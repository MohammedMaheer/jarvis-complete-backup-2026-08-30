import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'

function seedInstall(composePath: string): void {
  mkdirSync(composePath, { recursive: true })
  const env = [
    'DB_USER=jarvis',
    'POSTGRES_PASSWORD=p',
    'AUTH_SECRET_KEY=' + 'a'.repeat(64),
    'JARVIS_CONFIG_ADMIN_TOKEN=' + 'b'.repeat(64),
    'JARVIS_AUTH_ADMIN_TOKEN=' + 'c'.repeat(64),
    'ADMIN_API_KEY=' + 'd'.repeat(64),
    'CONFIG_SERVICE_PORT=7700',
    'AUTH_PORT=7701',
    'LOG_SERVER_PORT=7702',
    'COMMAND_CENTER_PORT=7703',
    'TTS_PORT=7707',
  ].join('\n') + '\n'
  writeFileSync(join(composePath, '.env'), env)
  writeFileSync(join(composePath, 'docker-compose.yml'), 'services: {}\n')
}

function meResponse(is_superuser: boolean): Response {
  return new Response(
    JSON.stringify({ id: 1, email: 'a@test.com', is_superuser }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('POST /api/install/regenerate-download', () => {
  let app: FastifyInstance
  let composePath: string

  beforeEach(async () => {
    composePath = mkdtempSync(join(tmpdir(), 'jarvis-regen-ep-'))
    process.env.JARVIS_COMPOSE_PATH = composePath
    app = await buildApp({ config: { authUrl: 'http://fake-auth:7701' } })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    delete process.env.JARVIS_COMPOSE_PATH
    rmSync(composePath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns regenerated files (secrets preserved) without touching originals for a superuser', async () => {
    seedInstall(composePath)
    const originalCompose = readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')
    const originalEnv = readFileSync(join(composePath, '.env'), 'utf-8')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(meResponse(true))

    const res = await app.inject({
      method: 'POST',
      url: '/api/install/regenerate-download',
      headers: { authorization: 'Bearer good' },
      payload: {},
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.compose).toContain('services:')
    expect(body.env).toContain('AUTH_SECRET_KEY=' + 'a'.repeat(64))
    expect(typeof body.initDb).toBe('string')

    // The originals are byte-for-byte untouched — this endpoint never writes.
    expect(readFileSync(join(composePath, 'docker-compose.yml'), 'utf-8')).toBe(originalCompose)
    expect(readFileSync(join(composePath, '.env'), 'utf-8')).toBe(originalEnv)
  })

  it('with ?latest=true, refreshes image digests from GHCR into the downloaded compose', async () => {
    seedInstall(composePath)
    const FRESH = 'sha256:' + '9'.repeat(64)
    // Route auth to the /me check, and every GHCR token/manifest call to FRESH.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const u = String(input)
      if (u.includes('fake-auth')) return meResponse(true)
      if (u.includes('/token')) {
        return new Response(JSON.stringify({ token: 't' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (u.includes('/manifests/')) {
        return new Response(null, { status: 200, headers: { 'docker-content-digest': FRESH } })
      }
      return new Response('', { status: 404 })
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/install/regenerate-download?latest=true',
      headers: { authorization: 'Bearer good' },
      payload: { pinImages: true },
    })

    expect(res.statusCode).toBe(200)
    // A first-party service (command-center is always present) is pinned to the
    // freshly-resolved digest, not the frozen bundled one.
    expect(res.json().compose).toContain('ghcr.io/alexberardi/jarvis-command-center@' + FRESH)
  })

  it('rejects a non-superuser with 403', async () => {
    seedInstall(composePath)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(meResponse(false))

    const res = await app.inject({
      method: 'POST',
      url: '/api/install/regenerate-download',
      headers: { authorization: 'Bearer regular' },
      payload: {},
    })

    expect(res.statusCode).toBe(403)
  })

  it('rejects a missing token with 401', async () => {
    seedInstall(composePath)

    const res = await app.inject({
      method: 'POST',
      url: '/api/install/regenerate-download',
      payload: {},
    })

    expect(res.statusCode).toBe(401)
  })
})
