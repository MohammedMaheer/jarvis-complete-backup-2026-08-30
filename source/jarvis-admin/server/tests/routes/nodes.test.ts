import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mockSuperuserAuth, mockFetchJson } from '../helpers.js'

describe('nodes routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({
      config: {
        authUrl: 'http://fake-auth:7701',
        commandCenterUrl: 'http://fake-cc:7703',
        commandCenterAdminKey: 'test-admin-key',
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

  it('requires auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/nodes',
    })

    expect(res.statusCode).toBe(401)
  })

  describe('GET /api/nodes', () => {
    it('proxies households request to auth service', async () => {
      const households = [{ id: 'h1', name: 'Home' }]

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockFetchJson(households),
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/nodes',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(households)

      const calls = vi.mocked(fetch).mock.calls
      const householdsCall = calls.find((c) =>
        String(c[0]).includes('/households'),
      )
      expect(householdsCall).toBeDefined()
    })
  })

  describe('GET /api/nodes/:householdId/nodes', () => {
    it('proxies nodes list to auth service', async () => {
      const nodes = [
        { id: 'n1', name: 'Kitchen', household_id: 'h1' },
        { id: 'n2', name: 'Living Room', household_id: 'h1' },
      ]

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockFetchJson(nodes),
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/nodes/h1/nodes',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(nodes)

      const calls = vi.mocked(fetch).mock.calls
      const nodesCall = calls.find((c) =>
        String(c[0]).includes('/households/h1/nodes'),
      )
      expect(nodesCall).toBeDefined()
    })
  })

  describe('POST /api/nodes/:nodeId/train-adapter', () => {
    it('proxies train request to command-center with admin key', async () => {
      const trainResponse = { job_id: 'train-123', status: 'queued' }

      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockFetchJson(trainResponse),
      )

      const res = await app.inject({
        method: 'POST',
        url: '/api/nodes/n1/train-adapter',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(trainResponse)

      // Verify it uses command-center URL and admin key
      const calls = vi.mocked(fetch).mock.calls
      const trainCall = calls.find((c) =>
        String(c[0]).includes('/api/v0/nodes/n1/commands'),
      )
      expect(trainCall).toBeDefined()
      const headers = (trainCall![1] as RequestInit).headers as Record<string, string>
      expect(headers['X-API-Key']).toBe('test-admin-key')
    })

    it('sends correct body with command and details', async () => {
      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockFetchJson({ ok: true }),
      )

      await app.inject({
        method: 'POST',
        url: '/api/nodes/n1/train-adapter',
        headers: { authorization: 'Bearer valid-token' },
      })

      const calls = vi.mocked(fetch).mock.calls
      const trainCall = calls.find((c) =>
        String(c[0]).includes('/api/v0/nodes/n1/commands'),
      )
      const body = (trainCall![1] as RequestInit).body as string
      expect(JSON.parse(body)).toEqual({
        command: 'train_adapter',
        details: {},
      })
    })
  })

  describe('error forwarding', () => {
    it('forwards upstream error status', async () => {
      mockSuperuserAuth()
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockFetchJson({ detail: 'Not found' }, 404),
      )

      const res = await app.inject({
        method: 'GET',
        url: '/api/nodes/bad-id/nodes',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(404)
    })
  })
})
