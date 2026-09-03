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

/**
 * A naive-UTC string → a real Date.
 *
 * 🔴 A THIRD CONVENTION, and it is the opposite of parseIstNaive above.
 * `pa_users.last_seen` is stamped `datetime.now(timezone.utc).replace(tzinfo=None)`
 * (`ws/websocket_router.py`) — deliberately UTC, deliberately naive. It is the ONLY
 * timestamp on the wire written that way; messages and notifications go out through
 * `chat_session_service._iso`, which attaches a real offset.
 *
 * Its backend comment says "the client marks server timestamps as UTC" — true of
 * the Flutter client, and false here: per the ES spec a date-time string with no
 * offset is parsed as LOCAL time, so `new Date("2026-08-24T15:06:52")` in a
 * browser on IST reads 3:06 pm when the person was actually last seen at 8:36 pm.
 * Measured against the live DB: every last-seen on the Chats and My Team screens
 * was 5h30m early.
 *
 * Fixed client-side by appending the Z the string is missing. A backend fix would
 * change a field the mobile app already reads correctly.
 */
export function parseUtcNaive(s: string | null | undefined): Date | null {
  if (!s) return null
  // Already carries a zone (…Z, …+05:30) → trust it. Only a bare naive string is
  // assumed UTC, so this stays correct if the backend ever starts sending an offset.
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s.trim())
  const d = new Date(naive ? `${s.trim().replace(' ', 'T')}Z` : s)
  return Number.isNaN(d.getTime()) ? null : d
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

/**
 * Dedicated single-part formatters.
 *
 * 🔴 Do NOT derive these by splitting a composite format. `dayLabel` returns
 * "Fri, 21 Aug" in en-IN, so `.split(' ')[0]` is `"Fri,"` — comma included — and
 * that is what every weekday cell of the calendar's week strip rendered. Part
 * order and punctuation are locale properties; slicing a formatted string is
 * guessing at them.
 */
const fmtWeekday = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', timeZone: 'Asia/Kolkata',
})
const fmtMonthYear = new Intl.DateTimeFormat('en-IN', {
  month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
})
const fmtDayNum = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', timeZone: 'Asia/Kolkata',
})

/** YYYY-MM-DD in IST — the key everything groups by. Built with Intl rather than
 *  slicing an ISO string, because toISOString() is UTC and would file a 6 AM IST
 *  task under the previous day. */
export const istDateKey = (d: Date) => fmtDateKey.format(d)

export const timeLabel = (d: Date) => fmtTime.format(d).toLowerCase()
/** "Fri" — the week-strip column heading. */
export const weekdayLabel = (d: Date) => fmtWeekday.format(d)
/** "21" — the day number, formatted rather than sliced off a date key. */
export const dayNumber = (d: Date) => fmtDayNum.format(d)
/** "August 2026" — the context a week strip needs when it crosses a month. */
export const monthYearLabel = (d: Date) => fmtMonthYear.format(d)
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
export function messageTime(s: string | null | undefined,
                            zone: 'auto' | 'utc' = 'auto'): string {
  if (!s) return ''
  // `zone:'utc'` for last_seen, the one field written naive-UTC. Opt-in rather than
  // the default, because message timestamps already arrive with a real offset and
  // forcing UTC on those would break them in the other direction.
  const d = zone === 'utc' ? parseUtcNaive(s) : new Date(s)
  if (!d || Number.isNaN(d.getTime())) return ''
  return fmtTime.format(d).toLowerCase()
}

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` :
  n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` :
  `${(n / 1024 ** 2).toFixed(1)} MB`

/**
 * "charan" → "Charan", "ALAN turing" → "Alan Turing". "You" stays "You".
 *
 * Ported from the Flutter `titleCaseName`. Names in this database are typed by
 * people at signup, so they arrive lowercase, SHOUTING, or mixed — and a chat list
 * of "charan / ALAN TURING / Priya" reads as broken data rather than as three
 * colleagues.
 */
export function titleCaseName(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/** "today at 5:40 pm" / "yesterday at 5:40 pm" / "19 Aug at 5:40 pm" — the
 *  last-seen line in a DM header. Same shape as the Flutter version. */
export function lastSeenLabel(iso: string | null | undefined): string {
  // parseUtcNaive, NOT new Date — see its comment. This is the field that was wrong.
  const d = parseUtcNaive(iso)
  if (!d) return 'Offline'
  const t = timeLabel(d)
  if (isToday(d)) return `last seen today at ${t}`
  const y = new Date(istNow().getTime() - 86_400_000)
  if (istDateKey(d) === istDateKey(y)) return `last seen yesterday at ${t}`
  return `last seen ${dayLabel(d)} at ${t}`
}

// ── priority ────────────────────────────────────────────────────────────────

/**
 * Is this task's priority worth showing a badge for?
 *
 * The backend stores TWO tiers, `normal` and `critical`, but old rows still carry
 * the legacy `low`/`medium`/`high` and nothing rewrites them. So a screen cannot
 * just test `!== 'medium'` (what the code did before the migration) — against a
 * current backend that is true for EVERY task, which put a grey, meaningless badge
 * on all of them.
 *
 * Only escalation earns a badge. `normal`/`medium`/`low` are the quiet default and
 * say nothing a reader needs; `critical`/`high` is the one that changes behaviour
 * (it is the only tier that gets a reminder at all).
 */
export const isEscalated = (p: string | null | undefined) =>
  p === 'critical' || p === 'high'

/** What to print in the badge. Legacy `high` is shown as `critical` so two tasks
 *  that behave identically don't appear to be different things. */
export const priorityLabel = (p: string | null | undefined) =>
  p === 'high' ? 'critical' : (p ?? '')

/**
 * Is this task genuinely late?
 *
 * 🔴 NOT just `task.is_overdue`. An all-day ("anytime") task carries a due_at only
 * to name the DAY — its time component is a 23:59 placeholder, not a deadline the
 * user chose. So the moment that date rolls past, a task somebody deliberately left
 * untimed gets reported late against a time they never set.
 *
 * Fixed at the source too (main.py now ANDs `not is_all_day` into is_overdue), but
 * kept here as well: an older backend still sends the unguarded flag, and clients
 * cannot assume which build they are talking to. Belt and braces, and it costs one
 * boolean.
 */
export const isReallyOverdue = (t: {
  is_overdue?: boolean; is_all_day?: boolean
}) => !!t.is_overdue && !t.is_all_day

/** "27 Aug" — day and month, no weekday and no year. For the ADDED column on an
 *  anytime task, where the year is noise and the weekday does not fit the width. */
const fmtDayMonth = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
})
export const dayMonthLabel = (d: Date) => fmtDayMonth.format(d)

/**
 * Remove the scheduler's dedup marker from a notification message.
 *
 * The backend appends "[#3662:crit_t15:202609031200]" to the text it STORES, and
 * finds it again with a LIKE to avoid sending the same reminder twice across a
 * restart. So the marker has to stay in the database — it just must never be read
 * by a person. Nothing stripped it on the way out, so every task reminder in the
 * bell ended with a row of internal ids.
 *
 * Done client-side as well as server-side on purpose: this is presentation, the
 * cost is one regex per row, and it keeps working against an older backend that
 * still serves the raw text. Belt and braces for a string no user should ever see.
 *
 * Matches at the END and tolerates both the current `[#id:tier:YYYYMMDDHHMM]` and
 * the older two-part `[#id:tier]` — rows of both shapes exist. Not a global
 * replace: the marker is only ever appended, so a `[#…]` mid-sentence was typed by
 * a person and is theirs to keep.
 */
const DEDUP_MARKER = /\s*\[#\d+:[a-z0-9_]+(?::[a-z0-9]+)?\]\s*$/i

export function stripDedupMarker(s: string | null | undefined): string {
  if (!s) return ''
  return s.replace(DEDUP_MARKER, '').trimEnd()
}
