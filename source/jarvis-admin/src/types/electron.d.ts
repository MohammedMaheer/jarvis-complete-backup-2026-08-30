export interface JarvisDesktopAction {
  type: 'process_snapshot' | 'file_search' | 'open_file' | 'action_history' | 'open_app' | 'open_folder' | 'open_settings' | 'system_action' | 'window_control' | 'cursor_move' | 'cursor_click' | 'click_element' | 'type_text' | 'key_press'
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
}

export interface JarvisDesktopResult {
  success: boolean
  message: string
  evidence?: Record<string, string | number | boolean>
}

export interface JarvisScreenContext {
  capturedAt: string
  foreground: { title: string; processName: string; processId: number }
  cursor: { x: number; y: number }
  accessibilityAvailable: boolean
  screenAccess: 'on_demand' | 'blocked'
  exclusionReason?: string | null
  windows: Array<{
    title: string
    processName: string
    processId: number
    isForeground: boolean
    bounds: { x: number; y: number; width: number; height: number }
  }>
  elements: Array<{
    name: string
    controlType: string
    automationId: string
    className: string
    enabled: boolean
    clickable: boolean
    bounds: { x: number; y: number; width: number; height: number }
  }>
}

export interface JarvisSystemSnapshot {
  hostname: string
  platform: string
  uptimeSeconds: number
  totalMemoryGb: number
  freeMemoryGb: number
  cpuCount: number
  cpuUsagePercent: number
  gpu: {
    name: string
    utilizationPercent: number
    memoryUsedMb: number
    memoryTotalMb: number
    temperatureC: number
  } | null
  desktop: boolean
}

declare global {
  interface Window {
    jarvisDesktop?: {
      isDesktop: boolean
      getSystemSnapshot: () => Promise<JarvisSystemSnapshot>
      inspectScreen: () => Promise<JarvisScreenContext>
      executeAction: (action: JarvisDesktopAction) => Promise<JarvisDesktopResult>
      minimize: () => Promise<boolean>
      toggleMaximize: () => Promise<boolean>
      close: () => Promise<boolean>
      setWindowMode: (mode: 'full' | 'overlay' | 'hide') => Promise<boolean>
      dashboardReady: () => Promise<boolean>
    }
  }
}

export {}
