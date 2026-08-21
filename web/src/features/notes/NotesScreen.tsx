import { useCallback, useState } from 'react'
import { NotebookPen, Pencil, Plus, Trash2, X } from 'lucide-react'
import { ApiError, notes as notesApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { messageTime } from '../../lib/format'
import type { Note } from '../../lib/types'
import {
  Button, Card, Confirmation, EmptyState, ErrorState, IconButton, Skeleton, cx,
  inputCls, inputStyle,
} from '../../ui'

/**
 * Notes — the long-term context Oscar reads.
 *
 * Deliberately NOT tasks. `pa_personal_notes` has no link to `pa_items` and note
 * CRUD never creates or edits a task; a note is something durable about how you
 * work ("standup every weekday at 9:30", "I never take calls before 10"), and Plan
 * My Day is what turns that into suggestions you approve.
 *
 * The wire field is `content`, not `body`. `body` exists in the database, is 100%
 * NULL, and is a leftover from a redesign before ship.
 */
export function NotesScreen() {
  const n = useApi(s => notesApi.list(s))
  const [editing, setEditing] = useState<Note | 'new' | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const notes = n.data?.notes ?? []

  const flash = useCallback((msg: string) => {
    setSaved(msg)
    setTimeout(() => setSaved(null), 2600)
  }, [])

  const remove = useCallback(async (id: number) => {
    setErr(null)
    try {
      await notesApi.remove(id)
      setConfirmId(null)
      n.reload()
      flash('Note removed. Oscar will stop using it.')
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    }
  }, [n, flash])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-lg text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Anything Oscar should keep in mind — your routines, working hours, standing
          commitments. These are context, not tasks.
        </p>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-4" /> <span className="hidden sm:inline">Add note</span>
        </Button>
      </div>

      {saved && <Confirmation>{saved}</Confirmation>}
      {err && <ErrorState error={err} />}

      {n.loading && !n.data && <Skeleton rows={3} />}
      {n.error && !n.data && <ErrorState error={n.error} onRetry={n.reload} />}

      {!n.loading && notes.length === 0 && (
        <Card>
          <EmptyState
            icon={<NotebookPen className="size-6" />}
            title="No notes yet"
            body="Try: “I start work at 9 and never take calls before 10.” Oscar uses these when planning your day."
            action={<Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" /> Add your first note
            </Button>}
          />
        </Card>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        {notes.map(note => (
          <Card key={note.id} className="group flex flex-col p-4">
            {note.title && (
              <div className="mb-1 text-[13px] font-semibold">{note.title}</div>
            )}
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {note.content}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {note.updated_at ? messageTime(note.updated_at) : ''}
              </span>
              {confirmId === note.id ? (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="danger" onClick={() => void remove(note.id)}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-0.5">
                  <IconButton label="Edit note" onClick={() => setEditing(note)}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Delete note" onClick={() => setConfirmId(note.id)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {editing && (
        <NoteEditor
          note={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={msg => { setEditing(null); n.reload(); flash(msg) }}
        />
      )}
    </div>
  )
}

function NoteEditor({ note, onClose, onSaved }: {
  note: Note | null
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [title, setTitle] = useState(note?.title ?? '')
  const [content, setContent] = useState(note?.content ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const body = content.trim()
    // The backend rejects empty content with a 400 and oversized content (>20k)
    // with another. Caught here so the user gets the message on the field rather
    // than as a server error after a round trip.
    if (!body || busy) return
    if (body.length > 20_000) {
      setErr('That is too long — keep a note under 20,000 characters.')
      return
    }
    setBusy(true); setErr(null)
    try {
      if (note) {
        await notesApi.update(note.id, { content: body, title: title.trim() })
        onSaved('Note updated. Oscar has it.')
      } else {
        await notesApi.create(body, title.trim() || undefined)
        onSaved("Saved. Oscar will use this when planning.")
      }
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2))
      setBusy(false)
    }
  }

  return (
    <>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-40 bg-black/30" />
      <div role="dialog" aria-modal="true" aria-label={note ? 'Edit note' : 'New note'}
           className="rise fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t p-5
                      sm:inset-0 sm:m-auto sm:h-fit sm:max-w-lg sm:rounded-2xl sm:border"
           style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                    paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{note ? 'Edit note' : 'New note'}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <input value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="Title (optional)"
                 className={inputCls} style={inputStyle} />
          <textarea value={content} onChange={e => setContent(e.target.value)}
                    rows={6} autoFocus
                    placeholder="I start at 9, standup every weekday at 9:30, and I keep Fridays free for deep work."
                    className={cx(inputCls, 'resize-none leading-relaxed')} style={inputStyle} />
          {err && <p className="text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}
          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy}
                    disabled={!content.trim()} className="flex-1">
              {note ? 'Save' : 'Add note'}
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </>
  )
}
