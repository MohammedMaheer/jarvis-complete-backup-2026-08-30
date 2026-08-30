import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { minimizeDisposition } = require('../../../desktop/window-mode.cjs') as {
  minimizeDisposition: (state: { authenticated: boolean; currentMode: string }) => 'overlay' | 'minimize'
}

describe('Electron minimize behavior', () => {
  it('collapses an authenticated full deck into the overlay', () => {
    expect(minimizeDisposition({ authenticated: true, currentMode: 'full' })).toBe('overlay')
  })

  it('uses normal minimize before login and when already compact', () => {
    expect(minimizeDisposition({ authenticated: false, currentMode: 'full' })).toBe('minimize')
    expect(minimizeDisposition({ authenticated: true, currentMode: 'overlay' })).toBe('minimize')
  })
})
