'use client'

import { useEffect, useRef } from 'react'

interface AudioVisualizerProps {
  analyser: AnalyserNode | null
  active: boolean
  tone: 'primary' | 'violet' | 'success' | 'destructive' | 'muted'
}

const WIDTH = 600
const HEIGHT = 96
const POINTS = 120
const LAYERS = [
  { scale: 1, opacity: 1, width: 2.2 },
  { scale: 0.65, opacity: 0.45, width: 1.4 },
  { scale: 0.38, opacity: 0.25, width: 1 },
]

const TONE_VAR: Record<AudioVisualizerProps['tone'], string> = {
  primary: 'var(--primary)',
  violet: 'var(--violet)',
  success: 'var(--success)',
  destructive: 'var(--destructive)',
  muted: 'var(--muted-foreground)',
}

/**
 * Draws the real microphone signal from the AnalyserNode.
 * Without a live microphone it only draws a flat line — nothing is simulated.
 */
export function AudioVisualizer({ analyser, active, tone }: AudioVisualizerProps) {
  const pathRefs = useRef<(SVGPathElement | null)[]>([])
  const activeRef = useRef(active)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    const buffer = analyser ? new Float32Array(analyser.fftSize) : null
    const flat = `M0 ${HEIGHT / 2} L${WIDTH} ${HEIGHT / 2}`
    let frame = 0

    const render = () => {
      const live = Boolean(analyser && buffer && activeRef.current)

      if (live && analyser && buffer) {
        analyser.getFloatTimeDomainData(buffer)
      }

      LAYERS.forEach((layer, li) => {
        const path = pathRefs.current[li]
        if (!path) return

        if (!live || !buffer) {
          path.setAttribute('d', flat)
          return
        }

        let d = ''
        for (let i = 0; i <= POINTS; i++) {
          const x = (i / POINTS) * WIDTH
          const envelope = Math.sin((Math.PI * i) / POINTS) ** 1.5
          // Ultrasonic tones carry very little audible energy, so the real samples are amplified for display.
          const sample = buffer[Math.floor((i / POINTS) * (buffer.length - 1))] * 7
          const value = Math.max(-1, Math.min(1, sample))
          const y = HEIGHT / 2 + value * envelope * layer.scale * HEIGHT * 0.42
          d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
        }
        path.setAttribute('d', d)
      })

      frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [analyser])

  const color = TONE_VAR[tone]

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="h-20 w-full transition-[filter] duration-500"
      style={{ filter: active && analyser ? `drop-shadow(0 0 8px ${color})` : 'none' }}
      role="img"
      aria-label={
        active && analyser ? 'Microphone signal waveform, capturing' : 'Microphone signal waveform, no signal'
      }
    >
      {LAYERS.map((layer, i) => (
        <path
          key={i}
          ref={(el) => {
            pathRefs.current[i] = el
          }}
          d={`M0 ${HEIGHT / 2} L${WIDTH} ${HEIGHT / 2}`}
          fill="none"
          stroke={color}
          strokeOpacity={layer.opacity}
          strokeWidth={layer.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{ transition: 'stroke 0.5s' }}
        />
      ))}
    </svg>
  )
}