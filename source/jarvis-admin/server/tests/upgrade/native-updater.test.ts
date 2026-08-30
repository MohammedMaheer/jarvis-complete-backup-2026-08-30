import { describe, it, expect, beforeEach, vi } from 'vitest'
import { updateNativeServices } from '../../src/services/upgrade/native-updater.js'
import type { NativeUpdateDeps } from '../../src/services/upgrade/native-updater.js'

// On macOS, whisper / tts / llm-proxy don't run in Docker — they're git checkouts
// under ~/.jarvis/native/<id> driven by launchd. The platform update flow
// regenerates compose and pulls Docker images... and never touches them. So a
// native service stayed frozen at whatever `main` was on the day it was
// installed, forever, and the only way to move it was a full wipe + reinstall.
//
// An update is really just: fetch → reset → re-run deploy-launchd.sh. The run
// scripts already reinstall deps when pyproject.toml changes (sentinel-gated) and
// run `alembic upgrade head` on every start, so everything downstream self-heals
// once the source moves and the agent restarts.

const LOG = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function makeDeps(over: Partial<NativeUpdateDeps> = {}): NativeUpdateDeps {
  return {
    nativeRoot: '/home/u/.jarvis/native',
    devRoot: null,
    installedNativeIds: () => ['jarvis-whisper-api'],
    sourceDirFor: (id) => `/home/u/.jarvis/native/${id}`,
    isManagedCheckout: (dir) => dir.startsWith('/home/u/.jarvis/native/'),
    hasCheckout: () => true,
    run: vi.fn().mockResolvedValue(undefined),
    log: LOG,
    ...over,
  }
}

describe('updateNativeServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('no-ops when no native services are installed (the Linux/Docker case)', async () => {
    const run = vi.fn()
    const deps = makeDeps({ installedNativeIds: () => [], run })

    const result = await updateNativeServices(deps, () => {})

    expect(run).not.toHaveBeenCalled()
    expect(result.updated).toEqual([])
  })

  it('fetches, hard-resets to the fetched head, and redeploys the launchd agent', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const deps = makeDeps({ run })

    const result = await updateNativeServices(deps, () => {})

    const calls = run.mock.calls.map((c) => [c[0], (c[1] as string[]).join(' ')])
    // Shallow clone: a plain `git pull` can't fast-forward, so fetch then reset.
    expect(calls).toContainEqual(['git', 'fetch --depth 1 origin HEAD'])
    expect(calls).toContainEqual(['git', 'reset --hard FETCH_HEAD'])
    // deploy-launchd.sh is idempotent: it re-materializes the plist and
    // bootstraps, and the run script refreshes deps + migrations on start.
    expect(calls.some(([cmd, args]) => cmd === 'bash' && args.includes('deploy-launchd.sh'))).toBe(true)

    expect(result.updated).toEqual(['jarvis-whisper-api'])
    expect(result.failed).toEqual([])
  })

  it('NEVER touches a dev checkout — that is the maintainer\'s working repo', async () => {
    const run = vi.fn()
    const deps = makeDeps({
      devRoot: '/Users/dev/jarvis',
      sourceDirFor: (id) => `/Users/dev/jarvis/${id}`,
      isManagedCheckout: () => false, // resolves to JARVIS_ROOT, not ~/.jarvis/native
      run,
    })

    const result = await updateNativeServices(deps, () => {})

    // A `git reset --hard` here would destroy uncommitted work in a real repo.
    expect(run).not.toHaveBeenCalled()
    expect(result.skipped).toEqual(['jarvis-whisper-api'])
    expect(result.updated).toEqual([])
  })

  it('skips a service whose checkout is missing rather than exploding', async () => {
    const run = vi.fn()
    const deps = makeDeps({ hasCheckout: () => false, run })

    const result = await updateNativeServices(deps, () => {})

    expect(run).not.toHaveBeenCalled()
    expect(result.skipped).toEqual(['jarvis-whisper-api'])
  })

  it('one failing service does not abort the others', async () => {
    const run = vi.fn().mockImplementation((_cmd, _args, cwd: string) => {
      if (cwd.includes('whisper')) return Promise.reject(new Error('network down'))
      return Promise.resolve()
    })
    const deps = makeDeps({
      installedNativeIds: () => ['jarvis-whisper-api', 'jarvis-tts'],
      run,
    })

    const result = await updateNativeServices(deps, () => {})

    // A broken whisper update must not leave tts on stale code — and must not
    // take the whole platform upgrade down with it.
    expect(result.updated).toEqual(['jarvis-tts'])
    expect(result.failed).toEqual([{ id: 'jarvis-whisper-api', error: 'network down' }])
  })

  it('reports progress per service', async () => {
    const emitted: Record<string, unknown>[] = []
    const deps = makeDeps({ installedNativeIds: () => ['jarvis-tts'] })

    await updateNativeServices(deps, (d) => emitted.push(d))

    const messages = emitted.map((e) => String(e.message ?? ''))
    expect(messages.some((m) => m.includes('jarvis-tts'))).toBe(true)
    expect(emitted.every((e) => e.phase === 'native')).toBe(true)
  })
})
