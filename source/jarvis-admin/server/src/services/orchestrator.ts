import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, spawn } from 'node:child_process'
import type { ServiceDefinition, ServiceRegistry } from '../types/service-registry.js'
import type { HealthStatus, RegisterResult, ServiceHealthResult, TieredStartupResult } from '../types/wizard.js'

/**
 * Service tiers for ordered startup and health polling.
 * Higher tiers depend on lower tiers being healthy.
 */
const TIER_ORDER = [
  ['jarvis-config-service'],
  ['jarvis-auth'],
  ['jarvis-logs'],
  // Everything else
] as const

/**
 * Choose which services to `docker compose up` in the final startup step.
 *
 * Two filters, both load-bearing:
 *  - skip services already brought up in earlier tiers (config/auth) or already
 *    healthy on a re-run;
 *  - skip services NOT defined in the generated compose. On macOS the native
 *    GPU services (llm-proxy, whisper, ocr) run outside Docker and are excluded
 *    from the compose; passing one to `docker compose up` aborts the ENTIRE
 *    batch with "no such service: …", which left macOS installs with only
 *    config + auth running (2026-07). `composeServiceIds === null` means
 *    introspection failed — don't filter, so a valid install is never blocked.
 */
export function selectRemainingToStart(
  services: ServiceDefinition[],
  alreadyRunning: Set<string>,
  composeServiceIds: Set<string> | null,
): string[] {
  const inCompose = (id: string): boolean =>
    composeServiceIds === null || composeServiceIds.has(id)
  const remainingServices = services
    .filter((s) => !alreadyRunning.has(s.id) && inCompose(s.id))
    .map((s) => s.id)
  const workerIds = services
    .flatMap((s) => (s.workers ?? []).map((w) => w.id))
    .filter(inCompose)
  return [...remainingServices, ...workerIds]
}

/**
 * Poll health endpoints for all enabled services, tier by tier.
 */
export async function pollServiceHealth(
  services: ServiceDefinition[],
  portOverrides: Record<string, number>,
  hostOverride?: string,
): Promise<HealthStatus> {
  const status: HealthStatus = {}
  const host = hostOverride ?? 'localhost'

  const serviceMap = new Map(services.map((s) => [s.id, s]))

  for (const tier of TIER_ORDER) {
    for (const id of tier) {
      const svc = serviceMap.get(id)
      if (!svc) continue
      serviceMap.delete(id)
      const port = portOverrides[id] ?? svc.port
      const url = `http://${host}:${port}${svc.healthCheck}`
      status[id] = await checkHealth(url)
    }
  }

  const remaining = [...serviceMap.values()]
  const results = await Promise.all(
    remaining.map(async (svc) => {
      const port = portOverrides[svc.id] ?? svc.port
      const url = `http://${host}:${port}${svc.healthCheck}`
      return { id: svc.id, result: await checkHealth(url) }
    }),
  )
  for (const { id, result } of results) {
    status[id] = result
  }

  return status
}

async function checkHealth(url: string): Promise<{ healthy: boolean; url: string; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      return { healthy: true, url }
    }
    return { healthy: false, url, error: `HTTP ${res.status}` }
  } catch (err) {
    return { healthy: false, url, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Wait for a service to become healthy, polling every 2 seconds.
 */
async function waitForHealth(
  host: string,
  port: number,
  healthPath: string,
  maxWaitSeconds: number,
  emit?: (data: Record<string, unknown>) => void,
  serviceName?: string,
  phase?: string,
): Promise<boolean> {
  const url = `http://${host}:${port}${healthPath}`
  const deadline = Date.now() + maxWaitSeconds * 1000
  const startTime = Date.now()
  let lastEmitTime = 0
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return true
    } catch {
      // Not ready yet
    }
    // Emit progress every 5 seconds
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    if (emit && serviceName && phase && Date.now() - lastEmitTime >= 5000) {
      emit({ phase, message: `Waiting for ${serviceName}...`, elapsed })
      lastEmitTime = Date.now()
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/**
 * Register all services with config-service using the batch endpoint.
 * Config-service auto-creates app-clients in auth and returns app keys.
 * Injects the keys into the .env file.
 */
export async function registerServices(
  services: ServiceDefinition[],
  configServiceUrl: string,
  adminToken: string,
  portOverrides: Record<string, number>,
  composePath?: string,
): Promise<RegisterResult> {
  // Register with host.docker.internal so Docker containers can reach services
  // via host port mapping. This also supports future multi-machine deployments
  // where remote services would be re-registered with their actual IP.
  // Also register external (published) coords so off-docker clients (the mobile
  // app, via ?style=external) get a reachable URL: external_host=localhost is
  // the sentinel the client rewrites to the host it reached config-service on.
  const serviceList = services
    .filter((s) => s.id !== 'jarvis-admin') // Admin doesn't need registration
    .map((s) => ({
      name: s.id,
      host: 'host.docker.internal',
      port: portOverrides[s.id] ?? s.port,
      external_host: 'localhost',
      external_port: portOverrides[s.id] ?? s.port,
    }))

  try {
    const res = await fetch(`${configServiceUrl}/v1/services/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Jarvis-Admin-Token': adminToken,
      },
      body: JSON.stringify({ services: serviceList }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const body = await res.text()
      return {
        registered: [],
        failed: [{ serviceId: 'batch', error: `HTTP ${res.status}: ${body}` }],
        needsRestart: false,
      }
    }

    const data = await res.json() as {
      results: Array<{
        name: string
        auth_created?: boolean
        auth_ok?: boolean
        app_key?: string
      }>
    }

    const registered: string[] = []
    const failed: Array<{ serviceId: string; error: string }> = []
    const appKeys: Record<string, { appId: string; appKey: string }> = {}

    for (const r of data.results ?? []) {
      registered.push(r.name)
      if (r.app_key) {
        appKeys[r.name] = { appId: r.name, appKey: r.app_key }
      }
    }

    // Inject app keys into .env file
    if (composePath && Object.keys(appKeys).length > 0) {
      const envFile = join(composePath, '.env')
      if (existsSync(envFile)) {
        const envContent = readFileSync(envFile, 'utf-8')
        const { content: updatedContent, report } = injectAppKeys(envContent, appKeys)
        writeFileSync(envFile, updatedContent)

        // Verify all expected keys are present after write
        const verifyContent = readFileSync(envFile, 'utf-8')
        const allExpectedKeys = [...report.injected, ...report.appended]
        const missingKeys = allExpectedKeys.filter((key) => !verifyContent.includes(`${key}=`))
        if (missingKeys.length > 0) {
          console.warn(`[orchestrator] Warning: keys missing after .env write: ${missingKeys.join(', ')}`)
        }
        if (report.appended.length > 0) {
          console.log(`[orchestrator] Appended missing keys to .env: ${report.appended.join(', ')}`)
        }
      }
    }

    return {
      registered,
      failed,
      needsRestart: Object.keys(appKeys).length > 0,
      appKeys,
    }
  } catch (err) {
    return {
      registered: [],
      failed: [{ serviceId: 'batch', error: err instanceof Error ? err.message : String(err) }],
      needsRestart: false,
    }
  }
}

/**
 * Update .env file with app keys returned from registration.
 * If a key pattern isn't found in the file, the key-value pair is appended.
 * Returns a report of what was injected vs appended.
 */
export function injectAppKeys(
  envContent: string,
  appKeys: Record<string, { appId: string; appKey: string }>,
): { content: string; report: InjectReport } {
  let updated = envContent
  const injected: string[] = []
  const appended: string[] = []

  for (const [serviceId, { appId, appKey }] of Object.entries(appKeys)) {
    const suffix = serviceId.replace(/^jarvis-/, '').replace(/-/g, '_').toUpperCase()
    const idKey = `JARVIS_APP_ID_${suffix}`
    const keyKey = `JARVIS_APP_KEY_${suffix}`

    const idPattern = new RegExp(`${idKey}=.*`)
    const keyPattern = new RegExp(`${keyKey}=.*`)

    if (idPattern.test(updated)) {
      updated = updated.replace(idPattern, `${idKey}=${appId}`)
      injected.push(idKey)
    } else {
      updated = updated.trimEnd() + `\n${idKey}=${appId}\n`
      appended.push(idKey)
    }

    if (keyPattern.test(updated)) {
      updated = updated.replace(keyPattern, `${keyKey}=${appKey}`)
      injected.push(keyKey)
    } else {
      updated = updated.trimEnd() + `\n${keyKey}=${appKey}\n`
      appended.push(keyKey)
    }
  }

  return { content: updated, report: { injected, appended } }
}

export interface InjectReport {
  injected: string[]
  appended: string[]
}

/**
 * Run tiered startup: start services in dependency order, wait for health,
 * register, inject keys, restart services that got new credentials.
 *
 * Emits SSE events for UI progress.
 * Optionally accepts a set of already-healthy service IDs to skip.
 */
export async function tieredStartup(
  composeFile: string,
  composePath: string,
  services: ServiceDefinition[],
  adminToken: string,
  portOverrides: Record<string, number>,
  emit: (data: Record<string, unknown>) => void,
  alreadyHealthy?: Set<string>,
): Promise<TieredStartupResult> {
  const env = { ...process.env, ...loadEnvFromFile(composePath) }
  const configPort = portOverrides['jarvis-config-service'] ?? 7700
  const authPort = portOverrides['jarvis-auth'] ?? 7701
  const skipSet = alreadyHealthy ?? new Set<string>()

  const composeCmd = (args: string[]) =>
    new Promise<number>((resolve) => {
      const child = spawn('docker', ['compose', '-f', composeFile, ...args], {
        cwd: composePath,
        env,
      })
      child.stdout.on('data', (chunk: Buffer) => {
        emit({ stream: 'stdout', text: chunk.toString() })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        emit({ stream: 'stderr', text: chunk.toString() })
      })
      child.on('close', (code) => resolve(code ?? 1))
    })

  // Step 1: Start infrastructure (postgres, redis, mosquitto, loki, grafana)
  emit({ phase: 'infra', message: 'Starting infrastructure...' })
  await composeCmd(['up', '-d', 'postgres', 'redis', 'mosquitto', 'loki', 'grafana'])

  // Wait for postgres to be healthy (60 iterations)
  emit({ phase: 'infra', message: 'Waiting for PostgreSQL...', attempt: 1, maxAttempts: 60 })
  for (let i = 0; i < 60; i++) {
    try {
      execSync('docker exec jarvis-postgres pg_isready -U jarvis', { timeout: 3000, stdio: 'pipe' })
      break
    } catch {
      emit({ phase: 'infra', message: 'Waiting for PostgreSQL...', attempt: i + 1, maxAttempts: 60 })
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  // Step 2: Start config-service (tier 0)
  if (skipSet.has('jarvis-config-service')) {
    emit({ phase: 'tier0', message: 'config-service already healthy, skipping...' })
  } else {
    emit({ phase: 'tier0', message: 'Starting config-service...' })
    await composeCmd(['up', '-d', 'jarvis-config-service'])
    // Initial delay to let the container start before polling
    await new Promise((r) => setTimeout(r, 5000))
    emit({ phase: 'tier0', message: 'Waiting for config-service to be healthy...' })
    const configHealthy = await waitForHealth('localhost', configPort, '/health', 60, emit, 'config-service', 'tier0')
    if (!configHealthy) {
      return { success: false, error: 'config-service failed to start' }
    }
  }

  // Step 3: Start auth (tier 1)
  if (skipSet.has('jarvis-auth')) {
    emit({ phase: 'tier1', message: 'auth service already healthy, skipping...' })
  } else {
    emit({ phase: 'tier1', message: 'Starting auth service...' })
    await composeCmd(['up', '-d', 'jarvis-auth'])
    // Initial delay to let the container start before polling
    await new Promise((r) => setTimeout(r, 5000))
    emit({ phase: 'tier1', message: 'Waiting for auth to be healthy...' })
    const authHealthy = await waitForHealth('localhost', authPort, '/health', 60, emit, 'auth', 'tier1')
    if (!authHealthy) {
      return { success: false, error: 'auth service failed to start' }
    }
  }

  // Step 4: Register all services + get app keys
  emit({ phase: 'register', message: 'Registering services and generating credentials...' })
  const configServiceUrl = `http://localhost:${configPort}`
  const enabledServices = services.filter((s) => s.category === 'core' || s.category === 'recommended' || s.category === 'optional')
  const regResult = await registerServices(enabledServices, configServiceUrl, adminToken, portOverrides, composePath)

  if (regResult.failed.length > 0) {
    emit({ phase: 'register', message: `Warning: ${regResult.failed.length} service(s) failed to register` })
  }
  if (regResult.registered.length > 0) {
    emit({ phase: 'register', message: `Registered ${regResult.registered.length} service(s)` })
  }

  // Step 4b: Register infrastructure (MQTT broker) — uses CRUD endpoint, not batch
  const configAdminToken = env.JARVIS_CONFIG_ADMIN_TOKEN ?? ''
  if (configAdminToken) {
    try {
      const mqttPort = portOverrides['mosquitto'] ?? 1884
      await fetch(`${configServiceUrl}/services`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': configAdminToken,
        },
        body: JSON.stringify({
          name: 'jarvis-mqtt-broker',
          // Neutral `localhost` so the entry resolves per-consumer: in-Docker
          // services (dockerized style) → host.docker.internal, remote Pi nodes
          // (remote style) → the server IP. host.docker.internal CANNOT be
          // resolved by a remote node, so it must NOT be the registered host —
          // that's why remote nodes never discovered the broker before.
          host: 'localhost',
          port: mqttPort,
          scheme: 'mqtt',
          external_host: 'localhost',
          external_port: mqttPort,
          description: 'MQTT message broker (Mosquitto)',
          health_path: '',
        }),
        signal: AbortSignal.timeout(10_000),
      })
      emit({ phase: 'register', message: 'Registered MQTT broker' })
    } catch (err) {
      emit({ phase: 'register', message: `Warning: MQTT broker registration failed: ${err instanceof Error ? err.message : err}` })
    }
  }

  // Step 5: Start remaining services (skip tier 0-1 and already-healthy services).
  // Workers are always included — they're new containers that may not exist yet
  // even when the parent service is healthy (e.g. registry added a worker).
  const alreadyRunning = new Set(['jarvis-config-service', 'jarvis-auth', ...skipSet])

  // The generated compose may not contain every enabled service: on macOS the
  // native GPU services (llm-proxy, whisper, ocr) run outside Docker and are
  // excluded from the compose. `docker compose up -d svcA svcB missingSvc`
  // validates ALL names first and aborts the whole batch with "no such
  // service: …" if one is absent — which left macOS installs with only
  // config + auth up (2026-07). Ask compose for the services it ACTUALLY
  // defines and only ever `up` those.
  let composeServiceIds: Set<string> | null
  try {
    const out = execSync(`docker compose -f "${composeFile}" config --services`, {
      cwd: composePath,
      env,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
    })
    composeServiceIds = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    // Couldn't introspect — don't over-filter and block a valid install.
    composeServiceIds = null
  }
  const remaining = selectRemainingToStart(services, alreadyRunning, composeServiceIds)

  if (remaining.length > 0) {
    emit({ phase: 'services', message: `Starting ${remaining.length} remaining services...` })
    // Reload env after key injection
    const updatedEnv = { ...process.env, ...loadEnvFromFile(composePath) }
    const child = spawn('docker', ['compose', '-f', composeFile, 'up', '-d', '--force-recreate', ...remaining], {
      cwd: composePath,
      env: updatedEnv,
    })
    await new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        emit({ stream: 'stdout', text: chunk.toString() })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        emit({ stream: 'stderr', text: chunk.toString() })
      })
      child.on('close', () => resolve())
    })

    // Initial delay before health polling
    await new Promise((r) => setTimeout(r, 5000))
  }

  // Step 6: Poll health of all started services
  emit({ phase: 'health', message: 'Checking service health...' })
  const serviceHealth: Record<string, ServiceHealthResult> = {}
  const allStarted = services.filter((s) => s.healthCheck)

  const healthResults = await Promise.all(
    allStarted.map(async (svc) => {
      const port = portOverrides[svc.id] ?? svc.port
      const healthy = await waitForHealth('localhost', port, svc.healthCheck, 60, emit, svc.id, 'health')
      const result: ServiceHealthResult = healthy
        ? { healthy: true }
        : { healthy: false, error: `${svc.id} failed health check after 60s` }
      emit({ phase: 'health', service: svc.id, healthy: result.healthy, error: result.error })
      return { id: svc.id, result }
    }),
  )

  for (const { id, result } of healthResults) {
    serviceHealth[id] = result
  }

  const unhealthyCount = Object.values(serviceHealth).filter((h) => !h.healthy).length
  emit({ phase: 'done', message: unhealthyCount > 0 ? `Started with ${unhealthyCount} unhealthy service(s)` : 'All services started' })
  return { success: true, serviceHealth }
}

function loadEnvFromFile(composePath: string): Record<string, string> {
  const envFile = join(composePath, '.env')
  if (!existsSync(envFile)) return {}

  const vars: Record<string, string> = {}
  const content = readFileSync(envFile, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
  }
  return vars
}

/**
 * Get default enabled modules (recommended services).
 */
export function getDefaultEnabledModules(registry: ServiceRegistry): string[] {
  return registry.services
    .filter((s) => s.category === 'recommended')
    .map((s) => s.id)
}
