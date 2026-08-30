import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'

describe('auth routes', () => {
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

  describe('POST /api/auth/login', () => {
    it('proxies login request to auth service', async () => {
      const tokenResponse = {
        access_token: 'at_123',
        refresh_token: 'rt_456',
        token_type: 'bearer',
        user: { id: 1, email: 'admin@test.com', is_superuser: true },
      }

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(tokenResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@test.com', password: 'password123' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(tokenResponse)

      // Verify the fetch was called with correct URL and body
      expect(fetch).toHaveBeenCalledWith(
        'http://fake-auth:7701/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'admin@test.com', password: 'password123' }),
        }),
      )
    })

    it('proxies 401 from auth service', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Invalid credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'wrong@test.com', password: 'bad' },
      })

      expect(res.statusCode).toBe(401)
      expect(res.json().detail).toBe('Invalid credentials')
    })
  })

  describe('POST /api/auth/refresh', () => {
    it('proxies refresh request to auth service', async () => {
      const tokenResponse = {
        access_token: 'at_new',
        refresh_token: 'rt_new',
        token_type: 'bearer',
        user: { id: 1, email: 'admin@test.com', is_superuser: true },
      }

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(tokenResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refresh_token: 'rt_456' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(tokenResponse)
    })

    it('proxies 401 for invalid refresh token', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'Invalid refresh token' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        payload: { refresh_token: 'expired-token' },
      })

      expect(res.statusCode).toBe(401)
    })
  })
})
