import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import type { ServiceRegistry } from '../../src/services/serviceRegistry.js'
import { mockSuperuserAuth } from '../helpers.js'

// Every route that proxies to command-center's admin API forwards
// `X-API-Key: app.config.commandCenterAdminKey`. If that key is unset it must
// FAIL LOUDLY (500 + log) rather than silently forwarding an empty key and
// getting a confusing 401 back from command-center — the exact bug that shipped
// when the traces router gained admin auth but the key was never wired.
describe('command-center admin key guard (empty key fails loudly)', () => {
  let app: FastifyInstance
  let registryGet: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    registryGet = vi.fn().mockResolvedValue('http://fake-cc:7703')
    const fakeRegistry = { get: registryGet, invalidate: vi.fn() } as unknown as ServiceRegistry
    app = await buildApp({
      config: {
        authUrl: 'http://fake-auth:7701',
        configServiceUrl: 'http://fake-config:7700',
        commandCenterUrl: 'http://fake-cc:7703',
        commandCenterAdminKey: '', // the misconfiguration we are guarding against
      },
      serviceRegistry: fakeRegistry,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    registryGet.mockClear()
  })

  const CASES = [
    { name: 'GET /api/traces', method: 'GET' as const, url: '/api/traces?limit=10' },
    { name: 'GET /api/traces/:id', method: 'GET' as const, url: '/api/traces/abc' },
    {
      name: 'POST /api/nodes/:id/train-adapter',
      method: 'POST' as const,
      url: '/api/nodes/n1/train-adapter',
    },
  ]

  for (const c of CASES) {
    it(`${c.name} returns 500 and never forwards an empty key`, async () => {
      mockSuperuserAuth()
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await app.inject({
        method: c.method,
        url: c.url,
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(500)
      expect(String(res.json().detail)).toMatch(/COMMAND_CENTER_ADMIN_KEY/)

      // No proxy call to command-center happened (only the superuser /me check).
      const proxied = fetchSpy.mock.calls.find((call) => String(call[0]).includes('fake-cc'))
      expect(proxied).toBeUndefined()
    })
  }
})
