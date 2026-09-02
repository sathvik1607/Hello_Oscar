import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, KeyRound, Mail } from 'lucide-react'
import { ApiError, auth } from '../../lib/api'
import {
  baseIsLocked, getBase, markUpdatedReload, setBase, signIn, takeSignOutReason,
} from '../../lib/session'
import { Logo } from '../../shell/AppShell'
import {
  Button, Card, Field, cx, inputCls, inputStyle,
} from '../../ui'

/**
 * Sign in.
 *
 * `POST /auth/login` returns a user AND — additively, for this app — a signed bearer
 * token. Both are required: a user with no token is the state a backend with no
 * `WEB_TOKEN_SECRET` produces, and letting that count as signed in gives you an app
 * that renders fully and then 401s on every request. Better to say so here.
 *
 * There is no registration form. The three registration paths each need a gate code
 * (`PLATFORM_INVITE_CODE`, a workspace invite, or `SUPER_ADMIN_PASS`) that a public
 * page has no business collecting or hinting at, and self-serve account creation is
 * a product decision rather than a missing screen. Joining a workspace by invite
 * code is offered after sign-in, where the account already exists.
 */
export function AuthScreen({ updated = false }: { updated?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Explains an automatic sign-out that just happened, so being bounced here does
  // not read as a bug. One-shot: read and cleared, so it never shows on a later visit.
  /**
   * One line, in the user's terms.
   *
   * 🔴 No build ids, no mention of caches, tabs, bundles or backends. Those were in
   * an earlier version of this copy and they are developer facts: a person signing
   * in does not know what a bundle is, and naming one turns a routine update into
   * something that looks like it needs investigating. All they need is why they are
   * seeing a login screen and what to do — sign in.
   *
   * Two sources, same sentence, because the user's situation is identical either
   * way: `updated` (this tab is running an older version) and a stale-identity
   * sign-out. Distinguishing them would be a distinction only we care about.
   */
  const [notice] = useState<string | null>(() => {
    const signedOut = takeSignOutReason() === 'stale_identity'
    return updated || signedOut
      ? 'We’ve updated Oscar. Please sign in again to continue.'
      : null
  })
  const [err, setErr] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [baseUrl, setBaseUrl] = useState(getBase())

  useEffect(() => { document.title = 'Sign in · Oscar' }, [])

  /**
   * 🔴 A stale tab reloads the moment it lands here — BEFORE the user types.
   *
   * Reaching this screen does not re-download anything: the tab is still running
   * the older code, backend URL included. Without this, signing in would return the
   * user to the same outdated app and the notice would greet them again — a loop
   * they cannot escape by following instructions.
   *
   * Done on ARRIVAL rather than on submit, because reloading after someone has
   * typed their password throws that password away. On arrival there is nothing to
   * lose, the reload is invisible (they see a login screen either way), and the
   * form they then fill in belongs to the current version.
   *
   * The one-shot reason is planted first, so the fresh page shows the notice it
   * would otherwise lose in the reload.
   */
  useEffect(() => {
    if (!updated) return
    markUpdatedReload()
    location.reload()
  }, [updated])

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setErr(null)
    // Persisted BEFORE the request so the api client sends it to the right host.
    //
    // 🔴 ONLY when the override is actually live, i.e. local dev. This used to run
    // unconditionally, and because `baseUrl` is seeded from getBase(), EVERY login
    // wrote the then-current URL into localStorage — including on the deployed site,
    // where the field below is not even rendered. That froze the backend URL at
    // whatever it was on the day you first signed in: later deploys changed the
    // compiled URL and the app ignored all of them, calling a host that had since
    // been suspended and naming it in an error that no longer appears anywhere in
    // the bundle. getBase() now prefers the build, and this no longer writes a key
    // that would need purging.
    if (!baseIsLocked()) setBase(baseUrl)

    try {
      const r = await auth.login(email.trim(), password)
      if (!r.token) {
        // A specific, actionable message. The generic alternative ("sign-in
        // failed") sends someone hunting for a wrong password when the real cause
        // is one unset environment variable on the server.
        setErr('This server has web sign-in disabled — WEB_TOKEN_SECRET (or ' +
               'ADMIN_SECRET) is not set on the backend. Ask an administrator to ' +
               'set one; the mobile app is unaffected.')
        setBusy(false)
        return
      }
      signIn(r.token, r.user)
    } catch (e2) {
      const ae = e2 instanceof ApiError ? e2 : null
      setErr(
        ae?.status === 401 ? 'That email and password do not match an account.'
        : ae?.isOffline ? ae.message
        : ae?.message ?? String(e2))
      setBusy(false)
    }
  }, [busy, email, password, baseUrl])

  return (
    <div className="grid min-h-full place-items-center px-4 py-10"
         style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="rise mb-8 text-center">
          <div className="mb-4 flex justify-center"><Logo size={52} /></div>
          <h1 className="text-2xl font-semibold tracking-tight">Oscar</h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
            Your tasks, your calendar, your assistant.
          </p>
        </div>

        <Card className="rise p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email">
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
                      style={{ color: 'var(--text-subtle)' }} />
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  autoComplete="username" autoFocus required spellCheck={false}
                  placeholder="you@company.com"
                  className={cx(inputCls, 'pl-9')} style={inputStyle}
                />
              </div>
            </Field>

            <Field label="Password">
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2"
                          style={{ color: 'var(--text-subtle)' }} />
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password" required
                  placeholder="••••••••"
                  className={cx(inputCls, 'pl-9')} style={inputStyle}
                />
              </div>
            </Field>

            {/* Informational, not an error — nothing went wrong, the session simply
                belonged to another backend. Suppressed once a real error exists, so
                the two never stack. */}
            {notice && !err && (
              <div className="rounded-xl px-3.5 py-3 text-[13px] leading-relaxed"
                   style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                {notice}
              </div>
            )}

            {err && (
              <div className="rounded-xl px-3.5 py-3 text-[13px] leading-relaxed"
                   style={{ background: 'rgba(239,68,68,.08)', color: '#DC2626' }}>
                {err}
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy}
                    disabled={!email.trim() || !password} className="w-full">
              Sign in <ArrowRight className="size-4" />
            </Button>
          </form>

          {/* 🔴 DEV ONLY. A URL field on a login page is what a phishing page looks
              like, and on a deployed app it invites someone to point their session
              at an arbitrary host. It is needed constantly in development and never
              by a real user, so it is compiled out of a production build entirely
              rather than merely hidden. */}
          {import.meta.env.DEV && (
          <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
            <button type="button" onClick={() => setShowAdvanced(v => !v)}
                    className="text-[11px] font-medium"
                    style={{ color: 'var(--text-subtle)' }}>
              {showAdvanced ? 'Hide' : 'Change'} server
            </button>
            {showAdvanced && (
              <div className="fade mt-2.5">
                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                       spellCheck={false} placeholder="https://…"
                       className={cx(inputCls, 'text-xs')} style={inputStyle} />
                <p className="mt-1.5 text-[11px] leading-relaxed"
                   style={{ color: 'var(--text-subtle)' }}>
                  This page's origin must be listed in the server's
                  {' '}<code>CORS_ORIGINS</code>, or every request fails before it is sent.
                </p>
              </div>
            )}
          </div>
          )}
        </Card>

        <p className="mt-6 text-center text-[11px] leading-relaxed"
           style={{ color: 'var(--text-subtle)' }}>
          Accounts are created by your workspace administrator.
        </p>
      </div>
    </div>
  )
}
