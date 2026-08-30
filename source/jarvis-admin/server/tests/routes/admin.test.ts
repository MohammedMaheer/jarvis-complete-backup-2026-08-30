import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mockSuperuserAuth, mockFetchJson } from '../helpers.js'

describe('admin routes (cross-household views)', () => {
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

  it('requires auth on /api/admin/households', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/households' })
    expect(res.statusCode).toBe(401)
  })

  it('requires auth on /api/admin/nodes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/nodes' })
    expect(res.statusCode).toBe(401)
  })

  it('proxies households to /superuser/households on jarvis-auth', async () => {
    const households = [
      { id: 'h1', name: 'Alpha House', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'h2', name: 'Beta House', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
    ]
    mockSuperuserAuth()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockFetchJson(households))

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/households',
      headers: { authorization: 'Bearer valid-token' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(households)

    const calls = vi.mocked(fetch).mock.calls
    const proxied = calls.find((c) => String(c[0]).includes('/superuser/households'))
    expect(proxied).toBeDefined()
    expect(String(proxied![0])).toBe('http://fake-auth:7701/superuser/households')
    const headers = (proxied![1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer valid-token')
  })

  it('proxies nodes to /superuser/nodes on jarvis-auth', async () => {
    const nodes = [
      { node_id: 'kitchen-pi', name: 'Kitchen', household_id: 'h1', is_active: true, services: [] },
    ]
    mockSuperuserAuth()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockFetchJson(nodes))

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/nodes',
      headers: { authorization: 'Bearer valid-token' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(nodes)
  })

  it('forwards upstream error status', async () => {
    mockSuperuserAuth()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ detail: 'Superuser access required' }, 403),
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/households',
      headers: { authorization: 'Bearer valid-token' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('requires auth on /api/admin/users', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' })
    expect(res.statusCode).toBe(401)
  })

  it('proxies users to /superuser/users on jarvis-auth', async () => {
    const users = [
      {
        id: 1,
        email: 'alex@example.com',
        username: 'alex',
        is_active: true,
        is_superuser: true,
        must_change_password: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: null,
        households: [{ household_id: 'h1', household_name: 'My Home', role: 'admin' }],
      },
    ]
    mockSuperuserAuth()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockFetchJson(users))

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: 'Bearer valid-token' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(users)

    const calls = vi.mocked(fetch).mock.calls
    const proxied = calls.find((c) => String(c[0]).includes('/superuser/users'))
    expect(proxied).toBeDefined()
    expect(String(proxied![0])).toBe('http://fake-auth:7701/superuser/users')
    const headers = (proxied![1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer valid-token')
  })

  it('requires auth on temp-password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/users/1/temp-password' })
    expect(res.statusCode).toBe(401)
  })

  it('proxies temp-password issuance and forwards the body', async () => {
    const upstream = {
      temp_password: 'xK4m-Tq9w-Rj2n',
      expires_at: '2026-07-03T10:00:00Z',
      must_change_password: true,
    }
    mockSuperuserAuth()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockFetchJson(upstream))

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/42/temp-password',
      headers: { authorization: 'Bearer valid-token' },
      payload: { expires_in_hours: 2 },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(upstream)

    const calls = vi.mocked(fetch).mock.calls
    const proxied = calls.find((c) => String(c[0]).includes('/temp-password'))
    expect(proxied).toBeDefined()
    expect(String(proxied![0])).toBe('http://fake-auth:7701/superuser/users/42/temp-password')
    const init = proxied![1] as RequestInit
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ expires_in_hours: 2 })
  })

  it('rejects a non-numeric user id without calling upstream', async () => {
    mockSuperuserAuth()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/1%2F..%2Fevil/temp-password',
      headers: { authorization: 'Bearer valid-token' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    const upstreamCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('fake-auth:7701/superuser/users'),
    )
    expect(upstreamCalls).toHaveLength(0)
  })

  it('forwards upstream error status from temp-password (e.g. 409 inactive user)', async () => {
    mockSuperuserAuth()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ detail: 'User is deactivated' }, 409),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/7/temp-password',
      headers: { authorization: 'Bearer valid-token' },
      payload: {},
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ detail: 'User is deactivated' })
  })
})
