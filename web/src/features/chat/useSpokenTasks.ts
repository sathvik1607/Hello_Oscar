import { useCallback, useEffect, useMemo, useState } from 'react'
import { tasks as tasksApi, team as teamApi } from '../../lib/api'
import { getUser } from '../../lib/session'
import { matchReplyTasks } from './replyTasks'
import type { Task } from '../../lib/types'

/**
 * The pool of tasks an Oscar reply can be matched against, and the matcher over it.
 *
 * 🔴 `GET /tasks/{user_id}` IS NOT ENOUGH, and that was a real hole. It returns what
 * the user CREATED plus what is ASSIGNED to them — so when Oscar answers "Sriram has
 * three tasks due today" or lists the team's work, none of those tasks are in the
 * pool and the panel silently shows nothing. Worse than an empty panel: the reply
 * clearly named tasks, so the cards look broken rather than absent.
 *
 * Three existing endpoints, deduped by id. No new endpoint, and nothing that the
 * app was not already entitled to read:
 *
 *   /tasks/{uid}                  mine — created by me, or assigned to me
 *   /tasks/{uid}/assigned-by-me   what I delegated to teammates
 *   /teams/{tid}/tasks?project=1  the team's project tasks
 *
 * The team call is skipped entirely for a user with no team, so a personal account
 * makes two requests, not three, and never a 404.
 *
 * Shared by the chat screen and the voice overlay ON PURPOSE. Two copies of "which
 * tasks can a reply name" is two places for the answer to differ, and the whole
 * point of the panel is that it agrees with what Oscar just said.
 */
export function useSpokenTasks() {
  const teamId = getUser()?.team_id ?? null
  const [pool, setPool] = useState<Task[]>([])

  const load = useCallback(async (signal?: AbortSignal) => {
    // allSettled, not all: a personal account, a lead-only endpoint or one slow call
    // must not empty the whole pool. Whatever answers is better than nothing.
    const calls = [
      tasksApi.mine(signal),
      tasksApi.assignedByMe(signal),
      ...(teamId ? [teamApi.projectTasks(teamId, signal)] : []),
    ]
    const res = await Promise.allSettled(calls)
    const seen = new Set<number>()
    const merged: Task[] = []
    for (const r of res) {
      if (r.status !== 'fulfilled') continue
      for (const t of r.value.tasks ?? []) {
        if (!seen.has(t.id)) { seen.add(t.id); merged.push(t) }
      }
    }
    // An aborted reload resolves with nothing; keeping the old pool is better than
    // blanking a panel the user is looking at.
    if (merged.length > 0 || !signal?.aborted) setPool(merged)
  }, [teamId])

  useEffect(() => {
    const ac = new AbortController()
    void load(ac.signal)
    return () => ac.abort()
  }, [load])

  /** Optimistic patch, so a checkbox in the panel does not wait for a refetch. */
  const patch = useCallback((fn: (p: { tasks: Task[] }) => { tasks: Task[] }) => {
    setPool(prev => fn({ tasks: prev }).tasks)
  }, [])

  const reload = useCallback(() => { void load() }, [load])

  return { pool, patch, reload }
}

/** The tasks a specific reply names, resolved against the live pool. */
export function useNamedTasks(reply: string | null | undefined, pool: Task[]) {
  return useMemo(() => matchReplyTasks(reply ?? '', pool), [reply, pool])
}
