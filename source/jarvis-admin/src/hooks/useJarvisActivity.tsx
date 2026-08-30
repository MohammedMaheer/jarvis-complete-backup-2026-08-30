import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { useAuth } from '@/auth/AuthContext'

export type JarvisActivity =
  | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'planning' | 'memory'
  | 'executing' | 'waiting_approval' | 'recovering' | 'speaking' | 'complete'
  | 'cancelled' | 'warning' | 'error' | 'offline'

export interface AudioLevel {
  rms: number
  bass: number
  mid: number
  treble: number
  timestamp: number
}

export interface JarvisUiEvent {
  schemaVersion: 1
  id: string
  timestamp: string
  activity: JarvisActivity
  phase: 'start' | 'progress' | 'complete' | 'error'
  source: 'system' | 'mic' | 'stt' | 'memory' | 'llm' | 'tool' | 'tts'
  label: string
  conversationId?: string
  taskId?: string
  stepId?: string
  toolName?: string
  progress?: number
  latencyMs?: number
  metadata?: Record<string, string | number | boolean>
}

interface ActivityState {
  activity: JarvisActivity
  connected: boolean
  lastEvent: JarvisUiEvent | null
  micLevel: AudioLevel | null
  ttsLevel: AudioLevel | null
  error: string | null
}

type Action =
  | { type: 'event'; event: JarvisUiEvent }
  | { type: 'connection'; connected: boolean; error?: string }
  | { type: 'local'; activity: JarvisActivity; label?: string }
  | { type: 'mic-level'; level: AudioLevel | null }
  | { type: 'tts-level'; level: AudioLevel | null }

const initialState: ActivityState = {
  activity: 'offline',
  connected: false,
  lastEvent: null,
  micLevel: null,
  ttsLevel: null,
  error: null,
}

function reducer(state: ActivityState, action: Action): ActivityState {
  switch (action.type) {
    case 'event':
      return { ...state, activity: action.event.activity, connected: true, lastEvent: action.event, error: action.event.phase === 'error' ? action.event.label : null }
    case 'connection':
      return { ...state, connected: action.connected, activity: action.connected ? state.activity : 'offline', error: action.error ?? null }
    case 'local':
      return { ...state, activity: action.activity, error: action.activity === 'error' || action.activity === 'warning' ? action.label ?? null : null }
    case 'mic-level': return { ...state, micLevel: action.level }
    case 'tts-level': return { ...state, ttsLevel: action.level }
    default: return state
  }
}

interface ActivityContextValue extends ActivityState {
  setLocalActivity: (activity: JarvisActivity, label?: string) => void
  setMicLevel: (level: AudioLevel | null) => void
  setTtsLevel: (level: AudioLevel | null) => void
}

const ActivityContext = createContext<ActivityContextValue | null>(null)

function parseSseBlock(block: string): JarvisUiEvent | null {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
  if (!data) return null
  try {
    const event = JSON.parse(data) as Partial<JarvisUiEvent>
    if (event.schemaVersion !== 1 || typeof event.id !== 'string' || typeof event.activity !== 'string' || typeof event.label !== 'string') return null
    return event as JarvisUiEvent
  } catch {
    return null
  }
}

export function JarvisActivityProvider({ children }: { children: ReactNode }) {
  const { state: auth } = useAuth()
  const [state, dispatch] = useReducer(reducer, initialState)
  const lastEventId = useRef<string | null>(null)
  const lastAgentEventId = useRef<string | null>(null)

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.accessToken) {
      dispatch({ type: 'connection', connected: false })
      return
    }
    let cancelled = false
    let retryTimer: number | undefined
    let retryMs = 1_000
    const controller = new AbortController()

    const connect = async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${auth.accessToken}` }
        if (lastEventId.current) headers['Last-Event-ID'] = lastEventId.current
        const response = await fetch('/api/assistant/events', { headers, cache: 'no-store', signal: controller.signal })
        if (!response.ok || !response.body) throw new Error(`Event bridge unavailable (${response.status})`)
        dispatch({ type: 'connection', connected: true })
        retryMs = 1_000
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ''
          for (const block of blocks) {
            const event = parseSseBlock(block)
            if (event) {
              lastEventId.current = event.id
              dispatch({ type: 'event', event })
            }
          }
        }
        if (!cancelled) throw new Error('Event bridge disconnected')
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
        dispatch({ type: 'connection', connected: false, error: error instanceof Error ? error.message : 'Event bridge unavailable' })
        retryTimer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(15_000, retryMs * 2)
      }
    }
    void connect()
    return () => {
      cancelled = true
      controller.abort()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [auth.accessToken, auth.isAuthenticated])

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.accessToken) return
    let cancelled = false
    let retryTimer: number | undefined
    let retryMs = 1_000
    const controller = new AbortController()
    const connect = async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream', Authorization: `Bearer ${auth.accessToken}` }
        if (lastAgentEventId.current) headers['Last-Event-ID'] = lastAgentEventId.current
        const response = await fetch('/api/assistant/agent/events', { headers, cache: 'no-store', signal: controller.signal })
        if (!response.ok || !response.body) throw new Error(`Agent event bridge unavailable (${response.status})`)
        retryMs = 1_000
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ''
          for (const block of blocks) {
            const event = parseSseBlock(block)
            if (!event) continue
            lastAgentEventId.current = event.id
            dispatch({ type: 'event', event })
          }
        }
        if (!cancelled) throw new Error('Agent event bridge disconnected')
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
        retryTimer = window.setTimeout(connect, retryMs)
        retryMs = Math.min(15_000, retryMs * 2)
      }
    }
    void connect()
    return () => {
      cancelled = true
      controller.abort()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [auth.accessToken, auth.isAuthenticated])

  const setLocalActivity = useCallback((activity: JarvisActivity, label?: string) => dispatch({ type: 'local', activity, label }), [])
  const setMicLevel = useCallback((level: AudioLevel | null) => dispatch({ type: 'mic-level', level }), [])
  const setTtsLevel = useCallback((level: AudioLevel | null) => dispatch({ type: 'tts-level', level }), [])
  const value = useMemo(() => ({ ...state, setLocalActivity, setMicLevel, setTtsLevel }), [state, setLocalActivity, setMicLevel, setTtsLevel])
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useJarvisActivity() {
  const value = useContext(ActivityContext)
  if (!value) throw new Error('useJarvisActivity must be used within JarvisActivityProvider')
  return value
}

// eslint-disable-next-line react-refresh/only-export-components
export { reducer as jarvisActivityReducer, parseSseBlock }
