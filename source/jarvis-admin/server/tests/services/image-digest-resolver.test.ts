import { describe, it, expect, vi } from 'vitest'
import {
  resolveManifestDigest,
  refreshDigestsForTrack,
} from '../../src/services/upgrade/image-digest-resolver.js'

const FRESH = 'sha256:' + 'b'.repeat(64)

// A fetch that answers GHCR's token endpoint with a token and every manifest
// request with the FRESH digest in the Docker-Content-Digest header.
function digestFetch(): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/token')) {
      return new Response(JSON.stringify({ token: 'anon-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(null, { status: 200, headers: { 'docker-content-digest': FRESH } })
  }) as unknown as typeof fetch
}

describe('image-digest-resolver', () => {
  it('resolves repo:tag -> manifest digest via GHCR token + Docker-Content-Digest header', async () => {
    const d = await resolveManifestDigest('jarvis-admin', 'latest', digestFetch())
    expect(d).toBe(FRESH)
  })

  it('returns null when the registry errors (caller keeps the bundled digest)', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await resolveManifestDigest('jarvis-admin', 'latest', fetchImpl)).toBeNull()
  })

  it('refreshes only the active track and merges fresh digests over the bundled map', async () => {
    const base = {
      'jarvis-admin': { latest: 'sha256:' + 'c'.repeat(64), dev: 'sha256:' + 'd'.repeat(64) },
      'jarvis-whisper-api': {
        latest: 'sha256:' + 'e'.repeat(64),
        'latest-cuda': 'sha256:' + 'f'.repeat(64),
      },
    }
    const out = await refreshDigestsForTrack('latest', base, digestFetch())
    expect(out['jarvis-admin'].latest).toBe(FRESH)
    expect(out['jarvis-whisper-api']['latest-cuda']).toBe(FRESH)
    // The other track's entries are left untouched.
    expect(out['jarvis-admin'].dev).toBe(base['jarvis-admin'].dev)
  })

  it('never throws; keeps the bundled digest for any tag that fails to resolve', async () => {
    const base = { 'jarvis-admin': { latest: 'sha256:' + 'c'.repeat(64) } }
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    const out = await refreshDigestsForTrack('latest', base, fetchImpl)
    expect(out['jarvis-admin'].latest).toBe(base['jarvis-admin'].latest)
  })
})
