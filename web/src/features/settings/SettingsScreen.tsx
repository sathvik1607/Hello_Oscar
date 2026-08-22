import { useCallback, useEffect, useState } from 'react'
import { Check, Monitor, Moon, Sun, Wifi } from 'lucide-react'
import { health } from '../../lib/api'
import {
  DEFAULT_BASE, applyTheme, getBase, getTheme, getUser, setBase, signOut,
  type Theme,
} from '../../lib/session'
import { reset as resetSocket, watchConnection, type ConnState } from '../../lib/appSocket'
import { SPEAKERS } from '../../lib/speakers'
import { useVoice } from '../voice/VoiceProvider'
import { VOICE_CHORD_LABEL, VOICE_HOTKEY_LABEL } from '../../lib/hotkeys'
import {
  Badge, Button, Card, Confirmation, Field, SectionHeading, cx, inputCls, inputStyle,
} from '../../ui'

/**
 * Account, appearance, voice and connection.
 *
 * The connection block is the reason this screen is not just a theme toggle. This
 * backend runs on three services against one database, free-tier instances spin
 * down and cold-start for ~50 seconds, and the most common support question is
 * "is it me or is it down". A reachability check and a visible socket state answer
 * that without a devtools console.
 */
export function SettingsScreen() {
  const user = getUser()
  const [theme, setTheme] = useState<Theme>(getTheme())
  const [base, setBaseValue] = useState(getBase())
  const [conn, setConn] = useState<ConnState>('closed')
  const [probe, setProbe] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle')
  const [probeMsg, setProbeMsg] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // Voice settings live in the provider, so the picker and the ambient switch
  // affect the running engine rather than a second copy of the preference.
  const voice = useVoice()

  useEffect(() => watchConnection(setConn), [])

  const pickTheme = useCallback((t: Theme) => {
    setTheme(t)
    applyTheme(t)
  }, [])

  const saveBase = useCallback(async () => {
    const url = base.trim().replace(/\/+$/, '')
    if (!url) return
    setBase(url)
    setBaseValue(url)
    // The socket was opened against the OLD host; without a reset it stays there
    // while every HTTP call goes somewhere else — the app then looks half-broken
    // in a way nothing on screen explains.
    resetSocket()
    setSaved(true)
    setTimeout(() => setSaved(false), 2600)
  }, [base])

  const check = useCallback(async () => {
    setProbe('checking'); setProbeMsg(null)
    try {
      const r = await health()
      // /health is SHALLOW — no database check — so a green answer means the process
      // is up, not that the app works. Said plainly rather than implied.
      setProbe(r?.status === 'ok' ? 'ok' : 'fail')
      setProbeMsg(r?.status === 'ok'
        ? 'The server is up. (This check does not test the database.)'
        : `Unexpected answer: ${JSON.stringify(r)}`)
    } catch (e) {
      setProbe('fail')
      setProbeMsg((e as Error).message)
    }
  }, [])

  return (
    <div className="max-w-2xl space-y-7">
      {/* ── account ──────────────────────────────────────────────────── */}
      <section>
        <SectionHeading>Account</SectionHeading>
        <Card className="divide-y" style={{ borderColor: 'var(--border)' }}>
          <Row label="Name" value={user?.name ?? '—'} />
          <Row label="Email" value={user?.email ?? user?.username ?? '—'} />
          <Row label="Workspace" value={user?.team_name ?? 'Personal account'} />
          <Row label="Role"
               value={user?.role === 'team_lead' ? 'Team lead'
                    : user?.role === 'team_member' ? 'Member'
                    : (user?.account_type ?? '—')} />
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              Signed in on this browser
            </div>
            <Button size="sm" onClick={signOut}>Sign out</Button>
          </div>
        </Card>
      </section>

      {/* ── appearance ───────────────────────────────────────────────── */}
      <section>
        <SectionHeading>Appearance</SectionHeading>
        <Card className="p-4">
          <Field label="Theme">
            <div className="flex gap-1.5">
              {([
                ['light', 'Light', Sun],
                ['dark', 'Dark', Moon],
                ['system', 'System', Monitor],
              ] as const).map(([id, label, Icon]) => (
                <button key={id} onClick={() => pickTheme(id)}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg
                                   border py-2 text-[13px] font-medium transition"
                        style={theme === id
                          ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)',
                              color: 'var(--accent)' }
                          : { background: 'var(--bg)', borderColor: 'var(--border)',
                              color: 'var(--text-muted)' }}>
                  <Icon className="size-3.5" /> {label}
                </button>
              ))}
            </div>
          </Field>
        </Card>
      </section>

      {/* ── voice ────────────────────────────────────────────────────── */}
      <section>
        <SectionHeading>Voice</SectionHeading>
        <Card className="space-y-4 p-4">
          <Field label="Oscar's voice"
                 hint="Sarvam bulbul:v3. The first five are male voices, the rest female.">
            <select value={voice.speaker}
                    onChange={e => voice.setSpeaker(e.target.value)}
                    className={inputCls} style={inputStyle}>
              {SPEAKERS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>

          <div className="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5"
               style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
            <span className="text-[13px]">Talk to Oscar from any screen</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <kbd className="rounded px-2 py-1 text-[11px] font-semibold"
                   style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
                {VOICE_CHORD_LABEL}
              </kbd>
              <span className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>or</span>
              <kbd className="rounded px-2 py-1 text-[11px] font-semibold"
                   style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
                {VOICE_HOTKEY_LABEL}
              </kbd>
            </span>
          </div>

          {/* ── ambient wake ─────────────────────────────────────────── */}
          <div className="rounded-xl border p-3.5"
               style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
            <label className="flex items-start gap-3">
              <input type="checkbox" checked={voice.ambient} className="mt-0.5"
                     onChange={e => voice.setAmbient(e.target.checked)} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">
                  Listen for &ldquo;Oscar&rdquo; in the background
                </span>
                <span className="mt-1 block text-xs leading-relaxed"
                      style={{ color: 'var(--text-subtle)' }}>
                  The microphone stays open while this tab is, so you can say
                  &ldquo;Oscar, what&rsquo;s due today&rdquo; without tapping anything.
                  It only acts on what is addressed to it by name.
                </span>
                {/* Stated plainly, because both consequences are real and neither is
                    obvious: a continuously-open socket is billed per second and
                    transcribes whatever is said nearby. */}
                <span className="mt-2 block text-xs leading-relaxed"
                      style={{ color: '#B45309' }}>
                  Speech is transcribed continuously while this is on — including
                  conversations near your microphone — and that is billed per minute.
                  Off by default for exactly that reason.
                </span>
              </span>
            </label>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
            Speech is relayed through the Oscar server, which holds the Sarvam
            credential — it never reaches this page. The microphone stays open only
            while a voice call is on screen, and Oscar acts only on what is addressed
            to it by name.
          </p>
        </Card>
      </section>

      {/* ── connection ───────────────────────────────────────────────── */}
      <section>
        <SectionHeading>Connection</SectionHeading>
        <Card className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-medium">Live connection</div>
            <Badge tone={conn === 'open' ? 'completed'
                       : conn === 'reconnecting' ? 'in_progress' : 'neutral'}>
              <Wifi className="size-3" />
              {conn === 'open' ? 'Connected'
               : conn === 'reconnecting' ? 'Reconnecting'
               : conn === 'connecting' ? 'Connecting' : 'Offline'}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-subtle)' }}>
            Streaming replies, reminders and live task updates all arrive over this.
            When it is down, Oscar falls back to a slower non-streaming reply.
          </p>

          <Field label="Backend URL"
                 hint={`Default: ${DEFAULT_BASE}. Changing this reconnects everything.`}>
            <div className="flex gap-2">
              <input value={base} onChange={e => setBaseValue(e.target.value)}
                     spellCheck={false} className={inputCls} style={inputStyle} />
              <Button onClick={() => void saveBase()}
                      disabled={base.trim().replace(/\/+$/, '') === getBase()}>
                Save
              </Button>
            </div>
          </Field>
          {saved && <Confirmation>Reconnected to {getBase()}</Confirmation>}

          <div className="flex items-center gap-2.5">
            <Button size="sm" loading={probe === 'checking'} onClick={() => void check()}>
              Test connection
            </Button>
            {probe === 'ok' && (
              <span className="flex items-center gap-1 text-[13px]" style={{ color: '#15803D' }}>
                <Check className="size-3.5" /> Reachable
              </span>
            )}
            {probe === 'fail' && (
              <span className="text-[13px]" style={{ color: '#DC2626' }}>Unreachable</span>
            )}
          </div>
          {probeMsg && (
            <p className={cx('text-xs leading-relaxed')}
               style={{ color: probe === 'fail' ? '#DC2626' : 'var(--text-subtle)' }}>
              {probeMsg}
            </p>
          )}
        </Card>
      </section>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="min-w-0 truncate text-[13px] font-medium">{value}</span>
    </div>
  )
}
