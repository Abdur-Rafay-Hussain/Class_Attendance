'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { getLivenessChallenge } from '@/lib/api'
import { FACE_SNAPSHOT_COUNT } from '@/lib/attendance'
import { cn } from '@/lib/utils'

// Time to let the camera adjust its exposure before the first photo.
const WARMUP_MS = 2000
// Time the person gets to perform each action before its photo is taken.
const ACTION_MS = 2800
// Short pause between two steps.
const PAUSE_MS = 700
const MAX_FRAME_WIDTH = 960

const STEP_TEXT: Record<string, string> = {
  FRONT: 'Look straight at the camera and keep your eyes open.',
  EYES_CLOSED: 'Close your eyes and keep them closed…',
  TURN_LEFT: 'Slowly turn your head to the left and hold.',
  TURN_RIGHT: 'Slowly turn your head to the right and hold.',
}

interface FaceCaptureProps {
  /** Called once with exactly 3 live JPEG photos and the liveness challenge they belong to. */
  onCaptured: (images: Blob[], challengeId: string) => void
  onError: (message: string) => void
  onCancel?: () => void
}

type CaptureStatus = 'starting' | 'capturing' | 'done'

function captureFrame(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return Promise.resolve(null)
  const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(video.videoWidth * scale)
  canvas.height = Math.round(video.videoHeight * scale)
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92))
}

function describeCameraError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera access was denied. Allow the camera in the browser address bar and try again.'
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No camera was found on this device.'
      case 'NotReadableError':
        return 'The camera is being used by another application.'
    }
  }
  return error instanceof Error ? error.message : 'Could not start the camera.'
}

/**
 * Opens the live camera as soon as it appears, asks the server for a random liveness challenge and then takes
 * one photo per step (look straight, close eyes, turn head). There is no capture button and no gallery upload.
 */
export function FaceCapture({ onCaptured, onError, onCancel }: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState<CaptureStatus>('starting')
  const [taken, setTaken] = useState(0)
  const [flash, setFlash] = useState(false)
  const [instruction, setInstruction] = useState('')

  const handlers = useRef({ onCaptured, onError })
  useEffect(() => {
    handlers.current = { onCaptured, onError }
  }, [onCaptured, onError])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const timers: ReturnType<typeof setTimeout>[] = []

    const stopCamera = () => {
      stream?.getTracks().forEach((track) => track.stop())
      stream = null
    }
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, ms))
      })

    async function run() {
      if (!navigator.mediaDevices?.getUserMedia) {
        handlers.current.onError('Camera is not available. Open this app on http://localhost or over HTTPS.')
        return
      }
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        })
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop())
          return
        }
        stream = media
        const video = videoRef.current
        if (!video) throw new Error('The camera preview is not ready.')
        video.srcObject = media
        await video.play().catch(() => {})

        const startedAt = performance.now()
        while (!cancelled && !(video.readyState >= 2 && video.videoWidth > 0)) {
          if (performance.now() - startedAt > 6000) {
            throw new Error('The camera did not start. Check that no other app is using it and try again.')
          }
          await sleep(100)
        }
        if (cancelled) return

        // A fresh random challenge from the server for every attempt.
        const challenge = await getLivenessChallenge()
        if (cancelled) return

        setStatus('capturing')
        setInstruction('Get ready…')
        await sleep(WARMUP_MS)

        const images: Blob[] = []
        for (let index = 0; index < challenge.steps.length; index++) {
          if (cancelled) return
          setInstruction(STEP_TEXT[challenge.steps[index]] ?? 'Follow the instruction on screen.')
          await sleep(ACTION_MS)
          if (cancelled) return

          const blob = await captureFrame(video)
          if (!blob) throw new Error('Could not take a photo from the camera. Please try again.')
          images.push(blob)
          setTaken(index + 1)
          setFlash(true)
          timers.push(setTimeout(() => setFlash(false), 150))

          if (index < challenge.steps.length - 1) {
            setInstruction('Good. Get ready for the next step…')
            await sleep(PAUSE_MS)
          }
        }
        if (cancelled) return

        stopCamera()
        setStatus('done')
        handlers.current.onCaptured(images, challenge.challengeId)
      } catch (error) {
        if (cancelled) return
        stopCamera()
        handlers.current.onError(describeCameraError(error))
      }
    }

    void run()

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
      stopCamera()
    }
  }, [])

  const message =
    status === 'starting' ? 'Opening camera…' : status === 'done' ? 'All photos captured.' : instruction

  return (
    <div className="flex flex-col gap-4">
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10 bg-black/60">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className="size-full object-cover"
          style={{ transform: 'scaleX(-1)' }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-[78%] w-[52%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-2 border-primary/70 shadow-[0_0_30px_-4px] shadow-primary/60"
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-white"
          animate={{ opacity: flash ? 0.7 : 0 }}
          transition={{ duration: 0.12 }}
        />
        {status === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/50 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin text-primary" aria-hidden="true" />
            Opening camera…
          </div>
        )}
      </div>

      <ol className="flex items-center justify-center gap-2" aria-label="Photos captured">
        {Array.from({ length: FACE_SNAPSHOT_COUNT }, (_, index) => {
          const done = index < taken
          return (
            <li
              key={index}
              className={cn(
                'flex size-8 items-center justify-center rounded-full border text-xs transition-colors duration-300',
                done
                  ? 'border-success/40 bg-success/15 text-success'
                  : 'border-white/10 bg-white/[0.03] text-muted-foreground',
              )}
            >
              {done ? <CheckCircle2 className="size-4" aria-hidden="true" /> : index + 1}
            </li>
          )
        })}
      </ol>

      <p className="text-center text-sm text-muted-foreground" aria-live="polite">
        {message}
      </p>

      {onCancel && status !== 'done' && (
        <button
          type="button"
          onClick={onCancel}
          className="mx-auto text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Cancel
        </button>
      )}
    </div>
  )
}