import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Check, CheckCheck, Circle, Hash, MessageSquare, Reply, Send, X,
} from 'lucide-react'
import { ApiError, messages as msgApi, team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { subscribe } from '../../lib/appSocket'
import { lastSeenLabel, messageTime, titleCaseName } from '../../lib/format'
import type { ChatText } from '../../lib/types'
import { Avatar } from '../../shell/AppShell'
import {
  Button, Card, EmptyState, ErrorState, IconButton, Skeleton, cx, inputCls, inputStyle,
} from '../../ui'

/**
 * Team group chat and 1-on-1 DMs.
 *
 * Both were fully built server-side — `pa_team_messages`, `pa_direct_messages`,
 * read pointers, presence — and had no web UI at all.
 *
 * Two things about the backend shape the design:
 *
 *  · **`/conversations` returns `peer_id` only, not a name.** So the roster from
 *    `/teams/{id}/members` is a required second fetch, and a DM whose peer has left
 *    the team renders by id rather than vanishing.
 *
 *  · **Unread counts from `/conversations` are AUTHORITATIVE** — they come from read
 *    pointers in the database, so they survive a reload. They overwrite local
 *    counts; nothing here merges them, because a client-side tally is only ever
 *    correct for the current session.
 *
 * Master/detail: a list on the left, a thread on the right, and on a phone one at a
 * time with a back button. A single scrolling page of every conversation is how a
 * messaging UI becomes unusable at ten conversations.
 */
type Open = { kind: 'team'; teamId: number } | { kind: 'dm'; peerId: number } | null

export function MessagesScreen() {
  const me = getUser()
  const teamId = me?.team_id ?? null
  const [open, setOpen] = useState<Open>(null)

  const convos = useApi(s => msgApi.conversations(s), [], 'conversations')
  const reloadConvos = convos.reload
  const members = useApi(
    s => teamId ? teamApi.members(teamId, s) : Promise.resolve([]), [teamId], 'members')

  const nameOf = useCallback((id: number) => {
    const m = (members.data ?? []).find(x => x.user_id === id)
    // An id is a poor label, but it is honest — better than hiding a conversation
    // because the person is no longer on the roster.
    return titleCaseName(m?.name) || `User ${id}`
  }, [members.data])

  const onlineOf = useCallback((id: number) =>
    (members.data ?? []).find(x => x.user_id === id)?.online ?? false, [members.data])

  /** Flutter shows the ROLE when someone is offline, not the word "Offline" —
   *  "Team lead" is information; "Offline" repeats the dot that is already absent. */
  const subtitleOf = useCallback((id: number) => {
    const m = (members.data ?? []).find(x => x.user_id === id)
    if (m?.online) return 'Online'
    if (m?.last_seen) return lastSeenLabel(m.last_seen)
    return titleCaseName(m?.role?.replace(/_/g, ' ')) || 'Offline'
  }, [members.data])

  // A new message anywhere refreshes the list, so unread badges and ordering are
  // right without opening the thread.
  useEffect(() => subscribe(f => {
    if (f.type === 'team.message.created' || f.type === 'direct.message.created') {
      reloadConvos()
    }
  }), [reloadConvos])

  const dmPeers = useMemo(() => {
    const fromConvos = (convos.data?.dms ?? []).map(d => d.peer_id)
    // Everyone on the team is a possible DM, not only people already talked to —
    // otherwise there is no way to start a first conversation.
    const roster = (members.data ?? [])
      .filter(m => m.is_active && m.user_id !== me?.id)
      .map(m => m.user_id)
    return Array.from(new Set([...fromConvos, ...roster]))
  }, [convos.data, members.data, me?.id])

  const unreadFor = useCallback((peerId: number) =>
    (convos.data?.dms ?? []).find(d => d.peer_id === peerId)?.unread ?? 0, [convos.data])

  const lastAtFor = useCallback((peerId: number) =>
    (convos.data?.dms ?? []).find(d => d.peer_id === peerId)?.last_message_at ?? null,
  [convos.data])

  const sorted = useMemo(() => [...dmPeers].sort((a, b) => {
    // Conversations with history first, newest at the top; then the rest of the
    // roster alphabetically, so starting a new chat is still easy to find.
    const la = lastAtFor(a), lb = lastAtFor(b)
    if (la && lb) return lb.localeCompare(la)
    if (la) return -1
    if (lb) return 1
    return nameOf(a).localeCompare(nameOf(b))
  }), [dmPeers, lastAtFor, nameOf])

  // Narrowed once. This screen only renders inside the authenticated shell, so a
  // null user is a programming error rather than a state to handle at each use.
  if (!me || !teamId) {
    return (
      <Card>
        <EmptyState
          icon={<MessageSquare className="size-6" />}
          title="Messaging needs a workspace"
          body="Team chat and direct messages appear once you join one with an invite code."
        />
      </Card>
    )
  }

  const teamUnread = convos.data?.team?.unread ?? 0

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      {/* ── list ─────────────────────────────────────────────────────── */}
      <Card className={cx('overflow-hidden p-1.5', open && 'hidden lg:block')}>
        {convos.loading && !convos.data && <Skeleton rows={3} />}
        {convos.error && !convos.data && (
          <ErrorState error={convos.error} onRetry={convos.reload} />
        )}

        <button
          onClick={() => setOpen({ kind: 'team', teamId })}
          className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition"
          style={open?.kind === 'team' ? { background: 'var(--accent-soft)' } : undefined}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg"
                style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
            <Hash className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium">
              {me.team_name ?? 'Team'}
            </span>
            <span className="block text-[11px]" style={{ color: 'var(--text-subtle)' }}>
              Everyone
            </span>
          </span>
          {teamUnread > 0 && <Unread n={teamUnread} />}
        </button>

        <div className="my-1.5 h-px" style={{ background: 'var(--border)' }} />

        {sorted.length === 0 && !members.loading && (
          <p className="px-3 py-4 text-center text-[13px]" style={{ color: 'var(--text-subtle)' }}>
            No one else on the team yet.
          </p>
        )}

        {sorted.map(peerId => {
          const n = unreadFor(peerId)
          const active = open?.kind === 'dm' && open.peerId === peerId
          return (
            <button key={peerId}
                    onClick={() => setOpen({ kind: 'dm', peerId })}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition"
                    style={active ? { background: 'var(--accent-soft)' } : undefined}>
              <span className="relative shrink-0">
                <Avatar name={nameOf(peerId)} size={32} />
                {onlineOf(peerId) && (
                  <Circle className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full"
                          fill="#22C55E" strokeWidth={0}
                          style={{ outline: '2px solid var(--bg-elevated)' }} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate text-[13.5px]',
                                    n > 0 ? 'font-semibold' : 'font-medium')}>
                  {nameOf(peerId)}
                </span>
                <span className="block truncate text-[11px]"
                      style={{ color: 'var(--text-subtle)' }}>
                  {subtitleOf(peerId)}
                </span>
              </span>
              {n > 0 && <Unread n={n} />}
            </button>
          )
        })}
      </Card>

      {/* ── thread ───────────────────────────────────────────────────── */}
      {open ? (
        <Thread
          key={open.kind === 'team' ? `t${open.teamId}` : `d${open.peerId}`}
          open={open}
          title={open.kind === 'team' ? (me.team_name ?? 'Team') : nameOf(open.peerId)}
          subtitle={open.kind === 'team'
            ? 'Shared with the whole team'
            : subtitleOf(open.peerId)}
          onBack={() => setOpen(null)}
          onRead={convos.reload}
        />
      ) : (
        <Card className="hidden lg:block">
          <EmptyState
            icon={<MessageSquare className="size-6" />}
            title="Pick a conversation"
            body="Team chat is shared with everyone. Direct messages are private."
          />
        </Card>
      )}
    </div>
  )
}

function Unread({ n }: { n: number }) {
  return (
    <span className="min-w-[20px] shrink-0 rounded-full px-1.5 py-0.5 text-center
                     text-[11px] font-bold tabular-nums text-white"
          style={{ background: 'var(--accent)' }}>
      {n > 99 ? '99+' : n}
    </span>
  )
}

// ── one conversation ────────────────────────────────────────────────────────

function Thread({ open, title, subtitle, onBack, onRead }: {
  open: NonNullable<Open>
  title: string
  /** Presence for a DM ("Online" / "last seen today at 5:40 pm"), or the scope
   *  for the team thread. The Flutter screen puts it here too — it is the one
   *  place the information is useful without being a badge on every row. */
  subtitle: string
  onBack: () => void
  onRead: () => void
}) {
  const me = getUser()
  const isTeam = open.kind === 'team'

  const h = useApi(
    s => isTeam ? msgApi.team(open.teamId, s) : msgApi.direct(open.peerId, s),
    [isTeam ? open.teamId : open.peerId])

  /**
   * Only what arrived over the SOCKET lives in state. The fetched history stays in
   * the hook and the rendered thread is derived from both.
   *
   * Copying `h.data.messages` into state on every fetch — the obvious shape — meant
   * an effect whose only job was to mirror one piece of state into another, firing a
   * second render each time. Deriving is a render-time merge with no effect at all,
   * and it cannot go out of sync with the fetch.
   *
   * No reset is needed when the conversation changes: the parent keys <Thread> on
   * the conversation, so it remounts with empty live state.
   */
  const [live, setLive] = useState<{ rows: ChatText[]; readUpTo: number }>(
    { rows: [], readUpTo: 0 })

  const rows = useMemo(() => {
    const merged = [...(h.data?.messages ?? [])]
    const seen = new Set(merged.map(r => r.id))
    // Deduped by id: the sender receives its own frame back, and the POST response
    // was already appended optimistically.
    for (const r of live.rows) if (!seen.has(r.id)) { merged.push(r); seen.add(r.id) }
    return merged.sort((a, b) => a.id - b.id)
  }, [h.data, live.rows])

  const readUpTo = Math.max(h.data?.read_up_to_id ?? 0, live.readUpTo)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<ChatText | null>(null)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const firstPaint = useRef(true)

  // Live append. Filtered to THIS conversation — the socket carries every
  // conversation the user is in, and appending blindly puts one person's DM into
  // another's thread.
  useEffect(() => subscribe(f => {
    const p = (f.payload ?? {}) as Record<string, unknown>
    if (isTeam) {
      if (f.type !== 'team.message.created') return
      if (Number(p.team_id) !== open.teamId) return
    } else {
      if (f.type !== 'direct.message.created') return
      const a = Number(p.sender_id), b = Number(p.recipient_id)
      const mine = me?.id
      if (!((a === open.peerId && b === mine) || (a === mine && b === open.peerId))) return
    }
    const row = p as unknown as ChatText
    // Deduped by id: the sender also gets its own frame back, and the POST
    // response already appended it optimistically.
    setLive(v => v.rows.some(r => r.id === row.id)
      ? v : { ...v, rows: [...v.rows, row] })
  }), [isTeam, open, me?.id])

  // The other side read our messages — promote the ticks without a refetch. The
  // team frame carries the read-by-ALL pointer, so a group tick only doubles once
  // every member has caught up, which is what it should mean.
  useEffect(() => subscribe(f => {
    const p = (f.payload ?? {}) as Record<string, unknown>
    if (isTeam && f.type === 'team.message.read' && Number(p.team_id) === open.teamId) {
      setLive(v => ({ ...v, readUpTo: Math.max(v.readUpTo, Number(p.read_up_to_id) || 0) }))
    }
    if (!isTeam && f.type === 'direct.message.read' && Number(p.reader_id) === open.peerId) {
      setLive(v => ({ ...v, readUpTo: Math.max(v.readUpTo, Number(p.last_read_id) || 0) }))
    }
  }), [isTeam, open])

  // Opening a thread IS reading it. Fire-and-forget — a failed read receipt must
  // never block the messages from showing.
  //
  // The pointer is the highest id PRESENT, not a count: ids are the sequence the
  // server reasons about, and sending a stale one would leave the badge stuck.
  useEffect(() => {
    const highest = rows.reduce((n, r) => Math.max(n, r.id), 0)
    if (!highest) return
    const t = setTimeout(() => {
      const p = isTeam
        ? msgApi.readTeam(open.teamId, highest)
        : msgApi.readDirect(open.peerId, highest)
      void p.then(onRead).catch(() => { /* a lingering badge is not worth an error */ })
    }, 400)
    return () => clearTimeout(t)
  }, [isTeam, open, rows, onRead])

  /**
   * Scroll to the newest ONLY when already near the bottom.
   *
   * Ported from the Flutter screen deliberately: yanking the view down while
   * somebody is reading back through a thread is one of the most irritating things
   * a chat UI can do. First load always jumps; after that it follows.
   */
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    if (firstPaint.current || nearBottom) {
      endRef.current?.scrollIntoView({ block: 'end' })
      firstPaint.current = false
    }
  }, [rows.length])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true); setErr(null)
    try {
      const row = isTeam
        ? await msgApi.sendTeam(open.teamId, text, replyTo?.id ?? null)
        : await msgApi.sendDirect(open.peerId, text, replyTo?.id ?? null)
      setLive(v => v.rows.some(r => r.id === row.id)
      ? v : { ...v, rows: [...v.rows, row] })
      setDraft(''); setReplyTo(null)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally { setSending(false) }
  }, [draft, sending, isTeam, open, replyTo])

  return (
    <Card className="flex h-[calc(100dvh-230px)] flex-col overflow-hidden lg:h-[calc(100dvh-190px)]">
      <header className="flex items-center gap-2 border-b px-3 py-2.5"
              style={{ borderColor: 'var(--border)' }}>
        <IconButton label="Back" onClick={onBack} className="lg:hidden">
          <ArrowLeft className="size-4" />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{title}</div>
          <div className="truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
            {subtitle}
          </div>
        </div>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3.5 py-4">
        {h.loading && !h.data && <Skeleton rows={3} />}
        {h.error && !h.data && <ErrorState error={h.error} onRetry={h.reload} />}
        {!h.loading && rows.length === 0 && (
          <EmptyState title="No messages yet"
                      body={isTeam ? 'Say hello to the team.' : 'Start the conversation.'} />
        )}
        {rows.map((r, i) => {
          const authorId = r.sender_id ?? r.user_id
          const prevAuthor = i > 0 ? (rows[i - 1].sender_id ?? rows[i - 1].user_id) : null
          return (
            <Bubble key={r.id} row={r} mine={authorId === me?.id}
                    // Only the FIRST message of a run gets a name label — the
                    // Flutter rule. Repeating it on every bubble in a back-and-forth
                    // turns a conversation into a list of labelled rows.
                    showAuthor={isTeam && authorId !== prevAuthor}
                    read={r.id <= readUpTo}
                    onReply={() => setReplyTo(r)} />
          )
        })}
        <div ref={endRef} />
      </div>

      <div className="border-t px-3.5 py-3" style={{ borderColor: 'var(--border)' }}>
        {err && <p className="mb-2 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}
        {replyTo && (
          <div className="mb-2 flex items-start gap-2 rounded-lg px-2.5 py-1.5"
               style={{ background: 'var(--bg-sunken)' }}>
            <span className="w-[3px] self-stretch rounded-full"
                  style={{ background: 'var(--accent)' }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
                {replyTo.sender_name ?? replyTo.user_name ?? 'Message'}
              </span>
              <span className="block truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {replyTo.text}
              </span>
            </span>
            <button onClick={() => setReplyTo(null)} aria-label="Cancel reply"
                    style={{ color: 'var(--text-subtle)' }}>
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            }}
            rows={1}
            placeholder={isTeam ? 'Message the team…' : 'Message…'}
            className={cx(inputCls, 'max-h-32 min-h-[42px] resize-none py-2.5')}
            style={inputStyle}
          />
          <Button variant="primary" onClick={() => void send()}
                  loading={sending} disabled={!draft.trim()} aria-label="Send">
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  )
}

function Bubble({ row, mine, showAuthor, read, onReply }: {
  row: ChatText; mine: boolean; showAuthor: boolean; read: boolean; onReply: () => void
}) {
  const author = titleCaseName(row.sender_name ?? row.user_name ?? '')
  return (
    <div className={cx('group flex items-end gap-1.5', mine ? 'justify-end' : 'justify-start')}>
      {mine && (
        <button onClick={onReply} aria-label="Reply"
                className="opacity-0 transition group-hover:opacity-60"
                style={{ color: 'var(--text-subtle)' }}>
          <Reply className="size-3.5" />
        </button>
      )}
      <div className="max-w-[80%]">
        {/* Only in the team thread. In a DM there are two people and both are
            obvious, so a name on every bubble is noise. */}
        {showAuthor && !mine && author && (
          <div className="mb-0.5 px-1 text-[11px] font-semibold" style={{ color: 'var(--accent)' }}>
            {author}
          </div>
        )}
        <div className={cx('rounded-2xl px-3 py-2 text-[14px] leading-relaxed',
                           mine ? 'rounded-br-md' : 'rounded-bl-md')}
             style={mine
               ? { background: 'var(--accent)', color: '#fff' }
               : { background: 'var(--bg-sunken)', color: 'var(--text)' }}>
          {/* The quoted message, rendered from the server's own preview so a reply
              needs no second round trip. */}
          {row.reply_to && (
            <div className="mb-1.5 border-l-2 pl-2 text-[12px] opacity-80"
                 style={{ borderColor: mine ? 'rgba(255,255,255,.5)' : 'var(--border-strong)' }}>
              <span className="block font-semibold">{row.reply_to.author ?? 'Message'}</span>
              <span className="block truncate">{row.reply_to.text}</span>
            </div>
          )}
          <span className="whitespace-pre-wrap break-words">{row.text}</span>
        </div>
        <div className={cx('mt-0.5 flex items-center gap-1 px-1 text-[10.5px] tabular-nums',
                           mine ? 'justify-end' : 'justify-start')}
             style={{ color: 'var(--text-subtle)' }}>
          {messageTime(row.created_at)}
          {/* Ticks on OWN messages only — a tick on somebody else's message would
              be claiming they read their own words. Single ✓ sent, double ✓✓ read. */}
          {mine && (read
            ? <CheckCheck className="size-3.5" style={{ color: 'var(--accent)' }} />
            : <Check className="size-3.5" />)}
        </div>
      </div>
      {!mine && (
        <button onClick={onReply} aria-label="Reply"
                className="opacity-0 transition group-hover:opacity-60"
                style={{ color: 'var(--text-subtle)' }}>
          <Reply className="size-3.5" />
        </button>
      )}
    </div>
  )
}
