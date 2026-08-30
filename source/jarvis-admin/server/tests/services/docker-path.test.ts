import { describe, it, expect } from 'vitest'
import { ensureDockerOnPath } from '../../src/services/docker-path.js'

describe('ensureDockerOnPath', () => {
  it('is a no-op on non-macOS platforms', () => {
    const env = { PATH: '/usr/bin:/bin' }
    ensureDockerOnPath({ platform: 'linux', exists: () => true, env })
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  it('prepends existing Docker Desktop dirs on macOS (the launchd PATH fix)', () => {
    const env = { PATH: '/usr/bin:/bin' }
    ensureDockerOnPath({
      platform: 'darwin',
      exists: (p) => p === '/opt/homebrew/bin',
      env,
    })
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin')
  })

  it('adds only dirs that actually exist', () => {
    const env = { PATH: '/usr/bin' }
    ensureDockerOnPath({
      platform: 'darwin',
      exists: (p) => p === '/usr/local/bin', // homebrew + app bundle absent
      env,
    })
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
  })

  it('never duplicates a dir already on PATH', () => {
    const env = { PATH: '/opt/homebrew/bin:/usr/bin' }
    ensureDockerOnPath({ platform: 'darwin', exists: () => true, env })
    const count = env.PATH.split(':').filter((p) => p === '/opt/homebrew/bin').length
    expect(count).toBe(1)
  })

  it('leaves PATH unchanged when no candidate dirs exist', () => {
    const env = { PATH: '/usr/bin:/bin' }
    ensureDockerOnPath({ platform: 'darwin', exists: () => false, env })
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})
