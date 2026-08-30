import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { getComposePath } from '../services/compose-path.js'
import { readEnvValues, upsertEnvVar } from '../services/env-file.js'
import type { EnvVar, ServiceDefinition } from '../services/registry.js'

/**
 * Service credentials editor — registry-declared env vars, edited in the
 * admin panel, written to the stack .env. The phone gateway's Twilio creds
 * are the first consumer (phone-calls PRD security requirement 5: secrets
 * are gateway-only ENV, never the settings DB — the Twilio auth token
 * doubles as the media-stream signature-verification key).
 *
 * Scope rules, enforced server-side:
 * - Only vars DECLARED in the service registry are visible or writable —
 *   this must never become an arbitrary .env editor.
 * - Only USER-SUPPLIED vars are visible or writable, and the SOLE marker of
 *   one is a self-referencing `${NAME:-...}` default — the paste-into-.env
 *   placeholder the installer writes for third-party keys the operator must
 *   fill in. A bare `secret: true` alone does NOT qualify: every core service
 *   declares installer-generated wiring secrets (AUTH_SECRET_KEY,
 *   ADMIN_API_KEY, MQTT_PASSWORD, *_ADMIN_TOKEN) that the operator must never
 *   touch here. Generated wiring (JARVIS_CONFIG_URL, REDIS_URL, ...) is
 *   read-only too. Today the phone gateway's Twilio creds are the only
 *   user-supplied set, so it's the only service this panel lists.
 * - Secret values are WRITE-ONLY: GET reports `is_set`, never the value.
 * - Audit logging names the vars changed, never the values.
 */

interface EnvVarView {
  name: string
  description: string
  required: boolean
  secret: boolean
  user_supplied: boolean
  is_set: boolean
  /** Current .env value — only for non-secret user-supplied vars. */
  value: string | null
  /** Registry default — shown for read-only generated vars. */
  default: string | null
}

interface ServiceEnvView {
  service_id: string
  service_name: string
  env_file_exists: boolean
  container_id: string | null
  container_running: boolean
  vars: EnvVarView[]
}

function isUserSupplied(v: EnvVar): boolean {
  // The ONE marker of a genuinely user-supplied credential is a
  // self-referencing "${NAME:-...}" placeholder default — the paste-into-.env
  // pattern the installer writes for third-party keys the operator fills in
  // (Twilio SID/token, caller ID, tunnel URL). A bare `secret: true` with no
  // such default is an INSTALLER-GENERATED wiring secret (AUTH_SECRET_KEY,
  // ADMIN_API_KEY, MQTT_PASSWORD, *_ADMIN_TOKEN, ...) that every core service
  // declares — treating those as editable turned this panel into a list of
  // every service and let an operator corrupt the stack's internal wiring.
  const d = v.default ?? ''
  return new RegExp(`^\\$\\{${v.name}(:-.*)?\\}$`).test(d)
}

function buildView(
  svc: ServiceDefinition,
  env: Record<string, string> | null,
  container: { id: string; state: string } | null,
): ServiceEnvView {
  return {
    service_id: svc.id,
    service_name: svc.name,
    env_file_exists: env !== null,
    container_id: container?.id ?? null,
    container_running: container?.state === 'running',
    vars: svc.envVars.map((v) => {
      const userSupplied = isUserSupplied(v)
      const raw = env?.[v.name]
      const isSet = raw !== undefined && raw !== ''
      return {
        name: v.name,
        description: v.description,
        required: v.required,
        secret: v.secret === true,
        user_supplied: userSupplied,
        is_set: isSet,
        value: userSupplied && !v.secret && isSet ? (raw as string) : null,
        default: userSupplied ? null : (v.default ?? null),
      }
    }),
  }
}

export async function serviceEnvRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  async function findContainer(serviceId: string): Promise<{ id: string; state: string } | null> {
    const docker = app.docker
    if (!docker) return null
    try {
      const containers = await docker.listJarvisContainers()
      const c = containers.find(
        (x) => x.name === serviceId || x.name === serviceId.replace(/^jarvis-/, ''),
      )
      return c ? { id: c.id, state: c.state } : null
    } catch {
      return null
    }
  }

  // Index: every registry service that declares at least one user-supplied
  // env var, with per-var set/not-set state. Secret values never included.
  app.get('/', async (_request, reply) => {
    const registry = app.registry
    if (!registry) {
      reply.code(503).send({ error: 'Service registry unavailable', services: [] })
      return
    }
    const env = readEnvValues()
    const services: ServiceEnvView[] = []
    for (const svc of registry.getRegistry().services) {
      if (!svc.envVars.some(isUserSupplied)) continue
      services.push(buildView(svc, env, await findContainer(svc.id)))
    }
    reply.send({ services })
  })

  // Write user-supplied vars for one service into the stack .env.
  app.put<{ Params: { serviceId: string }; Body: { values?: Record<string, unknown> } }>(
    '/:serviceId',
    async (request, reply) => {
      const registry = app.registry
      if (!registry) {
        reply.code(503).send({ error: 'Service registry unavailable' })
        return
      }
      const svc = registry.getServiceById(request.params.serviceId)
      if (!svc) {
        reply.code(404).send({ error: `Unknown service: ${request.params.serviceId}` })
        return
      }

      const values = request.body?.values
      if (!values || typeof values !== 'object' || Object.keys(values).length === 0) {
        reply.code(400).send({ error: 'Body must include a non-empty "values" object' })
        return
      }

      const editable = new Map(
        svc.envVars.filter(isUserSupplied).map((v) => [v.name, v]),
      )
      const updates: Array<[string, string]> = []
      for (const [name, value] of Object.entries(values)) {
        if (!editable.has(name)) {
          // Allowlist violation: undeclared var, or declared-but-generated
          // wiring. Refuse the whole request — no partial writes.
          reply.code(400).send({
            error: `${name} is not an editable env var for ${svc.id}`,
          })
          return
        }
        if (typeof value !== 'string') {
          reply.code(400).send({ error: `${name} must be a string` })
          return
        }
        if (/[\r\n]/.test(value)) {
          // A newline would let one value inject arbitrary extra env lines.
          reply.code(400).send({ error: `${name} must not contain newlines` })
          return
        }
        updates.push([name, value.trim()])
      }

      // upsertEnvVar returns false when the stack .env doesn't exist yet
      // (nothing installed) — probe with the first key before writing any.
      const env = readEnvValues()
      if (env === null) {
        reply.code(409).send({
          error:
            'No stack .env found — install the service first (wizard or Sync Compose), then set its credentials here.',
        })
        return
      }

      for (const [name, value] of updates) {
        upsertEnvVar(name, value)
      }

      // Audit: names only, never values.
      app.log.info(
        { service: svc.id, vars: updates.map(([n]) => n) },
        'service env vars updated via admin secrets editor',
      )

      const container = await findContainer(svc.id)
      reply.send({
        success: true,
        updated: updates.map(([n]) => n),
        restart_required: container?.state === 'running',
        container_id: container?.id ?? null,
      })
    },
  )

  // Apply saved env to the running service. This must RECREATE the container:
  // `docker restart` never re-reads compose env_file, so restarted services
  // keep their old environment (found live — the gateway's Twilio creds only
  // landed after a force-recreate). Recreate runs via the stack compose file;
  // containers the stack compose doesn't own (per-repo dev composes) get an
  // honest manual-command response instead of a fake success.
  app.post<{ Params: { serviceId: string } }>(
    '/:serviceId/apply',
    async (request, reply) => {
      const registry = app.registry
      if (!registry) {
        reply.code(503).send({ error: 'Service registry unavailable' })
        return
      }
      const svc = registry.getServiceById(request.params.serviceId)
      if (!svc) {
        reply.code(404).send({ error: `Unknown service: ${request.params.serviceId}` })
        return
      }
      // svc.id comes from the registry, but it lands in a shell command —
      // belt-and-braces beyond the registry allowlist.
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(svc.id)) {
        reply.code(400).send({ error: `Unsafe service id: ${svc.id}` })
        return
      }

      const manual = (message: string) =>
        reply.send({
          success: false,
          mode: 'manual' as const,
          message,
          command: `docker compose up -d --force-recreate ${svc.id}`,
        })

      const compose = app.compose
      const composeFile = join(getComposePath(), 'docker-compose.yml')
      if (!compose || !existsSync(composeFile)) {
        manual(
          `Saved — but no stack compose manages ${svc.name} here. Recreate its container to load the new values (a plain restart won't re-read env).`,
        )
        return
      }

      let stackServices: string[]
      try {
        stackServices = await compose.listServices(composeFile)
      } catch (err) {
        reply.code(500).send({
          error: `Could not read the stack compose file: ${(err as Error).message}`,
        })
        return
      }
      if (!stackServices.includes(svc.id)) {
        manual(
          `Saved — but ${svc.name} isn't in the stack compose (dev container?). Recreate it from its own compose project to load the new values (a plain restart won't re-read env).`,
        )
        return
      }

      try {
        await compose.recreateService(svc.id, composeFile)
      } catch (err) {
        reply.code(500).send({
          error: `Recreate failed for ${svc.id}: ${(err as Error).message}`,
        })
        return
      }

      app.log.info({ service: svc.id }, 'service recreated to apply env changes')
      reply.send({ success: true, mode: 'recreated' as const })
    },
  )
}
