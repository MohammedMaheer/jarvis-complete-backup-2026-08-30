import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyIntent, classifyRisk, createLocalAgentPlan } from '../../src/services/local-agent-graph.js'

afterEach(() => vi.unstubAllGlobals())

describe('local agent safety gates', () => {
  it('classifies natural power-action phrasing as high risk', () => {
    expect(classifyIntent('Restart my PC after I approve')).toBe('desktop_action')
    expect(classifyRisk('Restart my PC after I approve')).toEqual({ risk: 'high', requiresApproval: true })
    expect(classifyRisk('Please reboot the computer')).toEqual({ risk: 'high', requiresApproval: true })
  })

  it('keeps a generated restart action approval-gated at plan and step level', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ steps: [{ title: 'Restart', description: 'Restart the workstation.', tool: 'system_action', target: 'restart_pc', approvalRequired: false }] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const plan = await createLocalAgentPlan('Restart my PC after I approve')
    expect(plan.intent).toBe('desktop_action')
    expect(plan.risk).toBe('high')
    expect(plan.requiresApproval).toBe(true)
    expect(plan.steps[0]).toEqual(expect.objectContaining({ target: 'restart_pc', approvalRequired: true }))
    expect(plan.steps.at(-1)).toEqual(expect.objectContaining({ tool: 'reason', approvalRequired: false }))
  })

  it('drops model-invented executable targets outside the static allowlist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ steps: [{ title: 'Run arbitrary tool', description: 'Unsafe target.', tool: 'open_app', target: 'powershell_payload', approvalRequired: false }] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const plan = await createLocalAgentPlan('Open a useful app')
    expect(plan.steps).toEqual([expect.objectContaining({ tool: 'reason' })])
    expect(plan.steps.some((step) => step.target === 'powershell_payload')).toBe(false)
  })

  it('falls back to a deterministic safe plan when local planning is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))

    const plan = await createLocalAgentPlan('Check my computer health')
    expect(plan.steps).toEqual([
      expect.objectContaining({ tool: 'system_status', approvalRequired: false }),
      expect.objectContaining({ tool: 'reason' }),
    ])
  })

  it('uses a read-only process snapshot for memory pressure questions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const plan = await createLocalAgentPlan('What is using the most RAM?')
    expect(plan.intent).toBe('process_diagnostics')
    expect(plan.steps[0]).toEqual(expect.objectContaining({ tool: 'process_snapshot', approvalRequired: false }))
  })

  it('reads screen context without approval and keeps UI input approval-gated', async () => {
    expect(classifyIntent('What is visible on my screen?')).toBe('screen_context')
    expect(classifyRisk('What is visible on my screen?')).toEqual({ risk: 'low', requiresApproval: false })
    expect(classifyIntent('Click the Send button on my screen')).toBe('screen_control')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ steps: [
        { title: 'Read screen', description: 'Inspect visible controls.', tool: 'screen_context', approvalRequired: true },
        { title: 'Click Send', description: 'Click the visible Send control.', tool: 'click_element', arguments: { query: 'Send' }, approvalRequired: false },
      ] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const plan = await createLocalAgentPlan('Click the Send button on my screen')
    expect(plan.steps[0]).toEqual(expect.objectContaining({ tool: 'screen_context', approvalRequired: false }))
    expect(plan.steps[1]).toEqual(expect.objectContaining({
      tool: 'click_element',
      arguments: { query: 'Send' },
      approvalRequired: true,
    }))
  })

  it('drops invented cursor coordinates and unsupported keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ steps: [
        { title: 'Click nowhere', description: 'Invalid coordinates.', tool: 'cursor_click', arguments: { x: 'left', y: 42 }, approvalRequired: false },
        { title: 'Run shortcut', description: 'Unsupported key.', tool: 'key_press', arguments: { key: 'WIN+R' }, approvalRequired: false },
      ] }) } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const plan = await createLocalAgentPlan('Click and run a shortcut')
    expect(plan.steps.some((step) => step.tool === 'cursor_click' || step.tool === 'key_press')).toBe(false)
  })
})
