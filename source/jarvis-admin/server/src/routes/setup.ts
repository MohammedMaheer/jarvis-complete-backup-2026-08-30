import { lookup } from 'node:dns/promises'
import type { FastifyInstance } from 'fastify'
import { savePersistedConfig, isInstalled } from '../config.js'
import { requireSuperuserIfInstalled } from '../middleware/auth.js'
import { resolveServiceUrls } from '../services/configService.js'
import type { Config } from '../config.js'

interface ProbeBody {
  url: string
}

interface ProbeResult {
  healthy: boolean
  error?: string
}

// Reject link-local / cloud-metadata targets (169.254.0.0/16, incl. 169.254.169.254,
// and IPv6 fe80::/10). These are never a valid Jarvis service URL and are the classic
// SSRF pivot. RFC1918 / localhost stay allowed — the wizard legitimately probes LAN
// service URLs (e.g. http://10.0.0.5:7701, http://localhost:7700, container names).
function isBlockedProbeAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (v4.startsWith('169.254.')) return true
  if (ip.toLowerCase().startsWith('fe80:')) return true
  return false
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Check whether the admin backend has been configured with service URLs.
   * Frontend uses this to decide whether to show the setup wizard.
   */
  app.get('/status', async (_request, reply) => {
    const { authUrl, configServiceUrl } = app.config
    const installed = isInstalled()

    // URLs must be set
    if (!authUrl || !configServiceUrl) {
      // An installed runtime keeps its saved configuration even while Docker/WSL
      // is offline. Do not send the operator back through initialization.
      return reply.send(installed
        ? { configured: true, state: 'offline', reason: 'stored_configuration' }
        : { configured: false })
    }

    // Probe auth service to detect stale/unreachable URLs
    try {
      const res = await fetch(`${authUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (!res.ok) {
        return reply.send({ configured: false, reason: 'auth_unreachable' })
      }
    } catch {
      return reply.send(installed
        ? { configured: true, state: 'offline', reason: 'auth_unreachable' }
        : { configured: false, reason: 'auth_unreachable' })
    }

    return reply.send({ configured: true })
  })

  /**
   * Probe a URL's health endpoint to verify it's reachable.
   * Used by the setup wizard to validate Auth URL and Config URL.
   */
  app.post<{ Body: ProbeBody }>('/probe', async (request, reply) => {
    const { url } = request.body as ProbeBody

    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ healthy: false, error: 'URL is required' })
    }

    // Validate URL format
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return reply.code(400).send({ healthy: false, error: 'Invalid URL format' })
    }

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reply.code(400).send({ healthy: false, error: 'URL must use http or https' })
    }

    // Defense-in-depth for the native installer process: once it has recorded an
    // install, refuse the wizard probe (it becomes a redirect-only server anyway).
    // NOTE: in the containerized deployment this flag isn't present, so the real
    // SSRF protection below (metadata block + no-redirect) is what carries there.
    if (isInstalled() && !process.env.JARVIS_FORCE_INSTALL) {
      return reply.code(403).send({ healthy: false, error: 'Setup already completed' })
    }

    // Block cloud-metadata / link-local targets — the highest-value SSRF pivot.
    // Resolve and inspect the actual IPs, so a hostname whose A-record points at a
    // blocked range is caught too. RFC1918 / localhost stay allowed: the wizard
    // legitimately probes LAN service URLs. (Residual: a DNS-rebinding server can
    // return a benign IP here and a blocked one to fetch()'s own resolver — the
    // admin surface is expected to sit on a trusted LAN behind the operator's edge,
    // never on the public internet; see the threat model.)
    try {
      const resolved = await lookup(parsed.hostname, { all: true })
      if (resolved.some((a) => isBlockedProbeAddress(a.address))) {
        return reply.code(400).send({ healthy: false, error: 'Target address not allowed' })
      }
    } catch {
      // Host doesn't resolve here — not an SSRF concern. Let the probe fetch below
      // fail naturally (surfaced to the wizard as an unreachable/unhealthy target).
    }

    // Try /health first, then /info, then root
    const paths = ['/health', '/info', '/']
    let lastError = ''

    for (const path of paths) {
      try {
        const probeUrl = `${url.replace(/\/$/, '')}${path}`
        const response = await fetch(probeUrl, {
          redirect: 'manual', // never follow a 3xx into a blocked/internal target
          signal: AbortSignal.timeout(5000),
        })

        if (response.ok) {
          const result: ProbeResult = { healthy: true }
          return reply.send(result)
        }

        lastError = `HTTP ${response.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }

    const result: ProbeResult = { healthy: false, error: lastError }
    return reply.send(result)
  })

  /**
   * Save setup configuration (Auth URL and Config URL).
   * Persists to ~/.jarvis/admin.json and updates the in-memory config.
   */
  app.post<{ Body: { authUrl: string; configUrl: string } }>(
    '/configure',
    { preHandler: requireSuperuserIfInstalled },
    async (request, reply) => {
      const { authUrl, configUrl } = request.body as {
        authUrl: string
        configUrl: string
      }

      if (!authUrl || !configUrl) {
        return reply
          .code(400)
          .send({ error: 'Both authUrl and configUrl are required' })
      }

      const cleanAuthUrl = authUrl.replace(/\/$/, '')
      const cleanConfigUrl = configUrl.replace(/\/$/, '')

      // Update the running config
      app.config.authUrl = cleanAuthUrl
      app.config.configServiceUrl = cleanConfigUrl

      // Re-resolve service URLs from the new config service
      const SERVICE_NAME_TO_CONFIG: Record<string, keyof Config> = {
        'jarvis-auth': 'authUrl',
        'jarvis-llm-proxy-api': 'llmProxyUrl',
        'jarvis-command-center': 'commandCenterUrl',
        auth: 'authUrl',
        'llm-proxy': 'llmProxyUrl',
        'command-center': 'commandCenterUrl',
      }

      try {
        const serviceMap = await resolveServiceUrls(cleanConfigUrl)
        for (const [serviceName, configKey] of Object.entries(
          SERVICE_NAME_TO_CONFIG,
        )) {
          const url = serviceMap.get(serviceName)
          if (url) {
            ;(app.config as unknown as Record<string, unknown>)[configKey] = url
          }
        }
      } catch {
        // Config service may not have all services registered yet
      }

      // Persist to disk so it survives server restarts
      savePersistedConfig({
        authUrl: app.config.authUrl,
        configServiceUrl: app.config.configServiceUrl,
        llmProxyUrl: app.config.llmProxyUrl,
        commandCenterUrl: app.config.commandCenterUrl,
      })

      return reply.send({ ok: true })
    },
  )
}
