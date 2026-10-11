'use client'

import { AnimatePresence, motion } from 'motion/react'
import { Activity, AlertTriangle, CheckCircle2, RadioTower, UserX } from 'lucide-react'
import { CardHeading, GlassCard } from '@/components/attendance/glass-card'
import { formatTime, initials, type AttendanceRecord, type AttendanceStatus } from '@/lib/attendance'
import { cn } from '@/lib/utils'

interface ActivityStreamProps {
  className?: string
  records: AttendanceRecord[]
  live: boolean
  connected: boolean
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,2fr)_0.7fr_1fr_minmax(0,2fr)_auto]'

export function ActivityStream({ className, records, live, connected }: ActivityStreamProps) {
  const visible = records.slice(0, 200)

  return (
    <GlassCard className={cn('flex min-h-[26rem] flex-col gap-4 p-5 sm:p-6', className)} labelledBy="stream-title">
      <CardHeading
        id="stream-title"
        icon={Activity}
        title="Real-Time Activity Stream"
        description="Live attendance feed from the server"
        action={
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px]',
              connected ? 'border-success/40 bg-success/10 text-success' : 'border-white/10 bg-white/5 text-muted-foreground',
            )}
          >
            <span className={cn('size-1.5 rounded-full bg-current', connected && 'animate-pulse')} />
            {connected ? 'CONNECTED' : live ? 'CONNECTING' : 'OFFLINE'}
          </span>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/5 bg-black/20">
        <div
          className={cn(
            GRID,
            'border-b border-white/5 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground',
          )}
          role="row"
        >
          <span>Student</span>
          <span className="hidden md:block">ID</span>
          <span className="hidden md:block">Time</span>
          <span className="hidden md:block">Reason</span>
          <span className="text-right">Status</span>
        </div>

        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <RadioTower className="size-8 text-muted-foreground/60" aria-hidden="true" />
            <p className="max-w-xs text-sm text-muted-foreground">
              {live ? 'Listening for student check-ins…' : 'Start a session to begin streaming attendance events.'}
            </p>
          </div>
        ) : (
          <ul className="max-h-[30rem] flex-1 overflow-y-auto" aria-live="polite" aria-label="Attendance events">
            <AnimatePresence initial={false}>
              {visible.map((record) => (
                <motion.li
                  key={record.id}
                  layout
                  initial={{ opacity: 0, x: -28, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                  className={cn(GRID, 'border-b border-white/[0.04] px-4 py-3 last:border-b-0 hover:bg-white/[0.02]')}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-white/10 to-white/[0.02] text-[11px] font-semibold ring-1 ring-white/10">
                      {initials(record.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{record.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground md:hidden">
                        #{record.studentId} · {formatTime(record.timestamp)}
                      </p>
                      {record.reason && (
                        <p className="truncate text-[11px] text-muted-foreground md:hidden">{record.reason}</p>
                      )}
                    </div>
                  </div>
                  <span className="hidden font-mono text-xs text-muted-foreground md:block">#{record.studentId}</span>
                  <span className="hidden font-mono text-xs text-muted-foreground md:block">
                    {formatTime(record.timestamp)}
                  </span>
                  <span
                    className={cn(
                      'hidden truncate text-xs md:block',
                      record.status === 'PRESENT' ? 'text-muted-foreground' : 'text-destructive/90',
                    )}
                    title={record.reason}
                  >
                    {record.reason ?? '—'}
                  </span>
                  <StatusBadge status={record.status} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </GlassCard>
  )
}

function StatusBadge({ status }: { status: AttendanceStatus }) {
  if (status === 'PRESENT') {
    return (
      <span className="inline-flex items-center gap-1 justify-self-end rounded-full border border-success/40 bg-success/10 px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider text-success shadow-[0_0_14px_-2px] shadow-success/60">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        PRESENT
      </span>
    )
  }
  if (status === 'ABSENT') {
    return (
      <span className="inline-flex items-center gap-1 justify-self-end rounded-full border border-white/15 bg-white/5 px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider text-muted-foreground">
        <UserX className="size-3" aria-hidden="true" />
        ABSENT
      </span>
    )
  }
  return (
    <span className="animate-flag-pulse inline-flex items-center gap-1 justify-self-end rounded-full border border-destructive/50 bg-destructive/15 px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider text-destructive">
      <AlertTriangle className="size-3" aria-hidden="true" />
      FLAGGED
    </span>
  )
}