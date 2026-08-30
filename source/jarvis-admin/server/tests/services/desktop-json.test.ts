import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { parsePowerShellJson } = require('../../../desktop/desktop-json.cjs') as {
  parsePowerShellJson: (chunks: Buffer[]) => Record<string, unknown>
}

describe('PowerShell desktop JSON transport', () => {
  it('parses ordinary UTF-8 JSON', () => {
    expect(parsePowerShellJson([Buffer.from('{"success":true}')])).toEqual({ success: true })
  })

  it('parses UTF-16LE output with a byte-order mark', () => {
    const body = Buffer.from('{"screenAccess":"on_demand"}', 'utf16le')
    expect(parsePowerShellJson([Buffer.concat([Buffer.from([0xff, 0xfe]), body])])).toEqual({ screenAccess: 'on_demand' })
  })

  it('accepts the final JSON envelope after a PowerShell host warning', () => {
    expect(parsePowerShellJson([Buffer.from('WARNING: local host note\r\n{"verified":true}\r\n')])).toEqual({ verified: true })
  })

  it('rejects output without a JSON response envelope', () => {
    expect(() => parsePowerShellJson([Buffer.from('not json')])).toThrow('invalid local response')
  })
})
