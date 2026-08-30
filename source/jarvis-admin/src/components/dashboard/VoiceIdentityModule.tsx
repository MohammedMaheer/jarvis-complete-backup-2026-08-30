import { useEffect, useRef, useState } from 'react'
import { Fingerprint, Mic, MicOff, ShieldCheck, Waves } from 'lucide-react'
import { toast } from 'sonner'
import { enrollVoiceProfile, getVoiceProfile } from '@/api/assistant'
import { assessVoiceCapture, createAudioCapture, encodeWav, openMicrophoneStream, type AudioCapture } from '@/lib/audio'
import { cn } from '@/lib/utils'

const samplePhrases = [
  'Jarvis, this is Maheer. Initialize my private neural interface.',
  'My voice authorizes this local workstation and no external service.',
  'Jarvis, recognize my voice and prepare the engineering workspace.',
]

export default function VoiceIdentityModule() {
  const [samples, setSamples] = useState(0)
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const chunksRef = useRef<Float32Array[]>([])

  useEffect(() => {
    void getVoiceProfile().then((profile) => setSamples(profile.sample_count)).catch(() => {})
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      void captureRef.current?.stop()
    }
  }, [])

  const toggle = async () => {
    if (recording) {
      setRecording(false); setSaving(true)
      const capture = captureRef.current
      captureRef.current = null
      streamRef.current?.getTracks().forEach((track) => track.stop())
      const sampleRate = capture ? await capture.stop() : 48_000
      const chunks = chunksRef.current
      chunksRef.current = []
      try {
        const quality = assessVoiceCapture(chunks, sampleRate, {
          minDurationMs: 4_000,
          maxDurationMs: 12_000,
          minRms: 0.0025,
          maxClippingRatio: 0.03,
        })
        if (!quality.ok) throw new Error(quality.message ?? 'Record a clear 4-8 second voice sample')
        const result = await enrollVoiceProfile(encodeWav(chunks, sampleRate))
        setSamples(result.total_samples)
        toast.success(`Voiceprint sample ${result.total_samples} secured locally · ${(quality.durationMs / 1_000).toFixed(1)}s clear capture`)
      } catch (error) { toast.error(error instanceof Error ? error.message : 'Voice enrollment failed') }
      finally { setSaving(false); streamRef.current = null }
      return
    }
    try {
      const stream = await openMicrophoneStream()
      chunksRef.current = []
      const capture = await createAudioCapture(stream, (chunk) => chunksRef.current.push(chunk))
      streamRef.current = stream; captureRef.current = capture; setRecording(true)
      const device = stream.getAudioTracks()[0]?.label
      if (device) toast.message(`Recording from ${device}`)
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      toast.error(error instanceof Error ? error.message : 'Microphone access is required to enroll your voice')
    }
  }

  const complete = samples >= 3
  return (
    <section className="jarvis-identity-module">
      <div className="jarvis-identity-icon"><Fingerprint size={28} /><span /></div>
      <div className="min-w-0 flex-1"><p className="jarvis-kicker">Operator biometric // Maheer</p><div className="mt-1 flex flex-wrap items-center gap-3"><h2 className="text-lg font-light text-cyan-50">Voice identity matrix</h2><span className={cn('rounded-full border px-2 py-1 text-[8px] uppercase tracking-widest', complete ? 'border-emerald-300/20 text-emerald-300' : 'border-amber-300/20 text-amber-300')}>{complete ? 'Voiceprint ready' : `${samples}/3 samples`}</span></div><p className="mt-2 text-xs text-cyan-100/40">{recording ? `${samplePhrases[Math.min(samples, 2)]} Keep speaking clearly for 4-8 seconds.` : complete ? 'Your quality-checked multi-sample voiceprint is ready for challenge-response login.' : 'Record three clear 4-8 second phrases in your normal voice. Quiet, clipped, and short samples are rejected automatically.'}</p><div className="mt-3 flex gap-1">{[0,1,2].map((index) => <span key={index} className={cn('h-1 flex-1 rounded-full', index < samples ? 'bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,.45)]' : recording && index === samples ? 'animate-pulse bg-rose-300' : 'bg-cyan-300/10')} />)}</div></div>
      <button type="button" onClick={() => void toggle()} disabled={saving || complete} className={cn('jarvis-identity-record', recording && 'is-recording')}><span>{saving ? 'Encoding' : recording ? 'Secure sample' : complete ? 'Enrolled' : 'Record sample'}</span>{recording ? <MicOff size={18} /> : complete ? <ShieldCheck size={18} /> : <Mic size={18} />}{recording && <Waves size={14} />}</button>
    </section>
  )
}
