import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, Loader2, MessagesSquare, Plus, Send, Sparkles, Trash2,
} from 'lucide-react'
import { ApiError, assistant, chat as chatApi, team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { subscribe, watchConnection, type ConnState } from '../../lib/appSocket'
import { messageTime, titleCaseName } from '../../lib/format'
import { getUser } from '../../lib/session'
import { activeQuery, applyPick } from '../messages/mentions'
import { Avatar } from '../../shell/AppShell'
import { InlineCards, OscarPanel } from './OscarPanel'
import { matchReplyTasks } from './replyTasks'
import { useSpokenTasks } from './useSpokenTasks'
import { TaskDetail } from '../tasks/TaskDetail'
import { useTaskActions } from '../tasks/useTaskActions'
import type { Task, TeamMember } from '../../lib/types'
import {
  Button, Card, EmptyState, IconButton, Skeleton, cx, inputCls, inputStyle, Linkify} from '../../ui'

/**
 * Talking to Oscar.
 *
 * Streams over the WebSocket the app already holds — there is no SSE here and no
 * second transport. `POST /chat/stream` returns in ~0.2s with just an id; the answer
 * arrives as frames (`chat.thinking` → `chat.delta` → `chat.tool` → `chat.complete`).
 *
 * Four things this has to get right, each of which is a real backend behaviour and
 * not a UI preference:
 *
 * 1. **`chat.complete.text` is AUTHORITATIVE and replaces the buffer.** That is the
 *    documented contract, and it is the only way a fast-path reply arrives — those
 *    emit ZERO deltas. A client that only renders deltas is silent for every
 *    greeting and every "what's due today", which are the two most common things
 *    anyone types.
 *
 * 2. **A structured (JSON) answer also emits no deltas.** The agent sometimes
 *    answers with raw JSON (a `requires_input` envelope, a contact tool_call);
 *    streaming that would spray `{"type":"requi…` across the screen. The backend
 *    withholds deltas in that case, so nothing here needs to guess — but it must
 *    not assume deltas always come.
 *
 * 3. **`chat.tool` matters more than the token streaming.** A tool call is seconds
 *    of silence, and a blinking cursor there reads as hung. The backend names what
 *    it is doing ("checking your tasks"); showing that turns a hang into a wait.
 *
 * 4. **`streaming: false` means the server saw no live socket** and generated
 *    nothing. Fall back to the blocking `/chat` deterministically rather than
 *    waiting forever for frames that will never arrive.
 */

type Turn = {
  /** Local id. The server's message id arrives later (or not at all if the persist
   *  failed), so the list cannot be keyed on it. */
  key: string
  role: 'user' | 'assistant'
  text: string
  at?: string | null
  /** Streaming in progress — drives the cursor. */
  live?: boolean
  /** What tool is running, if one is. */
  tool?: string | null
  error?: boolean
}

export function ChatScreen() {
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [conn, setConn] = useState<ConnState>('closed')
  const [atBottom, setAtBottom] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  /**
   * @mention picker — the same one team chat has, wired into Oscar's composer.
   *
   * It was missing here, and `@` is REAL SYNTAX in this endpoint rather than
   * decoration: prompt rule 23b routes "@name <text>" to `send_to_member`, its
   * CRITICAL OVERRIDE turns "assign task @name …" into `create_task`, and 23c makes
   * "@notifyall" a broadcast. So typing `@` here already changed which tool ran —
   * you just had to spell the name exactly right from memory, and a misspelling
   * silently became prose instead of a mention.
   *
   * 🔴 THE WHOLE-TEAM TOKEN IS `@notifyall`, NOT `@everyone`. Team chat's picker
   * offers "@everyone" because the messages endpoint has a `mention_all` flag;
   * Oscar has no such flag and rule 23c keys on the literal word "notifyall".
   * Inserting "@everyone" here would produce a plausible-looking mention that
   * broadcasts to nobody — which is why this builds its own candidate list rather
   * than reusing `matches()`.
   */
  const [mentionQ, setMentionQ] = useState<string | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const me = getUser()
  const roster = useApi(s2 => (me?.team_id ? teamApi.members(me.team_id, s2)
                                          : Promise.resolve([] as TeamMember[])),
                        [me?.team_id], 'members')

  const picks = useMemo(() => {
    if (mentionQ === null) return []
    const q = mentionQ.toLowerCase()
    const all = 'notifyall'.startsWith(q) || 'everyone'.startsWith(q) || 'all'.startsWith(q)
      // A pseudo-row, so the list needs no special case. `user_id: -1` mirrors the
      // backend's ALL_MEMBERS_ID sentinel and is never sent anywhere.
      ? [{ user_id: -1, name: 'notifyall' } as TeamMember]
      : []
    return [...all, ...(roster.data ?? [])
      // Mentioning yourself would ask Oscar to DM you your own message.
      .filter(m => m.is_active && m.user_id !== me?.id)
      .filter(m => !q || m.name.toLowerCase().includes(q))]
      .slice(0, 6)
  }, [mentionQ, roster.data, me?.id])

  const pickMention = useCallback((m: TeamMember) => {
    const ta = taRef.current
    const caret = ta?.selectionStart ?? draft.length
    const next = applyPick(draft, caret, m.name)
    setDraft(next.text)
    setMentionQ(null)
    // Caret restored after the repaint — otherwise the browser drops it at the end
    // and a mention typed mid-sentence throws the cursor away.
    requestAnimationFrame(() => {
      ta?.focus(); ta?.setSelectionRange(next.caret, next.caret)
    })
  }, [draft])
  /** The task open beside the conversation. Held here, not in the bubble, so only one
   *  is ever open and the pane survives new turns arriving above it. */
  const [openTask, setOpenTask] = useState<Task | null>(null)
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches)

  const scroller = useRef<HTMLDivElement>(null)

  const sessions = useApi(s => chatApi.sessions(s))
  // Pulled out because it is the only stable member of the hook result —
  // depending on `sessions` itself would re-subscribe on every render.
  const reloadSessions = sessions.reload
  const suggestions = useApi(s => assistant.suggestions(s))
  /**
   * The tasks a reply can be matched against — mine, what I delegated, and the
   * team's, deduped. Shared with the voice overlay so the two cannot disagree about
   * which tasks Oscar is allowed to have named. See useSpokenTasks.
   */
  const { pool: taskList, patch, reload: reloadTasks } = useSpokenTasks()

  // Completing from a card behaves exactly as it does on Today or Tasks — same
  // optimistic update, same rollback, same refusal to route a completion through
  // PATCH /items.
  const { toggle, busyId } = useTaskActions(patch, reloadTasks)

  useEffect(() => watchConnection(setConn), [])

  /**
   * Side by side above `lg`, a sheet below it.
   *
   * A JS media query rather than CSS, because the two are different COMPONENT TREES,
   * not two styles: `TaskDetail` as a sheet is modal and portalled out of the layout,
   * as a column it is a plain flex child. Rendering both and hiding one with
   * `lg:hidden` would mount two copies of the comment thread — every comment fetched
   * twice, and posted into two live subscriptions.
   */
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  // ── frames ────────────────────────────────────────────────────────────────
  useEffect(() => subscribe(f => {
    const p = (f.payload ?? {}) as Record<string, unknown>
    const text = typeof p.text === 'string' ? p.text : ''

    switch (f.type) {
      case 'chat.thinking':
        // The assistant bubble is created here rather than on send, so a fast-path
        // reply (which skips straight to complete) does not leave an empty bubble
        // sitting on screen if the request itself fails.
        setTurns(t => t.some(x => x.live)
          ? t
          : [...t, { key: `a-${Date.now()}`, role: 'assistant', text: '', live: true }])
        break

      case 'chat.delta':
        if (!text) return
        setTurns(t => appendLive(t, prev => prev + text))
        break

      case 'chat.tool':
        setTurns(t => t.map(x => x.live
          ? { ...x, tool: typeof p.label === 'string' ? p.label : 'Working on it' }
          : x))
        break

      /**
       * 🔴 `chat.message.created` is DELIBERATELY NOT HANDLED, and this note exists
       * so nobody adds it back thinking it was an oversight.
       *
       * It looks like the proactive-message channel — a scheduler reminder arriving
       * while you have chat open. It is not usable for that, because the payload is
       * `{message, user_id, message_id}` with NOTHING identifying what kind of
       * thing it is, and `notification_service.send()` fires broadcast_chat for
       * EVERY notification type. Verified against a running backend: sending a
       * direct message produces `chat.message.created` alongside
       * `direct.message.created`.
       *
       * So rendering it here would drop a teammate's DM into the Oscar transcript
       * as though the assistant had said it. That is worse than missing reminders,
       * which already reach the user three other ways — the Activity list, the nav
       * badge and the tab title.
       *
       * `message_id` almost distinguishes them ("n:" notification, "c:" chat row),
       * but the only "c:" case is the non-streaming POST /chat reply, which this
       * screen already appends from the HTTP response — so handling it would
       * double-render instead.
       *
       * To make this work the backend needs a `kind` (or the notification type) in
       * the payload. Until then, not rendering is the correct behaviour.
       */

      case 'chat.complete':
        // REPLACE, never append. Deltas may have arrived, or may not have; either
        // way this text is the answer.
        setTurns(t => t.map(x => x.live
          ? { ...x, text, live: false, tool: null, at: new Date().toISOString() }
          : x))
        setSending(false)
        // The session's title and preview are derived from the first message, so
        // the list is stale until this lands.
        reloadSessions()
        // And so is the task list: the turn may have CREATED the task the reply is
        // about ("reminder set for 7 PM"), and a card cannot be matched against a
        // list that predates it.
        reloadTasks()
        break
    }
  }), [reloadSessions, reloadTasks])

  // ── autoscroll, but only when the user is already at the bottom ───────────
  // Yanking the view down while someone is reading back through the conversation
  // is one of the most irritating things a chat UI can do.
  useEffect(() => {
    if (!atBottom) return
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [turns, atBottom])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    // 80px of slack: exact-bottom detection fails on fractional scroll heights and
    // the autoscroll then switches itself off mid-reply.
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }, [])

  // ── sending ───────────────────────────────────────────────────────────────
  const send = useCallback(async (message: string) => {
    const text = message.trim()
    if (!text || sending) return

    setErr(null)
    setSending(true)
    setAtBottom(true)
    setDraft('')
    setTurns(t => [...t, {
      key: `u-${Date.now()}`, role: 'user', text, at: new Date().toISOString(),
    }])

    try {
      let sid = sessionId
      if (!sid) {
        // Opening a session scopes this conversation to itself. Without one every
        // turn lands in the AMBIENT history bucket, which is shown to EVERY
        // conversation — so an image sent from the phone a minute earlier leaks
        // into an unrelated "hi".
        const s = await chatApi.newSession()
        sid = s.session_id
        setSessionId(sid)
        sessions.reload()
      }

      const r = await chatApi.stream(text, sid)
      if (r.streaming === false) {
        // No live socket server-side. Frames would never arrive, so take the
        // blocking path rather than showing a cursor forever.
        const done = await chatApi.send(text, sid)
        setTurns(t => [...t, {
          key: `a-${Date.now()}`, role: 'assistant',
          text: done.response, at: new Date().toISOString(),
        }])
        setSending(false)
      }
      // Otherwise the frames handler above finishes the turn.
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      setErr(msg)
      setTurns(t => [...t.filter(x => !x.live), {
        key: `e-${Date.now()}`, role: 'assistant',
        text: "I couldn't send that.", error: true,
      }])
      setSending(false)
    }
  }, [sending, sessionId, sessions])

  const openSession = useCallback(async (id: number) => {
    setShowSessions(false)
    setSessionId(id)
    setTurns([])
    setErr(null)
    try {
      const h = await chatApi.history(id)
      setTurns(h.messages
        // 'system' rows exist in the table and are not conversation.
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          key: `h-${m.id}`,
          role: m.role as 'user' | 'assistant',
          text: m.content,
          at: m.created_at,
        })))
      setAtBottom(true)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  const newChat = useCallback(() => {
    setSessionId(null); setTurns([]); setErr(null); setShowSessions(false)
  }, [])

  const chips = useMemo(() => suggestions.data?.suggestions?.slice(0, 4) ?? [], [suggestions.data])
  const list = sessions.data?.sessions ?? []

  /**
   * The tasks the LATEST answer named — the panel shows one set, not a history.
   *
   * Derived from the last finished assistant turn rather than accumulated across the
   * conversation: cards from three questions ago competing with the current answer is
   * exactly what moving this out of the transcript was meant to fix.
   */
  const panelTasks = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      if (t.role !== 'assistant' || t.live) continue
      return matchReplyTasks(t.text, taskList)
    }
    return []
  }, [turns, taskList])

  // The panel is shown for a task OR for a list — either is a reason to split.
  const splitOpen = wide && (openTask !== null || panelTasks.length > 0)

  // Re-read the open task out of the refreshed list, so completing or editing it in
  // the pane is reflected in the pane itself and in the card behind it.
  const paneTask = openTask
    ? (taskList.find(t => t.id === openTask.id) ?? openTask)
    : null

  return (
    /* The row IS the split: Oscar keeps its own column and stays usable while a task
       is open beside it. That is the point — you asked for the task in this
       conversation, so acting on it should not take the conversation away. */
    <div className="flex h-[calc(100dvh-190px)] gap-3 lg:h-[calc(100dvh-150px)]">
    <div className="flex min-w-0 flex-1 flex-col">
      {/* ── toolbar ──────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" onClick={newChat}><Plus className="size-3.5" /> New</Button>
        <Button size="sm" onClick={() => setShowSessions(v => !v)}>
          <MessagesSquare className="size-3.5" />
          <span className="hidden sm:inline">History</span>
          {list.length > 0 && <span className="tabular-nums opacity-60">{list.length}</span>}
        </Button>
        <div className="flex-1" />
      </div>

      {showSessions && (
        <Card className="fade mb-3 max-h-56 overflow-y-auto p-1.5">
          {sessions.loading && <Skeleton rows={2} />}
          {list.length === 0 && !sessions.loading && (
            <p className="px-3 py-4 text-center text-[13px]" style={{ color: 'var(--text-subtle)' }}>
              No earlier conversations.
            </p>
          )}
          {list.map(s => (
            <div key={s.id} className="flex items-center gap-1">
              <button onClick={() => void openSession(s.id)}
                      className={cx('min-w-0 flex-1 rounded-lg px-3 py-2 text-left transition')}
                      style={sessionId === s.id
                        ? { background: 'var(--accent-soft)' } : undefined}>
                <div className="truncate text-[13px] font-medium">
                  {s.title || 'Untitled conversation'}
                </div>
                <div className="truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                  {s.message_count} messages{s.preview ? ` · ${s.preview}` : ''}
                </div>
              </button>
              <IconButton label="Delete conversation"
                          onClick={async () => {
                            await chatApi.deleteSession(s.id)
                            if (sessionId === s.id) newChat()
                            sessions.reload()
                          }}>
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          ))}
        </Card>
      )}

      {/* ── transcript ───────────────────────────────────────────────── */}
      <Card className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={scroller} onScroll={onScroll}
             className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
          {turns.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="size-6" />}
              title="Ask Oscar anything"
              body="Reminders, meetings, what's due — say it the way you'd say it to a person."
            />
          ) : (
            turns.map(t => (
              <Bubble key={t.key} turn={t} tasks={taskList} wide={wide}
                      busyId={busyId} onOpen={setOpenTask}
                      onToggle={tk => void toggle(tk)} />
            ))
          )}
        </div>

        {/* Jump-to-latest. Appears only when scrolled away, because a permanent
            button implies you are always behind. */}
        {!atBottom && (
          <button
            onClick={() => {
              setAtBottom(true)
              scroller.current?.scrollTo({
                top: scroller.current.scrollHeight, behavior: 'smooth',
              })
            }}
            className="fade absolute bottom-[86px] left-1/2 -translate-x-1/2 rounded-full
                       border px-3 py-1.5 text-xs font-medium shadow-sm"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <ArrowDown className="mr-1 inline size-3" /> Latest
          </button>
        )}

        {/* ── starter chips ────────────────────────────────────────── */}
        {turns.length === 0 && chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-3 sm:px-5">
            {chips.map(c => (
              // 🔴 Fills the composer, never sends. A tap that fires an
              // irreversible request is a worse mistake than one that fills a text
              // field — and these chips sit next to an agent that can create tasks
              // and message a team.
              <button key={c} onClick={() => setDraft(c)}
                      className="rounded-full border px-3 py-1.5 text-[12.5px] transition
                                 hover:brightness-[.97]"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)',
                               color: 'var(--text-muted)' }}>
                {c}
              </button>
            ))}
          </div>
        )}

        {/* ── composer ─────────────────────────────────────────────── */}
        <div className="border-t px-4 py-3 sm:px-5" style={{ borderColor: 'var(--border)' }}>
          {err && <p className="mb-2 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}
          {conn !== 'open' && (
            <p className="mb-2 text-[12px]" style={{ color: '#B45309' }}>
              {conn === 'reconnecting'
                ? 'Reconnecting — your message will go through the slower path.'
                : 'Connecting to Oscar…'}
            </p>
          )}
          {/* Above the composer, so it never covers the reply you are reading. */}
          {picks.length > 0 && (
            <div className="mb-1.5 overflow-hidden rounded-lg border"
                 style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
              {picks.map((m, i) => (
                <button key={m.user_id} type="button"
                        // onMouseDown, not onClick — onClick fires after blur, and the
                        // blur closes the picker before the pick registers.
                        onMouseDown={e => { e.preventDefault(); pickMention(m) }}
                        className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]',
                                      i === mentionIdx && 'bg-black/5 dark:bg-white/10')}>
                  {m.user_id === -1 ? (
                    <>
                      <span className="grid size-5 place-items-center rounded-full text-[10px] font-bold"
                            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>@</span>
                      <span>notifyall</span>
                      <span className="ml-auto text-[10.5px]" style={{ color: 'var(--text-subtle)' }}>
                        the whole team
                      </span>
                    </>
                  ) : (
                    <>
                      <Avatar name={m.name} size={20} />
                      <span className="truncate">{titleCaseName(m.name)}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              value={draft}
              onChange={e => {
                setDraft(e.target.value)
                setMentionQ(activeQuery(e.target.value, e.target.selectionStart ?? 0))
                setMentionIdx(0)
              }}
              // Clicking elsewhere moves the caret, which changes which token is being
              // typed — without this the picker keeps offering a query the cursor left.
              onSelect={e => setMentionQ(
                activeQuery(draft, (e.target as HTMLTextAreaElement).selectionStart ?? 0))}
              onBlur={() => setMentionQ(null)}
              onKeyDown={e => {
                if (picks.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault(); setMentionIdx(i => (i + 1) % picks.length); return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionIdx(i => (i - 1 + picks.length) % picks.length); return
                  }
                  // Enter completes the name instead of sending. Sending a half-typed
                  // mention is the exact mistake the picker exists to prevent — and
                  // here it would silently change which TOOL runs.
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault(); pickMention(picks[mentionIdx]); return
                  }
                  if (e.key === 'Escape') { e.preventDefault(); setMentionQ(null); return }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft) }
              }}
              rows={1}
              placeholder="Remind me to call Priya at 4…"
              className={cx(inputCls, 'max-h-36 min-h-[44px] resize-none py-3')}
              style={inputStyle}
            />
            <Button variant="primary" onClick={() => void send(draft)}
                    loading={sending} disabled={!draft.trim()} aria-label="Send">
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>

      {/* ── pulled up beside the conversation, never inside it ────────── */}
      {splitOpen && (
        <div className="fade hidden w-[420px] shrink-0 lg:block xl:w-[460px]">
          <OscarPanel tasks={panelTasks} openTask={paneTask}
                      onOpen={setOpenTask} onBack={() => setOpenTask(null)}
                      onToggle={tk => void toggle(tk)} busyId={busyId}
                      onChanged={reloadTasks} />
        </div>
      )}

      {/* Below lg there is no side to put a panel on, so a tapped task opens as the
          modal sheet it is on every other screen. */}
      {!wide && paneTask && (
        <TaskDetail task={paneTask}
                    onClose={() => setOpenTask(null)}
                    onChanged={reloadTasks} />
      )}
    </div>
  )
}

function Bubble({ turn, tasks, onOpen, onToggle, busyId, wide }: {
  turn: Turn
  tasks: Task[]
  onOpen: (t: Task) => void
  onToggle: (t: Task) => void
  busyId?: number | null
  wide: boolean
}) {
  const mine = turn.role === 'user'
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[85%] sm:max-w-[75%]')}>
        <div
          className={cx('rounded-2xl px-3.5 py-2.5 text-[14.5px] leading-relaxed',
                        mine ? 'rounded-br-md' : 'rounded-bl-md')}
          style={mine
            ? { background: 'var(--accent)', color: '#fff' }
            : turn.error
              ? { background: 'rgba(239,68,68,.1)', color: '#DC2626' }
              : { background: 'var(--bg-sunken)', color: 'var(--text)' }}
        >
          {/* Whitespace preserved: Oscar's answers contain deliberate line breaks
              and collapsing them turns a list into a run-on sentence. */}
          <span className="whitespace-pre-wrap break-words"><Linkify text={turn.text} /></span>

          {/* A caret while streaming, so an in-progress reply is visibly in progress
              rather than looking finished-but-short. */}
          {turn.live && !turn.tool && (
            <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px]
                             animate-pulse align-middle"
                  style={{ background: 'currentColor', opacity: .55 }} />
          )}

          {/* Tool activity, in the backend's own words. Never the tool NAME — the
              user does not need to know a function called get_tasks exists. */}
          {turn.live && turn.tool && (
            <span className="flex items-center gap-1.5 text-[13px]"
                  style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="size-3 animate-spin" /> {turn.tool}…
            </span>
          )}
        </div>
        {/* 🔴 NARROW SCREENS ONLY. On a wide screen these live in the side panel,
            and rendering them here as well would show the same tasks twice — plus a
            stale copy under every earlier answer. `wide` is the switch, not a
            breakpoint class, because the two are different trees. */}
        {!mine && !turn.live && !wide && (
          <InlineCards tasks={matchReplyTasks(turn.text, tasks)} onOpen={onOpen}
                       onToggle={onToggle} busyId={busyId} />
        )}

        {turn.at && !turn.live && (
          <div className={cx('mt-1 px-1 text-[11px] tabular-nums',
                             mine ? 'text-right' : 'text-left')}
               style={{ color: 'var(--text-subtle)' }}>
            {messageTime(turn.at)}
          </div>
        )}
      </div>
    </div>
  )
}

/** Update the one live assistant turn. Returns the list unchanged when there isn't
 *  one — a delta with no bubble means the frames arrived out of order, and inventing
 *  a bubble for it would duplicate the reply. */
function appendLive(turns: Turn[], fn: (prev: string) => string): Turn[] {
  const i = turns.findIndex(t => t.live)
  if (i === -1) {
    return [...turns, { key: `a-${Date.now()}`, role: 'assistant', text: fn(''), live: true }]
  }
  const next = [...turns]
  next[i] = { ...next[i], text: fn(next[i].text) }
  return next
}
