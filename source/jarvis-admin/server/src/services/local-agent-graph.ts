import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import {
  AGENT_TOOL_REGISTRY,
  AGENT_TOOLS,
  normalizeToolArguments,
  toolCatalogForPrompt,
  type AgentTool,
  type AgentToolArguments,
} from './agent-tool-registry.js'

export type { AgentTool, AgentToolArguments } from './agent-tool-registry.js'

const LOCAL_LLM_URL = process.env.JARVIS_NATIVE_LLM_URL ?? 'http://127.0.0.1:7704'

export interface AgentPlanStep {
  title: string
  description: string
  tool: AgentTool
  target?: string
  arguments?: AgentToolArguments
  approvalRequired: boolean
}

export interface AgentPlanResult {
  objective: string
  intent: string
  risk: 'low' | 'medium' | 'high'
  requiresApproval: boolean
  steps: AgentPlanStep[]
  engine: string
}

const GraphState = Annotation.Root({
  objective: Annotation<string>,
  intent: Annotation<string>,
  risk: Annotation<'low' | 'medium' | 'high'>,
  requiresApproval: Annotation<boolean>,
  steps: Annotation<AgentPlanStep[]>,
})

const APPROVAL_GATED_SYSTEM_TARGETS = new Set(['sleep', 'shutdown_pc', 'restart_pc'])
const INPUT_TOOLS = new Set<AgentTool>(Object.values(AGENT_TOOL_REGISTRY).filter((definition) => definition.riskLevel === 2 && definition.availability === 'desktop').map((definition) => definition.name))

function fallbackSteps(_objective: string, intent: string, _requiresApproval: boolean): AgentPlanStep[] {
  const reason = (title: string, description: string): AgentPlanStep => ({
    title,
    description,
    tool: 'reason',
    approvalRequired: false,
  })
  if (intent === 'system_diagnostics') {
    return [
      { title: 'Read system telemetry', description: 'Collect the current desktop resource snapshot.', tool: 'system_status', approvalRequired: false },
      reason('Assess the findings', 'Summarize measured resource and service health without inventing values.'),
    ]
  }
  if (intent === 'process_diagnostics') {
    return [
      { title: 'Rank memory consumers', description: 'Read the current process snapshot and rank it by working memory.', tool: 'process_snapshot', approvalRequired: false },
      reason('Explain measured pressure', 'Report only the measured process ranking and do not terminate anything.'),
    ]
  }
  if (intent === 'screen_context') {
    return [
      { title: 'Inspect the active screen', description: 'Read the foreground window and visible accessible controls locally.', tool: 'screen_context', approvalRequired: false },
      reason('Interpret visible context', 'Answer only from the measured foreground window and accessible controls.'),
    ]
  }
  if (intent === 'screen_control') {
    return [
      { title: 'Inspect the target screen', description: 'Read the foreground window and controls before proposing input.', tool: 'screen_context', approvalRequired: false },
      reason('Prepare a safe interaction', 'Explain which exact element needs operator-approved input.'),
    ]
  }
  if (intent === 'desktop_action') return [reason('Interpret the requested desktop action', 'Confirm the target and apply the existing local safety allowlist.')]
  if (intent === 'voice_pipeline') return [reason('Inspect the local voice chain', 'Use the live Whisper, speaker encoder, inference, and TTS status.')]
  if (intent === 'planning') return [reason('Shape the requested mission', 'Turn the operator objective into a concise, executable plan.')]
  return [reason('Answer from local capabilities', 'Use the local model and available context to respond precisely.')]
}

export function classifyIntent(objective: string): string {
  const text = objective.toLowerCase()
  if (/what(?:'s| is) (?:on|visible on) (?:my |the )?screen|look at (?:my |the )?screen|see (?:my |the )?screen|screen context|active window/.test(text)) return 'screen_context'
  if (/cursor|mouse|click|double.?click|right.?click|type (?:this|text|into)|press (?:enter|tab|escape|backspace|delete)|control (?:my |the )?screen/.test(text)) return 'screen_control'
  if (/voice|whisper|speaker|microphone|tts/.test(text)) return 'voice_pipeline'
  if (/open|launch|start|lock|mute|volume|sleep|shut\s*down|power\s*off|restart|reboot/.test(text)) return 'desktop_action'
  if (/using (?:the )?(?:most|all).*(?:ram|memory)|top (?:ram|memory) process|memory consumer|what.*(?:ram|memory)/.test(text)) return 'process_diagnostics'
  if (/health|status|diagnos|performance|slow/.test(text)) return 'system_diagnostics'
  if (/plan|priorit|today|mission|project/.test(text)) return 'planning'
  return 'knowledge_work'
}

export function classifyRisk(objective: string): { risk: 'low' | 'medium' | 'high'; requiresApproval: boolean } {
  const text = objective.toLowerCase()
  if (/delete|remove|erase|wipe|format|purge|shut\s*down|power\s*off|restart|reboot|send|publish|post|purchase|pay|transfer/.test(text)) return { risk: 'high', requiresApproval: true }
  if (/install|change|modify|write|move|rename|email|message|elevat|administrator|registry|firewall|click|cursor|mouse|type|press (?:enter|tab|escape|backspace|delete)/.test(text)) return { risk: 'medium', requiresApproval: true }
  return { risk: 'low', requiresApproval: false }
}

function normalizeStep(step: AgentPlanStep, planRequiresApproval: boolean): AgentPlanStep | null {
  const definition = AGENT_TOOL_REGISTRY[step.tool]
  if (!definition) return null
  const allowedTargets = definition.allowedTargets ? new Set(definition.allowedTargets) : undefined
  const target = step.target ? String(step.target).slice(0, 40) : undefined
  if (allowedTargets && (!target || !allowedTargets.has(target))) return null
  const argumentsValue = normalizeToolArguments(step.tool, target, step.arguments)
  if (INPUT_TOOLS.has(step.tool) && !argumentsValue) return null
  const privilegedSystemAction = step.tool === 'system_action' && !!target && APPROVAL_GATED_SYSTEM_TARGETS.has(target)
  const readOnlyTool = step.tool === 'screen_context' || step.tool === 'system_status' || step.tool === 'process_snapshot' || step.tool === 'reason'
  return {
    title: String(step.title).slice(0, 80),
    description: String(step.description ?? '').slice(0, 240),
    tool: step.tool,
    target,
    ...(argumentsValue ? { arguments: argumentsValue } : {}),
    // A high-risk objective gates executable actions, not the final prose
    // synthesis step. This keeps the human-in-the-loop boundary precise.
    approvalRequired: readOnlyTool ? false : definition.requiresApproval || planRequiresApproval || privilegedSystemAction || step.approvalRequired === true,
  }
}

async function generatePlan(objective: string, intent: string, requiresApproval: boolean): Promise<AgentPlanStep[]> {
  try {
    const response = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local-qwen3-8b', temperature: 0.25, max_tokens: 700, stream: false,
        messages: [
          { role: 'system', content: `You are the planning node in a private local Windows desktop agent graph. Return JSON only: {"steps":[{"title":"short","description":"specific","tool":"registered_tool","target":"optional allowlisted target","arguments":{"x":0,"y":0,"query":"named window, file name, or visible control","operation":"focus|minimize|maximize|restore|snap_left|snap_right|move_monitor","monitor":2,"extension":"pdf","scope":"downloads|documents|desktop|jarvis","path":"exact previously resolved path","text":"literal text","key":"ENTER","button":"left","clicks":1},"approvalRequired":true|false}]}. Create 1-5 grounded steps. Read the screen before interpreting or interacting with visible UI. Prefer native window operations and accessible control names over coordinates and never invent coordinates. File access is limited to approved user folders. Never propose arbitrary shell commands, credentials, purchases, third-party messages, or destructive file actions. The deterministic registry will reject invalid tools and arguments.\n\nTOOL REGISTRY\n${toolCatalogForPrompt()}\n\nIntent: ${intent}. The graph has classified approvalRequired=${requiresApproval}.` },
          { role: 'user', content: `${objective}\n/no_think` },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!response.ok) throw new Error('Local planning model is unavailable')
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content ?? ''
    const match = content.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('Local planning model returned no structured plan')
    const parsed = JSON.parse(match[0]) as { steps?: AgentPlanStep[] }
    const normalized = (parsed.steps ?? [])
      .slice(0, 5)
      .filter((step) => step?.title && AGENT_TOOLS.has(step.tool))
      .map((step) => normalizeStep(step, requiresApproval))
      .filter((step): step is AgentPlanStep => step !== null)
    if (normalized.length > 0) {
      const actions = normalized.filter((step) => step.tool !== 'reason').slice(0, 4)
      const synthesis = normalized.find((step) => step.tool === 'reason') ?? {
        title: 'Validate and report',
        description: 'Ground the final response in confirmed tool outcomes and clearly report any limitation.',
        tool: 'reason' as const,
        approvalRequired: false,
      }
      return [...actions, synthesis]
    }
  } catch {
    // Planning is an enhancement over the direct local response path. If the
    // planner is unavailable, retain a deterministic, safety-checked plan so
    // the UI never presents a dead agent mode.
  }
  return fallbackSteps(objective, intent, requiresApproval)
}

const graph = new StateGraph(GraphState)
  .addNode('classify', async (state) => ({ intent: classifyIntent(state.objective) }))
  .addNode('risk_gate', async (state) => classifyRisk(state.objective))
  .addNode('planner', async (state) => ({ steps: await generatePlan(state.objective, state.intent, state.requiresApproval) }))
  .addEdge(START, 'classify')
  .addEdge('classify', 'risk_gate')
  .addEdge('risk_gate', 'planner')
  .addEdge('planner', END)
  .compile()

export async function createLocalAgentPlan(objective: string): Promise<AgentPlanResult> {
  const result = await graph.invoke({ objective, intent: '', risk: 'low', requiresApproval: false, steps: [] })
  const requiresApproval = result.requiresApproval || result.steps.some((step) => step.approvalRequired)
  const risk = requiresApproval && result.risk === 'low' ? 'high' : result.risk
  return { objective, intent: result.intent, risk, requiresApproval, steps: result.steps, engine: 'LangGraph · Qwen3 local planner' }
}
