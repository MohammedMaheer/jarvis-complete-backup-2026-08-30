export type AgentTool =
  | 'reason'
  | 'system_status'
  | 'screen_context'
  | 'process_snapshot'
  | 'file_search'
  | 'open_file'
  | 'action_history'
  | 'open_app'
  | 'open_folder'
  | 'open_settings'
  | 'system_action'
  | 'window_control'
  | 'cursor_move'
  | 'cursor_click'
  | 'click_element'
  | 'type_text'
  | 'key_press'
  | 'request_approval'

export interface AgentToolArguments {
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

export interface AgentToolDefinition {
  name: AgentTool
  description: string
  riskLevel: 0 | 1 | 2 | 3
  requiresApproval: boolean
  timeoutMs: number
  maxRetries: number
  availability: 'desktop' | 'all'
  allowedTargets?: readonly string[]
}

const tool = (definition: AgentToolDefinition) => definition

export const AGENT_TOOL_REGISTRY: Readonly<Record<AgentTool, AgentToolDefinition>> = Object.freeze({
  reason: tool({ name: 'reason', description: 'Synthesize measured results without performing an action.', riskLevel: 0, requiresApproval: false, timeoutMs: 120_000, maxRetries: 0, availability: 'all' }),
  system_status: tool({ name: 'system_status', description: 'Read the current local system snapshot.', riskLevel: 0, requiresApproval: false, timeoutMs: 8_000, maxRetries: 1, availability: 'desktop' }),
  screen_context: tool({ name: 'screen_context', description: 'Read foreground window and Windows accessibility metadata.', riskLevel: 0, requiresApproval: false, timeoutMs: 10_000, maxRetries: 1, availability: 'desktop' }),
  process_snapshot: tool({ name: 'process_snapshot', description: 'Read and rank current user processes by memory without changing them.', riskLevel: 0, requiresApproval: false, timeoutMs: 8_000, maxRetries: 1, availability: 'desktop' }),
  file_search: tool({ name: 'file_search', description: 'Search bounded user folders by filename, extension, and modification time without scanning protected locations.', riskLevel: 0, requiresApproval: false, timeoutMs: 10_000, maxRetries: 1, availability: 'desktop' }),
  open_file: tool({ name: 'open_file', description: 'Open an exact previously resolved file inside an approved user folder.', riskLevel: 1, requiresApproval: false, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop' }),
  action_history: tool({ name: 'action_history', description: 'Report verified PC changes performed by JARVIS in the current desktop session.', riskLevel: 0, requiresApproval: false, timeoutMs: 4_000, maxRetries: 0, availability: 'desktop' }),
  open_app: tool({ name: 'open_app', description: 'Open or focus one allowlisted local application and verify its process.', riskLevel: 1, requiresApproval: false, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop', allowedTargets: ['calculator', 'notepad', 'explorer', 'terminal', 'task_manager', 'chrome', 'edge', 'browser', 'vscode', 'spotify'] }),
  open_folder: tool({ name: 'open_folder', description: 'Open one allowlisted local folder.', riskLevel: 1, requiresApproval: false, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop', allowedTargets: ['jarvis', 'desktop', 'downloads', 'documents'] }),
  open_settings: tool({ name: 'open_settings', description: 'Open an allowlisted Windows settings surface.', riskLevel: 1, requiresApproval: false, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop', allowedTargets: ['windows'] }),
  system_action: tool({ name: 'system_action', description: 'Perform an allowlisted operating-system action.', riskLevel: 3, requiresApproval: true, timeoutMs: 10_000, maxRetries: 0, availability: 'desktop', allowedTargets: ['lock', 'volume_mute', 'volume_up', 'volume_down', 'sleep', 'shutdown_pc', 'restart_pc'] }),
  window_control: tool({ name: 'window_control', description: 'Focus, minimize, maximize, restore, snap, or move a named visible application window using Win32 APIs and verify its bounds.', riskLevel: 1, requiresApproval: false, timeoutMs: 10_000, maxRetries: 1, availability: 'desktop' }),
  cursor_move: tool({ name: 'cursor_move', description: 'Move the pointer to operator-supplied coordinates.', riskLevel: 2, requiresApproval: true, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop' }),
  cursor_click: tool({ name: 'cursor_click', description: 'Click at operator-supplied coordinates.', riskLevel: 2, requiresApproval: true, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop' }),
  click_element: tool({ name: 'click_element', description: 'Click a named Windows accessibility element.', riskLevel: 2, requiresApproval: true, timeoutMs: 10_000, maxRetries: 0, availability: 'desktop' }),
  type_text: tool({ name: 'type_text', description: 'Type bounded literal text into the foreground application.', riskLevel: 2, requiresApproval: true, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop' }),
  key_press: tool({ name: 'key_press', description: 'Send one allowlisted keyboard command.', riskLevel: 2, requiresApproval: true, timeoutMs: 8_000, maxRetries: 0, availability: 'desktop' }),
  request_approval: tool({ name: 'request_approval', description: 'Pause a workflow for explicit operator authorization.', riskLevel: 2, requiresApproval: true, timeoutMs: 300_000, maxRetries: 0, availability: 'all' }),
})

export const AGENT_TOOLS = new Set<AgentTool>(Object.keys(AGENT_TOOL_REGISTRY) as AgentTool[])
export const ALLOWED_KEYS = new Set(['ENTER', 'TAB', 'ESCAPE', 'BACKSPACE', 'DELETE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'CTRL+A', 'CTRL+C', 'CTRL+V', 'CTRL+F', 'CTRL+L', 'CTRL+S', 'ALT+TAB'])

function finiteCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= -20_000 && value <= 20_000 ? value : undefined
}

function containsUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true
  }
  return false
}

export function normalizeToolArguments(toolName: AgentTool, target: string | undefined, input: AgentToolArguments | undefined): AgentToolArguments | undefined {
  const raw = input ?? {}
  if (toolName === 'cursor_move' || toolName === 'cursor_click') {
    const x = finiteCoordinate(raw.x)
    const y = finiteCoordinate(raw.y)
    if (x === undefined || y === undefined) return undefined
    return { x, y, ...(toolName === 'cursor_click' ? { button: raw.button === 'right' ? 'right' : 'left', clicks: raw.clicks === 2 ? 2 : 1 } : {}) }
  }
  if (toolName === 'click_element') {
    const query = String(raw.query ?? target ?? '').trim().slice(0, 120)
    return query ? { query } : undefined
  }
  if (toolName === 'window_control') {
    const query = String(raw.query ?? target ?? '').trim().slice(0, 120)
    const operations = new Set(['focus', 'minimize', 'maximize', 'restore', 'snap_left', 'snap_right', 'move_monitor'])
    const operation = String(raw.operation ?? '')
    const monitor = Number.isInteger(raw.monitor) && Number(raw.monitor) >= 1 && Number(raw.monitor) <= 16 ? Number(raw.monitor) : undefined
    if (!query || !operations.has(operation) || (operation === 'move_monitor' && monitor === undefined)) return undefined
    return { query, operation: operation as AgentToolArguments['operation'], ...(monitor ? { monitor } : {}) }
  }
  if (toolName === 'file_search') {
    const query = String(raw.query ?? '').trim().slice(0, 120)
    const extension = String(raw.extension ?? '').trim().toLowerCase().replace(/^\./, '').slice(0, 12)
    const scope = ['desktop', 'downloads', 'documents', 'jarvis'].includes(String(raw.scope)) ? raw.scope : 'downloads'
    return query || extension ? { ...(query ? { query } : {}), ...(extension ? { extension } : {}), scope } : undefined
  }
  if (toolName === 'open_file') {
    const path = String(raw.path ?? target ?? '').trim().slice(0, 1_024)
    return path ? { path } : undefined
  }
  if (toolName === 'type_text') {
    const text = String(raw.text ?? '').slice(0, 500)
    return text && !containsUnsafeControlCharacter(text) ? { text } : undefined
  }
  if (toolName === 'key_press') {
    const key = String(raw.key ?? target ?? '').trim().toUpperCase()
    return ALLOWED_KEYS.has(key) ? { key } : undefined
  }
  return undefined
}

export function publicToolRegistry(): Array<Omit<AgentToolDefinition, 'allowedTargets'> & { allowedTargets?: readonly string[] }> {
  return Object.values(AGENT_TOOL_REGISTRY).map((definition) => ({ ...definition }))
}

export function toolCatalogForPrompt(): string {
  return Object.values(AGENT_TOOL_REGISTRY)
    .map((definition) => `${definition.name}: ${definition.description} Risk ${definition.riskLevel}; approval=${definition.requiresApproval}; targets=${definition.allowedTargets?.join('|') ?? 'structured arguments'}`)
    .join('\n')
}
