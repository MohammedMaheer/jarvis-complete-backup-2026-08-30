import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cpu,
  Database,
  Gauge,
  Maximize2,
  Mic,
  MicOff,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  Workflow,
  Volume2,
  VolumeX,
  Zap,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  getAssistantStatus,
  getAssistantMemories,
  getVoiceProfile,
  deleteAssistantMemory,
  planAgentObjective,
  updateAgentStep,
  cancelAgentTask,
  sendAssistantCommand,
  synthesizeAssistantSpeech,
  transcribeCommand,
  type AssistantMessage,
  type AssistantMemory,
  type AssistantStatus,
  type LocalAgentPlan,
} from '@/api/assistant'
import { cn } from '@/lib/utils'
import { createAudioCapture, encodeWav, monitorAudioElement, openMicrophoneStream, playAudioBlobWithWebAudio, unlockAudioPlayback, type AudioCapture, type AudioLevel } from '@/lib/audio'
import { useJarvisActivity } from '@/hooks/useJarvisActivity'
import { interfaceSoundsEnabled, playInterfaceTone, setInterfaceSoundsEnabled } from '@/lib/interface-sounds'
import HolographicCore, { type CoreModule } from './HolographicCore'
import type { JarvisDesktopAction, JarvisScreenContext, JarvisSystemSnapshot } from '@/types/electron'

type ConsoleMessage = AssistantMessage & { id: string; latencyMs?: number; source?: 'voice' | 'text' }

type WorkflowKind = 'guardian' | 'voice' | 'mission' | 'workspace'
type WorkflowStep = { label: string; status: 'queued' | 'running' | 'done' | 'failed'; evidence?: string }
type ActiveWorkflow = { name: string; status: 'running' | 'done' | 'failed'; steps: WorkflowStep[] }
type AgentStepState = LocalAgentPlan['steps'][number]
type ApprovalRequest = { step: AgentStepState; resolve: (approved: boolean) => void }

const suggestions = [
  'What is visible on my screen?',
  'Open calculator',
  'Open my downloads',
  'Show my PC system status',
]

const workflowDefinitions: Record<WorkflowKind, { name: string; subtitle: string; steps: string[] }> = {
  guardian: { name: 'System Guardian', subtitle: 'Inspect hardware + local AI health', steps: ['Read hardware telemetry', 'Probe neural services', 'Synthesize health assessment'] },
  voice: { name: 'Voice Optimizer', subtitle: 'Audit STT, identity, and TTS chain', steps: ['Probe voice services', 'Inspect local pipeline constraints', 'Generate optimization brief'] },
  mission: { name: 'Mission Architect', subtitle: 'Turn priorities into an execution plan', steps: ['Gather operator context', 'Reason about priorities', 'Produce focused mission plan'] },
  workspace: { name: 'Workspace Launch', subtitle: 'Open the project and report readiness', steps: ['Validate native bridge', 'Open Jarvis workspace', 'Confirm operating context'] },
}

// v2 deliberately re-arms wake listening after the earlier implementation
// persisted a transient microphone failure as a permanent OFF preference.
const HANDS_FREE_KEY = 'jarvis.hands-free-voice.v2'
const LONG_TERM_MEMORY_KEY = 'jarvis.long-term-memory.v1'
const VOICE_ACTIVITY_START_MIN = 0.009
const VOICE_ACTIVITY_STOP_MIN = 0.005
const VOICE_ACTIVITY_SILENCE_MS = 850
const VOICE_ACTIVITY_MAX_MS = 15_000
const WAKE_WORD = /\b(?:jarvis|jervis|jarves|jarviss)\b/i
const WAKE_COMMAND_WINDOW_MS = 5_000

function startupGreeting(now = new Date()): string {
  const hour = now.getHours()
  const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  return `${salutation}, Maheer. JARVIS is online and ready. What would you like me to do?`
}

function normalizeTranscript(value: string): string {
  return value
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/\[(?:blank[_ ]?audio|no[_ ]?speech|silence)\]/gi, ' ')
    .replace(/\((?:dramatic music|background music|music|background noise|noise|silence)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function needsAgentPlan(command: string): boolean {
  return /\b(check|analy[sz]|diagnos|fix|prepare|organize|research|compare|summari[sz]|plan|configure|audit|optimi[sz]|investigate|set up|screen|window|cursor|mouse|click|type|press|control|execute|do this)\b/i.test(command) || command.length > 160
}

function abortError(): DOMException {
  return new DOMException('Task cancelled by operator', 'AbortError')
}

function acceptedButUnverified(message: string): Error {
  const error = new Error(message)
  error.name = 'AcceptedButUnverifiedError'
  return error
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError()
  return await new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Tool timed out after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs)
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function serializeScreenContext(context: JarvisScreenContext): string {
  const visibleWindows = context.windows
    .filter((windowInfo) => !/J\.A\.R\.V\.I\.S\.|jarvis/i.test(`${windowInfo.title} ${windowInfo.processName}`))
    .slice(0, 12)
    .map((windowInfo) => ({ title: windowInfo.title, app: windowInfo.processName, foreground: windowInfo.isForeground }))
  const visibleElements = context.elements.slice(0, 120).map((element) => ({
    name: element.name,
    type: element.controlType,
    enabled: element.enabled,
    clickable: element.clickable,
    bounds: element.bounds,
  }))
  return JSON.stringify({
    capturedAt: context.capturedAt,
    foreground: context.foreground,
    cursor: context.cursor,
    accessibilityAvailable: context.accessibilityAvailable,
    windows: visibleWindows,
    visibleElements,
  })
}

function assertVerifiedScreenContext(context: JarvisScreenContext): void {
  if (context.screenAccess !== 'on_demand') {
    throw new Error(context.exclusionReason || 'Windows screen context is blocked')
  }
  const capturedAt = Date.parse(context.capturedAt)
  if (!Number.isFinite(capturedAt) || Math.abs(Date.now() - capturedAt) > 15_000) {
    throw new Error('The captured screen context is stale or has no valid timestamp')
  }
  if (!context.foreground || typeof context.foreground.processName !== 'string') {
    throw new Error('The screen capture did not identify a foreground application')
  }
}

function approvalDetail(step: LocalAgentPlan['steps'][number]): string {
  if (step.tool === 'type_text') return `\n\nText to type:\n${step.arguments?.text ?? ''}`
  if (step.tool === 'click_element') return `\n\nVisible element: ${step.arguments?.query ?? step.target ?? 'unspecified'}`
  if (step.tool === 'cursor_move' || step.tool === 'cursor_click') return `\n\nCoordinates: ${step.arguments?.x}, ${step.arguments?.y}`
  if (step.tool === 'key_press') return `\n\nKey: ${step.arguments?.key ?? step.target ?? 'unspecified'}`
  return step.target ? `\n\nTarget: ${step.target}` : ''
}

function guardianAssessment(snapshot: JarvisSystemSnapshot | null, services: AssistantStatus | null): string[] {
  const findings: string[] = []
  if (!snapshot) findings.push('Native Windows telemetry unavailable')
  else {
    const memoryPercent = Math.round((snapshot.totalMemoryGb - snapshot.freeMemoryGb) / Math.max(1, snapshot.totalMemoryGb) * 100)
    if (snapshot.cpuUsagePercent >= 90) findings.push(`High CPU pressure: ${snapshot.cpuUsagePercent}%`)
    if (memoryPercent >= 85) findings.push(`High memory pressure: ${memoryPercent}%`)
    if (snapshot.uptimeSeconds >= 7 * 86_400) findings.push(`Extended uptime: ${Math.floor(snapshot.uptimeSeconds / 86_400)} days`)
    if (snapshot.gpu) {
      const vramPercent = Math.round(snapshot.gpu.memoryUsedMb / Math.max(1, snapshot.gpu.memoryTotalMb) * 100)
      if (vramPercent >= 92) findings.push(`High GPU memory pressure: ${vramPercent}%`)
      if (snapshot.gpu.temperatureC >= 83) findings.push(`Elevated GPU temperature: ${snapshot.gpu.temperatureC}°C`)
    }
  }
  if (!services) findings.push('Local AI service health unavailable')
  else {
    if (!services.llm) findings.push('Local Qwen inference offline')
    if (!services.whisper) findings.push('Whisper STT offline')
    if (!services.tts) findings.push('Local TTS offline')
    if (!services.memory) findings.push('pgvector memory route offline')
  }
  return findings.length > 0 ? findings : ['No deterministic warning threshold crossed']
}

function detectDesktopIntent(command: string): JarvisDesktopAction | 'system_status' | null {
  const text = command.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/\b(system|pc|computer|machine|desktop) (status|health|specs|information|okay|ok)\b/.test(text) || /\b(check|show|tell me) (my )?(system|pc|computer|machine|desktop)\b/.test(text) || text === 'show my pc system status') return 'system_status'
  if (/\b(open|launch|start|bring up) (the )?(calculator|calc)\b/.test(text)) return { type: 'open_app', target: 'calculator' }
  if (/\b(open|launch|start|bring up) (the )?notepad\b/.test(text)) return { type: 'open_app', target: 'notepad' }
  if (/\b(open|launch|start|bring up) (file )?explorer\b/.test(text)) return { type: 'open_app', target: 'explorer' }
  if (/\b(open|launch|start|bring up) (windows )?(terminal|powershell)\b/.test(text)) return { type: 'open_app', target: 'terminal' }
  if (/\b(open|launch|start|bring up) (the )?task manager\b/.test(text)) return { type: 'open_app', target: 'task_manager' }
  if (/\b(open|launch|start|bring up) (google )?chrome\b/.test(text)) return { type: 'open_app', target: 'chrome' }
  if (/\b(open|launch|start|bring up) (microsoft )?edge\b/.test(text)) return { type: 'open_app', target: 'edge' }
  if (/\b(open|launch|start|bring up) (my |the )?browser\b/.test(text)) return { type: 'open_app', target: 'browser' }
  if (/\b(open|launch|start|bring up) (visual studio code|vs code|vscode|code)\b/.test(text)) return { type: 'open_app', target: 'vscode' }
  if (/\b(open|launch|start|bring up) spotify\b/.test(text)) return { type: 'open_app', target: 'spotify' }
  if (/\b(?:what(?:'s| is)|show me).*(?:using|uses).*(?:most|all).*(?:ram|memory)|\btop (?:ram|memory) (?:apps|processes)\b/.test(text)) return { type: 'process_snapshot' }
  if (/\bwhat (?:did you|have you) (?:change|changed|do|done|touch|touched)(?: on my pc| on the computer)?\b/.test(text) || /\bshow (?:your )?(?:action|control) history\b/.test(text)) return { type: 'action_history' }
  if (/^(?:find|search for|locate)\b/.test(text)) {
    const typeToExtension: Record<string, string> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' }
    const scopeMatch = text.match(/\bin (downloads|documents|desktop|jarvis)(?: folder)?$/)
    const scope = (scopeMatch?.[1] ?? 'downloads') as 'desktop' | 'downloads' | 'documents' | 'jarvis'
    const withoutScope = scopeMatch ? text.slice(0, scopeMatch.index).trim() : text
    const extensionMatch = withoutScope.match(/\b(pdf|docx|xlsx|pptx)\b/)
    const extension = typeToExtension[extensionMatch?.[1] ?? '']
    const named = withoutScope
      .replace(/^(?:find|search for|locate)\s+/, '')
      .replace(/\b(?:my|the|newest|latest|recent|pdf|docx|xlsx|pptx|image|screenshot|files?|named|with|in the name|today|from today)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { type: 'file_search', arguments: { ...(named ? { query: named } : {}), ...(extension ? { extension } : {}), scope } }
  }
  const namedWindow = text.match(/\b(focus|bring back|minimize|maximize|restore) (?:the )?(chrome|edge|browser|vs code|vscode|spotify|terminal)\b/)
  if (namedWindow) {
    const operation = namedWindow[1] === 'bring back' ? 'restore' : namedWindow[1]
    return { type: 'window_control', arguments: { query: namedWindow[2], operation: operation as 'focus' | 'minimize' | 'maximize' | 'restore' } }
  }
  const snapWindow = text.match(/\b(?:put|snap|move) (?:the )?(chrome|edge|browser|vs code|vscode|spotify|terminal) (?:to |on )?(?:the )?(left|right)(?: side)?\b/)
  if (snapWindow) return { type: 'window_control', arguments: { query: snapWindow[1], operation: snapWindow[2] === 'left' ? 'snap_left' : 'snap_right' } }
  const monitorWindow = text.match(/\b(?:put|move) (?:the )?(chrome|edge|browser|vs code|vscode|spotify|terminal|jarvis) (?:to|on) monitor (\d{1,2})\b/)
  if (monitorWindow) return { type: 'window_control', arguments: { query: monitorWindow[1], operation: 'move_monitor', monitor: Number(monitorWindow[2]) } }
  if (/\b(open|launch|start) (windows )?settings\b/.test(text)) return { type: 'open_settings', target: 'windows' }
  if (/\b(lock|secure) (my |the )?(pc|computer|workstation)\b/.test(text)) return { type: 'system_action', target: 'lock' }
  if (/\b(mute|unmute) (the )?(pc |computer )?(volume|audio|sound)\b/.test(text)) return { type: 'system_action', target: 'volume_mute' }
  if (/\b(turn|raise|increase) (the )?(volume|audio|sound) up\b/.test(text)) return { type: 'system_action', target: 'volume_up' }
  if (/\b(turn|lower|decrease) (the )?(volume|audio|sound) down\b/.test(text)) return { type: 'system_action', target: 'volume_down' }
  if (/\b(put|send) (my |the )?(pc|computer|workstation) to sleep\b/.test(text)) return { type: 'system_action', target: 'sleep' }
  if (/\b(shut ?down|power off) (my |the )?(pc|computer|workstation)\b/.test(text) || /^(shut ?down|power off)\s*(the )?(pc|computer|workstation)?$/.test(text)) return { type: 'system_action', target: 'shutdown_pc' }
  if (/\b(restart|reboot) (my |the )?(pc|computer|workstation)\b/.test(text) || /^(restart|reboot)\s*(the )?(pc|computer|workstation)?$/.test(text)) return { type: 'system_action', target: 'restart_pc' }
  if (/\bopen (my )?(jarvis|workspace)( folder| workspace)?\b/.test(text)) return { type: 'open_folder', target: 'jarvis' }
  if (/\b(open|show|go to|take me to) (my )?downloads( folder)?\b/.test(text)) return { type: 'open_folder', target: 'downloads' }
  if (/\b(open|show|go to|take me to) (my )?desktop( folder)?\b/.test(text)) return { type: 'open_folder', target: 'desktop' }
  if (/\b(open|show|go to|take me to) (my )?documents( folder)?\b/.test(text)) return { type: 'open_folder', target: 'documents' }
  return null
}

export default function JarvisCommandConsole({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate()
  const { activity, connected: eventBridgeConnected, lastEvent, micLevel, ttsLevel, setLocalActivity, setMicLevel, setTtsLevel } = useJarvisActivity()
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [input, setInput] = useState('')
  const [commandHistory, setCommandHistory] = useState<string[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const isBusyRef = useRef(false)
  const [isRecording, setIsRecording] = useState(false)
  const [handsFree, setHandsFree] = useState(() => window.localStorage.getItem(HANDS_FREE_KEY) !== '0')
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [longTermMemory, setLongTermMemory] = useState(() => window.localStorage.getItem(LONG_TERM_MEMORY_KEY) !== '0')
  const [clock, setClock] = useState(new Date())
  const [systemSnapshot, setSystemSnapshot] = useState<JarvisSystemSnapshot | null>(null)
  const [voiceProfile, setVoiceProfile] = useState<{ exists: boolean; user_id: number; sample_count: number } | null>(null)
  const [workflow, setWorkflow] = useState<ActiveWorkflow | null>(null)
  const [agentPlan, setAgentPlan] = useState<LocalAgentPlan | null>(null)
  const [agentSteps, setAgentSteps] = useState<AgentStepState[]>([])
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null)
  const [memories, setMemories] = useState<AssistantMemory[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [agentMode, setAgentMode] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [coreModule, setCoreModule] = useState<CoreModule | null>(null)
  const [interfaceSounds, setInterfaceSounds] = useState(() => interfaceSoundsEnabled())
  const [messages, setMessages] = useState<ConsoleMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: startupGreeting(),
    },
  ])
  const streamRef = useRef<MediaStream | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const recordingStartedAtRef = useRef<number | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const speechAudioRef = useRef<HTMLAudioElement | null>(null)
  const speechCleanupRef = useRef<(() => void) | null>(null)
  const lastMicLevelAtRef = useRef(0)
  const lastTtsLevelAtRef = useRef(0)
  const recordingRef = useRef(false)
  const handsFreeRef = useRef(handsFree)
  const voiceActivityRef = useRef({ startedAt: 0, speechStartedAt: 0, lastSpeechAt: 0, seenSpeech: false, noiseFloor: 0.003 })
  const wakeArmedUntilRef = useRef(0)
  const speakingRef = useRef(false)
  const speechRunRef = useRef(0)
  const startRecordingRef = useRef<(automatic?: boolean) => Promise<void>>(async () => {})
  const greetingInFlightRef = useRef(false)
  const greetingAttemptedRef = useRef(false)
  const greetingRetryCountRef = useRef(0)
  const wakeRetryTimerRef = useRef<number | null>(null)
  const wakeRetryCountRef = useRef(0)
  const activeTaskAbortRef = useRef<AbortController | null>(null)
  const activeTaskIdRef = useRef<string | null>(null)
  const approvalRequestRef = useRef<ApprovalRequest | null>(null)
  const memoryModuleLoadedRef = useRef(false)
  const commandHistoryIndexRef = useRef(-1)
  const lastResolvedFileRef = useRef<string | null>(null)
  const workingContextRef = useRef<{ value: string; capturedAt: number } | null>(null)

  const setBusy = (value: boolean) => {
    isBusyRef.current = value
    setIsBusy(value)
  }
  const speakRef = useRef<(text: string) => Promise<void>>(async () => {})

  useEffect(() => {
    if (compact) return
    void window.jarvisDesktop?.dashboardReady().catch(() => {})
  }, [compact])

  useEffect(() => {
    const refresh = () => {
      getAssistantStatus().then(setStatus).catch(() => setStatus(null))
      getVoiceProfile().then(setVoiceProfile).catch(() => setVoiceProfile(null))
      if (window.jarvisDesktop) window.jarvisDesktop.getSystemSnapshot().then(setSystemSnapshot).catch(() => setSystemSnapshot(null))
    }
    refresh()
    const statusTimer = window.setInterval(refresh, 15_000)
    const clockTimer = window.setInterval(() => setClock(new Date()), 1_000)
    return () => {
      window.clearInterval(statusTimer)
      window.clearInterval(clockTimer)
    }
  }, [])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' })
  }, [messages, isBusy])

  useEffect(() => {
    if (!settingsOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [settingsOpen])

  useEffect(() => {
    if (coreModule !== 'memory' || memoryModuleLoadedRef.current || memoryLoading) return
    memoryModuleLoadedRef.current = true
    setMemoryLoading(true)
    void getAssistantMemories().then(setMemories).catch(() => setMemories([])).finally(() => setMemoryLoading(false))
  }, [coreModule, memories.length, memoryLoading])

  useEffect(() => {
    if (!settingsOpen) return
    setMemoryLoading(true)
    void getAssistantMemories()
      .then(setMemories)
      .catch(() => setMemories([]))
      .finally(() => setMemoryLoading(false))
  }, [settingsOpen])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
      if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  // Establish the local playback route on the first operator gesture. The
  // actual TTS response arrives after an async model request, which is late
  // enough for Chromium's normal autoplay window to have expired.
  useEffect(() => {
    let unlocked = false
    const unlock = () => {
      if (unlocked) return
      unlocked = true
      void unlockAudioPlayback().catch(() => { unlocked = false })
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => () => {
    recordingRef.current = false
    handsFreeRef.current = false
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void captureRef.current?.stop()
    speechCleanupRef.current?.()
    speechCleanupRef.current = null
    speakingRef.current = false
    if (wakeRetryTimerRef.current !== null) window.clearTimeout(wakeRetryTimerRef.current)
    activeTaskAbortRef.current?.abort()
    approvalRequestRef.current?.resolve(false)
    approvalRequestRef.current = null
  }, [])

  const mode = useMemo(() => {
    if (activity === 'offline') return eventBridgeConnected || status?.ready ? 'ONLINE' : 'OFFLINE'
    if (activity === 'listening') return 'LISTENING'
    if (activity === 'transcribing') return 'TRANSCRIBING'
    if (activity === 'thinking') return 'THINKING'
    if (activity === 'planning') return 'PLANNING'
    if (activity === 'memory') return 'MEMORY'
    if (activity === 'executing') return 'EXECUTING'
    if (activity === 'waiting_approval') return 'AUTHORIZATION'
    if (activity === 'recovering') return 'RECOVERING'
    if (activity === 'speaking') return 'SPEAKING'
    if (activity === 'cancelled') return 'CANCELLED'
    if (activity === 'warning') return 'WARNING'
    if (activity === 'error') return 'ERROR'
    return status?.ready ? 'ONLINE' : 'STANDBY'
  }, [activity, eventBridgeConnected, status?.ready])
  const greetingLabel = useMemo(() => startupGreeting(clock).split('. JARVIS')[0], [clock])
  const history = useMemo<AssistantMessage[]>(
    () => messages.filter((message) => message.id !== 'welcome').map(({ role, content }) => ({ role, content })),
    [messages],
  )
  const memoryUsedPercent = systemSnapshot
    ? Math.max(0, Math.min(100, Math.round(((systemSnapshot.totalMemoryGb - systemSnapshot.freeMemoryGb) / systemSnapshot.totalMemoryGb) * 100)))
    : null
  const gpuMemoryUsedPercent = systemSnapshot?.gpu
    ? Math.round(systemSnapshot.gpu.memoryUsedMb / Math.max(1, systemSnapshot.gpu.memoryTotalMb) * 100)
    : null
  const uptimeLabel = systemSnapshot
    ? `${Math.floor(systemSnapshot.uptimeSeconds / 86400)}d ${Math.floor((systemSnapshot.uptimeSeconds % 86400) / 3600)}h`
    : '—'
  const latestMessage = messages[messages.length - 1]
  const visibleAgentSteps: AgentStepState[] = agentSteps.length > 0
    ? agentSteps
    : (agentPlan?.steps ?? [])

  const speak = async (text: string) => {
    if (!speechEnabled) return
    const speechRun = ++speechRunRef.current
    speechAudioRef.current?.pause()
    speechCleanupRef.current?.()
    speechCleanupRef.current = null
    window.speechSynthesis?.cancel()
    speakingRef.current = true
    const speakWithSystemVoice = () => new Promise<void>((resolve, reject) => {
      if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance === 'undefined') {
        reject(new Error('No local speech output device is available'))
        return
      }
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text.replace(/[`*_#]/g, ' '))
      utterance.rate = 0.98
      utterance.pitch = 0.88
      utterance.volume = 1
      utterance.onend = () => {
        if (speechRun !== speechRunRef.current) { resolve(); return }
        speakingRef.current = false
        setTtsLevel(null)
        setLocalActivity('complete')
        resolve()
      }
      utterance.onerror = () => {
        if (speechRun !== speechRunRef.current) { resolve(); return }
        speakingRef.current = false
        setTtsLevel(null)
        reject(new Error('Local speech output could not be played'))
      }
      setLocalActivity('speaking', 'Local system voice fallback')
      window.speechSynthesis.speak(utterance)
    })
    // The first pointer/keyboard gesture normally unlocks this context. A
    // best-effort resume here also covers a command submitted by a hardware
    // shortcut or a restored Electron window.
    await unlockAudioPlayback().catch(() => {})
    let audioBlob: Blob
    try {
      audioBlob = await synthesizeAssistantSpeech(text.replace(/[`*_#]/g, ' '))
    } catch (error) {
      try {
        await speakWithSystemVoice()
        return
      } catch {
        speakingRef.current = false
        throw error
      }
    }
    if (!(audioBlob instanceof Blob) || audioBlob.size < 44) {
      speakingRef.current = false
      throw new Error('Local speech returned an empty audio frame')
    }
    speechAudioRef.current?.pause()
    if (speechAudioRef.current?.src) URL.revokeObjectURL(speechAudioRef.current.src)
    const audio = new Audio(URL.createObjectURL(audioBlob))
    audio.preload = 'auto'
    audio.volume = 1
    audio.muted = false
    audio.setAttribute('playsinline', 'true')
    speechAudioRef.current = audio
    setLocalActivity('speaking')
    // Audio playback must remain available even when a browser/Electron build
    // cannot attach a MediaElementSource (for example after a suspended
    // AudioContext). The analyser is visual-only and must never block sound.
    try {
      speechCleanupRef.current = monitorAudioElement(audio, (level: AudioLevel) => {
        if (level.timestamp - lastTtsLevelAtRef.current < 50) return
        lastTtsLevelAtRef.current = level.timestamp
        setTtsLevel(level)
      })
    } catch {
      speechCleanupRef.current = null
      setTtsLevel(null)
    }
    audio.addEventListener('ended', () => {
      if (speechRun !== speechRunRef.current) return
      speakingRef.current = false
      speechCleanupRef.current?.()
      speechCleanupRef.current = null
      setTtsLevel(null)
      setLocalActivity('complete')
    }, { once: true })
    try {
      audio.load()
      await audio.play()
    } catch (error) {
      speakingRef.current = false
      speechCleanupRef.current?.()
      speechCleanupRef.current = null
      setTtsLevel(null)
      setLocalActivity('warning', 'Local speech output could not start')
      try {
        // Some Chromium/Electron builds reject a newly-created media element
        // even after the local audio route was unlocked. Decode the already
        // received WAV through Web Audio before falling back to the OS voice.
        const playback = await playAudioBlobWithWebAudio(audioBlob, (level) => {
          if (level.timestamp - lastTtsLevelAtRef.current < 50) return
          lastTtsLevelAtRef.current = level.timestamp
          setTtsLevel(level)
        })
        speechCleanupRef.current = playback.stop
        speakingRef.current = true
        setLocalActivity('speaking', 'Local Web Audio output')
        await playback.finished
        speechCleanupRef.current = null
        speakingRef.current = false
        setTtsLevel(null)
        setLocalActivity('complete')
      } catch {
        try {
          await speakWithSystemVoice()
        } catch {
          throw error
        }
      }
    }
  }

  // Greet once per dashboard mount. The backend voice route is preferred, but
  // `speak` has a local system-voice fallback, so a service that is still
  // warming up must not suppress the operator greeting. The login/voice
  // gesture primes the shared playback context; a later gesture listener is
  // retained as a recovery path for a cold browser tab.
  speakRef.current = speak
  useEffect(() => {
    if (compact) return
    if (!speechEnabled || typeof window === 'undefined') return
    if (greetingAttemptedRef.current) return
    let cancelled = false
    let retryTimer: number | undefined
    const deliver = () => {
      if (cancelled || greetingAttemptedRef.current || greetingInFlightRef.current) return
      greetingAttemptedRef.current = true
      greetingInFlightRef.current = true
      void speakRef.current(startupGreeting()).then(() => {
        greetingRetryCountRef.current = 0
      }).catch(() => {
        if (cancelled) return
        greetingAttemptedRef.current = false
        greetingRetryCountRef.current += 1
        if (greetingRetryCountRef.current < 4) retryTimer = window.setTimeout(deliver, 1_500)
      }).finally(() => {
        greetingInFlightRef.current = false
      })
    }
    const onGesture = () => {
      void unlockAudioPlayback().catch(() => {})
      deliver()
    }
    window.addEventListener('pointerdown', onGesture, { passive: true })
    window.addEventListener('keydown', onGesture, { passive: true })
    // Do not wait for a health poll: the greeting can use the local voice
    // fallback while Qwen/TTS finish warming, and will still be retried after
    // a transient startup failure.
    const initialTimer = window.setTimeout(deliver, window.jarvisDesktop ? 120 : 350)
    return () => {
      cancelled = true
      window.clearTimeout(initialTimer)
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
    }
  }, [compact, speechEnabled])

  const resolveApproval = (approved: boolean) => {
    const pending = approvalRequestRef.current
    if (!pending) return
    approvalRequestRef.current = null
    setApprovalRequest(null)
    pending.resolve(approved)
  }

  useEffect(() => {
    if (!approvalRequest) return
    const rejectOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      resolveApproval(false)
    }
    window.addEventListener('keydown', rejectOnEscape)
    return () => window.removeEventListener('keydown', rejectOnEscape)
  }, [approvalRequest])

  const requestOperatorApproval = (step: AgentStepState) => new Promise<boolean>((resolve) => {
    const request = { step, resolve }
    approvalRequestRef.current = request
    setApprovalRequest(request)
  })

  const syncTask = (task: LocalAgentPlan) => {
    setAgentPlan(task)
    setAgentSteps(task.steps)
    return task
  }

  const executeAgentPlan = async (plan: LocalAgentPlan, signal: AbortSignal): Promise<{ outcomes: string[]; cancelled: boolean; synthesisStep?: AgentStepState }> => {
    syncTask(plan)
    const outcomes: string[] = []
    for (const step of plan.steps) {
      if (signal.aborted) throw abortError()
      if (step.approvalRequired) {
        syncTask(await updateAgentStep(plan.id, step.id, { status: 'waiting_approval', evidence: 'Waiting for operator authorization' }))
        setLocalActivity('waiting_approval', step.title)
        const approved = await requestOperatorApproval(step)
        if (!approved) {
          syncTask(await cancelAgentTask(plan.id, 'Operator declined approval'))
          return { outcomes, cancelled: true }
        }
      }

      syncTask(await updateAgentStep(plan.id, step.id, { status: 'running' }))
      if (step.tool === 'reason') {
        setLocalActivity('thinking', step.title)
        return { outcomes, cancelled: false, synthesisStep: step }
      }

      let attempt = 0
      while (attempt <= step.maxRetries) {
        const started = performance.now()
        try {
          setLocalActivity('executing', step.title)
          let evidence = ''
          let outcomeEvidence = ''
          if (step.tool === 'system_status') {
            if (!window.jarvisDesktop) throw new Error('Native telemetry requires the trusted JARVIS desktop app')
            const snapshot = await withTimeout(window.jarvisDesktop.getSystemSnapshot(), step.timeoutMs, signal)
            setSystemSnapshot(snapshot)
            evidence = `${snapshot.cpuCount} CPU threads · ${snapshot.freeMemoryGb} GB RAM free`
            outcomeEvidence = JSON.stringify(snapshot)
          } else if (step.tool === 'screen_context') {
            if (!window.jarvisDesktop) throw new Error('Screen inspection requires the trusted JARVIS desktop app')
            const context = await withTimeout(window.jarvisDesktop.inspectScreen(), step.timeoutMs, signal)
            assertVerifiedScreenContext(context)
            outcomeEvidence = serializeScreenContext(context)
            evidence = `${context.foreground.processName || 'Windows'} · ${context.foreground.title || 'active screen'} · ${context.elements.length} visible controls`
          } else if (['process_snapshot', 'file_search', 'open_file', 'action_history', 'open_app', 'open_folder', 'open_settings', 'system_action', 'window_control', 'cursor_move', 'cursor_click', 'click_element', 'type_text', 'key_press'].includes(step.tool)) {
            if (!window.jarvisDesktop) throw new Error('This action requires the trusted JARVIS desktop app')
            if (['open_app', 'open_folder', 'open_settings', 'system_action'].includes(step.tool) && !step.target) throw new Error(`The ${step.tool} step has no target`)
            const result = await withTimeout(window.jarvisDesktop.executeAction({ type: step.tool as JarvisDesktopAction['type'], target: step.target, arguments: step.arguments }), step.timeoutMs, signal)
            if (!result.success) throw new Error(result.message || 'Desktop action failed')
            if (result.evidence?.verified !== true) {
              if (result.evidence?.accepted === true) throw acceptedButUnverified(result.message || 'Windows accepted the request, but completion was not verified')
              throw new Error(result.message || 'Desktop action completion was not verified')
            }
            if (typeof result.evidence?.path === 'string') lastResolvedFileRef.current = result.evidence.path
            evidence = result.message
            outcomeEvidence = JSON.stringify({ message: result.message, evidence: result.evidence ?? {} })
          } else if (step.tool === 'request_approval') {
            evidence = 'Operator authorization recorded'
            outcomeEvidence = evidence
          } else {
            throw new Error(`No verified executor is registered for ${step.tool}`)
          }
          const latencyMs = Math.round(performance.now() - started)
          outcomes.push(`${step.title}: ${outcomeEvidence}`)
          syncTask(await updateAgentStep(plan.id, step.id, { status: 'complete', evidence: `[verified] ${evidence}`, latencyMs }))
          break
        } catch (error) {
          if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw abortError()
          const message = error instanceof Error ? error.message : 'Agent step failed'
          if (error instanceof Error && error.name === 'AcceptedButUnverifiedError') {
            syncTask(await updateAgentStep(plan.id, step.id, { status: 'failed', error: message, latencyMs: Math.round(performance.now() - started) }))
            throw error
          }
          if (attempt < step.maxRetries) {
            syncTask(await updateAgentStep(plan.id, step.id, { status: 'retrying', error: message, latencyMs: Math.round(performance.now() - started) }))
            setLocalActivity('recovering', `Retrying ${step.title} · attempt ${attempt + 2}/${step.maxRetries + 1}`)
            attempt += 1
            syncTask(await updateAgentStep(plan.id, step.id, { status: 'running' }))
            continue
          }
          syncTask(await updateAgentStep(plan.id, step.id, { status: 'failed', error: message, latencyMs: Math.round(performance.now() - started) }))
          throw error
        }
      }
    }
    return { outcomes, cancelled: false }
  }

  const execute = async (raw: string, source: 'voice' | 'text' = 'text') => {
    const command = raw.trim()
    if (!command || isBusyRef.current) return
    let desktopIntent = detectDesktopIntent(command)
    if (!desktopIntent && /^(?:open|show|launch) (?:it|that|the file)$/i.test(command) && lastResolvedFileRef.current) {
      desktopIntent = { type: 'open_file', arguments: { path: lastResolvedFileRef.current } }
    }
    // Execute simple, deterministic registered controls directly. Complex
    // objectives still enter LangGraph; this avoids asking the model to
    // reinterpret an already-resolved command such as “open Chrome”.
    const shouldPlan = agentMode && needsAgentPlan(command)
    const controller = new AbortController()
    activeTaskAbortRef.current = controller
    activeTaskIdRef.current = null
    const userMessage: ConsoleMessage = { id: crypto.randomUUID(), role: 'user', content: command, source }
    setCommandHistory((current) => current.at(-1) === command ? current : [...current.slice(-39), command])
    commandHistoryIndexRef.current = -1
    setMessages((current) => [...current, userMessage])
    setInput('')
    setBusy(true)
    setLocalActivity(shouldPlan ? 'planning' : 'thinking')
    if (!shouldPlan) {
      setAgentPlan(null)
      setAgentSteps([])
    }
    playInterfaceTone('confirm')
    let synthesisStepForFailure: AgentStepState | undefined
    try {
      if (!shouldPlan && desktopIntent && window.jarvisDesktop) {
        setLocalActivity('executing', 'Executing approved desktop action')
        let content: string
        if (desktopIntent === 'system_status') {
          const snapshot = await window.jarvisDesktop.getSystemSnapshot()
          setSystemSnapshot(snapshot)
          const uptimeHours = Math.floor(snapshot.uptimeSeconds / 3600)
          content = `${snapshot.hostname} is online with ${snapshot.cpuCount} logical CPU cores, ${snapshot.freeMemoryGb} GB of ${snapshot.totalMemoryGb} GB memory free, and ${uptimeHours} hours of uptime.`
        } else {
          const desktopTarget = desktopIntent.target
          if (desktopIntent.type === 'system_action' && desktopTarget && ['sleep', 'shutdown_pc', 'restart_pc'].includes(desktopTarget)) {
            const approved = window.confirm(`JARVIS is ready to ${desktopTarget.replaceAll('_', ' ')}. This affects the whole PC. Continue?`)
            if (!approved) {
              setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: 'System action cancelled. No change was made.' }])
              return
            }
          }
          const result = await window.jarvisDesktop.executeAction(desktopIntent)
          if (!result.success) throw new Error(result.message || 'Desktop action failed')
          if (result.evidence?.verified !== true) {
            if (result.evidence?.accepted === true) throw acceptedButUnverified(result.message || 'Windows accepted the request, but JARVIS could not verify completion')
            throw new Error(result.message || 'Desktop action completion was not verified')
          }
          if (typeof result.evidence?.path === 'string') lastResolvedFileRef.current = result.evidence.path
          workingContextRef.current = { value: `${desktopIntent.type}: ${result.message}\nEvidence: ${JSON.stringify(result.evidence ?? {})}`, capturedAt: Date.now() }
          content = result.message
        }
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content }])
        setLocalActivity('complete')
        void speak(content).catch(() => toast.error('Local spoken output could not be played'))
        return
      }
      let planContext = ''
      let synthesisStep: AgentStepState | undefined
      if (shouldPlan) {
        setLocalActivity('planning', 'Creating bounded local execution graph')
        const plan = await planAgentObjective(command, controller.signal)
        activeTaskIdRef.current = plan.id
        syncTask(plan)
        const execution = await executeAgentPlan(plan, controller.signal)
        if (execution.cancelled) {
          const content = 'Authorization was declined. The workflow was cancelled and no remaining steps were run.'
          setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content }])
          setLocalActivity('cancelled', 'Workflow cancelled by operator')
          return
        }
        synthesisStep = execution.synthesisStep
        synthesisStepForFailure = execution.synthesisStep
        planContext = execution.outcomes.length > 0 ? `\n\nVerified execution results from the local agent graph:\n${execution.outcomes.map((item) => `- ${item}`).join('\n')}` : ''
        if (execution.outcomes.length > 0) workingContextRef.current = { value: execution.outcomes.join('\n'), capturedAt: Date.now() }
        setLocalActivity('thinking')
      }
      const responseStarted = performance.now()
      const recentWorkingContext = workingContextRef.current && Date.now() - workingContextRef.current.capturedAt < 10 * 60_000
        ? workingContextRef.current.value
        : ''
      const response = await sendAssistantCommand(command + planContext, history, controller.signal, longTermMemory, recentWorkingContext, activeTaskIdRef.current ?? undefined)
      if (synthesisStep && activeTaskIdRef.current) {
        syncTask(await updateAgentStep(activeTaskIdRef.current, synthesisStep.id, {
          status: 'complete',
          evidence: '[verified] Response grounded in confirmed execution results',
          latencyMs: Math.round(performance.now() - responseStarted),
        }))
      }
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'assistant', content: response.content, latencyMs: response.latencyMs },
      ])
      setLocalActivity('complete')
      void speak(response.content).catch(() => toast.error('Local spoken output could not be played'))
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        if (activeTaskIdRef.current) {
          try { syncTask(await cancelAgentTask(activeTaskIdRef.current, 'Cancelled by operator')) } catch { /* task may already be terminal */ }
        }
        const content = 'Task cancelled. No remaining actions were executed.'
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content }])
        setLocalActivity('cancelled', content)
        return
      }
      if (activeTaskIdRef.current) {
        if (synthesisStepForFailure) {
          try { syncTask(await updateAgentStep(activeTaskIdRef.current, synthesisStepForFailure.id, { status: 'failed', error: err instanceof Error ? err.message : 'Local response failed' })) } catch { /* earlier tool failure may already be terminal */ }
        }
      }
      setLocalActivity('error', err instanceof Error ? err.message : 'Local command failed')
      playInterfaceTone('error')
      const failure = err instanceof Error ? err.message : 'Local command failed'
      const content = `I could not verify completion: ${failure}`
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content }])
      void speak(content).catch(() => {})
      toast.error(failure)
    } finally {
      if (activeTaskAbortRef.current === controller) activeTaskAbortRef.current = null
      activeTaskIdRef.current = null
      resolveApproval(false)
      setBusy(false)
    }
  }

  const updateWorkflowStep = (index: number, patch: Partial<WorkflowStep>) => {
    setWorkflow((current) => current ? { ...current, steps: current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step) } : current)
  }

  const cancelCurrentTask = () => {
    resolveApproval(false)
    activeTaskAbortRef.current?.abort()
    speechAudioRef.current?.pause()
    speechRunRef.current += 1
    speechCleanupRef.current?.()
    speechCleanupRef.current = null
    window.speechSynthesis?.cancel()
    speakingRef.current = false
    setTtsLevel(null)
    setLocalActivity('cancelled', 'Cancellation requested')
  }

  const runWorkflow = async (kind: WorkflowKind) => {
    if (isBusyRef.current) return
    const controller = new AbortController()
    activeTaskAbortRef.current = controller
    const definition = workflowDefinitions[kind]
    setWorkflow({ name: definition.name, status: 'running', steps: definition.steps.map((label) => ({ label, status: 'queued' })) })
    setBusy(true)
    setLocalActivity('executing', `${definition.name} protocol armed`)
    try {
      updateWorkflowStep(0, { status: 'running' })
      let snapshot: JarvisSystemSnapshot | null = null
      let serviceStatus: AssistantStatus | null = null
      if (kind === 'guardian' || kind === 'mission') {
        snapshot = window.jarvisDesktop ? await window.jarvisDesktop.getSystemSnapshot() : null
        if (snapshot) setSystemSnapshot(snapshot)
        updateWorkflowStep(0, { status: 'done', evidence: snapshot ? `${snapshot.cpuCount} CPU threads · ${snapshot.freeMemoryGb} GB RAM free` : 'Operator profile loaded' })
      } else if (kind === 'workspace') {
        updateWorkflowStep(0, { status: 'done', evidence: window.jarvisDesktop ? 'Trusted Electron IPC available' : 'Native bridge unavailable' })
      } else {
        serviceStatus = await getAssistantStatus()
        updateWorkflowStep(0, { status: 'done', evidence: `Whisper ${serviceStatus.whisper ? 'online' : 'offline'} · TTS ${serviceStatus.tts ? 'online' : 'offline'}` })
      }

      updateWorkflowStep(1, { status: 'running' })
      if (kind === 'workspace') {
        if (!window.jarvisDesktop) throw new Error('Native desktop bridge is unavailable')
        const result = await window.jarvisDesktop.executeAction({ type: 'open_folder', target: 'jarvis' })
        updateWorkflowStep(1, { status: 'done', evidence: result.message })
      } else {
        serviceStatus ??= await getAssistantStatus()
        updateWorkflowStep(1, { status: 'done', evidence: `${serviceStatus.model} · ${serviceStatus.contextWindow.toLocaleString()} context · ${serviceStatus.locality}` })
      }

      updateWorkflowStep(2, { status: 'running' })
      const deterministicFindings = kind === 'guardian' ? guardianAssessment(snapshot, serviceStatus) : []
      const prompts: Record<WorkflowKind, string> = {
        guardian: `Act as my local system guardian. Hardware: ${JSON.stringify(snapshot)}. AI services: ${JSON.stringify(serviceStatus)}. Deterministic findings (do not contradict or invent beyond these measured values): ${JSON.stringify(deterministicFindings)}. Give a concise health verdict, rank measured warnings, and propose one safe next action.`,
        voice: `Audit my all-local voice pipeline using this live status: ${JSON.stringify(serviceStatus)}. The path is microphone -> Whisper base.en with speaker recognition -> Qwen3 8B -> local TTS. Give three prioritized, specific improvements for accuracy and latency.`,
        mission: `Create a focused mission plan for Mohammed Maheer today. He works in robotics, AI, local LLMs, computer vision, ROS 2, automation, and product engineering. Use the system state ${JSON.stringify(snapshot)}. Return one mission objective, three executable steps, and a definition of done.`,
        workspace: 'Confirm that my Jarvis engineering workspace is open. Give me a concise startup checklist for the next productive coding session.',
      }
      if (controller.signal.aborted) throw abortError()
      const response = await sendAssistantCommand(prompts[kind], history, controller.signal, longTermMemory)
      updateWorkflowStep(2, { status: 'done', evidence: kind === 'guardian' ? deterministicFindings.join(' · ') : `${(response.latencyMs / 1000).toFixed(1)}s local synthesis` })
      setWorkflow((current) => current ? { ...current, status: 'done' } : current)
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: `${definition.name} complete.\n\n${response.content}`, latencyMs: response.latencyMs }])
      void speak(response.content).catch(() => toast.error('Local spoken output could not be played'))
      setLocalActivity('complete', `${definition.name} complete`)
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        setWorkflow((current) => current ? {
          ...current,
          status: 'failed',
          steps: current.steps.map((step) => step.status === 'running' || step.status === 'queued'
            ? { ...step, status: 'failed', evidence: 'Cancelled by operator' }
            : step),
        } : current)
        setLocalActivity('cancelled', `${definition.name} cancelled`)
        return
      }
      setWorkflow((current) => current ? { ...current, status: 'failed', steps: current.steps.map((step) => step.status === 'running' ? { ...step, status: 'failed', evidence: error instanceof Error ? error.message : 'Workflow failed' } : step) } : current)
      toast.error(error instanceof Error ? error.message : 'Agent workflow failed')
      setLocalActivity('error', error instanceof Error ? error.message : 'Agent workflow failed')
    } finally {
      if (activeTaskAbortRef.current === controller) activeTaskAbortRef.current = null
      setBusy(false)
    }
  }

  const removeMemory = async (memoryId: number) => {
    if (!window.confirm('Remove this memory from JARVIS?')) return
    try {
      await deleteAssistantMemory(memoryId)
      setMemories((current) => current.filter((memory) => memory.id !== memoryId))
      toast.success('Memory removed from the local store')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Memory removal failed')
    }
  }

  const stopRecording = async (reason: 'manual' | 'vad' | 'cancel' = 'manual') => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setIsRecording(false)
    const startedAt = recordingStartedAtRef.current
    recordingStartedAtRef.current = null
    const durationMs = startedAt ? Date.now() - startedAt : 0
    const capture = captureRef.current
    captureRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    const sampleRate = capture ? await capture.stop() : 48_000
    streamRef.current = null
    setMicLevel(null)

    const chunks = chunksRef.current
    chunksRef.current = []
    if (reason === 'cancel') return
    const automaticCapture = reason === 'vad'
    const restartHandsFree = () => {
      if (!automaticCapture || !handsFreeRef.current) return
      if (speakingRef.current) {
        window.setTimeout(restartHandsFree, 350)
        return
      }
      window.setTimeout(() => {
        if (speakingRef.current) {
          restartHandsFree()
          return
        }
        if (handsFreeRef.current && !recordingRef.current) void startRecordingRef.current(true)
      }, 260)
    }
    if (chunks.length === 0 || durationMs < 700) {
      if (automaticCapture) setLocalActivity('listening', 'Wake-word standby · say “Jarvis”')
      else {
        setLocalActivity('warning', 'Hold the microphone button for at least one second')
        toast.error('Keep speaking for at least one second so I can hear the command.')
      }
      restartHandsFree()
      return
    }
    const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const energy = Math.sqrt(chunks.reduce((sum, chunk) => {
      let chunkEnergy = 0
      for (const sample of chunk) chunkEnergy += sample * sample
      return sum + chunkEnergy
    }, 0) / Math.max(1, sampleCount))
    if (energy < 0.006) {
      if (automaticCapture) setLocalActivity('listening', 'Wake-word standby · say “Jarvis”')
      else {
        setLocalActivity('warning', 'No clear speech detected')
        toast.error('No clear speech detected. Check the selected microphone and try again.')
      }
      restartHandsFree()
      return
    }
    if (automaticCapture && isBusyRef.current) {
      restartHandsFree()
      return
    }
    setBusy(true)
    setLocalActivity('transcribing')
    try {
      const transcription = await transcribeCommand(encodeWav(chunks, sampleRate))
      const transcript = normalizeTranscript(typeof transcription.text === 'string' ? transcription.text : '')
      if (!transcript) {
        if (automaticCapture) {
          setBusy(false)
          setLocalActivity('listening', 'Wake-word standby · say “Jarvis”')
          restartHandsFree()
          return
        }
        throw new Error('I could not hear a clear command. Please try again.')
      }
      if (automaticCapture) {
        const wakeDetected = WAKE_WORD.test(transcript)
        const wakeArmed = Date.now() < wakeArmedUntilRef.current
        if (!wakeDetected && !wakeArmed) {
          setBusy(false)
          setLocalActivity('listening', 'Wake-word standby · say “Jarvis”')
          restartHandsFree()
          return
        }
        if (wakeDetected) wakeArmedUntilRef.current = Date.now() + WAKE_COMMAND_WINDOW_MS
        const command = wakeDetected
          ? transcript.replace(/^\s*(?:hey|ok|okay)?\s*,?\s*(?:jarvis|jervis|jarves|jarviss)\b[\s,:-]*/i, '').trim()
          : transcript
        if (!command) {
          setBusy(false)
          setLocalActivity('listening', 'Wake word detected · awaiting your command')
          await speakRef.current('Yes?').catch(() => playInterfaceTone('confirm'))
          const waitStarted = performance.now()
          while (speakingRef.current && performance.now() - waitStarted < 5_000) {
            await new Promise((resolve) => window.setTimeout(resolve, 100))
          }
          restartHandsFree()
          return
        }
        wakeArmedUntilRef.current = 0
        setBusy(false)
        await execute(command, 'voice')
        restartHandsFree()
        return
      }
      setBusy(false)
      await execute(transcript, 'voice')
      restartHandsFree()
    } catch (err) {
      setBusy(false)
      setLocalActivity('error', err instanceof Error ? err.message : 'Voice capture failed')
      if (!automaticCapture) toast.error(err instanceof Error ? err.message : 'Voice capture failed')
      restartHandsFree()
    }
  }

  const startRecording = async (automatic = false) => {
    if (recordingRef.current) {
      if (!automatic) await stopRecording('manual')
      return
    }
    try {
      const stream = await openMicrophoneStream()
      chunksRef.current = []
      const capture = await createAudioCapture(stream, (chunk) => {
        if (automatic && !voiceActivityRef.current.seenSpeech) {
          // Keep only a short pre-roll while waiting for the wake word. This
          // prevents an always-armed monitor from accumulating hours of PCM.
          chunksRef.current.push(chunk)
          if (chunksRef.current.length > 24) chunksRef.current.shift()
          return
        }
        chunksRef.current.push(chunk)
      }, { onLevel: (level) => {
        if (level.timestamp - lastMicLevelAtRef.current < 50) return
        lastMicLevelAtRef.current = level.timestamp
        setMicLevel(level)
        if (!automatic || !handsFreeRef.current || !recordingRef.current) return
        const now = performance.now()
        const voice = voiceActivityRef.current
        if (!voice.seenSpeech && now - voice.startedAt < 1_500) {
          voice.noiseFloor = Math.max(0.001, voice.noiseFloor * 0.92 + level.rms * 0.08)
        }
        const startThreshold = Math.max(VOICE_ACTIVITY_START_MIN, Math.min(0.04, voice.noiseFloor * 2.6))
        const stopThreshold = Math.max(VOICE_ACTIVITY_STOP_MIN, startThreshold * 0.58)
        if (level.rms >= startThreshold) {
          voice.lastSpeechAt = now
          if (!voice.seenSpeech) {
            voice.seenSpeech = true
            voice.speechStartedAt = now
            setLocalActivity('listening', 'Voice detected · checking for “Jarvis”')
          }
        } else if (voice.seenSpeech && level.rms < stopThreshold && now - voice.lastSpeechAt >= VOICE_ACTIVITY_SILENCE_MS) {
          void stopRecording('vad')
        }
        if (voice.seenSpeech && now - voice.speechStartedAt >= VOICE_ACTIVITY_MAX_MS) void stopRecording('vad')
        if (!voice.seenSpeech && now - voice.startedAt >= VOICE_ACTIVITY_MAX_MS) {
          voice.startedAt = now
        }
      } })
      streamRef.current = stream
      captureRef.current = capture
      recordingStartedAtRef.current = Date.now()
      recordingRef.current = true
      voiceActivityRef.current = { startedAt: performance.now(), speechStartedAt: 0, lastSpeechAt: 0, seenSpeech: false, noiseFloor: 0.003 }
      wakeRetryCountRef.current = 0
      setIsRecording(true)
      setLocalActivity('listening', automatic ? 'Wake-word standby · say “Jarvis”' : 'Listening for a command')
      playInterfaceTone('listen')
      const device = stream.getAudioTracks()[0]?.label
      if (device && !automatic) toast.message(`Listening through ${device}`)
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setMicLevel(null)
      recordingRef.current = false
      if (automatic) {
        const retryDelay = Math.min(30_000, 2_000 * (2 ** Math.min(4, wakeRetryCountRef.current)))
        wakeRetryCountRef.current += 1
        if (wakeRetryTimerRef.current !== null) window.clearTimeout(wakeRetryTimerRef.current)
        wakeRetryTimerRef.current = window.setTimeout(() => {
          wakeRetryTimerRef.current = null
          if (handsFreeRef.current && !recordingRef.current && !speakingRef.current) void startRecordingRef.current(true)
        }, retryDelay)
      }
      setLocalActivity('error', error instanceof Error ? error.message : 'Microphone access is required')
      playInterfaceTone('error')
      toast.error(error instanceof Error ? error.message : 'Microphone access is required for local voice commands.')
    }
  }

  startRecordingRef.current = startRecording

  useEffect(() => {
    handsFreeRef.current = handsFree
    window.localStorage.setItem(HANDS_FREE_KEY, handsFree ? '1' : '0')
  }, [handsFree])

  // Hands-free capture starts after the local readiness probe. Browsers wait
  // for the first gesture to satisfy their microphone permission policy;
  // Electron can begin immediately through its trusted local shell.
  useEffect(() => {
    if (!handsFree || !status?.ready || recordingRef.current) return
    let cancelled = false
    const begin = () => {
      if (cancelled || !handsFreeRef.current || recordingRef.current) return
      if (greetingInFlightRef.current) {
        window.setTimeout(begin, 500)
        return
      }
      if (speakingRef.current) {
        window.setTimeout(begin, 500)
        return
      }
      void startRecordingRef.current(true)
    }
    if (window.jarvisDesktop) {
      begin()
      return () => { cancelled = true }
    }
    window.addEventListener('pointerdown', begin, { once: true, passive: true })
    window.addEventListener('keydown', begin, { once: true, passive: true })
    return () => {
      cancelled = true
      window.removeEventListener('pointerdown', begin)
      window.removeEventListener('keydown', begin)
    }
  }, [handsFree, status?.ready])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void execute(input)
  }

  return (
    <section className={cn('jarvis-command-console jarvis-command-console--immersive relative flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-cyan-300/20 bg-[#020b12]/96 shadow-[0_26px_100px_rgba(0,0,0,.5),inset_0_0_80px_rgba(13,215,255,.035)]', compact && 'jarvis-command-console--overlay')}>
      <div className="jarvis-scanline" aria-hidden="true" />
      <div className="jarvis-console-header relative z-[1] flex shrink-0 items-center justify-between gap-4 border-b border-cyan-300/10 px-4 py-3 sm:px-8 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="jarvis-deck-mark"><Sparkles size={14} /></span>
            <div>
              <p className="jarvis-eyebrow">Maheer // Neural command deck</p>
              <p className="mt-1 text-sm font-medium tracking-wide text-cyan-50/85">{greetingLabel}</p>
            </div>
            <span className={cn('jarvis-live-pill', mode === 'LISTENING' ? 'is-listening' : ['PLANNING', 'THINKING', 'MEMORY', 'EXECUTING', 'TRANSCRIBING', 'RECOVERING', 'SPEAKING', 'AUTHORIZATION'].includes(mode) ? 'is-processing' : mode === 'ONLINE' ? 'is-online' : mode === 'OFFLINE' || mode === 'ERROR' ? 'is-error' : 'is-standby')}><i /> {mode}</span>
            <span className="jarvis-event-link" title={lastEvent?.label ?? 'Waiting for lifecycle events'}><Radio size={10} /> {eventBridgeConnected ? 'EVENT LINK' : 'LOCAL FALLBACK'}</span>
            {compact && <span className="jarvis-screen-on-demand" title="Screen context is captured only when you explicitly ask JARVIS to look"><ShieldCheck size={10} /> SCREEN ON-DEMAND</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden text-right font-mono text-[9px] uppercase tracking-[.14em] text-cyan-100/35 sm:block"><span>ABU DHABI</span><br /><b className="text-cyan-200/75">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div>
          {compact ? <><button type="button" onClick={() => void window.jarvisDesktop?.setWindowMode('full')} className="jarvis-deck-button" aria-label="Expand full JARVIS command deck"><Maximize2 size={15} /><span>Expand</span></button><button type="button" onClick={() => void window.jarvisDesktop?.setWindowMode('hide')} className="jarvis-deck-button" aria-label="Hide JARVIS overlay"><X size={15} /></button></> : <button type="button" onClick={() => setSettingsOpen(true)} className="jarvis-deck-button" aria-label="Open command deck settings"><Settings2 size={15} /><span className="hidden sm:inline">Settings</span></button>}
        </div>
      </div>

      <div className="jarvis-deck-scroll relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div className="jarvis-deck-stage relative shrink-0 overflow-hidden border-b border-cyan-300/10 px-4 py-5 sm:px-8 sm:py-7">
          <div className="jarvis-stage-grid">
            <aside className="jarvis-telemetry-rail jarvis-telemetry-rail--left" aria-label="System telemetry">
              <div className="jarvis-rail-heading"><span><Activity size={12} /> System matrix</span><b className="is-live">LIVE</b></div>
              <div className="jarvis-rail-card jarvis-rail-card--hero">
                <div className="jarvis-rail-kicker"><Cpu size={12} /> Host compute</div>
                <div className="jarvis-rail-value">{systemSnapshot ? systemSnapshot.cpuUsagePercent : '—'}<small>{systemSnapshot ? '% CPU' : ''}</small></div>
                <div className="jarvis-rail-caption">{systemSnapshot ? `${systemSnapshot.cpuCount} threads · ${systemSnapshot.hostname}` : 'Awaiting native telemetry'}</div>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><Database size={12} /> Memory fabric</div>
                <div className="jarvis-meter"><i style={{ width: `${memoryUsedPercent ?? 0}%` }} /></div>
                <div className="jarvis-rail-pair"><span>{systemSnapshot ? `${systemSnapshot.freeMemoryGb} GB free` : 'Reading…'}</span><b>{memoryUsedPercent !== null ? `${memoryUsedPercent}% used` : '—'}</b></div>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><Gauge size={12} /> GPU accelerator</div>
                <div className="jarvis-meter"><i style={{ width: `${gpuMemoryUsedPercent ?? 0}%` }} /></div>
                <div className="jarvis-rail-pair"><span>{systemSnapshot?.gpu ? `${systemSnapshot.gpu.utilizationPercent}% compute` : 'Not detected'}</span><b>{gpuMemoryUsedPercent !== null ? `${gpuMemoryUsedPercent}% VRAM` : '—'}</b></div>
                <div className="jarvis-rail-caption">{systemSnapshot?.gpu ? `${systemSnapshot.gpu.name} · ${systemSnapshot.gpu.temperatureC}°C` : 'NVIDIA telemetry unavailable'}</div>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><Clock3 size={12} /> Session uptime</div>
                <div className="jarvis-rail-value jarvis-rail-value--small">{uptimeLabel}</div>
                <div className="jarvis-rail-caption">{systemSnapshot?.platform ?? 'Native shell telemetry pending'}</div>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><Radio size={12} /> Local channels</div>
                {[
                  ['Qwen inference', status?.llm],
                  ['Whisper STT', status?.whisper],
                  ['Kokoro TTS', status?.tts],
                  ['pgvector memory', status?.memory],
                ].map(([label, online]) => <div key={String(label)} className="jarvis-channel-row"><span><i className={online ? 'is-ready' : ''} />{label}</span><b>{online === undefined ? 'UNKNOWN' : online ? 'READY' : 'OFFLINE'}</b></div>)}
              </div>
            </aside>

            <div className="jarvis-core-zone">
              <div className="jarvis-deck-metrics" aria-label="Local system status">
                <div><span>INFERENCE</span><b className={status?.llm ? 'is-ready' : ''}>{status === null ? 'CHECKING' : status.llm ? 'QWEN3 8B' : 'OFFLINE'}</b></div>
                <div><span>VOICE CHAIN</span><b className={status?.whisper && status.tts ? 'is-ready' : ''}>{status === null ? 'CHECKING' : status.whisper && status.tts ? 'READY' : 'DEGRADED'}</b></div>
                <div><span>MEMORY</span><b className={status?.memory ? 'is-ready' : ''}>{status === null ? 'CHECKING' : status.memory ? status.vectorStore ?? 'PGVECTOR' : 'OFFLINE'}</b></div>
              </div>
              <div className="relative flex min-h-[340px] items-center justify-center sm:min-h-[390px]">
                <HolographicCore mode={mode} isRecording={isRecording} isBusy={isBusy} micLevel={micLevel} ttsLevel={ttsLevel} taskSteps={visibleAgentSteps} activeModule={coreModule} onModuleSelect={(module) => setCoreModule((current) => current === module ? null : module)} />
                {coreModule && <aside className={`jarvis-context-plane jarvis-context-plane--${coreModule}`} aria-live="polite"><button type="button" className="jarvis-context-close" onClick={() => setCoreModule(null)} aria-label={`Close ${coreModule} module`}><X size={13} /></button><p className="jarvis-eyebrow">{coreModule} module</p>{coreModule === 'system' && <><strong>{systemSnapshot ? `${systemSnapshot.cpuUsagePercent}% CPU · ${systemSnapshot.freeMemoryGb.toFixed(1)} GB RAM free` : 'Native telemetry pending'}</strong><span>{systemSnapshot ? `${systemSnapshot.cpuCount} threads · ${uptimeLabel} uptime${systemSnapshot.gpu ? ` · ${systemSnapshot.gpu.utilizationPercent}% GPU` : ''}` : 'Open the Electron app for measured Windows data.'}</span></>}{coreModule === 'voice' && <><strong>{status?.whisper && status.tts ? 'Voice chain ready' : 'Voice chain degraded'}</strong><span>Whisper {status?.whisper ? 'ready' : 'offline'} · TTS {status?.tts ? 'ready' : 'offline'} · identity {voiceProfile?.exists ? 'enrolled' : 'pending'}</span></>}{coreModule === 'memory' && <><strong>{status?.memory ? 'pgvector connected' : 'Memory unavailable'}</strong><span>{memoryLoading ? 'Reading approved memories…' : `${memories.length} visible long-term memories. Only explicit non-secret facts persist.`}</span></>}{coreModule === 'tools' && <><strong>{agentPlan ? `${agentPlan.steps.length} registered task steps` : 'Tool registry standing by'}</strong><span>{agentPlan ? agentPlan.steps.map((step) => step.tool).join(' → ') : 'Actions are schema validated and risk gated.'}</span></>}{coreModule === 'guardian' && <><strong>Deterministic diagnostics</strong><span>Reads live telemetry and service health before local Qwen explains findings.</span><button type="button" onClick={() => { setCoreModule(null); void runWorkflow('guardian') }} disabled={isBusy}>Run Guardian</button></>}</aside>}
                <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-100/40">
                  <span className="h-px w-8 bg-cyan-300/20" />
                  {isRecording ? (handsFree ? 'Wake-word standby · say “Jarvis”' : 'Speak naturally · tap again to send') : isBusy ? (lastEvent?.label ?? visibleAgentSteps.find((step) => ['running', 'waiting_approval', 'retrying'].includes(step.status))?.title ?? mode) : 'Voice and text channels ready'}
                  <span className="h-px w-8 bg-cyan-300/20" />
                </div>
              </div>
              <div className="jarvis-command-suggestions" aria-label="Quick commands">
                {suggestions.slice(0, 3).map((suggestion) => <button key={suggestion} type="button" onClick={() => void execute(suggestion)} disabled={isBusy}>{suggestion}<ChevronRight size={12} /></button>)}
              </div>
            </div>

            <aside className="jarvis-telemetry-rail jarvis-telemetry-rail--right" aria-label="Mission telemetry">
              <div className="jarvis-rail-heading"><span><Zap size={12} /> Mission control</span></div>
              <div className="jarvis-rail-card jarvis-rail-card--hero">
                <div className="jarvis-rail-kicker"><Workflow size={12} /> Active protocol</div>
                <div className="jarvis-rail-value jarvis-rail-value--small">{workflow?.name ?? 'Standby'}</div>
                <div className="jarvis-rail-caption">{workflow ? `${workflow.steps.filter((step) => step.status === 'done').length}/${workflow.steps.length} nodes complete` : 'Choose a protocol to give JARVIS a focused job.'}</div>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><UserRound size={12} /> Operator link</div>
                <div className="jarvis-rail-pair"><span>Voice identity</span><b className={voiceProfile?.exists ? 'is-ready' : ''}>{voiceProfile?.exists ? 'ENROLLED' : 'PENDING'}</b></div>
                <div className="jarvis-rail-caption">{voiceProfile?.exists ? `${voiceProfile.sample_count} verified samples · scoped context` : 'Enroll a voice profile in Settings.'}</div>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><ShieldCheck size={12} /> Latest activity</div>
                <div className="jarvis-activity-line"><i className={latestMessage?.role === 'user' ? 'is-user' : 'is-ready'} /><span>{latestMessage?.role === 'user' ? 'Command received' : 'JARVIS response ready'}</span></div>
                <p className="jarvis-activity-text">{lastEvent?.label ?? latestMessage?.content ?? 'Local command channel is waiting.'}</p>
              </div>
              <div className="jarvis-rail-card">
                <div className="jarvis-rail-kicker"><Gauge size={12} /> Launch protocol</div>
                <div className="jarvis-rail-actions">
                  <button type="button" onClick={() => void runWorkflow('guardian')} disabled={isBusy}><span>Guardian scan</span><ChevronRight size={12} /></button>
                  <button type="button" onClick={() => void runWorkflow('voice')} disabled={isBusy}><span>Voice audit</span><ChevronRight size={12} /></button>
                  <button type="button" onClick={() => void execute('Show my PC system status')} disabled={isBusy}><span>Read system status</span><ChevronRight size={12} /></button>
                </div>
              </div>
            </aside>
          </div>
        </div>

        {workflow && (
          <div className="jarvis-workflow-trace shrink-0 border-b border-cyan-300/10 px-4 py-4 sm:px-8">
            <div className="mb-3 flex items-center justify-between"><p className="jarvis-eyebrow flex items-center gap-2"><Workflow size={13} /> {workflow.name}</p><span className={cn('text-[9px] font-bold uppercase tracking-[.2em]', workflow.status === 'done' ? 'text-emerald-300' : workflow.status === 'failed' ? 'text-red-300' : 'text-amber-300')}>{workflow.status}</span></div>
            <div className="grid gap-2 sm:grid-cols-3">{workflow.steps.map((step, index) => <div key={step.label} className={cn('jarvis-workflow-step', step.status)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{step.label}</strong><small>{step.evidence ?? (step.status === 'running' ? 'Executing locally…' : 'Awaiting dependency')}</small></div></div>)}</div>
          </div>
        )}
        {agentPlan && (
          <div className="jarvis-agent-plan shrink-0 border-b border-cyan-300/10 px-4 py-4 sm:px-8">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="jarvis-eyebrow flex items-center gap-2"><Workflow size={13} /> Local agent plan</p><span className={cn('rounded-full border px-2 py-1 text-[8px] font-bold uppercase tracking-[.16em]', agentPlan.risk === 'low' ? 'border-emerald-300/20 text-emerald-300' : agentPlan.risk === 'medium' ? 'border-amber-300/20 text-amber-300' : 'border-red-300/20 text-red-300')}>{agentPlan.risk} risk · {agentPlan.engine}</span></div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">{visibleAgentSteps.map((step, index) => <div key={step.id} className={cn('min-w-[170px] flex-1 rounded-xl border border-cyan-300/10 bg-cyan-300/[.025] p-3', step.status === 'running' && 'border-amber-300/35 shadow-[0_0_18px_rgba(251,191,36,.08)]', step.status === 'retrying' && 'border-violet-300/40 shadow-[0_0_18px_rgba(196,181,253,.08)]', step.status === 'complete' && 'border-emerald-300/25', step.status === 'failed' && 'border-rose-300/30', step.status === 'waiting_approval' && 'border-amber-300/50', ['cancelled', 'skipped'].includes(step.status) && 'opacity-50')}><span className="font-mono text-[9px] text-cyan-300/55">NODE {String(index + 1).padStart(2, '0')} · {step.status.replace('_', ' ')}</span><strong className="mt-1 block text-[11px] text-cyan-50/80">{step.title}</strong><small className="mt-1 block leading-relaxed text-cyan-100/35">{step.error ?? step.evidence ?? step.description}</small>{step.retryCount > 0 && <em className="mt-2 block text-[8px] not-italic uppercase tracking-widest text-violet-200/70">Retry {step.retryCount}/{step.maxRetries}</em>}{step.approvalRequired && <em className="mt-2 block text-[8px] not-italic uppercase tracking-widest text-amber-300/70">Approval gated</em>}</div>)}</div>
          </div>
        )}

        <div ref={transcriptRef} className="jarvis-transcript min-h-[145px] space-y-4 px-4 py-5 sm:px-16 sm:py-6">
            {messages.map((message) => (
              <div key={message.id} className={cn('flex gap-3', message.role === 'user' && 'justify-end')}>
                {message.role === 'assistant' && <span className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-cyan-300/25 bg-cyan-300/5 text-cyan-300"><Sparkles size={13} /></span>}
                <div className={cn('max-w-[82%]', message.role === 'user' && 'text-right')}>
                  <div className={cn(
                    'rounded-2xl px-4 py-3 text-sm leading-relaxed',
                    message.role === 'assistant'
                      ? 'rounded-tl-sm border border-cyan-300/12 bg-cyan-300/[.045] text-cyan-50/85'
                      : 'rounded-tr-sm bg-cyan-300 text-[#021017] shadow-[0_0_24px_rgba(34,211,238,.15)]',
                  )}>
                    {message.role === 'assistant' ? (
                      <div className="jarvis-markdown prose prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{message.content}</ReactMarkdown>
                      </div>
                    ) : message.content}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-cyan-100/30">
                    {message.source === 'voice' && <><Mic size={9} /> Voice</>}
                    {message.latencyMs && <span>{(message.latencyMs / 1000).toFixed(1)}s local</span>}
                    {message.role === 'assistant' && <button type="button" onClick={() => void navigator.clipboard.writeText(message.content).then(() => toast.success('Response copied'))} className="jarvis-transcript-action">Copy</button>}
                    {message.role === 'assistant' && <button type="button" onClick={() => void speak(message.content).catch(() => toast.error('Local spoken output could not be played'))} className="jarvis-transcript-action">Speak</button>}
                    {message.role === 'user' && <button type="button" disabled={isBusy} onClick={() => void execute(message.content, message.source ?? 'text')} className="jarvis-transcript-action">Run again</button>}
                  </div>
                </div>
              </div>
            ))}
            {isBusy && (
              <div className="flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-cyan-200/55">
                <span className="jarvis-thinking-dots"><i /><i /><i /></span> Processing locally
              </div>
            )}
        </div>

      </div>

        <div className="jarvis-command-dock shrink-0 border-t border-cyan-300/10 bg-black/20 p-4 sm:px-16 sm:py-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1"><span className="font-mono text-[9px] uppercase tracking-[.18em] text-cyan-100/30">Neural command channel</span><div className="flex items-center gap-2"><button type="button" onClick={() => { setAgentMode((value) => !value) }} aria-pressed={agentMode} aria-label={agentMode ? 'Disable agent workflows' : 'Enable agent workflows'} title={agentMode ? 'Agent workflows on' : 'Agent workflows off'} className={cn('grid h-7 w-7 place-items-center rounded-full border transition', agentMode ? 'border-amber-300/25 bg-amber-300/5 text-amber-200' : 'border-cyan-300/10 text-cyan-100/35')}><Workflow size={12} /></button><button type="button" onClick={() => { const next = !handsFree; handsFreeRef.current = next; setHandsFree(next); if (!next) void stopRecording('cancel'); else if (status?.ready && !recordingRef.current && !isBusyRef.current) void startRecordingRef.current(true) }} aria-pressed={handsFree} aria-label={handsFree ? 'Disable wake-word detection' : 'Enable wake-word detection'} title={handsFree ? 'Wake-word detection on' : 'Wake-word detection off'} className={cn('grid h-7 w-7 place-items-center rounded-full border transition', handsFree ? 'border-emerald-300/25 bg-emerald-300/5 text-emerald-200' : 'border-cyan-300/10 text-cyan-100/35')}><Mic size={12} /></button></div></div>
          <form onSubmit={submit} className="flex items-center gap-2 rounded-2xl border border-cyan-300/20 bg-[#06141d]/90 p-2 shadow-[inset_0_0_22px_rgba(34,211,238,.03)] focus-within:border-cyan-300/45">
              <button type="button" onClick={() => { if (handsFree) { handsFreeRef.current = false; setHandsFree(false); void stopRecording('cancel') } else void startRecording() }} disabled={isBusy && !handsFree} aria-pressed={isRecording} aria-label={handsFree ? 'Disable wake-word listening' : isRecording ? 'Stop recording and send' : 'Start voice command'} className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl transition', isRecording && !handsFree ? 'animate-pulse bg-red-500 text-white shadow-[0_0_24px_rgba(239,68,68,.45)]' : handsFree ? 'border border-emerald-300/30 bg-emerald-300/10 text-emerald-200' : 'bg-cyan-300/10 text-cyan-300 hover:bg-cyan-300/20', isBusy && !handsFree && 'opacity-50')}>
                {isRecording && !handsFree ? <MicOff size={19} /> : <Mic size={19} />}
              </button>
              <textarea rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); return } if (event.key === 'ArrowUp' && !event.currentTarget.value && commandHistory.length > 0) { event.preventDefault(); commandHistoryIndexRef.current = commandHistoryIndexRef.current < 0 ? commandHistory.length - 1 : Math.max(0, commandHistoryIndexRef.current - 1); setInput(commandHistory[commandHistoryIndexRef.current] ?? '') } }} disabled={isBusy || (isRecording && !handsFree)} placeholder={isRecording ? 'Wake-word standby · say “Jarvis” followed by a command…' : 'Ask anything or give JARVIS a task…'} className="max-h-28 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm text-cyan-50 outline-none placeholder:text-cyan-100/25" />
              {isBusy && <button type="button" onClick={cancelCurrentTask} aria-label="Cancel active task" title="Cancel active task" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-rose-300/25 bg-rose-300/10 text-rose-200 hover:bg-rose-300/20"><Square size={15} fill="currentColor" /></button>}
              <button type="button" onClick={() => { speechAudioRef.current?.pause(); setSpeechEnabled((value) => !value) }} aria-label={speechEnabled ? 'Mute spoken responses' : 'Enable spoken responses'} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-cyan-100/45 hover:bg-cyan-300/10 hover:text-cyan-200">
                {speechEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
              <button type="submit" disabled={!input.trim() || isBusy} aria-label="Send command" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-cyan-300 text-[#031017] transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-30">
                <Send size={18} />
              </button>
          </form>
      </div>

      {approvalRequest && (
        <div className="jarvis-authorization-backdrop" role="presentation">
          <section className="jarvis-authorization-panel" role="alertdialog" aria-modal="true" aria-labelledby="jarvis-authorization-title" aria-describedby="jarvis-authorization-impact">
            <p className="jarvis-eyebrow">J.A.R.V.I.S. // Authorization required</p>
            <h2 id="jarvis-authorization-title">{approvalRequest.step.title}</h2>
            <dl>
              <div><dt>Reason</dt><dd>{approvalRequest.step.description}</dd></div>
              <div><dt>Exact operation</dt><dd className="whitespace-pre-wrap">{approvalDetail(approvalRequest.step).trim() || approvalRequest.step.tool}</dd></div>
              <div><dt>Impact</dt><dd>This action can interact with the foreground application or operating system. It will not run without your authorization.</dd></div>
            </dl>
            <div className="jarvis-authorization-actions"><button type="button" onClick={() => resolveApproval(false)}>Reject</button><button type="button" className="is-authorize" onClick={() => resolveApproval(true)}>Authorize once</button></div>
          </section>
        </div>
      )}

      {paletteOpen && (
        <div className="jarvis-command-palette-backdrop" role="presentation" onClick={() => setPaletteOpen(false)}>
          <div className="jarvis-command-palette" role="dialog" aria-modal="true" aria-label="JARVIS command palette" onClick={(event) => event.stopPropagation()}>
            <div className="jarvis-palette-heading"><div><p className="jarvis-eyebrow">Neural shortcut layer</p><h2>Command palette</h2></div><kbd>ESC</kbd></div>
            <p className="jarvis-palette-hint">Launch a local directive or protocol without leaving the deck.</p>
            <div className="jarvis-palette-grid">
              {suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => { setPaletteOpen(false); void execute(suggestion) }} disabled={isBusy}><span>{suggestion}</span><ChevronRight size={14} /></button>)}
              {(Object.entries(workflowDefinitions) as [WorkflowKind, typeof workflowDefinitions[WorkflowKind]][]).map(([kind, definition]) => <button key={kind} type="button" onClick={() => { setPaletteOpen(false); void runWorkflow(kind) }} disabled={isBusy}><span>{definition.name}</span><small>PROTOCOL</small><ChevronRight size={14} /></button>)}
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="jarvis-settings-overlay" role="presentation" onClick={() => setSettingsOpen(false)}>
          <aside className="jarvis-settings-drawer" role="dialog" aria-modal="true" aria-label="Command deck settings" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start justify-between border-b border-cyan-300/10 px-5 py-5"><div><p className="jarvis-eyebrow">Secondary systems</p><h2 className="mt-1 text-lg font-medium text-cyan-50/90">Deck settings</h2><p className="mt-1 text-[11px] text-cyan-100/40">Controls stay out of the way until you need them.</p></div><div className="flex items-center gap-2"><button type="button" onClick={() => { setSettingsOpen(false); navigate('/settings') }} className="jarvis-deck-button" aria-label="Open full settings"><span className="hidden sm:inline">Full settings</span><ChevronRight size={14} /></button><button type="button" onClick={() => setSettingsOpen(false)} className="jarvis-deck-button" aria-label="Close settings"><X size={16} /></button></div></div>
            <div className="flex-1 overflow-y-auto px-5 py-5">
              <p className="jarvis-eyebrow">Core telemetry</p>
              <div className="mt-4 grid gap-2">{[
                ['Inference', status?.llm, `Qwen3 8B · ${(status?.chatFormat ?? 'chatml').toUpperCase()} · ${(status?.contextWindow ?? 16384).toLocaleString()} context`],
                ['Voice input', status?.whisper, 'Whisper base.en + ECAPA'],
                ['Voice output', status?.tts, 'Local neural TTS'],
                ['Desktop link', !!window.jarvisDesktop, window.jarvisDesktop ? 'Native control ready' : 'Browser safe mode'],
                ['Agent graph', true, status?.orchestration ?? 'LangGraph'],
                ['Long-term memory', status?.memory, status?.vectorStore ?? 'pgvector'],
                ['Privacy', true, 'Local only · no cloud LLM'],
              ].map(([label, online, value]) => <div key={String(label)} className="jarvis-setting-row"><span><i className={online ? 'is-ready' : ''} />{label}</span><b>{value}</b></div>)}</div>

              <p className="jarvis-eyebrow mt-8">Agent protocols</p>
              <div className="mt-4 grid gap-2">{(Object.entries(workflowDefinitions) as [WorkflowKind, typeof workflowDefinitions[WorkflowKind]][]).map(([kind, definition]) => <button key={kind} onClick={() => { setSettingsOpen(false); void runWorkflow(kind) }} disabled={isBusy} className="jarvis-agent-card"><span className="jarvis-agent-index">0{Object.keys(workflowDefinitions).indexOf(kind) + 1}</span><span><strong>{definition.name}</strong><small>{definition.subtitle}</small></span><Gauge size={14} /></button>)}</div>

              <div className="mt-8 flex items-center justify-between"><p className="jarvis-eyebrow">Local memory</p><button type="button" onClick={() => setMessages([{ id: 'welcome', role: 'assistant', content: 'Session context cleared. Local systems are standing by.' }])} className="text-[9px] uppercase tracking-[.16em] text-cyan-200/45 hover:text-cyan-100">Clear session</button></div>
              <p className="mt-2 text-[11px] leading-relaxed text-cyan-100/40">Only explicitly requested, non-secret memories persist. Remove individual facts without leaving the deck.</p>
              <button type="button" className="jarvis-setting-row mt-3 w-full text-left" onClick={() => { const next = !longTermMemory; setLongTermMemory(next); window.localStorage.setItem(LONG_TERM_MEMORY_KEY, next ? '1' : '0') }}><span><i className={longTermMemory ? 'is-ready' : ''} />Long-term recall</span><b>{longTermMemory ? 'ENABLED' : 'DISABLED'}</b></button>
              <div className="mt-3 space-y-2">
                {memoryLoading && <p className="text-[10px] uppercase tracking-[.15em] text-cyan-200/40">Reading memory fabric…</p>}
                {!memoryLoading && memories.length === 0 && <p className="rounded-lg border border-cyan-300/10 bg-cyan-300/[.02] p-3 text-[10px] text-cyan-100/35">No active long-term memories.</p>}
                {memories.slice(0, 8).map((memory) => <div key={memory.id} className="flex items-start gap-2 rounded-lg border border-cyan-300/10 bg-cyan-300/[.02] p-2.5"><div className="min-w-0 flex-1"><p className="text-[11px] leading-relaxed text-cyan-50/70">{memory.content}</p><small className="mt-1 block font-mono text-[8px] uppercase tracking-wider text-cyan-100/30">{memory.category} · {memory.source}</small></div><button type="button" onClick={() => void removeMemory(memory.id)} aria-label={`Remove memory ${memory.id}`} className="shrink-0 rounded p-1 text-cyan-100/30 hover:bg-rose-300/10 hover:text-rose-200"><Trash2 size={13} /></button></div>)}
              </div>

              <p className="jarvis-eyebrow mt-8">Quick directives</p>
              <div className="mt-4 grid gap-2">{suggestions.map((suggestion) => <button key={suggestion} onClick={() => { setSettingsOpen(false); void execute(suggestion) }} disabled={isBusy} className="group flex items-center justify-between gap-3 rounded-xl border border-cyan-300/10 bg-cyan-300/[.025] px-3 py-3 text-left text-xs leading-snug text-cyan-50/65 transition hover:border-cyan-300/30 hover:bg-cyan-300/[.07] hover:text-cyan-50 disabled:opacity-40"><span>{suggestion}</span><ChevronRight size={13} className="shrink-0 text-cyan-300/45" /></button>)}</div>

              <div className="mt-8 rounded-xl border border-emerald-300/10 bg-emerald-300/[.035] p-3"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-200/80"><CheckCircle2 size={13} /> Privacy seal</div><p className="mt-2 text-[11px] leading-relaxed text-cyan-50/40">Voice, prompts, model inference, and spoken output stay on this PC.</p></div>
              <button type="button" className="jarvis-setting-row mt-3 w-full text-left" onClick={() => { const next = !interfaceSounds; setInterfaceSounds(next); setInterfaceSoundsEnabled(next); if (next) playInterfaceTone('confirm') }}><span><i className={interfaceSounds ? 'is-ready' : ''} />Interface sounds</span><b>{interfaceSounds ? 'ON · QUIET' : 'OFF'}</b></button>
              {systemSnapshot && <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[9px] uppercase tracking-wider text-cyan-100/45"><span className="rounded-lg border border-cyan-300/10 bg-cyan-300/[.025] p-2">CPU<br /><b className="text-cyan-200/80">{systemSnapshot.cpuCount} threads</b></span><span className="rounded-lg border border-cyan-300/10 bg-cyan-300/[.025] p-2">Memory<br /><b className="text-cyan-200/80">{systemSnapshot.freeMemoryGb} GB free</b></span></div>}
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}
