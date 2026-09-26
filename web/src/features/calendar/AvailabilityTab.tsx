import { useEffect, useMemo, useState } from 'react'
import { availability as availabilityApi, ApiError } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { istDateKey, istNow, parseIstNaive, timeLabel } from '../../lib/format'
import type { Meeting } from '../../lib/types'
import { Button, Card, ErrorState, Skeleton, cx } from '../../ui'

const DEFAULT_WORK_START_HOUR = 10
const DEFAULT_WORK_END_HOUR = 18
const DEFAULT_SLOT_MINUTES = 15
const ALLOWED_INTERVALS = [15, 30, 45, 60] as const

/**
 * A day's slot grid — GREEN where the signed-in user is free, BLUE where a
 * range is already saved as available, RED with a strikethrough where a
 * real meeting occupies that block, GREY (no click) where the time has
 * already passed today.
 *
 * 🔴 BOOKED is computed from real MEETINGS directly (the `meetings` prop,
 * the same list CalendarScreen already fetches for its Agenda view), NOT
 * from `GET /internal/calendar/free-slots`. That endpoint answers a
 * DIFFERENT question — "what can Shiva's WhatsApp bot offer a lead" — and
 * once ANY custom range is saved for a date, it deliberately narrows to
 * ONLY the saved ranges (the person's real bookable hours). Reusing it here
 * would make every slot OUTSIDE a just-saved range look "booked" the moment
 * you save your first range — exactly the bug this rewrite fixes. This
 * editing UI needs a wider question — "is there a genuine conflict here" —
 * answered independently of whatever's saved, so a person can keep adding
 * more availability across multiple Saves.
 *
 * SAVING IS REAL and ADDITIVE. Selecting a free range and choosing an
 * interval, then pressing Save, calls `availabilityApi.set()` — which ADDS
 * to whatever ranges are already saved for this date (see that call's own
 * docstring); it never wipes out an earlier Save. The grid always shows the
 * FULL default 10:00-18:00 window as the base shape, regardless of what's
 * already saved, so a person can keep selecting more time on the same date
 * across multiple Saves — a slot already covered by a saved range renders
 * as its own SAVED state (blue), distinct from a real meeting (red/booked),
 * so it's visibly locked in but never confusable with "someone else took
 * this slot".
 */
export function AvailabilityTab({ dateKey, meetings }: {
  /** "YYYY-MM-DD" — the date currently selected on the Calendar page's month
   *  grid. Re-used here so picking a day once drives both the agenda below
   *  and this tab, rather than the tab keeping its own separate date state. */
  dateKey: string
  /** CalendarScreen's own already-fetched meeting list — reused rather than
   *  a second API call, and it's what determines which slots are genuinely
   *  BOOKED (see the component docstring). */
  meetings: Meeting[]
}) {
  // The day's ACTUAL configured ranges (custom if saved, else the backend's
  // default) — used to draw the SAVED overlay and the header subtitle.
  const g = useApi(signal => availabilityApi.get(dateKey, signal),
                    [dateKey], `availability-ranges:${dateKey}`)

  // Real meeting conflicts for THIS date, as [startMinutes, endMinutes)
  // pairs on the day's own clock — independent of anything saved.
  const busyRanges = useMemo(() => {
    const out: [number, number][] = []
    for (const m of meetings) {
      if (m.status === 'cancelled' || m.status === 'completed') continue
      const start = parseIstNaive(m.scheduled_at)
      if (!start || istDateKey(start) !== dateKey) continue
      const end = parseIstNaive(m.ends_at) ?? new Date(start.getTime() + 30 * 60_000)
      const [sh, sm] = m.scheduled_at!.slice(11, 16).split(':').map(Number)
      const durationMin = Math.round((end.getTime() - start.getTime()) / 60_000)
      out.push([sh * 60 + sm, sh * 60 + sm + durationMin])
    }
    return out
  }, [meetings, dateKey])

  const isBusy = (key: string) => {
    const [ch, cm] = key.slice(11, 16).split(':').map(Number)
    const cellStart = ch * 60 + cm
    const cellEnd = cellStart + DEFAULT_SLOT_MINUTES
    return busyRanges.some(([bs, be]) => bs < cellEnd && be > cellStart)
  }

  // Always the FULL default window — see the component docstring for why
  // this no longer switches to the saved ranges' own shape. Saved ranges are
  // overlaid as a separate visual state (see `savedAt` below), not used to
  // replace what the grid covers.
  const grid = useMemo(() => buildDayGrid(dateKey), [dateKey])

  // "Free" = not genuinely busy (a real meeting conflict) — see the
  // component docstring for why this is sourced from `meetings` rather than
  // `GET /internal/calendar/free-slots`.
  const freeStarts = useMemo(() => {
    const set = new Set<string>()
    for (const cell of grid) {
      if (!isBusy(cell.key)) set.add(cell.key)
    }
    return set
  }, [grid, busyRanges])

  // Which grid slots fall inside an ALREADY-SAVED range — checked by minute
  // offset, not by exact key match, since a saved range's own interval
  // (e.g. 30-min) may not line up with the grid's 15-min cells one-to-one;
  // a cell counts as "saved" if its own [start, start+15) falls within any
  // saved [range start, range end).
  const savedAt = useMemo(() => {
    const set = new Set<string>()
    // 🔴 g.data.ranges is ALWAYS non-empty — it's the default 10:00-18:00
    // window when nothing is custom-saved (see availabilityApi.get's own
    // docstring). Gating on `custom` here is load-bearing: without it, every
    // slot in the default window would render as "already saved" even when
    // NOTHING has actually been saved yet, which is exactly the bug this
    // whole rewrite exists to fix.
    if (!g.data?.custom) return set
    const ranges = g.data.ranges
    for (const cell of grid) {
      // The key's OWN "HH:MM" substring, not a re-derived Date — reading
      // hour/minute back off a constructed IST-naive Date via .getHours()
      // would read the BROWSER's local clock, not IST (same trap
      // format.ts's "ONE RULE" warns about); the string already has the
      // exact digits we need.
      const [ch, cm] = cell.key.slice(11, 16).split(':').map(Number)
      const cellMin = ch * 60 + cm
      for (const r of ranges) {
        const [sh, sm] = r.start.split(':').map(Number)
        const [eh, em] = r.end.split(':').map(Number)
        if (cellMin >= sh * 60 + sm && cellMin < eh * 60 + em) {
          set.add(cell.key)
          break
        }
      }
    }
    return set
  }, [grid, g.data])

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

  const selectable = (key: string) => freeStarts.has(key) && !isPast(key) && !savedAt.has(key)

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
      g.reload()
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : 'Could not save availability.')
    } finally {
      setSaving(false)
    }
  }

  if (g.loading && !g.data) return <Skeleton rows={4} />
  if (g.error && !g.data) {
    return <ErrorState error={g.error} onRetry={g.reload} />
  }

  const selectedCount = selected.size
  return (
    <Card className="p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Availability</div>
          <div className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            {`${timeLabel(setHour(dateKey, DEFAULT_WORK_START_HOUR))} – ` +
              `${timeLabel(setHour(dateKey, DEFAULT_WORK_END_HOUR))} IST`}
            {g.data?.custom && ` · ${g.data.ranges.length} range${g.data.ranges.length === 1 ? '' : 's'} saved`}
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
            const saved = savedAt.has(slot.key)
            const isSelected = selected.has(slot.key)
            // Four states, mutually exclusive, checked in this priority
            // order: PAST wins over everything — a slot that already
            // happened is never actionable regardless of what else is true
            // about it. Then SAVED — already locked in by an earlier Save,
            // shown distinctly from a real meeting so it never reads as
            // "someone else took this", but still not re-selectable (saving
            // the same minute twice would try to re-add an overlapping
            // range and the backend would reject it). Then BOOKED (a real
            // meeting) vs FREE (open, and clickable to start a new range).
            const state: 'past' | 'saved' | 'booked' | 'free' =
              past ? 'past' : saved ? 'saved' : isFree ? 'free' : 'booked'
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
                  : state === 'saved'
                    // Blue — distinct from both green/free (this is already
                    // committed, not just open) and red/booked (this is a
                    // deliberate choice the person made, not a meeting
                    // blocking them).
                    ? { background: 'rgba(59,130,246,.14)', color: '#3B82F6' }
                    : state === 'booked'
                      // Same red as TONES.overdue/blocked elsewhere in this
                      // app, plus a strikethrough — "already booked" must
                      // read as clearly blocked, not merely inactive.
                      ? { background: 'rgba(239,68,68,.12)', color: '#DC2626' }
                      // PAST: grey, no strikethrough — a gone time is not an
                      // error state, just nothing to act on any more.
                      : { background: 'var(--bg-sunken)', color: 'var(--text-subtle)', opacity: .6 }}
                title={state === 'free' ? 'Available' : state === 'saved' ? 'Already set as available'
                  : state === 'booked' ? 'Already booked' : 'Already passed'}
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
          <span className="size-2.5 rounded" style={{ background: 'rgba(59,130,246,.14)' }} />
          Saved
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
 * Every slot in the day's DEFAULT bookable window, labelled for display —
 * always this shape, regardless of what's already saved for the date (see
 * the component docstring). Saved ranges are overlaid separately via
 * `savedAt`, not used to change what this grid covers, so a person can
 * always select more time within normal hours across multiple Saves.
 *
 * The DEFAULT constants mirror the backend's own (_WORK_START_HOUR=10,
 * _WORK_END_HOUR=18, _SLOT_MINUTES=15 in services/internal_api_router.py) —
 * kept in sync by hand since the frontend has no way to ask the backend
 * "what are your default hours" as data yet.
 */
function buildDayGrid(dateKey: string): { key: string; label: string }[] {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const pad = (n: number) => String(n).padStart(2, '0')

  const startMin = DEFAULT_WORK_START_HOUR * 60
  const endMin = DEFAULT_WORK_END_HOUR * 60
  const slotMinutes = DEFAULT_SLOT_MINUTES

  const out: { key: string; label: string }[] = []
  {
    let minutesFromMidnight = startMin
    while (minutesFromMidnight + slotMinutes <= endMin) {
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
      minutesFromMidnight += slotMinutes
    }
  }
  return out
}
