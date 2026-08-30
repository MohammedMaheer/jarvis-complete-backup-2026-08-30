import JarvisCommandConsole from '@/components/dashboard/JarvisCommandConsole'

/**
 * The dashboard is intentionally a focused command deck. Operational controls
 * (containers, service registration, identity enrolment, and reconciliation)
 * remain available from Settings and the dedicated management routes so the
 * first screen stays useful instead of becoming another admin console.
 */
export default function DashboardPage() {
  return <JarvisCommandConsole />
}
