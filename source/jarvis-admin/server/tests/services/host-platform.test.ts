import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getHostPlatform, resetHostPlatformCache } from '../../src/services/host-platform.js'

const ORIG_HOST_OS = process.env.HOST_OS

describe('getHostPlatform', () => {
  beforeEach(() => {
    delete process.env.HOST_OS
    resetHostPlatformCache()
  })

  afterEach(() => {
    if (ORIG_HOST_OS === undefined) delete process.env.HOST_OS
    else process.env.HOST_OS = ORIG_HOST_OS
    resetHostPlatformCache()
    vi.restoreAllMocks()
  })

  it('returns the value of HOST_OS env var when set', () => {
    process.env.HOST_OS = 'darwin'
    expect(getHostPlatform()).toBe('darwin')
  })

  it('lowercases and trims HOST_OS env var', () => {
    process.env.HOST_OS = '  DARWIN  '
    expect(getHostPlatform()).toBe('darwin')
  })

  it('ignores invalid HOST_OS values', () => {
    process.env.HOST_OS = 'banana'
    // Should fall through to docker info / process.platform. We can't mock
    // execSync mid-import easily, so just assert it's not 'banana'.
    expect(['darwin', 'linux', 'win32']).toContain(getHostPlatform())
  })

  it('caches across calls — repeated calls return the same value', () => {
    process.env.HOST_OS = 'linux'
    const first = getHostPlatform()
    // Mutate after caching — the cached value should persist
    process.env.HOST_OS = 'darwin'
    const second = getHostPlatform()
    expect(second).toBe(first)
  })
})
