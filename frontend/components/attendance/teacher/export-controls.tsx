'use client'

import { useState, type ComponentType } from 'react'
import { motion } from 'motion/react'
import { Check, Download, FileSpreadsheet, FileText } from 'lucide-react'
import { CardHeading, GlassCard } from '@/components/attendance/glass-card'
import { exportCsv, exportExcel } from '@/lib/export-report'
import type { AttendanceRecord } from '@/lib/attendance'
import { cn } from '@/lib/utils'

interface ExportControlsProps {
  className?: string
  records: AttendanceRecord[]
  /** Used in the downloaded file name, for example "session-12". */
  label: string
}

type Format = 'csv' | 'excel'

export function ExportControls({ className, records, label }: ExportControlsProps) {
  const [lastExport, setLastExport] = useState<Format | null>(null)
  const disabled = records.length === 0

  function handleExport(format: Format) {
    if (format === 'csv') exportCsv(records, label)
    else exportExcel(records, label)
    setLastExport(format)
    setTimeout(() => setLastExport(null), 2200)
  }

  return (
    <GlassCard className={cn('flex flex-col gap-4 p-5 sm:p-6', className)} labelledBy="export-title">
      <CardHeading
        id="export-title"
        icon={Download}
        title="Export Controls"
        description={disabled ? 'No records yet' : `${records.length} records ready`}
      />

      <div className="flex flex-col gap-2.5">
        <ExportButton
          icon={FileText}
          title="Download CSV"
          meta="Comma-separated · UTF-8"
          disabled={disabled}
          done={lastExport === 'csv'}
          onClick={() => handleExport('csv')}
        />
        <ExportButton
          icon={FileSpreadsheet}
          title="Download Excel"
          meta="Microsoft Excel · .xls"
          disabled={disabled}
          done={lastExport === 'excel'}
          onClick={() => handleExport('excel')}
        />
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Reports include student ID, name, attendance status, the reason saved by the server and the time.
      </p>
    </GlassCard>
  )
}

interface ExportButtonProps {
  icon: ComponentType<{ className?: string }>
  title: string
  meta: string
  disabled: boolean
  done: boolean
  onClick: () => void
}

function ExportButton({ icon: Icon, title, meta, disabled, done, onClick }: ExportButtonProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { x: 3 }}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      className="group flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] p-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-white/8 disabled:hover:bg-white/[0.03]"
    >
      <span className="flex size-10 items-center justify-center rounded-xl bg-white/5 text-primary transition-shadow group-hover:shadow-[0_0_20px_-4px] group-hover:shadow-primary/60">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{meta}</span>
      </span>
      <span
        className={cn(
          'flex size-7 items-center justify-center rounded-full transition-colors',
          done ? 'bg-success/15 text-success' : 'text-muted-foreground group-hover:text-primary',
        )}
      >
        {done ? <Check className="size-4" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
        <span className="sr-only">{done ? 'Downloaded' : 'Download'}</span>
      </span>
    </motion.button>
  )
}