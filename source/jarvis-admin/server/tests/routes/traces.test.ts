import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import type { ServiceRegistry } from '../../src/services/serviceRegistry.js'
import { mockSuperuserAuth, mockFetchJson } from '../helpers.js'

describe('traces routes', () => {
  let app: FastifyInstance
  let registryGet: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    registryGet = vi.fn()
    const fakeRegistry = { get: registryGet, invalidate: vi.fn() } as unknown as ServiceRegistry
    app = await buildApp({
      config: {
        authUrl: 'http://fake-auth:7701',
        configServiceUrl: 'http://fake-config:7700',
        commandCenterAdminKey: 'test-admin-key',
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
    registryGet.mockReset()
  })

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/traces' })
    expect(res.statusCode).toBe(401)
  })

  describe('GET /api/traces', () => {
    it('resolves CC URL via registry and proxies the request', async () => {
      registryGet.mockResolvedValue('http://fake-cc:7703')
      const traces = { traces: [{ id: 'abc' }], total: 1 }
      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockFetchJson(traces))

      const res = await app.inject({
        method: 'GET',
        url: '/api/traces?limit=10',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(traces)
      expect(registryGet).toHaveBeenCalledWith('jarvis-command-center')

      const calls = vi.mocked(fetch).mock.calls
      const proxied = calls.find((c) => String(c[0]).includes('/api/v0/admin/traces'))
      expect(proxied).toBeDefined()
      expect(String(proxied![0])).toBe('http://fake-cc:7703/api/v0/admin/traces?limit=10')
      const headers = (proxied![1] as RequestInit).headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-admin-key')
    })

    it('returns 503 when service discovery fails', async () => {
      registryGet.mockRejectedValue(new TypeError('fetch failed'))
      mockSuperuserAuth()

      const res = await app.inject({
        method: 'GET',
        url: '/api/traces?limit=10',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(503)
      expect(res.json().detail).toContain('Service discovery failed')
      expect(res.json().detail).toContain('fetch failed')
    })

    it('forwards upstream error status', async () => {
      registryGet.mockResolvedValue('http://fake-cc:7703')
      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockFetchJson({ detail: 'CC error' }, 500),
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/traces',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(500)
    })
  })

  describe('GET /api/traces/:traceId', () => {
    it('resolves CC URL and proxies trace detail request', async () => {
      registryGet.mockResolvedValue('http://fake-cc:7703')
      const trace = { id: 'trace-1', spans: [] }
      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockFetchJson(trace))

      const res = await app.inject({
        method: 'GET',
        url: '/api/traces/trace-1',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(trace)

      const calls = vi.mocked(fetch).mock.calls
      const proxied = calls.find((c) => String(c[0]).includes('/api/v0/admin/traces/trace-1'))
      expect(proxied).toBeDefined()
      expect(String(proxied![0])).toBe('http://fake-cc:7703/api/v0/admin/traces/trace-1')
    })

    it('returns 503 when service discovery fails on detail route', async () => {
      registryGet.mockRejectedValue(new Error('config-service down'))
      mockSuperuserAuth()

      const res = await app.inject({
        method: 'GET',
        url: '/api/traces/trace-1',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(503)
    })
  })
})
