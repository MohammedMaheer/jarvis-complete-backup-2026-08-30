import { describe, it, expect } from 'vitest'
import {
  shouldSelfTerminateAfterInstall,
  shouldRedirectWhenInstalled,
} from '../../src/services/admin-lifecycle.js'

describe('admin-lifecycle: post-install self-termination', () => {
  it('does NOT self-terminate on macOS — the native binary is the permanent admin', () => {
    // Regression guard: the native macOS admin must stay alive after install so
    // the dashboard + native-services (llm-proxy/whisper/tts) step keep a
    // backend. Killing it is what made "all native pulls fail".
    expect(shouldSelfTerminateAfterInstall('darwin')).toBe(false)
  })

  it('self-terminates on Linux — the containerized admin takes over the port', () => {
    expect(shouldSelfTerminateAfterInstall('linux')).toBe(true)
  })

  it('self-terminates on any non-darwin platform (hands off to a container)', () => {
    expect(shouldSelfTerminateAfterInstall('windows' as never)).toBe(true)
  })
})

describe('admin-lifecycle: serve-vs-redirect when already installed', () => {
  it('serves the full app on macOS (no container to redirect to)', () => {
    expect(shouldRedirectWhenInstalled('darwin')).toBe(false)
  })

  it('redirects to the containerized dashboard on Linux', () => {
    expect(shouldRedirectWhenInstalled('linux')).toBe(true)
  })

  it('redirects on other non-darwin platforms', () => {
    expect(shouldRedirectWhenInstalled('win32')).toBe(true)
  })
})
