export type AttendanceStatus = 'PRESENT' | 'FLAGGED' | 'ABSENT'

export interface AttendanceRecord {
  id: string
  studentId: string
  name: string
  status: AttendanceStatus
  reason?: string
  timestamp: number
}

// Values below come directly from the backend code (gen_audio.py and attendance.py).

/** Digit tones are 4.0 kHz + 60 Hz per digit, and the start marker is 4.8 kHz (see gen_audio.py). */
export const BEACON_LABEL = '4.0–4.8 kHz'

/**
 * Frequency band kept when the recording is cleaned before upload: a little wider than the beacon tones.
 * If BASE_FREQUENCY or MARKER_FREQUENCY in the backend gen_audio.py change, change these two numbers
 * and BEACON_LABEL as well.
 */
export const BEACON_BAND_LOW_HZ = 3_700
export const BEACON_BAND_HIGH_HZ = 5_000

/** The backend creates every session with a 2 minute lifetime (SESSION_DURATION = 2 in gen_audio.py). */
export const DEFAULT_SESSION_SECONDS = 120

/** The backend requires exactly 3 face images for every check-in. */
export const FACE_SNAPSHOT_COUNT = 3

export function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}