import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ServiceRegistry } from '../../src/services/serviceRegistry.js'
import { mockFetchJson } from '../helpers.js'

function mockServicesResponse(): Response {
  return mockFetchJson({
    services: [
      { name: 'jarvis-command-center', url: 'http://cc:7703', host: 'cc', port: 7703 },
      { name: 'jarvis-auth', url: 'http://auth:7701', host: 'auth', port: 7701 },
    ],
  })
}

describe('ServiceRegistry', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the URL for a registered service', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockServicesResponse())
    const registry = new ServiceRegistry('http://config:7700')

    const url = await registry.get('jarvis-command-center')

    expect(url).toBe('http://cc:7703')
  })

  it('caches results within TTL', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockServicesResponse())

    const registry = new ServiceRegistry('http://config:7700', 60_000)

    expect(await registry.get('jarvis-command-center')).toBe('http://cc:7703')
    expect(await registry.get('jarvis-auth')).toBe('http://auth:7701')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches once the TTL has elapsed', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockServicesResponse())
      .mockResolvedValueOnce(mockServicesResponse())

    const registry = new ServiceRegistry('http://config:7700', 0)

    await registry.get('jarvis-command-center')
    await registry.get('jarvis-command-center')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('throws when the requested service is not registered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchJson({ services: [] }),
    )
    const registry = new ServiceRegistry('http://config:7700')

    await expect(registry.get('jarvis-command-center')).rejects.toThrow(
      "Service 'jarvis-command-center' is not registered",
    )
  })

  it('propagates config-service errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new TypeError('fetch failed'),
    )
    const registry = new ServiceRegistry('http://config:7700')

    await expect(registry.get('jarvis-command-center')).rejects.toThrow(
      'fetch failed',
    )
  })

  it('deduplicates concurrent fetches', async () => {
    let resolveResponse!: (r: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(pending)

    const registry = new ServiceRegistry('http://config:7700')
    const p1 = registry.get('jarvis-command-center')
    const p2 = registry.get('jarvis-auth')

    resolveResponse(mockServicesResponse())

    expect(await p1).toBe('http://cc:7703')
    expect(await p2).toBe('http://auth:7701')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries after invalidate()', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockServicesResponse())
      .mockResolvedValueOnce(mockServicesResponse())

    const registry = new ServiceRegistry('http://config:7700', 60_000)

    await registry.get('jarvis-command-center')
    registry.invalidate()
    await registry.get('jarvis-command-center')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('passes style query param when configured (dockerized)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockServicesResponse())

    const registry = new ServiceRegistry('http://config:7700', { style: 'dockerized' })
    await registry.get('jarvis-command-center')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'http://config:7700/services?style=dockerized',
    )
  })

  it('omits style query param when not configured', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(mockServicesResponse())

    const registry = new ServiceRegistry('http://config:7700')
    await registry.get('jarvis-command-center')

    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://config:7700/services')
  })

  it('recovers from a transient failure on the next call', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(mockServicesResponse())

    const registry = new ServiceRegistry('http://config:7700', 60_000)

    await expect(registry.get('jarvis-command-center')).rejects.toThrow(
      'fetch failed',
    )
    expect(await registry.get('jarvis-command-center')).toBe('http://cc:7703')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
