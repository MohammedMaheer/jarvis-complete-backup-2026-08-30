import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mockSuperuserAuth } from '../helpers.js'

describe('settings routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      config: {
        authUrl: 'http://fake-auth:7701',
        configServiceUrl: 'http://fake-config:7700',
      },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('GET /api/settings/', () => {
    it('proxies settings request to config service', async () => {
      const settingsResponse = {
        services: [{ service_name: 'jarvis-auth', success: true, settings: [], error: null, latency_ms: 5 }],
        total_services: 1,
        successful_services: 1,
        failed_services: 0,
      }

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(settingsResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/settings/',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(settingsResponse)
    })

    it('forwards query params', async () => {
      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ services: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      await app.inject({
        method: 'GET',
        url: '/api/settings/?service=jarvis-auth',
        headers: { authorization: 'Bearer valid-token' },
      })

      const calls = vi.mocked(fetch).mock.calls
      const settingsCall = calls.find((c) => String(c[0]).includes('/v1/settings/'))
      expect(settingsCall).toBeDefined()
      expect(String(settingsCall![0])).toContain('service=jarvis-auth')
    })
  })

  describe('PUT /api/settings/:service/:key', () => {
    it('proxies setting update to config service', async () => {
      const updateResponse = {
        service_name: 'jarvis-auth',
        success: true,
        key: 'jwt_expiry',
        requires_reload: false,
        message: 'Updated',
        error: null,
      }

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(updateResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/jarvis-auth/jwt_expiry',
        headers: { authorization: 'Bearer valid-token' },
        payload: { value: 3600 },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(updateResponse)
    })
  })
})
