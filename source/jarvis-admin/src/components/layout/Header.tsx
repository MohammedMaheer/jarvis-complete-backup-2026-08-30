import { useState } from 'react'
import { AppWindow, LogOut, Minus, Moon, Power, ShieldCheck, Square, Sun, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/theme/ThemeProvider'
import { shutdownJarvis } from '@/api/containers'

export default function Header({ immersive = false }: { immersive?: boolean }) {
  const { state, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [isShuttingDown, setIsShuttingDown] = useState(false)

  const handleEmergencyStop = async () => {
    const confirmed = window.confirm(
      'Emergency stop Jarvis now? This immediately stops every Jarvis service and closes the local dashboard. Windows and unrelated apps will remain running.',
    )
    if (!confirmed) return

    setIsShuttingDown(true)
    try {
      const result = await shutdownJarvis()
      if (result.failed.length > 0) {
        toast.warning(`${result.stopped.length} services stopped; ${result.failed.length} could not be stopped.`)
      } else {
        toast.success(`${result.stopped.length} Jarvis services stopped.`)
      }
      setTimeout(() => window.close(), 500)
    } catch (err) {
      setIsShuttingDown(false)
      toast.error(err instanceof Error ? err.message : 'Emergency stop failed')
    }
  }

  return (
    <header className={immersive
      ? 'jarvis-titlebar jarvis-titlebar--immersive z-10 flex h-12 shrink-0 items-center justify-between border-b border-cyan-300/10 bg-[#020b12]/65 px-4 backdrop-blur-xl sm:px-7'
      : 'jarvis-titlebar z-10 flex h-[4.25rem] items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)]/72 px-4 backdrop-blur-xl sm:px-6'}>
      <div className="flex items-center gap-3">
        {immersive && <span className="jarvis-orb h-7 w-7 shrink-0 text-white"><AppWindow size={13} aria-hidden="true" /></span>}
        <div>
          <h2 className={immersive ? 'font-mono text-[10px] font-bold uppercase tracking-[.24em] text-cyan-100/80' : 'text-sm font-semibold text-[var(--color-text)]'}>{immersive ? 'J.A.R.V.I.S. // COMMAND DECK' : 'Command Center'}</h2>
          <p className={immersive ? 'hidden' : 'hidden text-[11px] text-[var(--color-text-muted)] sm:block'}>Private local assistant operations</p>
        </div>
        {window.jarvisDesktop?.isDesktop && (
          <span className="hidden items-center gap-1.5 rounded-full border border-cyan-300/20 bg-cyan-300/5 px-2 py-1 font-mono text-[8px] font-bold uppercase tracking-[.18em] text-cyan-200/65 md:flex">
            <AppWindow size={10} /> Native shell
          </span>
        )}
      </div>

      <div className="jarvis-no-drag flex items-center gap-3">
        <button
          onClick={handleEmergencyStop}
          disabled={isShuttingDown}
          className="group flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-red-400 transition hover:border-red-400/60 hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-60"
          title="Emergency stop all Jarvis services"
          aria-label="Emergency stop all Jarvis services"
        >
          <Power size={17} className={isShuttingDown ? 'animate-pulse' : 'group-hover:drop-shadow-[0_0_6px_rgba(248,113,113,.9)]'} />
          <span className="hidden text-[10px] font-bold uppercase tracking-[0.12em] lg:inline">
            {isShuttingDown ? 'Stopping' : 'Kill Jarvis'}
          </span>
        </button>
        {state.user && (
          <div className="hidden items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-alt)]/70 px-3 py-1.5 sm:flex">
            <ShieldCheck size={14} className="text-[var(--color-secondary)]" aria-hidden="true" />
            <span className="max-w-52 truncate text-xs font-medium text-[var(--color-text-muted)]">{state.user.email}</span>
          </div>
        )}

        <button
          onClick={toggleTheme}
          className="rounded-xl border border-transparent p-2 text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        <button
          onClick={logout}
          className="rounded-xl border border-transparent p-2 text-[var(--color-text-muted)] hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-500"
          title="Logout"
        >
          <LogOut size={18} />
        </button>

        {window.jarvisDesktop?.isDesktop && (
          <div className="ml-1 flex items-center border-l border-cyan-300/10 pl-2">
            <button onClick={() => void window.jarvisDesktop?.minimize()} className="grid h-8 w-9 place-items-center rounded-lg text-cyan-100/45 hover:bg-cyan-300/10 hover:text-cyan-100" title="Collapse to desktop overlay" aria-label="Collapse JARVIS to desktop overlay"><Minus size={14} /></button>
            <button onClick={() => void window.jarvisDesktop?.toggleMaximize()} className="grid h-8 w-9 place-items-center rounded-lg text-cyan-100/45 hover:bg-cyan-300/10 hover:text-cyan-100" aria-label="Restore or maximize JARVIS"><Square size={11} /></button>
            <button onClick={() => void window.jarvisDesktop?.close()} className="grid h-8 w-9 place-items-center rounded-lg text-cyan-100/45 hover:bg-red-500/20 hover:text-red-300" aria-label="Close JARVIS"><X size={15} /></button>
          </div>
        )}
      </div>
    </header>
  )
}
