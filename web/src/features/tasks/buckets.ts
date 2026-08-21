import type { Task } from '../../lib/types'
import { isToday, istNow, parseIstNaive } from '../../lib/format'

/**
 * The order tasks are shown in.
 *
 * IN PROGRESS → PREVIOUS → UPCOMING → LATER, which is the product's ordering and
 * not an arbitrary sort. It answers "what am I in the middle of, what did I drop,
 * what is next" in that order, which is the order those questions actually occur.
 *
 * Two things this deliberately does NOT do:
 *
 *  · it does not treat a delegated task as personal. `is_mine` is the test, not
 *    `assigned_to_user_id === me` — that field names only the PRIMARY assignee, so
 *    on a shared task it answers wrong for everyone else. A 307-person cohort task
 *    disappeared from 306 home screens because of exactly that comparison.
 *
 *  · it does not drop undated tasks. An undated task with nowhere to go silently
 *    vanishes, and the user has no way to discover it is missing. They land in
 *    LATER, at the end, where they are visible without being urgent.
 */

export type BucketId = 'in_progress' | 'previous' | 'upcoming' | 'later'

export const BUCKET_META: Record<BucketId, { label: string; hint: string }> = {
  in_progress: { label: 'In progress', hint: 'Started but not finished' },
  previous:    { label: 'Previous',    hint: 'Overdue — still waiting on you' },
  upcoming:    { label: 'Upcoming',    hint: 'Due today' },
  later:       { label: 'Later',       hint: 'Beyond today, or no time set' },
}

export const BUCKET_ORDER: BucketId[] = ['in_progress', 'previous', 'upcoming', 'later']

export function bucketOf(t: Task): BucketId {
  if (t.status === 'in_progress') return 'in_progress'
  const due = parseIstNaive(t.due_at)
  // Overdue is the server's own verdict (`is_overdue`), which accounts for the
  // status. Recomputing it here would let the client and the scheduler disagree
  // about what "overdue" means, and the scheduler is the one sending the reminder.
  if (t.is_overdue) return 'previous'
  if (due && isToday(due)) return 'upcoming'
  return 'later'
}

/** Active work only. Completed and cancelled tasks are not "later" — they are
 *  finished, and mixing them into a list of open work is what makes a task list
 *  feel like a log. */
export const isActive = (t: Task) =>
  t.status !== 'completed' && t.status !== 'cancelled'

/** Earliest first, undated last. An undated task sorted as though it were due at
 *  the epoch would sit above genuinely urgent work. */
export function byDueAsc(a: Task, b: Task): number {
  const da = parseIstNaive(a.due_at)?.getTime()
  const db = parseIstNaive(b.due_at)?.getTime()
  if (da === undefined && db === undefined) {
    // Stable tiebreak on id, so an undated list does not reshuffle on every
    // refetch — visible reordering reads as data changing when nothing has.
    return a.id - b.id
  }
  if (da === undefined) return 1
  if (db === undefined) return -1
  return da - db
}

export function groupTasks(tasks: Task[]): Record<BucketId, Task[]> {
  const out: Record<BucketId, Task[]> = {
    in_progress: [], previous: [], upcoming: [], later: [],
  }
  for (const t of tasks.filter(isActive)) out[bucketOf(t)].push(t)
  for (const k of BUCKET_ORDER) out[k].sort(byDueAsc)
  return out
}

/** Today's timeline: what is due today plus anything already overdue, because an
 *  overdue task IS today's problem. Mirrors the Flutter Today screen, which keeps
 *  one flat time-ordered list rather than categories. */
export function todayTimeline(tasks: Task[]): Task[] {
  return tasks
    .filter(isActive)
    .filter(t => {
      const due = parseIstNaive(t.due_at)
      return t.is_overdue || t.status === 'in_progress' || (due && isToday(due))
    })
    .sort(byDueAsc)
}

/** Finished today — the end-of-day answer to "did I get anywhere". Without it a
 *  day where everything got done looks identical to a day where nothing did:
 *  both show an empty list. */
export function completedToday(tasks: Task[]): Task[] {
  const today = istNow()
  return tasks.filter(t => {
    if (t.status !== 'completed') return false
    const at = parseIstNaive(t.completed_at)
    return at && isToday(at) && at <= today
  })
}
