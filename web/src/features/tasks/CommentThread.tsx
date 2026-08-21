import { useCallback, useEffect, useRef, useState } from 'react'
import { Paperclip, Send, Sparkles } from 'lucide-react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { messageTime } from '../../lib/format'
import { subscribe } from '../../lib/appSocket'
import type { CommentAttachment, TaskComment } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import { ACCEPTED, AttachmentChip, MAX_BYTES, PendingChip } from './AttachmentChip'
import {
  Button, EmptyState, ErrorState, Skeleton, cx, inputCls, inputStyle,
} from '../../ui'

/**
 * The comment thread and its composer, for ONE item.
 *
 * Shared by tasks and meetings, because the backend endpoint is: a meeting id goes
 * in the `{task_id}` slot of `/users/{uid}/tasks/{id}/comments` and passes the same
 * `_task_for_user` gate. Duplicating this for meetings would mean two copies of the
 * attachment staging, the upload-in-flight guard and the access-denied handling —
 * and they would drift.
 */
export function CommentThread({ itemId, onPosted }: {
  itemId: number
  /** A posted comment can change the item (a completion writes a system note), so
   *  the owning sheet gets a chance to refetch. */
  onPosted?: () => void
}) {
  const me = getUser()
  const c = useApi(s => tasksApi.comments(itemId, s), [itemId])
  const reload = c.reload

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [staged, setStaged] = useState<CommentAttachment[]>([])
  const [uploading, setUploading] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  const comments = c.data?.comments ?? []

  // 404 here is the item-permission gate, not a missing route. Distinguished from
  // an empty thread because "you don't have access" and "nobody has commented"
  // need completely different words — Flutter models the same split as
  // `accessDenied`.
  const accessDenied = !!c.error &&
    (c.error.includes('not your') || c.error.includes('access denied'))

  useEffect(() => subscribe(f => {
    if (f.type !== 'task.comment.created') return
    if (Number(f.payload?.task_id) !== itemId) return
    reload()
  }), [itemId, reload])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [comments.length])

  const pick = useCallback(async (files: FileList | null) => {
    if (!files?.length) return
    setErr(null)
    for (const f of Array.from(files)) {
      // Checked here so a 25 MB upload that was always going to be refused is not
      // sent. The server stays the authority — it magic-byte sniffs and blocks
      // executable signatures even inside text formats.
      if (f.size > MAX_BYTES) { setErr(`${f.name} is larger than 25 MB.`); continue }
      setUploading(u => [...u, f.name])
      try {
        // Awaited into a local first: `await` cannot appear inside the state
        // updater's arrow, and inlining it there is a syntax error rather than a
        // race.
        const uploaded = await tasksApi.uploadAttachment(itemId, f)
        setStaged(prev => [...prev, uploaded])
      } catch (e) {
        // The server's message names the real problem; "upload failed" would hide it.
        setErr(e instanceof ApiError ? e.message : `${f.name} could not be uploaded.`)
      } finally {
        setUploading(u => u.filter(n => n !== f.name))
      }
    }
    // Reset, or picking the same file twice fires no change event.
    if (fileInput.current) fileInput.current.value = ''
  }, [itemId])

  const post = useCallback(async () => {
    const body = draft.trim()
    // A file-only comment is legal — the server accepts an empty body when
    // attachment_ids is present — so this must not require text.
    if ((!body && staged.length === 0) || sending) return
    // Posting mid-upload would send an EMPTY attachment_ids and the file would
    // finish seconds later attached to nothing.
    if (uploading.length) { setErr('Wait for the upload to finish.'); return }

    setSending(true); setErr(null)
    try {
      await tasksApi.comment(itemId, body, staged.map(a => a.id))
      setDraft(''); setStaged([])
      reload()
      onPosted?.()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally { setSending(false) }
  }, [draft, staged, uploading, sending, itemId, reload, onPosted])

  const canSend = (!!draft.trim() || staged.length > 0) && !uploading.length

  return (
    <>
      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[.1em]"
           style={{ color: 'var(--text-subtle)' }}>
        Comments{comments.length > 0 && ` · ${comments.length}`}
      </div>

      {c.loading && !c.data && <Skeleton rows={2} />}
      {accessDenied && <ErrorState error="You don't have access to this thread." />}
      {c.error && !accessDenied && <ErrorState error={c.error} onRetry={reload} />}
      {!c.loading && !c.error && comments.length === 0 && (
        <EmptyState title="No comments yet"
                    body="Add a note or a file — everyone on this item will see it." />
      )}

      <div className="space-y-3.5">
        {comments.map(cm => (
          <Comment key={cm.id} comment={cm} mine={cm.user_id === me?.id} />
        ))}
      </div>
      <div ref={endRef} />

      {/* composer, pinned by the parent's layout */}
      <div className="sticky bottom-0 -mx-5 mt-4 border-t px-5 pb-1 pt-3.5"
           style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
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
          <Button onClick={() => fileInput.current?.click()}
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
      </div>
    </>
  )
}

function Comment({ comment, mine }: { comment: TaskComment; mine: boolean }) {
  // 'assistant' rows are SYSTEM activity notes ("✅ Marked as completed by …")
  // written by item_service.complete_item — not Oscar replies. Rendering them as
  // chat from Oscar would claim the assistant said something it never did.
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
        {/* A file-only comment is legal, so the body renders only when present
            rather than leaving an empty line above the chip. */}
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
