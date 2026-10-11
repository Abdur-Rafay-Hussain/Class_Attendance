'use client'

import type { ComponentType, ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'

interface GlassCardProps {
  children: ReactNode
  className?: string
  delay?: number
  lift?: boolean
  labelledBy?: string
}

export function GlassCard({ children, className, delay = 0, lift = true, labelledBy }: GlassCardProps) {
  return (
    <motion.section
      aria-labelledby={labelledBy}
      initial={{ opacity: 0, y: 20, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      whileHover={lift ? { y: -3 } : undefined}
      className={cn('glass glass-glow rounded-3xl', className)}
    >
      {children}
    </motion.section>
  )
}

interface CardHeadingProps {
  id: string
  icon: ComponentType<{ className?: string }>
  title: string
  description?: string
  action?: ReactNode
}

export function CardHeading({ id, icon: Icon, title, description, action }: CardHeadingProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-[0_0_20px_-6px] shadow-primary/60">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {action}
    </div>
  )
}
