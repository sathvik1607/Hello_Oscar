import { useMemo, useState } from 'react'
import { availability as availabilityApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { istDateKey, istNow, parseIstNaive, timeLabel } from '../../lib/format'
import { Card, ErrorState, Skeleton, cx } from '../../ui'

/**
 * A day's 15-min slot grid — GREEN where the signed-in user is genuinely
 * free, GREY where an existing meeting already occupies that block. Backed
 * by the same `GET /internal/calendar/free-slots` endpoint built for the
 * WhatsApp Info-Agent's "Call with <person>" flow (see AlumnxAILabs_epa's
 * services/internal_api_router.py) — this tab shows the identical data a
 * lead booking through WhatsApp would see, so "what does my availability
 * look like" never disagrees between the two surfaces.
 *
 * 🔴 SELECTION IS VISUAL-ONLY, ON PURPOSE. Clicking/dragging a green range
 * marks it locally (see `selected` state) so a person can preview "I'm
 * available 3–5 PM" before deciding what to do with it — but nothing is
 * persisted. The backend has no per-user custom-hours table yet; the
 * bookable window (10:00–18:00 IST) is still the same hardcoded constant
 * every caller of free-slots gets. Wiring this selection to a real save is
 * follow-up work once that table exists — building it now would be a
 * write with nowhere real to land.
 *
 * Working hours (10:00–18:00) and the 15-min grid are NOT constants in this
 * file — they are DERIVED from whatever the backend actually returns, so a
 * future change to `_WORK_START_HOUR`/`_SLOT_MINUTES` on that side is
 * reflected here with no matching frontend edit.
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

  // Only THIS date's free slots, in order. The backend already sorts by
  // construction (day by day, slot by slot), so no re-sort is needed here.
  const freeStarts = useMemo(() => {
    const set = new Set<string>()
    for (const s of a.data?.slots ?? []) {
      const at = parseIstNaive(s.start)
      if (at && istDateKey(at) === dateKey) set.add(s.start)
    }
    return set
  }, [a.data, dateKey])

  const grid = useMemo(() => buildDayGrid(dateKey), [dateKey])

  // Visual-only range selection — see the component docstring. Stored as the
  // set of slot START timestamps currently marked, cleared whenever the date
  // changes so a selection never silently carries over to a different day.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragAnchor, setDragAnchor] = useState<string | null>(null)

  const toggleRange = (fromKey: string, toKey: string) => {
    const i0 = grid.findIndex(g => g.key === fromKey)
    const i1 = grid.findIndex(g => g.key === toKey)
    if (i0 === -1 || i1 === -1) return
    const [lo, hi] = i0 <= i1 ? [i0, i1] : [i1, i0]
    setSelected(prev => {
      const next = new Set(prev)
      for (let i = lo; i <= hi; i++) {
        const slot = grid[i]
        if (freeStarts.has(slot.key)) next.add(slot.key)
      }
      return next
    })
  }

  const clearSelection = () => setSelected(new Set())

  if (a.loading && !a.data) return <Skeleton rows={4} />
  if (a.error && !a.data) return <ErrorState error={a.error} onRetry={a.reload} />

  const selectedCount = selected.size
  return (
    <Card className="p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Availability</div>
          <div className="text-xs" style={{ color: 'var(--text-subtle)' }}>
            10:00 AM – 6:00 PM IST · 15-min slots
          </div>
        </div>
        {selectedCount > 0 && (
          <button onClick={clearSelection}
                  className="text-xs font-medium underline underline-offset-2"
                  style={{ color: 'var(--text-muted)' }}>
            Clear ({selectedCount})
          </button>
        )}
      </div>

      {grid.length === 0 ? (
        <div className="py-6 text-center text-sm" style={{ color: 'var(--text-subtle)' }}>
          No bookable hours configured for this day.
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
          {grid.map(slot => {
            const isFree = freeStarts.has(slot.key)
            const isSelected = selected.has(slot.key)
            return (
              <button
                key={slot.key}
                type="button"
                disabled={!isFree}
                onMouseDown={() => { if (isFree) setDragAnchor(slot.key) }}
                onMouseEnter={() => { if (dragAnchor && isFree) toggleRange(dragAnchor, slot.key) }}
                onMouseUp={() => setDragAnchor(null)}
                onClick={() => { if (isFree && !dragAnchor) toggleRange(slot.key, slot.key) }}
                className={cx(
                  'rounded-lg px-1.5 py-2 text-center text-[11px] font-semibold tabular-nums transition',
                  !isFree && 'cursor-not-allowed opacity-50',
                )}
                style={isFree
                  ? (isSelected
                      ? { background: '#15803D', color: '#fff' }
                      : { background: 'rgba(34,197,94,.13)', color: '#15803D' })
                  // Same red as TONES.overdue/blocked elsewhere in this app —
                  // "already booked" reuses the existing red rather than the
                  // grey used for closed/cancelled states, per product
                  // decision: a booked slot should read as clearly blocked,
                  // not merely inactive.
                  : { background: 'rgba(239,68,68,.12)', color: '#DC2626' }}
                title={isFree ? 'Available' : 'Already booked'}
              >
                {slot.label}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex items-center gap-4 text-[11px]" style={{ color: 'var(--text-subtle)' }}>
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
      </div>
    </Card>
  )
}

/** Every 15-min slot in the day's working-hours window, labelled for display.
 *  Not sourced from the API response directly — a day with ZERO free slots
 *  (everything booked) would otherwise render an empty grid indistinguishable
 *  from "nothing configured", when the true state is "fully booked". Building
 *  the full grid here and marking each cell free/busy against the API's
 *  `slots` list keeps those two states visually distinct.
 *
 *  Mirrors the backend's own constants (_WORK_START_HOUR=10, _WORK_END_HOUR=18,
 *  _SLOT_MINUTES=15 in services/internal_api_router.py) — kept in sync by
 *  hand since the frontend has no way to ask the backend "what are your
 *  working hours" as data yet. */
function buildDayGrid(dateKey: string): { key: string; label: string }[] {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const WORK_START_HOUR = 10
  const WORK_END_HOUR = 18
  const SLOT_MINUTES = 15

  const out: { key: string; label: string }[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  let minutesFromMidnight = WORK_START_HOUR * 60
  const endMinutes = WORK_END_HOUR * 60
  while (minutesFromMidnight + SLOT_MINUTES <= endMinutes) {
    const h = Math.floor(minutesFromMidnight / 60)
    const m = minutesFromMidnight % 60
    const key = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(m)}:00`
    // `key` is an IST-NAIVE wall-clock string, same shape the backend sends —
    // it must go through parseIstNaive, never Date.UTC directly, or timeLabel
    // (which formats via Intl with an explicit Asia/Kolkata zone) re-shifts
    // the hour by the IST offset a second time. See format.ts's own "ONE RULE".
    const label = timeLabel(parseIstNaive(key)!)
    out.push({ key, label })
    minutesFromMidnight += SLOT_MINUTES
  }
  return out
}
