import { useEffect, useState } from 'react'
import { Menu, MoreHorizontal, X } from 'lucide-react'
import { NAV, TITLES, type SectionId } from './nav'
import { ConnectionBanner } from './ConnectionBanner'
import { OscarButton } from '../features/voice/OscarButton'
import { AmbientIndicator } from '../features/voice/AmbientIndicator'
import { getUser, signOut } from '../lib/session'
import { cx } from '../ui'

/**
 * The application shell: navigation, header, and the always-available Oscar entry
 * point.
 *
 * Layout is a single flex row on desktop and a stacked column on mobile — not the
 * same layout scaled down. The differences are real: on desktop navigation is a
 * persistent rail (you can see where else you could be), on mobile it is a bottom
 * bar with the four most-used sections and a "More" sheet (a rail would eat a third
 * of a phone screen). Oscar sits in the header on desktop and floats above the
 * bottom bar on mobile, which is where a thumb already is.
 */
export function AppShell({ section, onNavigate, children }: {
  section: SectionId
  onNavigate: (s: SectionId) => void
  children: React.ReactNode
}) {
  const user = getUser()
  const [railOpen, setRailOpen] = useState(false)     // tablet drawer
  const [moreOpen, setMoreOpen] = useState(false)     // mobile sheet
  const hasTeam = !!user?.team_id

  const items = NAV.filter(n => !n.needsTeam || hasTeam)
  const primary = items.filter(n => n.primary)
  const secondary = items.filter(n => !n.primary)
  const meta = TITLES[section]

  // Navigating must always close whatever was open, or the sheet stays over the
  // screen it just navigated to.
  const go = (s: SectionId) => { onNavigate(s); setRailOpen(false); setMoreOpen(false) }

  // The tab title tracks the section, so a pinned tab and the browser's history
  // are both readable. Small thing; it is also the only label a pinned tab has.
  useEffect(() => { document.title = `${meta.title} · Oscar` }, [meta.title])

  // Escape closes the overlays. Expected by anyone who uses a keyboard, and the
  // only way out of the mobile sheet for a screen-reader user.
  useEffect(() => {
    if (!railOpen && !moreOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setRailOpen(false); setMoreOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railOpen, moreOpen])

  return (
    <div className="flex min-h-full" style={{ background: 'var(--bg)' }}>
      {/* ── desktop rail ─────────────────────────────────────────────── */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col border-r px-3 py-4',
          'transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          railOpen ? 'translate-x-0' : '-translate-x-full')}
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      >
        <div className="mb-6 flex items-center justify-between gap-2 px-2">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight">Oscar</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {user?.team_name ?? 'Personal'}
              </div>
            </div>
          </div>
          <button onClick={() => setRailOpen(false)} aria-label="Close navigation"
                  className="lg:hidden" style={{ color: 'var(--text-muted)' }}>
            <X className="size-4" />
          </button>
        </div>

        <nav className="space-y-0.5" aria-label="Main">
          {items.map(n => (
            <NavRow key={n.id} item={n} active={section === n.id} onClick={() => go(n.id)} />
          ))}
        </nav>

        <div className="mt-auto space-y-3 px-2 pt-4">
          <div className="flex items-center gap-2.5">
            <Avatar name={user?.name ?? '?'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{user?.name}</div>
              <div className="truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {user?.email ?? user?.username}
              </div>
            </div>
          </div>
          <button onClick={signOut}
                  className="text-[11px] font-medium transition hover:underline"
                  style={{ color: 'var(--text-subtle)' }}>
            Sign out
          </button>
        </div>
      </aside>

      {/* Scrim. Only on tablet, where the rail is a drawer. */}
      {railOpen && (
        <button aria-label="Close navigation" onClick={() => setRailOpen(false)}
                className="fixed inset-0 z-30 bg-black/25 lg:hidden" />
      )}

      {/* ── main column ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-20 flex items-center gap-3 border-b px-4 py-3
                     backdrop-blur-xl sm:px-7"
          style={{
            // Translucent so content scrolling under the header reads as depth
            // rather than as a hard cut.
            background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
            borderColor: 'var(--border)',
          }}
        >
          <button onClick={() => setRailOpen(true)} aria-label="Open navigation"
                  className="lg:hidden" style={{ color: 'var(--text-muted)' }}>
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[17px] font-semibold tracking-tight sm:text-xl">
              {meta.title}
            </h1>
            <p className="hidden truncate text-xs sm:block" style={{ color: 'var(--text-muted)' }}>
              {meta.subtitle}
            </p>
          </div>
          {/* Oscar is reachable from every screen, by design — an assistant behind
              a tab is an assistant nobody talks to. Hidden on the smallest widths,
              where the floating button below serves the same purpose without
              crowding the title. */}
          <div className="hidden sm:block"><OscarButton /></div>
        </header>

        <ConnectionBanner />

        <main className="min-w-0 flex-1 px-4 pb-28 pt-5 sm:px-7 lg:pb-10">
          {/* Keyed on section so each screen mounts fresh — a stale scroll
              position or a half-finished form leaking across a navigation reads
              as a bug, and the state worth keeping lives in the session or the
              server anyway. */}
          <div key={section} className="rise mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>

      {/* ── mobile bottom bar ────────────────────────────────────────── */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t lg:hidden"
        style={{
          background: 'color-mix(in srgb, var(--bg-elevated) 94%, transparent)',
          borderColor: 'var(--border)',
          backdropFilter: 'blur(16px)',
          // Respect the iPhone home indicator, or the last row of tabs sits under it.
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        aria-label="Sections"
      >
        {primary.map(n => (
          <TabButton key={n.id} label={n.label} icon={<n.icon className="size-[18px]" />}
                     active={section === n.id} onClick={() => go(n.id)} />
        ))}
        <TabButton label="More" icon={<MoreHorizontal className="size-[18px]" />}
                   active={secondary.some(s => s.id === section)}
                   onClick={() => setMoreOpen(v => !v)} />
      </nav>

      <AmbientIndicator />

      {/* Floating Oscar, above the bottom bar — the mobile equivalent of the
          header button, placed where a thumb rests. */}
      <div className="fixed bottom-[74px] right-4 z-30 sm:hidden"
           style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
        <OscarButton floating />
      </div>

      {moreOpen && (
        <>
          <button aria-label="Close menu" onClick={() => setMoreOpen(false)}
                  className="fixed inset-0 z-40 bg-black/30 lg:hidden" />
          <div className="fade fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t p-3 lg:hidden"
               style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                        paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
               role="dialog" aria-label="More sections">
            <div className="mx-auto mb-3 h-1 w-9 rounded-full"
                 style={{ background: 'var(--border-strong)' }} />
            {secondary.map(n => (
              <NavRow key={n.id} item={n} active={section === n.id} onClick={() => go(n.id)} />
            ))}
            <button onClick={signOut}
                    className="mt-1 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium"
                    style={{ color: '#DC2626' }}>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function NavRow({ item, active, onClick }: {
  item: typeof NAV[number]; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5',
                    'text-sm font-medium transition')}
      style={active
        ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
        : { color: 'var(--text-muted)' }}
    >
      <item.icon className="size-[17px] shrink-0" />
      {item.label}
    </button>
  )
}

function TabButton({ label, icon, active, onClick }: {
  label: string; icon: React.ReactNode; active: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} aria-current={active ? 'page' : undefined}
            className="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition"
            style={{ color: active ? 'var(--accent)' : 'var(--text-subtle)' }}>
      {icon}{label}
    </button>
  )
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <div className="grid shrink-0 place-items-center rounded-[10px] font-bold text-white"
         style={{
           width: size, height: size, fontSize: size * 0.42,
           background: 'linear-gradient(135deg,#8B7CFF,#6D5EF6)',
         }}>O</div>
  )
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
  return (
    <div className="grid shrink-0 place-items-center rounded-full font-semibold"
         style={{
           width: size, height: size, fontSize: size * 0.38,
           background: 'var(--accent-soft)', color: 'var(--accent)',
         }}
         aria-hidden>
      {initials || '?'}
    </div>
  )
}
