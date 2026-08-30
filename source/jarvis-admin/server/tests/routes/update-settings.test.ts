import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'

// config.ts resolves ~/.jarvis/admin.json ONCE at module load
// (`const CONFIG_DIR = join(homedir(), '.jarvis')`), so homedir() has to be
// redirected before that module is imported — a later spyOn is too late.
const { TEST_HOME } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { TEST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-admin-home-')) }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TEST_HOME, default: { ...actual, homedir: () => TEST_HOME } }
})

const { buildApp } = await import('../../src/app.js')
const { mockSuperuserAuth } = await import('../helpers.js')

const ADMIN_JSON = join(TEST_HOME, '.jarvis', 'admin.json')

async function build(allowUpdates: boolean): Promise<FastifyInstance> {
  const app = await buildApp({
    config: {
      authUrl: 'http://fake-auth:7701',
      configServiceUrl: 'http://fake-config:7700',
      allowUpdates,
    },
  })
  await app.ready()
  return app
}

// `JARVIS_ALLOW_UPDATES` was env-only in practice: the only way to turn updates
// on was to hand-edit a launchd plist (or compose .env) and bootout/bootstrap
// the service. A non-technical self-hoster cannot do that, which made the
// *documented* update path unreachable for the people it was written for.
//
// The flag must be settable from the API (and therefore the UI). It persists to
// ~/.jarvis/admin.json — which loadConfig already prefers over the env var — and
// it must take effect WITHOUT a restart.
describe('update settings — allowUpdates is togglable at runtime', () => {
  let app: FastifyInstance

  beforeEach(() => {
    rmSync(ADMIN_JSON, { force: true })
  })

  afterEach(async () => {
    if (app) await app.close()
    vi.restoreAllMocks()
  })

  it('GET /api/update/settings reports the current state', async () => {
    app = await build(false)
    const res = await app.inject({ method: 'GET', url: '/api/update/settings' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ allowUpdates: false })
  })

  it('POST /api/update/settings requires a superuser (no anonymous self-enable)', async () => {
    app = await build(false)
    const res = await app.inject({
      method: 'POST',
      url: '/api/update/settings',
      payload: { allowUpdates: true },
    })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).toBeLessThan(404)
  })

  it('a superuser can enable updates, and it persists to admin.json', async () => {
    app = await build(false)
    mockSuperuserAuth()

    const res = await app.inject({
      method: 'POST',
      url: '/api/update/settings',
      headers: { authorization: 'Bearer fake-superuser-jwt' },
      payload: { allowUpdates: true },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ allowUpdates: true })

    // Persisted — survives a restart, and outranks the env var in loadConfig.
    expect(existsSync(ADMIN_JSON)).toBe(true)
    const saved = JSON.parse(readFileSync(ADMIN_JSON, 'utf-8')) as { allowUpdates?: boolean }
    expect(saved.allowUpdates).toBe(true)
  })

  it('the toggle takes effect immediately — no restart, no plist edit', async () => {
    app = await build(false)
    mockSuperuserAuth()

    await app.inject({
      method: 'POST',
      url: '/api/update/settings',
      headers: { authorization: 'Bearer fake-superuser-jwt' },
      payload: { allowUpdates: true },
    })

    // If this only landed on disk, the user would flip the switch and nothing
    // would happen until a restart — the exact UX we're removing.
    expect(app.config.allowUpdates).toBe(true)
  })

  it('a superuser can turn updates back off (round trip)', async () => {
    app = await build(true)
    mockSuperuserAuth()

    const res = await app.inject({
      method: 'POST',
      url: '/api/update/settings',
      headers: { authorization: 'Bearer fake-superuser-jwt' },
      payload: { allowUpdates: false },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ allowUpdates: false })
    expect(app.config.allowUpdates).toBe(false)
  })

  it('rejects a non-boolean allowUpdates', async () => {
    app = await build(false)
    mockSuperuserAuth()

    const res = await app.inject({
      method: 'POST',
      url: '/api/update/settings',
      headers: { authorization: 'Bearer fake-superuser-jwt' },
      payload: { allowUpdates: 'yes-please' },
    })

    expect(res.statusCode).toBe(400)
    expect(app.config.allowUpdates).toBe(false)
  })
})

// After a failed resume the marker is deliberately LEFT on disk so the failure
// stays visible. But the upgrade is over — if /status kept reporting
// inProgress:true, the UI would poll forever on something that already stopped.
describe('update status — a failed upgrade is finished, not "in progress"', () => {
  let app: FastifyInstance

  beforeEach(() => {
    rmSync(join(TEST_HOME, '.jarvis', 'upgrade-in-progress.json'), { force: true })
  })

  afterEach(async () => {
    if (app) await app.close()
    vi.restoreAllMocks()
  })

  it('reports inProgress:false and surfaces the error when the resume failed', async () => {
    mkdirSync(join(TEST_HOME, '.jarvis'), { recursive: true })
    writeFileSync(
      join(TEST_HOME, '.jarvis', 'upgrade-in-progress.json'),
      JSON.stringify({
        version: '0.1.86',
        phase: 'error',
        startedAt: new Date().toISOString(),
        error: 'docker daemon unreachable',
      }),
    )

    app = await build(true)
    const res = await app.inject({ method: 'GET', url: '/api/update/status' })

    const body = res.json() as { inProgress: boolean; phase: string; error?: string }
    expect(body.inProgress).toBe(false)
    expect(body.phase).toBe('error')
    expect(body.error).toContain('docker daemon unreachable')
  })

  it('still reports inProgress:true while the resume is genuinely running', async () => {
    mkdirSync(join(TEST_HOME, '.jarvis'), { recursive: true })
    writeFileSync(
      join(TEST_HOME, '.jarvis', 'upgrade-in-progress.json'),
      JSON.stringify({
        version: '0.1.86',
        phase: 'binary-updated',
        startedAt: new Date().toISOString(),
      }),
    )

    app = await build(true)
    const res = await app.inject({ method: 'GET', url: '/api/update/status' })
    expect((res.json() as { inProgress: boolean }).inProgress).toBe(true)
  })
})

// The silent-lie bug: with updates disabled, checkForUpdate short-circuits to
// `updateAvailable: false` WITHOUT contacting GitHub. The privacy behaviour is
// right, but the response was indistinguishable from a genuine "you're on the
// latest version" — so the UI told users they were current when it had never
// looked. The response must distinguish the two.
describe('update check — never claims "up to date" when it did not check', () => {
  let app: FastifyInstance

  afterEach(async () => {
    if (app) await app.close()
    vi.restoreAllMocks()
  })

  it('GET /api/update/check reports updatesEnabled:false when the gate is off', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    app = await build(false)

    const res = await app.inject({ method: 'GET', url: '/api/update/check' })
    expect(res.statusCode).toBe(200)

    const body = res.json() as { updateAvailable: boolean; updatesEnabled: boolean }
    expect(body.updatesEnabled).toBe(false)
    expect(body.updateAvailable).toBe(false)

    // And it genuinely made no outbound call — the privacy guarantee holds.
    const calledGitHub = fetchSpy.mock.calls.some((c) => String(c[0]).includes('api.github.com'))
    expect(calledGitHub).toBe(false)
  })
})
