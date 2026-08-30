import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, GitMerge, RefreshCw, Search, Server } from 'lucide-react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useAllSettings } from '@/hooks/useSettings'
import { useServiceEnv } from '@/hooks/useServiceEnv'
import { useContainers, useRestartContainer } from '@/hooks/useContainers'
import ServiceCard from '@/components/settings/ServiceCard'
import ServiceEnvCard from '@/components/settings/ServiceEnvCard'
import VoiceIdentityModule from '@/components/dashboard/VoiceIdentityModule'
import ServiceHealthCard from '@/components/dashboard/ServiceHealthCard'
import UpdateBanner from '@/components/dashboard/UpdateBanner'
import { cn } from '@/lib/utils'
import { getCapabilityDiagnostics, runAssistantSmokeTest } from '@/api/assistant'

export default function SettingsPage() {
  const navigate = useNavigate()
  const { data, isLoading, isError, error, refetch, isFetching } = useAllSettings()
  const { data: envData } = useServiceEnv()
  const containersQuery = useContainers()
  const restartMutation = useRestartContainer()
  const [search, setSearch] = useState('')
  const diagnosticsQuery = useQuery({ queryKey: ['assistant-capability-diagnostics'], queryFn: getCapabilityDiagnostics, staleTime: 15_000 })
  const smokeMutation = useMutation({
    mutationFn: runAssistantSmokeTest,
    onSuccess: (result) => result.pass ? toast.success('Core local smoke test passed') : toast.error('Core local smoke test found a failure'),
    onError: (err: Error) => toast.error(`Smoke test failed: ${err.message}`),
  })

  const filtered = useMemo(() => {
    if (!data) return []
    if (!search.trim()) return data.services

    const q = search.toLowerCase()
    return data.services
      .map((svc) => ({
        ...svc,
        settings: svc.settings.filter(
          (s) =>
            s.key.toLowerCase().includes(q) ||
            s.category.toLowerCase().includes(q) ||
            (s.description?.toLowerCase().includes(q) ?? false),
        ),
      }))
      .filter((svc) => svc.settings.length > 0 || svc.service_name.toLowerCase().includes(q))
  }, [data, search])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="animate-spin text-[var(--color-primary)]" size={24} />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="py-20 text-center">
        <p className="mb-2 text-red-500">Failed to load settings</p>
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          {(error as Error)?.message ?? 'Unknown error'}
        </p>
        <button
          onClick={() => refetch()}
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Settings</h1>

        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          {data && (
            <span>
              {data.successful_services}/{data.total_services} services
            </span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className={cn(
              'rounded-lg p-1.5 hover:bg-[var(--color-surface-alt)]',
              isFetching && 'animate-spin',
            )}
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Operator identity</h2>
          <p className="text-xs text-[var(--color-text-muted)]">Manage local voice enrollment and speaker-scoped context. Audio stays on this PC.</p>
        </div>
        <VoiceIdentityModule />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Capability diagnostics</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Measured local checks only. UNKNOWN means this session has not produced proof.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => diagnosticsQuery.refetch()} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]">Refresh</button>
            <button type="button" onClick={() => smokeMutation.mutate()} disabled={smokeMutation.isPending} className="rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-50">{smokeMutation.isPending ? 'Testing…' : 'Run safe smoke test'}</button>
          </div>
        </div>
        {diagnosticsQuery.isError && <div className="rounded-lg border border-red-400/20 bg-red-500/5 p-3 text-xs text-red-300">Diagnostics unavailable: {(diagnosticsQuery.error as Error).message}</div>}
        {diagnosticsQuery.data && <div className="jarvis-panel p-4">
          <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-2"><Activity size={16} className="text-cyan-300" /><span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text)]">{diagnosticsQuery.data.overall}</span></div><span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{diagnosticsQuery.data.locality}</span></div>
          <div className="grid gap-2 sm:grid-cols-2">{diagnosticsQuery.data.capabilities.map((capability) => <div key={capability.id} className="rounded-lg border border-[var(--color-border)] bg-black/10 p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-[var(--color-text)]">{capability.label}</span><span className={cn('text-[9px] font-bold tracking-wider', capability.status === 'READY' || capability.status === 'ACTIVE' ? 'text-emerald-300' : capability.status === 'OFFLINE' ? 'text-red-300' : 'text-amber-200')}>{capability.status}</span></div><p className="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{capability.evidence}</p>{typeof capability.latencyMs === 'number' && <p className="mt-1 text-[9px] text-cyan-300/70">{capability.latencyMs} ms local probe</p>}</div>)}</div>
        </div>}
        {smokeMutation.data && <div className="rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]"><strong className={smokeMutation.data.pass ? 'text-emerald-300' : 'text-red-300'}>{smokeMutation.data.pass ? 'PASS' : 'FAIL'}</strong> · {smokeMutation.data.passed.length} required checks passed · {smokeMutation.data.unverified.length} live-only capabilities remain unverified.<p className="mt-1 text-[10px]">{smokeMutation.data.note}</p></div>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Operations</h2>
            <p className="text-xs text-[var(--color-text-muted)]">Service health, updates, and compose reconciliation live here instead of crowding the command deck.</p>
          </div>
          <button type="button" onClick={() => containersQuery.refetch()} className={cn('rounded-lg p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-alt)]', containersQuery.isFetching && 'animate-spin')} title="Refresh service health"><RefreshCw size={14} /></button>
        </div>
        <UpdateBanner />
        <div className="jarvis-panel flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3"><GitMerge size={20} className="text-[var(--color-text-muted)]" /><div><p className="text-sm font-medium text-[var(--color-text)]">Sync compose to latest registry</p><p className="text-xs text-[var(--color-text-muted)]">Regenerate compose and re-register services without changing the command deck.</p></div></div>
          <button type="button" onClick={() => navigate('/reconcile')} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]">Sync now</button>
        </div>
        {containersQuery.isLoading && <div className="flex items-center justify-center py-6"><RefreshCw className="animate-spin text-[var(--color-primary)]" size={20} /></div>}
        {containersQuery.isError && <div className="rounded-lg border border-red-400/20 bg-red-500/5 p-3 text-xs text-red-300">Service health unavailable: {(containersQuery.error as Error)?.message ?? 'Docker is not reachable'}</div>}
        {containersQuery.data && !containersQuery.isLoading && (() => {
          const running = containersQuery.data.containers.filter((container) => container.state === 'running')
          const stopped = containersQuery.data.containers.filter((container) => container.state !== 'running')
          const restart = (id: string) => restartMutation.mutate(id, { onSuccess: () => toast.success('Container restart initiated'), onError: (err) => toast.error(`Restart failed: ${err.message}`) })
          return containersQuery.data.containers.length === 0
            ? <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]"><Server size={15} />{containersQuery.data.error ?? 'No Jarvis containers found.'}</div>
            : <div className="space-y-3">{running.length > 0 && <div><p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Running</p><div className="grid gap-3 sm:grid-cols-2">{running.map((container) => <ServiceHealthCard key={container.id} container={container} onRestart={restart} isRestarting={restartMutation.isPending && restartMutation.variables === container.id} />)}</div></div>}{stopped.length > 0 && <div><p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Stopped</p><div className="grid gap-3 sm:grid-cols-2">{stopped.map((container) => <ServiceHealthCard key={container.id} container={container} onRestart={restart} isRestarting={restartMutation.isPending && restartMutation.variables === container.id} />)}</div></div>}</div>
        })()}
      </section>

      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search settings..."
          className={cn(
            'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-3',
            'text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
            'outline-none focus:ring-2 focus:ring-[var(--color-primary)]',
          )}
        />
      </div>

      <div className="space-y-3">
        {filtered.map((svc, i) => (
          <ServiceCard key={svc.service_name} result={svc} defaultExpanded={i === 0} />
        ))}

        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">
            {search ? 'No settings match your search' : 'No services found'}
          </p>
        )}
      </div>

      {envData && envData.services.length > 0 && (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              Service credentials
            </h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              Third-party keys these services need (stored in the stack .env, never in
              the settings database — secrets are write-only here).
            </p>
          </div>
          {envData.services.map((entry) => (
            <ServiceEnvCard key={entry.service_id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
