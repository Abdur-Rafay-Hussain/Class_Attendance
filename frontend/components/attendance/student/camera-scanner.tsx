'use client'

import { useEffect, useRef, type RefObject } from 'react'

export type ScanPhase = 'idle' | 'requesting' | 'scanning' | 'decoding' | 'success' | 'failure'

const PHASE_RGB: Record<ScanPhase, string> = {
  idle: '120, 140, 170',
  requesting: '64, 224, 255',
  scanning: '64, 224, 255',
  decoding: '170, 140, 255',
  success: '60, 240, 160',
  failure: '255, 80, 95',
}

interface CameraScannerProps {
  stream: MediaStream | null
  phase: ScanPhase
  /** Lets the parent read real frames from the live camera video to send to the backend. */
  videoRef?: RefObject<HTMLVideoElement | null>
}

export function CameraScanner({ stream, phase, videoRef: externalVideoRef }: CameraScannerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const internalVideoRef = useRef<HTMLVideoElement>(null)
  const videoRef = externalVideoRef ?? internalVideoRef
  const phaseRef = useRef<ScanPhase>(phase)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    if (stream) video.play().catch(() => {})
  }, [stream, videoRef])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    let frame = 0
    const draw = (time: number) => {
      const w = canvas.width
      const h = canvas.height
      const t = time / 1000
      const current = phaseRef.current
      const rgb = PHASE_RGB[current]
      const active = current === 'scanning' || current === 'decoding' || current === 'requesting'
      const video = videoRef.current

      ctx.clearRect(0, 0, w, h)

      // Only the real camera image is ever drawn. Without a camera stream the area stays an empty dark panel.
      if (video && video.readyState >= 2 && video.videoWidth) {
        const scale = Math.max(w / video.videoWidth, h / video.videoHeight)
        const vw = video.videoWidth * scale
        const vh = video.videoHeight * scale
        ctx.save()
        ctx.translate(w, 0)
        ctx.scale(-1, 1)
        ctx.filter = 'saturate(0.7) contrast(1.05) brightness(0.85)'
        ctx.drawImage(video, (w - vw) / 2, (h - vh) / 2, vw, vh)
        ctx.restore()
        ctx.filter = 'none'
      } else {
        ctx.fillStyle = '#0b1222'
        ctx.fillRect(0, 0, w, h)
      }

      const cx = w / 2
      const cy = h / 2
      const radius = Math.min(w, h) * 0.4

      const vignette = ctx.createRadialGradient(cx, cy, radius * 0.6, cx, cy, Math.max(w, h) * 0.75)
      vignette.addColorStop(0, 'rgba(5, 8, 20, 0)')
      vignette.addColorStop(1, 'rgba(5, 8, 20, 0.85)')
      ctx.fillStyle = vignette
      ctx.fillRect(0, 0, w, h)

      if (current !== 'idle') drawRadar(ctx, cx, cy, radius, t, rgb, active, Math.min(w, h))

      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [videoRef])

  return (
    <>
      <video ref={videoRef} muted playsInline className="hidden" aria-hidden="true" />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" aria-hidden="true" />
    </>
  )
}

function drawRadar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  t: number,
  rgb: string,
  active: boolean,
  unit: number,
) {
  const angle = (t * 2.2) % (Math.PI * 2)
  const line = Math.max(1, unit / 400)

  ctx.lineWidth = line
  for (let i = 1; i <= 4; i++) {
    ctx.strokeStyle = `rgba(${rgb}, ${0.08 + i * 0.05})`
    ctx.beginPath()
    ctx.arc(cx, cy, (radius * i) / 4, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.save()
  ctx.setLineDash([line * 6, line * 8])
  ctx.lineDashOffset = -t * 30
  ctx.strokeStyle = `rgba(${rgb}, 0.6)`
  ctx.lineWidth = line * 1.5
  ctx.beginPath()
  ctx.arc(cx, cy, radius * 1.08, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  ctx.strokeStyle = `rgba(${rgb}, 0.18)`
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()

  if (active) {
    const spacing = unit / 26
    const dot = Math.max(1.5, unit / 260)
    for (let x = cx - radius; x <= cx + radius; x += spacing) {
      for (let y = cy - radius; y <= cy + radius; y += spacing) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy > radius * radius) continue
        const a = Math.atan2(dy, dx)
        const diff = (((angle - a) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const glow = Math.max(0, 1 - diff / 1.3)
        ctx.fillStyle = `rgba(${rgb}, ${0.06 + glow * 0.75})`
        ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot)
      }
    }

    if ('createConicGradient' in ctx) {
      const sweep = ctx.createConicGradient(angle, cx, cy)
      sweep.addColorStop(0, `rgba(${rgb}, 0)`)
      sweep.addColorStop(0.82, `rgba(${rgb}, 0)`)
      sweep.addColorStop(0.998, `rgba(${rgb}, 0.32)`)
      sweep.addColorStop(1, `rgba(${rgb}, 0)`)
      ctx.fillStyle = sweep
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.save()
    ctx.shadowColor = `rgba(${rgb}, 0.9)`
    ctx.shadowBlur = unit / 30
    ctx.strokeStyle = `rgba(${rgb}, 0.95)`
    ctx.lineWidth = line * 2
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
    ctx.stroke()

    const laserY = cy - radius * 0.7 + ((Math.sin(t * 1.6) + 1) / 2) * radius * 1.4
    const half = Math.sqrt(Math.max(0, radius * radius - (laserY - cy) ** 2))
    ctx.strokeStyle = `rgba(${rgb}, 0.7)`
    ctx.lineWidth = line
    ctx.beginPath()
    ctx.moveTo(cx - half, laserY)
    ctx.lineTo(cx + half, laserY)
    ctx.stroke()
    ctx.restore()
  }

  const box = radius * 0.62
  const corner = box * 0.28
  const pulse = active ? 1 + Math.sin(t * 4) * 0.03 : 1
  const b = box * pulse
  ctx.strokeStyle = `rgba(${rgb}, 0.95)`
  ctx.lineWidth = line * 2.5
  ctx.lineCap = 'round'
  const corners: [number, number, number, number][] = [
    [-1, -1, 1, 1],
    [1, -1, -1, 1],
    [-1, 1, 1, -1],
    [1, 1, -1, -1],
  ]
  for (const [sx, sy, dx, dy] of corners) {
    const x = cx + sx * b
    const y = cy - radius * 0.06 + sy * b
    ctx.beginPath()
    ctx.moveTo(x + dx * corner, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + dy * corner)
    ctx.stroke()
  }
}