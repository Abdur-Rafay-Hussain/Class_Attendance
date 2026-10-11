'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AudioWaveform, KeyRound, LayoutDashboard, ScanFace } from 'lucide-react'
import { AuthScreen, type Role } from '@/components/attendance/auth-screen'
import { TeacherDashboard } from '@/components/attendance/teacher/teacher-dashboard'
import { StudentCheckIn } from '@/components/attendance/student/student-check-in'
import { logout, setUnauthorizedHandler, type AuthSession } from '@/lib/api'
import { cn } from '@/lib/utils'

type Screen = 'auth' | Role

const SCREENS = [
  { id: 'auth', label: 'Sign in', icon: KeyRound },
  { id: 'teacher', label: 'Teacher', icon: LayoutDashboard },
  { id: 'student', label: 'Student', icon: ScanFace },
] as const

export function AppShell() {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const screen: Screen = session ? session.role : 'auth'
  const userName = session ? (session.name ?? session.email.split('@')[0]) : ''

  // If the backend rejects the token (expired or invalid), return to the sign-in screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout()
      setSession(null)
      setNotice('Your session expired. Please sign in again.')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  function handleAuthenticated(next: AuthSession) {
    setNotice(null)
    setSession(next)
  }

  function signOut() {
    logout()
    setSession(null)
  }

  function selectScreen(id: Screen) {
    if (id === 'auth' && session) signOut()
  }

  return (
    <div className="relative min-h-dvh overflow-x-hidden">
      <BackgroundGlow />

      <header className="sticky top-0 z-30 border-b border-white/5 bg-background/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-violet text-primary-foreground shadow-[0_0_24px_-4px] shadow-primary/70">
              <AudioWaveform className="size-5" aria-hidden="true" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-tight">Resonance</p>
              <p className="hidden text-[11px] text-muted-foreground sm:block">AI Classroom Attendance</p>
            </div>
          </div>

          <nav aria-label="Switch screen" className="glass flex items-center gap-1 rounded-full p-1">
            {SCREENS.map(({ id, label: baseLabel, icon: Icon }) => {
              const active = screen === id
              const label = id === 'auth' && session ? 'Sign out' : baseLabel
              const locked = id !== 'auth' && session?.role !== id
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  disabled={locked}
                  title={locked ? `Sign in with a ${id} account to open this view` : undefined}
                  onClick={() => selectScreen(id)}
                  className={cn(
                    'relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:px-4 sm:text-sm',
                    active ? 'text-primary-foreground' : 'text-muted-foreground enabled:hover:text-foreground',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="screen-pill"
                      className="absolute inset-0 rounded-full bg-primary shadow-[0_0_20px_-2px] shadow-primary/70"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    />
                  )}
                  <Icon className="relative size-4" aria-hidden="true" />
                  <span className="relative hidden sm:inline">{label}</span>
                  <span className="sr-only sm:hidden">{label}</span>
                </button>
              )
            })}
          </nav>
        </div>
      </header>

      <main className="relative mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10 lg:px-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={screen}
            initial={{ opacity: 0, y: 16, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -12, filter: 'blur(8px)' }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            {screen === 'auth' && <AuthScreen onAuthenticated={handleAuthenticated} notice={notice} />}
            {screen === 'teacher' && <TeacherDashboard userName={userName} courseId={session?.courseId ?? null} />}
            {screen === 'student' && <StudentCheckIn userName={userName} />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}

function BackgroundGlow() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10">
      <div className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" />
      <div className="absolute -left-40 -top-40 size-[36rem] rounded-full bg-primary/15 blur-[120px]" />
      <div className="absolute -right-32 top-20 size-[30rem] rounded-full bg-violet/15 blur-[120px]" />
      <div className="absolute bottom-[-12rem] left-1/3 size-[28rem] rounded-full bg-success/10 blur-[130px]" />
    </div>
  )
}