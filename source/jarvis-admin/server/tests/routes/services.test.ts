import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mockSuperuserAuth } from '../helpers.js'

describe('services routes', () => {
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

  describe('GET /api/services/registry', () => {
    it('proxies registry request to config service', async () => {
      const registryResponse = {
        services: [
          { name: 'jarvis-auth', default_port: 7701, description: 'Auth', health_path: '/health', config_registered: true, auth_registered: true, current_host: null, current_port: null },
        ],
      }

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(registryResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/services/registry',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(registryResponse)
    })
  })

  describe('POST /api/services/register', () => {
    it('proxies register request', async () => {
      const registerResponse = {
        results: [{ name: 'jarvis-auth', config_ok: true, auth_ok: true, auth_created: true, app_key: 'key123', env_written: null, error: null }],
      }

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(registerResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/services/register',
        headers: { authorization: 'Bearer valid-token' },
        payload: { services: [{ name: 'jarvis-auth', host: 'localhost', port: 7701 }] },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(registerResponse)
    })
  })

  describe('POST /api/services/probe', () => {
    it('proxies probe request', async () => {
      const probeResponse = { healthy: true, latency_ms: 5, error: null }

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(probeResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/services/probe',
        headers: { authorization: 'Bearer valid-token' },
        payload: { host: 'localhost', port: 7701, health_path: '/health' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(probeResponse)
    })
  })
})
