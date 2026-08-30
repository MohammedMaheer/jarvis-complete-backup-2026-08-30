import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The update-checker module caches results in module-level state, so each test
 * imports a fresh copy via vi.resetModules() + dynamic import to avoid cache
 * bleed between cases.
 */
async function freshCheckForUpdate() {
  vi.resetModules()
  const mod = await import('../../src/services/update-checker.js')
  return mod.checkForUpdate
}

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not fetch when updates are disabled and reports no update', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const checkForUpdate = await freshCheckForUpdate()

    const info = await checkForUpdate(false, false)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(info.updateAvailable).toBe(false)
    expect(info.releaseUrl).toBe('')
    expect(info.currentVersion).toBe(info.latestVersion)
  })

  it('does not fetch when disabled even when forced', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const checkForUpdate = await freshCheckForUpdate()

    const info = await checkForUpdate(true, false)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(info.updateAvailable).toBe(false)
  })

  it('fetches the GitHub releases API when enabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/alexberardi/jarvis-admin/releases/v99.0.0',
          body: 'release notes',
          published_at: '2026-01-01T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const checkForUpdate = await freshCheckForUpdate()

    const info = await checkForUpdate(true, true)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('api.github.com')
    expect(info.latestVersion).toBe('99.0.0')
    expect(info.updateAvailable).toBe(true)
  })
})
