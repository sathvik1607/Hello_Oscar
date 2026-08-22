import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, Loader2, MessagesSquare, Mic, Plus, Send, Sparkles, Trash2,
} from 'lucide-react'
import { ApiError, assistant, chat as chatApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { subscribe, watchConnection, type ConnState } from '../../lib/appSocket'
import { messageTime } from '../../lib/format'
import { useVoice } from '../voice/VoiceProvider'
import {
  Button, Card, EmptyState, IconButton, Skeleton, cx, inputCls, inputStyle,
} from '../../ui'

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

  const scroller = useRef<HTMLDivElement>(null)
  const { openVoice } = useVoice()

  const sessions = useApi(s => chatApi.sessions(s))
  // Pulled out because it is the only stable member of the hook result —
  // depending on `sessions` itself would re-subscribe on every render.
  const reloadSessions = sessions.reload
  const suggestions = useApi(s => assistant.suggestions(s))

  useEffect(() => watchConnection(setConn), [])

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
        break
    }
  }), [reloadSessions])

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

  return (
    <div className="flex h-[calc(100dvh-190px)] flex-col lg:h-[calc(100dvh-150px)]">
      {/* ── toolbar ──────────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" onClick={newChat}><Plus className="size-3.5" /> New</Button>
        <Button size="sm" onClick={() => setShowSessions(v => !v)}>
          <MessagesSquare className="size-3.5" />
          <span className="hidden sm:inline">History</span>
          {list.length > 0 && <span className="tabular-nums opacity-60">{list.length}</span>}
        </Button>
        <div className="flex-1" />
        <Button size="sm" onClick={openVoice}><Mic className="size-3.5" /> Voice</Button>
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
            turns.map(t => <Bubble key={t.key} turn={t} />)
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
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
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
  )
}

function Bubble({ turn }: { turn: Turn }) {
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
          <span className="whitespace-pre-wrap break-words">{turn.text}</span>

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
