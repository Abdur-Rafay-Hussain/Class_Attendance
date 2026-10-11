'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  AudioLines,
  Camera,
  CheckCircle2,
  Loader2,
  Mic,
  ShieldCheck,
  Server,
  XCircle,
} from 'lucide-react'
import { GlassCard } from '@/components/attendance/glass-card'
import { FaceCapture } from '@/components/attendance/student/face-capture'
import { AudioVisualizer } from '@/components/attendance/student/audio-visualizer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError, enrollInCourse, markAttendance } from '@/lib/api'
import {
  BEACON_BAND_HIGH_HZ,
  BEACON_BAND_LOW_HZ,
  BEACON_LABEL,
  FACE_SNAPSHOT_COUNT,
} from '@/lib/attendance'
import { cn } from '@/lib/utils'

// The backend decodes the session code from the recording. One full repeat of the code takes about 8.25 seconds
// (see gen_audio.py: marker, then 13 digits with 0.3 s gaps) and a recording may start in the middle of a repeat,
// so 30 seconds guarantees at least two complete repeats. The WAV file stays far below the 5 MB upload limit.
const CAPTURE_MS = 30_000
// The backend only accepts 16-bit PCM WAV audio recorded at exactly 44100 Hz.
const TARGET_SAMPLE_RATE = 44_100

// Used only by the "what this phone heard" report. They must match BASE_FREQUENCY, FREQUENCY_STEP and
// MARKER_FREQUENCY in the backend gen_audio.py.
const BEACON_BASE_HZ = 4_000
const BEACON_STEP_HZ = 40
const BEACON_MARKER_HZ = 4_700

type Phase = 'idle' | 'listening' | 'processing' | 'camera' | 'submitting' | 'success' | 'failure'

interface CheckInResult {
  time: string
  title: string
  message: string
  /** Report of what the phone's recording contained (only shown when the server could not decode the audio). */
  details?: string
}

// ============================================================
// AUDIO RECORDING
// ============================================================

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(channel.slice(0))
    return true
  }
}
registerProcessor('capture-processor', CaptureProcessor)
`

interface Recorder {
  analyser: AnalyserNode
  sampleRate: number
  /** Stops recording and returns every captured sample. */
  stop: () => Float32Array
  close: () => void
}

async function createRecorder(media: MediaStream): Promise<Recorder> {
  const AudioContextClass =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) throw new Error('This browser cannot record audio.')

  let lastError: unknown = null

  // First try a 44100 Hz context (what the backend needs). Some browsers refuse to connect a microphone
  // running at another rate to it, so fall back to the device rate and convert afterwards.
  for (const preferredRate of [TARGET_SAMPLE_RATE, undefined]) {
    let context: AudioContext | null = null
    try {
      context = preferredRate ? new AudioContextClass({ sampleRate: preferredRate }) : new AudioContextClass()
      if (!context.audioWorklet) throw new Error('This browser does not support AudioWorklet audio capture.')
      await context.resume()

      const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await context.audioWorklet.addModule(moduleUrl)
      } finally {
        URL.revokeObjectURL(moduleUrl)
      }

      const source = context.createMediaStreamSource(media)
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      const worklet = new AudioWorkletNode(context, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      // Silent output so the browser keeps pulling audio through the capture node without playing it back.
      const mute = context.createGain()
      mute.gain.value = 0

      const chunks: Float32Array[] = []
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        chunks.push(event.data)
      }

      source.connect(analyser)
      source.connect(worklet)
      worklet.connect(mute)
      mute.connect(context.destination)

      const activeContext = context
      return {
        analyser,
        sampleRate: activeContext.sampleRate,
        stop: () => {
          worklet.port.onmessage = null
          try {
            source.disconnect()
            worklet.disconnect()
            mute.disconnect()
          } catch {
            // Already disconnected.
          }
          const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          const samples = new Float32Array(total)
          let offset = 0
          for (const chunk of chunks) {
            samples.set(chunk, offset)
            offset += chunk.length
          }
          return samples
        },
        close: () => {
          activeContext.close().catch(() => {})
        },
      }
    } catch (error) {
      lastError = error
      context?.close().catch(() => {})
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Could not start audio capture.')
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const i0 = Math.floor(position)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const fraction = position - i0
    output[i] = input[i0] * (1 - fraction) + input[i1] * fraction
  }
  return output
}

async function resampleTo44100(input: Float32Array, from: number): Promise<Float32Array> {
  if (from === TARGET_SAMPLE_RATE) return input
  try {
    const buffer = new AudioBuffer({ length: input.length, numberOfChannels: 1, sampleRate: from })
    buffer.copyToChannel(new Float32Array(input), 0)
    const offline = new OfflineAudioContext(1, Math.ceil((input.length * TARGET_SAMPLE_RATE) / from), TARGET_SAMPLE_RATE)
    const node = offline.createBufferSource()
    node.buffer = buffer
    node.connect(offline.destination)
    node.start()
    const rendered = await offline.startRendering()
    return new Float32Array(rendered.getChannelData(0))
  } catch {
    return resampleLinear(input, from, TARGET_SAMPLE_RATE)
  }
}

/**
 * Keeps only the frequency band where the beacon tones are and removes the noise outside of it, so the backend
 * can still separate the tones from the silence between them when the signal is weak or the room is noisy.
 * Two cascaded band-pass filters. The band comes from lib/attendance.ts.
 */
function bandPassBeacon(input: Float32Array, sampleRate: number): Float32Array {
  const f0 = Math.sqrt(BEACON_BAND_LOW_HZ * BEACON_BAND_HIGH_HZ)
  const octaves = Math.log2(BEACON_BAND_HIGH_HZ / BEACON_BAND_LOW_HZ)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const sin = Math.sin(w0)
  const cos = Math.cos(w0)
  const alpha = sin * Math.sinh(((Math.LN2 / 2) * octaves * w0) / sin)
  const a0 = 1 + alpha
  const b0 = alpha / a0
  const b2 = -alpha / a0
  const a1 = (-2 * cos) / a0
  const a2 = (1 - alpha) / a0

  let data = input
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(data.length)
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < data.length; i++) {
      const x0 = data[i]
      const y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2
      out[i] = y0
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
    }
    data = out
  }
  return data
}

/**
 * Microphones can record the beacon quietly, and the backend ignores anything below a fixed volume. This raises
 * the volume of the (already band-filtered) real recording, never above full scale and never lowering it.
 */
function applyGain(samples: Float32Array): Float32Array {
  let rawPeak = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i])
    if (value > rawPeak) rawPeak = value
  }
  if (rawPeak === 0) return samples

  const magnitudes = samples.map((v) => Math.abs(v))
  magnitudes.sort()
  const level = magnitudes[Math.floor((magnitudes.length - 1) * 0.995)]
  if (!(level > 1e-5)) return samples

  const gain = Math.max(1, Math.min(0.5 / level, 0.95 / rawPeak, 60))
  if (gain === 1) return samples

  const output = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) output[i] = samples[i] * gain
  return output
}

function writeText(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 16-bit PCM, mono, 44100 Hz WAV file — the only format the backend accepts. */
function encodeWav(samples: Float32Array): Blob {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeText(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(view, 8, 'WAVE')
  writeText(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function prepareWav(raw: Float32Array, sampleRate: number): Promise<{ blob: Blob; samples: Float32Array }> {
  const resampled = await resampleTo44100(raw, sampleRate)
  const filtered = bandPassBeacon(resampled, TARGET_SAMPLE_RATE)
  const samples = applyGain(filtered)
  return { blob: encodeWav(samples), samples }
}

// ============================================================
// "WHAT THIS PHONE HEARD" REPORT
// ============================================================

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    const half = len / 2
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < half; j++) {
        const a = i + j
        const b = a + half
        const vr = re[b] * cr - im[b] * ci
        const vi = re[b] * ci + im[b] * cr
        re[b] = re[a] - vr
        im[b] = im[a] - vi
        re[a] += vr
        im[a] += vi
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
}

function dominantFrequency(samples: Float32Array, start: number, end: number): number {
  const n = end - start
  let size = 1024
  while (size < n) size <<= 1
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let mean = 0
  for (let i = 0; i < n; i++) mean += samples[start + i]
  mean /= n
  for (let i = 0; i < n; i++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    re[i] = (samples[start + i] - mean) * window
  }
  fft(re, im)
  let best = 1
  let bestPower = -1
  for (let k = 1; k < size / 2; k++) {
    const power = re[k] * re[k] + im[k] * im[k]
    if (power > bestPower) {
      bestPower = power
      best = k
    }
  }
  return (best * TARGET_SAMPLE_RATE) / size
}

/**
 * Follows the same steps as the backend decoder (50 ms frames, loud/quiet split, strongest frequency of each sound
 * piece, markers and digits) and describes what it found, so a failed decode can be understood.
 */
function analyzeBeacon(samples: Float32Array): string {
  const rate = TARGET_SAMPLE_RATE
  const frameSize = Math.floor(rate * 0.05)
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]) * 32767)
  const threshold = Math.max(500, peak * 0.08)

  const segments: [number, number][] = []
  let start = -1
  let lastEnd = 0
  for (let s = 0; s + frameSize <= samples.length; s += frameSize) {
    let sum = 0
    for (let i = s; i < s + frameSize; i++) {
      const v = samples[i] * 32767
      sum += v * v
    }
    lastEnd = s + frameSize
    if (Math.sqrt(sum / frameSize) > threshold) {
      if (start < 0) start = s
    } else if (start >= 0) {
      segments.push([start, s])
      start = -1
    }
  }
  if (start >= 0) segments.push([start, lastEnd])

  const groups: string[] = []
  let digits: string[] = []
  const heard: string[] = []
  let markers = 0
  let digitTones = 0
  let unknown = 0
  let tooShort = 0

  for (const [s, e] of segments) {
    if (e - s < rate * 0.08) {
      tooShort++
      continue
    }
    const frequency = dominantFrequency(samples, s, e)
    const ms = Math.round(((e - s) / rate) * 1000)
    if (Math.abs(frequency - BEACON_MARKER_HZ) < 100) {
      if (digits.length) groups.push(digits.join(''))
      digits = []
      markers++
      heard.push(`M${Math.round(frequency)}(${ms}ms)`)
      continue
    }
    const digit = Math.round((frequency - BEACON_BASE_HZ) / BEACON_STEP_HZ)
    const expected = BEACON_BASE_HZ + digit * BEACON_STEP_HZ
    if (digit >= 0 && digit <= 9 && Math.abs(frequency - expected) < 25) {
      digits.push(String(digit))
      digitTones++
      heard.push(String(digit))
    } else {
      unknown++
      heard.push(`?${Math.round(frequency)}(${ms}ms)`)
    }
  }
  if (digits.length) groups.push(digits.join(''))

  const counts = new Map<string, number>()
  for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)

  return [
    `Recording: ${(samples.length / rate).toFixed(1)} s, ${segments.length} sound pieces found`,
    `Markers: ${markers}, digit tones: ${digitTones}, unrecognised: ${unknown}, too short: ${tooShort}`,
    `Sequence: ${heard.slice(0, 60).join(' ')}${heard.length > 60 ? ' …' : ''}`,
    groups.length
      ? `Groups (expected 13 digits each, the same group at least 2 times): ${ranked.map(([group, count]) => `${group} x${count}`).join(' | ')}`
      : 'No digit groups were found.',
  ].join('\n')
}

async function acquireMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone is not available. Open this app on http://localhost or over HTTPS.')
  }
  return navigator.mediaDevices.getUserMedia({
    video: false,
    // Echo cancellation, noise suppression and automatic gain can remove or distort the beacon tones, so they are off.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } },
  })
}

function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was denied. Allow the microphone in the browser address bar and try again.'
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No microphone was found on this device.'
      case 'NotReadableError':
        return 'The microphone is being used by another application.'
    }
  }
  return error instanceof Error ? error.message : 'Could not start the microphone.'
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ============================================================
// COMPONENT
// ============================================================

export function StudentCheckIn({ userName }: { userName: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [progress, setProgress] = useState(0)
  const [recorded, setRecorded] = useState(false)
  const [faceDone, setFaceDone] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [result, setResult] = useState<CheckInResult | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const wavRef = useRef<Blob | null>(null)
  const processedRef = useRef<Float32Array | null>(null)
  const runRef = useRef(0)

  const releaseMedia = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current?.close()
    recorderRef.current = null
    setAnalyser(null)
  }, [])

  useEffect(
    () => () => {
      runRef.current += 1
      releaseMedia()
    },
    [releaseMedia],
  )

  function fail(title: string, message: string, details?: string) {
    releaseMedia()
    setResult({ time: nowLabel(), title, message, details })
    setPhase('failure')
  }

  // Step 1 finished: the beacon recording is ready. The camera opens automatically next.
  async function finishListening(runId: number) {
    const isCurrent = () => runRef.current === runId
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    setProgress(1)
    setPhase('processing')

    const recorder = recorderRef.current
    const raw = recorder ? recorder.stop() : new Float32Array(0)
    const sampleRate = recorder?.sampleRate ?? TARGET_SAMPLE_RATE
    recorder?.close()
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setAnalyser(null)

    if (raw.length < sampleRate * 2) {
      fail('Microphone problem', 'No audio was recorded from the microphone. Check the microphone and try again.')
      return
    }

    let prepared: { blob: Blob; samples: Float32Array }
    try {
      prepared = await prepareWav(raw, sampleRate)
    } catch {
      if (isCurrent()) fail('Audio problem', 'The recording could not be prepared for upload. Please try again.')
      return
    }
    if (!isCurrent()) return

    wavRef.current = prepared.blob
    processedRef.current = prepared.samples
    setRecorded(true)
    setPhase('camera')
  }

  // Step 2 finished: the camera took 3 live photos. Send the audio and the photos together.
  async function handleFaceCaptured(images: Blob[]) {
    const runId = runRef.current
    const wav = wavRef.current
    if (!wav) {
      fail('Audio problem', 'The beacon recording is missing. Please try again.')
      return
    }
    setFaceDone(true)
    setPhase('submitting')

    try {
      const response = await markAttendance(wav, images)
      if (runRef.current !== runId) return
      setSubmitted(true)

      if (response.alreadyProcessed) {
        const saved = response.status ?? 'recorded'
        setResult({
          time: nowLabel(),
          title: 'Already checked in',
          message: `Your attendance for this session is already saved as ${saved}.${response.reason ? ` ${response.reason}` : ''}`,
        })
        setPhase(response.status === 'PRESENT' ? 'success' : 'failure')
      } else if (response.faceMatched) {
        setResult({
          time: nowLabel(),
          title: 'Face verified',
          message:
            'Your face matched and your check-in was sent to the attendance agent. Your teacher’s dashboard shows the final status.',
        })
        setPhase('success')
      } else {
        setResult({
          time: nowLabel(),
          title: 'Face did not match',
          message:
            'Your face did not match the registered face. The result was sent to the attendance agent and may be flagged.',
        })
        setPhase('failure')
      }
    } catch (error) {
      if (runRef.current !== runId) return
      const message =
        error instanceof ApiError ? error.message : 'Something went wrong while contacting the server.'

      // When the server could not read the audio, also show what this phone's recording contained.
      let details: string | undefined
      const audioProblem = error instanceof ApiError && error.status === 400 && /audio|session id/i.test(error.message)
      if (audioProblem && processedRef.current) {
        try {
          details = analyzeBeacon(processedRef.current)
        } catch {
          details = undefined
        }
      }
      fail('Verification failed', message, details)
    }
  }

  function handleFaceError(message: string) {
    fail('Camera problem', message)
  }

  async function startListening() {
    releaseMedia()
    const runId = ++runRef.current
    const isCurrent = () => runRef.current === runId

    wavRef.current = null
    processedRef.current = null
    setResult(null)
    setProgress(0)
    setRecorded(false)
    setFaceDone(false)
    setSubmitted(false)
    setPhase('listening')

    let media: MediaStream
    try {
      media = await acquireMicrophone()
    } catch (error) {
      if (isCurrent()) fail('Microphone problem', describeMediaError(error))
      return
    }
    if (!isCurrent()) {
      media.getTracks().forEach((track) => track.stop())
      return
    }
    streamRef.current = media

    let recorder: Recorder
    try {
      recorder = await createRecorder(media)
    } catch (error) {
      if (isCurrent()) fail('Microphone problem', describeMediaError(error))
      return
    }
    if (!isCurrent()) {
      recorder.close()
      return
    }
    recorderRef.current = recorder
    setAnalyser(recorder.analyser)

    const startedAt = performance.now()
    let finishing = false
    timerRef.current = setInterval(() => {
      if (!isCurrent()) return
      const ratio = Math.min(1, (performance.now() - startedAt) / CAPTURE_MS)
      setProgress(ratio)
      if (ratio >= 1 && !finishing) {
        finishing = true
        void finishListening(runId)
      }
    }, 100)
  }

  function reset() {
    wavRef.current = null
    processedRef.current = null
    setPhase('idle')
    setResult(null)
    setProgress(0)
    setRecorded(false)
    setFaceDone(false)
    setSubmitted(false)
  }

  const busy = phase === 'listening' || phase === 'processing' || phase === 'camera' || phase === 'submitting'
  const secondsLeft = Math.ceil((1 - progress) * (CAPTURE_MS / 1000))
  const tone = phase === 'listening' ? 'primary' : phase === 'success' ? 'success' : phase === 'failure' ? 'destructive' : 'muted'

  const status = {
    idle: { label: 'Ready to verify', hint: 'Press the button while the teacher’s attendance beep is playing.' },
    listening: { label: 'Listening for beacon…', hint: `Keep still. Listening for the ${BEACON_LABEL} classroom beacon.` },
    processing: { label: 'Processing recording…', hint: 'Preparing the audio for the server.' },
    camera: { label: 'Camera is taking photos…', hint: `Look at the camera. ${FACE_SNAPSHOT_COUNT} photos are taken automatically.` },
    submitting: { label: 'Verifying with server…', hint: 'Sending your recording and face photos.' },
    success: { label: 'Done', hint: '' },
    failure: { label: 'Not completed', hint: '' },
  }[phase]

  const steps = [
    { icon: AudioLines, label: 'Beacon', done: recorded },
    { icon: Camera, label: 'Face', done: faceDone },
    { icon: Server, label: 'Server', done: submitted },
  ]

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-center">
        <p className="text-sm text-muted-foreground">Hi {userName.split(' ')[0]},</p>
        <h1 className="mt-1 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Verify your attendance</h1>
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <AudioLines className="size-3.5 text-primary" aria-hidden="true" />
          Beacon {BEACON_LABEL}
        </p>
      </motion.div>

      <GlassCard lift={false} className="overflow-hidden p-4 sm:p-5" labelledBy="checkin-title">
        <h2 id="checkin-title" className="sr-only">
          Attendance verification
        </h2>

        {phase === 'camera' ? (
          <FaceCapture onCaptured={handleFaceCaptured} onError={handleFaceError} />
        ) : (
          <>
            <div className="relative flex aspect-[4/3] flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl border border-white/5 bg-black/30 px-4">
              {phase === 'listening' || phase === 'processing' ? (
                <>
                  <div className="relative flex size-20 items-center justify-center">
                    {phase === 'listening' &&
                      [0, 1].map((ring) => (
                        <motion.span
                          key={ring}
                          aria-hidden="true"
                          className="absolute size-20 rounded-full border border-primary/50"
                          animate={{ scale: [1, 1.8], opacity: [0.6, 0] }}
                          transition={{ duration: 2, repeat: Infinity, delay: ring, ease: 'easeOut' }}
                        />
                      ))}
                    <span className="relative flex size-16 items-center justify-center rounded-full bg-primary/15 text-primary">
                      {phase === 'processing' ? (
                        <Loader2 className="size-7 animate-spin" aria-hidden="true" />
                      ) : (
                        <Mic className="size-7" aria-hidden="true" />
                      )}
                    </span>
                  </div>
                  <p className="font-mono text-4xl font-semibold tabular-nums tracking-tight">
                    {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
                  </p>
                  <div className="w-full">
                    <AudioVisualizer analyser={analyser} active={phase === 'listening'} tone={tone} />
                  </div>
                </>
              ) : phase === 'submitting' ? (
                <>
                  <Loader2 className="size-9 animate-spin text-primary" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">Verifying with the server…</p>
                </>
              ) : (
                <>
                  <span className="flex size-16 items-center justify-center rounded-full border border-white/10 bg-white/5 text-muted-foreground">
                    <AudioLines className="size-7" aria-hidden="true" />
                  </span>
                  <p className="max-w-xs text-center text-sm text-muted-foreground">
                    First the app listens to the classroom beacon. Then the camera opens by itself and takes{' '}
                    {FACE_SNAPSHOT_COUNT} photos.
                  </p>
                </>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between gap-3 px-1">
              <AnimatePresence mode="wait">
                <motion.div
                  key={phase}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.25 }}
                  className="min-w-0"
                  aria-live="polite"
                >
                  <p className={cn('flex items-center gap-2 text-sm font-semibold', busy ? 'text-primary' : 'text-foreground')}>
                    {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                    {status.label}
                  </p>
                  {status.hint && <p className="truncate text-xs text-muted-foreground">{status.hint}</p>}
                </motion.div>
              </AnimatePresence>
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <Mic className={cn('size-3.5', analyser && 'text-primary')} aria-hidden="true" />
                {analyser ? 'Mic live' : 'Mic off'}
              </span>
            </div>

            <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-primary to-violet transition-[width] duration-100 ease-linear"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </>
        )}

        <ol className="mt-4 grid grid-cols-3 gap-2">
          {steps.map(({ icon: Icon, label, done }) => (
            <li
              key={label}
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-xs transition-colors duration-300',
                done ? 'border-success/30 bg-success/10 text-success' : 'border-white/5 bg-white/[0.02] text-muted-foreground',
              )}
            >
              {done ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <Icon className="size-3.5" aria-hidden="true" />}
              {label}
            </li>
          ))}
        </ol>

        <motion.button
          type="button"
          onClick={startListening}
          disabled={busy}
          whileHover={busy ? undefined : { scale: 1.015 }}
          whileTap={busy ? undefined : { scale: 0.98 }}
          className="relative mt-5 flex h-14 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-primary to-violet text-base font-semibold text-primary-foreground shadow-[0_0_40px_-8px] shadow-primary/80 outline-none focus-visible:ring-4 focus-visible:ring-primary/40 disabled:cursor-wait disabled:opacity-70"
        >
          {!busy && (
            <motion.span
              aria-hidden="true"
              className="absolute inset-y-0 w-1/3 -skew-x-12 bg-white/25 blur-md"
              animate={{ x: ['-150%', '400%'] }}
              transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut', repeatDelay: 1 }}
            />
          )}
          {busy ? (
            <Loader2 className="relative size-5 animate-spin" aria-hidden="true" />
          ) : (
            <ShieldCheck className="relative size-5" aria-hidden="true" />
          )}
          <span className="relative">
            {phase === 'listening'
              ? `Listening… ${secondsLeft}s`
              : phase === 'processing'
                ? 'Processing recording…'
                : phase === 'camera'
                  ? 'Taking photos…'
                  : phase === 'submitting'
                    ? 'Verifying with server…'
                    : 'Verify Attendance'}
          </span>
        </motion.button>

        <ResultOverlay phase={phase} result={result} onRetry={startListening} onDone={reset} />
      </GlassCard>

      <EnrollCard />
    </div>
  )
}

// ============================================================
// COURSE ENROLLMENT (POST /enroll)
// ============================================================

function EnrollCard() {
  const [courseId, setCourseId] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setMessage(null)
    setPending(true)
    try {
      const response = await enrollInCourse(courseId.trim())
      setMessage({ ok: true, text: response.message ?? 'Enrollment successful.' })
      setCourseId('')
    } catch (error) {
      setMessage({ ok: false, text: error instanceof ApiError ? error.message : 'Could not enroll. Please try again.' })
    } finally {
      setPending(false)
    }
  }

  return (
    <GlassCard lift={false} className="p-4 sm:p-5" labelledBy="enroll-title">
      <h2 id="enroll-title" className="text-sm font-semibold tracking-tight">
        Join a course
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        You must be enrolled before you can check in. Enter the course ID given by your teacher.
      </p>
      <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          required
          value={courseId}
          onChange={(event) => setCourseId(event.target.value)}
          placeholder="Course ID"
          aria-label="Course ID"
          className="h-10 rounded-xl border-white/10 bg-white/[0.03] dark:bg-white/[0.03]"
        />
        <Button type="submit" disabled={pending || !courseId.trim()} className="h-10 rounded-xl">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          Enroll
        </Button>
      </form>
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={cn(
            'mt-3 rounded-xl border px-3 py-2 text-xs',
            message.ok
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          {message.text}
        </p>
      )}
    </GlassCard>
  )
}

// ============================================================
// RESULT OVERLAY
// ============================================================

interface ResultOverlayProps {
  phase: Phase
  result: CheckInResult | null
  onRetry: () => void
  onDone: () => void
}

function ResultOverlay({ phase, result, onRetry, onDone }: ResultOverlayProps) {
  const open = (phase === 'success' || phase === 'failure') && result
  const success = phase === 'success'

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
          animate={{ opacity: 1, backdropFilter: 'blur(18px)' }}
          exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
          transition={{ duration: 0.35 }}
          className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-background/60 p-6"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="result-title"
          aria-describedby="result-desc"
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 260, damping: 22, delay: 0.05 }}
            className={cn(
              'glass w-full max-w-sm rounded-3xl p-6 text-center',
              success ? 'border-success/30' : 'border-destructive/30',
            )}
          >
            <motion.span
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 15, delay: 0.15 }}
              className={cn(
                'mx-auto flex size-16 items-center justify-center rounded-full',
                success
                  ? 'bg-success/15 text-success shadow-[0_0_40px_-4px] shadow-success/70'
                  : 'bg-destructive/15 text-destructive shadow-[0_0_40px_-4px] shadow-destructive/70',
              )}
            >
              {success ? <CheckCircle2 className="size-8" aria-hidden="true" /> : <XCircle className="size-8" aria-hidden="true" />}
            </motion.span>
            <h3 id="result-title" className="mt-4 text-lg font-semibold tracking-tight">
              {result.title}
            </h3>
            <p id="result-desc" className="mt-1 text-sm text-muted-foreground">
              {result.message}
            </p>
            {result.details && (
              <div className="mt-4 text-left">
                <p className="text-[11px] font-medium text-muted-foreground">What this phone heard</p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 p-2 font-mono text-[10px] leading-4 text-foreground/90">
                  {result.details}
                </pre>
              </div>
            )}
            <div className="mt-4 flex items-center justify-center gap-2 font-mono text-xs">
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">{result.time}</span>
            </div>
            <button
              type="button"
              autoFocus
              onClick={success ? onDone : onRetry}
              className={cn(
                'mt-6 h-11 w-full rounded-xl text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4',
                success
                  ? 'bg-success text-primary-foreground hover:bg-success/90 focus-visible:ring-success/30'
                  : 'bg-destructive text-foreground hover:bg-destructive/90 focus-visible:ring-destructive/30',
              )}
            >
              {success ? 'Done' : 'Try again'}
            </button>
            {!success && (
              <button
                type="button"
                onClick={onDone}
                className="mt-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Dismiss
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}