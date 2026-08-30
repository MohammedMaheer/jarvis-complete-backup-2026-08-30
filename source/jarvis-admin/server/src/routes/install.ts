import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, accessSync, constants as fsConstants } from 'node:fs'
import { join, parse as parsePath } from 'node:path'
import { homedir, platform, arch, totalmem } from 'node:os'
import { exec, spawn, execSync } from 'node:child_process'
import net from 'node:net'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser, requireSuperuserIfInstalled } from '../middleware/auth.js'
import { getComposePath } from '../services/compose-path.js'
import { getWhisperModelPath, setWhisperModelPath } from '../services/whisper-model-setting.js'
import { generateCompose, getAllEnabledServices } from '../services/generators/compose-generator.js'
import { generateEnv } from '../services/generators/env-generator.js'
import { generateInitDbScript } from '../services/generators/init-db-generator.js'
import { seedGo2rtcConfig } from '../services/generators/go2rtc-config.js'
import { generateAllSecrets } from '../services/generators/secret-generator.js'
import { parseRegistry } from '../services/generators/service-registry.js'
import { pollServiceHealth, registerServices, tieredStartup, getDefaultEnabledModules } from '../services/orchestrator.js'
import { savePersistedConfig, isInstalled } from '../config.js'
import { getHostPlatform } from '../services/host-platform.js'
import { shouldSelfTerminateAfterInstall } from '../services/admin-lifecycle.js'
import type { WizardState, HardwareInfo, InstallState, PreflightCheck, PreflightResult } from '../types/wizard.js'
import type { ServiceRegistry } from '../types/service-registry.js'
import registryData from '../data/service-registry.json' with { type: 'json' }

function disableAutostart(): void {
  const cmd = platform() === 'darwin'
    ? `launchctl unload "${join(homedir(), 'Library/LaunchAgents/com.jarvis.admin.plist')}" 2>/dev/null`
    : platform() === 'linux'
      ? 'systemctl --user disable jarvis-admin 2>/dev/null'
      : ''
  if (!cmd) return
  exec(cmd, (err) => {
    if (err) console.warn(`[jarvis-admin] Could not disable autostart: ${err.message}`)
    else console.log(`[jarvis-admin] Disabled autostart (${platform()})`)
  })
}

function loadRegistry(): ServiceRegistry {
  return parseRegistry(registryData)
}

export async function installRoutes(app: FastifyInstance): Promise<void> {
  const registry = loadRegistry()

  /**
   * Check installation state with container awareness.
   */
  app.get('/status', async (_request, reply) => {
    // Compose-export mode: services are managed externally (TrueNAS, Portainer, etc.)
    // Just check if auth is reachable and whether account setup is needed.
    if (process.env.JARVIS_DEPLOY_MODE === 'compose-export') {
      // Try to reach auth to determine if account creation is needed
      const authUrl = process.env.JARVIS_AUTH_BASE_URL ?? 'http://jarvis-auth:8000'
      let authReachable = false
      try {
        const res = await fetch(`${authUrl}/health`, { signal: AbortSignal.timeout(3000) })
        authReachable = res.ok
      } catch {
        // Auth not reachable yet
      }

      if (!authReachable) {
        // Services still starting
        const status: InstallState = {
          configured: false,
          state: 'deployed-needs-account',
          deployMode: 'compose-export',
          reason: 'services_starting',
        }
        return reply.send(status)
      }

      const status: InstallState = {
        configured: false,
        state: 'deployed-needs-account',
        deployMode: 'compose-export',
      }
      return reply.send(status)
    }

    const composePath = getComposePath()
    const composeFile = join(composePath, 'docker-compose.yml')
    const envFile = join(composePath, '.env')

    if (!existsSync(composeFile) || !existsSync(envFile)) {
      // No local compose files — but if service URLs are configured and reachable,
      // the stack is managed externally (e.g., ./jarvis CLI, Docker admin container).
      const { authUrl, configServiceUrl } = app.config
      if (authUrl && configServiceUrl) {
        try {
          const res = await fetch(`${authUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3000) })
          if (res.ok) {
            const status: InstallState = { configured: true, state: 'complete' }
            return reply.send(status)
          }
        } catch {
          // Auth not reachable — fall through to fresh install check
        }
      }

      // Check Docker availability
      let dockerAvailable = false
      try {
        execSync('docker info', { stdio: 'ignore', timeout: 5000 })
        dockerAvailable = true
      } catch {
        // Docker not available
      }

      const status: InstallState = {
        configured: false,
        reason: dockerAvailable ? 'not_installed' : 'docker_not_found',
        state: 'fresh',
      }
      return reply.send(status)
    }

    // Compose file exists — check what containers are running. A stopped
    // Docker/WSL engine is an offline runtime, not a fresh installation.
    const running: string[] = []
    const stopped: string[] = []
    let dockerAvailable = false
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 5000 })
      dockerAvailable = true
    } catch {
      // Docker may be stopped after WSL shutdown; preserve the install state.
    }
    try {
      const output = execSync(
        `docker compose -f "${composeFile}" ps --format json`,
        { cwd: composePath, timeout: 10_000, encoding: 'utf-8', env: { ...process.env, ...loadEnvFile(composePath) } },
      )
      // docker compose ps --format json outputs one JSON object per line
      const lines = output.trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const container = JSON.parse(line) as { Service: string; State: string }
          if (container.State === 'running') {
            running.push(container.Service)
          } else {
            stopped.push(container.Service)
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // docker compose ps failed — compose file may exist but no containers
    }

    // Determine state
    let state: 'generated' | 'partial' | 'running' | 'complete' | 'offline'
    if (!dockerAvailable && isInstalled()) {
      state = 'offline'
    } else if (running.length === 0 && stopped.length === 0) {
      state = 'generated'
    } else if (running.length > 0 && stopped.length === 0) {
      // All containers running — check if auth is up (indicates complete setup)
      const envVars = loadEnvFile(composePath)
      const authPort = parseInt(envVars.AUTH_PORT ?? '7701', 10)
      try {
        const res = await fetch(`http://localhost:${authPort}/health`, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          state = 'complete'
        } else {
          state = 'running'
        }
      } catch {
        state = 'running'
      }
    } else {
      state = 'partial'
    }

    const status: InstallState = {
      configured: true,
      composePath,
      reason: state === 'offline' ? 'docker_unavailable' : undefined,
      state,
      running: running.length > 0 ? running : undefined,
      stopped: stopped.length > 0 ? stopped : undefined,
    }
    return reply.send(status)
  })

  /**
   * Pre-flight checks before installation begins.
   * Verifies Docker, Compose, ports, disk space, Docker socket, and NVIDIA runtime.
   */
  app.get<{ Querystring: { services?: string } }>('/preflight', async (request, reply) => {
    const checks: PreflightCheck[] = []
    const composePath = getComposePath()
    const dockerSocket = app.config?.dockerSocket ?? (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock')

    // Parse enabled services from query param
    const enabledServiceIds = (request.query as { services?: string }).services?.split(',').filter(Boolean) ?? []
    const enabledServices = registry.services.filter((s) =>
      s.category === 'core' || enabledServiceIds.includes(s.id),
    )

    // 1. Docker
    try {
      const output = execSync('docker info', { encoding: 'utf-8', timeout: 5000 })
      const versionMatch = output.match(/Server Version:\s*(.+)/i)
      const version = versionMatch?.[1]?.trim() ?? 'unknown'
      checks.push({ name: 'Docker', status: 'pass', message: `Docker is running (v${version})` })
    } catch (err) {
      checks.push({
        name: 'Docker',
        status: 'fail',
        message: 'Docker is not running or not installed',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 2. Docker Compose
    try {
      const output = execSync('docker compose version', { encoding: 'utf-8', timeout: 5000 })
      checks.push({ name: 'Docker Compose', status: 'pass', message: output.trim() })
    } catch (err) {
      checks.push({
        name: 'Docker Compose',
        status: 'fail',
        message: 'Docker Compose is not available',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 3. Port availability
    const portsToCheck = enabledServices.map((s) => ({ id: s.id, port: s.port }))
    const conflicts: Array<{ id: string; port: number }> = []
    let nativeLlmHealthy = false
    // Windows uses the native CUDA llama.cpp server on 7704. It intentionally
    // occupies the same logical service port as the optional Docker LLM proxy;
    // probe it so preflight does not report an expected reservation as a clash.
    if (process.platform === 'win32') {
      try {
        const response = await fetch('http://127.0.0.1:7704/health', { signal: AbortSignal.timeout(1500) })
        nativeLlmHealthy = response.ok
      } catch {
        nativeLlmHealthy = false
      }
    }

    await Promise.all(
      portsToCheck.map(async ({ id, port }) => {
        const inUse = await isPortInUse(port)
        if (inUse && !(id === 'jarvis-llm-proxy-api' && port === 7704 && nativeLlmHealthy)) {
          conflicts.push({ id, port })
        }
      }),
    )

    if (conflicts.length > 0) {
      const coreConflicts = conflicts.filter((c) =>
        enabledServices.find((s) => s.id === c.id && s.category === 'core'),
      )
      const details = conflicts.map((c) => `${c.id} (port ${c.port})`).join(', ')
      checks.push({
        name: 'Ports',
        status: coreConflicts.length > 0 ? 'fail' : 'warn',
        message: `${conflicts.length} port(s) already in use: ${details}`,
        details: `Conflicting ports: ${details}`,
      })
    } else {
      checks.push({
        name: 'Ports',
        status: nativeLlmHealthy ? 'warn' : 'pass',
        message: nativeLlmHealthy
          ? 'Required ports are available; 7704 is reserved by the native local Qwen server'
          : 'All required ports are available',
        details: nativeLlmHealthy ? 'The optional Docker LLM proxy is intentionally disabled while native CUDA llama.cpp is active.' : undefined,
      })
    }

    // 4. Disk space
    try {
      const targetPath = existsSync(composePath) ? composePath : homedir()
      let availableKb: number
      if (platform() === 'win32') {
        const drive = (parsePath(targetPath).root?.[0] ?? 'C').toUpperCase()
        const output = execSync(
          `powershell.exe -NoProfile -Command "(Get-PSDrive -Name ${drive}).Free"`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim()
        const availableBytes = Number.parseInt(output, 10)
        if (!Number.isFinite(availableBytes)) throw new Error('Windows free-space query returned no number')
        availableKb = Math.floor(availableBytes / 1024)
      } else {
        const output = execSync(`df -k "${targetPath}"`, { encoding: 'utf-8', timeout: 5000 })
        const lines = output.trim().split('\n')
        if (lines.length < 2) throw new Error('df returned no filesystem row')
        const parts = lines[1].split(/\s+/)
        // df -k output: Filesystem 1K-blocks Used Available Use% Mounted
        availableKb = parseInt(parts[3], 10)
      }
      if (Number.isFinite(availableKb)) {
        const availableGb = Math.round(availableKb / (1024 * 1024))
        if (availableKb < 2 * 1024 * 1024) {
          checks.push({
            name: 'Disk Space',
            status: 'fail',
            message: `Only ${availableGb} GB available (minimum 2 GB required)`,
          })
        } else if (availableKb < 10 * 1024 * 1024) {
          checks.push({
            name: 'Disk Space',
            status: 'warn',
            message: `${availableGb} GB available (10+ GB recommended)`,
          })
        } else {
          checks.push({
            name: 'Disk Space',
            status: 'pass',
            message: `${availableGb} GB available`,
          })
        }
      }
    } catch {
      checks.push({ name: 'Disk Space', status: 'warn', message: 'Could not determine available disk space' })
    }

    // 5. Docker socket
    try {
      if (platform() === 'win32') {
        // Windows named pipes can't be checked with accessSync — verify via docker ping
        execSync('docker info', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
        checks.push({ name: 'Docker Socket', status: 'pass', message: `Docker Desktop accessible via named pipe` })
      } else {
        accessSync(dockerSocket, fsConstants.R_OK | fsConstants.W_OK)
        checks.push({ name: 'Docker Socket', status: 'pass', message: `Docker socket accessible at ${dockerSocket}` })
      }
    } catch (err) {
      checks.push({
        name: 'Docker Socket',
        status: 'fail',
        message: platform() === 'win32'
          ? 'Docker Desktop not running or not accessible'
          : `Docker socket not accessible at ${dockerSocket}`,
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 6. NVIDIA runtime (Linux only)
    if (platform() === 'linux') {
      const gpuServicesEnabled = enabledServices.some((s) => s.gpu)
      try {
        const output = execSync("docker info --format '{{json .Runtimes}}'", {
          encoding: 'utf-8',
          timeout: 5000,
        })
        const hasNvidia = output.toLowerCase().includes('nvidia')
        if (hasNvidia) {
          checks.push({ name: 'NVIDIA Runtime', status: 'pass', message: 'NVIDIA container runtime detected' })
        } else if (gpuServicesEnabled) {
          checks.push({
            name: 'NVIDIA Runtime',
            status: 'warn',
            message: 'NVIDIA runtime not found. GPU services may not work.',
            details: 'Install the NVIDIA Container Toolkit for GPU acceleration',
          })
        }
      } catch {
        if (gpuServicesEnabled) {
          checks.push({
            name: 'NVIDIA Runtime',
            status: 'warn',
            message: 'Could not check for NVIDIA runtime. GPU services may not work.',
          })
        }
      }
    }

    // 7. Python >=3.11 for native services (macOS only). llm-proxy / whisper /
    // tts run natively on macOS and build a venv that requires Python >=3.11.
    // The macOS system python3 is usually 3.9, and `brew install python@3.11`
    // installs `python3.11` (not a bare `python3`) — so verify an explicitly
    // versioned interpreter (or a new-enough python3) exists. Without this the
    // native services install but crash-loop on pip's "requires a different
    // Python" error, which is invisible from the Docker side.
    if (platform() === 'darwin' && enabledServices.some((s) => s.nativeCapable)) {
      const versioned = ['python3.13', 'python3.12', 'python3.11'].find((bin) => {
        try {
          execSync(`command -v ${bin}`, { timeout: 3000, stdio: 'pipe' })
          return true
        } catch {
          return false
        }
      })
      let bareOk: string | null = null
      if (!versioned) {
        try {
          const v = execSync(`python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])'`, {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: 'pipe',
          }).trim()
          const [maj, min] = v.split('.').map((n) => parseInt(n, 10))
          if (maj > 3 || (maj === 3 && min >= 11)) bareOk = v
        } catch {
          // no usable python3 at all
        }
      }
      if (versioned || bareOk) {
        checks.push({
          name: 'Python (native services)',
          status: 'pass',
          message: `Python >=3.11 available (${versioned ?? `python3 ${bareOk}`}) for native llm-proxy / whisper / tts`,
        })
      } else {
        checks.push({
          name: 'Python (native services)',
          status: 'fail',
          message: 'Python >=3.11 is required for the native llm-proxy / whisper / tts services on macOS',
          details: "Install it with 'brew install python@3.11' (macOS ships python3 3.9), then retry.",
        })
      }
    }

    const canProceed = !checks.some((c) => c.status === 'fail')
    const result: PreflightResult = { checks, canProceed }
    return reply.send(result)
  })

  /**
   * Detect hardware: GPU, RAM, platform.
   * Wrapped in try/catch so the endpoint never throws.
   */
  app.get('/hardware', async (_request, reply) => {
    try {
      // Prefer host detection (env override + docker-info) over process.platform
      // — admin can run in a Linux container on a Mac host, where process.platform
      // is always 'linux'.
      const plat = getHostPlatform()
      const archName = arch()
      const totalMemoryGb = Math.round(totalmem() / (1024 * 1024 * 1024))

      let gpuName: string | null = null
      let gpuVramMb: number | null = null
      let gpuType: import('../types/wizard.js').GpuType = 'none'
      const recommendedBackends: string[] = []
      let recommendedBackend = 'gguf'

      if (plat === 'darwin') {
        // macOS: check for Apple Silicon
        try {
          const output = execSync('system_profiler SPDisplaysDataType -json', {
            encoding: 'utf-8',
            timeout: 10_000,
          })
          const data = JSON.parse(output)
          const gpu = data?.SPDisplaysDataType?.[0]
          if (gpu) {
            gpuName = gpu.sppci_model ?? 'Apple Silicon GPU'
            gpuVramMb = totalMemoryGb * 1024 // Unified memory
            gpuType = 'apple'
          }
        } catch {
          // Fallback
        }

        if (archName === 'arm64') {
          recommendedBackends.push('gguf', 'mlx')
          recommendedBackend = 'gguf'
        } else {
          recommendedBackends.push('gguf')
        }
      } else if (plat === 'linux') {
        // Linux: check for NVIDIA GPU(s)
        try {
          const output = execSync(
            'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
            { encoding: 'utf-8', timeout: 10_000 },
          )
          const lines = output.trim().split('\n').filter(Boolean)
          let totalVram = 0
          const gpuNames: string[] = []
          for (const line of lines) {
            const parts = line.split(', ')
            if (parts.length >= 2) {
              gpuNames.push(parts[0].trim())
              totalVram += parseInt(parts[1], 10)
            }
          }
          if (gpuNames.length > 0) {
            gpuName = gpuNames.length === 1
              ? gpuNames[0]
              : `${gpuNames.length}x ${gpuNames[0]}`
            gpuVramMb = totalVram
            gpuType = 'nvidia'
          }
        } catch {
          // No NVIDIA GPU
        }

        // Linux: check for AMD GPU (if no NVIDIA found)
        if (gpuType === 'none') {
          try {
            const output = execSync('lspci 2>/dev/null | grep -i "vga\\|3d\\|display"', {
              encoding: 'utf-8',
              timeout: 10_000,
            })
            const amdMatch = output.match(/AMD.*?\[(.+?)\]/i)
              || output.match(/Advanced Micro Devices.*?(\S+)\s*$/im)
            if (amdMatch) {
              gpuName = amdMatch[1]?.trim() || 'AMD GPU'
              gpuType = 'amd'
              // Try to get VRAM via /sys (not always available)
              try {
                const vramBytes = execSync(
                  'cat /sys/class/drm/card*/device/mem_info_vram_total 2>/dev/null | head -1',
                  { encoding: 'utf-8', timeout: 5_000 },
                ).trim()
                if (vramBytes) {
                  gpuVramMb = Math.round(parseInt(vramBytes, 10) / (1024 * 1024))
                }
              } catch { /* VRAM detection optional */ }
            }
          } catch {
            // No AMD GPU
          }
        }

        if (gpuType === 'nvidia') {
          recommendedBackends.push('gguf', 'vllm')
          recommendedBackend = 'gguf'
        } else if (gpuType === 'amd') {
          recommendedBackends.push('gguf')
          recommendedBackend = 'gguf'
        } else {
          recommendedBackends.push('gguf')
        }
      }

      // No GPU detected on any platform — offer remote as fallback
      if (!gpuName && recommendedBackends.length === 0) {
        recommendedBackends.push('remote')
        recommendedBackend = 'remote'
      }

      // ARM without GPU = suggest remote-llm.
      // os.arch() normalises to 'arm64' (never the uname-style 'aarch64').
      const isArm = archName === 'arm64'
      if (isArm && plat === 'linux' && gpuType === 'none') {
        recommendedBackend = 'remote'
      }

      const info: HardwareInfo = {
        platform: plat === 'darwin' ? 'darwin' : 'linux',
        arch: archName,
        totalMemoryGb,
        gpuName,
        gpuVramMb,
        gpuType,
        recommendedBackends,
        recommendedBackend,
      }

      return reply.send(info)
    } catch (err) {
      // Graceful fallback — never throw from hardware detection
      console.error('[install] Hardware detection failed:', err)
      const fallback: HardwareInfo = {
        platform: getHostPlatform() === 'darwin' ? 'darwin' : 'linux',
        arch: arch(),
        totalMemoryGb: Math.round(totalmem() / (1024 * 1024 * 1024)),
        gpuName: null,
        gpuVramMb: null,
        gpuType: 'none',
        recommendedBackends: ['remote'],
        recommendedBackend: 'remote',
      }
      return reply.send(fallback)
    }
  })

  /**
   * Generate compose, env, and init-db files.
   */
  app.post<{ Body: WizardState }>('/generate', { preHandler: requireSuperuserIfInstalled }, async (request, reply) => {
    const state = request.body as WizardState
    const composePath = getComposePath()

    // Generate secrets if not provided
    if (!state.secrets || Object.keys(state.secrets).length === 0) {
      state.secrets = generateAllSecrets()
    }

    const enabledServices = getAllEnabledServices(state, registry)
    const primaryDb = registry.infrastructure
      .find((i) => i.id === 'postgres')
      ?.envVars.find((e) => e.name === 'POSTGRES_DB')?.default ?? 'jarvis_config'

    const compose = generateCompose(state, registry)
    const env = generateEnv(state, registry)
    const initDb = generateInitDbScript(enabledServices, primaryDb)

    // Write files
    mkdirSync(composePath, { recursive: true })
    // Create .models dir before Docker does, so it's owned by the user (not root)
    mkdirSync(join(composePath, '.models'), { recursive: true })
    writeFileSync(join(composePath, 'docker-compose.yml'), compose)
    writeFileSync(join(composePath, '.env'), env)
    writeFileSync(join(composePath, 'init-db.sh'), initDb)
    chmodSync(join(composePath, 'init-db.sh'), 0o755)

    // go2rtc config — shared seed with the reconcile path (never overwrites a
    // hand-edited file; users add streams to it)
    seedGo2rtcConfig(composePath, enabledServices.map((s) => s.id))

    return reply.send({
      ok: true,
      composePath,
      files: ['docker-compose.yml', '.env', 'init-db.sh'],
      serviceCount: enabledServices.length,
    })
  })

  /**
   * SSE: docker compose pull
   */
  app.get('/pull', { preHandler: requireSuperuserIfInstalled }, async (request, reply) => {
    const composePath = getComposePath()
    const composeFile = join(composePath, 'docker-compose.yml')

    if (!existsSync(composeFile)) {
      return reply.code(400).send({ error: 'Compose file not found. Run /generate first.' })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const child = spawn('docker', ['compose', '-f', composeFile, 'pull'], {
      cwd: composePath,
      env: { ...process.env, ...loadEnvFile(composePath) },
    })

    child.stdout.on('data', (chunk: Buffer) => {
      reply.raw.write(`data: ${JSON.stringify({ stream: 'stdout', text: chunk.toString() })}\n\n`)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      reply.raw.write(`data: ${JSON.stringify({ stream: 'stderr', text: chunk.toString() })}\n\n`)
    })

    request.raw.on('close', () => {
      child.kill()
    })

    child.on('close', (code) => {
      reply.raw.write(`data: ${JSON.stringify({ done: true, code })}\n\n`)
      reply.raw.end()
    })
  })

  /**
   * SSE: tiered startup — infra → config → auth → register → all services
   */
  app.get('/start', { preHandler: requireSuperuserIfInstalled }, async (request, reply) => {
    const composePath = getComposePath()
    const composeFile = join(composePath, 'docker-compose.yml')

    if (!existsSync(composeFile)) {
      return reply.code(400).send({ error: 'Compose file not found. Run /generate first.' })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const envVars = loadEnvFile(composePath)
    const adminToken = envVars.JARVIS_AUTH_ADMIN_TOKEN ?? ''
    const portOverrides = {} as Record<string, number>

    const emit = (data: Record<string, unknown>) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Client disconnected
      }
    }

    try {
      // Check which services are already healthy before starting
      const alreadyHealthy = new Set<string>()
      const currentHealth = await pollServiceHealth(registry.services, portOverrides)
      for (const [id, status] of Object.entries(currentHealth)) {
        if (status.healthy) {
          alreadyHealthy.add(id)
          emit({ phase: 'preflight', message: `${id} already healthy, will skip` })
        }
      }

      const result = await tieredStartup(
        composeFile, composePath, registry.services, adminToken, portOverrides, emit, alreadyHealthy,
      )

      // Persist service URLs so the admin server can proxy to them
      if (result.success) {
        const authPort = envVars.AUTH_PORT ?? '7701'
        const configPort = envVars.CONFIG_SERVICE_PORT ?? '7700'
        const llmPort = envVars.LLM_PROXY_API_PORT ?? '7704'
        const ccPort = envVars.COMMAND_CENTER_PORT ?? '7703'

        const urls = {
          authUrl: `http://localhost:${authPort}`,
          configServiceUrl: `http://localhost:${configPort}`,
          llmProxyUrl: `http://localhost:${llmPort}`,
          commandCenterUrl: `http://localhost:${ccPort}`,
        }
        savePersistedConfig(urls)

        // Update in-memory config so subsequent requests work immediately
        Object.assign(app.config, urls)
      }

      // Emit service health results before closing
      if (result.serviceHealth) {
        emit({ phase: 'serviceHealth', serviceHealth: result.serviceHealth })
      }

      // Redirect target for the admin dashboard. On Linux the containerized
      // admin takes over on ADMIN_PORT; on macOS there is no container — this
      // native binary keeps serving the dashboard on its own port.
      const hostPlatform = getHostPlatform()
      const isNativeMac = hostPlatform === 'darwin'
      let redirect: string | undefined
      if (result.success) {
        const adminPort = isNativeMac ? String(app.config.port) : (envVars.ADMIN_PORT ?? '7710')
        const requestHost = request.hostname.split(':')[0] ?? 'localhost'
        redirect = `http://${requestHost}:${adminPort}`
      }

      emit({ done: true, code: result.success ? 0 : 1, error: result.error, serviceHealth: result.serviceHealth, redirect })

      // Mark install complete. On Linux the containerized admin takes over the
      // same port, so the installer disables its launchd/systemd autostart and
      // self-terminates to free the port for the container. On macOS there is
      // NO container: this native binary IS the permanent admin, so it must
      // stay alive (and keep its autostart) to serve the dashboard AND the
      // native-services install step that runs immediately after this.
      if (result.success && redirect) {
        savePersistedConfig({ installed: true })
        if (shouldSelfTerminateAfterInstall(hostPlatform)) {
          disableAutostart()
          setTimeout(() => {
            console.log(`[jarvis-admin] Installer complete. Admin dashboard running at ${redirect}. Shutting down installer.`)
            process.exit(0)
          }, 5000)
        } else {
          console.log(`[jarvis-admin] Install complete. Native macOS admin staying up on port ${app.config.port} to serve the dashboard + native services.`)
        }
      }
    } catch (err) {
      emit({ done: true, code: 1, error: err instanceof Error ? err.message : String(err) })
    }

    reply.raw.end()
  })

  /**
   * Register services with config-service + auth, inject app keys.
   */
  app.post<{ Body: { portOverrides?: Record<string, number> } }>(
    '/register',
    { preHandler: requireSuperuserIfInstalled },
    async (request, reply) => {
      const composePath = getComposePath()
      const envFile = join(composePath, '.env')

      if (!existsSync(envFile)) {
        return reply.code(400).send({ error: 'Env file not found. Run /generate first.' })
      }

      const envVars = loadEnvFile(composePath)
      const adminToken = envVars.JARVIS_AUTH_ADMIN_TOKEN ?? ''
      const configPort = parseInt(envVars.CONFIG_SERVICE_PORT ?? '7700', 10)
      const configServiceUrl = `http://localhost:${configPort}`
      const portOverrides = (request.body as { portOverrides?: Record<string, number> })?.portOverrides ?? {}

      // Get all services from registry (except infrastructure)
      const services = registry.services.filter(
        (s) => s.category === 'core' || s.category === 'recommended',
      )

      const result = await registerServices(services, configServiceUrl, adminToken, portOverrides)

      return reply.send(result)
    },
  )

  /**
   * Poll all service health endpoints.
   */
  app.get('/health', async (_request, reply) => {
    const composePath = getComposePath()
    const envVars = existsSync(join(composePath, '.env'))
      ? loadEnvFile(composePath)
      : {}

    const services = registry.services
    const portOverrides: Record<string, number> = {}
    for (const svc of services) {
      const portVar = svc.id.replace(/^jarvis-/, '').replace(/-/g, '_').toUpperCase() + '_PORT'
      if (envVars[portVar]) {
        portOverrides[svc.id] = parseInt(envVars[portVar], 10)
      }
    }

    const status = await pollServiceHealth(services, portOverrides)
    return reply.send(status)
  })

  /**
   * Create superuser account via jarvis-auth.
   */
  app.post<{
    Body: { email: string; password: string; displayName: string }
  }>('/account', { preHandler: requireSuperuserIfInstalled }, async (request, reply) => {
    const { email, password, displayName } = request.body as {
      email: string
      password: string
      displayName: string
    }

    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' })
    }

    const composePath = getComposePath()
    const envVars = existsSync(join(composePath, '.env'))
      ? loadEnvFile(composePath)
      : {}
    const authPort = parseInt(envVars.AUTH_PORT ?? '7701', 10)
    const authUrl = `http://localhost:${authPort}`

    try {
      // Register user
      const registerRes = await fetch(`${authUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, display_name: displayName }),
        signal: AbortSignal.timeout(10_000),
      })

      if (!registerRes.ok) {
        const body = await registerRes.text()
        return reply.code(registerRes.status).send({ error: body })
      }

      // Promote to superuser via admin token
      const adminToken = envVars.JARVIS_AUTH_ADMIN_TOKEN ?? ''
      const promoteRes = await fetch(`${authUrl}/admin/users/promote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': adminToken,
        },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(10_000),
      })

      if (!promoteRes.ok) {
        const body = await promoteRes.text()
        return reply.code(promoteRes.status).send({
          error: `User created but promotion failed: ${body}`,
        })
      }

      return reply.send({ ok: true, email })
    } catch (err) {
      return reply.code(502).send({
        error: `Auth service unavailable: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })

  /**
   * Get the service registry data.
   */
  app.get('/registry', async (_request, reply) => {
    return reply.send(registry)
  })

  /**
   * Get default enabled modules.
   */
  app.get('/defaults', async (_request, reply) => {
    const modules = getDefaultEnabledModules(registry)
    return reply.send({ enabledModules: modules })
  })

  /**
   * SSE: reconcile existing install with the latest service registry.
   *
   * Returns the current optional services and integration toggles for the
   * reconcile options screen. Pre-populates from the existing .env.
   */
  app.get('/reconcile/options', { preHandler: requireSuperuser }, async (request, reply) => {
    const composePath = getComposePath()
    const env = loadEnvFile(composePath)
    const { reconstructWizardState } = await import('../services/upgrade/state-reconstructor.js')
    const state = reconstructWizardState(env, registry)

    // Build options: optional + recommended services with current enabled state
    const options = registry.services
      .filter((s) => s.category === 'optional' || s.category === 'recommended')
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        enabled: s.category === 'core' || state.enabledModules.includes(s.id),
      }))

    // The whisper model is a RUNTIME setting (whisper.model_path) that jarvis-whisper-api
    // reads from the settings DB and hot-reloads on — NOT the compose WHISPER_MODEL env
    // (which the service ignores). Show the live setting so the field reflects the model
    // STT actually loads; fall back to the compose-derived value / default if the settings
    // gateway is unreachable.
    const whisperModel = await getWhisperModelPath(app.config.configServiceUrl, request.headers.authorization)

    return reply.send({
      services: options,
      relayEnabled: state.relayEnabled,
      relayUrl: state.relayUrl || 'https://relay.jarvisautomation.io',
      whisperModelPath: whisperModel || state.whisperModelPath || '/whisper-models/ggml-base.en.bin',
      whisperBackend: state.whisperBackend ?? 'cpu',
      ttsBackend: state.ttsBackend ?? 'cpu',
      pinImages: state.pinImages ?? false,
      releaseTrack: state.releaseTrack ?? 'stable',
      bgModelEnabled: state.bgModelEnabled ?? false,
      bgModelFile: state.bgModelFile ?? '',
      // The sidecar is NVIDIA/Linux only — lets the UI grey the toggle out.
      bgModelSupported: state.platform !== 'darwin',
    })
  })

  /**
   * Non-destructive regeneration for the "hand the operator a new file" flow.
   *
   * Rebuilds docker-compose.yml / .env / init-db.sh from the current install
   * (secrets + user config preserved, new fields added) and RETURNS them as
   * strings — nothing on disk is touched. The operator reviews, swaps the files
   * in, and runs `docker compose up -d`. This is the same engine `/reconcile`
   * uses, exposed for a review-first (or compose-mode) migration.
   */
  app.post('/regenerate-download', { preHandler: requireSuperuser }, async (request, reply) => {
    const composePath = getComposePath()
    if (!existsSync(join(composePath, 'docker-compose.yml'))) {
      return reply.code(400).send({ error: 'No existing install found. Run /generate first.' })
    }

    const overrides = (request.body ?? undefined) as
      | import('../services/upgrade/compose-upgrader.js').UpgradeOverrides
      | undefined

    // ?latest=true refreshes the pinned image digests from GHCR first, so the
    // downloaded compose targets the newest published builds ("Update stack to
    // latest"). Default keeps the current pins (config-only regeneration).
    const latest = (request.query as { latest?: string } | undefined)?.latest === 'true'

    const { regenerateComposeFiles, regenerateComposeFilesLatest } = await import('../services/upgrade/compose-upgrader.js')
    const { getHostComposePath } = await import('../services/host-paths.js')
    const hostPath = await getHostComposePath()

    const files = latest
      ? await regenerateComposeFilesLatest(composePath, overrides, hostPath || undefined)
      : regenerateComposeFiles(composePath, overrides, hostPath || undefined)
    return reply.send(files)
  })

  /**
   * Regenerates docker-compose.yml/.env/init-db.sh from the current install state
   * (reconstructed from the existing .env), then runs `docker compose up -d` to
   * create any new containers (e.g. workers added in a registry update) without
   * forcing a recreate of unchanged services.
   *
   * Accepts optional body: { enabledModules?: string[], relayEnabled?: boolean }
   * to override the reconstructed state with user selections from the options screen.
   */
  app.post('/reconcile', { preHandler: requireSuperuser }, async (request, reply) => {
    const composePath = getComposePath()
    const composeFile = join(composePath, 'docker-compose.yml')

    if (!existsSync(composeFile)) {
      return reply.code(400).send({ error: 'No existing install found. Run /generate first.' })
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
        // Client disconnected
      }
    }

    try {
      const { upgradeCompose } = await import('../services/upgrade/compose-upgrader.js')
      const { reconstructWizardState } = await import('../services/upgrade/state-reconstructor.js')
      const { getComposeServices, getComposeWorkerIds } = await import('../services/generators/compose-generator.js')

      // Apply user overrides from the options screen (if provided). NOTE:
      // whisperModelPath is deliberately NOT a compose override — the whisper model
      // is a runtime setting (whisper.model_path) that jarvis-whisper-api reads from
      // the settings DB and hot-reloads on; it's written to the settings gateway
      // below, not baked into the generated compose (whose WHISPER_MODEL env the
      // service ignores). whisperBackend (the image variant) stays a compose concern.
      const body = request.body as { enabledModules?: string[]; relayEnabled?: boolean; relayUrl?: string; whisperModelPath?: string; whisperBackend?: 'cpu' | 'cuda' | 'vulkan' | 'rocm'; releaseTrack?: 'stable' | 'dev'; bgModelEnabled?: boolean; bgModelFile?: string } | null
      const hasOverrides = body?.enabledModules || body?.relayEnabled !== undefined || body?.whisperBackend || body?.releaseTrack || body?.bgModelEnabled !== undefined || body?.bgModelFile !== undefined
      const overrides = hasOverrides
        ? { enabledModules: body?.enabledModules, relayEnabled: body?.relayEnabled, relayUrl: body?.relayUrl, whisperBackend: body?.whisperBackend, releaseTrack: body?.releaseTrack, bgModelEnabled: body?.bgModelEnabled, bgModelFile: body?.bgModelFile }
        : undefined

      // Detect if the release track is changing (requires pull + force-recreate)
      const prevEnv = loadEnvFile(composePath)
      const prevTrack = prevEnv.JARVIS_IMAGE_TAG === 'dev' ? 'dev' : 'stable'
      const newTrack = body?.releaseTrack ?? prevTrack
      const trackChanged = newTrack !== prevTrack

      emit({ phase: 'regenerate', message: 'Regenerating compose from latest registry...' })
      await upgradeCompose(app, overrides)
      emit({ phase: 'regenerate', message: 'Files regenerated.' })

      // Whisper model is a runtime setting, not compose: write whisper.model_path to
      // the settings gateway. jarvis-whisper-api hot-reloads the model on its next
      // transcription (no container restart), so no compose recreate is needed for it.
      if (body?.whisperModelPath) {
        emit({ phase: 'whisper', message: `Setting whisper model → ${body.whisperModelPath}` })
        const res = await setWhisperModelPath(app.config.configServiceUrl, request.headers.authorization, body.whisperModelPath)
        emit(
          res.ok
            ? { phase: 'whisper', message: 'Whisper model saved (applies on the next transcription).' }
            : { phase: 'whisper', message: `⚠️ Could not update whisper model: ${res.error ?? 'unknown error'}` },
        )
      }

      // Pull new images when switching release tracks
      if (trackChanged) {
        emit({ phase: 'pull', message: `Switching to ${newTrack} track — pulling images...` })
        await new Promise<void>((resolve, reject) => {
          const pullChild = spawn('docker', ['compose', '-f', composeFile, 'pull'], {
            cwd: composePath,
            env: { ...process.env, ...loadEnvFile(composePath) },
          })
          pullChild.stdout.on('data', (chunk: Buffer) => emit({ stream: 'stdout', text: chunk.toString() }))
          pullChild.stderr.on('data', (chunk: Buffer) => emit({ stream: 'stderr', text: chunk.toString() }))
          request.raw.on('close', () => pullChild.kill())
          pullChild.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`docker compose pull exited with code ${code}`))
          })
        })
        emit({ phase: 'pull', message: 'Images pulled.' })
      }

      // Build the explicit service list for `docker compose up -d` and EXCLUDE
      // jarvis-admin. Including admin causes admin (which is the parent of this
      // very docker compose process) to recreate itself mid-sweep — the child
      // process gets SIGKILLed when the old admin container dies and remaining
      // services are left in Created state. User updates admin separately via
      // `docker compose pull jarvis-admin && docker compose up -d --force-recreate jarvis-admin`.
      const env = loadEnvFile(composePath)
      const reconstructed = reconstructWizardState(env, registry)
      const composeServices = getComposeServices(reconstructed, registry)
      const serviceIds = composeServices.filter((s) => s.id !== 'jarvis-admin').map((s) => s.id)
      const workerIds = getComposeWorkerIds(composeServices)

      // One-time Compose project-name migration. The generated compose now pins
      // `name: jarvis`. An install created before that has its running
      // containers under a directory-derived project (e.g. "compose"), so the
      // `up` below would collide on the fixed container_name:s ("container name
      // already in use" on jarvis-loki etc.). Detect a stale project from a
      // probe container and remove the stale NON-admin containers so `up`
      // recreates them under "jarvis". Their data lives in named volumes
      // (postgres/loki/grafana/...), which survive container removal.
      // jarvis-admin is left running — it is the parent of this process and is
      // updated separately. Best-effort + fully guarded: any failure here just
      // falls through to the normal `up` (which would surface a real conflict).
      try {
        let staleProject = ''
        try {
          staleProject = execSync(
            'docker inspect -f \'{{ index .Config.Labels "com.docker.compose.project" }}\' jarvis-postgres',
            { encoding: 'utf-8', timeout: 5000 },
          ).trim()
        } catch {
          /* probe container absent (fresh install) — nothing to migrate */
        }
        if (staleProject && staleProject !== 'jarvis') {
          emit({ phase: 'apply', message: `Migrating Compose project '${staleProject}' → 'jarvis' (one-time; named-volume data is preserved)...` })
          const ids = execSync(
            `docker ps -aq --filter "label=com.docker.compose.project=${staleProject}"`,
            { encoding: 'utf-8', timeout: 5000 },
          ).trim().split('\n').filter(Boolean)
          for (const id of ids) {
            let name = ''
            try {
              name = execSync(`docker inspect -f '{{.Name}}' ${id}`, { encoding: 'utf-8', timeout: 5000 }).trim().replace(/^\//, '')
            } catch { /* ignore */ }
            if (name === 'jarvis-admin') continue // never remove our own parent
            try {
              execSync(`docker rm -f ${id}`, { timeout: 20000 })
              emit({ stream: 'stdout', text: `Removed stale-project container ${name || id}\n` })
            } catch (rmErr) {
              emit({ stream: 'stderr', text: `Could not remove ${name || id}: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}\n` })
            }
          }
        }
      } catch (migErr) {
        emit({ stream: 'stderr', text: `Project-migration check skipped: ${migErr instanceof Error ? migErr.message : String(migErr)}\n` })
      }

      const upArgs = ['compose', '-f', composeFile, 'up', '-d']
      if (trackChanged) upArgs.push('--force-recreate')
      upArgs.push(...serviceIds, ...workerIds)

      emit({ phase: 'apply', message: `Applying changes to ${serviceIds.length} services + ${workerIds.length} workers (admin excluded — update separately)...` })
      const child = spawn(
        'docker',
        upArgs,
        { cwd: composePath, env: { ...process.env, ...env } },
      )

      child.stdout.on('data', (chunk: Buffer) => {
        emit({ stream: 'stdout', text: chunk.toString() })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        emit({ stream: 'stderr', text: chunk.toString() })
      })

      request.raw.on('close', () => {
        child.kill()
      })

      await new Promise<void>((resolve) => {
        child.on('close', async (code) => {
          if (code === 0) {
            // Background-model slot: the sidecar container is compose, but the
            // proxy routes to it via DB settings (model.background.*). Write
            // them here so the Reconcile toggle is ONE action, then restart the
            // llm-proxy containers (all model.* keys are requires_reload — a
            // settings write alone is silently inert).
            if (body?.bgModelEnabled !== undefined && app.config.llmProxyUrl) {
              try {
                const {
                  buildBackgroundSlotSettings,
                  buildBackgroundSlotDisableSettings,
                  computeBgCtxPerSlot,
                  writeBackgroundSlotSettings,
                } = await import('../services/bg-model-config.js')
                const bgSettings = body.bgModelEnabled
                  ? buildBackgroundSlotSettings(body.bgModelFile ?? env.BG_MODEL_FILE ?? '', computeBgCtxPerSlot(env))
                  : buildBackgroundSlotDisableSettings()
                emit({
                  phase: 'bg-model',
                  message: body.bgModelEnabled
                    ? `Pointing the LLM proxy background slot at llama-server-bg (${body.bgModelFile ?? env.BG_MODEL_FILE})...`
                    : 'Clearing the LLM proxy background slot (falls back to the live model)...',
                })
                const bgRes = await writeBackgroundSlotSettings(
                  app.config.llmProxyUrl,
                  request.headers.authorization ?? '',
                  bgSettings,
                )
                if (!bgRes.ok) {
                  emit({ phase: 'bg-model', message: `⚠️ Background slot settings failed: ${bgRes.error ?? 'unknown error'}` })
                } else {
                  if (bgRes.failedKeys.length > 0) {
                    emit({ phase: 'bg-model', message: `⚠️ Some keys were rejected (older llm-proxy image?): ${bgRes.failedKeys.join(', ')}` })
                  }
                  // Apply: model.* settings only load on model-service startup.
                  const docker = app.docker
                  if (docker) {
                    emit({ phase: 'bg-model', message: 'Restarting LLM proxy to load the background slot...' })
                    const containers = await docker.listJarvisContainers()
                    for (const c of containers.filter((x) => x.name.includes('llm-proxy') || x.name.includes('llm_proxy'))) {
                      await docker.restartContainer(c.id)
                    }
                    emit({ phase: 'bg-model', message: 'Background model slot configured.' })
                  } else {
                    emit({ phase: 'bg-model', message: '⚠️ Docker unavailable — restart the llm-proxy containers to apply the background slot.' })
                  }
                }
              } catch (bgErr) {
                emit({ stream: 'stderr', text: `Background-slot configuration warning: ${bgErr instanceof Error ? bgErr.message : String(bgErr)}\n` })
              }
            }

            // Re-register with config-service so the registry picks up any
            // coordinate changes (e.g. the external/published coords mobile
            // needs). Sync regenerates compose, but config-service registration
            // is a separate runtime step — push it here so existing installs
            // self-heal via the Sync button instead of needing a reinstall.
            try {
              emit({ phase: 'register', message: 'Re-registering services with config-service...' })
              const adminToken = env.JARVIS_AUTH_ADMIN_TOKEN ?? ''
              const configPort = parseInt(env.CONFIG_SERVICE_PORT ?? '7700', 10)
              const regServices = registry.services.filter(
                (s) => s.category === 'core' || s.category === 'recommended',
              )
              await registerServices(
                regServices,
                `http://localhost:${configPort}`,
                adminToken,
                reconstructed.portOverrides ?? {},
                composePath,
              )
              emit({ stream: 'stdout', text: 'Re-registered services with config-service\n' })
            } catch (regErr) {
              emit({ stream: 'stderr', text: `Re-register warning: ${regErr instanceof Error ? regErr.message : String(regErr)}\n` })
            }
            emit({ phase: 'done', message: 'Reconcile complete. To pick up admin changes: docker compose pull jarvis-admin && docker compose up -d --force-recreate jarvis-admin', done: true, code: 0 })
          } else {
            emit({ phase: 'error', message: `docker compose up exited with code ${code}`, done: true, code })
          }
          resolve()
        })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ phase: 'error', message: `Reconcile failed: ${message}`, done: true, code: 1 })
    }

    reply.raw.end()
  })
}

/**
 * Parse a .env file into a key-value object.
 */
function loadEnvFile(composePath: string): Record<string, string> {
  const envPath = join(composePath, '.env')
  if (!existsSync(envPath)) return {}

  const content = readFileSync(envPath, 'utf-8')
  const vars: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex)
    const value = trimmed.slice(eqIndex + 1)
    vars[key] = value
  }

  return vars
}

/**
 * Check if a port is already in use by trying to listen on it.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true)
      } else {
        resolve(false)
      }
    })
    server.once('listening', () => {
      server.close(() => resolve(false))
    })
    server.listen(port, '127.0.0.1')
  })
}
