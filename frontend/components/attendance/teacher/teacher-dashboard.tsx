'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, CalendarClock, Hash } from 'lucide-react'
import { SessionControl, type SessionStatus } from '@/components/attendance/teacher/session-control'
import { LiveProgress } from '@/components/attendance/teacher/live-progress'
import { ActivityStream } from '@/components/attendance/teacher/activity-stream'
import { ExportControls } from '@/components/attendance/teacher/export-controls'
import {
  ApiError,
  attendanceSocketUrl,
  fetchSessionAudio,
  finishAttendance,
  getSessionStatus,
  parseAttendanceEvent,
  startAttendance,
} from '@/lib/api'
import { DEFAULT_SESSION_SECONDS, type AttendanceRecord } from '@/lib/attendance'

interface ActiveSession {
  id: number
  uid: string
}

interface StoredSession extends ActiveSession {
  expiresAt: number
  durationSeconds: number
}

// Lets the teacher resume a running session after a page refresh (the backend has no "list sessions" endpoint).
const STORAGE_KEY = 'resonance.activeSession'

function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredSession>
    if (
      typeof parsed.id === 'number' &&
      typeof parsed.uid === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      typeof parsed.durationSeconds === 'number'
    ) {
      return parsed as StoredSession
    }
  } catch {
    // Storage unavailable or corrupted: ignore.
  }
  return null
}

function writeStoredSession(value: StoredSession) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage unavailable: resuming after refresh simply will not work.
  }
}

function clearStoredSession() {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}

function mergeRecords(previous: AttendanceRecord[], incoming: AttendanceRecord[]) {
  const byStudent = new Map<string, AttendanceRecord>()
  for (const record of previous) byStudent.set(record.studentId, record)
  for (const record of incoming) byStudent.set(record.studentId, record)
  return [...byStudent.values()].sort((a, b) => b.timestamp - a.timestamp)
}

function messageFrom(error: unknown) {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
}

interface TeacherDashboardProps {
  userName: string
  /** Course ID returned by the backend when this teacher signed up in this browser (null if unknown). */
  courseId: number | null
}

export function TeacherDashboard({ userName, courseId }: TeacherDashboardProps) {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const [durationSeconds, setDurationSeconds] = useState(DEFAULT_SESSION_SECONDS)
  const [session, setSession] = useState<ActiveSession | null>(null)
  const [connected, setConnected] = useState(false)
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [finalized, setFinalized] = useState(false)
  const [busy, setBusy] = useState(false)
  const [beaconPlaying, setBeaconPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sessionRef = useRef<ActiveSession | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const startingRef = useRef(false)
  const stoppingRef = useRef(false)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  // ----------------------------------------------------------
  // Beacon audio (real WAV returned by the backend)
  // ----------------------------------------------------------
  const releaseBeacon = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.onplay = null
      audio.onpause = null
      audio.onended = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    audioRef.current = null
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = null
    }
    setBeaconPlaying(false)
  }, [])

  const playBeacon = useCallback(
    async (blob: Blob) => {
      releaseBeacon()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.preload = 'auto'
      audio.volume = 1
      audio.onplay = () => setBeaconPlaying(true)
      audio.onpause = () => setBeaconPlaying(false)
      audio.onended = () => setBeaconPlaying(false)
      audioRef.current = audio
      audioUrlRef.current = url
      try {
        await audio.play()
      } catch {
        setBeaconPlaying(false)
        setError('The browser blocked audio playback. Press "Play beacon" to start the ultrasonic beacon.')
      }
    },
    [releaseBeacon],
  )

  const toggleBeacon = useCallback(async () => {
    setError(null)
    const audio = audioRef.current
    if (audio) {
      if (audio.paused) {
        try {
          await audio.play()
        } catch {
          setError('The browser blocked audio playback. Check the laptop volume and browser sound permissions.')
        }
      } else {
        audio.pause()
      }
      return
    }

    // Session was resumed after a refresh: download the beacon audio again.
    const current = sessionRef.current
    if (!current) return
    try {
      const data = await fetchSessionAudio(current.id)
      await playBeacon(data.audio)
    } catch (err) {
      setError(messageFrom(err))
    }
  }, [playBeacon])

  useEffect(() => releaseBeacon, [releaseBeacon])

  // ----------------------------------------------------------
  // Resume a running session after a page refresh
  // ----------------------------------------------------------
  useEffect(() => {
    const stored = readStoredSession()
    if (!stored) return
    if (stored.expiresAt <= Date.now()) {
      clearStoredSession()
      return
    }

    let cancelled = false
    getSessionStatus(stored.id)
      .then((result) => {
        if (cancelled) return
        if (result.status !== 'active') {
          clearStoredSession()
          return
        }
        const resumed = { id: stored.id, uid: stored.uid }
        sessionRef.current = resumed
        setSession(resumed)
        setEndsAt(stored.expiresAt)
        setDurationSeconds(stored.durationSeconds)
        setRecords(mergeRecords([], result.records))
        setFinalized(false)
        setStatus('live')
      })
      .catch(() => {
        if (!cancelled) clearStoredSession()
      })

    return () => {
      cancelled = true
    }
  }, [])

  // ----------------------------------------------------------
  // Live WebSocket feed
  // ----------------------------------------------------------
  const sessionId = session?.id ?? null

  useEffect(() => {
    if (status !== 'live' || sessionId === null) return

    let closed = false
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let ping: ReturnType<typeof setInterval> | null = null

    const connect = () => {
      if (closed) return
      const ws = new WebSocket(attendanceSocketUrl(sessionId))
      socket = ws

      ws.onopen = () => {
        if (closed) return
        setConnected(true)
        // Catch up on anything saved while the socket was not connected.
        getSessionStatus(sessionId)
          .then((result) => {
            if (!closed) setRecords((prev) => mergeRecords(prev, result.records))
          })
          .catch(() => {})
        ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        }, 25_000)
      }

      ws.onmessage = (event) => {
        const record = parseAttendanceEvent(event.data)
        if (record) setRecords((prev) => mergeRecords(prev, [record]))
      }

      ws.onclose = () => {
        if (ping) clearInterval(ping)
        ping = null
        if (closed) return
        setConnected(false)
        retry = setTimeout(connect, 2000)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      if (ping) clearInterval(ping)
      socket?.close()
      setConnected(false)
    }
  }, [status, sessionId])

  // ----------------------------------------------------------
  // Start / stop
  // ----------------------------------------------------------
  const startSession = useCallback(async () => {
    if (startingRef.current || stoppingRef.current) return
    startingRef.current = true
    setBusy(true)
    setError(null)
    try {
      const started = await startAttendance()
      const next = { id: started.sessionId, uid: started.sessionUid }
      sessionRef.current = next
      setSession(next)
      setRecords([])
      setFinalized(false)
      setEndsAt(started.expiresAt)
      setDurationSeconds(started.durationSeconds)
      setStatus('live')
      writeStoredSession({ ...next, expiresAt: started.expiresAt, durationSeconds: started.durationSeconds })
      await playBeacon(started.audio)
    } catch (err) {
      setError(messageFrom(err))
    } finally {
      startingRef.current = false
      setBusy(false)
    }
  }, [playBeacon])

  const stopSession = useCallback(async () => {
    const current = sessionRef.current
    if (!current || stoppingRef.current) return
    stoppingRef.current = true
    setBusy(true)
    setError(null)

    try {
      await finishAttendance(current.id)
    } catch (err) {
      setError(messageFrom(err))
      stoppingRef.current = false
      setBusy(false)
      return
    }

    releaseBeacon()
    clearStoredSession()
    setStatus('ended')
    setEndsAt(null)

    // Students who never checked in are saved as ABSENT by the backend when the session is finished.
    try {
      const final = await getSessionStatus(current.id)
      setRecords((prev) => mergeRecords(prev, final.records))
      setFinalized(true)
    } catch (err) {
      setError(`The session was finished, but the final attendance list could not be loaded. ${messageFrom(err)}`)
    }

    stoppingRef.current = false
    setBusy(false)
  }, [releaseBeacon])

  const present = records.filter((r) => r.status === 'PRESENT').length
  const flagged = records.filter((r) => r.status === 'FLAGGED').length
  const absent = records.filter((r) => r.status === 'ABSENT').length

  return (
    <div className="flex flex-col gap-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"
      >
        <div>
          <p className="text-sm text-muted-foreground">Welcome,</p>
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{userName}</h1>
        </div>
        <ul className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <li
            className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5"
            title="Students need this number to enroll in your course"
          >
            <BookOpen className="size-3.5 text-primary" aria-hidden="true" />
            {courseId !== null ? `Course ID ${courseId} — share with students` : 'Course ID not available here'}
          </li>
          <li className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
            <CalendarClock className="size-3.5 text-primary" aria-hidden="true" />
            {session ? `Session #${session.id}` : 'No session started'}
          </li>
          {session && (
            <li className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5">
              <Hash className="size-3.5 text-primary" aria-hidden="true" />
              {session.uid}
            </li>
          )}
        </ul>
      </motion.div>

      <AnimatePresence>
        {error && (
          <motion.p
            role="alert"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 gap-4 md:grid-flow-dense md:grid-cols-2 lg:grid-cols-12 lg:gap-5">
        <SessionControl
          className="md:col-span-2 lg:col-span-7"
          status={status}
          endsAt={endsAt}
          durationSeconds={durationSeconds}
          busy={busy}
          beaconPlaying={beaconPlaying}
          onStart={startSession}
          onStop={stopSession}
          onToggleBeacon={toggleBeacon}
        />
        <LiveProgress
          className="md:col-span-1 lg:col-span-5"
          present={present}
          flagged={flagged}
          absent={absent}
          finalized={finalized}
        />
        <ActivityStream
          className="md:col-span-2 lg:col-span-8"
          records={records}
          live={status === 'live'}
          connected={connected}
        />
        <ExportControls
          className="md:col-span-1 lg:col-span-4"
          records={records}
          label={session ? `session-${session.id}` : 'session'}
        />
      </div>
    </div>
  )
}