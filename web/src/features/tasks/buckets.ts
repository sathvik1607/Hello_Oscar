import type { Task } from '../../lib/types'
import {
  dayLabel, isToday, isTomorrow, istDateKey, istNow, parseIstNaive, isReallyOverdue } from '../../lib/format'

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
  if (isReallyOverdue(t)) return 'previous'
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
/**
 * Ordering: CHRONOLOGICAL, then anytime.
 *
 * 🔴 Deliberately NOT priority-first. A critical-first sort was tried and reverted:
 * it reads as wrong on a day view, because a list of times that jumps 3:30pm →
 * 5:00pm → 9:00am is no longer a timeline, and a timeline is what the day view is
 * for. Criticals are already distinguishable — the API refuses a critical without a
 * due_at, so they always carry a real clock time, and lateness turns that time red.
 *
 * ANYTIME (all-day) tasks sort LAST, together. Their due_at is a 23:59 placeholder
 * rather than a chosen hour, so ordering them by it would place them at the end of
 * the timed run and imply a late-evening commitment nobody made. As their own group
 * the list says the honest thing: some time that day, no particular hour.
 *
 * Ties break on id so a list does not reshuffle between refetches — visible
 * reordering reads as data changing when nothing has.
 */
const isAnytime = (t: Task) => !!t.is_all_day

export function byDueAsc(a: Task, b: Task): number {
  if (isAnytime(a) !== isAnytime(b)) return isAnytime(a) ? 1 : -1
  if (isAnytime(a) && isAnytime(b)) return a.id - b.id

  const da = parseIstNaive(a.due_at)?.getTime()
  const db = parseIstNaive(b.due_at)?.getTime()
  if (da === undefined && db === undefined) return a.id - b.id
  if (da === undefined) return 1
  if (db === undefined) return -1
  return da - db || a.id - b.id
}

export function groupTasks(tasks: Task[]): Record<BucketId, Task[]> {
  const out: Record<BucketId, Task[]> = {
    in_progress: [], previous: [], upcoming: [], later: [],
  }
  for (const t of tasks.filter(isActive)) out[bucketOf(t)].push(t)
  for (const k of BUCKET_ORDER) out[k].sort(byDueAsc)
  return out
}

/**
 * Today's timeline: what is due TODAY. One flat, time-ordered list.
 *
 * 🔴 PREVIOUS DAYS' WORK IS NOT INCLUDED, and that is a reversal. This used to pull
 * in everything overdue as well, on the reasoning that an overdue task is still
 * today's problem. In practice it made the screen useless: measured on a real
 * account, 29 of 39 rows were from earlier dates, so "Today" opened on tasks from
 * three days ago and the day's actual work sat below the fold. A day view that is
 * three-quarters not-today is not a day view.
 *
 * `in_progress` is still included whatever its date — work someone has actively
 * started is in play now by definition, and dropping it mid-flight would be worse
 * than showing it a day late.
 *
 * ⚠️ ACCEPTED COST: a task due yesterday and untouched no longer appears here. It is
 * not lost — it is in Tasks and on the Calendar under its own date — but nothing
 * SURFACES it any more, because the backend's roll-forward is disabled
 * (`_roll_over_previous_dues` is commented out of the scheduler loop), so its due_at
 * never moves on its own. Surfacing stale work again means either re-enabling that
 * or giving this screen its own "earlier" section; both are deliberate product
 * decisions rather than something to slip in here.
 */
export function todayTimeline(tasks: Task[]): Task[] {
  return tasks
    .filter(isActive)
    .filter(t => {
      const due = parseIstNaive(t.due_at)
      return t.status === 'in_progress' || (due && isToday(due))
    })
    .sort(byDueAsc)
}

/** Finished today — the end-of-day answer to "did I get anywhere". Without it a
 *  day where everything got done looks identical to a day where nothing did:
 *  both show an empty list. */
export function completedToday(tasks: Task[]): Task[] {
  const today = istNow()
  return tasks
    .filter(t => {
      if (t.status !== 'completed') return false
      const at = parseIstNaive(t.completed_at)
      return at && isToday(at) && at <= today
    })
    // 🔴 SORTED, like todayTimeline above — this was the one bucket that filtered and
    // then returned whatever order the API happened to give, which is id order. On a
    // real day it rendered 6:35, 5:30, 5:30, 5:00, 7:00 and read as a bug.
    //
    // By DUE time, not completed_at, because the due time is what the card actually
    // prints (dueLabel(due) in TaskCard). Sorting on a field the row does not show
    // would leave it looking just as unordered.
    .sort(byDueAsc)
}


/**
 * DATE sections, with due time ascending inside each.
 *
 * 🔴 STATUS NO LONGER DECIDES WHERE A TASK GOES. `bucketOf` above put anything
 * `in_progress` into its own section first, so a task started this morning left
 * Today's list and appeared under a status heading — two different questions
 * ("when is this due", "how far along is it") answered by one axis. Status is a
 * FILTER now; the day owns the ordering.
 *
 * Sections, top to bottom:
 *   Overdue     past its time and still open — the only one that is a problem
 *   Today · Tomorrow
 *   a named day  "Mon 25 Aug", ascending — soonest first
 *   No date      cannot be late, so it sits after everything dated
 *
 * Keyed on istDateKey, the IST calendar day, so a task due 23:30 stays on its own
 * date instead of being pushed into the next one by the browser's offset.
 */
export type DateSection = { key: string; label: string; tasks: Task[] }

export function groupByDueDate(tasks: Task[]): DateSection[] {
  const out: (DateSection & { rank: number })[] = []
  const find = (key: string, label: string, rank: number) => {
    let g = out.find(x => x.key === key)
    if (!g) { g = { key, label, rank, tasks: [] }; out.push(g) }
    return g
  }
  const todayKey = istDateKey(istNow())
  for (const t of tasks) {
    const due = parseIstNaive(t.due_at)
    const key = due ? istDateKey(due) : null
    if (!key)                     find('none', 'No date', 5).tasks.push(t)
    else if (isToday(due))        find('today', 'Today', 1).tasks.push(t)
    else if (isTomorrow(due))     find('tomorrow', 'Tomorrow', 2).tasks.push(t)
    // FUTURE and PAST are separate ranks, not one bucket of "other dates". They sort
    // in opposite directions, so sharing a rank made that impossible to express.
    else if (key > todayKey)      find(key, dayLabel(due!), 3).tasks.push(t)
    else                          find(key, dayLabel(due!), 4).tasks.push(t)
  }
  // Strictly by due time inside every section — status never affects this.
  for (const g of out) g.tasks.sort(byDueAsc)
  return out
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      // 🔴 PAST DATES SORT DESCENDING — the bug this replaced. Every non-today date
      // shared one rank and was compared with localeCompare ascending, so the Done
      // view opened on 7 Jul and worked forwards: the oldest history first, with the
      // days you actually care about buried at the bottom.
      //
      // The two directions are not a preference. A future date answers "what is
      // next", so nearest first. A past date answers "what just happened", so most
      // recent first. istDateKey is YYYY-MM-DD, which sorts lexically as it sorts
      // chronologically, so one comparator serves both.
      return a.rank === 4 ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key)
    })
    .map(({ key, label, tasks }) => ({ key, label, tasks }))
}
