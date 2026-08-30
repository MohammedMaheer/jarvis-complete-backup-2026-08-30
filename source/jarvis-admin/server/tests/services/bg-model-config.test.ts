import { describe, it, expect } from 'vitest'
import {
  buildBackgroundSlotSettings,
  buildBackgroundSlotDisableSettings,
  computeBgCtxPerSlot,
} from '../../src/services/bg-model-config.js'

describe('bg-model-config: background slot settings payloads', () => {
  it('enable payload points the slot at llama-server-bg with thinking unrestricted', () => {
    const s = buildBackgroundSlotSettings('Qwen3.8-27B-UD-Q3_K_XL.gguf', 16384)
    expect(s['model.background.backend']).toBe('REST')
    // Must differ from the live model path or the proxy shares one instance.
    expect(s['model.background.name']).toBe('.models/Qwen3.8-27B-UD-Q3_K_XL.gguf')
    expect(s['model.background.rest_url']).toBe('http://llama-server-bg:8080')
    expect(s['model.background.context_window']).toBe(16384)
    expect(s['model.background.reasoning_budget']).toBe('-1')
    // Thinking jobs can run past the 60s defaults; 240s is the runaway ceiling.
    expect(s['model_service.timeout_seconds']).toBe(240)
    expect(s['rest.timeout_seconds']).toBe(240)
  })

  it('disable payload clears the slot back to live-sharing and keeps timeouts', () => {
    const s = buildBackgroundSlotDisableSettings()
    expect(s['model.background.backend']).toBe('')
    expect(s['model.background.name']).toBe('')
    expect(s['model.background.rest_url']).toBe('')
    expect(s['model.background.context_window']).toBe(0)
    expect(s['model.background.reasoning_budget']).toBe('')
    expect(s).not.toHaveProperty('model_service.timeout_seconds')
    expect(s).not.toHaveProperty('rest.timeout_seconds')
  })

  it('per-slot context = BG_MODEL_CTX / BG_MODEL_NP with compose defaults 32768/2', () => {
    expect(computeBgCtxPerSlot({})).toBe(16384)
    expect(computeBgCtxPerSlot({ BG_MODEL_CTX: '65536', BG_MODEL_NP: '4' })).toBe(16384)
    expect(computeBgCtxPerSlot({ BG_MODEL_CTX: '16384', BG_MODEL_NP: '1' })).toBe(16384)
    // Junk degrades to defaults, never NaN/0.
    expect(computeBgCtxPerSlot({ BG_MODEL_CTX: 'banana', BG_MODEL_NP: '0' })).toBe(16384)
  })
})
