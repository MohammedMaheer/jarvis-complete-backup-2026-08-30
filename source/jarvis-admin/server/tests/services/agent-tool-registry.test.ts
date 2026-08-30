import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_REGISTRY, normalizeToolArguments } from '../../src/services/agent-tool-registry.js'

describe('agent tool registry', () => {
  it('keeps every input action approval-gated and non-retrying', () => {
    for (const name of ['cursor_move', 'cursor_click', 'click_element', 'type_text', 'key_press'] as const) {
      expect(AGENT_TOOL_REGISTRY[name]).toEqual(expect.objectContaining({ requiresApproval: true, maxRetries: 0 }))
    }
  })

  it('rejects malformed coordinates, control text, and unsupported keys', () => {
    expect(normalizeToolArguments('cursor_click', undefined, { x: Number.NaN, y: 1 })).toBeUndefined()
    expect(normalizeToolArguments('type_text', undefined, { text: 'bad\u0000text' })).toBeUndefined()
    expect(normalizeToolArguments('key_press', undefined, { key: 'WIN+R' })).toBeUndefined()
  })

  it('validates native window operations and monitor bounds', () => {
    expect(normalizeToolArguments('window_control', undefined, { query: 'Chrome', operation: 'snap_left' })).toEqual({ query: 'Chrome', operation: 'snap_left' })
    expect(normalizeToolArguments('window_control', undefined, { query: 'Chrome', operation: 'move_monitor' })).toBeUndefined()
    expect(normalizeToolArguments('window_control', undefined, { query: 'Chrome', operation: 'move_monitor', monitor: 2 })).toEqual({ query: 'Chrome', operation: 'move_monitor', monitor: 2 })
    expect(normalizeToolArguments('window_control', undefined, { query: 'Chrome', operation: 'close' as never })).toBeUndefined()
  })

  it('bounds file search and exact-file arguments', () => {
    expect(normalizeToolArguments('file_search', undefined, { extension: '.PDF', scope: 'downloads' })).toEqual({ extension: 'pdf', scope: 'downloads' })
    expect(normalizeToolArguments('file_search', undefined, {})).toBeUndefined()
    expect(normalizeToolArguments('open_file', undefined, { path: 'C:\\Users\\USER\\Downloads\\result.pdf' })).toEqual({ path: 'C:\\Users\\USER\\Downloads\\result.pdf' })
  })
})
