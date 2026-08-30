// macOS-only routes that manage services running as user LaunchAgents instead
// of Docker containers. The corresponding docker-compose services are excluded
// by compose-generator when the user opts in via WizardState.nativeServices.
//
// Each managed service ships its own `deploy-launchd.sh` + plist template in
// its own repo; this module orchestrates them. Source is taken from
// `JARVIS_ROOT/<service-id>` if present (dev), otherwise cloned to
// `~/.jarvis/native/<service-id>` from GitHub.
import { existsSync, mkdirSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { parseRegistry } from '../services/generators/service-registry.js'
import type { ServiceDefinition, ServiceRegistry } from '../types/service-registry.js'
import registryData from '../data/service-registry.json' with { type: 'json' }
import { getComposePath } from '../services/compose-path.js'
import { getHostPlatform } from '../services/host-platform.js'

const GITHUB_ORG = 'alexberardi'
const NATIVE_ROOT = join(homedir(), '.jarvis', 'native')

interface NativeServiceStatus {
  serviceId: string
  label: string
  installed: boolean       // plist exists in ~/Library/LaunchAgents
  running: boolean         // launchctl reports state=running
  pid?: number
  sourceDir?: string
  port?: number
  logs: { stdout: string; stderr: string }
}

/**
 * Map a service ID → the launchd label its deploy-launchd.sh installs.
 * llm-proxy uses the legacy label (com.jarvis.llm-proxy, not -api) so
 * existing installs aren't orphaned.
 */
function launchdLabel(serviceId: string): string {
  if (serviceId === 'jarvis-llm-proxy-api') return 'com.jarvis.llm-proxy'
  return `com.jarvis.${serviceId.replace(/^jarvis-/, '')}`
}

/** Returns the directory with a checkout of the service repo, cloning if missing. */
function resolveSourceDir(serviceId: string): string {
  const dev = process.env.JARVIS_ROOT
    ? join(process.env.JARVIS_ROOT, serviceId)
    : null
  if (dev && existsSync(join(dev, 'deploy-launchd.sh'))) return dev

  const target = join(NATIVE_ROOT, serviceId)
  if (existsSync(join(target, 'deploy-launchd.sh'))) return target
  return target  // doesn't exist yet — caller will clone
}

function logDir(serviceId: string): string {
  // The plists in each service write to ~/Library/Logs/<dirname>; mirror their
  // naming so the log endpoint can find them. llm-proxy uses a shortened dir.
  if (serviceId === 'jarvis-llm-proxy-api') {
    return join(homedir(), 'Library', 'Logs', 'jarvis-llm-proxy')
  }
  return join(homedir(), 'Library', 'Logs', serviceId)
}

function plistPath(label: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** Returns true when launchctl reports `state = running` for the label. */
function isRunning(label: string): { running: boolean; pid?: number } {
  try {
    const uid = execSync('id -u', { encoding: 'utf-8' }).trim()
    const output = execSync(`launchctl print gui/${uid}/${label} 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 3000,
    })
    const stateMatch = output.match(/state\s*=\s*(\w+)/)
    const pidMatch = output.match(/pid\s*=\s*(\d+)/)
    const running = stateMatch?.[1] === 'running'
    return { running, pid: pidMatch ? parseInt(pidMatch[1], 10) : undefined }
  } catch {
    return { running: false }
  }
}

function loadEnvFile(composePath: string): Record<string, string> {
  const envPath = join(composePath, '.env')
  if (!existsSync(envPath)) return {}
  const content = readFileSync(envPath, 'utf-8')
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
  }
  return vars
}

function resolvePort(serviceId: string, svc: ServiceDefinition, composePath: string): number {
  const env = loadEnvFile(composePath)
  const portVarMap: Record<string, string> = {
    'jarvis-llm-proxy-api': 'LLM_PROXY_API_PORT',
    'jarvis-whisper-api': 'WHISPER_API_PORT',
    'jarvis-tts': 'TTS_PORT',
    'jarvis-osx-api': 'OSX_API_PORT',
  }
  const portVar = portVarMap[serviceId]
  if (portVar && env[portVar]) {
    const p = parseInt(env[portVar], 10)
    if (!Number.isNaN(p)) return p
  }
  return svc.port
}

function nativeCapableServices(registry: ServiceRegistry): ServiceDefinition[] {
  return registry.services.filter((s) => s.nativeCapable)
}

export async function nativeServicesRoutes(app: FastifyInstance): Promise<void> {
  const registry = parseRegistry(registryData)

  // Guard the :id path param before it is interpolated into any launchctl/shell
  // command. Only IDs present in the service registry are accepted; anything
  // else is rejected so an attacker cannot smuggle shell metacharacters into
  // the launchd label. Returns the validated id, or null after sending a 404.
  const requireKnownServiceId = (
    request: { params: { id: string } },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): string | null => {
    const { id } = request.params
    if (!registry.services.some((s) => s.id === id)) {
      reply.code(404).send({ error: `Unknown service: ${id}` })
      return null
    }
    return id
  }

  // Auth policy here mirrors /api/install/*: the wizard runs install BEFORE
  // there is a superuser account, so install + status are open (same trust
  // model as the rest of the bootstrap). Post-install lifecycle ops
  // (start/stop/uninstall) require superuser since they can disable services
  // running on a live install.

  /** Catalog + status for every native-capable service. */
  app.get('/', async (_request, reply) => {
    if (getHostPlatform() !== 'darwin') {
      return reply.send({ supported: false, services: [] })
    }
    const services = nativeCapableServices(registry).map((svc) => {
      const label = launchdLabel(svc.id)
      const installed = existsSync(plistPath(label))
      const { running, pid } = installed ? isRunning(label) : { running: false }
      const sourceDir = resolveSourceDir(svc.id)
      const sourceExists = existsSync(join(sourceDir, 'deploy-launchd.sh'))
      const logs = logDir(svc.id)
      const status: NativeServiceStatus = {
        serviceId: svc.id,
        label,
        installed,
        running,
        pid,
        sourceDir: sourceExists ? sourceDir : undefined,
        port: resolvePort(svc.id, svc, getComposePath()),
        logs: {
          stdout: join(logs, 'out.log'),
          stderr: join(logs, 'err.log'),
        },
      }
      return { ...svc, status }
    })
    return reply.send({ supported: true, services })
  })

  /**
   * SSE: install (clone if needed) + run deploy-launchd.sh for one service.
   * Streams stdout/stderr of the deploy script so the wizard can show progress.
   *
   * GET (not POST) because EventSource is GET-only, matching /api/install/start.
   */
  app.get<{ Params: { id: string } }>('/:id/install', async (request, reply) => {
    if (getHostPlatform() !== 'darwin') {
      return reply.code(400).send({ error: 'Native services are macOS-only' })
    }
    const { id } = request.params as { id: string }
    const svc = registry.services.find((s) => s.id === id)
    if (!svc) return reply.code(404).send({ error: `Unknown service: ${id}` })
    if (!svc.nativeCapable) {
      return reply.code(400).send({ error: `${id} does not support native install` })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const emit = (data: Record<string, unknown>) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Client disconnected mid-stream — let the child finish anyway.
      }
    }

    const composePath = getComposePath()
    const envFilePath = join(composePath, '.env')
    const port = resolvePort(id, svc, composePath)
    const sourceDir = resolveSourceDir(id)

    try {
      // Phase 1: ensure source is on disk
      if (!existsSync(join(sourceDir, 'deploy-launchd.sh'))) {
        mkdirSync(NATIVE_ROOT, { recursive: true })
        emit({ phase: 'clone', message: `Cloning ${id} into ${sourceDir}` })
        await runStreaming(
          'git', ['clone', '--depth', '1', `https://github.com/${GITHUB_ORG}/${id}.git`, sourceDir],
          { cwd: NATIVE_ROOT }, emit,
        )
      } else {
        emit({ phase: 'source', message: `Using existing checkout at ${sourceDir}` })
      }

      if (!existsSync(join(sourceDir, 'deploy-launchd.sh'))) {
        throw new Error(`deploy-launchd.sh missing in ${sourceDir} after clone — repo layout may be wrong`)
      }

      // Phase 2: deploy launchagent. The script handles plist materialization +
      // launchctl bootstrap; first run also kicks off venv creation + pip
      // install via run-prod-native.sh, which can take minutes.
      emit({ phase: 'launchd', message: `Deploying launchd agent on port ${port}` })
      await runStreaming(
        'bash', [join(sourceDir, 'deploy-launchd.sh')],
        {
          cwd: sourceDir,
          env: {
            ...process.env,
            ENV_FILE_PATH: envFilePath,
            [portEnvVarFor(id)]: String(port),
          },
        },
        emit,
      )

      const label = launchdLabel(id)
      emit({ phase: 'done', label, sourceDir, port, message: 'LaunchAgent ready', done: true, code: 0 })
    } catch (err) {
      emit({ phase: 'error', message: err instanceof Error ? err.message : String(err), done: true, code: 1 })
    }

    reply.raw.end()
  })

  /** Restart (kickstart -k) — also used for "start". */
  app.post<{ Params: { id: string } }>('/:id/restart', { preHandler: requireSuperuser }, async (request, reply) => {
    if (getHostPlatform() !== 'darwin') return reply.code(400).send({ error: 'macOS only' })
    const id = requireKnownServiceId(request, reply)
    if (!id) return
    const label = launchdLabel(id)
    if (!existsSync(plistPath(label))) {
      return reply.code(404).send({ error: `${label} not installed` })
    }
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim()
      execSync(`launchctl kickstart -k gui/${uid}/${label}`, { timeout: 5000 })
      return reply.send({ ok: true, label })
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  /** Stop (bootout) — leaves the plist in place so the user can re-enable later. */
  app.post<{ Params: { id: string } }>('/:id/stop', { preHandler: requireSuperuser }, async (request, reply) => {
    if (getHostPlatform() !== 'darwin') return reply.code(400).send({ error: 'macOS only' })
    const id = requireKnownServiceId(request, reply)
    if (!id) return
    const label = launchdLabel(id)
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim()
      execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`, { timeout: 5000 })
      return reply.send({ ok: true, label })
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  /** Uninstall: stop AND remove the plist file. */
  app.post<{ Params: { id: string } }>('/:id/uninstall', { preHandler: requireSuperuser }, async (request, reply) => {
    if (getHostPlatform() !== 'darwin') return reply.code(400).send({ error: 'macOS only' })
    const id = requireKnownServiceId(request, reply)
    if (!id) return
    const label = launchdLabel(id)
    const plist = plistPath(label)
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim()
      execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null || true`, { timeout: 5000 })
      if (existsSync(plist)) {
        unlinkSync(plist)
      }
      return reply.send({ ok: true, label, removedPlist: plist })
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  /**
   * Tail the last N lines of stdout or stderr. Reads from disk rather than
   * proxying launchctl — the plist's StandardOutPath / StandardErrorPath
   * point at predictable files.
   */
  app.get<{ Params: { id: string }; Querystring: { stream?: string; lines?: string } }>(
    '/:id/logs',
    { preHandler: requireSuperuser },
    async (request, reply) => {
      if (getHostPlatform() !== 'darwin') return reply.code(400).send({ error: 'macOS only' })
      const id = requireKnownServiceId(request, reply)
      if (!id) return
      const { stream = 'stderr', lines = '200' } = request.query as { stream?: string; lines?: string }
      const dir = logDir(id)
      const file = join(dir, stream === 'stdout' ? 'out.log' : 'err.log')
      if (!existsSync(file)) {
        return reply.send({ file, content: '', size: 0 })
      }
      try {
        const size = statSync(file).size
        const wanted = Math.min(parseInt(lines, 10) || 200, 5000)
        // tail -n via shell — avoids loading huge log files into memory.
        const content = execSync(`tail -n ${wanted} "${file}"`, { encoding: 'utf-8', timeout: 5000 })
        return reply.send({ file, content, size })
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  )
}

/** Env var name the deploy-launchd scripts read for the listener port. */
function portEnvVarFor(serviceId: string): string {
  if (serviceId === 'jarvis-llm-proxy-api') return 'LLM_PROXY_PORT'
  if (serviceId === 'jarvis-whisper-api') return 'WHISPER_PORT'
  if (serviceId === 'jarvis-tts') return 'TTS_PORT'
  if (serviceId === 'jarvis-osx-api') return 'OSX_API_PORT'
  return 'PORT'
}

/** Run a child process and emit its stdout/stderr through the SSE emitter. */
async function runStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  emit: (data: Record<string, unknown>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    child.stdout.on('data', (buf: Buffer) => emit({ stream: 'stdout', text: buf.toString() }))
    child.stderr.on('data', (buf: Buffer) => emit({ stream: 'stderr', text: buf.toString() }))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}
