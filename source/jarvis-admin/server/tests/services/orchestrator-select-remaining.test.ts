import { describe, it, expect } from 'vitest'
import { selectRemainingToStart } from '../../src/services/orchestrator.js'
import type { ServiceDefinition } from '../../src/types/service-registry.js'

const svc = (id: string, workers: string[] = []): ServiceDefinition =>
  ({ id, workers: workers.map((w) => ({ id: w })) }) as unknown as ServiceDefinition

describe('selectRemainingToStart', () => {
  const services = [
    svc('jarvis-config-service'),
    svc('jarvis-auth'),
    svc('jarvis-tts'),
    svc('jarvis-whisper-api'),      // native on macOS — excluded from compose
    svc('jarvis-llm-proxy-api', ['llm-proxy-worker']), // native on macOS
    svc('jarvis-notifications'),
  ]
  const alreadyRunning = new Set(['jarvis-config-service', 'jarvis-auth'])

  it('excludes services not in the compose (the macOS native-service crash)', () => {
    // Compose on macOS omits whisper + llm-proxy (they run natively).
    const composeServiceIds = new Set([
      'jarvis-config-service', 'jarvis-auth', 'jarvis-tts', 'jarvis-notifications',
    ])
    const remaining = selectRemainingToStart(services, alreadyRunning, composeServiceIds)
    expect(remaining).not.toContain('jarvis-whisper-api')
    expect(remaining).not.toContain('jarvis-llm-proxy-api')
    expect(remaining).not.toContain('llm-proxy-worker') // its worker too
    expect(remaining).toEqual(['jarvis-tts', 'jarvis-notifications'])
  })

  it('skips services already started in earlier tiers', () => {
    const composeServiceIds = new Set(services.map((s) => s.id))
    const remaining = selectRemainingToStart(services, alreadyRunning, composeServiceIds)
    expect(remaining).not.toContain('jarvis-config-service')
    expect(remaining).not.toContain('jarvis-auth')
  })

  it('includes a worker only when its container is in the compose', () => {
    const withWorker = new Set([...services.map((s) => s.id), 'llm-proxy-worker'])
    const remaining = selectRemainingToStart(services, alreadyRunning, withWorker)
    expect(remaining).toContain('llm-proxy-worker')
  })

  it('does not filter when compose introspection failed (null) — never blocks a valid install', () => {
    const remaining = selectRemainingToStart(services, alreadyRunning, null)
    expect(remaining).toContain('jarvis-whisper-api')
    expect(remaining).toContain('jarvis-llm-proxy-api')
  })
})
