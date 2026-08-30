import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { proxyRequest } from '../services/proxy.js'

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  app.get('/', async (request, reply) => {
    const configUrl = app.config.configServiceUrl
    const query = request.url.split('?')[1] ?? ''
    const qs = query ? `?${query}` : ''

    const result = await proxyRequest({
      method: 'GET',
      url: `${configUrl}/v1/settings/${qs}`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 15_000,
    })

    reply.code(result.status).send(result.data)
  })

  app.put<{ Params: { service: string; key: string } }>(
    '/:service/:key',
    async (request, reply) => {
      const { service, key } = request.params
      const configUrl = app.config.configServiceUrl

      const result = await proxyRequest({
        method: 'PUT',
        url: `${configUrl}/v1/settings/${encodeURIComponent(service)}/${key}`,
        headers: { Authorization: request.headers.authorization! },
        body: request.body,
        timeout: 10_000,
      })

      reply.code(result.status).send(result.data)
    },
  )
}
