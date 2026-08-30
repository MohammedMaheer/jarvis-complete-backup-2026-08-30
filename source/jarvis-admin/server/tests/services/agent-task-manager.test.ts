import { describe, expect, it, vi } from 'vitest'
import { AgentTaskManager } from '../../src/services/agent-task-manager.js'
import type { AgentPlanResult } from '../../src/services/local-agent-graph.js'

const plan = (objective = 'Check system health'): AgentPlanResult => ({
  objective,
  intent: 'system_diagnostics',
  risk: 'low',
  requiresApproval: false,
  engine: 'test',
  steps: [
    { title: 'Read telemetry', description: 'Read measured values.', tool: 'system_status', approvalRequired: false },
    { title: 'Assess', description: 'Summarize results.', tool: 'reason', approvalRequired: false },
  ],
})

describe('AgentTaskManager', () => {
  it('creates an ordered task graph and deduplicates an active objective', () => {
    const manager = new AgentTaskManager()
    const first = manager.create(7, plan())
    const duplicate = manager.create(7, plan('  CHECK SYSTEM HEALTH  '))
    expect(duplicate.id).toBe(first.id)
    expect(first.steps[0].status).toBe('ready')
    expect(first.steps[1].dependencies).toEqual([first.steps[0].id])
    expect(first.steps[0].maxRetries).toBe(1)
  })

  it('rejects impossible transitions and unmet dependencies', () => {
    const manager = new AgentTaskManager()
    const task = manager.create(1, plan())
    expect(() => manager.transition(task.id, 1, task.steps[1].id, 'running')).toThrow('dependencies')
    manager.transition(task.id, 1, task.steps[0].id, 'running')
    manager.transition(task.id, 1, task.steps[0].id, 'complete')
    expect(() => manager.transition(task.id, 1, task.steps[0].id, 'running')).toThrow('Invalid agent step transition')
  })

  it('pauses for approval and resumes the exact waiting step', () => {
    const manager = new AgentTaskManager()
    const approvalPlan: AgentPlanResult = {
      ...plan('Click Send'),
      intent: 'screen_control',
      risk: 'high',
      requiresApproval: true,
      steps: [{ title: 'Click Send', description: 'Click named control.', tool: 'click_element', arguments: { query: 'Send' }, approvalRequired: true }],
    }
    const task = manager.create(1, approvalPlan)
    manager.transition(task.id, 1, task.steps[0].id, 'waiting_approval')
    const resumed = manager.transition(task.id, 1, task.steps[0].id, 'running')
    expect(resumed.status).toBe('running')
    expect(resumed.steps[0].status).toBe('running')
  })

  it('cancels pending work and emits redacted lifecycle events', () => {
    const manager = new AgentTaskManager()
    const listener = vi.fn()
    manager.subscribe(listener)
    const task = manager.create(1, plan())
    const cancelled = manager.cancel(task.id, 1)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.steps.every((step) => step.status === 'cancelled')).toBe(true)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ activity: 'cancelled', taskId: task.id }))
    expect(JSON.stringify(listener.mock.calls)).not.toContain(task.objective)
  })

  it('fails closed after a terminal tool error', () => {
    const manager = new AgentTaskManager()
    const task = manager.create(1, plan())
    manager.transition(task.id, 1, task.steps[0].id, 'running')
    const failed = manager.transition(task.id, 1, task.steps[0].id, 'failed', { error: 'telemetry unavailable' })
    expect(failed.status).toBe('failed')
    expect(failed.steps[1].status).toBe('skipped')
  })

  it('enforces each tool retry budget', () => {
    const manager = new AgentTaskManager()
    const task = manager.create(1, plan())
    manager.transition(task.id, 1, task.steps[0].id, 'running')
    manager.transition(task.id, 1, task.steps[0].id, 'retrying')
    manager.transition(task.id, 1, task.steps[0].id, 'running')
    expect(() => manager.transition(task.id, 1, task.steps[0].id, 'retrying')).toThrow('retry budget exhausted')
  })
})
