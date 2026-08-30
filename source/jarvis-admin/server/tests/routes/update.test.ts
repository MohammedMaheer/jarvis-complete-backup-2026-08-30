import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mockSuperuserAuth } from '../helpers.js'

const BASE_CONFIG = {
  authUrl: 'http://fake-auth:7701',
  configServiceUrl: 'http://fake-config:7700',
}

describe('update routes', () => {
  describe('with allowUpdates: false (default privacy gate)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildApp({ config: { ...BASE_CONFIG, allowUpdates: false } })
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.restoreAllMocks()
    })

    it('GET /api/update/check returns no update without hitting GitHub', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await app.inject({ method: 'GET', url: '/api/update/check' })

      expect(res.statusCode).toBe(200)
      expect(res.json().updateAvailable).toBe(false)
      const githubCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('api.github.com'))
      expect(githubCall).toBeUndefined()
    })

    it('POST /api/update/apply returns 403 (no GitHub fetch)', async () => {
      mockSuperuserAuth()
      const fetchSpy = vi.spyOn(globalThis, 'fetch')

      const res = await app.inject({
        method: 'POST',
        url: '/api/update/apply',
        headers: { authorization: 'Bearer valid-token' },
      })

      expect(res.statusCode).toBe(403)
      // The message points at the UI toggle, not the env var: the flag is now
      // settable from the admin UI (POST /api/update/settings), so telling a
      // self-hoster to go edit a launchd plist would be actively wrong.
      expect(res.json().error).toContain('Updates are disabled')
      expect(res.json().error).toContain('/api/update/settings')
      const githubCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('api.github.com'))
      expect(githubCall).toBeUndefined()
    })
  })

  describe('with allowUpdates: true (opted in)', () => {
    let app: FastifyInstance

    beforeAll(async () => {
      app = await buildApp({ config: { ...BASE_CONFIG, allowUpdates: true } })
      await app.ready()
    })

    afterAll(async () => {
      await app.close()
    })

    beforeEach(() => {
      vi.restoreAllMocks()
    })

    it('GET /api/update/check hits the GitHub releases API', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tag_name: 'v99.0.0',
            html_url: 'https://github.com/alexberardi/jarvis-admin/releases/v99.0.0',
            body: 'notes',
            published_at: '2026-01-01T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )

      const res = await app.inject({ method: 'GET', url: '/api/update/check' })

      expect(res.statusCode).toBe(200)
      const githubCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('api.github.com'))
      expect(githubCall).toBeDefined()
    })
  })
})
