import { execFile, execSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { getHostPlatform } from '../services/host-platform.js'
import { upsertEnvVar } from '../services/env-file.js'

/**
 * Download a single file straight from HuggingFace with curl — no
 * huggingface_hub / venv python needed. Native macOS services build their venvs
 * asynchronously after install, so the venv python isn't available when the
 * Models step runs; curl always is. Gated repos use the Bearer token.
 */
function downloadFileDirect(
  modelsDir: string,
  repo: string,
  filename: string,
  token: string | undefined,
): Promise<string> {
  const dest = join(modelsDir, filename)
  const url = `https://huggingface.co/${repo}/resolve/main/${filename}?download=true`
  const args = ['-fL', '--retry', '3', '--retry-delay', '2', '-o', dest, url]
  if (token) args.push('-H', `Authorization: Bearer ${token}`)
  return new Promise((resolve, reject) => {
    execFile('curl', args, { timeout: 1_800_000, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        try { if (existsSync(dest)) unlinkSync(dest) } catch { /* ignore */ }
        reject(new Error(stderr || err.message))
      } else {
        resolve(dest)
      }
    })
  })
}

/**
 * Best-effort `launchctl kickstart -k` for a native service. Failures are
 * swallowed: a crash-looping job can transiently reject a kickstart, but the
 * plist's KeepAlive will restart it anyway (picking up new .env values).
 */
function tryKickstartNative(label: string): boolean {
  try {
    const uid = execSync('id -u', { encoding: 'utf-8' }).trim()
    execSync(`launchctl kickstart -k gui/${uid}/${label}`, { timeout: 8000, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * The native macOS llm-proxy runs from ~/.jarvis/native/jarvis-llm-proxy-api and
 * loads models from a `.models/` dir relative to that checkout. Returns that dir
 * (creating it) when the native checkout exists, else null.
 */
function nativeLlmModelsDir(): string | null {
  const checkout = join(homedir(), '.jarvis', 'native', 'jarvis-llm-proxy-api')
  if (!existsSync(checkout)) return null
  const dir = join(checkout, '.models')
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return null
    }
  }
  return dir
}

/** The native llm-proxy venv python (has huggingface_hub), or null if absent. */
function nativeVenvPython(): string | null {
  const py = join(homedir(), '.jarvis', 'native', 'jarvis-llm-proxy-api', '.venv', 'bin', 'python')
  return existsSync(py) ? py : null
}

interface ModelInfo {
  name: string
  size: number
  sizeFormatted: string
}

interface DownloadBody {
  repo: string
  filename?: string
  token?: string
}

/** Search paths for the .models directory (local fallback) */
function findLocalModelsDir(): string | null {
  // Explicit env var takes priority (set in docker-compose for dev)
  const envDir = process.env.MODELS_DIR
  if (envDir && existsSync(envDir)) return envDir

  // Native macOS install: the llm-proxy runs from ~/.jarvis/native/... — its
  // .models dir (created on demand) is where GGUFs must land.
  const native = nativeLlmModelsDir()
  if (native) return native

  const candidates = [
    join(homedir(), 'jarvis', 'jarvis-llm-proxy-api', '.models'),
    join(homedir(), '.jarvis', 'compose', '.models'),
    join(homedir(), '.jarvis', '.models'),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return null
}

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  /** List installed models in the .models directory */
  app.get('/installed', async (_request, reply) => {
    // Try Docker first
    const container = await findLlmContainer(app)
    if (container) {
      try {
        const output = await app.docker!.execInContainer(container.id, [
          'python', '-c',
          'import os, json; models = []; d = "/app/.models"; [models.append({"name": f, "size": os.path.getsize(os.path.join(d, f))}) for f in os.listdir(d) if f.endswith((".gguf", ".bin")) and os.path.isfile(os.path.join(d, f))]; print(json.dumps(models))',
        ])
        const raw = extractJson(output)
        const models: ModelInfo[] = (JSON.parse(raw) as { name: string; size: number }[]).map((m) => ({
          ...m,
          sizeFormatted: formatBytes(m.size),
        }))
        return reply.send({ models })
      } catch (err) {
        console.error('[models] Docker list failed, trying local:', err)
      }
    }

    // Local filesystem fallback
    const modelsDir = findLocalModelsDir()
    if (!modelsDir) {
      return reply.send({ models: [] })
    }

    try {
      const files = readdirSync(modelsDir)
      const models: ModelInfo[] = files
        .filter((f) => f.endsWith('.gguf') || f.endsWith('.bin'))
        .map((f) => {
          const size = statSync(join(modelsDir, f)).size
          return { name: f, size, sizeFormatted: formatBytes(size) }
        })
      return reply.send({ models })
    } catch (err) {
      console.error('[models] Local list failed:', err)
      return reply.send({ models: [] })
    }
  })

  /** Download a model from HuggingFace */
  app.post<{ Body: DownloadBody }>('/download', async (request, reply) => {
    const { repo, filename, token } = request.body as DownloadBody

    if (!repo) {
      return reply.code(400).send({ error: 'repo is required' })
    }

    const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/
    const FILENAME_PATTERN = /^[a-zA-Z0-9_.-]+$/

    if (!REPO_PATTERN.test(repo)) {
      return reply.code(400).send({ error: 'Invalid repo format. Expected: owner/repo-name' })
    }
    if (filename && !FILENAME_PATTERN.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename format' })
    }

    // Persist the token so the service can pull gated models at runtime too.
    if (token) upsertEnvVar('HUGGINGFACE_HUB_TOKEN', token)

    // Try Docker first
    const container = await findLlmContainer(app)
    if (container) {
      // Pass token via sys.argv (not env vars) — dockerode env passing breaks in Bun runtime
      const tokenArg = token ?? ''
      const cmd = filename
        ? [
            'python', '-c',
            'import sys; from huggingface_hub import hf_hub_download; print(hf_hub_download(repo_id=sys.argv[1], filename=sys.argv[2], local_dir="/app/.models", token=sys.argv[3] or None))',
            repo,
            filename,
            tokenArg,
          ]
        : [
            'python', '-c',
            'import sys; from huggingface_hub import snapshot_download; print(snapshot_download(repo_id=sys.argv[1], local_dir=f"/app/.models/{sys.argv[1].split(\'/\')[-1]}", token=sys.argv[2] or None))',
            repo,
            tokenArg,
          ]

      try {
        const output = await app.docker!.execInContainer(container.id, cmd)
        return reply.send({ success: true, output: output.trim(), message: 'Download complete' })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[models] Docker download failed, trying local:', msg)
      }
    }

    // Local fallback — run python subprocess on host
    const modelsDir = findLocalModelsDir()
    if (!modelsDir) {
      return reply.code(503).send({
        error: 'No LLM proxy container found and no local .models directory. Start the LLM proxy or create the directory.',
      })
    }

    try {
      // Single GGUF file → direct curl (no venv). Full-repo snapshot (VLLM, no
      // filename) still needs huggingface_hub via the local venv python.
      const output = filename
        ? await downloadFileDirect(modelsDir, repo, filename, token)
        : (await runLocalPython(modelsDir, repo, filename, token)).trim()
      return reply.send({ success: true, output, message: 'Download complete' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[models] Local download failed:', msg)
      return reply.code(500).send({ error: `Download failed: ${msg}` })
    }
  })

  /**
   * Fetch the whisper STT model so the native service can start. whisper won't
   * egress on its own (outbound is opt-in) and its autodownload gate reads a DB
   * setting, not the env var — and its settings table may not exist natively.
   * So we curl ggml-base.en straight to whisper's default model_path; whisper
   * then simply finds a local file. Also flips the env flag for good measure and
   * restarts the native service.
   */
  app.post<{ Body: { enabled: boolean } }>('/whisper-autodownload', async (request, reply) => {
    const enabled = (request.body as { enabled?: boolean })?.enabled ?? true
    upsertEnvVar('WHISPER_ALLOW_MODEL_AUTODOWNLOAD', enabled ? 'true' : 'false')
    if (!enabled) {
      return reply.send({ success: true, enabled: false, downloaded: false })
    }

    const modelDir = join(homedir(), 'whisper.cpp', 'models')
    const dest = join(modelDir, 'ggml-base.en.bin')
    try {
      if (!existsSync(dest)) {
        mkdirSync(modelDir, { recursive: true })
        await downloadFileDirect(modelDir, 'ggerganov/whisper.cpp', 'ggml-base.en.bin', undefined)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[models] whisper model download failed:', msg)
      return reply.code(500).send({ error: `Whisper model download failed: ${msg}` })
    }

    const restarted = getHostPlatform() === 'darwin'
      ? tryKickstartNative('com.jarvis.whisper-api')
      : false
    return reply.send({ success: true, enabled: true, downloaded: existsSync(dest), restarted })
  })

  /** Delete a model file */
  app.delete<{ Params: { name: string } }>('/:name', async (request, reply) => {
    const { name } = request.params
    const FILENAME_PATTERN = /^[a-zA-Z0-9_.-]+$/

    if (!FILENAME_PATTERN.test(name)) {
      return reply.code(400).send({ error: 'Invalid filename' })
    }

    // Try Docker first
    const container = await findLlmContainer(app)
    if (container) {
      try {
        await app.docker!.execInContainer(container.id, [
          'python', '-c',
          'import sys, os; p = f"/app/.models/{sys.argv[1]}"; os.remove(p) if os.path.isfile(p) else None; print("ok")',
          name,
        ])
        return reply.send({ success: true })
      } catch (err) {
        console.error('[models] Docker delete failed, trying local:', err)
      }
    }

    // Local fallback
    const modelsDir = findLocalModelsDir()
    if (!modelsDir) {
      return reply.code(503).send({ error: 'No models directory found' })
    }

    const filePath = join(modelsDir, name)
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: 'Model not found' })
    }

    try {
      unlinkSync(filePath)
      return reply.send({ success: true })
    } catch (err) {
      console.error('[models] Local delete failed:', err)
      return reply.code(500).send({ error: 'Failed to delete model' })
    }
  })
}

async function findLlmContainer(app: FastifyInstance) {
  if (!app.docker) return null
  try {
    const containers = await app.docker.listJarvisContainers()
    return containers.find(
      (c) =>
        (c.name.includes('llm-proxy') || c.name.includes('llm_proxy')) &&
        c.name.includes('api') &&
        c.state === 'running'
    ) ?? containers.find(
      (c) =>
        (c.name.includes('llm-proxy') || c.name.includes('llm_proxy')) &&
        c.state === 'running'
    ) ?? null
  } catch {
    return null
  }
}

function runLocalPython(
  modelsDir: string,
  repo: string,
  filename: string | undefined,
  token: string | undefined,
): Promise<string> {
  const pyCode = filename
    ? `import sys, os; from huggingface_hub import hf_hub_download; print(hf_hub_download(repo_id=sys.argv[1], filename=sys.argv[2], local_dir=sys.argv[3], token=os.environ.get("HUGGINGFACE_HUB_TOKEN") or None))`
    : `import sys, os; from huggingface_hub import snapshot_download; print(snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[3] + "/" + sys.argv[1].split("/")[-1], token=os.environ.get("HUGGINGFACE_HUB_TOKEN") or None))`

  // Prefer the native llm-proxy venv python — it has huggingface_hub installed.
  // The macOS system python3 is 3.9 without it, so a bare python3 would fail.
  const python = nativeVenvPython() ?? 'python3'
  const args = filename
    ? [python, '-c', pyCode, repo, filename, modelsDir]
    : [python, '-c', pyCode, repo, '', modelsDir]

  const env = { ...process.env }
  if (token) env.HUGGINGFACE_HUB_TOKEN = token

  return new Promise((resolve, reject) => {
    execFile(args[0]!, args.slice(1), { env, timeout: 600_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
      } else {
        resolve(stdout)
      }
    })
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Extract the first JSON array or object from Docker exec output (may have header bytes) */
function extractJson(raw: string): string {
  const start = raw.indexOf('[')
  if (start === -1) return '[]'
  return raw.slice(start)
}
