import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerServices } from '../../src/services/orchestrator.js'

/**
 * Guards the self-heal path: admin's registerServices (run on first install AND
 * on Sync/reconcile) must register each service's external/published coords so
 * an off-docker client (the mobile app, via ?style=external) gets a reachable
 * URL. If these fields are dropped, mobile discovery silently breaks again.
 */
describe('registerServices — external coords for off-docker clients', () => {
  const realFetch = global.fetch

  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => {
    global.fetch = realFetch
  })

  it('sends external_host=localhost + external_port in the register payload', async () => {
    let captured: { services: Array<Record<string, unknown>> } | null = null
    global.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body)
      return { ok: true, json: async () => ({ results: [] }) }
    }) as unknown as typeof global.fetch

    await registerServices(
      [
        { id: 'jarvis-auth', port: 7701 },
        { id: 'jarvis-command-center', port: 7703 },
        { id: 'jarvis-admin', port: 7711 }, // must be filtered out
      ] as never,
      'http://localhost:7700',
      'admin-token',
      {},
    )

    expect(captured).not.toBeNull()
    const services = captured!.services
    // admin is excluded from registration
    expect(services.find((s) => s.name === 'jarvis-admin')).toBeUndefined()

    const auth = services.find((s) => s.name === 'jarvis-auth')!
    expect(auth.external_host).toBe('localhost')
    expect(auth.external_port).toBe(7701)

    const cc = services.find((s) => s.name === 'jarvis-command-center')!
    expect(cc.external_host).toBe('localhost')
    expect(cc.external_port).toBe(7703)
  })
})
