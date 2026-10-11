'use client'

import { useEffect } from 'react'
import { motion, useSpring, useTransform } from 'motion/react'
import { Gauge } from 'lucide-react'
import { CardHeading, GlassCard } from '@/components/attendance/glass-card'
import { cn } from '@/lib/utils'

interface LiveProgressProps {
  className?: string
  present: number
  flagged: number
  absent: number
  /**
   * The backend has no endpoint that returns the enrolled student count. Until the session is finished
   * (when every enrolled student without a record is saved as ABSENT), the percentage is based on the
   * check-ins received so far.
   */
  finalized: boolean
}

const RADIUS = 78
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const TICKS = 60

export function LiveProgress({ className, present, flagged, absent, finalized }: LiveProgressProps) {
  const total = present + flagged + absent
  const percent = total ? (present / total) * 100 : 0
  const spring = useSpring(0, { stiffness: 70, damping: 18 })
  const label = useTransform(spring, (v) => Math.round(v).toString())
  const dashOffset = useTransform(spring, (v) => CIRCUMFERENCE - (v / 100) * CIRCUMFERENCE)

  useEffect(() => {
    spring.set(percent)
  }, [percent, spring])

  const stats = [
    { label: 'Present', value: present, dot: 'bg-success' },
    { label: 'Flagged', value: flagged, dot: 'bg-destructive' },
    { label: 'Absent', value: absent, dot: 'bg-muted-foreground' },
  ]

  return (
    <GlassCard className={cn('flex flex-col gap-4 p-5 sm:p-6', className)} labelledBy="progress-title">
      <CardHeading
        id="progress-title"
        icon={Gauge}
        title="Live Progress Metric"
        description={finalized ? 'Present vs. class strength' : 'Present vs. check-ins received'}
      />

      <div className="flex flex-1 items-center justify-center py-2">
        <div
          className="relative size-52"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-label="Students marked present"
        >
          <svg viewBox="0 0 200 200" className="size-full -rotate-90">
            <defs>
              <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--primary)" />
                <stop offset="100%" stopColor="var(--success)" />
              </linearGradient>
            </defs>
            {Array.from({ length: TICKS }, (_, i) => {
              const angle = (i / TICKS) * Math.PI * 2
              const lit = (i / TICKS) * 100 < percent
              return (
                <line
                  key={i}
                  x1={100 + Math.cos(angle) * 94}
                  y1={100 + Math.sin(angle) * 94}
                  x2={100 + Math.cos(angle) * 98}
                  y2={100 + Math.sin(angle) * 98}
                  stroke={lit ? 'var(--primary)' : 'oklch(1 0 0 / 0.1)'}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  style={{ transition: 'stroke 0.4s' }}
                />
              )
            })}
            <circle cx="100" cy="100" r={RADIUS} fill="none" stroke="oklch(1 0 0 / 0.06)" strokeWidth="12" />
            <motion.circle
              cx="100"
              cy="100"
              r={RADIUS}
              fill="none"
              stroke="url(#ring-gradient)"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              style={{ strokeDashoffset: dashOffset }}
              className="drop-shadow-[0_0_10px_oklch(0.84_0.14_200/0.6)]"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="font-mono text-5xl font-semibold tabular-nums tracking-tight">
              <motion.span>{label}</motion.span>
              <span className="text-2xl text-muted-foreground">%</span>
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {present} / {total} {finalized ? 'students' : 'check-ins'}
            </p>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn('size-1.5 rounded-full', stat.dot)} />
              {stat.label}
            </dt>
            <dd className="font-mono text-lg font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </GlassCard>
  )
}