import { formatTime, type AttendanceRecord } from '@/lib/attendance'

const HEADERS = ['Student ID', 'Name', 'Status', 'Reason', 'Time']

function toRows(records: AttendanceRecord[]) {
  return [...records]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) => [r.studentId, r.name, r.status, r.reason ?? '', formatTime(r.timestamp)])
}

function escapeCsv(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

function download(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function baseName(label: string) {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, '-')
  return `attendance-${safeLabel}-${new Date().toISOString().slice(0, 10)}`
}

export function exportCsv(records: AttendanceRecord[], label = 'session') {
  const lines = [HEADERS, ...toRows(records)].map((row) => row.map(escapeCsv).join(','))
  download('\uFEFF' + lines.join('\n'), `${baseName(label)}.csv`, 'text/csv;charset=utf-8')
}

export function exportExcel(records: AttendanceRecord[], label = 'session') {
  const head = HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
  const body = toRows(records)
    .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')
  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></body></html>`
  download(html, `${baseName(label)}.xls`, 'application/vnd.ms-excel')
}