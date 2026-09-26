import { useEffect, useMemo, useState } from 'react'
import { availability as availabilityApi, ApiError } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { istDateKey, istNow, parseIstNaive, timeLabel } from '../../lib/format'
import { Button, Card, ErrorState, Skeleton, cx } from '../../ui'

const DEFAULT_WORK_START_HOUR = 10
const DEFAULT_WORK_END_HOUR = 18
const DEFAULT_SLOT_MINUTES = 15
const ALLOWED_INTERVALS = [15, 30, 45, 60] as const

/**
 * A day's slot grid — GREEN where the signed-in user is free, RED with a
 * strikethrough where a real meeting already occupies that block, GREY
 * (no click) where the time has already passed today. Backed by the same
 * `GET /internal/calendar/free-slots` and `POST /internal/calendar/
 * set-availability` endpoints built for the WhatsApp Info-Agent's
 * "Call with <person>" flow (see AlumnxAILabs_epa's
 * services/internal_api_router.py) — this tab shows and edits the SAME
 * data a lead booking through WhatsApp would see, so "what does my
 * availability look like" never disagrees between the two surfaces.
 *
 * SAVING IS REAL. Selecting a free range and choosing an interval, then
 * pressing Save, calls `availabilityApi.set()` — which REPLACES every saved
 * range for this user on THIS date (see that call's own docstring). A date
 * with nothing saved keeps using the backend's hardcoded 10:00-18:00 @
 * 15-min default; saving here is what moves a date off that default.
 */
export function AvailabilityTab({ dateKey }: {
  /** "YYYY-MM-DD" — the date currently selected on the Calendar page's month
   *  grid. Re-used here so picking a day once drives both the agenda below
   *  and this tab, rather than the tab keeping its own separate date state. */
  dateKey: string
}) {
  // The backend only ever walks forward from TODAY, never from an arbitrary
  // date (see availabilityApi.freeSlots's own comment) — so covering a date
  // up to 30 days out means asking for that many days and filtering down to
  // just `dateKey` here. Recomputed whenever the picked date changes so a far
  // future pick still requests enough days to reach it.
  const daysNeeded = useMemo(() => {
    const [y, mo, d] = dateKey.split('-').map(Number)
    const target = new Date(Date.UTC(y, mo - 1, d, 12))
    const today = new Date(Date.UTC(
      Number(istDateKey(istNow()).slice(0, 4)),
      Number(istDateKey(istNow()).slice(5, 7)) - 1,
      Number(istDateKey(istNow()).slice(8, 10)), 12))
    const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
    // A past date has no slots to show (the backend never returns them) —
    // clamp to 1 rather than a negative/zero `days` the backend would reject.
    return Math.min(30, Math.max(1, diffDays + 1))
  }, [dateKey])

  const a = useApi(signal => availabilityApi.freeSlots(daysNeeded, signal),
                    [daysNeeded], `availability:${daysNeeded}`)

  // The day's ACTUAL configured ranges (custom if saved, else the backend's
  // default) — a separate call from freeSlots above, because a fully-booked
  // date returns zero free slots and that is indistinguishable from "nothing
  // configured" without asking for the ranges directly. This is what draws
  // the grid's real shape; freeSlots says which of its cells are open.
  const g = useApi(signal => availabilityApi.get(dateKey, signal),
                    [dateKey], `availability-ranges:${dateKey}`)

  // Only THIS date's free slots, keyed by their exact start timestamp.
  const freeStarts = useMemo(() => {
    const set = new Set<string>()
    for (const s of a.data?.slots ?? []) {
      const at = parseIstNaive(s.start)
      if (at && istDateKey(at) === dateKey) set.add(s.start)
    }
    return set
  }, [a.data, dateKey])

  const grid = useMemo(
    () => buildDayGrid(dateKey, g.data?.ranges ?? null),
    [dateKey, g.data])

  const isToday = dateKey === istDateKey(istNow())
  const isPast = (key: string) => {
    if (!isToday) return false
    const at = parseIstNaive(key)
    return !!at && at.getTime() < istNow().getTime()
  }

  // Visual selection — the slot START timestamps currently marked, plus the
  // interval chosen for THIS selection (a fresh pick always restarts the
  // interval choice; there is no "sticky" interval across separate ranges).
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingInterval, setPendingInterval] = useState<number>(DEFAULT_SLOT_MINUTES)
  const [dragAnchor, setDragAnchor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Clear any in-progress selection when the date changes — a half-picked
  // range for one day must never silently carry over and get saved against
  // a different one.
  useEffect(() => { setSelected(new Set()); setSaveError(null) }, [dateKey])

  const selectable = (key: string) => freeStarts.has(key) && !isPast(key)

  const toggleRange = (fromKey: string, toKey: string) => {
    const i0 = grid.findIndex(cell => cell.key === fromKey)
    const i1 = grid.findIndex(cell => cell.key === toKey)
    if (i0 === -1 || i1 === -1) return
    const [lo, hi] = i0 <= i1 ? [i0, i1] : [i1, i0]
    setSelected(prev => {
      const next = new Set(prev)
      for (let i = lo; i <= hi; i++) {
        const slot = grid[i]
        if (selectable(slot.key)) next.add(slot.key)
      }
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  const saveSelection = async () => {
    if (selected.size === 0) return
    // Collapse the selected slot-start set into contiguous [start, end)
    // ranges at the chosen interval — the backend stores RANGES, not
    // individual slots, so a run of adjacent picked cells becomes one range.
    const idxOf = (k: string) => grid.findIndex(cell => cell.key === k)
    const ordered = grid.map(cell => cell.key).filter(k => selected.has(k))
    const ranges: { start: string; end: string; slot_minutes: number }[] = []
    let rangeStart: string | null = null
    let prevIdx = -1
    for (const k of ordered) {
      const idx = idxOf(k)
      if (rangeStart === null) {
        rangeStart = k
      } else if (idx !== prevIdx + 1) {
        ranges.push(makeRange(rangeStart, grid[prevIdx].key, pendingInterval))
        rangeStart = k
      }
      prevIdx = idx
    }
    if (rangeStart !== null) ranges.push(makeRange(rangeStart, grid[prevIdx].key, pendingInterval))

    setSaving(true)
    setSaveError(null)
    try {
      await availabilityApi.set(dateKey, ranges)
      setSelected(new Set())
      // Both calls must refresh — set-availability changed what the RANGES
      // are (g) and, downstream, which slots are free within them (a).
      a.reload()
      g.reload()
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not save availability.')
    } finally {
      setSaving(false)
    }
  }

  if ((a.loading && !a.data) || (g.loading && !g.data)) return <Skeleton rows={4} />
  const loadError = a.error ?? g.error
  if (loadError && !a.data && !g.data) {
    return <ErrorState error={loadError} onRetry={() => { a.reload(); g.reload() }} />
  }

  const selectedCount = selected.size
  return (
    <Card className="p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Availability</div>
          <div className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            {g.data?.custom
              ? 'Custom hours for this date'
              : `${timeLabel(setHour(dateKey, DEFAULT_WORK_START_HOUR))} – ` +
                `${timeLabel(setHour(dateKey, DEFAULT_WORK_END_HOUR))} IST · default hours`}
          </div>
        </div>
        {selectedCount > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-sunken)' }}>
              {ALLOWED_INTERVALS.map(mins => (
                <button
                  key={mins}
                  onClick={() => setPendingInterval(mins)}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold transition"
                  style={pendingInterval === mins
                    ? { background: 'var(--accent)', color: '#fff' }
                    : { color: 'var(--text-muted)' }}
                >
                  {mins}m
                </button>
              ))}
            </div>
            <button onClick={clearSelection}
                    className="text-xs font-medium underline underline-offset-2"
                    style={{ color: 'var(--text-muted)' }}>
              Clear ({selectedCount})
            </button>
            <Button size="sm" variant="primary" onClick={saveSelection} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>

      {saveError && (
        <div className="mb-3 rounded-lg px-3 py-2 text-xs"
             style={{ background: 'rgba(239,68,68,.1)', color: '#DC2626' }}>
          {saveError}
        </div>
      )}

      {grid.length === 0 ? (
        <div className="py-6 text-center text-sm" style={{ color: 'var(--text-subtle)' }}>
          No bookable hours configured for this day.
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {grid.map(slot => {
            const isFree = freeStarts.has(slot.key)
            const past = isPast(slot.key)
            const isSelected = selected.has(slot.key)
            // Three real states, mutually exclusive: PAST wins over BOOKED —
            // a slot that has both already happened AND was never free is
            // still shown as "past" (no action), because "booked" implies
            // there is something to look at, and a gone time is not that.
            const state: 'past' | 'booked' | 'free' =
              past ? 'past' : isFree ? 'free' : 'booked'
            const clickable = state === 'free'
            return (
              <button
                key={slot.key}
                type="button"
                disabled={!clickable}
                onMouseDown={() => { if (clickable) setDragAnchor(slot.key) }}
                onMouseEnter={() => { if (dragAnchor && clickable) toggleRange(dragAnchor, slot.key) }}
                onMouseUp={() => setDragAnchor(null)}
                onClick={() => { if (clickable && !dragAnchor) toggleRange(slot.key, slot.key) }}
                className={cx(
                  'rounded-lg px-1.5 py-2 text-center text-[11px] font-semibold tabular-nums transition',
                  !clickable && 'cursor-not-allowed',
                  state === 'booked' && 'line-through',
                )}
                style={state === 'free'
                  ? (isSelected
                      ? { background: '#15803D', color: '#fff' }
                      : { background: 'rgba(34,197,94,.13)', color: '#15803D' })
                  : state === 'booked'
                    // Same red as TONES.overdue/blocked elsewhere in this app,
                    // plus a strikethrough — "already booked" must read as
                    // clearly blocked, not merely inactive.
                    ? { background: 'rgba(239,68,68,.12)', color: '#DC2626' }
                    // PAST: grey, no strikethrough — a gone time is not an
                    // error state, just nothing to act on any more.
                    : { background: 'var(--bg-sunken)', color: 'var(--text-subtle)', opacity: .6 }}
                title={state === 'free' ? 'Available' : state === 'booked' ? 'Already booked' : 'Already passed'}
              >
                {slot.label}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px]" style={{ color: 'var(--text-subtle)' }}>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded" style={{ background: 'rgba(34,197,94,.13)' }} />
          Free
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded" style={{ background: '#15803D' }} />
          Selected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded" style={{ background: 'rgba(239,68,68,.12)' }} />
          Booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded" style={{ background: 'var(--bg-sunken)' }} />
          Past
        </span>
      </div>
    </Card>
  )
}

/** "HH:MM" boundaries → one AvailabilityRange for the save call. */
function makeRange(fromKey: string, toKeyInclusive: string, slotMinutes: number) {
  const start = fromKey.slice(11, 16)
  // toKeyInclusive is a SLOT START, not the range end — add its own length
  // (the interval being saved, not necessarily what it displayed as before
  // saving) to get the true end of the range.
  const [h, m] = toKeyInclusive.slice(11, 16).split(':').map(Number)
  const endMinutes = h * 60 + m + slotMinutes
  const pad = (n: number) => String(n).padStart(2, '0')
  const end = `${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}`
  return { start, end, slot_minutes: slotMinutes }
}

function setHour(dateKey: string, hour: number): Date {
  const pad = (n: number) => String(n).padStart(2, '0')
  return parseIstNaive(`${dateKey}T${pad(hour)}:00:00`)!
}

/**
 * Every slot in the day's bookable window(s), labelled for display.
 *
 * Built from `savedRanges` when the caller has them (each range's own
 * chosen interval reproduced exactly), or the backend's hardcoded default
 * window otherwise — a day with ZERO free slots (everything booked) still
 * renders its full configured grid, distinguishing "fully booked" from
 * "nothing configured", which sourcing cells directly from the API's
 * `slots` list could not do (an all-booked day would return an empty list
 * either way).
 *
 * The DEFAULT constants mirror the backend's own (_WORK_START_HOUR=10,
 * _WORK_END_HOUR=18, _SLOT_MINUTES=15 in services/internal_api_router.py) —
 * kept in sync by hand since the frontend has no way to ask the backend
 * "what are your default hours" as data yet.
 */
function buildDayGrid(
  dateKey: string,
  savedRanges: { start: string; end: string; slot_minutes: number }[] | null,
): { key: string; label: string }[] {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')

  const windows = savedRanges && savedRanges.length > 0
    ? savedRanges.map(r => {
        const [sh, sm] = r.start.split(':').map(Number)
        const [eh, em] = r.end.split(':').map(Number)
        return { startMin: sh * 60 + sm, endMin: eh * 60 + em, slotMinutes: r.slot_minutes }
      })
    : [{ startMin: DEFAULT_WORK_START_HOUR * 60, endMin: DEFAULT_WORK_END_HOUR * 60,
        slotMinutes: DEFAULT_SLOT_MINUTES }]

  const out: { key: string; label: string }[] = []
  for (const w of windows) {
    let minutesFromMidnight = w.startMin
    while (minutesFromMidnight + w.slotMinutes <= w.endMin) {
      const h = Math.floor(minutesFromMidnight / 60)
      const m = minutesFromMidnight % 60
      const key = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(m)}:00`
      // `key` is an IST-NAIVE wall-clock string, same shape the backend
      // sends — it must go through parseIstNaive, never Date.UTC directly,
      // or timeLabel (which formats via Intl with an explicit Asia/Kolkata
      // zone) re-shifts the hour by the IST offset a second time. See
      // format.ts's own "ONE RULE".
      const label = timeLabel(parseIstNaive(key)!)
      out.push({ key, label })
      minutesFromMidnight += w.slotMinutes
    }
  }
  return out
}
