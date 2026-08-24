import type { Task } from '../../lib/types'

/**
 * Which of the user's tasks an Oscar reply is talking about.
 *
 * Oscar answers "you have 30 tasks due today" and then lists them as bullets —
 * `• {title} — 8:00 AM`. The titles are right there in the text, and the client
 * already holds the task list, so the cards can be derived with NO backend change:
 * no new endpoint, no new WebSocket frame, and nothing added to the agent or the
 * fast path. The reply is matched against data the app already has.
 *
 * 🔴 ORDERED BY WHERE THE TITLE APPEARS IN THE TEXT, not by the list's own order.
 * The cards sit directly under the sentence that names them, so any other ordering
 * reads as a different set of tasks from the one just described.
 *
 * 🔴 LONGEST TITLE FIRST, and a matched span is CONSUMED. With "Call Madhavi" and
 * "Call Madhavi and ask her to register", the short one is a substring of the long
 * one — so matching short-first tags the wrong task and then finds the long one
 * again at the same place, producing two cards for one bullet. Same failure mode as
 * the @mention resolver, and this project already has a wrong-recipient incident
 * from loose name matching.
 */

/** Below this, a title is too generic to match on safely. "Pay" or "Call" would hit
 *  almost any reply that mentions paying or calling, and a card for a task the
 *  sentence never mentioned is worse than a missing card. */
const MIN_TITLE_LEN = 5

export function matchReplyTasks(text: string, tasks: Task[]): Task[] {
  if (!text) return []
  const low = text.toLowerCase()
  // Marks characters already claimed by a longer title, so a shorter title cannot
  // match inside a span that has already been attributed.
  const used = new Array(low.length).fill(false)

  const hits: { at: number; task: Task }[] = []

  for (const t of [...tasks].sort(
    (a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0)
  )) {
    const title = (t.title ?? '').trim().toLowerCase()
    if (title.length < MIN_TITLE_LEN) continue

    let from = 0
    for (;;) {
      const at = low.indexOf(title, from)
      if (at < 0) break
      let free = true
      for (let i = at; i < at + title.length; i++) if (used[i]) { free = false; break }
      if (free) {
        for (let i = at; i < at + title.length; i++) used[i] = true
        hits.push({ at, task: t })
        break
      }
      from = at + 1
    }
  }

  return hits.sort((a, b) => a.at - b.at).map(h => h.task)
}
