import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'

// Mock savePersistedConfig so setup tests don't write to disk
vi.mock('../../src/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config.js')>()
  return {
    ...original,
    savePersistedConfig: vi.fn(),
    // Setup route behavior must be isolated from the operator's real
    // ~/.jarvis/admin.json.  The production gate deliberately reads that file,
    // but a developer machine with JARVIS installed is still a first-boot
    // fixture for this suite.
    isInstalled: vi.fn(() => false),
  }
})

describe('setup routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      config: {
        authUrl: '',
        configServiceUrl: '',
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

  describe('GET /api/setup/status', () => {
    it('returns configured: false when URLs are empty', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/setup/status',
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().configured).toBe(false)
    })
  })

  describe('POST /api/setup/probe', () => {
    it('returns healthy when endpoint responds ok', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('OK', { status: 200 }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/probe',
        payload: { url: 'http://auth-host:7701' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().healthy).toBe(true)
    })

    it('tries fallback paths when /health fails', async () => {
      // /health fails
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('', { status: 404 }))
        // /info succeeds
        .mockResolvedValueOnce(new Response('OK', { status: 200 }))

      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/probe',
        payload: { url: 'http://service:7700' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().healthy).toBe(true)
    })

    it('returns 400 for invalid URL format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/probe',
        payload: { url: 'not-a-url' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/Invalid URL/i)
    })

    it('returns 400 for non-http protocol', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/probe',
        payload: { url: 'ftp://server:21/files' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/http/i)
    })

    it('returns unhealthy when all paths fail', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))

      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/probe',
        payload: { url: 'http://dead-host:9999' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().healthy).toBe(false)
      expect(res.json().error).toBeDefined()
    })

    it('returns 400 when URL is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/probe',
        payload: {},
      })

      expect(res.statusCode).toBe(400)
    })
  })

  describe('POST /api/setup/configure', () => {
    it('persists config and returns ok', async () => {
      // Mock resolveServiceUrls fetch
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ services: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/configure',
        payload: {
          authUrl: 'http://auth:7701',
          configUrl: 'http://config:7700',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(true)
    })

    it('returns 400 when fields are missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/configure',
        payload: { authUrl: 'http://auth:7701' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/required/i)
    })

    it('still returns ok when config service resolution fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new TypeError('connection refused'),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/setup/configure',
        payload: {
          authUrl: 'http://auth:7701',
          configUrl: 'http://config:7700',
        },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(true)
    })
  })
})

describe('setup routes - configured', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      config: {
        authUrl: 'http://auth:7701',
        configServiceUrl: 'http://config:7700',
      },
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns configured: true when URLs are set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('OK', { status: 200 }),
    )

    const res = await app.inject({
      method: 'GET',
      url: '/api/setup/status',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().configured).toBe(true)
  })
})
