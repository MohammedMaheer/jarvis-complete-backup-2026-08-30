import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import type { ServiceDefinition } from '../../types/service-registry.js'
import { pollServiceHealth } from '../orchestrator.js'
import { parseRegistry } from '../generators/service-registry.js'
import { getComposePath } from '../compose-path.js'
import registryData from '../../data/service-registry.json' with { type: 'json' }

type Emit = (data: Record<string, unknown>) => void

function loadEnvFromFile(composePath: string): Record<string, string> {
  const envFile = join(composePath, '.env')
  if (!existsSync(envFile)) return {}
  const vars: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
  }
  return vars
}

/** Pull all Docker images defined in the compose file. */
export async function pullImages(_app: FastifyInstance, emit: Emit): Promise<void> {
  const composePath = getComposePath()
  const composeFile = join(composePath, 'docker-compose.yml')
  const env = { ...process.env, ...loadEnvFromFile(composePath) }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', composeFile, 'pull'], {
      cwd: composePath,
      env,
    })
    child.stdout.on('data', (chunk: Buffer) => {
      emit({ stream: 'stdout', text: chunk.toString() })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      emit({ stream: 'stderr', text: chunk.toString() })
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker compose pull exited with code ${code}`))
    })
  })
}

/** Restart all services in tier order, skipping tier 0-1 (already running). */
export async function restartServices(_app: FastifyInstance, emit: Emit): Promise<void> {
  const composePath = getComposePath()
  const composeFile = join(composePath, 'docker-compose.yml')
  const env = { ...process.env, ...loadEnvFromFile(composePath) }
  const registry = parseRegistry(registryData)

  // Get all service names except tier 0-1 (config-service, auth — already running)
  // and jarvis-admin (restarting itself kills this process mid-sweep).
  // Workers are always included — registry may have added new ones since install.
  const alreadyRunning = new Set(['jarvis-config-service', 'jarvis-auth', 'jarvis-admin'])
  const remainingServices = registry.services
    .filter((s: ServiceDefinition) => !alreadyRunning.has(s.id))
    .map((s: ServiceDefinition) => s.id)
  const workerIds = registry.services.flatMap((s: ServiceDefinition) =>
    (s.workers ?? []).map((w) => w.id),
  )
  const remaining = [...remainingServices, ...workerIds]

  emit({ phase: 'restart', message: `Restarting ${remaining.length} services...` })

  await new Promise<void>((resolve) => {
    const child = spawn(
      'docker',
      ['compose', '-f', composeFile, 'up', '-d', '--force-recreate', ...remaining],
      { cwd: composePath, env },
    )
    child.stdout.on('data', (chunk: Buffer) => {
      emit({ stream: 'stdout', text: chunk.toString() })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      emit({ stream: 'stderr', text: chunk.toString() })
    })
    child.on('close', () => resolve())
  })
}

/** Verify all services are healthy. */
export async function verifyHealth(_app: FastifyInstance, emit: Emit): Promise<void> {
  const registry = parseRegistry(registryData)
  const status = await pollServiceHealth(registry.services, {})

  let healthy = 0
  let unhealthy = 0
  for (const [id, result] of Object.entries(status)) {
    if (result.healthy) {
      healthy++
    } else {
      unhealthy++
      emit({ phase: 'verify', message: `${id}: ${result.error ?? 'unhealthy'}` })
    }
  }

  emit({ phase: 'verify', message: `${healthy} healthy, ${unhealthy} unhealthy` })
}
