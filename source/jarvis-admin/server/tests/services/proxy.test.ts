import { describe, it, expect, vi, beforeEach } from 'vitest'
import { proxyRequest } from '../../src/services/proxy.js'
import { mockFetchJson, mockFetchText } from '../helpers.js'

describe('proxyRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns parsed JSON for JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ ok: true }),
    )

    const result = await proxyRequest({
      method: 'GET',
      url: 'http://upstream/api',
    })

    expect(result.status).toBe(200)
    expect(result.data).toEqual({ ok: true })
  })

  it('returns plain text for non-JSON responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchText('hello world'),
    )

    const result = await proxyRequest({
      method: 'GET',
      url: 'http://upstream/text',
    })

    expect(result.status).toBe(200)
    expect(result.data).toBe('hello world')
  })

  it('forwards custom headers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({}),
    )

    await proxyRequest({
      method: 'GET',
      url: 'http://upstream/api',
      headers: { Authorization: 'Bearer token123' },
    })

    expect(fetch).toHaveBeenCalledWith(
      'http://upstream/api',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token123',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })

  it('serializes body as JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ created: true }, 201),
    )

    const result = await proxyRequest({
      method: 'POST',
      url: 'http://upstream/api',
      body: { name: 'test' },
    })

    expect(result.status).toBe(201)
    expect(fetch).toHaveBeenCalledWith(
      'http://upstream/api',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      }),
    )
  })

  it('returns 504 on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise((_resolve, reject) => {
        const err = new DOMException('The operation was aborted', 'AbortError')
        setTimeout(() => reject(err), 5)
      }),
    )

    const result = await proxyRequest({
      method: 'GET',
      url: 'http://upstream/slow',
      timeout: 1,
    })

    expect(result.status).toBe(504)
    expect(result.data).toEqual({ detail: 'Upstream request timed out' })
  })

  it('returns 502 on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed'),
    )

    const result = await proxyRequest({
      method: 'GET',
      url: 'http://upstream/down',
    })

    expect(result.status).toBe(502)
    expect(result.data).toEqual({
      detail: 'Upstream unavailable: fetch failed',
    })
  })

  it('collects response headers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'abc-123',
        },
      }),
    )

    const result = await proxyRequest({
      method: 'GET',
      url: 'http://upstream/api',
    })

    expect(result.headers['x-request-id']).toBe('abc-123')
  })
})
