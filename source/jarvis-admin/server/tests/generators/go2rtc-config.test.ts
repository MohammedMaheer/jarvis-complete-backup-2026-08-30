import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GO2RTC_DEFAULT_CONFIG,
  seedGo2rtcConfig,
} from '../../src/services/generators/go2rtc-config.js'

describe('go2rtc config seeding (shared by fresh install + reconcile)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'go2rtc-seed-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates go2rtc.yaml when go2rtc is enabled and no file exists', () => {
    const wrote = seedGo2rtcConfig(dir, ['jarvis-tts', 'go2rtc'])
    expect(wrote).toBe(true)
    expect(readFileSync(join(dir, 'go2rtc.yaml'), 'utf-8')).toBe(GO2RTC_DEFAULT_CONFIG)
  })

  it('never overwrites an existing (hand-edited) go2rtc.yaml', () => {
    const handEdited = 'api:\n  listen: ":1984"\n\nstreams:\n  doorbell: rtsp://cam/1\n'
    writeFileSync(join(dir, 'go2rtc.yaml'), handEdited)

    const wrote = seedGo2rtcConfig(dir, ['go2rtc'])
    expect(wrote).toBe(false)
    expect(readFileSync(join(dir, 'go2rtc.yaml'), 'utf-8')).toBe(handEdited)
  })

  it('does nothing when go2rtc is not enabled', () => {
    const wrote = seedGo2rtcConfig(dir, ['jarvis-tts', 'jarvis-phone-gateway'])
    expect(wrote).toBe(false)
    expect(existsSync(join(dir, 'go2rtc.yaml'))).toBe(false)
  })
})
