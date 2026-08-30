import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { proxyRequest } from '../services/proxy.js'
import { requireCommandCenterAdminKey } from '../services/commandCenter.js'

export async function nodesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  // List households for the authenticated user (proxy to jarvis-auth)
  app.get('/', async (request, reply) => {
    const result = await proxyRequest({
      method: 'GET',
      url: `${app.config.authUrl}/households`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 10_000,
    })
    reply.code(result.status).send(result.data)
  })

  // List nodes in a household (proxy to jarvis-auth)
  app.get<{ Params: { householdId: string } }>(
    '/:householdId/nodes',
    async (request, reply) => {
      const { householdId } = request.params
      const result = await proxyRequest({
        method: 'GET',
        url: `${app.config.authUrl}/households/${householdId}/nodes`,
        headers: { Authorization: request.headers.authorization! },
        timeout: 10_000,
      })
      reply.code(result.status).send(result.data)
    },
  )

  // Trigger adapter training for a node (proxy to command-center)
  app.post<{ Params: { nodeId: string } }>(
    '/:nodeId/train-adapter',
    async (request, reply) => {
      const adminKey = requireCommandCenterAdminKey(app, reply)
      if (!adminKey) return
      const { nodeId } = request.params
      const result = await proxyRequest({
        method: 'POST',
        url: `${app.config.commandCenterUrl}/api/v0/nodes/${nodeId}/commands`,
        headers: { 'X-API-Key': adminKey },
        body: { command: 'train_adapter', details: {} },
        timeout: 10_000,
      })
      reply.code(result.status).send(result.data)
    },
  )
}
