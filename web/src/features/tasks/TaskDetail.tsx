import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check, ChevronDown, Clock, Flag, Paperclip, Send, Sparkles, Trash2, Users, X,
} from 'lucide-react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { dueLabel, messageTime, parseIstNaive, relative } from '../../lib/format'
import { subscribe } from '../../lib/appSocket'
import type { CommentAttachment, Task, TaskComment } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import { ACCEPTED, AttachmentChip, MAX_BYTES, PendingChip } from './AttachmentChip'
import {
  Badge, Button, EmptyState, ErrorState, IconButton, Portal, STATUS_LABEL, Skeleton,
  cx, inputCls, inputStyle,
} from '../../ui'

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
  const [showDetails, setShowDetails] = useState(false)
  const [busyAction, setBusyAction] = useState(false)

  /** Uploaded and waiting to be posted with the next comment. Two-phase like chat
   *  images: the transfer starts when the file is PICKED so it overlaps typing
   *  instead of stacking on top of Send. */
  const [staged, setStaged] = useState<CommentAttachment[]>([])
  const [uploading, setUploading] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const due = parseIstNaive(task.due_at)
  const comments = c.data?.comments ?? []
  const done = task.status === 'completed'

  // 404 here is the item-permission gate, not a missing route — this caller cannot
  // see the task. Distinguished from an empty thread because "you don't have access"
  // and "nobody has commented" need completely different words. Flutter models the
  // same distinction as `accessDenied`.
  const accessDenied = c.error?.includes('not your') || c.error?.includes('access denied')

  useEffect(() => subscribe(f => {
    if (f.type !== 'task.comment.created') return
    if (Number(f.payload?.task_id) !== task.id) return
    reloadComments()
  }), [task.id, reloadComments])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [comments.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ── attachments ───────────────────────────────────────────────────────────
  const pick = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    setErr(null)
    for (const f of Array.from(files)) {
      // Checked here so a 25 MB upload that was always going to be refused is not
      // sent at all. The server remains the authority — it magic-byte sniffs and
      // blocks executable signatures even inside text formats.
      if (f.size > MAX_BYTES) {
        setErr(`${f.name} is larger than 25 MB.`)
        continue
      }
      setUploading(u => [...u, f.name])
      try {
        const a = await tasksApi.uploadAttachment(task.id, f)
        setStaged(s => [...s, a])
      } catch (e) {
        // The server's own message names the actual problem (wrong type, too
        // large, executable); a generic "upload failed" would hide it.
        setErr(e instanceof ApiError ? e.message : `${f.name} could not be uploaded.`)
      } finally {
        setUploading(u => u.filter(n => n !== f.name))
      }
    }
    // Reset the input, or picking the same file twice in a row fires no change event.
    if (fileInput.current) fileInput.current.value = ''
  }, [task.id])

  // ── posting ───────────────────────────────────────────────────────────────
  const post = useCallback(async () => {
    const body = draft.trim()
    // A file-only comment is legal — the server accepts an empty body when
    // attachment_ids is present — so this must not require text.
    if ((!body && staged.length === 0) || sending) return
    // Posting while an upload is still running would send an EMPTY attachment_ids
    // and the file would finish seconds later attached to nothing.
    if (uploading.length) { setErr('Wait for the upload to finish.'); return }

    setSending(true); setErr(null)
    try {
      await tasksApi.comment(task.id, body, staged.map(a => a.id))
      setDraft('')
      setStaged([])
      c.reload()
      onChanged()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [draft, staged, uploading, sending, task.id, c, onChanged])

  const toggleComplete = useCallback(async () => {
    setBusyAction(true); setErr(null)
    try {
      if (done) await tasksApi.setStatus(task.id, 'pending')
      else await tasksApi.complete(task.id)
      onChanged()
      c.reload()          // completion posts a system activity note to the thread
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally { setBusyAction(false) }
  }, [done, task.id, onChanged, c])

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

  // Each row says whether its value may be capitalised. A blanket `capitalize`
  // class turned "6:00 pm" into "6:00 Pm" — CSS capitalises the first letter of
  // EVERY word, so it reaches inside a formatted time and a filename too. Only the
  // enum-ish values want it.
  const details = useMemo(() => [
    ['Status', STATUS_LABEL[task.status] ?? task.status, false],
    ['Priority', task.priority, true],
    ['Due', due ? dueLabel(due) : 'No time set', false],
    ['Created', task.created_at ? messageTime(task.created_at) : '—', false],
    ...(task.completed_at ? [['Completed', messageTime(task.completed_at), false]] : []),
    ...(task.owner_name ? [['Created by', task.owner_name, false]] : []),
    ...(task.subtask_count ? [['Sub-tasks', String(task.subtask_count), false]] : []),
    ['Task ID', `#${task.id}`, false],
  ] as [string, string, boolean][], [task, due])

  const canSend = (!!draft.trim() || staged.length > 0) && !uploading.length

  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-[55] bg-black/35" />
      <aside
        role="dialog" aria-modal="true" aria-label={task.title}
        className="fixed inset-y-0 right-0 z-[56] flex w-full flex-col border-l shadow-2xl
                   sm:max-w-[540px]"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      >
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* ── description ─────────────────────────────────────────── */}
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.1em]"
               style={{ color: 'var(--text-subtle)' }}>
            Description
          </div>
          {task.description?.trim() ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {task.description}
            </p>
          ) : (
            <p className="text-sm italic" style={{ color: 'var(--text-subtle)' }}>
              No description.
            </p>
          )}

          {/* ── details, collapsed ──────────────────────────────────── */}
          <button onClick={() => setShowDetails(v => !v)}
                  aria-expanded={showDetails}
                  className="mt-3.5 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            Task details
            <ChevronDown className={cx('size-3.5 transition-transform', showDetails && 'rotate-180')} />
          </button>
          {showDetails && (
            <dl className="fade mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl p-3.5"
                style={{ background: 'var(--bg-sunken)' }}>
              {details.map(([k, v, cap]) => (
                <div key={k} className="contents">
                  <dt className="text-[12px]" style={{ color: 'var(--text-subtle)' }}>{k}</dt>
                  <dd className={cx('text-[12px] font-medium', cap && 'capitalize')}>{v}</dd>
                </div>
              ))}
            </dl>
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

          {/* ── comments ────────────────────────────────────────────── */}
          <div className="mb-2.5 mt-6 text-[11px] font-semibold uppercase tracking-[.1em]"
               style={{ color: 'var(--text-subtle)' }}>
            Comments{comments.length > 0 && ` · ${comments.length}`}
          </div>

          {c.loading && !c.data && <Skeleton rows={2} />}
          {accessDenied && (
            <ErrorState error="You don't have access to this task's comments." />
          )}
          {c.error && !accessDenied && <ErrorState error={c.error} onRetry={c.reload} />}
          {!c.loading && !c.error && comments.length === 0 && (
            <EmptyState
              title="No comments yet"
              body="Add a note or a file — everyone on this task will see it."
            />
          )}

          <div className="space-y-3.5">
            {comments.map(cm => (
              <Comment key={cm.id} comment={cm} mine={cm.user_id === me?.id} />
            ))}
          </div>
          <div ref={endRef} />
        </div>

        {/* ── composer ─────────────────────────────────────────────── */}
        <footer className="border-t px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
          {err && <p className="mb-2.5 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          {(staged.length > 0 || uploading.length > 0) && (
            <div className="mb-2.5 space-y-1.5">
              {staged.map(a => (
                <AttachmentChip key={a.id} attachment={a}
                                onRemove={() => setStaged(s => s.filter(x => x.id !== a.id))} />
              ))}
              {uploading.map(n => <PendingChip key={n} name={n} />)}
            </div>
          )}

          <div className="flex items-end gap-2">
            <input ref={fileInput} type="file" multiple accept={ACCEPTED}
                   className="hidden" onChange={e => void pick(e.target.files)} />
            <Button size="md" onClick={() => fileInput.current?.click()}
                    aria-label="Attach a file" title="Attach a file (25 MB max)">
              <Paperclip className="size-4" />
            </Button>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void post() }
              }}
              rows={1}
              placeholder="Add a note or attach a file…"
              className={cx(inputCls, 'max-h-32 min-h-[42px] resize-none py-2.5')}
              style={inputStyle}
            />
            <Button variant="primary" onClick={() => void post()}
                    loading={sending} disabled={!canSend} aria-label="Post comment">
              <Send className="size-4" />
            </Button>
          </div>

          <p className="mt-2.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
            Shared with everyone on this task. PDF, Excel, CSV, Word, PowerPoint or
            images, up to 25 MB.
          </p>
        </footer>
      </aside>
    </Portal>
  )
}

function Comment({ comment, mine }: { comment: TaskComment; mine: boolean }) {
  // 'assistant' rows are SYSTEM activity notes ("✅ Marked as completed by …")
  // written by item_service.complete_item — not Oscar replies. Styled as a quiet
  // system line, because rendering them as chat from Oscar would claim the
  // assistant said something it never did.
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
      <Avatar name={comment.user_name ?? '?'} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold">
            {mine ? 'You' : (comment.user_name ?? `User ${comment.user_id}`)}
          </span>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-subtle)' }}>
            {messageTime(comment.created_at)}
          </span>
        </div>
        {/* A file-only comment is legal, so the body is rendered only when there
            is one rather than leaving an empty line above the chip. */}
        {comment.body.trim() && (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {comment.body}
          </p>
        )}
        {!!comment.attachments?.length && (
          <div className="mt-2 space-y-1.5">
            {comment.attachments.map(a => <AttachmentChip key={a.id} attachment={a} />)}
          </div>
        )}
      </div>
    </div>
  )
}
