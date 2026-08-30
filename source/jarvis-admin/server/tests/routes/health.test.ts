import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { FastifyInstance } from 'fastify'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('GET /health', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
    expect(body.timestamp).toBeDefined()
  })

  it('returns valid ISO timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const body = res.json()
    const parsed = new Date(body.timestamp)
    expect(parsed.toISOString()).toBe(body.timestamp)
  })

  it('exposes a sanitized Windows PowerShell launcher report with a UTF-8 BOM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-startup-'))
    const reportPath = join(directory, 'startup.json')
    const previous = process.env.JARVIS_STARTUP_REPORT
    await writeFile(reportPath, `\uFEFF${JSON.stringify({
      status: 'failed',
      stage: 'auth-service',
      message: 'Auth failed its bounded readiness check.',
      timestamp: '2026-08-29T00:00:00.000Z',
      log: 'must-not-be-exposed',
    })}`)
    process.env.JARVIS_STARTUP_REPORT = reportPath

    try {
      const res = await app.inject({ method: 'GET', url: '/startup' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        status: 'failed',
        stage: 'auth-service',
        message: 'Auth failed its bounded readiness check.',
        timestamp: '2026-08-29T00:00:00.000Z',
      })
    } finally {
      if (previous === undefined) delete process.env.JARVIS_STARTUP_REPORT
      else process.env.JARVIS_STARTUP_REPORT = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})
