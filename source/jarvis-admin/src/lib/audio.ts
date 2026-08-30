export interface AudioCapture {
  context: AudioContext
  sampleRate: number
  stop: () => Promise<number>
}

export interface AudioLevel {
  rms: number
  bass: number
  mid: number
  treble: number
  timestamp: number
}

export interface AudioCaptureOptions {
  onLevel?: (level: AudioLevel) => void
}

export interface VoiceCaptureRequirements {
  minDurationMs: number
  maxDurationMs: number
  minRms: number
  maxClippingRatio?: number
}

export interface VoiceCaptureQuality {
  ok: boolean
  durationMs: number
  rms: number
  activeRms: number
  peak: number
  clippingRatio: number
  code?: 'recording_too_short' | 'recording_too_long' | 'recording_too_quiet' | 'recording_clipped' | 'empty_recording'
  message?: string
}

/**
 * Evaluate microphone PCM before sending it to STT or speaker recognition.
 * This keeps a bad local capture from consuming a one-time voice challenge.
 */
export function assessVoiceCapture(
  chunks: Float32Array[],
  sampleRate: number,
  requirements: VoiceCaptureRequirements,
): VoiceCaptureQuality {
  let samples = 0
  let squareSum = 0
  let peak = 0
  let clipped = 0
  const frameSize = Math.max(160, Math.round(sampleRate * 0.02))
  const frameEnergy: number[] = []
  let frameSquare = 0
  let frameSamples = 0
  for (const chunk of chunks) {
    samples += chunk.length
    for (const sample of chunk) {
      const absolute = Math.abs(sample)
      squareSum += sample * sample
      if (absolute > peak) peak = absolute
      if (absolute >= 0.995) clipped += 1
      frameSquare += sample * sample
      frameSamples += 1
      if (frameSamples >= frameSize) {
        frameEnergy.push(Math.sqrt(frameSquare / frameSamples))
        frameSquare = 0
        frameSamples = 0
      }
    }
  }
  if (frameSamples > 0) frameEnergy.push(Math.sqrt(frameSquare / frameSamples))
  const durationMs = sampleRate > 0 ? Math.round((samples / sampleRate) * 1_000) : 0
  const rms = samples ? Math.sqrt(squareSum / samples) : 0
  const clippingRatio = samples ? clipped / samples : 0
  const rankedFrames = frameEnergy.sort((left, right) => right - left)
  const activeCount = Math.max(1, Math.ceil(rankedFrames.length * 0.2))
  const activeRms = rankedFrames.slice(0, activeCount).reduce((sum, value) => sum + value, 0) / activeCount
  const base = { durationMs, rms, activeRms, peak, clippingRatio }
  if (!samples) return { ...base, ok: false, code: 'empty_recording', message: 'No microphone audio was captured. Check the selected input and retry.' }
  if (durationMs < requirements.minDurationMs) return { ...base, ok: false, code: 'recording_too_short', message: `Keep speaking for at least ${(requirements.minDurationMs / 1_000).toFixed(0)} seconds before submitting.` }
  if (durationMs > requirements.maxDurationMs) return { ...base, ok: false, code: 'recording_too_long', message: `Use one natural phrase under ${(requirements.maxDurationMs / 1_000).toFixed(0)} seconds.` }
  if (activeRms < requirements.minRms || peak < 0.002) return { ...base, ok: false, code: 'recording_too_quiet', message: 'No usable speech was detected. Check the active Windows input device and microphone level, then speak normally.' }
  if (clippingRatio > (requirements.maxClippingRatio ?? 0.03)) return { ...base, ok: false, code: 'recording_clipped', message: 'The microphone signal is distorted. Move slightly farther away and retry.' }
  return { ...base, ok: true }
}

const microphoneConstraints = (deviceId?: string): MediaStreamConstraints => ({
  audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
})

function microphoneScore(device: MediaDeviceInfo): number {
  const label = device.label.toLowerCase()
  let score = 0
  if (/realtek|microphone array|built-in|internal/.test(label)) score += 50
  if (/microphone|mic|headset/.test(label)) score += 20
  if (/droidcam|virtual|wireless controller|stereo mix/.test(label)) score -= 80
  if (device.deviceId === 'default') score -= 5
  return score
}

function friendlyMicrophoneError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('Windows blocked microphone access. Enable Microphone access and Let desktop apps access your microphone in Windows Privacy settings, then restart JARVIS.')
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error('No active microphone was found. Connect or enable your preferred microphone, then try again.')
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return new Error('The selected microphone is busy or unavailable. Close apps using the microphone and disconnect inactive DroidCam or controller inputs, then retry.')
  }
  if (name === 'OverconstrainedError') {
    return new Error('The selected microphone cannot use the requested capture format. JARVIS will retry with another input.')
  }
  return error instanceof Error ? error : new Error('Microphone access is unavailable in this desktop runtime.')
}

/**
 * Open a physical microphone reliably on Windows. Portable/virtual audio
 * devices can remain registered even when their source is disconnected, so a
 * successful-looking default route may be silent. Once permission exposes
 * labels, prefer the healthy physical input and retry exact device IDs when
 * the Windows default cannot be opened.
 */
export async function openMicrophoneStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This desktop runtime does not expose microphone capture. Restart the JARVIS desktop app.')
  }

  let firstError: unknown
  let initial: MediaStream | null = null
  try {
    initial = await navigator.mediaDevices.getUserMedia(microphoneConstraints())
    const initialLabel = initial.getAudioTracks()[0]?.label.toLowerCase() ?? ''
    if (!/droidcam|virtual|wireless controller/.test(initialLabel)) return initial
  } catch (error) {
    firstError = error
    if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
      throw friendlyMicrophoneError(error)
    }
  }

  let inputs: MediaDeviceInfo[] = []
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default')
      .sort((left, right) => microphoneScore(right) - microphoneScore(left))
  } catch {
    // The original getUserMedia error below is more useful than enumeration.
  }

  for (const input of inputs) {
    if (microphoneScore(input) < 0) continue
    try {
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(input.deviceId))
      initial?.getTracks().forEach((track) => track.stop())
      return stream
    } catch (error) {
      firstError ??= error
    }
  }

  if (initial) return initial
  throw friendlyMicrophoneError(firstError)
}

// Keep one renderer-scoped playback context alive after the operator's first
// click/keypress. Chromium can otherwise reject a later `audio.play()` call
// because the response arrives asynchronously after the original command
// gesture. This context is local-only and carries no microphone data.
let playbackContext: AudioContext | null = null

function getPlaybackContext(): AudioContext {
  if (!playbackContext) playbackContext = new window.AudioContext()
  return playbackContext
}

export async function unlockAudioPlayback(): Promise<void> {
  const context = getPlaybackContext()
  if (context.state === 'suspended') await context.resume()
  // A zero-gain oscillator establishes a user-activated audio route without
  // producing an audible click or sending anything outside the local device.
  const gain = context.createGain()
  gain.gain.value = 0
  gain.connect(context.destination)
  const oscillator = context.createOscillator()
  oscillator.connect(gain)
  oscillator.start()
  oscillator.stop(context.currentTime + 0.01)
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect()
    gain.disconnect()
  }, { once: true })
}

/**
 * Capture a mono microphone stream without the deprecated ScriptProcessorNode.
 * The worklet posts short PCM frames to the UI thread; the graph is connected
 * to a muted sink so Chromium keeps processing without feeding the microphone
 * back into the speakers.
 */
export async function createAudioCapture(
  stream: MediaStream,
  onChunk: (chunk: Float32Array) => void,
  options: AudioCaptureOptions = {},
): Promise<AudioCapture> {
  const AudioContextCtor = window.AudioContext
  const context = new AudioContextCtor()
  let stopped = false
  try {
    if (!context.audioWorklet) throw new Error('AudioWorklet is unavailable in this desktop runtime')
    // A same-origin static module keeps the strict dashboard CSP intact;
    // blob-backed worklets would require broadening script-src to `blob:`.
    await context.audioWorklet.addModule('/audio-capture-worklet.js')

    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.78
    source.connect(analyser)
    const node = new AudioWorkletNode(context, 'jarvis-microphone-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
    const sink = context.createGain()
    sink.gain.value = 0
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!stopped && event.data instanceof Float32Array) onChunk(new Float32Array(event.data))
    }
    source.connect(node)
    node.connect(sink)
    sink.connect(context.destination)
    await context.resume()

    const frequency = new Uint8Array(analyser.frequencyBinCount)
    const waveform = new Uint8Array(analyser.fftSize)
    let levelFrame = 0
    const publishLevel = () => {
      if (stopped) return
      if (!document.hidden && options.onLevel) {
        analyser.getByteTimeDomainData(waveform)
        analyser.getByteFrequencyData(frequency)
        let square = 0
        for (const value of waveform) {
          const normalized = (value - 128) / 128
          square += normalized * normalized
        }
        const band = (from: number, to: number) => {
          const start = Math.max(0, Math.floor(frequency.length * from))
          const end = Math.max(start + 1, Math.floor(frequency.length * to))
          let total = 0
          for (let i = start; i < Math.min(end, frequency.length); i += 1) total += frequency[i] / 255
          return total / Math.max(1, end - start)
        }
        options.onLevel({
          rms: Math.min(1, Math.sqrt(square / waveform.length) * 2.2),
          bass: band(0, 0.12),
          mid: band(0.12, 0.45),
          treble: band(0.45, 1),
          timestamp: performance.now(),
        })
      }
      levelFrame = window.requestAnimationFrame(publishLevel)
    }
    if (options.onLevel) levelFrame = window.requestAnimationFrame(publishLevel)

    return {
      context,
      sampleRate: context.sampleRate,
      stop: async () => {
        if (stopped) return context.sampleRate
        stopped = true
        const rate = context.sampleRate
        if (levelFrame) window.cancelAnimationFrame(levelFrame)
        node.port.onmessage = null
        source.disconnect()
        analyser.disconnect()
        node.disconnect()
        sink.disconnect()
        if (context.state !== 'closed') await context.close()
        return rate
      },
    }
  } catch (error) {
    if (context.state !== 'closed') await context.close().catch(() => {})
    throw error
  }
}

export interface AudioPlaybackHandle {
  finished: Promise<void>
  stop: () => void
}

/**
 * Play a local WAV blob through the already-unlocked Web Audio route. This is
 * a fallback for Chromium builds that return a valid blob from the TTS API
 * but reject an asynchronously-created HTMLAudioElement because of autoplay
 * policy. No network or media URL is involved in this path.
 */
export async function playAudioBlobWithWebAudio(
  blob: Blob,
  onLevel?: (level: AudioLevel) => void,
): Promise<AudioPlaybackHandle> {
  const context = getPlaybackContext()
  if (context.state === 'suspended') await context.resume()
  if (context.state !== 'running') throw new Error('Local audio output is suspended')

  const bytes = await blob.arrayBuffer()
  const buffer = await context.decodeAudioData(bytes.slice(0))
  const source = context.createBufferSource()
  const analyser = context.createAnalyser()
  const gain = context.createGain()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.8
  source.buffer = buffer
  source.connect(analyser)
  analyser.connect(gain)
  gain.connect(context.destination)

  const frequency = new Uint8Array(analyser.frequencyBinCount)
  const waveform = new Uint8Array(analyser.fftSize)
  let stopped = false
  let frame = 0
  let resolveFinished: (() => void) | null = null
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve })
  const band = (from: number, to: number) => {
    const start = Math.floor(frequency.length * from)
    const end = Math.max(start + 1, Math.floor(frequency.length * to))
    let total = 0
    for (let index = start; index < Math.min(end, frequency.length); index += 1) total += frequency[index] / 255
    return total / Math.max(1, end - start)
  }
  const tick = () => {
    if (stopped) return
    if (!document.hidden && onLevel) {
      analyser.getByteTimeDomainData(waveform)
      analyser.getByteFrequencyData(frequency)
      let square = 0
      for (const value of waveform) {
        const normalized = (value - 128) / 128
        square += normalized * normalized
      }
      onLevel({
        rms: Math.min(1, Math.sqrt(square / waveform.length) * 2.2),
        bass: band(0, 0.12),
        mid: band(0.12, 0.45),
        treble: band(0.45, 1),
        timestamp: performance.now(),
      })
    }
    frame = window.requestAnimationFrame(tick)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (frame) window.cancelAnimationFrame(frame)
    try { source.stop() } catch { /* already ended */ }
    source.disconnect()
    analyser.disconnect()
    gain.disconnect()
    onLevel?.({ rms: 0, bass: 0, mid: 0, treble: 0, timestamp: performance.now() })
    resolveFinished?.()
    resolveFinished = null
  }
  source.addEventListener('ended', stop, { once: true })
  source.start()
  if (onLevel) frame = window.requestAnimationFrame(tick)
  return { finished, stop }
}

export function encodeWav(chunks: Float32Array[], inputRate: number): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }

  // Windows microphone arrays frequently expose a clean but low-amplitude
  // signal. Apply bounded peak/RMS normalization locally so Whisper and the
  // speaker encoder receive usable PCM without turning digital silence into
  // speech or clipping a healthy recording.
  let squareSum = 0
  let peak = 0
  for (const sample of merged) {
    squareSum += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  const rms = Math.sqrt(squareSum / Math.max(1, merged.length))
  const gain = peak >= 0.002
    ? Math.max(1, Math.min(12, 0.85 / Math.max(peak, 0.0001), 0.05 / Math.max(rms, 0.0001)))
    : 1

  const outputRate = 16_000
  const ratio = inputRate / outputRate
  const length = Math.max(1, Math.floor(merged.length / ratio))
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio))
    let sample = 0
    for (let j = start; j < end; j += 1) sample += merged[j]
    sample = (sample / Math.max(1, end - start)) * gain
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff
  }

  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const write = (pos: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(pos + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, outputRate, true)
  view.setUint32(28, outputRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  pcm.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true))
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Attach a real Web Audio analyser to a local TTS element. */
export function monitorAudioElement(
  audio: HTMLAudioElement,
  onLevel: (level: AudioLevel) => void,
): () => void {
  const context = getPlaybackContext()
  // A suspended analyser would route the media element through a silent
  // AudioContext and make an otherwise valid WAV appear to play with no
  // sound. In that case leave the element on its native output path; the
  // visual meter can recover on the next user-activated response.
  if (context.state !== 'running') return () => {}
  const source = context.createMediaElementSource(audio)
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.8
  source.connect(analyser)
  analyser.connect(context.destination)
  const frequency = new Uint8Array(analyser.frequencyBinCount)
  const waveform = new Uint8Array(analyser.fftSize)
  let stopped = false
  let frame = 0
  const band = (from: number, to: number) => {
    const start = Math.floor(frequency.length * from)
    const end = Math.max(start + 1, Math.floor(frequency.length * to))
    let total = 0
    for (let i = start; i < Math.min(end, frequency.length); i += 1) total += frequency[i] / 255
    return total / Math.max(1, end - start)
  }
  const tick = () => {
    if (stopped) return
    analyser.getByteTimeDomainData(waveform)
    analyser.getByteFrequencyData(frequency)
    let square = 0
    for (const value of waveform) {
      const normalized = (value - 128) / 128
      square += normalized * normalized
    }
    onLevel({
      rms: Math.min(1, Math.sqrt(square / waveform.length) * 2.2),
      bass: band(0, 0.12),
      mid: band(0.12, 0.45),
      treble: band(0.45, 1),
      timestamp: performance.now(),
    })
    frame = window.requestAnimationFrame(tick)
  }
  void context.resume().catch(() => {})
  frame = window.requestAnimationFrame(tick)
  return () => {
    if (stopped) return
    stopped = true
    window.cancelAnimationFrame(frame)
    source.disconnect()
    analyser.disconnect()
    onLevel({ rms: 0, bass: 0, mid: 0, treble: 0, timestamp: performance.now() })
    // The shared playback context is intentionally kept alive so another
    // response can start without falling back into the autoplay policy gate.
  }
}
