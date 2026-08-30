import type { FastifyInstance } from 'fastify'
import { requireSuperuser } from '../middleware/auth.js'
import { createLocalAgentPlan } from '../services/local-agent-graph.js'
import { agentTaskManager, type AgentStepStatus } from '../services/agent-task-manager.js'
import { publicToolRegistry } from '../services/agent-tool-registry.js'
import { assessVoiceWav } from '../services/voice-audio-quality.js'
import { runCapabilityDiagnostics, toSafeSmokeResult } from '../services/capability-health.js'
import { buildUntrustedContext, CORE_SYSTEM_PROMPT, PROMPT_VERSIONS } from '../services/prompt-registry.js'
import { runPhase4DeterministicEvaluation } from '../services/phase4-evaluation.js'
import { enforceAssistantTruth } from '../services/truth-contract.js'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ChatBody {
  message: string
  history?: ChatMessage[]
  memoryEnabled?: boolean
  workingContext?: string
  agentTaskId?: string
}

interface SpeakBody {
  text: string
}

interface AgentPlanBody { objective: string }
interface AgentStepTransitionBody {
  status: AgentStepStatus
  evidence?: string
  error?: string
  latencyMs?: number
}

const LOCAL_LLM_URL = process.env.JARVIS_NATIVE_LLM_URL ?? 'http://127.0.0.1:7704'
const WHISPER_URL = process.env.JARVIS_WHISPER_URL ?? 'http://127.0.0.1:7706'
const TTS_URL = process.env.JARVIS_TTS_URL ?? 'http://127.0.0.1:7707'
const COMMAND_CENTER_URL = process.env.JARVIS_COMMAND_CENTER_URL ?? 'http://127.0.0.1:7703'
const VOICE_ENROLLMENT_AUDIO_REQUIREMENTS = {
  minDurationMs: 4_000,
  maxDurationMs: 12_000,
  minRms: 0.0025,
  maxClippingRatio: 0.03,
} as const

interface StoredMemory { id?: number; key?: string; content: string; category?: string; is_pinned?: boolean }
interface ExplicitMemoryClassification { category: string; key?: string; content: string; isPinned: boolean }

const UNSAFE_MEMORY_PATTERNS = [
  /\b(password|passcode|pin)\b\s*(?:is|=|:)\s*\S+/i,
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bearer)\b\s*(?:is|=|:)\s*\S+/i,
  /\b(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_-]{16,}|xox[baprs]-[a-z0-9-]{16,})\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
]

const BOILERPLATE_RESPONSE = /^(?:i['’]?m|i am) here to help(?: with practical engineering and real-world solutions)?\b[\s\S]*(?:let me know how i can assist|what can i help)/i

export function isSafeMemoryContent(content: string): boolean {
  const value = content.trim()
  return value.length >= 3 && value.length <= 2_000 && !UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(value))
}

function memoryKeyPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

export function classifyExplicitMemory(rawContent: string): ExplicitMemoryClassification {
  const content = rawContent.trim().replace(/[.!]+$/, '')
  const editor = content.match(/(?:always\s+)?use\s+(vs\s*code|visual studio code|cursor|pycharm)\s+for\s+([a-z0-9 +#.-]+)/i)
  if (editor) return { category: 'preference', key: `preference.editor.${memoryKeyPart(editor[2])}`, content, isPinned: true }
  const browser = content.match(/(?:i\s+)?(?:use|prefer)\s+(edge|chrome|firefox|brave)\s+(?:as|for)\s+(?:my\s+)?([a-z0-9 _-]*browser|work)/i)
  if (browser) return { category: 'preference', key: `preference.browser.${memoryKeyPart(browser[2]) || 'default'}`, content, isPinned: true }
  const alias = content.match(/when i say\s+[“"']?(.+?)[”"']?\s*,?\s*i mean\s+(.+)/i)
  if (alias) return { category: 'alias', key: `alias.${memoryKeyPart(alias[1])}`, content, isPinned: true }
  const namedRoutine = content.match(/(?:routine|mode)\s+(?:called|named)\s+[“"']?([^”"']+)/i)
  if (namedRoutine || /\b(?:routine|workflow|every time i start|when i say start)\b/i.test(content)) {
    return { category: 'procedure', key: namedRoutine ? `procedure.${memoryKeyPart(namedRoutine[1])}` : undefined, content, isPinned: false }
  }
  if (/\b(?:this project|project\s+[a-z0-9_-]+|repository|codebase)\b/i.test(content)) return { category: 'project', content, isPinned: false }
  if (/\b(?:we fixed|we diagnosed|last time|yesterday|previously)\b/i.test(content)) return { category: 'episode', content, isPinned: false }
  if (/\b(?:prefer|always|default|from now on|keep answers|don't|do not)\b/i.test(content)) return { category: 'preference', content, isPinned: true }
  return { category: 'semantic', content, isPinned: true }
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((word) => word.length > 2))
}

async function loadRelevantMemories(authHeader: string | undefined, userId: number, query: string): Promise<StoredMemory[]> {
  const householdId = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
  if (!authHeader || !householdId) return []
  try {
    const response = await fetch(`${COMMAND_CENTER_URL}/api/v0/memories?user_id=${userId}&household_id=${encodeURIComponent(householdId)}`, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return []
    const queryTerms = terms(query)
    return ((await response.json()) as StoredMemory[])
      .map((memory) => {
        const overlap = [...terms(memory.content)].filter((word) => queryTerms.has(word)).length
        return { memory, score: overlap + (memory.is_pinned && overlap > 0 ? 1 : 0) }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ memory }) => memory)
  } catch { return [] }
}

export function shouldRetrieveMemory(query: string): boolean {
  const value = query.trim()
  if (value.length > 120) return true
  return /\b(remember|last time|before|previous|same (?:format|way|style)|my (?:preference|project|profile|work browser|browser|editor|routine|workflow)|what did (?:we|i)|continue|resume|personal(?:ize|ise)|based on me)\b/i.test(value)
}

export async function saveExplicitMemory(authHeader: string | undefined, userId: number, content: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!isSafeMemoryContent(content)) return false
  const householdId = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
  if (!authHeader || !householdId) return false
  try {
    const classified = classifyExplicitMemory(content)
    const endpoint = `${COMMAND_CENTER_URL}/api/v0/memories?user_id=${userId}&household_id=${encodeURIComponent(householdId)}`
    const response = await fetcher(endpoint, { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: classified.content, category: classified.category, key: classified.key, source: 'explicit_user', is_pinned: classified.isPinned }), signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return false
    // HTTP success means the write was accepted, not that durable memory now
    // exists. Read it back through the scoped memory API before allowing the
    // assistant to say "I'll remember that."
    const verification = await fetcher(endpoint, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(8_000) })
    if (!verification.ok) return false
    const memories = await verification.json() as StoredMemory[]
    return memories.some((memory) => memory.content.trim() === classified.content && (!classified.key || memory.key === classified.key))
  } catch { return false }
}

async function forgetExplicitMemory(authHeader: string | undefined, userId: number, requested: string): Promise<number> {
  const householdId = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
  if (!authHeader || !householdId || requested.trim().length < 3) return 0
  try {
    const list = await fetch(`${COMMAND_CENTER_URL}/api/v0/memories?user_id=${userId}&household_id=${encodeURIComponent(householdId)}`, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(5_000) })
    if (!list.ok) return 0
    const requestedTerms = terms(requested)
    const candidates = ((await list.json()) as Array<StoredMemory & { id: number }>)
      .map((memory) => ({ memory, score: [...terms(memory.content)].filter((term) => requestedTerms.has(term)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    let removed = 0
    for (const { memory } of candidates) {
      const response = await fetch(`${COMMAND_CENTER_URL}/api/v0/memories/${memory.id}`, { method: 'DELETE', headers: { Authorization: authHeader }, signal: AbortSignal.timeout(5_000) })
      if (response.ok) removed += 1
    }
    return removed
  } catch { return 0 }
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSuperuser)

  const capabilityEndpoints = () => ({
    auth: app.config.authUrl,
    config: app.config.configServiceUrl,
    commandCenter: app.config.commandCenterUrl || COMMAND_CENTER_URL,
    llm: LOCAL_LLM_URL,
    whisper: WHISPER_URL,
    tts: TTS_URL,
  })

  app.get('/diagnostics', async () => runCapabilityDiagnostics(capabilityEndpoints()))

  app.post('/smoke-test', async () => {
    const diagnostics = await runCapabilityDiagnostics(capabilityEndpoints())
    return toSafeSmokeResult(diagnostics)
  })

  app.get('/evaluation', async () => ({
    ...runPhase4DeterministicEvaluation(),
    promptVersions: PROMPT_VERSIONS,
    scope: 'deterministic routing, memory routing, safety gates, tool validation, and prompt-injection boundaries only',
  }))

  app.get('/events', async (request, reply) => {
    const appId = process.env.JARVIS_APP_ID_COMMAND_CENTER
    const appKey = process.env.JARVIS_APP_KEY_COMMAND_CENTER
    if (!appId || !appKey) {
      return reply.code(503).send({ error: 'Command Center event credentials are not configured' })
    }

    const commandCenterUrl = app.config.commandCenterUrl || COMMAND_CENTER_URL
    let upstream: Response
    try {
      upstream = await fetch(`${commandCenterUrl.replace(/\/$/, '')}/api/v0/ui/events`, {
        headers: {
          'X-Jarvis-App-Id': appId,
          'X-Jarvis-App-Key': appKey,
          ...(request.headers['last-event-id'] ? { 'Last-Event-ID': String(request.headers['last-event-id']) } : {}),
        },
      })
    } catch (error) {
      return reply.code(503).send({ error: `Command Center event stream is unavailable: ${(error as Error).message}` })
    }

    if (!upstream.ok || !upstream.body) {
      return reply.code(upstream.status || 503).send({ error: 'Command Center event stream is unavailable' })
    }

    // Use the same raw SSE pattern as the install/update streams. Calling
    // `reply.hijack()` here prevents Fastify from flushing the headers on some
    // Electron/Node combinations, leaving an authenticated browser request
    // hanging before it can receive the first heartbeat.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders?.()

    const reader = upstream.body.getReader()
    const abort = () => { void reader.cancel().catch(() => {}) }
    request.raw.once('close', abort)
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!reply.raw.destroyed) reply.raw.write(Buffer.from(value))
      }
    } catch (error) {
      if (!reply.raw.destroyed) reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`)
    } finally {
      request.raw.off('close', abort)
      if (!reply.raw.destroyed) reply.raw.end()
    }
  })

  app.get('/status', async () => {
    const started = performance.now()
    const [llm, whisper, tts, memory] = await Promise.all([
      probe(`${LOCAL_LLM_URL}/health`),
      probe(`${WHISPER_URL}/health`),
      probe(`${TTS_URL}/health`),
      probe(`${COMMAND_CENTER_URL}/health`),
    ])

    return {
      llm,
      whisper,
      tts,
      memory,
      ready: llm && whisper && tts,
      model: 'Qwen3 8B · Q4_K_M · CUDA',
      contextWindow: 16384,
      configuredContextWindow: Number.parseInt(process.env.JARVIS_MODEL_CONTEXT_WINDOW ?? '32768', 10),
      chatFormat: process.env.JARVIS_MODEL_CHAT_FORMAT ?? 'chatml',
      eventStream: true,
      latencyMs: Math.round(performance.now() - started),
      locality: '100% local',
      orchestration: 'LangGraph',
      vectorStore: 'pgvector',
    }
  })

  app.post<{ Body: AgentPlanBody }>('/agent/plan', async (request, reply) => {
    const objective = request.body?.objective?.trim()
    if (!objective || objective.length > 4_000) {
      reply.code(400).send({ error: 'Agent objective must contain between 1 and 4,000 characters' })
      return
    }
    try {
      const plan = await createLocalAgentPlan(objective)
      reply.send(agentTaskManager.create(request.user.id, plan))
    } catch (error) {
      reply.code(503).send({ error: `Local agent planning failed: ${(error as Error).message}` })
    }
  })

  app.get('/agent/tools', async () => ({ tools: publicToolRegistry() }))

  app.get('/agent/tasks', async (request) => ({ tasks: agentTaskManager.list(request.user.id) }))

  app.get<{ Params: { taskId: string } }>('/agent/tasks/:taskId', async (request, reply) => {
    const task = agentTaskManager.get(request.params.taskId, request.user.id)
    if (!task) return reply.code(404).send({ error: 'Agent task was not found' })
    return task
  })

  app.post<{ Params: { taskId: string }; Body: { reason?: string } }>('/agent/tasks/:taskId/cancel', async (request, reply) => {
    try {
      return agentTaskManager.cancel(request.params.taskId, request.user.id, request.body?.reason?.slice(0, 240) || 'Cancelled by operator')
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message })
    }
  })

  app.post<{ Params: { taskId: string; stepId: string }; Body: AgentStepTransitionBody }>('/agent/tasks/:taskId/steps/:stepId', async (request, reply) => {
    const allowedStatuses = new Set<AgentStepStatus>(['running', 'waiting_approval', 'retrying', 'complete', 'failed', 'cancelled'])
    if (!allowedStatuses.has(request.body?.status)) return reply.code(400).send({ error: 'Invalid agent step status' })
    try {
      return agentTaskManager.transition(request.params.taskId, request.user.id, request.params.stepId, request.body.status, {
        evidence: request.body.evidence,
        error: request.body.error,
        latencyMs: request.body.latencyMs,
      })
    } catch (error) {
      const message = (error as Error).message
      return reply.code(message.includes('not found') ? 404 : 409).send({ error: message })
    }
  })

  app.get('/agent/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.flushHeaders?.()
    const write = (event: unknown) => {
      if (!reply.raw.destroyed) reply.raw.write(`event: jarvis-agent\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const unsubscribe = agentTaskManager.subscribe(write, request.headers['last-event-id'] ? String(request.headers['last-event-id']) : undefined)
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
    }, 15_000)
    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    request.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })

  app.get('/voice-profile', async (_request, reply) => {
    const appId = process.env.JARVIS_APP_ID_COMMAND_CENTER
    const appKey = process.env.JARVIS_APP_KEY_COMMAND_CENTER
    const householdId = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
    const userId = Number.parseInt(process.env.JARVIS_PRIMARY_USER_ID ?? '1', 10)
    if (!appId || !appKey || !householdId) return reply.code(503).send({ error: 'Voice identity is not configured' })
    try {
      const response = await fetch(`${WHISPER_URL}/voice-profiles/check?user_id=${userId}&household_id=${encodeURIComponent(householdId)}`, { headers: { 'X-Jarvis-App-Id': appId, 'X-Jarvis-App-Key': appKey }, signal: AbortSignal.timeout(5_000) })
      reply.code(response.status).send(await response.json())
    } catch (error) { reply.code(503).send({ error: `Voice profile service is unavailable: ${(error as Error).message}` }) }
  })

  app.get('/memory', async (request, reply) => {
    const householdId = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
    if (!householdId) return reply.code(503).send({ error: 'Primary household is not configured' })
    try {
      const response = await fetch(`${COMMAND_CENTER_URL}/api/v0/memories?user_id=${request.user.id}&household_id=${encodeURIComponent(householdId)}`, {
        headers: { Authorization: request.headers.authorization ?? '' },
        signal: AbortSignal.timeout(8_000),
      })
      reply.code(response.status).send(await response.json())
    } catch (error) {
      reply.code(503).send({ error: `Memory service is unavailable: ${(error as Error).message}` })
    }
  })

  app.delete<{ Params: { memoryId: string } }>('/memory/:memoryId', async (request, reply) => {
    if (!/^\d+$/.test(request.params.memoryId)) return reply.code(400).send({ error: 'Memory id must be numeric' })
    try {
      const response = await fetch(`${COMMAND_CENTER_URL}/api/v0/memories/${request.params.memoryId}`, {
        method: 'DELETE',
        headers: { Authorization: request.headers.authorization ?? '' },
        signal: AbortSignal.timeout(8_000),
      })
      reply.code(response.status).send(await response.json())
    } catch (error) {
      reply.code(503).send({ error: `Memory service is unavailable: ${(error as Error).message}` })
    }
  })

  app.post<{ Body: Buffer }>('/voice-enroll', async (request, reply) => {
    const audio = request.body
    if (!Buffer.isBuffer(audio) || audio.length < 8_000 || audio.length > 2_000_000) return reply.code(400).send({ error: 'Record a clear 3-8 second WAV sample under 2 MB' })
    const audioAssessment = assessVoiceWav(audio, VOICE_ENROLLMENT_AUDIO_REQUIREMENTS)
    if (!audioAssessment.ok) {
      request.log.warn({
        failureCode: audioAssessment.code,
        durationMs: audioAssessment.metrics?.durationMs,
        rms: audioAssessment.metrics ? Number(audioAssessment.metrics.rms.toFixed(4)) : undefined,
        clippingRatio: audioAssessment.metrics ? Number(audioAssessment.metrics.clippingRatio.toFixed(4)) : undefined,
      }, 'Voice enrollment capture rejected before encoding')
      return reply.code(400).send({ ...audioAssessment, retryable: true })
    }
    const appId = process.env.JARVIS_APP_ID_COMMAND_CENTER
    const appKey = process.env.JARVIS_APP_KEY_COMMAND_CENTER
    const householdId = process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? ''
    const userId = Number.parseInt(process.env.JARVIS_PRIMARY_USER_ID ?? '1', 10)
    if (!appId || !appKey || !householdId) return reply.code(503).send({ error: 'Voice identity is not configured' })
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'enrollment.wav')
    try {
      const response = await fetch(`${WHISPER_URL}/voice-profiles/enroll?user_id=${userId}&household_id=${encodeURIComponent(householdId)}`, { method: 'POST', headers: { 'X-Jarvis-App-Id': appId, 'X-Jarvis-App-Key': appKey }, body: form, signal: AbortSignal.timeout(60_000) })
      reply.code(response.status).send(await response.json())
    } catch (error) { reply.code(503).send({ error: `Voice enrollment service is unavailable: ${(error as Error).message}` }) }
  })

  app.post<{ Body: ChatBody }>('/chat', async (request, reply) => {
    const message = request.body?.message?.trim()
    if (!message || message.length > 12_000) {
      reply.code(400).send({ error: 'Message must contain between 1 and 12,000 characters' })
      return
    }

    const history = (request.body.history ?? [])
      .filter((item) => item && ['user', 'assistant'].includes(item.role) && item.content)
      // A stale renderer can carry an earlier canned answer into the next
      // turn. Excluding those replies stops the local model from anchoring on
      // the same generic sentence for every subsequent request.
      .filter((item) => !(item.role === 'assistant' && /^(?:i['’]?m|i am) here to help(?: with practical engineering and real-world solutions)?\b/i.test(item.content.trim())))
      .slice(-10)
      .map((item) => ({ role: item.role, content: item.content.slice(0, 8_000) }))

    const memoryEnabled = request.body.memoryEnabled !== false
    const workingContext = typeof request.body.workingContext === 'string'
      ? request.body.workingContext.trim().slice(0, 8_000)
      : ''
    const relevantMemories = memoryEnabled && shouldRetrieveMemory(message) ? await loadRelevantMemories(request.headers.authorization, request.user.id, message) : []
    const rememberMatch = message.match(/^remember(?: that)?\s+(.{3,2000})$/i)
    const memorySaved = memoryEnabled && rememberMatch ? await saveExplicitMemory(request.headers.authorization, request.user.id, rememberMatch[1]) : false
    const forgetMatch = message.match(/^forget(?: that| the preference)?(?:\s+(.{3,2000}))?[.!]?$/i)
    const previousRemembered = [...history].reverse().find((item) => item.role === 'user' && /^remember(?: that)?\s+/i.test(item.content))?.content.replace(/^remember(?: that)?\s+/i, '')
    const forgetRequested = forgetMatch?.[1]?.trim().toLowerCase() === 'preference' ? previousRemembered : forgetMatch?.[1] || previousRemembered
    const forgottenCount = memoryEnabled && forgetMatch ? await forgetExplicitMemory(request.headers.authorization, request.user.id, forgetRequested || '') : 0
    const memoryContext = relevantMemories.length
      ? buildUntrustedContext('memory', relevantMemories.map((memory) => `- ${memory.content}`).join('\n'))
      : ''

    const memoryOperation = memorySaved
      ? '\n\nThe requested information has been classified and saved to private local memory. Acknowledge that briefly.'
      : forgottenCount > 0
        ? `\n\n${forgottenCount} matching private memory item(s) were forgotten. Confirm that briefly.`
        : forgetMatch
          ? '\n\nNo matching memory was found. Say that clearly without claiming anything was deleted.'
          : ''
    const transientContext = workingContext ? buildUntrustedContext('desktop', workingContext) : ''
    const modelMessages = [{ role: 'system', content: CORE_SYSTEM_PROMPT + memoryContext + transientContext }, ...history, { role: 'user', content: message + memoryOperation }]
    const started = performance.now()
    let response: Response
    try {
      response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local-qwen3-8b',
          messages: modelMessages,
          temperature: 0.55,
          top_p: 0.9,
          max_tokens: 640,
          stream: false,
        }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (err) {
      reply.code(503).send({ error: `Local inference is unavailable: ${(err as Error).message}` })
      return
    }

    const payload = (await response.json()) as {
      error?: { message?: string }
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
      usage?: Record<string, number>
      timings?: Record<string, number>
    }
    if (!response.ok) {
      reply.code(502).send({ error: payload.error?.message ?? 'Local model request failed' })
      return
    }

    let content = payload.choices?.[0]?.message?.content?.trim()
    if (!content) {
      reply.code(502).send({ error: 'The local model returned an empty response' })
      return
    }

    // A warm model can occasionally emit a cached assistant-style greeting
    // instead of answering the latest request. Retry once with an explicit
    // direct-answer constraint; this keeps the behavior local and avoids
    // leaking the canned response into the next history window.
    if (BOILERPLATE_RESPONSE.test(content)) {
      try {
        const retryMessages = [
          ...modelMessages.slice(0, -1),
          { role: 'system', content: 'The previous draft was boilerplate. Respond to the latest user request directly and specifically. Do not offer generic help or ask the user to tell you what they need.' },
          modelMessages[modelMessages.length - 1],
        ]
        const retry = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'local-qwen3-8b', messages: retryMessages, temperature: 0.35, top_p: 0.9, max_tokens: 640, stream: false }),
          signal: AbortSignal.timeout(120_000),
        })
        if (retry.ok) {
          const retryPayload = await retry.json() as { choices?: Array<{ message?: { content?: string } }> }
          const retryContent = retryPayload.choices?.[0]?.message?.content?.trim()
          if (retryContent && !BOILERPLATE_RESPONSE.test(retryContent)) content = retryContent
        }
      } catch {
        // Keep the original model answer if the one-shot corrective pass is
        // unavailable; the request itself was still processed locally.
      }
    }

    const agentTask = typeof request.body.agentTaskId === 'string'
      ? agentTaskManager.get(request.body.agentTaskId, request.user.id)
      : undefined
    const verifiedToolSteps = agentTask?.steps.filter((step) => step.status === 'complete' && step.tool !== 'reason' && step.evidence?.startsWith('[verified]')) ?? []
    const truthful = enforceAssistantTruth(content, {
      memoryWriteVerified: memorySaved,
      memoryRecallCount: relevantMemories.length,
      screenContextVerified: verifiedToolSteps.some((step) => step.tool === 'screen_context'),
      verifiedToolResultCount: verifiedToolSteps.length,
      verifiedMutationCount: verifiedToolSteps.filter((step) => !['system_status', 'screen_context', 'process_snapshot', 'file_search', 'action_history', 'request_approval'].includes(step.tool)).length,
    })

    reply.send({
      content: truthful.content,
      latencyMs: Math.round(performance.now() - started),
      usage: payload.usage ?? null,
      timings: payload.timings ?? null,
      model: 'Qwen3-8B-Q4_K_M',
      memoryCount: relevantMemories.length,
      memorySaved,
      forgottenCount,
      correctedClaims: truthful.correctedClaims,
    })
  })

  app.post<{ Body: SpeakBody }>('/speak', async (request, reply) => {
    const text = request.body?.text?.trim()
    if (!text || text.length > 4_000) {
      reply.code(400).send({ error: 'Speech text must contain between 1 and 4,000 characters' })
      return
    }

    const appId = process.env.JARVIS_APP_ID_COMMAND_CENTER
    const appKey = process.env.JARVIS_APP_KEY_COMMAND_CENTER
    if (!appId || !appKey) {
      reply.code(503).send({ error: 'TTS service credentials are not configured' })
      return
    }

    try {
      const response = await fetch(`${TTS_URL}/speak`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Jarvis-App-Id': appId,
          'X-Jarvis-App-Key': appKey,
          'X-Context-Household-Id': process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? '',
          'X-Context-Node-Id': 'maheer-desktop',
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        reply.code(502).send({ error: 'Local speech synthesis failed' })
        return
      }
      const audio = Buffer.from(await response.arrayBuffer())
      reply.type('audio/wav').send(audio)
    } catch (err) {
      reply.code(503).send({ error: `Local speech synthesis is unavailable: ${(err as Error).message}` })
    }
  })

  app.post<{ Body: Buffer }>('/transcribe', async (request, reply) => {
    const audio = request.body
    if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.length > 2_000_000) {
      reply.code(400).send({ error: 'A valid WAV recording under 2 MB is required' })
      return
    }

    const appId = process.env.JARVIS_APP_ID_COMMAND_CENTER
    const appKey = process.env.JARVIS_APP_KEY_COMMAND_CENTER
    if (!appId || !appKey) {
      reply.code(503).send({ error: 'Whisper service credentials are not configured' })
      return
    }

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'command.wav')
    const started = performance.now()
    try {
      const response = await fetch(`${WHISPER_URL}/transcribe?preprocess=true&speaker_recognition=true`, {
        method: 'POST',
        headers: {
          'X-Jarvis-App-Id': appId,
          'X-Jarvis-App-Key': appKey,
          'X-Context-Household-Id': process.env.JARVIS_PRIMARY_HOUSEHOLD_ID ?? '',
          'X-Context-Node-Id': 'maheer-desktop',
          'X-Context-Household-Member-Ids': '1',
        },
        body: form,
        signal: AbortSignal.timeout(60_000),
      })
      const payload = (await response.json()) as Record<string, unknown>
      if (!response.ok) {
        reply.code(502).send({ error: payload.detail ?? 'Whisper transcription failed' })
        return
      }
      reply.send({ ...payload, latencyMs: Math.round(performance.now() - started) })
    } catch (err) {
      reply.code(503).send({ error: `Whisper is unavailable: ${(err as Error).message}` })
    }
  })
}
