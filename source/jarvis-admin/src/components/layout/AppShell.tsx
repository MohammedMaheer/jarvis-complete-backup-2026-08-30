import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import Sidebar from './Sidebar'
import Header from './Header'
import { JarvisActivityProvider } from '@/hooks/useJarvisActivity'

export default function AppShell() {
  const { state } = useAuth()
  const location = useLocation()

  if (state.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-background)]">
        <p className="text-[var(--color-text-muted)]">Loading...</p>
      </div>
    )
  }

  if (!state.isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  const immersiveDashboard = location.pathname === '/dashboard' || location.pathname === '/overlay'
  const overlay = location.pathname === '/overlay'

  return (
    <JarvisActivityProvider>
      <div className={overlay ? 'jarvis-workspace jarvis-workspace--immersive jarvis-workspace--overlay flex h-screen bg-[var(--color-background)]' : immersiveDashboard ? 'jarvis-workspace jarvis-workspace--immersive flex h-screen bg-[var(--color-background)]' : 'jarvis-workspace flex h-screen bg-[var(--color-background)]'}>
        {!immersiveDashboard && <Sidebar />}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!overlay && <Header immersive={immersiveDashboard} />}
          <main className={immersiveDashboard ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'flex-1 overflow-y-auto p-3 sm:p-5 lg:p-7'}>
            <Outlet />
          </main>
        </div>
      </div>
    </JarvisActivityProvider>
  )
}
