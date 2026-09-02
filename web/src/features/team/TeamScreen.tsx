import { useEffect, useMemo, useState } from 'react'
import { Circle, Users } from 'lucide-react'
import { team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import { getUser, identityIsStale, signOutStaleIdentity } from '../../lib/session'
import {
  dayLabel, isPast, isToday, isTomorrow, istDateKey, messageTime, parseIstNaive,
} from '../../lib/format'
import { resolvePresence, usePresence } from '../../lib/presence'
import type { Task } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import { byDueAsc } from '../tasks/buckets'
import { TaskCard } from '../tasks/TaskCard'
import { TaskDetail } from '../tasks/TaskDetail'
import { useUnreadComments } from '../tasks/useUnreadComments'
import {
  Card, EmptyState, ErrorState, SectionHeading, Skeleton, cx,
} from '../../ui'

/**
 * Who is on what.
 *
 * The team's PROJECT tasks, filtered by `is_project` — not by "is it delegated".
 * That client-side filter is what used to drop self-assigned tasks (including every
 * RFQ task) off this view while the server was returning them correctly.
 *
 * Presence rides on the members list rather than a dedicated endpoint: `online` is
 * derived live from the server's WebSocket registry, and `last_seen` is stamped when
 * a member's LAST socket disconnected. It is not a login time — nothing records
 * logins — and it is null while they are online, which is why "Online" and a
 * timestamp are mutually exclusive here.
 */
export function TeamScreen() {
  const me = getUser()
  const teamId = me?.team_id
  /**
   * Opens on the WORKSPACE, not on you.
   *
   * 🔴 This was reversed, and defaulting to your own tasks was wrong for the screen
   * it is on. My Team answers "who is on what" — everyone ELSE'S work is the reason
   * to open it, and your own is already the entire Today and Tasks screens. Landing
   * here on your own 100 rows made it a third copy of a screen you have twice, with
   * the team's work one tap away and invisible until you took it.
   *
   * `null` means the workspace (every member's project tasks). Picking a member from
   * the roster still narrows to that person, which is what the roster is for.
   */
  const [selected, setSelected] = useState<number | null>(null)
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // Unread comments per task — the badge and the glow on each card, and the
  // clear when one is opened. See useUnreadComments: derived from the bell rows
  // because no per-viewer read state exists on pa_task_comments.
  const comments = useUnreadComments()

  const members = useApi(
    s => teamId ? teamApi.members(teamId, s) : Promise.resolve([]), [teamId])
  const projects = useApi(
    s => teamId ? teamApi.projectTasks(teamId, s) : Promise.resolve({ count: 0, tasks: [] }),
    [teamId])
  const memberTasks = useApi(
    s => teamId && selected
      ? teamApi.memberTasks(teamId, selected, s)
      : Promise.resolve({ count: 0, tasks: [] }),
    [teamId, selected])

  // 🔴 This screen had NO live wiring at all, so a teammate completing a task or a
  // new project task appearing showed nothing until you navigated away and back —
  // on the one screen whose whole purpose is watching other people's work.
  useLiveData(ITEM_FRAMES,
              () => { projects.reload(); memberTasks.reload(); members.reload() },
              { invalidatePrefixes: [...ITEM_CACHES, 'members'] })

  /**
   * The cached identity belongs to a DIFFERENT backend's database — sign out.
   *
   * Detected off the roster this screen already loads: if the signed-in id is not in
   * its own team's member list, `oscar.web.user` is stale (see identityIsStale). The
   * symptom without this is a red "Member not in this team" card on a healthy team,
   * because `selected` defaults to the cached id and that id exists nowhere here.
   *
   * Signing out is the honest response: a token minted against another database
   * still verifies, so the session cannot be repaired in place — only re-established
   * against the backend now in use.
   */
  useEffect(() => {
    // Two independent signals, because neither alone is sufficient.
    //
    // (1) The ROSTER says our id is not on our own team. Authoritative when it has
    //     loaded — but `members` carries no cache key, so `.data` is null on the
    //     first paint and this cannot be the only trigger.
    //
    // (2) 🔴 The member-tasks call actually 404'd "Member not in this team". This is
    //     the signal that matters: it is the request that FAILED, it is what puts
    //     the red card on screen, and it needs nothing else to have loaded first.
    //     Matched on the backend's own wording (main.py raises exactly this), and
    //     guarded on `selected === me.id` so a lead clicking a teammate who really
    //     did leave the team is NOT signed out — that 404 is legitimate and about
    //     somebody else.
    const rosterSaysNo = identityIsStale(members.data)
    const ownTasks404 = !!memberTasks.error
      && /member not in this team/i.test(memberTasks.error)
      && selected === me?.id
    if (rosterSaysNo || ownTasks404) signOutStaleIdentity()
  }, [members.data, memberTasks.error, selected, me?.id])

  // Live presence, overlaid on the fetched roster — see lib/presence.ts.
  const live = usePresence()

  const roster = useMemo(
    () => (members.data ?? [])
      .filter(m => m.is_active)
      .map(m => ({ ...m, ...resolvePresence(live, m.user_id, m) }))
      // Online first, then alphabetical. Sorting by join date puts whoever
      // registered first at the top forever, which carries no information.
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [members.data, live])

  /**
   * 🔴 SORTED. This list was rendered in whatever order the API returned, which is
   * id order — so a team's projects came out by when they were created and looked
   * shuffled. It was the last list in the app still doing that; Today, Tasks and the
   * calendar all order their rows.
   *
   * Open work first, by due date, using the SAME comparator as everywhere else
   * (byDueAsc from buckets.ts — it already handles undated tasks and breaks ties on
   * id so the list does not reshuffle on every refetch). Finished work sinks to the
   * bottom: on a team view the question is what is still outstanding, and a completed
   * task sitting between two live ones answers a question nobody asked.
   */
  const shown = useMemo(() => {
    const raw = selected ? (memberTasks.data?.tasks ?? []) : (projects.data?.tasks ?? [])
    const closed = (t: Task) => t.status === 'completed' || t.status === 'cancelled'
    return [...raw].sort((a, b) =>
      Number(closed(a)) - Number(closed(b)) || byDueAsc(a, b))
  }, [selected, memberTasks.data, projects.data])
  const activeShown = shown.filter(t => t.status !== 'cancelled')

  /**
   * Grouped by DUE DAY, with the day named.
   *
   * A flat list gives no sense of when anything lands — and this workspace really has
   * 300 project tasks. Dated headings turn it into "what is on today, what is
   * tomorrow, what has slipped".
   *
   * Four headings, in the order they matter:
   *   Overdue          past its time and still open — first, always
   *   Today / Tomorrow
   *   a named day      "Mon 25 Aug"
   *   Done · <day>     finished work, by the day it was due, last of all
   *
   * 🔴 There is no "No date" heading, open or done. A heading with no day in it is
   * not a group, it is a pile — nothing about an undated row says when it matters,
   * so it could only grow and never resolve. Those tasks are untouched and still
   * visible on Tasks and in the member's own list; they are just not part of a view
   * about who is doing what this week.
   *
   * Keyed on istDateKey, the IST calendar day, so a task at 23:30 stays on its own
   * date instead of being pushed into the next one by the browser's offset.
   */
  const groups = useMemo(() => {
    const isClosed = (t: Task) => t.status === 'completed' || t.status === 'cancelled'
    const out: { key: string; label: string; rank: number; tasks: Task[] }[] = []
    const find = (key: string, label: string, rank: number) => {
      let g = out.find(x => x.key === key)
      if (!g) { g = { key, label, rank, tasks: [] }; out.push(g) }
      return g
    }
    for (const t of activeShown) {
      const due = parseIstNaive(t.due_at)
      if (isClosed(t)) {
        // 🔴 FINISHED WORK IS GROUPED BY DAY TOO, not piled into one bucket. As a
        // single group it was 83 tasks spanning weeks, and because the list is sorted
        // by full datetime the visible times cycled — 08:00, 20:11, 08:00, 12:00 —
        // which reads as unsorted even though it is not.
        //
        // Undated finished work is DROPPED, for the same reason the open "No date"
        // group went: a heading with no day in it is not a group, it is a pile, and
        // on a screen about who is doing what this week it answers nothing. Finished
        // AND undated is the least useful row on the page.
        if (!due) continue
        find(`done-${istDateKey(due)}`,
             isToday(due) ? 'Done today' : `Done · ${dayLabel(due)}`,
             4).tasks.push(t)
      }
      // 🔴 UNDATED WORK IS NOT SHOWN. It had its own "No date" group, which was a
      // place tasks went to be forgotten: nothing about a row with no date says
      // when it matters, so the group could only ever grow. Dropped rather than
      // folded into a dated group, because guessing a date for someone else's task
      // is worse than leaving it out of this view — it is still on Tasks and in
      // that member's own list.
      else if (!due)            continue
      else if (isPast(due) && !isToday(due))
                                find('overdue', 'Overdue', 0).tasks.push(t)
      else if (isToday(due))    find('today', 'Today', 1).tasks.push(t)
      else if (isTomorrow(due)) find('tomorrow', 'Tomorrow', 1).tasks.push(t)
      else                      find(istDateKey(due), dayLabel(due), 2).tasks.push(t)
    }
    /**
     * Rank first, then the day — but the day sorts in OPPOSITE directions either side
     * of the split, because "next" and "latest" are different questions:
     *
     *   open work (ranks 0-2)   ASCENDING  — soonest first, what needs doing next
     *   finished work (rank 4)  DESCENDING — most recent day first, what just landed
     *
     * Times inside every group stay ascending, from the byDueAsc sort upstream.
     */
    return out.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      if (a.rank === 4) return b.key.localeCompare(a.key)      // newest day on top
      if (a.key === 'today') return -1
      if (b.key === 'today') return 1
      return a.key.localeCompare(b.key)
    })
  }, [activeShown])
  const selectedMember = roster.find(m => m.user_id === selected)
  /** "Your tasks", not "Sathvik's tasks" — reading your own name back at you in a
   *  heading is the same noise as "To: you" on your own task card. */
  const headingName = selectedMember
    ? (selectedMember.user_id === me?.id ? 'Your' : `${selectedMember.name}'s`)
    : null

  if (!teamId) {
    return (
      <Card>
        <EmptyState
          icon={<Users className="size-6" />}
          title="You're not in a workspace"
          body="Team views appear once you join one with an invite code."
        />
      </Card>
    )
  }

  return (
    <div className="space-y-7">
      {/* ── roster ───────────────────────────────────────────────────── */}
      <section>
        {/* "Members", not the team name. The name was on screen THREE times — this
            heading, the workspace card below it, and the task heading further down
            — which is how "ALUMNX AI LABS / ALUMNX AI LABS / ALUMNX AI LABS ·
            PROJECT TASKS" ended up reading as three different things. The team name
            belongs in the header, not repeated down the page. */}
        <SectionHeading count={roster.length}>Members</SectionHeading>
        {members.loading && !members.data && <Skeleton rows={2} />}
        {members.error && <ErrorState error={members.error} onRetry={members.reload} />}

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {/* 🔴 THE WORKSPACE IS A CARD IN THE ROSTER, and it is selected by default.
              `selected === null` already meant "the whole workspace" — that was the
              default all along — but nothing on screen SAID so: every member card sat
              unselected and the heading below just changed wording. A default with no
              visible state reads as nothing being selected.
              First in the grid, so the reading order is "the team, then the people in
              it", and tapping it is the way back from a member without hunting for a
              clear button. */}
          <button
            onClick={() => setSelected(null)}
            aria-pressed={selected === null}
            className="flex items-center gap-3 rounded-[var(--radius-card)] border p-3 text-left transition"
            style={selected === null
              ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)' }
              : { background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <div className="grid size-[34px] shrink-0 place-items-center rounded-full"
                 style={{ background: 'var(--accent)', color: '#fff' }}>
              <Users className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium">
                {me.team_name ?? 'Workspace'}
              </div>
              <div className="truncate text-[11.5px]" style={{ color: 'var(--text-subtle)' }}>
                {/* "project tasks" is our own database word (pa_items.is_project) and
                    means nothing to a reader. What the card actually selects is
                    everyone's work at once. */}
                Everyone
              </div>
            </div>
          </button>

          {roster.map(m => {
            const isSel = selected === m.user_id
            return (
              <button
                key={m.user_id}
                // Tapping the selected member clears the filter — a filter you can
                // only escape by finding a "clear" button is a trap.
                onClick={() => setSelected(isSel ? null : m.user_id)}
                aria-pressed={isSel}
                className={cx('flex items-center gap-3 rounded-[var(--radius-card)] border p-3 text-left transition')}
                style={isSel
                  ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)' }
                  : { background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
              >
                <div className="relative">
                  <Avatar name={m.name} size={34} />
                  {m.online && (
                    <Circle className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full"
                            fill="#22C55E" strokeWidth={0}
                            style={{ outline: '2px solid var(--bg-elevated)' }} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">
                    {m.user_id === me.id ? `${m.name} (you)` : m.name}
                  </div>
                  <div className="truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                    {m.online
                      ? 'Online'
                      : m.last_seen ? `Last seen ${messageTime(m.last_seen, 'utc')}`
                      : m.role === 'team_lead' ? 'Lead' : 'Offline'}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── tasks ────────────────────────────────────────────────────── */}
      <section>
        <SectionHeading count={activeShown.length}>
          {/* Whose work is shown, and nothing else. Was
              "ALUMNX AI LABS · PROJECT TASKS" — the team name for a third time,
              plus a column name from our schema. */}
          {headingName ? `${headingName}'s tasks` : 'Everyone'}
        </SectionHeading>

        {(projects.loading || memberTasks.loading) && <Skeleton rows={3} />}
        {projects.error && !selected && (
          <ErrorState error={projects.error} onRetry={projects.reload} />
        )}
        {memberTasks.error && !!selected && (
          <ErrorState error={memberTasks.error} onRetry={memberTasks.reload} />
        )}

        {!projects.loading && !memberTasks.loading && activeShown.length === 0 && (
          <Card>
            <EmptyState
              title={headingName
                ? (headingName === 'Your' ? 'You have nothing open'
                   : `${selectedMember?.name} has nothing open`)
                : 'No team projects'}
              body={selectedMember
                ? 'Tasks assigned to them will show here.'
                : 'Project tasks shared across the workspace appear here.'}
            />
          </Card>
        )}

        {groups.map(g => (
          <div key={g.key} className="mb-5">
            {/* The day, then how many land on it. Overdue is the only heading that is
                a problem rather than a fact, so it is the only one coloured. */}
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="text-[12px] font-semibold uppercase tracking-[.08em]"
                    style={{ color: g.key === 'overdue' ? '#DC2626' : 'var(--text-muted)' }}>
                {g.label}
              </span>
              <span className="rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums"
                    style={{ background: 'var(--bg-sunken)', color: 'var(--text-subtle)' }}>
                {g.tasks.length}
              </span>
            </div>
            <div className="space-y-2">
              {g.tasks.map(t => (
                <TaskCard key={t.id} task={t}
                          // Read-only from here: completing somebody else's task from
                          // a roster view is almost always a mis-tap, and it notifies
                          // them.
                          onToggle={() => setOpenTask(t)}
                          onOpen={() => { comments.markSeen(t.id); setOpenTask(t) }}
                        unreadComments={comments.byItem.get(t.id)}
                          showAssignee />
              ))}
            </div>
          </div>
        ))}
      </section>

      {openTask && (
        <TaskDetail task={openTask} onClose={() => setOpenTask(null)}
                    onChanged={() => { projects.reload(); memberTasks.reload() }} />
      )}
    </div>
  )
}
