import { randomUUID } from 'node:crypto'
import type { AgentPlanResult, AgentPlanStep } from './local-agent-graph.js'
import { AGENT_TOOL_REGISTRY } from './agent-tool-registry.js'

export type AgentTaskStatus = 'pending' | 'running' | 'waiting_approval' | 'complete' | 'failed' | 'cancelled'
export type AgentStepStatus = 'pending' | 'ready' | 'running' | 'waiting_approval' | 'retrying' | 'complete' | 'failed' | 'skipped' | 'cancelled'

export interface AgentTaskStep extends AgentPlanStep {
  id: string
  status: AgentStepStatus
  dependencies: string[]
  retryCount: number
  maxRetries: number
  timeoutMs: number
  startedAt?: string
  completedAt?: string
  latencyMs?: number
  evidence?: string
  error?: string
}

export interface AgentTask {
  id: string
  userId: number
  objective: string
  intent: string
  risk: AgentPlanResult['risk']
  requiresApproval: boolean
  engine: string
  status: AgentTaskStatus
  createdAt: string
  updatedAt: string
  completedAt?: string
  cancelRequested: boolean
  steps: AgentTaskStep[]
}

export interface AgentTaskEvent {
  schemaVersion: 1
  id: string
  timestamp: string
  activity: 'planning' | 'executing' | 'waiting_approval' | 'recovering' | 'complete' | 'warning' | 'error' | 'cancelled'
  phase: 'start' | 'progress' | 'complete' | 'error'
  source: 'llm' | 'tool' | 'system'
  label: string
  taskId: string
  stepId?: string
  toolName?: string
  latencyMs?: number
  metadata?: Record<string, string | number | boolean>
}

type Listener = (event: AgentTaskEvent) => void

const terminalTaskStatuses = new Set<AgentTaskStatus>(['complete', 'failed', 'cancelled'])
const terminalStepStatuses = new Set<AgentStepStatus>(['complete', 'failed', 'skipped', 'cancelled'])
const allowedTransitions: Readonly<Record<AgentStepStatus, ReadonlySet<AgentStepStatus>>> = {
  pending: new Set(['ready', 'running', 'waiting_approval', 'cancelled', 'skipped']),
  ready: new Set(['running', 'waiting_approval', 'cancelled', 'skipped']),
  running: new Set(['waiting_approval', 'retrying', 'complete', 'failed', 'cancelled']),
  waiting_approval: new Set(['running', 'cancelled']),
  retrying: new Set(['running', 'failed', 'cancelled']),
  complete: new Set(),
  failed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
}

export class AgentTaskManager {
  private readonly tasks = new Map<string, AgentTask>()
  private readonly listeners = new Set<Listener>()
  private readonly recentEvents: AgentTaskEvent[] = []

  create(userId: number, plan: AgentPlanResult): AgentTask {
    const fingerprint = `${userId}:${plan.objective.trim().toLowerCase()}`
    const duplicate = [...this.tasks.values()].find((task) => !terminalTaskStatuses.has(task.status) && `${task.userId}:${task.objective.trim().toLowerCase()}` === fingerprint)
    if (duplicate) return duplicate

    const now = new Date().toISOString()
    const taskId = randomUUID()
    const steps = plan.steps.slice(0, 8).map<AgentTaskStep>((step, index) => {
      const definition = AGENT_TOOL_REGISTRY[step.tool]
      return {
        ...step,
        id: `${taskId}:step:${index + 1}`,
        status: index === 0 ? 'ready' : 'pending',
        dependencies: index === 0 ? [] : [`${taskId}:step:${index}`],
        retryCount: 0,
        maxRetries: definition.maxRetries,
        timeoutMs: definition.timeoutMs,
      }
    })
    const task: AgentTask = { id: taskId, userId, objective: plan.objective, intent: plan.intent, risk: plan.risk, requiresApproval: plan.requiresApproval, engine: plan.engine, status: 'pending', createdAt: now, updatedAt: now, cancelRequested: false, steps }
    this.tasks.set(task.id, task)
    this.trimTasks()
    this.emit({ activity: 'planning', phase: 'complete', source: 'llm', label: 'Execution plan created', taskId, metadata: { stepCount: steps.length, risk: plan.risk } })
    return structuredClone(task)
  }

  get(taskId: string, userId: number): AgentTask | undefined {
    const task = this.tasks.get(taskId)
    return task?.userId === userId ? structuredClone(task) : undefined
  }

  list(userId: number): AgentTask[] {
    return [...this.tasks.values()].filter((task) => task.userId === userId).slice(-20).reverse().map((task) => structuredClone(task))
  }

  transition(taskId: string, userId: number, stepId: string, status: AgentStepStatus, details: { evidence?: string; error?: string; latencyMs?: number } = {}): AgentTask {
    const task = this.tasks.get(taskId)
    if (!task || task.userId !== userId) throw new Error('Agent task was not found')
    if (terminalTaskStatuses.has(task.status)) throw new Error(`Agent task is already ${task.status}`)
    const step = task.steps.find((candidate) => candidate.id === stepId)
    if (!step) throw new Error('Agent task step was not found')
    if (!allowedTransitions[step.status].has(status)) throw new Error(`Invalid agent step transition: ${step.status} -> ${status}`)
    if (status === 'running' && step.dependencies.some((dependency) => task.steps.find((candidate) => candidate.id === dependency)?.status !== 'complete')) throw new Error('Agent step dependencies are not complete')
    if (status === 'retrying' && step.retryCount >= step.maxRetries) throw new Error(`Agent step retry budget exhausted (${step.maxRetries})`)

    const now = new Date().toISOString()
    step.status = status
    if (status === 'running') step.startedAt ??= now
    if (status === 'retrying') step.retryCount += 1
    if (details.evidence) step.evidence = details.evidence.slice(0, 1_000)
    if (details.error) step.error = details.error.slice(0, 500)
    if (typeof details.latencyMs === 'number' && Number.isFinite(details.latencyMs)) step.latencyMs = Math.max(0, Math.round(details.latencyMs))
    if (terminalStepStatuses.has(status)) step.completedAt = now
    task.updatedAt = now

    if (status === 'running') task.status = 'running'
    if (status === 'waiting_approval') task.status = 'waiting_approval'
    if (status === 'complete') {
      const next = task.steps.find((candidate) => candidate.status === 'pending' && candidate.dependencies.every((dependency) => task.steps.find((item) => item.id === dependency)?.status === 'complete'))
      if (next) next.status = 'ready'
      if (task.steps.every((candidate) => candidate.status === 'complete' || candidate.status === 'skipped')) {
        task.status = 'complete'
        task.completedAt = now
      } else task.status = 'running'
    }
    if (status === 'failed') {
      task.status = 'failed'
      task.completedAt = now
      for (const candidate of task.steps) if (candidate.status === 'pending' || candidate.status === 'ready') candidate.status = 'skipped'
    }
    if (status === 'cancelled') this.cancelInternal(task, details.error ?? details.evidence ?? 'Cancelled by operator')

    const activity = status === 'waiting_approval' ? 'waiting_approval' : status === 'retrying' ? 'recovering' : status === 'failed' ? 'error' : task.status === 'complete' ? 'complete' : status === 'cancelled' ? 'cancelled' : 'executing'
    const phase = status === 'failed' ? 'error' : status === 'complete' ? 'complete' : 'progress'
    this.emit({ activity, phase, source: 'tool', label: step.title, taskId, stepId, toolName: step.tool, latencyMs: step.latencyMs, metadata: { status, retryCount: step.retryCount } })
    return structuredClone(task)
  }

  cancel(taskId: string, userId: number, reason = 'Cancelled by operator'): AgentTask {
    const task = this.tasks.get(taskId)
    if (!task || task.userId !== userId) throw new Error('Agent task was not found')
    if (!terminalTaskStatuses.has(task.status)) this.cancelInternal(task, reason)
    return structuredClone(task)
  }

  subscribe(listener: Listener, lastEventId?: string): () => void {
    if (lastEventId) {
      const index = this.recentEvents.findIndex((event) => event.id === lastEventId)
      if (index >= 0) for (const event of this.recentEvents.slice(index + 1)) listener(event)
    }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private cancelInternal(task: AgentTask, reason: string): void {
    const now = new Date().toISOString()
    task.cancelRequested = true
    task.status = 'cancelled'
    task.updatedAt = now
    task.completedAt = now
    for (const step of task.steps) {
      if (!terminalStepStatuses.has(step.status)) {
        step.status = 'cancelled'
        step.completedAt = now
        step.error = reason.slice(0, 500)
      }
    }
    this.emit({ activity: 'cancelled', phase: 'complete', source: 'system', label: 'Task cancelled', taskId: task.id })
  }

  private emit(input: Omit<AgentTaskEvent, 'schemaVersion' | 'id' | 'timestamp'>): void {
    const event: AgentTaskEvent = { schemaVersion: 1, id: randomUUID(), timestamp: new Date().toISOString(), ...input }
    this.recentEvents.push(event)
    if (this.recentEvents.length > 256) this.recentEvents.splice(0, this.recentEvents.length - 256)
    for (const listener of this.listeners) listener(event)
  }

  private trimTasks(): void {
    if (this.tasks.size <= 100) return
    const finished = [...this.tasks.values()].filter((task) => terminalTaskStatuses.has(task.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    for (const task of finished.slice(0, this.tasks.size - 100)) this.tasks.delete(task.id)
  }
}

export const agentTaskManager = new AgentTaskManager()
