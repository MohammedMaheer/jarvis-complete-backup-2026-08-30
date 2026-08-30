import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveServiceUrls } from '../../src/services/configService.js'
import { mockFetchJson } from '../helpers.js'

describe('resolveServiceUrls', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a map of service names to URLs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({
        services: [
          { name: 'jarvis-auth', url: 'http://auth:7701', host: 'auth', port: 7701 },
          { name: 'jarvis-logs', url: 'http://logs:7702', host: 'logs', port: 7702 },
        ],
      }),
    )

    const map = await resolveServiceUrls('http://config:7700')

    expect(map.get('jarvis-auth')).toBe('http://auth:7701')
    expect(map.get('jarvis-logs')).toBe('http://logs:7702')
    expect(map.size).toBe(2)
  })

  it('strips trailing slash from config URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ services: [] }),
    )

    await resolveServiceUrls('http://config:7700/')

    expect(fetch).toHaveBeenCalledWith(
      'http://config:7700/services',
      expect.anything(),
    )
  })

  it('passes style query param when provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ services: [] }),
    )

    await resolveServiceUrls('http://config:7700', 'dockerized')

    expect(fetch).toHaveBeenCalledWith(
      'http://config:7700/services?style=dockerized',
      expect.anything(),
    )
  })

  it('throws on non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    )

    await expect(resolveServiceUrls('http://config:7700')).rejects.toThrow(
      'Config service returned 404',
    )
  })

  it('throws on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed'),
    )

    await expect(resolveServiceUrls('http://config:7700')).rejects.toThrow(
      'fetch failed',
    )
  })

  it('returns empty map for empty services list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ services: [] }),
    )

    const map = await resolveServiceUrls('http://config:7700')
    expect(map.size).toBe(0)
  })
})
