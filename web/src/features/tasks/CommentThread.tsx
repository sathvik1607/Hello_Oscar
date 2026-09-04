import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
  Button, DayDivider, EmptyState, ErrorState, Skeleton, cx, dayKeyOf,
  inputCls, inputStyle, Linkify} from '../../ui'

/**
 * The comment thread and its composer, for ONE item.
 *
 * Shared by tasks and meetings, because the backend endpoint is: a meeting id goes
 * in the `{task_id}` slot of `/users/{uid}/tasks/{id}/comments` and passes the same
 * `_task_for_user` gate. Duplicating this for meetings would mean two copies of the
 * attachment staging, the upload-in-flight guard and the access-denied handling —
 * and they would drift.
 */
/**
 * Split into a hook plus two components ON PURPOSE.
 *
 * The composer has to be a SIBLING of the sheet's scroll region, not a child of it.
 * As `sticky bottom-0` inside a short scroll container it parked itself at the end
 * of the content with the rest of the sheet blank underneath — it looked like a
 * floating input in the middle of a mostly-empty panel. A footer pinned by the
 * sheet's own flex column is always at the bottom, whether the thread has two
 * comments or two hundred.
 *
 * One hook so both halves share the staging, the in-flight guard and the errors —
 * two copies of that would drift.
 */
export function useCommentThread(itemId: number, onPosted?: () => void) {
  const me = getUser()
  const c = useApi(s => tasksApi.comments(itemId, s), [itemId])
  const reload = c.reload

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [staged, setStaged] = useState<CommentAttachment[]>([])
  const [uploading, setUploading] = useState<string[]>([])

  const comments = c.data?.comments ?? []

  // 404 here is the item-permission gate, not a missing route. Distinguished from
  // an empty thread because "you don't have access" and "nobody has commented"
  // need completely different words — Flutter models the same split as
  // `accessDenied`.
  const accessDenied = !!c.error &&
    (c.error.includes('not your') || c.error.includes('access denied'))
  // ⚠️ The backend answers "Task not found or access denied" for BOTH a permission
  // miss and a genuinely deleted item — one string, two causes, and the client
  // cannot tell them apart. The copy is written to survive either reading: it
  // states who may comment rather than asserting what went wrong, so it is not a
  // lie if the item is simply gone. Splitting them needs distinct details from the
  // API, not more guessing here.

  useEffect(() => subscribe(f => {
    if (f.type !== 'task.comment.created') return
    if (Number(f.payload?.task_id) !== itemId) return
    reload()
  }), [itemId, reload])

  /** Shared by the file picker, paste and drop. */
  const upload = useCallback(async (files: File[]) => {
    if (!files.length) return
    setErr(null)
    for (const f of files) {
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
  }, [itemId])

  const pick = useCallback(
    (list: FileList | null) => upload(list ? [...list] : []), [upload])

  /**
   * Paste a file — ⌘V / Ctrl+V.
   *
   * A screenshot is the obvious case and it needs no filename: the clipboard gives
   * a File with a generic name (often "image.png"), which is why one is synthesised
   * from the item and the time — a thread of four files all called "image.png" is
   * unusable.
   *
   * `clipboardData.files` covers a file copied from Finder or Explorer;
   * `clipboardData.items` covers a screenshot, which arrives as an item of kind
   * "file" and is NOT always present in `.files`. Both are read, and duplicates
   * cannot happen because a paste carries one or the other.
   *
   * preventDefault ONLY when something was actually attached, so pasting text into
   * the composer still behaves exactly as it always did.
   */
  const paste = useCallback(async (e: React.ClipboardEvent) => {
    const cd = e.clipboardData
    if (!cd) return
    const files: File[] = [...cd.files]
    if (files.length === 0) {
      for (const item of cd.items) {
        if (item.kind !== 'file') continue
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length === 0) return          // plain text — leave the paste alone
    e.preventDefault()

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const named = files.map((f, i) => {
      // A pasted screenshot is called "image.png" every time. Renaming it here is
      // the difference between a readable thread and four identical chips.
      const generic = !f.name || /^image\.\w+$/i.test(f.name)
      if (!generic) return f
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
      return new File([f], `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`,
                      { type: f.type })
    })
    await upload(named)
  }, [upload])

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

  return {
    me, comments, loading: c.loading, error: c.error, accessDenied, reload,
    draft, setDraft, sending, err, staged, setStaged, uploading,
    pick, paste, post, canSend,
  }
}

export type Thread = ReturnType<typeof useCommentThread>

/** The messages. Belongs inside the sheet's scrolling region. */
export function CommentList({ t }: { t: Thread }) {
  const endRef = useRef<HTMLDivElement>(null)
  // Scrolls to the newest when the thread grows. Owned here because this is the
  // component that renders the node.
  //
  // Deferred a frame: on the first render the comments exist in React but the
  // browser has not laid them out, so scrollIntoView measures a container that is
  // still short and stops part-way up a long thread.
  useEffect(() => {
    if (t.comments.length === 0) return
    const id = requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(id)
  }, [t.comments.length])

  return (
    <>
      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[.1em]"
           style={{ color: 'var(--text-subtle)' }}>
        Comments{t.comments.length > 0 && ` · ${t.comments.length}`}
      </div>

      {t.loading && t.comments.length === 0 && <Skeleton rows={2} />}
      {/* 🔴 NOT AN ERROR — a fact about who may comment.
          "Something went wrong / You don't have access to this thread" told the
          reader two wrong things: that the app had failed, and that the thread is
          somehow off-limits to them personally. Neither is true. Nothing went
          wrong — the backend answered correctly — and the rule is simply that a
          comment thread belongs to the people on the item.

          `_task_for_user` (main.py) grants access to the owner, ANY assignee, and a
          team lead of either's team. So the honest sentence names the rule rather
          than the refusal, and a red warning triangle is the wrong furniture for
          it entirely. */}
      {t.accessDenied && (
        <EmptyState
          title="Only people on this task can comment"
          body="You'll be able to read and add notes here once you're the owner or an assignee."
        />
      )}
      {t.error && !t.accessDenied && (
        <ErrorState error={t.error} onRetry={t.reload} />
      )}
      {!t.loading && !t.error && t.comments.length === 0 && (
        <EmptyState title="No comments yet"
                    body="Add a note or a file — everyone on this item will see it." />
      )}

      <div className="space-y-3.5">
        {t.comments.map((cm, i) => {
          // A divider whenever the DAY changes, and before the first comment. Without
          // it every row showed a bare time, so a note from last Tuesday and one from
          // five minutes ago were indistinguishable — "6:04 pm" says nothing about
          // which day, and a thread that goes quiet for a week reads as continuous.
          // Same rule and same component as the DM/team threads.
          const day = dayKeyOf(cm.created_at)
          const prevDay = i > 0 ? dayKeyOf(t.comments[i - 1].created_at) : null
          return (
            <Fragment key={cm.id}>
              {day && day !== prevDay && <DayDivider iso={cm.created_at} />}
              <Comment comment={cm} mine={cm.user_id === t.me?.id} />
            </Fragment>
          )
        })}
      </div>
      <div ref={endRef} />
    </>
  )
}

/** The input. Belongs in the sheet's footer, OUTSIDE the scrolling region. */
export function CommentComposer({ t }: { t: Thread }) {
  const fileInput = useRef<HTMLInputElement>(null)
  /**
   * 🔴 NO COMPOSER WITHOUT ACCESS. The message above already says only people on
   * the task can comment, and the box sat right underneath it inviting you to type
   * anyway — a paperclip, a placeholder and a send button, all of which would have
   * failed on POST after you had written the note. Offering an action that cannot
   * succeed is worse than not offering it.
   *
   * Decided here rather than at the two call sites (TaskDetail, MeetingDetail):
   * the composer already receives the whole thread, so one guard covers both and a
   * third caller cannot forget it.
   */
  if (t.accessDenied) return null
  return (
    <div className="border-t px-5 py-3.5"
         style={{ borderColor: 'var(--border)' }}>
      {t.err && <p className="mb-2.5 text-[13px]" style={{ color: '#DC2626' }}>{t.err}</p>}

      {(t.staged.length > 0 || t.uploading.length > 0) && (
        <div className="mb-2.5 space-y-1.5">
          {t.staged.map(a => (
            <AttachmentChip key={a.id} attachment={a}
                            onRemove={() => t.setStaged(s => s.filter(x => x.id !== a.id))} />
          ))}
          {t.uploading.map(n => <PendingChip key={n} name={n} />)}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input ref={fileInput} type="file" multiple accept={ACCEPTED}
               className="hidden"
               onChange={e => {
                 void t.pick(e.target.files)
                 // Reset, or picking the same file twice in a row fires no change
                 // event and the second pick silently does nothing.
                 e.target.value = ''
               }} />
        <Button onClick={() => fileInput.current?.click()}
                aria-label="Attach a file" title="Attach a file — or just paste one (25 MB max)">
          <Paperclip className="size-4" />
        </Button>
        <textarea
          value={t.draft}
          onChange={e => t.setDraft(e.target.value)}
          onPaste={e => void t.paste(e)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void t.post() }
          }}
          rows={1}
          placeholder="Add a note, or paste a screenshot…"
          className={cx(inputCls, 'max-h-32 min-h-[42px] resize-none py-2.5')}
          style={inputStyle}
        />
        <Button variant="primary" onClick={() => void t.post()}
                loading={t.sending} disabled={!t.canSend} aria-label="Post comment">
          <Send className="size-4" />
        </Button>
      </div>
    </div>
  )
}

function Comment({ comment, mine }: { comment: TaskComment; mine: boolean }) {
  // 'assistant' rows are SYSTEM activity notes ("✅ Marked as completed by …")
  // written by item_service.complete_item — not Oscar replies. Centred and quiet,
  // because they belong to neither side of the conversation.
  if (comment.role === 'assistant') {
    return (
      <div className="flex items-center justify-center gap-2 px-1 text-[12.5px]"
           style={{ color: 'var(--text-subtle)' }}>
        <Sparkles className="size-3 shrink-0" />
        <span className="min-w-0">{comment.body}</span>
        <span className="shrink-0 tabular-nums">{messageTime(comment.created_at)}</span>
      </div>
    )
  }

  /**
   * Mine on the RIGHT, everyone else on the LEFT — the arrangement every messaging
   * app uses, because it makes "who said this" answerable without reading a name.
   * A thread of uniform left-aligned rows forces you to read the label on every
   * line to follow a two-person exchange.
   *
   * The avatar is dropped on my own side: I know who I am, and it is the one piece
   * of information the alignment already carries.
   */
  return (
    <div className={cx('flex gap-2.5', mine ? 'justify-end' : 'justify-start')}>
      {!mine && <Avatar name={comment.user_name ?? '?'} size={28} />}
      <div className={cx('min-w-0 max-w-[82%]', mine && 'items-end text-right')}>
        <div className={cx('flex items-baseline gap-2', mine && 'justify-end')}>
          {/* No name on my own messages — the side already says it. */}
          {!mine && (
            <span className="text-[13px] font-semibold">
              {comment.user_name ?? `User ${comment.user_id}`}
            </span>
          )}
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-subtle)' }}>
            {messageTime(comment.created_at)}
          </span>
        </div>

        {/* 🔴 THE FILE COMES FIRST, and the note about it sits underneath.
            It used to be the other way round, which reads backwards: someone
            attaches a contract and types "check clause 4" — the sentence is a
            caption for the file, so showing the caption above a file you cannot see
            yet makes it a riddle. Every messaging app puts the attachment first for
            the same reason. */}
        {!!comment.attachments?.length && (
          <div className={cx('mt-1 flex flex-col gap-1.5', mine && 'items-end')}>
            {comment.attachments.map(a => <AttachmentChip key={a.id} attachment={a} />)}
          </div>
        )}

        {/* A file-only comment is legal, so the bubble renders only when there is
            text — otherwise an empty bubble sits below the chip. */}
        {comment.body.trim() && (
          /**
           * max-w + break-all so a long URL WRAPS instead of stretching the bubble.
           *
           * `inline-block` with no max-width sizes to its content, and a 130-char
           * Google Docs link has no space to break at — so the bubble grew past the
           * sheet and rendered as a coloured bar running off the edge, with the text
           * beyond the viewport.
           *
           * `break-words` alone was not enough: it breaks at word boundaries, and a
           * URL is one long word. `break-all` on the span is what lets it split
           * mid-token. Prose is unaffected — it still breaks at spaces first.
           */
          <div className={cx('mt-1.5 inline-block max-w-full rounded-2xl px-3 py-2 text-left',
                             'text-sm leading-relaxed',
                             mine ? 'rounded-br-md' : 'rounded-bl-md')}
               style={mine
                 ? { background: 'var(--accent)', color: '#fff' }
                 : { background: 'var(--bg-sunken)', color: 'var(--text)' }}>
            <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              <Linkify text={comment.body} />
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
