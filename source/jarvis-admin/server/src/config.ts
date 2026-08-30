import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export interface Config {
  port: number
  authUrl: string
  configServiceUrl: string
  llmProxyUrl: string
  commandCenterUrl: string
  commandCenterAdminKey: string
  dockerSocket: string
  registryPath: string | null
  staticDir: string | null
  /** Allowed CORS origins for the admin API. Empty = same-origin only (no
   *  cross-origin reflection). Set JARVIS_ADMIN_CORS_ORIGINS to a
   *  comma-separated allowlist (e.g. "http://localhost:5173"). */
  corsOrigins: string[]
  /** Global, box-level opt-in for outbound update checks + self-update.
   *  Defaults to false (fully local; no outbound internet unless opted in).
   *  Set JARVIS_ALLOW_UPDATES=true to allow GitHub release checks and applies. */
  allowUpdates: boolean
}

/** Persisted service URLs and version info from the setup wizard. */
interface PersistedConfig {
  authUrl?: string
  configServiceUrl?: string
  llmProxyUrl?: string
  commandCenterUrl?: string
  installedVersion?: string
  installed?: boolean
  /** Last known local runtime state. This is informational and survives WSL/Docker stops. */
  runtimeState?: 'ready' | 'offline'
  lastReadyAt?: string
  allowUpdates?: boolean
}

export function isInstalled(): boolean {
  return loadPersistedConfig().installed === true
}

const CONFIG_DIR = join(homedir(), '.jarvis')
const CONFIG_FILE = join(CONFIG_DIR, 'admin.json')

function loadPersistedConfig(): PersistedConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as PersistedConfig
    }
  } catch {
    // Corrupted file — start fresh
  }
  return {}
}

export function savePersistedConfig(urls: PersistedConfig): void {
  const existing = loadPersistedConfig()
  const merged = { ...existing, ...urls }
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n')
}

/**
 * The service registry JSON ships next to the compiled server at
 * `dist/data/service-registry.json`. Default to it when REGISTRY_PATH is
 * unset so a production container has a working registry out of the box.
 *
 * Why this exists: the production compose-generator never emitted
 * REGISTRY_PATH — only the dev compose did, and it points at the src copy.
 * So every prod admin ran with `app.registry === null`, which made every
 * registry-backed route fail. Most visibly, GET /api/service-env returned
 * 503, so the Service Credentials panel's fetch errored and the whole
 * section silently vanished from the settings page. Defaulting to the
 * bundled file fixes existing installs on the next image pull, with no
 * compose regeneration required.
 */
function bundledRegistryPath(): string | null {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'data', 'service-registry.json')
  return existsSync(bundled) ? bundled : null
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const persisted = loadPersistedConfig()

  return {
    port: parseInt(env.PORT ?? '7711', 10),
    // Priority: persisted (from setup wizard) > env var > empty (triggers setup wizard)
    authUrl: persisted.authUrl ?? env.JARVIS_AUTH_BASE_URL ?? env.AUTH_URL ?? '',
    configServiceUrl: persisted.configServiceUrl ?? env.JARVIS_CONFIG_URL ?? env.CONFIG_SERVICE_URL ?? '',
    llmProxyUrl: persisted.llmProxyUrl ?? env.JARVIS_LLM_PROXY_URL ?? env.LLM_PROXY_URL ?? '',
    commandCenterUrl: persisted.commandCenterUrl ?? env.JARVIS_COMMAND_CENTER_URL ?? env.COMMAND_CENTER_URL ?? '',
    commandCenterAdminKey: env.COMMAND_CENTER_ADMIN_KEY ?? '',
    dockerSocket: env.DOCKER_SOCKET ?? (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock'),
    registryPath: env.REGISTRY_PATH ?? bundledRegistryPath(),
    staticDir: env.STATIC_DIR ?? null,
    corsOrigins: (env.JARVIS_ADMIN_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    // Default false: fully local, no outbound update checks unless opted in.
    allowUpdates:
      (persisted.allowUpdates ??
        (env.JARVIS_ALLOW_UPDATES === 'true' || env.JARVIS_ALLOW_UPDATES === '1')) === true,
  }
}
