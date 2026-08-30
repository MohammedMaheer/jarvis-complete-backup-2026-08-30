import type { ImageDigestMap } from '../generators/compose-generator.js'
import bundledDigests from '../../data/image-digests.json' with { type: 'json' }

// The compose generator pins first-party images to a `@sha256` digest from the
// bundled image-digests.json, which is frozen at admin-build time. That makes
// `docker compose pull` a no-op — it re-pulls the exact digest already running,
// so services (including admin itself) can never update. This resolver refreshes
// those digests from GHCR at update time so a regenerated compose points at the
// newest published image and `docker compose pull` actually fetches it.
//
// Resolution uses the plain GHCR HTTP registry API (anonymous pull token, then
// the manifest's Docker-Content-Digest header) — no docker CLI dependency, and
// fully mockable in tests. Multi-arch repos publish a manifest LIST whose
// top-level digest covers every arch, so one pinned digest works cross-arch.

const REGISTRY_HOST = 'ghcr.io'
const REGISTRY_NAMESPACE = 'alexberardi'
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const TIMEOUT_MS = 15_000

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/**
 * Resolve one `repo:tag` to its manifest digest via the GHCR HTTP API. Returns
 * null on any failure (unpublished tag, rate limit, network error, malformed
 * digest) — the caller falls back to the bundled digest, so a refresh is never
 * worse than today's frozen map.
 */
export async function resolveManifestDigest(
  repo: string,
  tag: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const tokenRes = await fetchImpl(
      `https://${REGISTRY_HOST}/token?service=${REGISTRY_HOST}&scope=repository:${REGISTRY_NAMESPACE}/${repo}:pull`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    if (!tokenRes.ok) return null
    const token = ((await tokenRes.json()) as { token?: string }).token
    if (!token) return null

    const manifestRes = await fetchImpl(
      `https://${REGISTRY_HOST}/v2/${REGISTRY_NAMESPACE}/${repo}/manifests/${tag}`,
      {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    if (!manifestRes.ok) return null
    const digest = manifestRes.headers.get('docker-content-digest')
    return digest && DIGEST_RE.test(digest) ? digest : null
  } catch {
    return null
  }
}

/**
 * Return a fresh digest map for the active `track`: every bundled `(repo, tag)`
 * whose tag belongs to that track is re-resolved against GHCR; any that fails to
 * resolve keeps its bundled digest. Other tracks' entries are copied through
 * untouched. Never throws.
 */
export async function refreshDigestsForTrack(
  track: 'latest' | 'dev',
  base: ImageDigestMap = bundledDigests as ImageDigestMap,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageDigestMap> {
  const result: ImageDigestMap = {}
  const jobs: Promise<void>[] = []
  for (const [repo, tags] of Object.entries(base)) {
    result[repo] = { ...tags }
    for (const tag of Object.keys(tags)) {
      // Only the active track is used by the generator (the other track's pins
      // are dead weight), so don't spend network calls resolving it.
      if (tag !== track && !tag.startsWith(`${track}-`)) continue
      // Resolve concurrently. Sequential await-per-tag made a refresh cost the
      // SUM of ~17 round-trips — seconds per upgrade, and it blew unit-test
      // timeouts under load. resolveManifestDigest self-contains its errors +
      // timeout (returns null), so Promise.all never rejects.
      jobs.push(
        resolveManifestDigest(repo, tag, fetchImpl).then((fresh) => {
          if (fresh) result[repo][tag] = fresh
        }),
      )
    }
  }
  await Promise.all(jobs)
  return result
}
