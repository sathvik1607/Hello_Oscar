import { useMemo, useState } from 'react'
import { Circle, Users } from 'lucide-react'
import { team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import { getUser } from '../../lib/session'
import { messageTime } from '../../lib/format'
import { resolvePresence, usePresence } from '../../lib/presence'
import type { Task } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import { TaskCard } from '../tasks/TaskCard'
import { TaskDetail } from '../tasks/TaskDetail'
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
  const [selected, setSelected] = useState<number | null>(null)
  const [openTask, setOpenTask] = useState<Task | null>(null)

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

  const shown = selected ? (memberTasks.data?.tasks ?? []) : (projects.data?.tasks ?? [])
  const activeShown = shown.filter(t => t.status !== 'cancelled')
  const selectedMember = roster.find(m => m.user_id === selected)

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
        <SectionHeading count={roster.length}>{me.team_name ?? 'Team'}</SectionHeading>
        {members.loading && !members.data && <Skeleton rows={2} />}
        {members.error && <ErrorState error={members.error} onRetry={members.reload} />}

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
                      : m.last_seen ? `Last seen ${messageTime(m.last_seen)}`
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
          {selectedMember ? `${selectedMember.name}'s tasks` : 'Team projects'}
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
              title={selectedMember ? `${selectedMember.name} has nothing open` : 'No team projects'}
              body={selectedMember
                ? 'Tasks assigned to them will show here.'
                : 'Project tasks shared across the workspace appear here.'}
            />
          </Card>
        )}

        <div className="space-y-2">
          {activeShown.map(t => (
            <TaskCard key={t.id} task={t}
                      // Read-only from here: completing somebody else's task from a
                      // roster view is almost always a mis-tap, and it notifies them.
                      onToggle={() => setOpenTask(t)}
                      onOpen={() => setOpenTask(t)}
                      showAssignee />
          ))}
        </div>
      </section>

      {openTask && (
        <TaskDetail task={openTask} onClose={() => setOpenTask(null)}
                    onChanged={() => { projects.reload(); memberTasks.reload() }} />
      )}
    </div>
  )
}
