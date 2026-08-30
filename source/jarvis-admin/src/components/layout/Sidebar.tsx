import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Settings, Server, Cpu, Box, Zap, Activity, Boxes, Users, ArrowUpCircle, AudioWaveform } from 'lucide-react'
import { cn } from '@/lib/utils'
import SystemInfoBar from './SystemInfoBar'
import type { LucideIcon } from 'lucide-react'

interface NavItem {
  label: string
  icon: LucideIcon
  path: string
}

const navItems: NavItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: '/dashboard' },
  { label: 'Settings', icon: Settings, path: '/settings' },
  { label: 'Services', icon: Server, path: '/services' },
  { label: 'Models', icon: Box, path: '/models' },
  { label: 'Quick Sets', icon: Zap, path: '/quick-sets' },
  { label: 'Traces', icon: Activity, path: '/traces' },
  { label: 'Nodes', icon: Cpu, path: '/nodes' },
  { label: 'Users', icon: Users, path: '/users' },
  { label: 'Native', icon: Boxes, path: '/native-services' },
  // /update used to be reachable ONLY via the dashboard's UpdateBanner, which
  // renders only when an update is available. With update checks off, the server
  // never contacts GitHub and always reports updateAvailable:false — so the
  // banner never appeared, so the page was unreachable, so its "Check for
  // updates" toggle was unreachable. To turn updates ON you had to reach a page
  // that only existed once updates were already on. It needs a permanent home.
  { label: 'Updates', icon: ArrowUpCircle, path: '/update' },
]

export default function Sidebar() {
  return (
    <aside className="z-20 flex w-20 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]/90 backdrop-blur-xl lg:w-64">
      <div className="flex h-[4.25rem] items-center border-b border-[var(--color-border)] px-4 lg:px-5">
        <span className="jarvis-orb h-9 w-9 shrink-0 text-white">
          <AudioWaveform size={17} aria-hidden="true" />
        </span>
        <div className="ml-3 hidden min-w-0 lg:block">
          <span className="block text-base font-bold tracking-[0.18em] text-[var(--color-text)]">JARVIS</span>
          <span className="block text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-muted)]">Local command core</span>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2.5 lg:p-3" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                'group flex min-h-11 items-center justify-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-all lg:justify-start',
                isActive
                  ? 'bg-[var(--color-primary)]/12 text-[var(--color-primary)] shadow-sm ring-1 ring-[var(--color-primary)]/15'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]',
              )
            }
            title={item.label}
          >
            <item.icon size={18} className="shrink-0 transition-transform group-hover:scale-105" />
            <span className="hidden lg:inline">{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="hidden lg:block"><SystemInfoBar /></div>
    </aside>
  )
}
