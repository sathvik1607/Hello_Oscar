/**
 * The design system. Small, deliberate, and the only place a radius, a shadow or a
 * padding scale is decided.
 *
 * Every component references the semantic CSS variables from index.css (`--bg`,
 * `--border`, `--text-muted`) rather than a raw colour. That is what makes dark
 * mode one block of CSS instead of a `dark:` prefix on a thousand elements — and
 * what stops the theme drifting out of sync one component at a time.
 */

import type { ReactNode } from 'react'
import { AlertTriangle, Check, Loader2, WifiOff } from 'lucide-react'

export const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(' ')

// ── surfaces ────────────────────────────────────────────────────────────────

export function Card({ children, className, as: As = 'div', ...rest }: {
  children?: ReactNode; className?: string; as?: 'div' | 'section' | 'article'
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <As
      className={cx('rounded-[var(--radius-card)] border', className)}
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      {...rest}
    >{children}</As>
  )
}

export function SectionHeading({ children, count, action }: {
  children: ReactNode; count?: number; action?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 px-1">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[.1em]"
          style={{ color: 'var(--text-muted)' }}>
        {children}
        {count !== undefined && count > 0 && (
          <span className="rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums"
                style={{ background: 'var(--bg-sunken)', color: 'var(--text-subtle)' }}>
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  )
}

// ── buttons ─────────────────────────────────────────────────────────────────

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

export function Button({
  variant = 'secondary', size = 'md', loading, children, className, disabled, ...rest
}: BtnProps) {
  const sizes = {
    sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
    md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  }
  const variants = {
    primary: 'text-white shadow-sm',
    secondary: '',
    ghost: 'border-transparent',
    danger: 'text-white',
  }
  const style: React.CSSProperties =
    variant === 'primary' ? { background: 'var(--accent)', borderColor: 'transparent' }
    : variant === 'danger' ? { background: '#EF4444', borderColor: 'transparent' }
    : variant === 'ghost' ? { background: 'transparent', color: 'var(--text-muted)' }
    : { background: 'var(--bg-elevated)', borderColor: 'var(--border)', color: 'var(--text)' }

  return (
    <button
      className={cx(
        'inline-flex shrink-0 items-center justify-center border font-medium',
        'transition-[filter,background-color,opacity] hover:brightness-[.97] active:brightness-95',
        'disabled:pointer-events-none disabled:opacity-45',
        sizes[size], variants[variant], className)}
      style={style}
      // A button that is busy must also be unclickable, or a double-tap sends the
      // request twice — and one of those requests creates a duplicate task.
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  )
}

export function IconButton({ label, children, className, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }
) {
  return (
    <button
      aria-label={label} title={label}
      className={cx('grid size-9 shrink-0 place-items-center rounded-lg transition',
        'hover:brightness-95', className)}
      style={{ color: 'var(--text-muted)' }}
      {...rest}
    >{children}</button>
  )
}

// ── inputs ──────────────────────────────────────────────────────────────────

export const inputCls =
  'w-full rounded-xl border px-3.5 py-2.5 text-sm outline-none transition ' +
  'placeholder:opacity-55 focus:ring-2'

export const inputStyle: React.CSSProperties = {
  background: 'var(--bg-elevated)',
  borderColor: 'var(--border)',
  color: 'var(--text)',
  // @ts-expect-error — a custom property is valid CSS and Tailwind's ring colour
  // reads it; React's CSSProperties type simply has no entry for one.
  '--tw-ring-color': 'color-mix(in srgb, var(--accent) 28%, transparent)',
}

export function Field({ label, hint, children }: {
  label: string; hint?: string; children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs" style={{ color: 'var(--text-subtle)' }}>{hint}</span>}
    </label>
  )
}

// ── badges ──────────────────────────────────────────────────────────────────

/** Status and priority colours are lifted from the Flutter app's AppColors, so a
 *  high-priority task is the same red on both surfaces. */
const TONES: Record<string, { bg: string; fg: string }> = {
  pending:     { bg: 'rgba(59,130,246,.12)',  fg: '#3B82F6' },
  in_progress: { bg: 'rgba(245,158,11,.14)',  fg: '#B45309' },
  completed:   { bg: 'rgba(34,197,94,.13)',   fg: '#15803D' },
  cancelled:   { bg: 'rgba(148,163,184,.16)', fg: '#64748B' },
  blocked:     { bg: 'rgba(239,68,68,.12)',   fg: '#DC2626' },
  high:        { bg: 'rgba(239,68,68,.12)',   fg: '#DC2626' },
  medium:      { bg: 'rgba(245,158,11,.14)',  fg: '#B45309' },
  low:         { bg: 'rgba(148,163,184,.16)', fg: '#64748B' },
  overdue:     { bg: 'rgba(239,68,68,.13)',   fg: '#DC2626' },
  brand:       { bg: 'var(--accent-soft)',    fg: 'var(--accent)' },
  neutral:     { bg: 'var(--bg-sunken)',      fg: 'var(--text-muted)' },
}

export function Badge({ children, tone = 'neutral', className }: {
  children: ReactNode; tone?: keyof typeof TONES | string; className?: string
}) {
  const t = TONES[tone] ?? TONES.neutral
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full',
                        'px-2 py-0.5 text-[11px] font-semibold', className)}
          style={{ background: t.bg, color: t.fg }}>
      {children}
    </span>
  )
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'To do', in_progress: 'In progress', completed: 'Done',
  cancelled: 'Cancelled', blocked: 'Blocked',
}

// ── states: loading / empty / error / offline ───────────────────────────────
// Every screen must have all four. A blank screen is indistinguishable from a
// broken one, and that ambiguity is what makes an app feel unreliable.

/** Skeleton rows, not a spinner. A spinner says "wait"; a skeleton says "here is
 *  the shape of what is coming", which measurably reduces perceived latency. */
export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('space-y-2.5', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton h-[62px] rounded-[var(--radius-card)]"
             style={{ opacity: 1 - i * 0.12 }} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-14 text-sm"
         style={{ color: 'var(--text-muted)' }} role="status">
      <Loader2 className="size-4 animate-spin" /> {label ?? 'Loading…'}
    </div>
  )
}

export function EmptyState({ icon, title, body, action }: {
  icon?: ReactNode; title: string; body?: string; action?: ReactNode
}) {
  return (
    <div className="fade flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 grid size-12 place-items-center rounded-2xl"
             style={{ background: 'var(--bg-sunken)', color: 'var(--text-subtle)' }}>
          {icon}
        </div>
      )}
      <div className="text-[15px] font-semibold">{title}</div>
      {body && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {body}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  // An unreachable host and a real server error need different words: one is "try
  // again", the other is "check the connection". Telling them apart is the whole
  // reason ApiError carries status 0.
  const offline = /can't reach|failed to fetch|networkerror/i.test(error)
  return (
    <Card className="p-5" >
      <div className="flex gap-3">
        {offline
          ? <WifiOff className="mt-0.5 size-4 shrink-0" style={{ color: '#B45309' }} />
          : <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: '#DC2626' }} />}
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {offline ? "Can't reach Oscar" : 'Something went wrong'}
          </div>
          <p className="mt-1 break-words text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {error}
          </p>
          {onRetry && (
            <Button size="sm" className="mt-3.5" onClick={onRetry}>Try again</Button>
          )}
        </div>
      </div>
    </Card>
  )
}

/** A one-line inline confirmation. Used after a write so the user sees the write
 *  landed — "Oscar understood" is the whole point of the Personalize screen. */
export function Confirmation({ children }: { children: ReactNode }) {
  return (
    <div className="fade flex items-center gap-2 text-[13px] font-medium"
         style={{ color: '#15803D' }}>
      <Check className="size-3.5" /> {children}
    </div>
  )
}
