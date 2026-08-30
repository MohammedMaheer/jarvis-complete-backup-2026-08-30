import type { FastifyInstance, FastifyReply } from 'fastify'

/**
 * Returns the command-center admin key, or sends a 500 (and logs) and returns
 * null when it is not configured. Guards every route that proxies to
 * command-center's admin API: forwarding an empty `X-API-Key` gets a confusing
 * 401 back from command-center, so fail loudly here instead. The key is wired
 * from the shared `ADMIN_API_KEY` secret via the `COMMAND_CENTER_ADMIN_KEY`
 * entry on the jarvis-admin service in service-registry.json.
 */
export function requireCommandCenterAdminKey(
  app: FastifyInstance,
  reply: FastifyReply,
): string | null {
  const key = app.config.commandCenterAdminKey
  if (!key) {
    console.error(
      '[jarvis-admin] COMMAND_CENTER_ADMIN_KEY is not configured — cannot authenticate to the command-center admin API',
    )
    reply.code(500).send({
      detail:
        'COMMAND_CENTER_ADMIN_KEY is not configured; the admin dashboard cannot authenticate to command-center.',
    })
    return null
  }
  return key
}
