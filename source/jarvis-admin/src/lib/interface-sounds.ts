export type InterfaceTone = 'listen' | 'confirm' | 'warning' | 'error'

const STORAGE_KEY = 'jarvis:interface-sounds'

export function interfaceSoundsEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
}

export function setInterfaceSoundsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
}

/** Short, local-only UI cue. It never runs from a background/liveness loop. */
export function playInterfaceTone(tone: InterfaceTone): void {
  if (!interfaceSoundsEnabled() || typeof window === 'undefined') return
  const context = new window.AudioContext()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const now = context.currentTime
  const frequencies: Record<InterfaceTone, number> = { listen: 520, confirm: 740, warning: 300, error: 180 }
  oscillator.frequency.setValueAtTime(frequencies[tone], now)
  oscillator.type = tone === 'error' ? 'sawtooth' : 'sine'
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(tone === 'error' ? 0.035 : 0.022, now + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + (tone === 'warning' ? 0.18 : 0.12))
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + 0.2)
  oscillator.addEventListener('ended', () => { void context.close().catch(() => {}) }, { once: true })
}

