import {
  AlertCircle, ArrowLeft, ArrowRight, Check, GitBranch, MessageSquare, User, Users,
} from 'lucide-react'
import type { Task } from '../../lib/types'
import {
  dayMonthLabel, isReallyOverdue, parseIstNaive, timeLabel,
} from '../../lib/format'
import { getUser } from '../../lib/session'
import { Badge, Card, STATUS_LABEL, cx } from '../../ui'

/**
 * One task, everywhere. Today, Tasks and Team all render this — three
 * near-identical cards is how a status colour ends up meaning two different things
 * on two screens.
 *
 * The checkbox is the primary action and it is on the card, not behind a detail
 * screen. Completing a task is the most common thing anyone does here, and making
 * it a two-navigation operation is the difference between a tool and a form.
 */
export function TaskCard({ task, onToggle, onOpen, busy, showAssignee,
                          unreadComments }: {
  task: Task
  onToggle: () => void
  onOpen: () => void
  busy?: boolean
  /** Accepted and ignored. The From:/To: lines are driven by OWNERSHIP now, matching
   *  the Flutter card, so nothing gates them: a delegated task must say who has it on
   *  every screen, not only on Team. Kept in the signature so the four call sites do
   *  not all need editing for a prop that no longer changes anything. */
  showAssignee?: boolean
  /** Unread comments on this task. Drives the badge and the glow — see
   *  useUnreadComments for why this is derived from notifications. */
  unreadComments?: number
}) {
  void showAssignee                 // see the prop's own note
  const unread = unreadComments ?? 0
  const me = getUser()
  const due = parseIstNaive(task.due_at)
  // The ADDED date for an anytime task. created_at is naive UTC from the app
  // process, and parseIstNaive is the wrong reader for it — but the column shows a
  // DAY, and a 5h30m offset only ever moves a day boundary for something created
  // within 5.5h of midnight. Accepted: a date, not a timestamp, is being displayed.
  const addedLabel = (() => {
    const c = task.created_at ? new Date(task.created_at + 'Z') : null
    return c && !Number.isNaN(c.getTime()) ? dayMonthLabel(c) : '—'
  })()
  const done = task.status === 'completed'
  // Flutter's `_isClosedState`. In a task LIST both closed states are struck
  // through — that is what ticking something off looks like. (The CALENDAR uses
  // the opposite rule for completed items; see CalendarScreen.)
  const terminal = done || task.status === 'cancelled'
  const shared = (task.assignee_count ?? task.assignees.length) > 1

  /**
   * WHO, exactly as the Flutter card decides it:
   *
   *   assigneeName: ownerName == me ? assignedToName : null     → "To: X"
   *   assignerName: ownerName != me ? ownerName      : null     → "From: X"
   *
   * Mutually exclusive by construction — you either handed it out or received it.
   *
   * Two deliberate deviations from the mobile code, both safer:
   * · compared on owner_user_id, not on the NAME. Mobile does `ownerName ==
   *   currentUserName`, and this workspace has real duplicate first names (three
   *   variants of Sri Ram in the directory alone), so a name comparison can call
   *   someone else's task yours.
   * · "To:" is suppressed when the assignee is you. Mobile prints "To: <you>" on a
   *   self-assigned task, which is a fact you supplied and a column of noise on the
   *   home screen where most rows are your own.
   */
  const iOwn = task.owner_user_id == null || task.owner_user_id === me?.id
  const toName = iOwn && task.assigned_to_user_id && task.assigned_to_user_id !== me?.id
    ? task.assigned_to_name : null
  const fromName = !iOwn ? task.owner_name : null
  // Nobody else is involved: I own it and it is assigned to me (or to nobody, which
  // create_item resolves to me anyway). Previously this rendered NOTHING — both
  // fromName and toName are null — so a self-assigned task had a blank space where
  // every other card names a person, and the row looked unfinished rather than
  // deliberately solo. "Personal" is the honest label and matches the mobile card.
  const isPersonal = !fromName && !toName

  return (
    <Card className={cx('group transition', terminal && 'opacity-60')}
          /* Unseen comments TINT THE EXISTING BORDER rather than adding a ring around
             it. A box-shadow ring sits outside the 1px border and reads as two edges
             of slightly different colour — which is exactly what looked unclean. One
             edge, one colour, and the card's geometry is untouched. */
          style={unread > 0 ? { borderColor: 'var(--accent)' } : undefined}>
      <div className="flex items-start gap-3 p-3.5">
        {/* A CIRCLE, like the mobile card — and its own button, not a click on the
            row: a row that both opens and completes means every mis-tap either loses
            your place or marks work done that is not. */}
        <button
          onClick={onToggle}
          disabled={busy || task.status === 'cancelled'}
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          className={cx('mt-px grid size-[22px] shrink-0 place-items-center rounded-full',
                        'transition disabled:opacity-40')}
          /* 1.5px and the SUBTLE border token, matching the Flutter circle
             (width: 22, border width: 1.5, AppColors.surfaceBorder). `border-2` with
             --border-strong looked fine on the old rounded SQUARE and reads as a
             heavy black ring once it is a circle — a full outline draws far more
             attention than three sides of a soft-cornered box. */
          style={done
            ? { background: '#22C55E', border: '1.5px solid #22C55E' }
            : { border: '1.5px solid var(--border)' }}
        >
          {done && <Check className="size-3 text-white" strokeWidth={3.5} />}
        </button>

        {/* ── WHEN: its own left column, with a divider ─────────────────
            The time was previously buried in a meta row under the title, beside a
            priority chip and a clock icon. Pulled out to the left because it is the
            single most scanned value on the card — the question is "what is next",
            and a column of aligned times answers that at a glance where inline text
            does not.

            An ANYTIME task has no time to put here (its due_at is a 23:59
            placeholder, not a chosen hour), so it shows when it was ADDED instead —
            the honest alternative, and it stops the column looking broken or
            implying a late-evening deadline. */}
        <div className="w-[68px] shrink-0 border-r pr-3 text-right"
             style={{ borderColor: 'var(--border)' }}>
          {task.is_all_day ? (
            <>
              <div className="text-[10px] font-medium uppercase tracking-wide"
                   style={{ color: 'var(--text-subtle)' }}>Added</div>
              <div className="text-[12.5px] font-semibold tabular-nums"
                   style={{ color: 'var(--text-muted)' }}>
                {addedLabel}
              </div>
            </>
          ) : (
            <div className="text-[13px] font-bold tabular-nums leading-tight"
                 style={isReallyOverdue(task) && !terminal
                   ? { color: '#DC2626' } : { color: 'var(--text)' }}>
              {due ? timeLabel(due) : '—'}
            </div>
          )}
        </div>

        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          {/* ── title row: risk, title, status ────────────────────────── */}
          <div className="flex items-start gap-2">
            {/* A child sub-task is overdue. Suppressed once closed, like the due
                styling — the risk is about work still outstanding. */}
            {!!task.risk_flag && !terminal && (
              <AlertCircle className="mt-0.5 size-4 shrink-0" style={{ color: '#D97706' }} />
            )}
            <div className={cx('min-w-0 flex-1 text-[14.5px] font-medium leading-snug',
                               terminal && 'line-through')}>
              {task.title}
            </div>
            <Badge tone={task.status}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
          </div>

          {/* ── meta row: sub-tasks, sharing, comments ─────────────────
              🔴 NO PRIORITY LABEL. A "critical" chip on every critical card is
              noise: critical REQUIRES a time (the API rejects one without a due_at)
              and criticals already sort to the top, so the chip repeats what the
              position and the time column have already said. The one thing worth
              flagging is being LATE, which the time turns red for.

              The inline time is gone too — it lives in the left column now. Two
              time labels on one card was the original problem. */}
          <div className="mt-1.5 flex items-center gap-2">
            {shared && (
              <Badge tone="neutral">
                <Users className="size-3" />
                {task.assignees_done ?? 0}/{task.assignee_count ?? task.assignees.length}
              </Badge>
            )}
            {/* Unread comments. Accent-coloured and pushed right, next to the
                sub-task count — both answer "is there more inside this row". */}
            {unread > 0 && (
              <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px
                               text-[11px] font-semibold"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                <MessageSquare className="size-3" /> {unread}
              </span>
            )}
            {!!task.subtask_count && (
              <span className={cx('flex shrink-0 items-center gap-1 text-xs',
                                  unread > 0 ? 'ml-2' : 'ml-auto')}
                    style={{ color: 'var(--text-subtle)' }}>
                <GitBranch className="size-3" /> {task.subtask_count}
              </span>
            )}
          </div>

          {/* ── From: / To: — their own lines, as on mobile ───────────── */}
          {/* From is ACCENT-coloured and bolder while To is muted, deliberately:
              work someone handed YOU is a claim on your time, work you handed out is
              a thing to track. The Flutter card draws exactly this distinction. */}
          {isPersonal && (
            <div className="mt-1 flex items-center gap-1 text-xs"
                 style={{ color: 'var(--text-subtle)' }}>
              <User className="size-3 shrink-0" />
              <span>Personal</span>
            </div>
          )}
          {fromName && (
            <div className="mt-1 flex items-center gap-1 text-xs font-medium"
                 style={{ color: 'var(--accent)' }}>
              <ArrowLeft className="size-3 shrink-0" />
              <span>From:</span>
              <span className="truncate font-semibold">{fromName}</span>
            </div>
          )}
          {toName && (
            <div className="mt-1 flex items-center gap-1 text-xs"
                 style={{ color: 'var(--text-subtle)' }}>
              <ArrowRight className="size-3 shrink-0" />
              <span className="font-medium">To:</span>
              <span className="truncate">{toName}</span>
            </div>
          )}
        </button>
      </div>
    </Card>
  )
}
