import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'

// The self-updater swaps the binary, writes ~/.jarvis/upgrade-in-progress.json,
// and restarts the process. orchestrator.ts says, in as many words:
//
//     "After restart, the new binary reads the marker and calls resumeUpgrade()"
//
// `resumeUpgrade()` was implemented — and NOTHING EVER CALLED IT. No startup
// hook read the marker. So on a standalone/native install (the documented macOS
// path) the update flow swapped the admin binary, restarted, and stopped:
//   - compose was never regenerated
//   - images were never pulled, services never restarted
//   - installedVersion in admin.json never advanced
//   - the marker sat at phase "binary-updated" forever, so /api/update/status
//     reported an upgrade permanently "in progress"
//
// i.e. the Update button updated the admin and nothing else. These tests pin the
// startup hook that finishes the job.
const { TEST_HOME } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { TEST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-resume-')) }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => TEST_HOME, default: { ...actual, homedir: () => TEST_HOME } }
})

const resumeUpgrade = vi.fn()
vi.mock('../../src/services/upgrade/orchestrator.js', () => ({
  runUpgrade: vi.fn(),
  resumeUpgrade,
}))

const { resumeUpgradeIfPending } = await import('../../src/services/upgrade/resume.js')

const JARVIS_DIR = join(TEST_HOME, '.jarvis')
const MARKER = join(JARVIS_DIR, 'upgrade-in-progress.json')
const ADMIN_JSON = join(JARVIS_DIR, 'admin.json')

function writeMarker(version: string, phase = 'binary-updated'): void {
  mkdirSync(JARVIS_DIR, { recursive: true })
  writeFileSync(MARKER, JSON.stringify({ version, phase, startedAt: new Date().toISOString() }))
}

const fakeApp = () =>
  ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }) as unknown as FastifyInstance

describe('resumeUpgradeIfPending — finishes an upgrade interrupted by the binary restart', () => {
  beforeEach(() => {
    rmSync(JARVIS_DIR, { recursive: true, force: true })
    resumeUpgrade.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when there is no marker (the normal boot path)', async () => {
    await resumeUpgradeIfPending(fakeApp(), '0.1.85')
    expect(resumeUpgrade).not.toHaveBeenCalled()
  })

  it('resumes the upgrade when the marker matches the running version', async () => {
    writeMarker('0.1.85')

    await resumeUpgradeIfPending(fakeApp(), '0.1.85')

    expect(resumeUpgrade).toHaveBeenCalledOnce()
    const [, marker] = resumeUpgrade.mock.calls[0]
    expect(marker).toMatchObject({ version: '0.1.85', phase: 'binary-updated' })
  })

  it('mirrors live phases into the marker — it is the UI\'s only window into the resume', async () => {
    writeMarker('0.1.85')
    // The SSE stream died with the old process during the binary swap, so
    // /api/update/status (which reads this marker) is all the client has left.
    resumeUpgrade.mockImplementation(async (_app, _marker, emit) => {
      emit({ phase: 'pull', message: 'Pulling updated images...' })
      const mid = JSON.parse(readFileSync(MARKER, 'utf-8')) as { phase: string }
      expect(mid.phase).toBe('pull')

      emit({ phase: 'native', message: 'Updating native services...' })
      const later = JSON.parse(readFileSync(MARKER, 'utf-8')) as { phase: string }
      expect(later.phase).toBe('native')
    })

    await resumeUpgradeIfPending(fakeApp(), '0.1.85')

    expect(resumeUpgrade).toHaveBeenCalledOnce()
  })

  it('clears the marker after a successful resume', async () => {
    writeMarker('0.1.85')

    await resumeUpgradeIfPending(fakeApp(), '0.1.85')

    // A leftover marker makes /api/update/status report "in progress" forever.
    expect(existsSync(MARKER)).toBe(false)
  })

  it('records the new version in admin.json once the upgrade actually completes', async () => {
    writeMarker('0.1.85')

    await resumeUpgradeIfPending(fakeApp(), '0.1.85')

    const saved = JSON.parse(readFileSync(ADMIN_JSON, 'utf-8')) as { installedVersion?: string }
    expect(saved.installedVersion).toBe('0.1.85')
  })

  it('keeps the marker (with the error) when the resume fails — never silently drops the upgrade', async () => {
    writeMarker('0.1.85')
    resumeUpgrade.mockRejectedValue(new Error('docker daemon unreachable'))

    // Startup must survive: a failed resume cannot take the admin down with it,
    // or the user loses the very UI they'd use to recover.
    await expect(resumeUpgradeIfPending(fakeApp(), '0.1.85')).resolves.toBeUndefined()

    expect(existsSync(MARKER)).toBe(true)
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8')) as { phase: string; error?: string }
    expect(marker.phase).toBe('error')
    expect(marker.error).toContain('docker daemon unreachable')
  })

  it('discards a stale marker from a DIFFERENT version instead of resuming it', async () => {
    // The binary we're running is not the one the marker was written for — the
    // swap didn't land (rolled back, or a hand-installed binary). Resuming would
    // regenerate compose for a version we aren't running.
    writeMarker('0.1.99')

    await resumeUpgradeIfPending(fakeApp(), '0.1.85')

    expect(resumeUpgrade).not.toHaveBeenCalled()
    expect(existsSync(MARKER)).toBe(false)
  })

  it('does not re-run an upgrade that already failed (no crash-loop on every boot)', async () => {
    writeMarker('0.1.85', 'error')

    await resumeUpgradeIfPending(fakeApp(), '0.1.85')

    expect(resumeUpgrade).not.toHaveBeenCalled()
    // Left in place so the UI can still surface the failure.
    expect(existsSync(MARKER)).toBe(true)
  })
})
