import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mockSuperuserAuth } from '../helpers.js'

describe('system routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      config: { authUrl: 'http://fake-auth:7701' },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('GET /api/system/info', () => {
    it('returns system information', async () => {
      mockSuperuserAuth()
      const res = await app.inject({
        method: 'GET',
        url: '/api/system/info',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.hostname).toBeDefined()
      expect(body.platform).toBeDefined()
      expect(body.cpuCount).toBeGreaterThan(0)
      expect(body.totalMemoryMb).toBeGreaterThan(0)
      expect(body.version).toBeDefined()
      expect(body.uptime).toBeGreaterThan(0)
    })

    it('requires auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/system/info',
      })

      expect(res.statusCode).toBe(401)
    })
  })
})
