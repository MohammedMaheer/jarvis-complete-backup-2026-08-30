import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { proxyRequest } from '../services/proxy.js'
import { requireCommandCenterAdminKey } from '../services/commandCenter.js'

async function resolveCcUrl(app: FastifyInstance, reply: FastifyReply): Promise<string | null> {
  try {
    return await app.serviceRegistry.get('jarvis-command-center')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reply.code(503).send({ detail: `Service discovery failed: ${message}` })
    return null
  }
}

export async function tracesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  // List recent traces (proxy to command-center)
  app.get('/', async (request, reply) => {
    const adminKey = requireCommandCenterAdminKey(app, reply)
    if (!adminKey) return
    const ccUrl = await resolveCcUrl(app, reply)
    if (!ccUrl) return
    const qs = new URLSearchParams(request.query as Record<string, string>).toString()
    const url = `${ccUrl}/api/v0/admin/traces${qs ? `?${qs}` : ''}`
    const result = await proxyRequest({
      method: 'GET',
      url,
      headers: { 'X-API-Key': adminKey },
      timeout: 10_000,
    })
    reply.code(result.status).send(result.data)
  })

  // Get trace detail (proxy to command-center)
  app.get<{ Params: { traceId: string } }>(
    '/:traceId',
    async (request, reply) => {
      const adminKey = requireCommandCenterAdminKey(app, reply)
      if (!adminKey) return
      const ccUrl = await resolveCcUrl(app, reply)
      if (!ccUrl) return
      const { traceId } = request.params
      const result = await proxyRequest({
        method: 'GET',
        url: `${ccUrl}/api/v0/admin/traces/${traceId}`,
        headers: { 'X-API-Key': adminKey },
        timeout: 10_000,
      })
      reply.code(result.status).send(result.data)
    },
  )
}
