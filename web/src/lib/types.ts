/**
 * Wire shapes, transcribed from the backend rather than guessed.
 *
 * Every type here corresponds to something a route in main.py actually returns.
 * Where the backend has two fields that mean nearly the same thing, the comment
 * says which one to read — the app has been wrong about exactly that before.
 */

export type AccountType = 'personal' | 'team_member' | 'team_lead'

export type SessionUser = {
  id: number
  name: string
  username: string | null
  email: string | null
  role: string | null
  team_id: number | null
  team_name: string | null
  account_type: AccountType
  onboarding_state: 'complete' | 'needs_team_join'
}

export type LoginResponse = {
  success: true
  /** Null when the backend has no WEB_TOKEN_SECRET / ADMIN_SECRET set. The app
   *  treats that as a configuration failure and refuses to proceed, rather than
   *  running unauthenticated and looking like it works. */
  token: string | null
  user: SessionUser
}

/** TWO tiers. `services/priority.py` normalises everything the backend stores to
 *  'normal' | 'critical' — high→critical, medium/low→normal — so those are the only
 *  values a current backend ever SENDS. The legacy three stay in the union because
 *  rows are not rewritten: nothing re-serialises an old row, and the aliases are
 *  still accepted on write. Read defensively, write the honest names.
 *
 *  Priority is scheduler BEHAVIOUR, not a label: `critical` gets exactly one
 *  reminder at T-15 and requires a due_at; `normal` gets none, ever. */
export type Priority = 'normal' | 'critical' | 'low' | 'medium' | 'high'
export type ItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked'

export type Assignee = {
  user_id: number
  name: string | null
  status: string
  completed_at: string | null
}

export type Task = {
  id: number
  title: string
  description: string | null
  priority: Priority
  status: ItemStatus
  is_overdue: boolean
  /** IST-naive ISO, or null for an undated task. NEVER convert this to UTC — the
   *  backend stores the IST wall-clock with no tzinfo, so `new Date(due_at)` would
   *  be reinterpreted in the browser's zone. See parseIstNaive() in format.ts. */
  due_at: string | null
  /** 🔴 NOT `due_at === null`. An all-day task still carries a due_at — it names the
   *  DAY, and the time component is a placeholder (23:59 from plan-day). A dateless
   *  task falls out of every date-grouped view, which is why null is not the
   *  representation. False on every pre-migration row, so the 23:59 sentinel is
   *  still worth honouring for old rows. */
  is_all_day: boolean
  due_label: string | null
  completed_at: string | null
  created_at: string | null
  updated_at: string | null
  assigned_to_user_id: number | null
  assigned_to_name: string | null
  /** 🔴 READ THIS, not `assigned_to_user_id === me`. The legacy field names only the
   *  PRIMARY assignee, so on a shared task it answers wrong for everyone else — a
   *  307-person cohort task vanished from 306 home screens because of exactly that
   *  comparison. `is_mine` is true when the viewer is ANY assignee. */
  is_mine: boolean
  assignees: Assignee[]
  assignee_count?: number
  assignees_truncated?: boolean
  assignees_done?: number
  owner_user_id?: number | null
  owner_name?: string | null
  parent_task_id?: number | null
  subtask_count?: number
  is_project?: boolean | number
  risk_flag?: number
  item_type?: 'task' | 'meeting'
  /** "14 of 307 done" — the rollup the roster is capped to avoid shipping. */
  completed_count?: number
  pending_count?: number
  root_task_id?: number | null
  escalation_level?: number
  /** Carried forward from a previous day by the scheduler.
   *
   *  🔴 The bool alone CANNOT answer the question worth asking. `spilled_over_at` is
   *  never cleared on a manual reschedule, so it means "was carried at some point",
   *  not "still needs attention". Compare it against `updated_at`: still roughly
   *  equal ⇒ untouched since the roll ⇒ worth prompting; `updated_at` clearly later
   *  ⇒ the user has already set their own time ⇒ historical, stay quiet.
   *
   *  ⚠️ Spill-over is DISABLED on the backend as of 2026-08-29, so nothing new is
   *  stamped. A flag in the wild is historical only. */
  spilled_over?: boolean
  spilled_over_at?: string | null
}

export type Meeting = {
  id: number
  title: string
  description: string | null
  status: ItemStatus
  /** IST-naive, same rule as due_at. */
  scheduled_at: string | null
  ends_at: string | null
  location: string | null
  attendees?: string[] | null
  assigned_to_user_id?: number | null
  assigned_to_name?: string | null
  attendee_user_ids?: number[] | null
  owner_user_id?: number | null
  owner_name?: string | null
  /** 🔴 "Is this mine, or was I invited?" — computed server-side per CALLER. The
   *  task list answers this with `is_mine`; for meetings this is the field. Do not
   *  re-derive it from `assigned_to_user_id`, which names only the primary invitee
   *  and so answers wrong for everyone else on a multi-invitee meeting. */
  viewer_role?: 'owner' | 'invitee' | null
  /** Pre-formatted for display, IST, computed once server-side. */
  date?: string | null
  date_label?: string | null
  time?: string | null
  end_time?: string | null
  duration_min?: number | null
  is_today?: boolean
  is_tomorrow?: boolean
}

export type TaskComment = {
  id: number
  user_id: number
  user_name: string | null
  /** 'assistant' rows are SYSTEM-generated activity notes ("✅ Marked as completed
   *  by …") written by item_service.complete_item — not Oscar replies. The comment
   *  agent is deliberately disabled; this is display styling only. */
  role: 'user' | 'assistant'
  body: string
  created_at: string | null
  attachments?: CommentAttachment[]
}

export type CommentAttachment = {
  id: number
  /** NULL until the comment is posted — the two-phase link. A row with a null
   *  comment_id is a normal state (uploaded while still typing), not corruption. */
  comment_id: number | null
  file_name: string | null
  mime_type: string
  /** 'image' | 'document' — decides whether a preview is even possible. */
  kind: string
  is_image: boolean
  byte_size: number
  /** PDFs only — the "4 pages" line. */
  page_count?: number | null
  /** Relative — resolve through the API base. */
  url: string
  thumbnail_url: string | null
  /** Non-null only while the bucket is public. Client rule: use the direct field
   *  when present, else the relative one. Correct across a public/presigned flip
   *  with no client change. */
  direct_url: string | null
  thumbnail_direct_url: string | null
}

export type Note = {
  id: number
  user_id: number
  title: string | null
  /** The wire field is `content`, not `body`. `pa_personal_notes.body` exists in the
   *  database, is 100% NULL, and is a leftover from a pre-ship redesign. */
  content: string
  /** 🔴 These two are in DIFFERENT ZONES and that is intentional, not a bug:
   *  `created_at` carries +00:00, `updated_at` carries +05:30 (it is written by
   *  notes_service._now(), which is IST). Both arrive with an explicit offset, so
   *  `new Date(...)` is correct for each — do NOT "normalise" them to one zone or
   *  push either through a naive-UTC parser, which is wrong by 5:30 either way. */
  created_at: string | null
  updated_at: string | null
}

export type PlannedTask = {
  title: string
  /** 🔴 NEVER null any more. A suggestion with no time from the model becomes 23:59
   *  on the plan date, flagged `is_all_day`. It used to be null, which dropped the
   *  suggestion out of every date-grouped view in the app — it is still a task for
   *  that DAY. So a `due_at ? … : 'No time set'` branch is now dead code; read
   *  `is_all_day` instead. */
  due_at: string
  /** True ⇒ the 23:59 above is a placeholder, not a deadline the user chose. */
  is_all_day: boolean
  /** 🔴 ALWAYS false, and it MUST be forwarded to POST /items. A suggestion is
   *  derived from the user's PRIVATE notes, so it is personal by definition — and
   *  POST /items defaults is_project to TRUE, so a caller that drops this key puts
   *  someone's private note on the team lead's My Team board. */
  is_project: boolean
  /** Derived from is_all_day server-side, never asked of the model: all-day →
   *  'normal', timed → 'critical'. */
  priority: Priority
  description: string | null
  reasoning: string | null
  /** Which note this came from — traceability, and what the backend uses to enforce
   *  weekday-only notes. */
  source_note_id: number | null
}

export type PlanDayResponse = {
  tasks: PlannedTask[]
  notes_considered: number
  message: string | null
}

export type NotificationType =
  | 'update_request' | 'update_response' | 'task_completed' | 'task_assigned'
  | 'task_reminder' | 'task_updated' | 'task_deleted' | 'direct_message'
  | 'meeting_update' | 'task_comment' | 'meeting_comment' | 'kiosk_lead'

export type AppNotification = {
  id: number
  user_id: number
  type: NotificationType
  message: string
  is_read: number
  /** A plain int, NOT a foreign key — rows pointing at deleted items exist, so a
   *  deep-link from the bell can legitimately resolve to nothing. */
  item_id: number | null
  /** Set on update_request / update_response rows, where `item_id` is null — so a
   *  bell tap on those can only resolve through THIS field. */
  update_request_id: number | null
  created_at: string | null
  read_at: string | null
}

export type ChatSession = {
  id: number
  title: string | null
  message_count: number
  preview: string | null
  last_message_at: string | null
  created_at: string | null
}

export type ChatMessage = {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string | null
  reply_to_ref?: string | null
  image_url?: string | null
  image_thumbnail_url?: string | null
  image_direct_url?: string | null
  image_thumbnail_direct_url?: string | null
}

export type TeamMember = {
  user_id: number
  name: string
  role: string
  is_active: number
  joined_at: string | null
  /** Derived live from the server's WebSocket registry, not stored. */
  online: boolean
  /** Stamped when their LAST socket disconnected. Not a login time — nothing
   *  records logins — and null while they are online. */
  last_seen: string | null
}

export type BusinessProfile = {
  business: string | null
  note: string | null
  details: string | null
  capabilities: string[]
  getting_started: string[]
}

// ── messaging ───────────────────────────────────────────────────────────────

export type ChatText = {
  id: number
  text: string
  sender_id?: number
  recipient_id?: number
  /** Team messages use `user_id` for the author; DMs use `sender_id`. Both carry
   *  `sender_name`, which is the field to render. */
  user_id?: number
  sender_name?: string | null
  user_name?: string | null
  reply_to_id: number | null
  reply_to?: { id: number; author: string | null; text: string } | null
  created_at: string | null
}

export type Conversations = {
  /** Null for a personal account — there is no team group to show. */
  team: { team_id: number; last_message_at: string | null; unread: number } | null
  dms: {
    peer_id: number
    /** The peer's real name, joined server-side. Before this existed the client had
     *  to resolve names from /teams/{id}/members, which returns ACTIVE members only
     *  — so a conversation with someone who had left the team rendered as
     *  "User 87" and no client could do better. */
    peer_name: string | null
    /** False for a former teammate. Distinguishes "no longer here" from "offline",
     *  which look identical otherwise. */
    peer_active: boolean
    last_message_at: string | null
    unread: number
  }[]
}
