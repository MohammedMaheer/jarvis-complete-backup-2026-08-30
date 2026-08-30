import { describe, expect, it, vi } from 'vitest'
import { runCapabilityDiagnostics, toSafeSmokeResult } from '../../src/services/capability-health.js'

const endpoints = {
  auth: 'http://127.0.0.1:7701',
  config: 'http://127.0.0.1:7700',
  commandCenter: 'http://127.0.0.1:7703',
  llm: 'http://127.0.0.1:7704',
  whisper: 'http://127.0.0.1:7706',
  tts: 'http://127.0.0.1:7707',
}

describe('capability health', () => {
  it('derives required readiness from real probe results and keeps desktop claims unknown', async () => {
    const fetcher = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })) as typeof fetch
    const report = await runCapabilityDiagnostics(endpoints, fetcher)

    expect(report.overall).toBe('DEGRADED')
    expect(report.locality).toBe('local-only')
    expect(report.capabilities.find((item) => item.id === 'llm')?.status).toBe('READY')
    expect(report.capabilities.find((item) => item.id === 'pc_control')?.status).toBe('UNKNOWN')
    expect(fetcher).toHaveBeenCalledTimes(6)

    const smoke = toSafeSmokeResult(report)
    expect(smoke.pass).toBe(true)
    expect(smoke.unverified).toContain('speaker_identity')
  })

  it('blocks readiness when one required local service is offline', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      return String(input).includes(':7704')
        ? new Response('unavailable', { status: 503 })
        : new Response('ok', { status: 200 })
    }) as typeof fetch
    const report = await runCapabilityDiagnostics(endpoints, fetcher)

    expect(report.overall).toBe('BLOCKED')
    expect(report.capabilities.find((item) => item.id === 'llm')).toMatchObject({ status: 'OFFLINE', required: true })
    expect(toSafeSmokeResult(report).pass).toBe(false)
  })

  it('does not leak response bodies into diagnostic evidence', async () => {
    const fetcher = vi.fn(async () => new Response('token=secret-value', { status: 500 })) as typeof fetch
    const report = await runCapabilityDiagnostics(endpoints, fetcher)
    expect(JSON.stringify(report)).not.toContain('secret-value')
  })
})
