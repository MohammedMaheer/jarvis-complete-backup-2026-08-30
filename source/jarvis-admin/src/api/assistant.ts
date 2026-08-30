import { apiClient } from './client'

export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantStatus {
  llm: boolean
  whisper: boolean
  tts: boolean
  ready: boolean
  model: string
  contextWindow: number
  latencyMs: number
  locality: string
  memory?: boolean
  orchestration?: string
  vectorStore?: string
  chatFormat?: string
  eventStream?: boolean
  configuredContextWindow?: number
}

export type CapabilityHealthStatus = 'READY' | 'ACTIVE' | 'DEGRADED' | 'OFFLINE' | 'DISABLED' | 'UNKNOWN'

export interface CapabilityDiagnostics {
  schemaVersion: 1
  checkedAt: string
  overall: 'READY' | 'DEGRADED' | 'BLOCKED'
  locality: 'local-only'
  capabilities: Array<{
    id: string
    label: string
    implementation: 'IMPLEMENTED' | 'PARTIAL' | 'MOCKED' | 'BROKEN' | 'UNUSED' | 'DUPLICATED' | 'UNSAFE' | 'UNVERIFIED'
    status: CapabilityHealthStatus
    required: boolean
    checkedAt: string
    latencyMs?: number
    endpoint?: string
    evidence: string
    recovery?: string
  }>
}

export interface AssistantSmokeResult {
  pass: boolean
  checkedAt: string
  passed: string[]
  failed: Array<{ id: string; evidence: string; recovery?: string }>
  unverified: string[]
  note: string
}

export async function synthesizeAssistantSpeech(text: string): Promise<Blob> {
  const { data } = await apiClient.post<Blob>('/api/assistant/speak', { text }, {
    responseType: 'blob',
    timeout: 30_000,
  })
  return data
}

export async function getAssistantStatus(): Promise<AssistantStatus> {
  const { data } = await apiClient.get<AssistantStatus>('/api/assistant/status')
  return data
}

export async function getCapabilityDiagnostics(): Promise<CapabilityDiagnostics> {
  const { data } = await apiClient.get<CapabilityDiagnostics>('/api/assistant/diagnostics', { timeout: 10_000 })
  return data
}

export async function runAssistantSmokeTest(): Promise<AssistantSmokeResult> {
  const { data } = await apiClient.post<AssistantSmokeResult>('/api/assistant/smoke-test', {}, { timeout: 15_000 })
  return data
}

export async function sendAssistantCommand(message: string, history: AssistantMessage[], signal?: AbortSignal, memoryEnabled = true, workingContext = '', agentTaskId?: string) {
  const { data } = await apiClient.post<{
    content: string
    latencyMs: number
    model: string
    usage: Record<string, number> | null
    memoryCount: number
    memorySaved: boolean
    correctedClaims?: string[]
  }>('/api/assistant/chat', { message, history, memoryEnabled, workingContext, agentTaskId }, { signal })
  return data
}

export async function transcribeCommand(audio: Blob) {
  const { data } = await apiClient.post<{
    text: string
    latencyMs: number
    speaker: { user_id: number | null; confidence: number }
  }>('/api/assistant/transcribe', audio, {
    headers: { 'Content-Type': 'audio/wav' },
    timeout: 60_000,
  })
  return data
}

export interface LocalAgentPlan {
  id: string
  userId: number
  objective: string
  intent: string
  risk: 'low' | 'medium' | 'high'
  requiresApproval: boolean
  engine: string
  status: 'pending' | 'running' | 'waiting_approval' | 'complete' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  completedAt?: string
  cancelRequested: boolean
  steps: Array<{
    id: string
    title: string
    description: string
    tool: 'reason' | 'system_status' | 'screen_context' | 'process_snapshot' | 'file_search' | 'open_file' | 'action_history' | 'open_app' | 'open_folder' | 'open_settings' | 'system_action' | 'window_control' | 'cursor_move' | 'cursor_click' | 'click_element' | 'type_text' | 'key_press' | 'request_approval'
    target?: string
    arguments?: {
      x?: number
      y?: number
      text?: string
      key?: string
      query?: string
      operation?: 'focus' | 'minimize' | 'maximize' | 'restore' | 'snap_left' | 'snap_right' | 'move_monitor'
      monitor?: number
      path?: string
      extension?: string
      scope?: 'desktop' | 'downloads' | 'documents' | 'jarvis'
      button?: 'left' | 'right'
      clicks?: 1 | 2
    }
    approvalRequired: boolean
    status: 'pending' | 'ready' | 'running' | 'waiting_approval' | 'retrying' | 'complete' | 'failed' | 'skipped' | 'cancelled'
    dependencies: string[]
    retryCount: number
    maxRetries: number
    timeoutMs: number
    startedAt?: string
    completedAt?: string
    latencyMs?: number
    evidence?: string
    error?: string
  }>
}

export interface AssistantMemory {
  id: number
  content: string
  category: string
  source: string
  is_pinned: boolean
  created_at: string
  updated_at: string
  expires_at?: string | null
}

export async function planAgentObjective(objective: string, signal?: AbortSignal): Promise<LocalAgentPlan> {
  const { data } = await apiClient.post<LocalAgentPlan>('/api/assistant/agent/plan', { objective }, { timeout: 100_000, signal })
  return data
}

export async function updateAgentStep(taskId: string, stepId: string, update: {
  status: 'running' | 'waiting_approval' | 'retrying' | 'complete' | 'failed' | 'cancelled'
  evidence?: string
  error?: string
  latencyMs?: number
}): Promise<LocalAgentPlan> {
  const { data } = await apiClient.post<LocalAgentPlan>(`/api/assistant/agent/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepId)}`, update, { timeout: 10_000 })
  return data
}

export async function cancelAgentTask(taskId: string, reason = 'Cancelled by operator'): Promise<LocalAgentPlan> {
  const { data } = await apiClient.post<LocalAgentPlan>(`/api/assistant/agent/tasks/${encodeURIComponent(taskId)}/cancel`, { reason }, { timeout: 10_000 })
  return data
}

export async function getAssistantMemories(): Promise<AssistantMemory[]> {
  const { data } = await apiClient.get<AssistantMemory[]>('/api/assistant/memory', { timeout: 10_000 })
  return data
}

export async function deleteAssistantMemory(memoryId: number): Promise<void> {
  await apiClient.delete(`/api/assistant/memory/${memoryId}`, { timeout: 10_000 })
}

export async function getVoiceProfile(): Promise<{ exists: boolean; user_id: number; sample_count: number }> {
  const { data } = await apiClient.get('/api/assistant/voice-profile')
  return data
}

export async function enrollVoiceProfile(audio: Blob): Promise<{ status: string; total_samples: number }> {
  const { data } = await apiClient.post('/api/assistant/voice-enroll', audio, { headers: { 'Content-Type': 'audio/wav' }, timeout: 60_000 })
  return data
}
