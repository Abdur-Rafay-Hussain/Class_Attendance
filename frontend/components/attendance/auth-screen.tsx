'use client'

import { useState, type ComponentType, type FormEvent, type InputHTMLAttributes } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight,
  AudioLines,
  BadgeCheck,
  BookOpen,
  GraduationCap,
  IdCard,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  Presentation,
  ScanFace,
  User,
  Zap,
} from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/attendance/glass-card'
import { FaceCapture } from '@/components/attendance/student/face-capture'
import {
  ApiError,
  login,
  logout,
  registerStudent,
  signupTeacher,
  type AuthSession,
  type Role,
} from '@/lib/api'
import { BEACON_LABEL, DEFAULT_SESSION_SECONDS, FACE_SNAPSHOT_COUNT } from '@/lib/attendance'

export type { Role }

interface AuthScreenProps {
  onAuthenticated: (session: AuthSession) => void
  notice?: string | null
}

export function AuthScreen({ onAuthenticated, notice }: AuthScreenProps) {
  const [role, setRole] = useState<Role>('student')

  return (
    <div className="grid items-center gap-10 lg:min-h-[calc(100dvh-12rem)] lg:grid-cols-[1.1fr_1fr] lg:gap-16">
      <AuthHero />

      <GlassCard lift={false} className="mx-auto w-full max-w-md p-6 sm:p-8" labelledBy="auth-title">
        <h2 id="auth-title" className="text-xl font-semibold tracking-tight">
          Welcome back
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose your role to continue.</p>

        {notice && (
          <p
            role="status"
            className="mt-4 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary"
          >
            {notice}
          </p>
        )}

        <Tabs value={role} onValueChange={(value) => setRole(value as Role)} className="mt-6 gap-6">
          <TabsList className="h-11 w-full rounded-xl border border-white/5 bg-white/[0.03] p-1 group-data-horizontal/tabs:h-11">
            <TabsTrigger
              value="student"
              className="h-full rounded-lg data-active:bg-primary/15 data-active:text-primary dark:data-active:border-primary/30 dark:data-active:bg-primary/15 dark:data-active:text-primary"
            >
              <GraduationCap aria-hidden="true" />
              Student
            </TabsTrigger>
            <TabsTrigger
              value="teacher"
              className="h-full rounded-lg data-active:bg-primary/15 data-active:text-primary dark:data-active:border-primary/30 dark:data-active:bg-primary/15 dark:data-active:text-primary"
            >
              <Presentation aria-hidden="true" />
              Teacher
            </TabsTrigger>
          </TabsList>

          <TabsContent value="student">
            <AuthForm role="student" onAuthenticated={onAuthenticated} />
          </TabsContent>
          <TabsContent value="teacher">
            <AuthForm role="teacher" onAuthenticated={onAuthenticated} />
          </TabsContent>
        </Tabs>
      </GlassCard>
    </div>
  )
}

function AuthHero() {
  const features = [
    { icon: AudioLines, label: 'Ultrasonic proximity' },
    { icon: ScanFace, label: 'Face verification' },
    { icon: Zap, label: 'Real-time sync' },
  ]
  const facts = [
    { value: BEACON_LABEL, label: 'Beacon band' },
    { value: String(FACE_SNAPSHOT_COUNT), label: 'Face snapshots' },
    { value: `${DEFAULT_SESSION_SECONDS / 60} min`, label: 'Session window' },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      className="max-w-xl"
    >
      <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
          <span className="relative inline-flex size-2 rounded-full bg-primary" />
        </span>
        Ultrasonic + face verified attendance
      </span>
      <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
        Attendance that{' '}
        <span className="bg-gradient-to-r from-primary via-primary to-violet bg-clip-text text-transparent">
          verifies itself.
        </span>
      </h1>
      <p className="mt-5 text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg">
        The teacher&apos;s laptop plays an inaudible ultrasonic beacon. Students confirm presence by recording that
        beacon with their microphone while the camera captures {FACE_SNAPSHOT_COUNT} face snapshots — no QR codes, no
        roll calls.
      </p>

      <ul className="mt-8 flex flex-wrap gap-2">
        {features.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="glass flex items-center gap-2 rounded-full px-3.5 py-2 text-sm text-foreground/90"
          >
            <Icon className="size-4 text-primary" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>

      <dl className="mt-10 grid max-w-md grid-cols-3 gap-6 border-t border-white/5 pt-6">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt className="text-xs text-muted-foreground">{fact.label}</dt>
            <dd className="mt-1 font-mono text-lg font-semibold tracking-tight">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </motion.div>
  )
}

interface AuthFormProps {
  role: Role
  onAuthenticated: (session: AuthSession) => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

type Step = 'form' | 'camera' | 'saving'

function AuthForm({ role, onAuthenticated }: AuthFormProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [step, setStep] = useState<Step>('form')
  const [studentId, setStudentId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [courseName, setCourseName] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isTeacher = role === 'teacher'
  const isSignup = mode === 'signup'

  /** Signs in and checks that the account type matches the selected tab. Returns true on success. */
  async function signIn(displayName: string | null): Promise<boolean> {
    const session = await login(email.trim(), password)

    if (session.role !== role) {
      // The backend decides the role. Do not let the selected tab hide which kind of account this is.
      logout()
      setError(
        session.role === 'teacher'
          ? 'This is a teacher account. Use the Teacher tab to sign in.'
          : 'This is a student account. Use the Student tab to sign in.',
      )
      return false
    }

    onAuthenticated({ ...session, name: session.name ?? displayName })
    return true
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError(null)

    if (!EMAIL_PATTERN.test(email.trim())) {
      setError('Please enter a valid email address.')
      return
    }

    if (isSignup) {
      if (!name.trim()) {
        setError('Please enter your full name.')
        return
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters.')
        return
      }

      if (!isTeacher) {
        if (!studentId.trim()) {
          setError('Please enter your Student ID.')
          return
        }
        // Details are valid: the camera opens next and takes the face photos automatically.
        setStep('camera')
        return
      }

      if (!courseName.trim()) {
        setError('Please enter the course name.')
        return
      }
      if (!secretKey) {
        setError('Please enter the teacher signup secret.')
        return
      }

      setPending(true)
      let created = false
      try {
        await signupTeacher({
          name: name.trim(),
          email: email.trim(),
          password,
          courseName: courseName.trim(),
          secretKey,
        })
        created = true
        await signIn(name.trim())
      } catch (err) {
        if (created) {
          setMode('login')
          setError('Your account was created, but signing in failed. Please sign in.')
        } else {
          setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
        }
      } finally {
        setPending(false)
      }
      return
    }

    setPending(true)
    try {
      await signIn(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setPending(false)
    }
  }

  async function handleCaptured(images: Blob[], challengeId: string) {
    setStep('saving')
    setError(null)
    let registered = false
    try {
      const photos = images.map((image, index) => new File([image], `face-${index + 1}.jpg`, { type: 'image/jpeg' }))
      await registerStudent({
        studentId: studentId.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
        photos,
        challengeId,
      })
      registered = true
      const ok = await signIn(name.trim())
      if (!ok) setStep('form')
    } catch (err) {
      if (registered) {
        setMode('login')
        setError('Your account was created, but signing in failed. Please sign in.')
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
      }
      setStep('form')
    }
  }

  function handleCameraError(message: string) {
    setError(message)
    setStep('form')
  }

  if (step === 'camera') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">Face scan</p>
        <FaceCapture onCaptured={handleCaptured} onError={handleCameraError} onCancel={() => setStep('form')} />
      </div>
    )
  }

  if (step === 'saving') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center" role="status">
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
        <p className="text-sm font-medium">Creating your account…</p>
        <p className="text-xs text-muted-foreground">Sending your details and face photos to the server.</p>
      </div>
    )
  }

  const submitLabel = isSignup
    ? isTeacher
      ? 'Create faculty account'
      : 'Continue to face scan'
    : `Sign in to ${isTeacher ? 'faculty' : 'student'} account`

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <AnimatePresence initial={false}>
        {isSignup && (
          <motion.div
            key="signup-top"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-col gap-4 overflow-hidden"
          >
            {!isTeacher && (
              <Field
                id="student-id"
                name="student_id"
                label="Student ID"
                icon={IdCard}
                placeholder="21BCS001"
                autoComplete="off"
                maxLength={50}
                value={studentId}
                onChange={(event) => setStudentId(event.target.value)}
                required
              />
            )}
            <Field
              id={`${role}-name`}
              name="name"
              label="Full name"
              icon={User}
              placeholder="Jordan Lee"
              autoComplete="name"
              maxLength={50}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Field
        id={`${role}-email`}
        name="email"
        type="email"
        label="Email Address"
        icon={Mail}
        placeholder="Enter your email address"
        autoComplete="email"
        maxLength={50}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <Field
        id={`${role}-password`}
        name="password"
        type="password"
        label="Password"
        icon={Lock}
        placeholder="••••••••"
        autoComplete={isSignup ? 'new-password' : 'current-password'}
        minLength={isSignup ? 8 : undefined}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
      />

      <AnimatePresence initial={false}>
        {isSignup && isTeacher && (
          <motion.div
            key="teacher-extra"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-col gap-4 overflow-hidden"
          >
            <Field
              id="teacher-course"
              name="course"
              label="Course name"
              icon={BookOpen}
              placeholder="Python"
              autoComplete="off"
              maxLength={50}
              value={courseName}
              onChange={(event) => setCourseName(event.target.value)}
              required
            />
            <Field
              id="teacher-secret"
              name="secret"
              type="password"
              label="Teacher signup secret"
              icon={KeyRound}
              placeholder="Given by your administrator"
              autoComplete="off"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
              required
            />
          </motion.div>
        )}
      </AnimatePresence>

      {isSignup && !isTeacher && (
        <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-muted-foreground">
          Next, your camera opens and automatically takes {FACE_SNAPSHOT_COUNT} live photos of your face. Sit in good
          light and look straight at the camera. Only one face should be visible.
        </p>
      )}

      <AnimatePresence>
        {error && (
          <motion.p
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <Button
        type="submit"
        disabled={pending}
        className="group mt-1 h-11 rounded-xl bg-primary text-primary-foreground shadow-[0_0_30px_-6px] shadow-primary/70 hover:bg-primary/90"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : isSignup && !isTeacher ? (
          <ScanFace className="size-4" aria-hidden="true" />
        ) : (
          <BadgeCheck className="size-4" aria-hidden="true" />
        )}
        {pending ? 'Verifying…' : submitLabel}
        {!pending && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {isSignup ? 'Already registered?' : 'New here?'}{' '}
        <button
          type="button"
          onClick={() => {
            setMode(isSignup ? 'login' : 'signup')
            setError(null)
          }}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {isSignup ? 'Sign in' : 'Create an account'}
        </button>
      </p>
    </form>
  )
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
}

function Field({ id, label, icon: Icon, className, ...props }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-foreground/80">
        {label}
      </Label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          className={`h-11 rounded-xl border-white/10 bg-white/[0.03] pl-10 transition-shadow focus-visible:border-primary/50 focus-visible:shadow-[0_0_0_4px] focus-visible:shadow-primary/10 dark:bg-white/[0.03] ${className ?? ''}`}
          {...props}
        />
      </div>
    </div>
  )
}