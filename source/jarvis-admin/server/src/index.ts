import { exec, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Fastify from 'fastify'
import { buildApp } from './app.js'
import { loadConfig, isInstalled } from './config.js'
import { VERSION } from './version.js'
import { createDockerService } from './services/docker.js'
import { createComposeService } from './services/compose.js'
import { createRegistryService } from './services/registry.js'
import { ensureDockerOnPath } from './services/docker-path.js'
import { resumeUpgradeIfPending } from './services/upgrade/resume.js'
import { shouldRedirectWhenInstalled } from './services/admin-lifecycle.js'

const REPO = 'alexberardi/jarvis-admin'

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start ${url}`
    : process.platform === 'darwin' ? `open ${url}`
    : `xdg-open ${url}`
  exec(cmd, () => {})
}

/**
 * Ensures frontend assets exist at ~/.jarvis/public/.
 * Downloads from the matching GitHub release on first run or version mismatch.
 */
async function ensureFrontendAssets(): Promise<string | null> {
  const publicDir = join(homedir(), '.jarvis', 'public')
  const versionFile = join(publicDir, '.version')

  // Already present and correct version
  if (existsSync(versionFile)) {
    const installed = readFileSync(versionFile, 'utf-8').trim()
    if (installed === VERSION && existsSync(join(publicDir, 'index.html'))) {
      return publicDir
    }
  }

  // Dev mode — no version baked in, skip download
  if (VERSION === '0.0.0-dev') {
    return null
  }

  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/public.tar.gz`
  const tarball = join(homedir(), '.jarvis', 'public.tar.gz')

  console.log(`Downloading frontend assets (v${VERSION})...`)
  mkdirSync(join(homedir(), '.jarvis'), { recursive: true })

  try {
    // Use curl (available on all platforms including Windows 10+)
    execSync(`curl -fsSL -o "${tarball}" "${url}"`, { stdio: 'pipe', timeout: 60000 })

    // Remove old assets if present
    if (existsSync(publicDir)) {
      const rmCmd = process.platform === 'win32'
        ? `rmdir /s /q "${publicDir}"`
        : `rm -rf "${publicDir}"`
      execSync(rmCmd, { stdio: 'pipe' })
    }

    // Extract
    execSync(`tar xzf "${tarball}" -C "${join(homedir(), '.jarvis')}"`, { stdio: 'pipe', timeout: 30000 })

    // Clean up tarball
    const rmTar = process.platform === 'win32'
      ? `del "${tarball}"`
      : `rm -f "${tarball}"`
    execSync(rmTar, { stdio: 'pipe' })

    // Write version marker
    writeFileSync(versionFile, VERSION)
    console.log(`Frontend assets installed to ${publicDir}`)
    return publicDir
  } catch (err) {
    console.error('Failed to download frontend assets:', err instanceof Error ? err.message : err)
    console.error(`You can manually download from: ${url}`)
    console.error(`Extract to: ${publicDir}`)
    return null
  }
}

async function startRedirectServer(port: number): Promise<void> {
  const adminPort = process.env.ADMIN_PORT ?? '7710'
  const app = Fastify({ logger: false })

  app.get('*', (request, reply) => {
    const host = (request.hostname ?? 'localhost').split(':')[0]
    reply.redirect(`http://${host}:${adminPort}`)
  })

  await app.listen({ port, host: '0.0.0.0' })
  console.log(`[jarvis-admin] Already installed. Redirecting :${port} → :${adminPort}. Set JARVIS_FORCE_INSTALL=1 to re-run setup.`)
}

async function main(): Promise<void> {
  // Make Docker Desktop's `docker` CLI resolvable before any docker call —
  // a launchd-started admin on macOS otherwise has a PATH without it, which
  // shows up as a false "Docker not found" in the install wizard.
  ensureDockerOnPath()

  const config = loadConfig()

  // On Linux the containerized admin serves the dashboard on the same port,
  // so this throwaway installer binary just redirects to it once installed.
  // On macOS there is no container — this native binary IS the admin — so it
  // must serve the full app itself (the SPA renders the dashboard once
  // installed) instead of redirecting to a port nothing listens on.
  if (isInstalled() && !process.env.JARVIS_FORCE_INSTALL && shouldRedirectWhenInstalled(process.platform)) {
    await startRedirectServer(config.port)
    return
  }

  // Auto-provision frontend assets if no STATIC_DIR is configured
  if (!config.staticDir) {
    const assetsDir = await ensureFrontendAssets()
    if (assetsDir) {
      config.staticDir = assetsDir
    }
  }

  const docker = await createDockerService(config.dockerSocket)
  const compose = createComposeService()
  const registry = config.registryPath ? createRegistryService(config.registryPath) : null

  const app = await buildApp({ config, docker, compose, registry })

  // Native desktop installations are private to this Windows account. Docker
  // deployments can explicitly keep 0.0.0.0 inside the container, while the
  // canonical Windows launcher binds the privileged admin/control API only to
  // loopback.
  const bindHost = process.env.JARVIS_ADMIN_BIND_HOST ?? '0.0.0.0'
  await app.listen({ port: config.port, host: bindHost })
  console.log(`jarvis-admin server listening on port ${config.port}`)

  // A standalone upgrade can't finish in one pass: selfUpdate() swaps the binary
  // and restarts the process, killing the request mid-flight. It leaves a marker
  // so THIS boot can finish the job (compose regen → pull → restart → verify).
  // Deliberately not awaited: it pulls images and restarts containers, which
  // takes minutes, and the UI must be up while it runs — that's where the user
  // watches /api/update/status.
  void resumeUpgradeIfPending(app, VERSION)

  openBrowser(`http://localhost:${config.port}`)
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
