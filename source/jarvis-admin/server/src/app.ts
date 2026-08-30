import { existsSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { type Config, loadConfig } from './config.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { settingsRoutes } from './routes/settings.js'
import { servicesRoutes } from './routes/services.js'
import { containersRoutes } from './routes/containers.js'
import { serviceEnvRoutes } from './routes/service-env.js'
import { systemRoutes } from './routes/system.js'
import { nodesRoutes } from './routes/nodes.js'
import { setupRoutes } from './routes/setup.js'
import { llmSetupRoutes } from './routes/llm-setup.js'
import { quickSetsRoutes } from './routes/quick-sets.js'
import { modelsRoutes } from './routes/models.js'
import { updateRoutes } from './routes/update.js'
import { installRoutes } from './routes/install.js'
import { nativeServicesRoutes } from './routes/native-services.js'
import { tracesRoutes } from './routes/traces.js'
import { adminRoutes } from './routes/admin.js'
import { assistantRoutes } from './routes/assistant.js'
import { resolveServiceUrls } from './services/configService.js'
import { ServiceRegistry } from './services/serviceRegistry.js'
import type { DockerService } from './services/docker.js'
import type { ComposeService } from './services/compose.js'
import type { RegistryService } from './services/registry.js'

export interface AppOptions {
  config?: Partial<Config>
  docker?: DockerService | null
  compose?: ComposeService | null
  registry?: RegistryService | null
  serviceRegistry?: ServiceRegistry
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
    docker: DockerService | null
    compose: ComposeService | null
    registry: RegistryService | null
    serviceRegistry: ServiceRegistry
  }
}

/** Map service names from config-service to Config property names.
 *  Supports both full names (jarvis-auth) and short names (auth). */
const SERVICE_NAME_TO_CONFIG: Record<string, keyof Config> = {
  'jarvis-auth': 'authUrl',
  'jarvis-llm-proxy-api': 'llmProxyUrl',
  'jarvis-command-center': 'commandCenterUrl',
  // Short-name fallbacks
  auth: 'authUrl',
  'llm-proxy': 'llmProxyUrl',
  'command-center': 'commandCenterUrl',
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...opts.config }

  // Resolve service URLs from config-service (only fill in blanks — env vars take priority)
  const configUrlStyle = process.env.JARVIS_CONFIG_URL_STYLE || undefined
  try {
    const serviceMap = await resolveServiceUrls(config.configServiceUrl, configUrlStyle)
    for (const [serviceName, configKey] of Object.entries(SERVICE_NAME_TO_CONFIG)) {
      if (!(config as Record<string, unknown>)[configKey]) {
        const url = serviceMap.get(serviceName)
        if (url) {
          ;(config as Record<string, unknown>)[configKey] = url
        }
      }
    }
  } catch (err) {
    console.warn(
      `[jarvis-admin] Could not resolve service URLs from config-service at ${config.configServiceUrl}: ${err instanceof Error ? err.message : err}. Using defaults.`
    )
  }

  console.log(`[jarvis-admin] Service URLs: auth=${config.authUrl}, config=${config.configServiceUrl}, llm=${config.llmProxyUrl}, cc=${config.commandCenterUrl}`)

  const app = Fastify({ logger: false })

  // Treat an empty application/json body as {} instead of failing with
  // "Body cannot be empty when content-type is set to 'application/json'".
  // Many fetch() callers set Content-Type: application/json but omit the body
  // on argument-less POSTs (e.g. /api/update/apply, /api/install/reconcile).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim()
    if (raw.length === 0) return done(null, {})
    try {
      done(null, JSON.parse(raw))
    } catch (err) {
      done(err as Error, undefined)
    }
  })
  app.addContentTypeParser(['audio/wav', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  // Restrict CORS on this authenticated admin API. In production the SPA is
  // served same-origin (see fastifyStatic below), so the default is no
  // cross-origin reflection (origin: false). For split-origin dev setups, set
  // JARVIS_ADMIN_CORS_ORIGINS to an explicit comma-separated allowlist.
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  })

  // Security headers on every response (the backend also serves the SPA
  // same-origin). CSP is the SPA's XSS backstop and frame-ancestors/X-Frame-
  // Options stop clickjacking of this Docker-control surface. The built SPA is a
  // single external module script with no inline scripts, so script-src 'self'
  // holds; 'unsafe-inline' is allowed only for styles (React runtime inline
  // styles). Everything the SPA talks to is same-origin.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // TTS responses are short local WAV blobs created by the renderer. Keep
    // media origins narrow; this does not permit remote audio or scripts.
    "media-src 'self' blob: data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Content-Security-Policy', csp)
    reply.header('X-Frame-Options', 'DENY')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  })

  // Request logging for debugging
  app.addHook('onResponse', (request, reply, done) => {
    console.log(`${request.method} ${request.url} → ${reply.statusCode}`)
    done()
  })

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    console.error(`ERROR ${request.method} ${request.url}:`, error)
    reply.code(error.statusCode ?? 500).send({ error: error.message })
  })

  app.decorate('config', config)
  app.decorate('docker', opts.docker ?? null)
  app.decorate('compose', opts.compose ?? null)
  app.decorate('registry', opts.registry ?? null)
  app.decorate(
    'serviceRegistry',
    opts.serviceRegistry ??
      new ServiceRegistry(config.configServiceUrl, { style: configUrlStyle }),
  )
  app.decorateRequest('user', null as never)

  await app.register(healthRoutes)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(settingsRoutes, { prefix: '/api/settings' })
  await app.register(servicesRoutes, { prefix: '/api/services' })
  await app.register(containersRoutes, { prefix: '/api/containers' })
  await app.register(systemRoutes, { prefix: '/api/system' })
  await app.register(nodesRoutes, { prefix: '/api/nodes' })
  await app.register(setupRoutes, { prefix: '/api/setup' })
  await app.register(llmSetupRoutes, { prefix: '/api/llm-setup' })
  await app.register(quickSetsRoutes, { prefix: '/api/quick-sets' })
  await app.register(modelsRoutes, { prefix: '/api/models' })
  await app.register(updateRoutes, { prefix: '/api/update' })
  await app.register(installRoutes, { prefix: '/api/install' })
  await app.register(nativeServicesRoutes, { prefix: '/api/native-services' })
  await app.register(tracesRoutes, { prefix: '/api/traces' })
  await app.register(adminRoutes, { prefix: '/api/admin' })
  await app.register(assistantRoutes, { prefix: '/api/assistant' })
  await app.register(serviceEnvRoutes, { prefix: '/api/service-env' })

  // Serve static frontend in production
  if (config.staticDir && existsSync(config.staticDir)) {
    await app.register(fastifyStatic, {
      root: config.staticDir,
      // The shell is deployed in place by the local launcher. Never let a
      // browser or Electron keep an older index that points at a stale
      // renderer bundle (this is especially important for audio fixes).
      setHeaders: (response, filePath) => {
        if (filePath.endsWith('index.html')) response.header('Cache-Control', 'no-store, no-cache, must-revalidate')
      },
    })

    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler((_request, reply) => {
      reply.sendFile('index.html', config.staticDir!)
    })
  }

  return app
}
