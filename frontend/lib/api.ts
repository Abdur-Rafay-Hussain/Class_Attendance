import type { AttendanceRecord, AttendanceStatus } from '@/lib/attendance'

export type Role = 'student' | 'teacher'

export interface TokenResponse {
  access_token: string
  token_type: string
}

export interface AuthSession {
  accessToken: string
  tokenType: string
  role: Role
  email: string
  name: string | null
  /** Teacher only: the course ID the backend returned when this teacher signed up in this browser. */
  courseId: number | null
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// All normal HTTP calls go to /api/... on the Next.js server, which forwards them to the FastAPI backend
// (see next.config.mjs). This keeps the browser on one origin, so CORS never blocks a request.
const API_PREFIX = '/api'

// Only used to build the WebSocket address (WebSockets are not subject to CORS).
const BACKEND_ORIGIN = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '')

// Kept in memory only (never localStorage) to limit token exposure; a page reload requires signing in again.
let accessToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export function setAccessToken(token: string | null) {
  accessToken = token
}

/** Called when the backend rejects the stored token (expired or invalid) on an authenticated request. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

interface FastApiValidationIssue {
  msg?: string
  loc?: (string | number)[]
}

function extractErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      const messages = (detail as FastApiValidationIssue[])
        .map((issue) => {
          const field = issue.loc?.filter((part) => part !== 'body').join('.')
          return field ? `${field}: ${issue.msg}` : issue.msg
        })
        .filter(Boolean)
      if (messages.length) return messages.join(' · ')
    }
  }
  if (status >= 500) {
    return `The attendance server did not respond correctly (status ${status}). Check that the backend is running at ${BACKEND_ORIGIN}.`
  }
  if (typeof body === 'string' && body.trim()) return body
  return `Request failed with status ${status}.`
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: BodyInit
  headers?: Record<string, string>
  auth?: boolean
  signal?: AbortSignal
  accept?: string
}

async function send(
  path: string,
  { method = 'GET', body, headers = {}, auth = false, signal, accept = 'application/json' }: RequestOptions = {},
): Promise<Response> {
  const finalHeaders: Record<string, string> = { Accept: accept, ...headers }

  if (auth) {
    if (!accessToken) throw new ApiError('You are not signed in.', 401)
    finalHeaders.Authorization = `Bearer ${accessToken}`
  }

  let response: Response
  try {
    response = await fetch(`${API_PREFIX}${path}`, { method, body, headers: finalHeaders, signal, cache: 'no-store' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(`Cannot reach the attendance server. Check that the backend is running at ${BACKEND_ORIGIN}.`, 0)
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let parsed: unknown = raw
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Not JSON: keep the raw text.
    }
    if (response.status === 401 && auth) {
      unauthorizedHandler?.()
      throw new ApiError('Your session has expired. Please sign in again.', 401)
    }
    throw new ApiError(extractErrorMessage(parsed, response.status), response.status)
  }

  return response
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options)
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError('The server returned a response that could not be read.', 502)
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1]
  if (!segment) return null
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')
    return JSON.parse(atob(base64)) as Record<string, unknown>
  } catch {
    return null
  }
}

function normaliseRole(value: unknown): Role | null {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const lower = values.map((v) => String(v).toLowerCase())
  if (lower.includes('teacher')) return 'teacher'
  if (lower.includes('student')) return 'student'
  return null
}

/** Reads the role the backend embedded in the signed token. The UI role selector is never trusted. */
function roleFromToken(claims: Record<string, unknown> | null): Role | null {
  if (!claims) return null
  for (const key of ['role', 'user_type', 'type', 'scopes', 'scope']) {
    const role = normaliseRole(claims[key])
    if (role) return role
  }
  return null
}

/**
 * The backend sends datetimes without a timezone (they are UTC). Treat a missing timezone as UTC
 * so that times are not shifted by the browser's local timezone.
 */
export function parseServerTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim().replace(/(\.\d{3})\d+/, '$1')
  const hasZone = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(text)
  const ms = Date.parse(hasZone ? text : `${text}Z`)
  return Number.isNaN(ms) ? null : ms
}

// ============================================================
// TEACHER COURSE ID (returned once by POST /Teacher/signup)
// ============================================================

const COURSE_KEY_PREFIX = 'resonance.teacherCourse.'

function readStoredCourseId(email: string): number | null {
  try {
    const raw = localStorage.getItem(COURSE_KEY_PREFIX + email.toLowerCase())
    const id = Number(raw)
    return raw && Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

function storeCourseId(email: string, courseId: number) {
  try {
    localStorage.setItem(COURSE_KEY_PREFIX + email.toLowerCase(), String(courseId))
  } catch {
    // Storage unavailable: the course ID is simply not remembered.
  }
}

// ============================================================
// AUTH
// ============================================================

export async function login(email: string, password: string): Promise<AuthSession> {
  const form = new URLSearchParams({ username: email, password })
  const token = await requestJson<TokenResponse>('/login', {
    method: 'POST',
    body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  if (!token?.access_token) throw new ApiError('The server did not return an access token.', 500)

  const claims = decodeJwtPayload(token.access_token)
  const role = roleFromToken(claims)
  if (!role) {
    throw new ApiError('Signed in, but the server token does not include an account role (teacher or student).', 500)
  }

  setAccessToken(token.access_token)
  const name = typeof claims?.name === 'string' ? claims.name : null
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    role,
    email,
    name,
    courseId: role === 'teacher' ? readStoredCourseId(email) : null,
  }
}

export interface StudentRegistration {
  studentId: string
  name: string
  email: string
  password: string
  photos: File[]
}

export async function registerStudent({ studentId, name, email, password, photos }: StudentRegistration) {
  const form = new FormData()
  // The backend field is spelled exactly "Student_id".
  form.append('Student_id', studentId)
  form.append('name', name)
  form.append('email', email)
  form.append('password', password)
  photos.forEach((photo) => form.append('photos', photo))
  try {
    return await requestJson<{ message?: string }>('/register', { method: 'POST', body: form })
  } catch (error) {
    if (error instanceof ApiError && error.status >= 500) {
      throw new ApiError('Registration failed on the server. The Student ID may already be in use.', error.status)
    }
    throw error
  }
}

export interface TeacherRegistration {
  name: string
  email: string
  password: string
  courseName: string
  secretKey: string
}

/** POST /Teacher/signup — creates the teacher and their course. Returns the new course ID. */
export async function signupTeacher({ name, email, password, courseName, secretKey }: TeacherRegistration) {
  const raw = await requestJson<{ message?: string; course_id?: number }>('/Teacher/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teacher: { name, email, password },
      course: { name: courseName },
      secret_key: secretKey,
    }),
  })

  if (typeof raw.course_id !== 'number') {
    throw new ApiError('The server did not return the course ID.', 502)
  }

  storeCourseId(email, raw.course_id)
  return { message: raw.message, courseId: raw.course_id }
}

export async function enrollInCourse(courseId: string) {
  const id = Number(courseId)
  if (!Number.isInteger(id) || id <= 0) throw new ApiError('Enter a valid numeric course ID.', 400)
  const form = new FormData()
  form.append('course_id', String(id))
  return requestJson<{ message?: string }>('/enroll', { method: 'POST', body: form, auth: true })
}

export function logout() {
  setAccessToken(null)
}

// ============================================================
// ATTENDANCE SESSIONS (TEACHER)
// ============================================================

export interface SessionAudio {
  sessionId: number
  sessionUid: string
  /** Local-clock timestamp (ms) when the session expires. */
  expiresAt: number
  /** Seconds left in the session when the response arrived. */
  durationSeconds: number
  audio: Blob
}

async function readSessionAudio(response: Response, receivedAt: number): Promise<SessionAudio> {
  const idHeader = response.headers.get('X-Session-ID')
  const uidHeader = response.headers.get('X-Session-UID')
  const expiryHeader = parseServerTime(response.headers.get('X-Session-Expiry'))
  const sessionId = Number(idHeader)

  if (!idHeader || !Number.isInteger(sessionId) || !uidHeader || expiryHeader === null) {
    throw new ApiError('The server did not return the session details with the audio.', 502)
  }

  // Use the server's own clock (Date header) so a wrong laptop clock does not break the countdown.
  const serverNow = parseServerTime(response.headers.get('Date')) ?? receivedAt
  const remainingMs = Math.max(0, expiryHeader - serverNow)

  const audio = await response.blob()
  if (audio.size === 0) throw new ApiError('The server returned empty audio.', 502)

  return {
    sessionId,
    sessionUid: uidHeader,
    expiresAt: receivedAt + remainingMs,
    durationSeconds: Math.max(1, Math.round(remainingMs / 1000)),
    audio: audio.type ? audio : new Blob([audio], { type: 'audio/wav' }),
  }
}

/** POST /attendance/start — creates a session and returns the real beacon audio. */
export async function startAttendance(): Promise<SessionAudio> {
  const response = await send('/attendance/start', { method: 'POST', auth: true, accept: 'audio/wav' })
  return readSessionAudio(response, Date.now())
}

/** GET /attendance/audio/{id} — the same beacon audio for an already-active session. */
export async function fetchSessionAudio(sessionId: number): Promise<SessionAudio> {
  const response = await send(`/attendance/audio/${sessionId}`, { accept: 'audio/wav' })
  return readSessionAudio(response, Date.now())
}

export interface SessionStatus {
  sessionId: number
  sessionUid: string
  status: string
  startedAt: number | null
  expiresAt: number | null
  records: AttendanceRecord[]
}

interface RawStatusStudent {
  student_id?: string | number
  student_name?: string | null
  status?: string
  reason?: string
  marked_at?: string
}

interface RawSessionStatus {
  session_id?: number
  session_uid?: string
  status?: string
  started_at?: string
  expires_at?: string
  students?: RawStatusStudent[]
}

const KNOWN_STATUSES: AttendanceStatus[] = ['PRESENT', 'FLAGGED', 'ABSENT']

/** Student IDs are text in the backend (for example "21BCS001"), but older data may still be numeric. */
function normalizeStudentId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function toRecord(
  studentId: unknown,
  studentName: unknown,
  status: unknown,
  reason: unknown,
  markedAt: unknown,
): AttendanceRecord | null {
  const id = normalizeStudentId(studentId)
  if (id === null || !KNOWN_STATUSES.includes(status as AttendanceStatus)) return null
  return {
    id,
    studentId: id,
    name: typeof studentName === 'string' && studentName ? studentName : `Student ${id}`,
    status: status as AttendanceStatus,
    reason: typeof reason === 'string' && reason ? reason : undefined,
    timestamp: parseServerTime(markedAt) ?? Date.now(),
  }
}

/** GET /attendance/status/{id} — every attendance record saved in the database for the session. */
export async function getSessionStatus(sessionId: number): Promise<SessionStatus> {
  const raw = await requestJson<RawSessionStatus>(`/attendance/status/${sessionId}`)
  const records = (raw.students ?? [])
    .map((s) => toRecord(s.student_id, s.student_name, s.status, s.reason, s.marked_at))
    .filter((r): r is AttendanceRecord => r !== null)

  return {
    sessionId: typeof raw.session_id === 'number' ? raw.session_id : sessionId,
    sessionUid: String(raw.session_uid ?? ''),
    status: String(raw.status ?? ''),
    startedAt: parseServerTime(raw.started_at),
    expiresAt: parseServerTime(raw.expires_at),
    records,
  }
}

/** POST /attendance/finish/{id} — closes the session and marks missing students ABSENT. */
export async function finishAttendance(sessionId: number) {
  return requestJson<{ session_id: number; status: string; message?: string }>(`/attendance/finish/${sessionId}`, {
    method: 'POST',
    auth: true,
  })
}

/** WebSocket address of the live attendance feed for a session (the backend does not require auth here). */
export function attendanceSocketUrl(sessionId: number): string {
  return `${BACKEND_ORIGIN.replace(/^http/, 'ws')}/attendance/live/${sessionId}`
}

/** Converts a message from the live WebSocket into a record. Returns null for anything unexpected. */
export function parseAttendanceEvent(data: unknown): AttendanceRecord | null {
  let message: unknown = data
  if (typeof data === 'string') {
    try {
      message = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!message || typeof message !== 'object') return null
  const event = message as Record<string, unknown>
  if (event.type !== 'attendance_update') return null
  return toRecord(event.student_id, event.student_name, event.status, event.reason, event.marked_at)
}

// ============================================================
// MARK ATTENDANCE (STUDENT)
// ============================================================

export interface MarkResult {
  sessionUid: string
  faceMatched: boolean
  message: string
  alreadyProcessed: boolean
  status?: string
  reason?: string
}

interface RawMarkResponse {
  session_id?: number | string
  face_matched?: boolean
  message?: string
  status?: string
  reason?: string
}

/** POST /attendance/mark — real WAV recording + exactly 3 face images. */
export async function markAttendance(audio: Blob, faceImages: Blob[]): Promise<MarkResult> {
  if (faceImages.length !== 3) throw new ApiError('Exactly 3 face images are required.', 400)

  const form = new FormData()
  form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'attendance.wav')
  faceImages.forEach((image, index) => {
    form.append('face_image', new Blob([image], { type: 'image/jpeg' }), `face-${index + 1}.jpg`)
  })

  const raw = await requestJson<RawMarkResponse>('/attendance/mark', { method: 'POST', body: form, auth: true })

  // When attendance was already saved, the backend answers with { status, message } and no face_matched.
  const alreadyProcessed = typeof raw.status === 'string'
  if (!alreadyProcessed && typeof raw.face_matched !== 'boolean') {
    throw new ApiError('The server returned an unexpected check-in response.', 502)
  }

  return {
    sessionUid: String(raw.session_id ?? ''),
    faceMatched: alreadyProcessed ? raw.status === 'PRESENT' : raw.face_matched === true,
    message: raw.message ?? '',
    alreadyProcessed,
    status: raw.status,
    reason: raw.reason,
  }
}