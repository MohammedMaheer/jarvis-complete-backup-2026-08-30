import { lazy, Suspense, type FormEvent, useEffect, useRef, useState } from 'react'
import { Fingerprint, KeyRound, Mic, MicOff, RefreshCw, ShieldCheck, Waves } from 'lucide-react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { getSetupStatus, getVoiceChallenge, type VoiceChallenge, type VoiceVerificationFailure } from '@/api/auth'
import { apiClient } from '@/api/client'
import { assessVoiceCapture, createAudioCapture, encodeWav, openMicrophoneStream, unlockAudioPlayback, type AudioCapture } from '@/lib/audio'
import { cn } from '@/lib/utils'

type Mode = 'loading' | 'setup' | 'login'
interface StartupReport { status: 'starting' | 'ready' | 'failed' | 'degraded' | 'unknown'; stage: string; message: string }
const NeuralCoreScene = lazy(() => import('@/components/dashboard/NeuralCoreScene'))
const NeuralScene = ({ mode, compact = false }: { mode: string; compact?: boolean }) => <Suspense fallback={<div className="jarvis-core-fallback" />}><NeuralCoreScene mode={mode} compact={compact} /></Suspense>

export default function LoginPage() {
  const { state, login, voiceUnlock, setup } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('loading')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [challenge, setChallenge] = useState<VoiceChallenge | null>(null)
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [voiceState, setVoiceState] = useState('Calibrating local identity systems')
  const [startupReport, setStartupReport] = useState<StartupReport | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const chunksRef = useRef<Float32Array[]>([])

  const refreshChallenge = async () => {
    setVoiceState('Generating secure local challenge')
    try {
      const next = await getVoiceChallenge()
      setChallenge(next)
      setVoiceState(next.enrolled ? 'Voiceprint ready · identity challenge armed' : 'Voiceprint enrollment required · use credentials once')
      if (!next.enrolled) setCredentialsOpen(true)
    } catch {
      setChallenge(null)
      setVoiceState('Voice identity offline · credentials available')
      setCredentialsOpen(true)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function checkSetup() {
      try {
        const { data } = await apiClient.get<StartupReport>('/startup')
        if (!cancelled) setStartupReport(data)
      } catch { /* The health shell may be from an older build. */ }
      try {
        const { data } = await apiClient.get<{ configured: boolean }>('/api/setup/status')
        if (!cancelled && !data.configured) return navigate('/setup', { replace: true })
      } catch {
        if (!cancelled) navigate('/setup', { replace: true })
        return
      }
      try {
        const res = await getSetupStatus()
        if (!cancelled) {
          setMode(res.needs_setup ? 'setup' : 'login')
          if (!res.needs_setup) void refreshChallenge()
        }
      } catch { if (!cancelled) setMode('login') }
    }
    void checkSetup()
    return () => { cancelled = true }
  }, [navigate])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    void captureRef.current?.stop()
  }, [])

  useEffect(() => {
    if (mode !== 'login' || !window.jarvisDesktop || sessionStorage.getItem('jarvis-login:greeted') === '1') return
    sessionStorage.setItem('jarvis-login:greeted', '1')
    const timer = window.setTimeout(() => {
      try {
        window.speechSynthesis.cancel()
        const greeting = new SpeechSynthesisUtterance('Good to see you, Maheer. JARVIS is online. Authenticate by voice, or use recovery access.')
        greeting.rate = 0.96
        greeting.pitch = 0.88
        greeting.volume = 0.92
        window.speechSynthesis.speak(greeting)
      } catch { /* The visual authentication state remains usable without system speech. */ }
    }, 350)
    return () => window.clearTimeout(timer)
  }, [mode])

  if (state.isAuthenticated) {
    return <Navigate to={challenge && !challenge.enrolled ? '/settings' : '/'} replace />
  }

  const stopVoiceUnlock = async () => {
    if (!isRecording || !challenge) return
    setIsRecording(false)
    const capture = captureRef.current
    captureRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    const sampleRate = capture ? await capture.stop() : 48_000
    streamRef.current = null
    const chunks = chunksRef.current
    chunksRef.current = []
    const quality = assessVoiceCapture(chunks, sampleRate, {
      minDurationMs: 2_500,
      maxDurationMs: 12_000,
      minRms: 0.002,
      maxClippingRatio: 0.03,
    })
    if (!quality.ok) {
      setVoiceState(`Capture not sent · ${quality.message}`)
      return
    }
    setVoiceState(`Clear ${(quality.durationMs / 1_000).toFixed(1)}s capture · comparing voiceprint and challenge phrase locally`)
    try {
      const confidence = await voiceUnlock(encodeWav(chunks, sampleRate), challenge.challengeId)
      setVoiceState(`Identity confirmed · ${(confidence * 100).toFixed(0)}% voice confidence`)
    } catch (error) {
      const failure = (error as { response?: { data?: VoiceVerificationFailure }; message?: string })?.response?.data
      const reason = failure?.error ?? failure?.detail ?? (error as Error)?.message ?? 'voice verification failed'
      const confidence = typeof failure?.confidence === 'number' ? ` · confidence ${(failure.confidence * 100).toFixed(0)}%` : ''
      const heard = failure?.transcript?.trim() ? ` · heard “${failure.transcript.trim().slice(0, 96)}”` : ''
      const missingParts = [...(failure?.missingAnchors ?? []), ...(failure?.missingWords ?? [])]
      const missing = missingParts.length ? ` · repeat ${missingParts.join(', ')}` : ''
      const suggestion = failure?.suggestion ? ` · ${failure.suggestion}` : ''
      setVoiceState(`Identity rejected · ${reason}${confidence}${missing}${heard}${suggestion}`)
      await refreshChallenge()
    }
  }

  const startVoiceUnlock = async () => {
    if (isRecording) return void stopVoiceUnlock()
    if (!challenge?.enrolled) return setCredentialsOpen(true)
    try {
      // The voice orb is a trusted user gesture. Prime the shared local
      // playback route now so the post-login greeting is allowed to play
      // after the asynchronous verification request completes.
      await unlockAudioPlayback().catch(() => {})
      const stream = await openMicrophoneStream()
      chunksRef.current = []
      const capture = await createAudioCapture(stream, (chunk) => chunksRef.current.push(chunk))
      streamRef.current = stream
      captureRef.current = capture
      setIsRecording(true)
      const device = stream.getAudioTracks()[0]?.label
      setVoiceState(`Listening${device ? ` through ${device}` : ''} · speak the displayed phrase, then tap the core`)
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      const reason = error instanceof Error ? error.message : 'microphone permission is required'
      setVoiceState(`Microphone unavailable · ${reason}`)
    }
  }

  const handleLogin = (event: FormEvent) => {
    event.preventDefault()
    // Preserve the browser's user-activation grant across the route change.
    // Without this, Chromium can reject the greeting because authentication
    // finishes asynchronously after the submit gesture has expired.
    void unlockAudioPlayback().catch(() => {})
    void login(email, password)
  }
  const handleSetup = (event: FormEvent) => {
    event.preventDefault(); setValidationError(null)
    if (password !== confirmPassword) return setValidationError('Passwords do not match')
    if (password.length < 8) return setValidationError('Password must be at least 8 characters')
    void unlockAudioPlayback().catch(() => {})
    void setup(email, password, username || undefined)
  }
  const displayError = validationError ?? state.error
  const inputClass = 'w-full border-b border-cyan-300/20 bg-transparent px-1 py-2.5 text-sm text-cyan-50 outline-none placeholder:text-cyan-100/25 focus:border-cyan-300/70'

  if (mode === 'loading') return <div className="jarvis-login-shell"><div className="h-[420px] w-[520px]"><NeuralScene mode="PROCESSING" compact /></div><p className="jarvis-login-status">Initializing neural interface</p></div>

  if (mode === 'setup') return (
    <div className="jarvis-login-shell"><div className="jarvis-auth-grid max-w-5xl">
      <section className="jarvis-auth-hero"><div className="jarvis-auth-orb"><NeuralScene mode="ONLINE" /></div><p className="jarvis-kicker">J.A.R.V.I.S. // FIRST BOOT</p><h1>Establish operator identity</h1><p>Your administrator credential is the recovery key. Voice identity can be enrolled immediately after activation.</p></section>
      <form onSubmit={handleSetup} className="jarvis-auth-panel space-y-5"><div><p className="jarvis-kicker">Secure initialization</p><h2>Primary operator</h2></div><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="Email" /><input type="text" required value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} placeholder="Operator name" /><input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Recovery password" /><input type="password" required minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} placeholder="Confirm recovery password" />{displayError && <p className="jarvis-auth-error">{displayError}</p>}<button type="submit" disabled={state.isLoading} className="jarvis-primary-action">{state.isLoading ? 'Creating identity…' : 'Activate JARVIS'}</button></form>
    </div></div>
  )

  return (
    <div className="jarvis-login-shell">
      <div className="jarvis-login-grid" aria-hidden="true" />
      <div className="jarvis-auth-grid">
        {startupReport && ['failed', 'degraded'].includes(startupReport.status) && <div className="jarvis-startup-alert" role="status"><span>{startupReport.status === 'failed' ? 'STARTUP DEGRADED' : 'LOCAL SERVICES LIMITED'} // {startupReport.stage}</span><strong>{startupReport.message}</strong><small>Diagnostics: logs/startup-latest.log</small></div>}
        <section className="jarvis-auth-hero">
          <div className="jarvis-auth-orb" onClick={() => void startVoiceUnlock()} role="button" tabIndex={0} aria-label={isRecording ? 'Stop recording and verify voice' : 'Start voice authentication'}>
            <NeuralScene mode={isRecording ? 'LISTENING' : state.isLoading ? 'PROCESSING' : 'ONLINE'} />
            <div className={cn('jarvis-auth-mic', isRecording && 'is-listening')}>{isRecording ? <MicOff size={22} /> : <Mic size={22} />}</div>
          </div>
          <p className="jarvis-kicker">BIOMETRIC ACCESS // LOCAL NODE 01</p><h1>Good to see you, Maheer.</h1>
          <p className="jarvis-voice-state"><Waves size={14} /> {voiceState}</p>
          {state.error && !credentialsOpen && <p className="jarvis-auth-error mt-2" role="alert">{state.error}</p>}
          {challenge?.enrolled ? <div className="jarvis-challenge"><span>Voice challenge</span><strong>“{challenge.phrase}”</strong><small>Use a fresh recording: speak this phrase naturally, then tap the core again. An enrollment sample without the current phrase will be rejected.</small></div> : <div className="jarvis-challenge is-warning"><span>Enrollment status</span><strong>No verified voiceprint is available yet.</strong><small>Use the recovery credential, then enroll three clean samples from the command deck.</small></div>}
          <div className="jarvis-security-row"><span><Fingerprint size={14} /> Speaker encoder</span><span><ShieldCheck size={14} /> Challenge phrase</span><span>100% local</span></div>
        </section>
        <aside className="jarvis-auth-panel">
          <div className="flex items-center justify-between"><div><p className="jarvis-kicker">Fallback channel</p><h2>Recovery access</h2></div><KeyRound className="text-cyan-300/60" size={22} /></div>
          <p className="mt-3 text-xs leading-relaxed text-cyan-100/40">{challenge && !challenge.enrolled ? 'Sign in once with your recovery credential. JARVIS will open Voice Identity automatically so you can record three new samples.' : 'Credentials remain optional for daily use and available when your voiceprint, microphone, or local speech service needs recovery.'}</p>
          <button type="button" className="jarvis-secondary-action mt-5" onClick={() => setCredentialsOpen((value) => !value)}>{credentialsOpen ? 'Hide credentials' : 'Use credentials instead'}</button>
          <div className={cn('jarvis-credential-drawer', credentialsOpen && 'is-open')}><form onSubmit={handleLogin} className="space-y-5 pt-6"><input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="Administrator email" /><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="Recovery password" />{displayError && <p className="jarvis-auth-error">{displayError}</p>}<button type="submit" disabled={state.isLoading} className="jarvis-primary-action">{state.isLoading ? 'Authenticating…' : challenge && !challenge.enrolled ? 'Enter & enroll voice' : 'Enter neural workspace'}</button></form></div>
          <button type="button" onClick={() => void refreshChallenge()} className="mt-5 flex items-center gap-2 text-[10px] uppercase tracking-[.18em] text-cyan-200/45 hover:text-cyan-200"><RefreshCw size={12} /> Rotate voice challenge</button>
        </aside>
      </div>
    </div>
  )
}
