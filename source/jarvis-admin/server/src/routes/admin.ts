import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { proxyRequest } from '../services/proxy.js'

/**
 * Cross-household admin views (households, nodes, users) that the regular
 * user-scoped routes don't expose. Backed by jarvis-auth's
 * /superuser/* endpoints; the caller's superuser JWT is forwarded.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  app.get('/households', async (request, reply) => {
    const result = await proxyRequest({
      method: 'GET',
      url: `${app.config.authUrl}/superuser/households`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 10_000,
    })
    reply.code(result.status).send(result.data)
  })

  app.get('/nodes', async (request, reply) => {
    const result = await proxyRequest({
      method: 'GET',
      url: `${app.config.authUrl}/superuser/nodes`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 10_000,
    })
    reply.code(result.status).send(result.data)
  })

  app.get('/users', async (request, reply) => {
    const result = await proxyRequest({
      method: 'GET',
      url: `${app.config.authUrl}/superuser/users`,
      headers: { Authorization: request.headers.authorization! },
      timeout: 10_000,
    })
    reply.code(result.status).send(result.data)
  })

  app.post<{ Params: { userId: string }; Body: unknown }>(
    '/users/:userId/temp-password',
    async (request, reply) => {
      // Numeric-only: the id is interpolated into the upstream URL.
      if (!/^\d+$/.test(request.params.userId)) {
        reply.code(400).send({ detail: 'Invalid user id' })
        return
      }
      const result = await proxyRequest({
        method: 'POST',
        url: `${app.config.authUrl}/superuser/users/${request.params.userId}/temp-password`,
        headers: { Authorization: request.headers.authorization! },
        body: request.body ?? {},
        timeout: 10_000,
      })
      reply.code(result.status).send(result.data)
    },
  )
}
