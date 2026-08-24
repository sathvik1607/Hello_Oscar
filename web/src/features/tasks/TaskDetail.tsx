import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Clock, Flag, Pencil, Trash2, Users, X } from 'lucide-react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import { getUser } from '../../lib/session'
import { dueLabel, messageTime, parseIstNaive, relative } from '../../lib/format'
import type { Task } from '../../lib/types'
import { CommentComposer, CommentList, useCommentThread } from './CommentThread'
import { NewTaskSheet } from './NewTaskSheet'
import {
  Badge, Button, IconButton, Portal, STATUS_LABEL, cx, Linkify} from '../../ui'

/**
 * One task, opened: description, details, actions, then the comment thread.
 *
 * The layout mirrors the Flutter `TaskDetailScreen` deliberately — description card,
 * a collapsible details block, complete/delete beneath it, then a `COMMENTS`
 * section and a composer. Same order, same information, so somebody moving between
 * the phone and a browser is not relearning the screen.
 *
 * A side sheet rather than a route, so the list stays behind it and closing returns
 * you to your place instead of the top of a refetched list. Portalled to
 * `document.body`: AppShell wraps every screen in a transformed element, and a
 * transformed ancestor captures `position: fixed` — which is what made the first
 * version of this sheet lay out inside the content column at a third of the
 * viewport height.
 *
 * 🔴 A comment does NOT trigger Oscar. The agent block in the backend's
 * `add_task_comment` is commented out, so the thread is human-to-human plus
 * system-generated activity notes. The Flutter data source's docstring still claims
 * otherwise and is stale. The composer is worded to match reality: implying a
 * comment will reschedule the task, when it will not, is worse than not offering it.
 */
export function TaskDetail({ task, onClose, onChanged, inline, onEditStart,
                            focusThread }: {
  task: Task
  onClose: () => void
  onChanged: () => void
  /** Fired the moment the edit form opens.
   *
   *  Exists for the VOICE panel: the microphone is open for the whole call, so
   *  typing into a form while Oscar is listening means every word said in the room —
   *  and anything read aloud while typing — becomes an utterance. The voice screen
   *  passes `end` here so editing ends the call, and the user restarts it
   *  deliberately with Shift Shift. Unused everywhere else. */
  onEditStart?: () => void
  /** Render as a COLUMN in the page rather than a sheet over it. Used by the Oscar
   *  screen, where the task sits beside the conversation that produced it — see
   *  `Frame` at the bottom of this file for why it is one component and not two. */
  inline?: boolean
  /** Opened from a COMMENT notification. Scrolls the thread into view and focuses
   *  the composer, so a "X commented on your task" tap lands on the comment rather
   *  than on the description with the thread below the fold. Off by default: opening
   *  a task normally should show the task. */
  focusThread?: boolean
}) {
  const me = getUser()
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [busyAction, setBusyAction] = useState(false)

  // One hook, two placements: the list scrolls with the sheet body, the composer
  // is pinned by the sheet's flex column so it is always at the bottom.
  const thread = useCommentThread(task.id, onChanged)

  const due = parseIstNaive(task.due_at)
  const done = task.status === 'completed'

  /* Waits for the comments to LOAD before scrolling. Scrolling to an empty div puts
     you at the bottom of the description and then the list renders below where you
     are looking — so the scroll has to be keyed on the rows arriving, not on mount. */
  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusThread || thread.loading) return
    requestAnimationFrame(() =>
      threadRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }))
  }, [focusThread, thread.loading])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleComplete = useCallback(async () => {
    setBusyAction(true); setErr(null)
    try {
      if (done) await tasksApi.setStatus(task.id, 'pending')
      else await tasksApi.complete(task.id)
      // The completion posts a system activity note into the thread; the
      // thread refetches itself from the task.comment.created frame.
      onChanged()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally { setBusyAction(false) }
  }, [done, task.id, onChanged])

  const remove = useCallback(async () => {
    setErr(null)
    try {
      await tasksApi.cancel(task.id)
      onChanged()
      onClose()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
      setConfirmDelete(false)
    }
  }, [task.id, onChanged, onClose])

  /**
   * ONLY what is not already on screen.
   *
   * This block used to list Status, Priority and Due — all three of which are
   * already a badge, a badge and the line under the title. So it restated three
   * things you could see and added `Task ID #2550`, a database primary key with no
   * meaning to anyone reading it. A details panel that repeats the header is not
   * extra information, it is noise that makes the real detail harder to find.
   *
   * What survives is the provenance a task card cannot show: when it was made, who
   * made it, whether it has children. If none of that is known the block hides
   * entirely rather than rendering a table of dashes.
   */
  const details = useMemo(() => ([
    ...(task.created_at ? [['Created', messageTime(task.created_at)]] : []),
    ...(task.completed_at ? [['Completed', messageTime(task.completed_at)]] : []),
    // Only worth saying when it was somebody else — "created by you" on your own
    // task is a fact you supplied.
    ...(task.owner_name && !task.is_mine ? [['Created by', task.owner_name]] : []),
    ...(task.subtask_count ? [['Sub-tasks', String(task.subtask_count)]] : []),
  ] as [string, string][]), [task])

  return (
    <Frame inline={inline} label={task.title} onClose={onClose}>
        {/* ── header ─────────────────────────────────────────────────── */}
        <header className="flex items-start gap-3 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={task.status}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
              {task.priority !== 'medium' && (
                <Badge tone={task.priority}><Flag className="size-3" /> {task.priority}</Badge>
              )}
              {task.is_overdue && !done && <Badge tone="overdue">{relative(due)}</Badge>}
            </div>
            <h2 className={cx('text-[17px] font-semibold leading-snug', done && 'line-through')}>
              {task.title}
            </h2>
            <div className="mt-1.5 flex items-center gap-1.5 text-[13px]"
                 style={{ color: 'var(--text-muted)' }}>
              <Clock className="size-3.5" /> {due ? dueLabel(due) : 'No time set'}
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </header>

        {/* A flex COLUMN, so the comments block below can push itself to the bottom
            when the thread is short — see the mt-auto on it. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          {/* ── description ─────────────────────────────────────────── */}
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.1em]"
               style={{ color: 'var(--text-subtle)' }}>
            Description
          </div>
          {task.description?.trim() ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              <Linkify text={task.description} />
            </p>
          ) : (
            <p className="text-sm italic" style={{ color: 'var(--text-subtle)' }}>
              No description.
            </p>
          )}

          {/* ── details, collapsed ──────────────────────────────────── */}
          {details.length > 0 && (
            <>
              <button onClick={() => setShowDetails(v => !v)}
                      aria-expanded={showDetails}
                      className="mt-3.5 flex items-center gap-1 text-[12px] font-medium"
                      style={{ color: 'var(--text-subtle)' }}>
                {showDetails ? 'Hide' : 'Details'}
                <ChevronDown className={cx('size-3.5 transition-transform',
                                           showDetails && 'rotate-180')} />
              </button>
              {showDetails && (
                <dl className="fade mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  {details.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-[12px]" style={{ color: 'var(--text-subtle)' }}>{k}</dt>
                      {/* No `capitalize` anywhere near a formatted value. */}
                      <dd className="text-[12px]">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          )}

          {/* ── who is on it ────────────────────────────────────────── */}
          {(task.assignees.length > 1 || !task.is_mine) && (
            <div className="mt-4 rounded-xl p-3.5" style={{ background: 'var(--bg-sunken)' }}>
              <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold
                              uppercase tracking-[.1em]"
                   style={{ color: 'var(--text-subtle)' }}>
                <Users className="size-3" />
                {task.assignee_count && task.assignee_count > 1
                  ? `${task.assignees_done ?? 0} of ${task.assignee_count} done`
                  : 'Assigned to'}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {task.assignees.map(a => (
                  <span key={a.user_id}
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs"
                        style={{
                          background: 'var(--bg-elevated)',
                          color: a.status === 'completed' ? '#15803D' : 'var(--text-muted)',
                        }}>
                    {a.status === 'completed' && '✓'}
                    {a.user_id === me?.id ? 'You' : (a.name ?? `#${a.user_id}`)}
                  </span>
                ))}
                {/* The roster is CAPPED at 25 server-side — past that only the
                    viewer's own row is sent. Saying so is the difference between a
                    short list and a wrong one. */}
                {task.assignees_truncated && (
                  <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                    +{(task.assignee_count ?? 0) - task.assignees.length} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── actions ─────────────────────────────────────────────── */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant={done ? 'secondary' : 'primary'} size="sm"
                    loading={busyAction} onClick={() => void toggleComplete()}>
              <Check className="size-3.5" /> {done ? 'Reopen' : 'Mark complete'}
            </Button>
            {!confirmDelete && (
              <Button size="sm" variant="secondary"
                      onClick={() => { onEditStart?.(); setEditing(true) }}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            )}
            {confirmDelete ? (
              <>
                <Button size="sm" variant="danger" onClick={() => void remove()}>
                  Cancel it
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                {/* "Cancel", not "Delete": this is a SOFT delete — the row survives
                    with status='cancelled' and still shows on the Calendar. Calling
                    it Delete promises destruction the backend does not perform. */}
                <Trash2 className="size-3.5" /> Cancel task
              </Button>
            )}
          </div>

          {editing && (
            <NewTaskSheet
              task={task}
              onClose={() => setEditing(false)}
              onCreated={() => {
                setEditing(false)
                // Reload rather than patching locally: an edit can change due_at,
                // which moves the task between buckets on the list behind this.
                onChanged()
              }}
            />
          )}

          {err && (
            <p className="mt-3 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>
          )}

          {/* ── comments ────────────────────────────────────────────── */}
          {/*
            * `mt-auto` is the fix for a void.
            *
            * With the composer correctly pinned to the bottom of the sheet, a
            * one-comment thread left an enormous gap between the last comment and
            * the input — the content sat at the top and the rest of a full-height
            * sheet was empty. Every chat application solves this the same way: a
            * short thread hugs the composer rather than clinging to the top, so the
            * empty space ends up ABOVE the messages where it reads as headroom
            * instead of as a rendering fault.
            *
            * It only takes effect when there is slack. Once the thread is long
            * enough to overflow, this is inert and the region simply scrolls.
            */}
          <div ref={threadRef} className="mt-auto pt-6">
            <CommentList t={thread} />
          </div>
        </div>

        <CommentComposer t={thread} />
    </Frame>
  )
}

/**
 * Sheet, or column — the same body either way.
 *
 * One component rather than two copies of the detail view. The alternative was a
 * separate inline component, and the reason not to is concrete: this file's header,
 * details block, assignee list, actions and comment thread are the contract with the
 * Flutter screen, and a second copy is a second place for that contract to drift.
 *
 * The SHEET is modal — overlay, `aria-modal`, portalled to `document.body` because
 * AppShell wraps every screen in a transformed element and a transformed ancestor
 * captures `position: fixed`. The COLUMN is not modal: it sits in the layout, has no
 * overlay to dismiss, and must NOT be `aria-modal` or a screen reader would report
 * the conversation beside it as unavailable.
 */
function Frame({ inline, label, onClose, children }: {
  inline?: boolean
  label: string
  onClose: () => void
  children: ReactNode
}) {
  if (inline) {
    return (
      <section aria-label={label}
               className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border"
               style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
        {children}
      </section>
    )
  }
  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-[55] bg-black/35" />
      <aside
        role="dialog" aria-modal="true" aria-label={label}
        className="fixed inset-y-0 right-0 z-[56] flex w-full flex-col border-l shadow-2xl
                   sm:max-w-[540px]"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      >
        {children}
      </aside>
    </Portal>
  )
}

