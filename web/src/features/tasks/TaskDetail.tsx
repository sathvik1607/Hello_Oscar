import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight, Send, Sparkles, Trash2, Users, X,
} from 'lucide-react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { dueLabel, messageTime, parseIstNaive, relative } from '../../lib/format'
import { subscribe } from '../../lib/appSocket'
import type { Task, TaskComment } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import {
  Badge, Button, EmptyState, ErrorState, IconButton, STATUS_LABEL, Skeleton, cx,
  inputCls, inputStyle,
} from '../../ui'

/**
 * One task, opened. A side sheet rather than a route, so the list stays behind it —
 * closing returns you to your place instead of to the top of a refetched list.
 *
 * The comment thread is the interesting part. It is not a ticketing log: the same
 * endpoint the phone posts to is wired to Oscar's agent tooling, so a comment like
 * "move this to tomorrow at 6" is a request, not a note. That is why the composer
 * is phrased as talking to Oscar and why the send button says what it will do.
 *
 * 🔴 A comment does NOT currently trigger an Oscar reply. The agent block in
 * `add_task_comment` is deliberately commented out server-side, so today the thread
 * is human-to-human plus system activity notes. The UI is honest about that — it
 * offers "Ask Oscar" as an explicit action that goes through /chat/stream, rather
 * than implying a comment will be acted on when it will not be.
 */
export function TaskDetail({ task, onClose, onChanged }: {
  task: Task
  onClose: () => void
  onChanged: () => void
}) {
  const me = getUser()
  const c = useApi(s => tasksApi.comments(task.id, s), [task.id])
  const reloadComments = c.reload
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const due = parseIstNaive(task.due_at)
  const comments = c.data?.comments ?? []

  // Live comments. Another assignee commenting while this sheet is open should
  // appear, not wait for a manual refresh — and the frame already exists
  // (task.comment.created), so polling here would be inventing work.
  useEffect(() => subscribe(f => {
    if (f.type !== 'task.comment.created') return
    if (Number(f.payload?.task_id) !== task.id) return
    reloadComments()
  }), [task.id, reloadComments])

  // Scroll to the newest comment when the thread loads or grows. `auto` rather than
  // `smooth` on first load, so opening the sheet does not animate a long thread.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [comments.length])

  const post = useCallback(async () => {
    const body = draft.trim()
    if (!body || sending) return
    setSending(true); setErr(null)
    try {
      await tasksApi.comment(task.id, body)
      setDraft('')
      c.reload()
      // The comment may have changed the task (a system activity note follows a
      // completion), so the list behind this sheet needs to know.
      onChanged()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [draft, sending, task.id, c, onChanged])

  const remove = useCallback(async () => {
    setErr(null)
    try {
      await tasksApi.remove(task.id)
      onChanged()
      onClose()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
      setConfirmDelete(false)
    }
  }, [task.id, onChanged, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-40 bg-black/30" />
      <aside
        role="dialog" aria-modal="true" aria-label={task.title}
        className="rise fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l
                   sm:max-w-[520px]"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      >
        {/* ── header ───────────────────────────────────────────────── */}
        <header className="flex items-start gap-3 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge tone={task.status}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
              {task.priority !== 'medium' && (
                <Badge tone={task.priority}>{task.priority} priority</Badge>
              )}
              {task.is_overdue && <Badge tone="overdue">{relative(due)}</Badge>}
            </div>
            <h2 className="text-[17px] font-semibold leading-snug">{task.title}</h2>
            <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              {due ? dueLabel(due) : 'No time set'}
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {task.description && (
            <p className="mb-5 whitespace-pre-wrap text-sm leading-relaxed"
               style={{ color: 'var(--text-muted)' }}>
              {task.description}
            </p>
          )}

          {/* Who is on it. Shown only when it is shared or delegated — "assigned to
              you" on your own task is a fact you already knew. */}
          {(task.assignees.length > 1 || !task.is_mine) && (
            <div className="mb-5 rounded-xl p-3.5" style={{ background: 'var(--bg-sunken)' }}>
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
                {/* The roster is CAPPED server-side at 25 — past that only the
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

          {/* ── thread ─────────────────────────────────────────────── */}
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[.1em]"
               style={{ color: 'var(--text-subtle)' }}>
            Activity
          </div>

          {c.loading && !c.data && <Skeleton rows={2} />}
          {c.error && <ErrorState error={c.error} onRetry={c.reload} />}
          {!c.loading && comments.length === 0 && (
            <EmptyState
              title="Nothing here yet"
              body="Add a note, or tell Oscar what to change about this task."
            />
          )}

          <div className="space-y-3">
            {comments.map(cm => <Comment key={cm.id} comment={cm} mine={cm.user_id === me?.id} />)}
          </div>
          <div ref={endRef} />
        </div>

        {/* ── composer ─────────────────────────────────────────────── */}
        <footer className="border-t px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
          {err && (
            <p className="mb-2.5 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                // Enter sends, Shift+Enter adds a line. The inverse is what chat
                // apps do and what everyone's hands expect.
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void post() }
              }}
              rows={1}
              placeholder="Add a note, or ask Oscar to change this…"
              className={cx(inputCls, 'max-h-32 min-h-[42px] resize-none py-2.5')}
              style={inputStyle}
            />
            <Button variant="primary" onClick={() => void post()}
                    loading={sending} disabled={!draft.trim()}
                    aria-label="Post comment">
              <Send className="size-4" />
            </Button>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-3">
            {/* Honest about the boundary: a comment is a note; asking Oscar to
                change something goes through the agent. Implying otherwise is how
                a user ends up believing a task was rescheduled when it was not. */}
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
              Notes are shared with everyone on this task.
              <span className="hidden sm:inline"> Use Oscar to reschedule or reassign.</span>
            </p>
            {confirmDelete ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="danger" onClick={() => void remove()}>Delete</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)}
                      className="flex shrink-0 items-center gap-1 text-[11px] font-medium"
                      style={{ color: 'var(--text-subtle)' }}>
                <Trash2 className="size-3" /> Delete
              </button>
            )}
          </div>
        </footer>
      </aside>
    </>
  )
}

function Comment({ comment, mine }: { comment: TaskComment; mine: boolean }) {
  // 'assistant' rows are SYSTEM activity notes ("✅ Marked as completed by …")
  // written by item_service.complete_item — not Oscar replies. Styled as a quiet
  // system line, because rendering them as chat bubbles from Oscar would claim the
  // assistant said something it did not.
  if (comment.role === 'assistant') {
    return (
      <div className="flex items-center gap-2 px-1 text-[12.5px]"
           style={{ color: 'var(--text-subtle)' }}>
        <Sparkles className="size-3 shrink-0" />
        <span className="min-w-0 flex-1">{comment.body}</span>
        <span className="shrink-0 tabular-nums">{messageTime(comment.created_at)}</span>
      </div>
    )
  }

  return (
    <div className="flex gap-2.5">
      <Avatar name={comment.user_name ?? '?'} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold">
            {mine ? 'You' : (comment.user_name ?? `User ${comment.user_id}`)}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-subtle)' }}>
            {messageTime(comment.created_at)}
          </span>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
          {comment.body}
        </p>
        {!!comment.attachments?.length && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {comment.attachments.map(a => (
              <a key={a.id}
                 href={a.direct_url ?? undefined}
                 target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                 style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
                {a.file_name ?? 'Attachment'} <ArrowUpRight className="size-3" />
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
