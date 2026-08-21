/**
 * Dates.
 *
 * 🔴 THE ONE RULE: `due_at`, `scheduled_at` and `ends_at` are IST-NAIVE. The
 * backend writes the IST wall-clock with no timezone suffix, so `new Date(due_at)`
 * reinterprets those digits in the BROWSER's zone — an 8:10 PM task displays as
 * 1:40 AM for anyone outside India, and as the wrong DAY either side of midnight.
 * Every read of those three fields goes through parseIstNaive().
 *
 * `created_at` / `updated_at` are a different case (UTC from MySQL), and chat
 * timestamps are a third (the app process's own clock, which is UTC on Render and
 * IST locally, with existing rows a genuine mixture). Chat is therefore ordered by
 * id, never by time — see api.chat.history.
 */

const IST_OFFSET_MIN = 5 * 60 + 30

/** An IST-naive string → a real Date pointing at that IST instant. */
export function parseIstNaive(s: string | null | undefined): Date | null {
  if (!s) return null
  // Tolerate both "2026-08-21T18:30:00" and "2026-08-21 18:30:00".
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const [, y, mo, d, h, mi, se] = m
  return new Date(Date.UTC(
    +y, +mo - 1, +d, +h, +mi, +(se ?? 0)) - IST_OFFSET_MIN * 60_000)
}

/** A Date → the IST-naive string the backend expects back. Never send an ISO
 *  string with a Z or an offset for these fields; the backend would store the
 *  digits verbatim and the task would be born hours off. */
export function toIstNaive(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}` +
    `T${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`
}

/** "Now", as an IST wall-clock Date — the reference every comparison uses, so the
 *  app agrees with the server about what "today" and "overdue" mean regardless of
 *  where the browser is. */
export function istNow(): Date {
  return new Date()
}

const fmtTime = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
})
const fmtDay = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
})
const fmtFull = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata',
})
const fmtDateKey = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata',
})

/** YYYY-MM-DD in IST — the key everything groups by. Built with Intl rather than
 *  slicing an ISO string, because toISOString() is UTC and would file a 6 AM IST
 *  task under the previous day. */
export const istDateKey = (d: Date) => fmtDateKey.format(d)

export const timeLabel = (d: Date) => fmtTime.format(d).toLowerCase()
export const dayLabel = (d: Date) => fmtDay.format(d)
export const fullDayLabel = (d: Date) => fmtFull.format(d)

export const isToday = (d: Date | null) =>
  !!d && istDateKey(d) === istDateKey(istNow())

export const isTomorrow = (d: Date | null) => {
  if (!d) return false
  const t = new Date(istNow().getTime() + 86_400_000)
  return istDateKey(d) === istDateKey(t)
}

export const isPast = (d: Date | null) => !!d && d.getTime() < istNow().getTime()

/** Human date for a due time: "6:30 pm" today, "Tomorrow 9 am", else "Fri 5 Sep". */
export function dueLabel(d: Date | null): string {
  if (!d) return 'No time set'
  if (isToday(d)) return timeLabel(d)
  if (isTomorrow(d)) return `Tomorrow ${timeLabel(d)}`
  return `${dayLabel(d)} · ${timeLabel(d)}`
}

/** "3h overdue" / "in 25m". Coarse on purpose: a countdown to the second turns a
 *  calm list into something that demands attention every tick. */
export function relative(d: Date | null): string {
  if (!d) return ''
  const diff = d.getTime() - istNow().getTime()
  const past = diff < 0
  const mins = Math.round(Math.abs(diff) / 60_000)
  const body =
    mins < 1 ? 'now' :
    mins < 60 ? `${mins}m` :
    mins < 60 * 24 ? `${Math.round(mins / 60)}h` :
    `${Math.round(mins / (60 * 24))}d`
  if (body === 'now') return 'now'
  return past ? `${body} overdue` : `in ${body}`
}

/** Chat/message timestamps. These carry an explicit offset from the server
 *  (chat_session_service._iso), so they can be parsed normally — the IST-naive
 *  rule does NOT apply here, and applying it would shift them by 5½ hours. */
export function messageTime(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return fmtTime.format(d).toLowerCase()
}

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` :
  n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` :
  `${(n / 1024 ** 2).toFixed(1)} MB`
