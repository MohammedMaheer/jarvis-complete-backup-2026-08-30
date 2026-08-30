import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'

describe('security headers', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ config: { authUrl: 'http://fake-auth:7701' } })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('sets a CSP that blocks framing and inline scripts', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    const csp = res.headers['content-security-policy'] as string
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    // Scripts must NOT be allowed inline (that's the XSS protection); only styles are.
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('sets anti-clickjacking + MIME-sniffing + referrer headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  })

  it('applies the headers to API routes too, not just the SPA', async () => {
    // An unauthenticated API call still carries the headers.
    const res = await app.inject({ method: 'GET', url: '/api/settings/' })
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  })
})
