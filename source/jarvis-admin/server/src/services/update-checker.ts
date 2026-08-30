import { VERSION } from '../version.js'

const REPO = 'alexberardi/jarvis-admin'
const CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  releaseNotes: string
  publishedAt: string
}

let cached: UpdateInfo | null = null
let lastCheck = 0

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function checkForUpdate(force = false, enabled = true): Promise<UpdateInfo> {
  const current = VERSION.replace(/^v/, '')

  // Privacy gate: when updates are disabled, never reach out to GitHub.
  // Fail closed — report "no update available" without any network call.
  if (!enabled) {
    return {
      currentVersion: current,
      latestVersion: current,
      updateAvailable: false,
      releaseUrl: '',
      releaseNotes: '',
      publishedAt: '',
    }
  }

  const now = Date.now()
  if (!force && cached && now - lastCheck < CHECK_INTERVAL_MS) {
    return cached
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      // Rate-limited or unavailable — return stale cache or "no update"
      return cached ?? {
        currentVersion: current,
        latestVersion: current,
        updateAvailable: false,
        releaseUrl: '',
        releaseNotes: '',
        publishedAt: '',
      }
    }

    const data = await res.json() as {
      tag_name: string
      html_url: string
      body: string
      published_at: string
    }

    const latest = data.tag_name.replace(/^v/, '')

    cached = {
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: compareSemver(latest, current) > 0,
      releaseUrl: data.html_url,
      releaseNotes: data.body ?? '',
      publishedAt: data.published_at ?? '',
    }
    lastCheck = now

    return cached
  } catch (err) {
    console.warn('[update-checker] GitHub API check failed:', err instanceof Error ? err.message : err)
    return cached ?? {
      currentVersion: current,
      latestVersion: current,
      updateAvailable: false,
      releaseUrl: '',
      releaseNotes: '',
      publishedAt: '',
    }
  }
}
