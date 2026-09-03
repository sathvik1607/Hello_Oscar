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
export function TaskCard({ task, onToggle, onOpen, busy, showAssignee, bothParties,
                          unreadComments }: {
  task: Task
  onToggle: () => void
  onOpen: () => void
  busy?: boolean
  /**
   * Accepted and ignored — every screen passes it and none of them means anything
   * by it any more. Kept in the signature so the seven call sites do not all need
   * editing for a prop that changes nothing. Use `bothParties` for the real switch.
   */
  showAssignee?: boolean
  /**
   * Show BOTH sides — "From: X" and "To: Y" — instead of framing the row around the
   * viewer.
   *
   * The default framing asks "do I own this?", which is the right question on Today
   * and on Tasks: those screens are your own plate, so naming yourself on every row
   * is a column of noise. My Team asks a different question entirely — who is on
   * what — and there the viewer is usually neither party. Under the default logic a
   * task Sathvik gave Sriram rendered as "From: Sathvik" with no sign of who has it,
   * and a task the LEAD handed out rendered "To: Sriram" with no sign of who sent
   * it. Half the answer either way, on the one screen whose entire purpose is that
   * answer.
   *
   * 🔴 MY TEAM ONLY. On Today, Tasks, Oscar and Voice the viewer-centric framing is
   * the correct one — those screens are your own plate, and printing "From: <you>"
   * on a task you set yourself is the exact noise the ownership logic removes.
   */
  bothParties?: boolean
  /** Unread comments on this task. Drives the badge and the glow — see
   *  useUnreadComments for why this is derived from notifications. */
  unreadComments?: number
}) {
  const unread = unreadComments ?? 0
  const me = getUser()
  const due = parseIstNaive(task.due_at)
  // When the task was ADDED. created_at is naive UTC from the app process, so it
  // is read as UTC rather than through parseIstNaive (which assumes IST). Only a
  // DAY is displayed, and a 5h30m offset can only move a day boundary for
  // something created within 5.5h of midnight — accepted, since this is a date and
  // not a timestamp.
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
  /**
   * `showAssignee` switches from the viewer's point of view to the TASK's.
   *
   * Both names are shown, and each is suppressed only when it is the same person as
   * the other side — a task someone kept for themselves says "From: X" once rather
   * than "From: X / To: X", which is the same fact printed twice.
   */
  void showAssignee                 // see the prop's own note
  const bothSides = !!bothParties
  const toName = bothSides
    ? (task.assigned_to_user_id && task.assigned_to_user_id !== task.owner_user_id
        ? task.assigned_to_name : null)
    : (iOwn && task.assigned_to_user_id && task.assigned_to_user_id !== me?.id
        ? task.assigned_to_name : null)
  const fromName = bothSides ? task.owner_name : (!iOwn ? task.owner_name : null)
  // Nobody else is involved: I own it and it is assigned to me (or to nobody, which
  // create_item resolves to me anyway). Previously this rendered NOTHING — both
  // fromName and toName are null — so a self-assigned task had a blank space where
  // every other card names a person, and the row looked unfinished rather than
  // deliberately solo. "Personal" is the honest label and matches the mobile card.
  /**
   * Nobody else is involved. On My Team that means a member's own task — they own it
   * and kept it — where `toName` is suppressed as a duplicate of `fromName`, so the
   * test has to be "no second party", not "no names at all".
   */
  const isPersonal = bothSides ? !toName && !fromName : (!fromName && !toName)

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
              {/* The ADDED date, matching the Flutter app.
                  Two clients showing different dates for the same row is worse than
                  either choice being imperfect — someone comparing phone and browser
                  would reasonably conclude one of them is broken. Flutter has only a
                  created-date concept for these, so the web app follows rather than
                  diverging, and Flutter is the place to change if this should become
                  the due date on both.
                  ⚠️ Note it is NOT the day the task is for: measured on real data,
                  all 22 anytime tasks have a created date different from their due
                  date, and the SORT still uses due_at. So this column deliberately
                  does not explain the row's position.
                  Never the time: the stored 23:59 is a placeholder, not a chosen
                  hour, and printing it would read as a late-evening deadline. */}
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

          {/* ── From: / To: ─────────────────────────────────────────── */}
          {/* ONE LINE when both are present. "X gave this to Y" is a single fact,
              and stacking it made the card read as two separate statements — and
              two rows tall, on a list where the whole point is scanning many.
              Each still gets its own line when it is alone, which is the common
              case everywhere except My Team.

              From is ACCENT-coloured and bolder while To is muted, deliberately:
              work someone handed YOU is a claim on your time, work you handed out
              is a thing to track. The Flutter card draws exactly this distinction.

              🔴 That emphasis is only honest when the row is ABOUT you. Under
              `bothParties` (My Team) you are usually neither party, so an accented
              "From" would shout at a bystander about somebody else's inbox —
              muted there, and the pair reads as the one fact it is. */}
          {isPersonal && (
            <div className="mt-1 flex items-center gap-1 text-xs"
                 style={{ color: 'var(--text-subtle)' }}>
              <User className="size-3 shrink-0" />
              <span>Personal</span>
            </div>
          )}
          {(fromName || toName) && (
            /* min-w-0 on the row AND on each half: without it a flex child refuses
               to shrink below its content, so `truncate` never engages and one long
               name pushes the other off the card instead of both ellipsing. */
            <div className="mt-1 flex min-w-0 items-center gap-x-2 gap-y-1 text-xs
                            flex-wrap">
              {fromName && (
                <span className={cx('flex min-w-0 items-center gap-1',
                                    !bothSides && 'font-medium')}
                      style={{ color: bothSides ? 'var(--text-subtle)' : 'var(--accent)' }}>
                  <ArrowLeft className="size-3 shrink-0" />
                  <span className={cx('shrink-0', bothSides && 'font-medium')}>From:</span>
                  <span className={cx('truncate',
                                      bothSides ? 'font-medium' : 'font-semibold')}>
                    {fromName}
                  </span>
                </span>
              )}
              {toName && (
                <span className="flex min-w-0 items-center gap-1"
                      style={{ color: 'var(--text-subtle)' }}>
                  <ArrowRight className="size-3 shrink-0" />
                  <span className="shrink-0 font-medium">To:</span>
                  <span className="truncate">{toName}</span>
                </span>
              )}
            </div>
          )}
        </button>
      </div>
    </Card>
  )
}
