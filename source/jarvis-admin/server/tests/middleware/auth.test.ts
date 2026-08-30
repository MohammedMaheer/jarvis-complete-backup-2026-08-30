import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'

// The settings routes use requireSuperuser, so we test via /api/settings

describe('requireSuperuser middleware', () => {
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

  it('rejects requests without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toMatch(/missing/i)
  })

  it('rejects requests with non-Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      headers: { authorization: 'Basic abc123' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toMatch(/missing/i)
  })

  it('rejects invalid tokens (auth service returns non-200)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Invalid token' }), { status: 401 }),
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      headers: { authorization: 'Bearer bad-token' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toMatch(/invalid|expired/i)
  })

  it('rejects non-superuser accounts with 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 1, email: 'user@test.com', is_superuser: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      headers: { authorization: 'Bearer regular-user-token' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/superuser/i)
  })

  it('allows valid superuser token through', async () => {
    // First call: auth middleware calls /auth/me
    // Second call: settings proxy calls config-service
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 1, email: 'admin@test.com', is_superuser: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ services: [], total_services: 0, successful_services: 0, failed_services: 0 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      headers: { authorization: 'Bearer valid-superuser-token' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('returns 502 when auth service is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/',
      headers: { authorization: 'Bearer some-token' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/unavailable/i)
  })
})
