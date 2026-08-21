import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import { istDateKey, istNow } from '../../lib/format'
import { Button, Field, IconButton, Portal, cx, inputCls, inputStyle } from '../../ui'

/**
 * Create a task by hand.
 *
 * Oscar is the better path for most of these ("remind me to call the supplier at
 * 4"), and this exists for the case Oscar is worse at: you already know exactly
 * what you want and typing it is faster than saying it. So it is deliberately
 * small — title, when, priority — rather than a mirror of every field the API
 * accepts.
 *
 * 🔴 `due_at` is sent IST-NAIVE. The backend stores these digits verbatim with no
 * timezone, so sending an ISO string with a Z would land the task hours off — and
 * a due time in the past is born overdue, which fires a reminder immediately.
 */
export function NewTaskSheet({ onClose, onCreated }: {
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(istDateKey(istNow()))
  const [time, setTime] = useState(defaultTime())
  const [noTime, setNoTime] = useState(false)
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t || busy) return
    setBusy(true); setErr(null)
    try {
      // Built from the date/time PARTS rather than parsed out of a Date, so the
      // browser's timezone never enters the value.
      const due_at = noTime ? null : `${date}T${time}:00`
      await tasksApi.create({
        title: t,
        ...(description.trim() ? { description: description.trim() } : {}),
        due_at,
        priority,
      })
      onCreated()
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2))
      setBusy(false)
    }
  }

  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-40 bg-black/30" />
      <div
        role="dialog" aria-modal="true" aria-label="New task"
        className="rise fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t p-5
                   sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-2xl sm:border"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">New task</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="What needs doing">
            <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                   className={inputCls} style={inputStyle}
                   placeholder="Call the supplier about the invoice" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input type="date" value={date} disabled={noTime}
                     onChange={e => setDate(e.target.value)}
                     className={cx(inputCls, noTime && 'opacity-45')} style={inputStyle} />
            </Field>
            <Field label="Time">
              <input type="time" value={time} disabled={noTime}
                     onChange={e => setTime(e.target.value)}
                     className={cx(inputCls, noTime && 'opacity-45')} style={inputStyle} />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={noTime}
                   onChange={e => setNoTime(e.target.checked)} />
            No specific time
            {/* Worth saying: an undated task gets no reminder at all, which is a
                surprise if you expected one. */}
            <span className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
              (no reminder)
            </span>
          </label>

          <Field label="Priority" hint="High gets a reminder 30 minutes ahead; low gets none until it's overdue.">
            <div className="flex gap-1.5">
              {(['low', 'medium', 'high'] as const).map(p => (
                <button key={p} type="button" onClick={() => setPriority(p)}
                        className="flex-1 rounded-lg border py-2 text-[13px] font-medium capitalize transition"
                        style={priority === p
                          ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)',
                              color: 'var(--accent)' }
                          : { background: 'var(--bg)', borderColor: 'var(--border)',
                              color: 'var(--text-muted)' }}>
                  {p}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Notes">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={2} placeholder="Optional"
                      className={cx(inputCls, 'resize-none')} style={inputStyle} />
          </Field>

          {err && <p className="text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy}
                    disabled={!title.trim()} className="flex-1">
              Create task
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </Portal>
  )
}

/** The next round half-hour, in IST. A default of "now" produces a task that is
 *  overdue the moment it is created and fires a reminder immediately. */
function defaultTime(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date())
  const [h, m] = parts.split(':').map(Number)
  const bumped = m < 30 ? { h, m: 30 } : { h: (h + 1) % 24, m: 0 }
  return `${String(bumped.h).padStart(2, '0')}:${String(bumped.m).padStart(2, '0')}`
}
