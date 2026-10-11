'use client'

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Loader2, Power, Radio, RotateCcw, Square, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardHeading, GlassCard } from '@/components/attendance/glass-card'
import { BEACON_LABEL, DEFAULT_SESSION_SECONDS } from '@/lib/attendance'
import { cn } from '@/lib/utils'

export type SessionStatus = 'idle' | 'live' | 'ended'

interface SessionControlProps {
  className?: string
  status: SessionStatus
  endsAt: number | null
  durationSeconds: number
  busy: boolean
  beaconPlaying: boolean
  onStart: () => void
  onStop: () => void
  onToggleBeacon: () => void
}

function useRemainingSeconds(endsAt: number | null, status: SessionStatus) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!endsAt) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [endsAt])
  if (status === 'ended') return 0
  if (!endsAt || now === 0) return DEFAULT_SESSION_SECONDS
  return Math.max(0, Math.ceil((endsAt - now) / 1000))
}

export function SessionControl({
  className,
  status,
  endsAt,
  durationSeconds,
  busy,
  beaconPlaying,
  onStart,
  onStop,
  onToggleBeacon,
}: SessionControlProps) {
  const remaining = useRemainingSeconds(endsAt, status)
  const live = status === 'live'

  useEffect(() => {
    if (live && endsAt && remaining === 0) onStop()
  }, [live, endsAt, remaining, onStop])

  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0')
  const seconds = String(remaining % 60).padStart(2, '0')
  const total = durationSeconds > 0 ? durationSeconds : DEFAULT_SESSION_SECONDS
  const elapsedRatio = live ? Math.min(1, Math.max(0, 1 - remaining / total)) : status === 'ended' ? 1 : 0

  return (
    <GlassCard className={cn('flex flex-col gap-5 p-5 sm:p-6', className)} labelledBy="session-title">
      <CardHeading
        id="session-title"
        icon={Radio}
        title="Active Session Control"
        description={`Ultrasonic beacon · ${BEACON_LABEL}`}
        action={<StatusChip status={status} playing={beaconPlaying} />}
      />

      <div className="grid flex-1 items-center gap-6 sm:grid-cols-[1fr_auto]">
        <div className="relative flex h-44 items-center justify-center overflow-hidden rounded-2xl border border-white/5 bg-black/20">
          <AnimatePresence mode="wait">
            {live ? (
              <motion.div
                key="wave"
                initial={{ opacity: 0, scale: 0.6, filter: 'blur(10px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                className="absolute inset-0 flex items-center px-4"
              >
                {beaconPlaying && (
                  <motion.span
                    aria-hidden="true"
                    initial={{ scale: 0.2, opacity: 0.7 }}
                    animate={{ scale: 4, opacity: 0 }}
                    transition={{ duration: 1.1, ease: 'easeOut' }}
                    className="absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary"
                  />
                )}
                <EmissionWaveform active={beaconPlaying} />
              </motion.div>
            ) : (
              <motion.div
                key="button"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.4, filter: 'blur(12px)' }}
                transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                className="relative flex items-center justify-center"
              >
                {[0, 1, 2].map((ring) => (
                  <motion.span
                    key={ring}
                    aria-hidden="true"
                    className="absolute size-24 rounded-full border border-primary/50"
                    animate={{ scale: [1, 1.9], opacity: [0.6, 0] }}
                    transition={{ duration: 2.4, repeat: Infinity, delay: ring * 0.8, ease: 'easeOut' }}
                  />
                ))}
                <motion.button
                  type="button"
                  onClick={onStart}
                  disabled={busy}
                  whileHover={busy ? undefined : { scale: 1.06 }}
                  whileTap={busy ? undefined : { scale: 0.94 }}
                  className="relative flex size-24 flex-col items-center justify-center gap-1 rounded-full bg-gradient-to-br from-primary to-violet text-primary-foreground shadow-[0_0_50px_-4px] shadow-primary/80 outline-none focus-visible:ring-4 focus-visible:ring-primary/40 disabled:cursor-wait disabled:opacity-70"
                >
                  {busy ? (
                    <Loader2 className="size-6 animate-spin" aria-hidden="true" />
                  ) : status === 'ended' ? (
                    <RotateCcw className="size-6" aria-hidden="true" />
                  ) : (
                    <Power className="size-6" aria-hidden="true" />
                  )}
                  <span className="text-[11px] font-semibold uppercase tracking-wider">
                    {busy ? 'Wait' : status === 'ended' ? 'Restart' : 'Start'}
                  </span>
                  <span className="sr-only">session</span>
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex flex-row items-center justify-between gap-4 sm:flex-col sm:items-end">
          <div className="sm:text-right">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              {live ? 'Time remaining' : status === 'ended' ? 'Session closed' : 'Session length'}
            </p>
            <p
              className={cn(
                'font-mono text-5xl font-semibold tabular-nums tracking-tight transition-colors sm:text-6xl',
                live ? 'text-primary [text-shadow:0_0_24px_oklch(0.84_0.14_200/0.55)]' : 'text-foreground/80',
              )}
              aria-live="polite"
              aria-atomic="true"
            >
              {minutes}
              <span className={cn(live && 'animate-pulse')}>:</span>
              {seconds}
            </p>
          </div>
          {live && (
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                variant="outline"
                onClick={onToggleBeacon}
                className="h-10 rounded-xl border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
              >
                {beaconPlaying ? (
                  <VolumeX className="size-3.5" aria-hidden="true" />
                ) : (
                  <Volume2 className="size-3.5" aria-hidden="true" />
                )}
                {beaconPlaying ? 'Pause beacon' : 'Play beacon'}
              </Button>
              <Button
                variant="outline"
                onClick={onStop}
                disabled={busy}
                className="h-10 rounded-xl border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="size-3.5 fill-current" aria-hidden="true" />
                )}
                End session
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-white/5">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-primary to-violet"
          animate={{ width: `${elapsedRatio * 100}%` }}
          transition={{ duration: 0.3, ease: 'linear' }}
        />
      </div>
    </GlassCard>
  )
}

function StatusChip({ status, playing }: { status: SessionStatus; playing: boolean }) {
  const config = {
    idle: { label: 'Standby', className: 'border-white/10 bg-white/5 text-muted-foreground' },
    live: playing
      ? { label: 'Emitting', className: 'border-primary/40 bg-primary/10 text-primary' }
      : { label: 'Beacon paused', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
    ended: { label: 'Closed', className: 'border-violet/40 bg-violet/10 text-violet' },
  }[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider',
        config.className,
      )}
    >
      <span className={cn('size-1.5 rounded-full bg-current', status === 'live' && playing && 'animate-pulse')} />
      {config.label}
    </span>
  )
}

/** Decorative bars that only move while the real beacon audio is actually playing. */
function EmissionWaveform({ active, bars = 56 }: { active: boolean; bars?: number }) {
  const barRefs = useRef<(SVGRectElement | null)[]>([])
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    const setIdle = () => {
      barRefs.current.forEach((bar) => {
        if (!bar) return
        bar.setAttribute('height', '6')
        bar.setAttribute('y', '47')
      })
    }

    if (!active) {
      setIdle()
      return
    }

    let frame = 0
    const start = performance.now()
    const render = (time: number) => {
      const s = reduceMotion ? 0.6 : (time - start) / 1000
      barRefs.current.forEach((bar, i) => {
        if (!bar) return
        const envelope = Math.sin((Math.PI * (i + 0.5)) / bars)
        const value =
          (Math.sin(s * 6 + i * 0.45) * 0.5 + 0.5) * 0.6 + (Math.sin(s * 11.3 - i * 0.8) * 0.5 + 0.5) * 0.4
        const height = 6 + envelope * value * 84
        bar.setAttribute('height', height.toFixed(1))
        bar.setAttribute('y', ((100 - height) / 2).toFixed(1))
      })
      if (!reduceMotion) frame = requestAnimationFrame(render)
    }
    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [active, bars, reduceMotion])

  return (
    <svg
      viewBox={`0 0 ${bars * 6} 100`}
      preserveAspectRatio="none"
      className="h-28 w-full drop-shadow-[0_0_12px_oklch(0.84_0.14_200/0.6)]"
      role="img"
      aria-label={active ? 'Ultrasonic beacon is playing' : 'Ultrasonic beacon is paused'}
    >
      <defs>
        <linearGradient id="emission-gradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="100%" stopColor="var(--violet)" />
        </linearGradient>
      </defs>
      {Array.from({ length: bars }, (_, i) => (
        <rect
          key={i}
          ref={(el) => {
            barRefs.current[i] = el
          }}
          x={i * 6 + 1}
          width={3.5}
          rx={1.75}
          y={47}
          height={6}
          fill="url(#emission-gradient)"
        />
      ))}
    </svg>
  )
}