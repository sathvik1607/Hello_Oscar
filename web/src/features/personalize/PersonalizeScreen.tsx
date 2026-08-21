import { useCallback, useState } from 'react'
import { Check, Info, Plus, Sparkles, Wand2 } from 'lucide-react'
import { ApiError, assistant, notes as notesApi, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { dueLabel, istDateKey, istNow, parseIstNaive } from '../../lib/format'
import type { PlannedTask } from '../../lib/types'
import {
  Badge, Button, Card, Confirmation, EmptyState, ErrorState, SectionHeading,
  Skeleton, cx, inputCls, inputStyle,
} from '../../ui'

/**
 * Teach Oscar how you work, and see what it does with that.
 *
 * Two halves, and the split is the point:
 *
 *  · TELL IT SOMETHING — free text, in your own words, saved as a note. No form, no
 *    fields, no "wake time" dropdown. The backend has no structured profile schema
 *    on this branch; notes plus the planner ARE the personalization system, and
 *    inventing a form here would mean inventing a backend to hold it.
 *
 *  · PLAN MY DAY — the visible consequence. It reads your notes plus today's open
 *    and completed tasks and their comment threads, and SUGGESTS. It persists
 *    nothing: the `db.add`-never contract is test-locked server-side, and this
 *    screen keeps that promise visible by making you approve each row.
 *
 * 🔴 Approving creates tasks through the normal POST /items — the only write in the
 * whole path. Approving twice would create duplicates, so an approved row is marked
 * and cannot be approved again.
 */
export function PersonalizeScreen() {
  const n = useApi(s => notesApi.list(s), [], 'notes')
  const biz = useApi(s => assistant.business(s), [], 'business')

  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [planning, setPlanning] = useState(false)
  const [plan, setPlan] = useState<PlannedTask[] | null>(null)
  const [planMsg, setPlanMsg] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<Set<number>>(new Set())
  const [acceptingIdx, setAcceptingIdx] = useState<number | null>(null)

  const notes = n.data?.notes ?? []

  const say = useCallback((m: string) => {
    setFlash(m); setTimeout(() => setFlash(null), 3200)
  }, [])

  const tell = useCallback(async () => {
    const body = draft.trim()
    if (!body || saving) return
    setSaving(true); setErr(null)
    try {
      await notesApi.create(body)
      setDraft('')
      n.reload()
      // The confirmation is not decoration — "did that land?" is the single most
      // common doubt on a screen whose whole output is invisible.
      say('Got it. Oscar will take that into account from now on.')
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [draft, saving, n, say])

  const runPlan = useCallback(async () => {
    setPlanning(true); setErr(null); setPlan(null); setAccepted(new Set())
    try {
      const r = await notesApi.planDay({ date: istDateKey(istNow()) })
      setPlan(r.tasks)
      setPlanMsg(r.message ?? null)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setPlanning(false)
    }
  }, [])

  const accept = useCallback(async (t: PlannedTask, i: number) => {
    if (accepted.has(i) || acceptingIdx !== null) return
    setAcceptingIdx(i); setErr(null)
    try {
      await tasksApi.create({
        title: t.title,
        ...(t.description ? { description: t.description } : {}),
        // due_at comes back IST-naive (or null) — passed straight through. Parsing
        // and re-serialising it here would be two chances to shift it.
        due_at: t.due_at,
        priority: t.priority,
      })
      setAccepted(prev => new Set(prev).add(i))
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setAcceptingIdx(null)
    }
  }, [accepted, acceptingIdx])

  const acceptAll = useCallback(async () => {
    if (!plan) return
    // Sequential, not Promise.all. Each is a real write against a shared backend,
    // and eight parallel creates on a cold free-tier instance is how you get four
    // timeouts and no idea which landed.
    for (let i = 0; i < plan.length; i++) {
      if (!accepted.has(i)) await accept(plan[i], i)
    }
  }, [plan, accepted, accept])

  return (
    <div className="space-y-7">
      {/* ── tell Oscar something ─────────────────────────────────────── */}
      <section>
        <SectionHeading>Tell Oscar about you</SectionHeading>
        <Card className="p-4">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void tell() }
            }}
            rows={3}
            placeholder="I wake at 6, start work at 9, and have standup every weekday at 9:30. Fridays are for deep work — no meetings."
            className={cx(inputCls, 'resize-none leading-relaxed')}
            style={inputStyle}
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
              Plain sentences work best. Oscar reads these when planning — it does not
              create tasks from them on its own.
            </p>
            <Button variant="primary" size="sm" loading={saving}
                    disabled={!draft.trim()} onClick={() => void tell()}>
              <Plus className="size-3.5" /> Save
            </Button>
          </div>
        </Card>
        {flash && <div className="mt-2.5"><Confirmation>{flash}</Confirmation></div>}
      </section>

      {err && <ErrorState error={err} />}

      {/* ── what Oscar knows ─────────────────────────────────────────── */}
      <section>
        <SectionHeading count={notes.length}>What Oscar knows</SectionHeading>
        {n.loading && !n.data && <Skeleton rows={2} />}
        {!n.loading && notes.length === 0 && (
          <Card>
            <EmptyState
              icon={<Sparkles className="size-6" />}
              title="Oscar doesn't know anything about you yet"
              body="Add a sentence above. The more it knows about your routine, the better its plans are."
            />
          </Card>
        )}
        {notes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {notes.map(note => (
              <span key={note.id}
                    className="max-w-full rounded-xl border px-3 py-2 text-[13px] leading-relaxed"
                    style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                             color: 'var(--text-muted)' }}>
                {note.content.length > 140 ? note.content.slice(0, 140) + '…' : note.content}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── plan my day ──────────────────────────────────────────────── */}
      <section>
        <SectionHeading action={
          <Button variant="primary" size="sm" loading={planning} onClick={() => void runPlan()}>
            <Wand2 className="size-3.5" /> Plan my day
          </Button>
        }>
          Today's plan
        </SectionHeading>

        <p className="mb-3 px-1 text-xs leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
          Oscar reads your notes, today's open and finished tasks, and their comment
          threads. Nothing is created until you approve it.
        </p>

        {planning && <Skeleton rows={3} />}

        {plan && plan.length === 0 && (
          <Card>
            <EmptyState
              title="Nothing to suggest"
              body={planMsg ?? 'Add a note about your routine and try again.'}
            />
          </Card>
        )}

        {plan && plan.length > 0 && (
          <div className="space-y-2">
            {plan.map((t, i) => {
              const due = parseIstNaive(t.due_at)
              const done = accepted.has(i)
              return (
                <Card key={`${t.title}-${i}`} className={cx(done && 'opacity-60')}>
                  <div className="flex items-start gap-3 p-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14.5px] font-medium leading-snug">{t.title}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                          {due ? dueLabel(due) : 'No time set'}
                        </span>
                        {t.priority !== 'medium' && <Badge tone={t.priority}>{t.priority}</Badge>}
                      </div>
                      {/* WHY it suggested this. Without it the plan is a list of
                          orders; with it, it is reasoning you can disagree with. */}
                      {t.reasoning && (
                        <p className="mt-2 flex gap-1.5 text-xs leading-relaxed"
                           style={{ color: 'var(--text-subtle)' }}>
                          <Info className="mt-px size-3 shrink-0" /> {t.reasoning}
                        </p>
                      )}
                    </div>
                    {done ? (
                      <span className="flex shrink-0 items-center gap-1 text-[13px] font-medium"
                            style={{ color: '#15803D' }}>
                        <Check className="size-3.5" /> Added
                      </span>
                    ) : (
                      <Button size="sm" loading={acceptingIdx === i}
                              onClick={() => void accept(t, i)}>
                        Add
                      </Button>
                    )}
                  </div>
                </Card>
              )
            })}

            {plan.some((_, i) => !accepted.has(i)) && (
              <div className="flex justify-end pt-1">
                <Button size="sm" variant="primary" onClick={() => void acceptAll()}
                        loading={acceptingIdx !== null}>
                  Add all {plan.filter((_, i) => !accepted.has(i)).length}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── what Oscar can do ────────────────────────────────────────── */}
      {/* Sourced from /assistant/business, which resolves per org: a DB profile, then
          the org's MCP, then a generic default. So this is the org's OWN copy where
          one exists rather than a hardcoded feature list. */}
      {biz.data?.capabilities?.length ? (
        <section>
          <SectionHeading>What Oscar can do for you</SectionHeading>
          <Card className="p-4">
            {biz.data.business && (
              <div className="mb-2.5 text-[13px] font-semibold">{biz.data.business}</div>
            )}
            {biz.data.note && (
              <p className="mb-3 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {biz.data.note}
              </p>
            )}
            <ul className="space-y-1.5">
              {biz.data.capabilities.map(c => (
                <li key={c} className="flex gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                  <Check className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                  {c}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </div>
  )
}
