import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { proxyRequest } from '../services/proxy.js'
import { injectAppKeys } from '../services/orchestrator.js'
import { getComposePath } from '../services/compose-path.js'

/**
 * Persist a newly-rotated app key to the central composePath/.env so the
 * service container picks it up after restart. Mirrors the .env write
 * that ``registerServices`` already does at the end of the register
 * flow, just scoped to a single service.
 *
 * Returns true if the .env file existed and was successfully written.
 * Returns false (and logs at warn level) on any failure — callers
 * surface this via ``env_written`` in the response so the UI can tell
 * the user whether they still have manual work to do.
 *
 * Note: this targets the central ``composePath/.env`` convention with
 * prefixed key names (``JARVIS_APP_KEY_LOGS``) used by production
 * installs. Dev environments using per-service .env files with simple
 * ``JARVIS_APP_KEY`` names need a separate update (out of scope for
 * this fix — see May-2026 beta debugging notes).
 */
function persistRotatedKey(serviceName: string, appKey: string): boolean {
  const composePath = getComposePath()
  const envFile = join(composePath, '.env')
  if (!existsSync(envFile)) return false
  try {
    const envContent = readFileSync(envFile, 'utf-8')
    const { content: updatedContent } = injectAppKeys(envContent, {
      [serviceName]: { appId: serviceName, appKey },
    })
    writeFileSync(envFile, updatedContent)
    return true
  } catch (err) {
    console.warn(
      `[services] Failed to write rotated key for ${serviceName} to ${envFile}:`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

export async function servicesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  app.get('/registry', async (request, reply) => {
    const configUrl = app.config.configServiceUrl

    const result = await proxyRequest({
      method: 'GET',
      url: `${configUrl}/v1/services/registry`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 10_000,
    })

    reply.code(result.status).send(result.data)
  })

  app.post('/register', async (request, reply) => {
    const configUrl = app.config.configServiceUrl

    const result = await proxyRequest({
      method: 'POST',
      url: `${configUrl}/v1/services/register`,
      headers: { Authorization: request.headers.authorization! },
      body: request.body,
      timeout: 30_000,
    })

    reply.code(result.status).send(result.data)
  })

  app.post('/rotate-key', async (request, reply) => {
    const configUrl = app.config.configServiceUrl

    const result = await proxyRequest({
      method: 'POST',
      url: `${configUrl}/v1/services/rotate-key`,
      headers: { Authorization: request.headers.authorization! },
      body: request.body,
      timeout: 10_000,
    })

    // If rotation succeeded, write the new plaintext to the central
    // composePath/.env. Without this step, the UI used to return the
    // new key in the modal but nothing wrote it anywhere — operators
    // had to copy it by hand from the modal, and one missed copy left
    // the .env stuck on its placeholder indefinitely. (May-2026 beta
    // debugging: dev jarvis-logs never got off ``your-jarvis-logs-app-key``
    // because every rotate flow was relying on manual transcription.)
    //
    // We augment the response with ``env_written`` so the UI can tell
    // the user whether they still need to update .env manually.
    if (result.status === 200 && result.data && typeof result.data === 'object') {
      const payload = result.data as { service_name?: string; app_key?: string; env_written?: boolean | null }
      if (payload.service_name && payload.app_key) {
        const wrote = persistRotatedKey(payload.service_name, payload.app_key)
        // Preserve any env_written the upstream config-service may have
        // already set (it has its own --base-path branch); otherwise
        // surface ours.
        if (payload.env_written !== true) {
          payload.env_written = wrote
        }
        reply.code(result.status).send(payload)
        return
      }
    }

    reply.code(result.status).send(result.data)
  })

  app.post('/probe', async (request, reply) => {
    const configUrl = app.config.configServiceUrl

    const result = await proxyRequest({
      method: 'POST',
      url: `${configUrl}/v1/services/probe`,
      headers: { Authorization: request.headers.authorization! },
      body: request.body,
      timeout: 10_000,
    })

    reply.code(result.status).send(result.data)
  })

  app.get('/suggestions', async (_request, reply) => {
    const registry = app.registry
    if (!registry) {
      reply.send({ suggestions: [] })
      return
    }

    const allServices = registry.getRegistry().services
    const suggestions = allServices.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      port: s.port,
      healthCheck: s.healthCheck,
    }))

    reply.send({ suggestions })
  })

  app.delete<{ Params: { name: string } }>('/:name', async (request, reply) => {
    const configUrl = app.config.configServiceUrl
    const { name } = request.params

    const result = await proxyRequest({
      method: 'DELETE',
      url: `${configUrl}/v1/services/${encodeURIComponent(name)}`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 10_000,
    })

    reply.code(result.status).send(result.data)
  })
}
