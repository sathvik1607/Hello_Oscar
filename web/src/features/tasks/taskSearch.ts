import type { Task } from '../../lib/types'
import { STATUS_LABEL } from '../../ui'

/**
 * Free-text search over a task list.
 *
 * The Tasks screen is where every task in the product is reachable, so this is the
 * one control that has to look past the screen's own framing: the status filter, the
 * date sections, and the fact that the default list is only work assigned to YOU.
 *
 * EVERY TERM MUST MATCH, ACROSS ANY FIELD. Not "any term matches" — with a
 * hundreds-of-rows list an OR search returns almost everything for a two-word query
 * and reads as broken. `sriram ppt` means the Sriram one about a PPT, which is how
 * anyone types a search and is only expressible as AND.
 *
 * Terms match a SUBSTRING, not a prefix and not a whole word, so "camp" finds
 * "DataCamp" — a task title is prose, and people remember fragments of it.
 *
 * Case- and accent-insensitive via NFD folding, because the roster has real names
 * with diacritics and nobody types them.
 */

/** Case, accents and surrounding space removed, so comparisons are on shape alone. */
const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/**
 * Everything about one task that a person might search BY, as one folded string.
 *
 * Built per task per query rather than cached on the row: the list is bounded by the
 * server's 2000-row cap, this runs on keystrokes over an already-materialised array,
 * and a cache keyed on a mutable row is a staleness bug waiting for the next live
 * update to arrive.
 *
 * The fields, and why each is here:
 *   title / description   what people actually remember
 *   assigned_to_name      "assigned to" — who has to do it
 *   assignees[].name      the REST of a shared task's roster; the legacy column
 *                         names only the primary assignee, so without this a
 *                         307-person task is searchable by exactly one of them
 *   owner_name            "assigned by" — who handed it over
 *   status                so "done" and "cancelled" are typeable, using the SAME
 *                         words the card prints (STATUS_LABEL) rather than the raw
 *                         enum; a user searches what they can see
 *   priority              "critical" reads off the badge the same way
 *   due_label             the server's own human date ("Tomorrow", "28 Aug"), which
 *                         is what the row shows — so a date can be searched as it
 *                         appears rather than as an ISO string nobody sees
 */
function haystack(t: Task): string {
  const names = (t.assignees ?? []).map(a => a.name).filter(Boolean)
  return fold([
    t.title,
    t.description ?? '',
    t.assigned_to_name ?? '',
    ...names,
    t.owner_name ?? '',
    STATUS_LABEL[t.status] ?? t.status,
    t.status,
    t.priority ?? '',
    t.due_label ?? '',
  ].join('  '))
}

/**
 * Split on whitespace. A quoted phrase is kept whole, so `"data camp"` is one term —
 * the escape hatch for when AND-ing the words apart is too loose.
 */
export function searchTerms(query: string): string[] {
  const out: string[] = []
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = fold(m[1] ?? m[2] ?? '')
    if (term) out.push(term)
  }
  return out
}

/** True when every term appears somewhere in the task. An empty query matches all. */
export function matchesTask(t: Task, terms: string[]): boolean {
  if (!terms.length) return true
  const hay = haystack(t)
  return terms.every(term => hay.includes(term))
}

/**
 * Filter, keeping the caller's order.
 *
 * Deliberately NOT re-sorted by relevance. The list's date sections are the
 * screen's organising idea and a search is a filter on it, not a different view —
 * a relevance sort would drop the results out of their days and answer "which of
 * these is most like what I typed", a question nobody asked.
 */
export function filterTasks(tasks: Task[], query: string): Task[] {
  const terms = searchTerms(query)
  if (!terms.length) return tasks
  return tasks.filter(t => matchesTask(t, terms))
}

/**
 * De-dupe by id, first occurrence winning.
 *
 * Searching spans several requests (your own work, everything you delegated, the
 * completed list) and they OVERLAP by design — a task you assigned to someone and
 * then finished is in all three. Without this the same row renders two and three
 * times and the count lies.
 */
export function dedupeById(lists: (Task[] | undefined)[]): Task[] {
  const seen = new Set<number>()
  const out: Task[] = []
  for (const list of lists) {
    for (const t of list ?? []) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
  }
  return out
}
