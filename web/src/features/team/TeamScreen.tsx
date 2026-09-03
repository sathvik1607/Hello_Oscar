import { useEffect, useMemo, useState } from 'react'
import { Circle, Plus, Users } from 'lucide-react'
import { team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import { getUser, identityIsStale, signOutStaleIdentity } from '../../lib/session'
import {
  isToday, istDateKey, istNow, messageTime, parseIstNaive,
} from '../../lib/format'
import { resolvePresence, usePresence } from '../../lib/presence'
import type { Task } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import { byDueAsc } from '../tasks/buckets'
import { NewTaskSheet } from '../tasks/NewTaskSheet'
import { TaskCard } from '../tasks/TaskCard'
import { TaskDetail } from '../tasks/TaskDetail'
import { useUnreadComments } from '../tasks/useUnreadComments'
import {
  Button, Card, EmptyState, ErrorState, SectionHeading, Skeleton, cx,
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
  const [creating, setCreating] = useState(false)
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
    /**
     * 🔴 THIS SCREEN IS TODAY ONLY — the workspace and a picked member alike.
     *
     * My Team answers "who is on what", and that is a question about right now.
     * The workspace view was a planning view instead: 216 tasks across weeks,
     * with today's four rows sitting below two months of slipped work and above
     * everything still ahead. Nobody scrolls that to find out what the team is
     * doing today, and Tasks and the calendar already exist for the long view.
     *
     * Today by the IST calendar day (istDateKey, the same basis as the grouping
     * below), so a task at 23:30 stays on its own date rather than being pushed
     * over by the browser's offset. Undated tasks fall out here as well — the
     * grouping was already dropping them, and a task with no date is not "today".
     */
    const scoped = raw.filter(t => isToday(parseIstNaive(t.due_at)))
    const closed = (t: Task) => t.status === 'completed' || t.status === 'cancelled'
    return [...scoped].sort((a, b) =>
      Number(closed(a)) - Number(closed(b)) || byDueAsc(a, b))
  }, [selected, memberTasks.data, projects.data])
  const activeShown = shown.filter(t => t.status !== 'cancelled')

  /**
   * Two headings: Today, then Done today.
   *
   * The list is a single day (see `shown`), so the only split left worth drawing is
   * open versus finished. This was four dated headings — Overdue, Today/Tomorrow, a
   * named day, and a Done group per day — which is what the multi-week list it used
   * to be actually needed.
   *
   * 🔴 Undated tasks are not here, and never were. A heading with no day in it is
   * not a group, it is a pile — nothing about an undated row says when it matters.
   * They are untouched and still visible on Tasks and in the member's own list;
   * they are simply not part of a view about today.
   */
  const groups = useMemo(() => {
    const isClosed = (t: Task) => t.status === 'completed' || t.status === 'cancelled'
    /**
     * Two groups, because the list is one day: what is still on, then what is done.
     *
     * This used to build four ranks — Overdue, Today/Tomorrow, a named day, and a
     * Done group per day — which is what a list spanning weeks needs. Scoped to
     * today those branches are unreachable: nothing here is overdue by a day,
     * nothing is tomorrow, and every finished row was due today. Dead branches
     * whose comments describe behaviour the screen no longer has are worse than no
     * branches, so they are gone rather than left to rot.
     *
     * Open first. A finished task between two live ones answers a question nobody
     * asked, and the point of the screen is what is outstanding.
     *
     * Times inside each group stay ascending, from the byDueAsc sort upstream.
     */
    const open: Task[] = []
    const done: Task[] = []
    for (const t of activeShown) (isClosed(t) ? done : open).push(t)
    const out: { key: string; label: string; tasks: Task[] }[] = []
    if (open.length) out.push({ key: 'today', label: 'Today', tasks: open })
    if (done.length) out.push({ key: 'done-today', label: 'Done today', tasks: done })
    return out
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
        {/* Just "Tasks".
            The heading used to name whose work was shown ("Your tasks", "Sathvik's
            tasks", "Everyone") — which restated the roster selection sitting a few
            centimetres above it, where it is already the highlighted card. A heading
            that echoes the control above it is not a label, it is a second copy of
            one, and it changed under you as you tapped around.
            The button carries the name instead, because there it is NEW information:
            it says who the task will be for. */}
        <SectionHeading
          count={activeShown.length}
          action={
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              {/* Names the person only when one is picked, and never yourself —
                  "New task for you" on your own row is the same noise the heading
                  was. Workspace selected = a plain new task. */}
              {selectedMember && selectedMember.user_id !== me?.id
                ? `New task for ${selectedMember.name?.split(' ')[0] ?? 'them'}`
                : 'New task'}
            </Button>
          }
        >
          Tasks
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
              /* Says TODAY, because that is what the list is scoped to when a
                 member is picked. "Nothing open" would be a claim about their
                 whole backlog, which this view no longer shows — and they may
                 well have plenty, just not due today. */
              /* Every one of these says TODAY, because that is what the list is
                 scoped to. "No team projects" would be a claim about the whole
                 board — which may well be full, just not for today. */
              title={headingName
                ? (headingName === 'Your' ? 'Nothing on today'
                   : `${selectedMember?.name} has nothing on today`)
                : 'Nothing on today'}
              body={selectedMember
                ? 'Their tasks due today will show here.'
                : "The team's tasks due today will show here."}
              /* Desktop only, same reasoning as Today: on a phone this sits a short
                 scroll below the identical button in the section header, so both
                 would render as two calls to action for one thing. On desktop they
                 are far apart — header top-right versus the middle of an empty
                 card — and an empty list is exactly when you want to add to it. */
              action={<div className="hidden sm:block">
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" />
                  {selectedMember && selectedMember.user_id !== me?.id
                    ? `New task for ${selectedMember.name?.split(' ')[0] ?? 'them'}`
                    : 'New task'}
                </Button>
              </div>}
            />
          </Card>
        )}

        {groups.map(g => (
          <div key={g.key} className="mb-5">
            {/* Just the label and a count. Nothing here is coloured: the Overdue
                heading was the only red one and it cannot occur in a single-day
                list — a task due earlier today is not late by a day. */}
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="text-[12px] font-semibold uppercase tracking-[.08em]"
                    style={{ color: 'var(--text-muted)' }}>
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
                          /* Both sides: this screen is about other people's work,
                             so "who gave it" and "who has it" are the point. */
                          bothParties />
              ))}
            </div>
          </div>
        ))}
      </section>

      {openTask && (
        <TaskDetail task={openTask} onClose={() => setOpenTask(null)}
                    onChanged={() => { projects.reload(); memberTasks.reload() }} />
      )}
      {creating && (
        /* 🔴 THE PICKED MEMBER IS THE ASSIGNEE. The roster selection is the whole
           intent of pressing this button here — making you re-pick the same person
           inside the form is a step that can only be got wrong, and getting it
           wrong sends work to the wrong person.
           seedDate is TODAY, always, because the whole screen is now today: a task
           created for another day would file correctly and then disappear from the
           list you are looking at, which reads as the create having failed. The
           date is still editable in the form — this is the starting point, not a
           restriction.
           A task for someone else lands on the team board automatically —
           NewTaskSheet forces is_project when the assignee is not you. */
        <NewTaskSheet
          seedDate={istDateKey(istNow())}
          seedAssignees={selected ? [selected] : null}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            projects.reload(); memberTasks.reload()
          }} />
      )}
    </div>
  )
}
