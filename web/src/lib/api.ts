/**
 * The one door to the backend.
 *
 * Nothing else in this app calls fetch. That is what makes three things true in a
 * single place instead of ninety-nine: the bearer token is always attached, a 401
 * always returns the app to the login screen, and an unreachable host is
 * distinguished from a rejected credential.
 *
 * 🔴 `user_id` is NEVER accepted as a caller argument. It is read from the signed-in
 * session. The backend's historic IDOR came from clients being trusted to say who
 * they were; a function signature that cannot express "somebody else" removes the
 * possibility of an accidental one here, and every request also carries a token the
 * server checks against the id it names.
 */

import { getBase, getToken, requireUserId, signOut } from './session'
import type {
  AppNotification, BusinessProfile, ChatMessage, ChatSession, CommentAttachment,
  LoginResponse, Meeting, Note, PlanDayResponse, Task, TaskComment, TeamMember,
} from './types'

export class ApiError extends Error {
  status: number
  /** The backend's ERR-YYYYMMDD-NNNNNN ref when it produced one, so a support
   *  conversation can start with a log line instead of "it broke". */
  ref?: string
  constructor(status: number, message: string, ref?: string) {
    super(message)
    this.status = status
    this.ref = ref
  }
  /** True when this is "the network/host is unreachable" rather than a real reply.
   *  Drives the offline banner — a wrong error state here sends someone hunting a
   *  bad password when the real cause is a CORS origin. */
  get isOffline() { return this.status === 0 }
}

type Opts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
  /** Treat 404 as an empty answer rather than an error. Used only where the
   *  backend genuinely answers 404 to mean "nothing", never to hide a bug. */
  nullOn404?: boolean
}

async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  const { method = 'GET', body, signal, nullOn404 } = opts
  const token = getToken()
  let res: Response
  try {
    res = await fetch(getBase() + path, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    // A thrown fetch has NO status. Collapsing this into a generic failure is the
    // mistake that costs hours: an unreachable host and an origin missing from
    // CORS_ORIGINS both land here, and neither is an authentication problem.
    throw new ApiError(0,
      `Can't reach ${getBase()}. The server may be down, or this page's origin ` +
      `(${location.origin}) may not be in the backend's CORS_ORIGINS.`)
  }

  if (res.status === 401) {
    // The token is gone or expired. Clearing the session here — rather than in each
    // screen — is what stops a stale token producing a wall of identical 401s
    // across eight panels at once.
    signOut()
    throw new ApiError(401, 'Your session has expired. Please sign in again.')
  }
  if (res.status === 403) {
    throw new ApiError(403, "That isn't yours to open.")
  }
  if (res.status === 404 && nullOn404) return null as T
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    let ref: string | undefined
    try {
      const j = await res.json()
      ref = j?.error_ref
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
      else if (j?.message) detail = j.message
    } catch { /* non-JSON body — the status line is all there is */ }
    throw new ApiError(res.status, detail, ref)
  }
  // 204 and empty bodies are legitimate on DELETE.
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

/**
 * Turn an attachment into something a browser can actually open.
 *
 * 🔴 The relative route CANNOT be used as an `<a href>` or `<img src>`. It is
 * `/tasks/attachments/{id}?user_id=…`, which the auth middleware treats as a
 * user-scoped request — and markup cannot send an Authorization header, so the
 * browser gets 401. Measured: 401 without the token, 302 with it.
 *
 * So there are two paths and the choice is not cosmetic:
 *
 *  · `direct_url` — a permanent public S3 link, non-null while the bucket serves
 *    anonymous reads on `tasks/*`. No auth involved, immutable (uuid key), safe to
 *    put straight in an href. This is the fast path and the common case today.
 *
 *  · otherwise — fetch it through the API WITH the token and hand back a blob URL.
 *    Costs a round trip and some memory, and is the only thing that works when the
 *    bucket is private.
 *
 * Returning a dead href when `direct_url` is null (which is what `direct_url ??
 * undefined` does) renders a file that looks downloadable and silently is not.
 */
export async function attachmentHref(a: {
  id: number; direct_url: string | null; url: string
}): Promise<{ href: string; revoke?: () => void }> {
  if (a.direct_url) return { href: a.direct_url }
  const res = await fetch(`${getBase()}${a.url}?user_id=${requireUserId()}`, {
    headers: { Authorization: `Bearer ${getToken() ?? ''}` },
  })
  if (!res.ok) throw new ApiError(res.status, `Could not open that file (${res.status}).`)
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  // The caller MUST revoke this — a blob URL pins the whole file in memory until
  // the document is discarded, and a thread with ten attachments would hold all ten.
  return { href, revoke: () => URL.revokeObjectURL(href) }
}

/** Same rule for a thumbnail: the direct link or nothing. A thumbnail is decoration,
 *  so it is not worth an authenticated round trip and a blob per row. */
export const thumbHref = (a: { thumbnail_direct_url: string | null }) =>
  a.thumbnail_direct_url ?? null

// ── auth (the only calls made while signed out) ───────────────────────────────

export const auth = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }),

  register: (body: Record<string, unknown>) =>
    request<{ success: boolean; user: unknown }>('/auth/register',
      { method: 'POST', body }),

  joinTeam: (invite_code: string) =>
    request<{ success: boolean; team_id: number; team_name: string; role: string }>(
      '/auth/join-team', { method: 'POST', body: { user_id: requireUserId(), invite_code } }),
}

// ── tasks ────────────────────────────────────────────────────────────────────

export const tasks = {
  /** Everything this user CREATED plus everything ASSIGNED to them, deduped
   *  server-side. This is the home-screen call: fetching only created-tasks is how
   *  delegated work used to be invisible. */
  mine: (signal?: AbortSignal) =>
    request<{ count: number; tasks: Task[] }>(`/tasks/${requireUserId()}`, { signal }),

  completed: (signal?: AbortSignal) =>
    request<{ count: number; tasks: Task[] }>(
      `/tasks/${requireUserId()}?status=completed`, { signal }),

  assignedByMe: (signal?: AbortSignal) =>
    request<{ count: number; tasks: Task[] }>(
      `/tasks/${requireUserId()}/assigned-by-me`, { signal }),

  create: (body: {
    title: string; description?: string; due_at?: string | null
    priority?: string; assigned_to_user_id?: number | null
    assigned_to_user_ids?: number[]; item_type?: 'task'
  }) => request<Task>('/items', {
    method: 'POST', body: { ...body, user_id: requireUserId(), item_type: 'task' },
  }),

  /** Route through the dedicated complete endpoint, never PATCH /items with
   *  status=completed. That path setattrs the field and skips completed_at, the
   *  timeline row and the notification to whoever assigned it — a completion the
   *  assigner is never told about. */
  complete: (itemId: number) =>
    request<Task>(`/items/${itemId}/complete?user_id=${requireUserId()}`,
      { method: 'PATCH' }),

  /** 🔴 `status` and `user_id` are QUERY params on this route, not a body. Sending
   *  them as JSON returns 422 with no hint that the shape is the problem. */
  setStatus: (itemId: number, status: string) =>
    request<Task>(
      `/items/${itemId}/status?user_id=${requireUserId()}&status=${encodeURIComponent(status)}`,
      { method: 'PATCH' }),

  update: (itemId: number, updates: Record<string, unknown>) =>
    request<Task>(`/items/${itemId}`, {
      method: 'PATCH', body: { ...updates, user_id: requireUserId() },
    }),

  remove: (itemId: number) =>
    request<void>(`/items/${itemId}?user_id=${requireUserId()}`, { method: 'DELETE' }),

  timeline: (taskId: number, signal?: AbortSignal) =>
    request<unknown[]>(`/tasks/${taskId}/timeline`, { signal }),

  comments: (taskId: number, signal?: AbortSignal) =>
    request<{ task_id: number; comments: TaskComment[] }>(
      `/users/${requireUserId()}/tasks/${taskId}/comments`, { signal }),

  /** Multipart, so it bypasses request(): setting Content-Type by hand on a
   *  FormData body strips the boundary and the server sees a malformed part.
   *  Two-phase like chat images — upload first (comment_id stays NULL), then post
   *  the comment with the returned ids. 25 MB cap, enforced server-side. */
  uploadAttachment: async (taskId: number, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(
      `${getBase()}/users/${requireUserId()}/tasks/${taskId}/attachments`,
      { method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}` }, body: fd })
    if (!res.ok) {
      let detail = `Upload failed (${res.status}).`
      try {
        const j = await res.json()
        if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : detail
      } catch { /* keep the status line */ }
      throw new ApiError(res.status, detail)
    }
    return res.json() as Promise<CommentAttachment>
  },

  comment: (taskId: number, body: string, attachment_ids?: number[]) =>
    request<{ task_id: number; comments: TaskComment[] }>(
      `/users/${requireUserId()}/tasks/${taskId}/comments`,
      { method: 'POST', body: { body, ...(attachment_ids?.length ? { attachment_ids } : {}) } }),
}

// ── meetings / calendar ──────────────────────────────────────────────────────

export const meetings = {
  /** ?all=true so completed and past meetings stay on the calendar. Without it the
   *  calendar silently loses everything that already happened. */
  all: (signal?: AbortSignal) =>
    request<{ count: number; meetings: Meeting[] }>(
      `/meetings/${requireUserId()}?all=true`, { signal }),

  upcoming: (signal?: AbortSignal) =>
    request<{ count: number; meetings: Meeting[] }>(`/meetings/${requireUserId()}`, { signal }),

  create: (body: {
    title: string; scheduled_at: string; ends_at?: string | null
    location?: string; description?: string; assigned_to_user_id?: number | null
  }) => request<Meeting>('/meetings', { method: 'POST', body: { ...body, user_id: requireUserId() } }),
}

// ── chat ─────────────────────────────────────────────────────────────────────

export const chat = {
  sessions: (signal?: AbortSignal) =>
    request<{ sessions: ChatSession[] }>(`/chat/sessions?user_id=${requireUserId()}`, { signal }),

  /** `user_id` is a QUERY param here (Query(...)), unlike /chat and /chat/stream
   *  which take it in the body. Body-only returns 422. */
  newSession: (title?: string) =>
    request<{ session_id: number; title: string | null }>(
      `/chat/sessions?user_id=${requireUserId()}` +
      (title ? `&title=${encodeURIComponent(title)}` : ''),
      { method: 'POST' }),

  /** Oldest-first, one page. Pages on message ID, never created_at — those
   *  timestamps come from the app process's clock and existing rows mix UTC and
   *  IST, so they can tie and cannot be ordered. */
  history: (sessionId: number, before?: number, signal?: AbortSignal) =>
    request<{ messages: ChatMessage[]; has_more?: boolean }>(
      `/chat/sessions/${sessionId}/messages?user_id=${requireUserId()}&limit=50` +
      (before ? `&before=${before}` : ''), { signal }),

  deleteSession: (sessionId: number) =>
    request<void>(`/chat/sessions/${sessionId}?user_id=${requireUserId()}`, { method: 'DELETE' }),

  /** Starts a streamed reply; the answer arrives as frames on the app socket.
   *  `streaming: false` means the server saw no live socket for this user and
   *  generated nothing — fall back to send(). */
  stream: (message: string, sessionId?: number, attachment_ids?: number[]) =>
    request<{ message_id: string | null; streaming: boolean; reason?: string }>(
      '/chat/stream', {
        method: 'POST',
        body: {
          user_id: requireUserId(), message,
          ...(sessionId ? { session_id: sessionId } : {}),
          ...(attachment_ids?.length ? { attachment_ids } : {}),
        },
      }),

  /** The blocking fallback. Returns the whole reply in one body. */
  send: (message: string, sessionId?: number) =>
    request<{ response: string; message_id: string | null; session_id?: number }>(
      '/chat', {
        method: 'POST',
        body: { user_id: requireUserId(), message, ...(sessionId ? { session_id: sessionId } : {}) },
      }),
}

// ── notes / personalization ──────────────────────────────────────────────────

export const notes = {
  list: (signal?: AbortSignal) =>
    request<{ notes: Note[] }>(`/users/${requireUserId()}/notes`, { signal }),

  create: (content: string, title?: string) =>
    request<{ note: Note }>(`/users/${requireUserId()}/notes`,
      { method: 'POST', body: { content, ...(title ? { title } : {}) } }),

  update: (noteId: number, patch: { title?: string; content?: string }) =>
    request<{ note: Note }>(`/notes/${noteId}?user_id=${requireUserId()}`,
      { method: 'PATCH', body: patch }),

  /** Soft delete — the row is kept with is_active=0. */
  remove: (noteId: number) =>
    request<void>(`/notes/${noteId}?user_id=${requireUserId()}`, { method: 'DELETE' }),

  /** Suggests tasks and PERSISTS NOTHING. The client previews, then creates the
   *  kept ones through tasks.create — deliberately the only write in this path. */
  planDay: (opts: { note_ids?: number[]; date?: string } = {}) =>
    request<PlanDayResponse>(`/users/${requireUserId()}/notes/plan-day`,
      { method: 'POST', body: opts }),
}

// ── notifications ────────────────────────────────────────────────────────────

export const notifications = {
  list: (unreadOnly = false, signal?: AbortSignal) =>
    request<AppNotification[]>(
      `/notifications/${requireUserId()}${unreadOnly ? '?unread_only=true' : ''}`, { signal }),

  markRead: (id: number) =>
    request<AppNotification>(`/notifications/${id}/read?user_id=${requireUserId()}`,
      { method: 'PATCH' }),

  markAllRead: () =>
    request<{ ok: boolean }>(`/notifications/${requireUserId()}/read-all`, { method: 'POST' }),
}

// ── team ─────────────────────────────────────────────────────────────────────

export const team = {
  members: (teamId: number, signal?: AbortSignal) =>
    request<TeamMember[]>(`/teams/${teamId}/members`, { signal }),

  /** Self-assigned project tasks for the whole team. Filter the result by
   *  `is_project`, NOT by "is it delegated" — that client-side filter is what used
   *  to drop self-assigned RFQ tasks off the Team Tasks tab. */
  projectTasks: (teamId: number, signal?: AbortSignal) =>
    request<{ count: number; tasks: Task[] }>(`/teams/${teamId}/tasks?project=true`, { signal }),

  memberTasks: (teamId: number, memberId: number, signal?: AbortSignal) =>
    request<{ count: number; tasks: Task[] }>(
      `/teams/${teamId}/members/${memberId}/tasks`, { signal }),
}

// ── assistant metadata ───────────────────────────────────────────────────────

export const assistant = {
  suggestions: (signal?: AbortSignal) =>
    request<{ suggestions: string[] }>(
      `/assistant/suggestions?user_id=${requireUserId()}`, { signal }),

  business: (signal?: AbortSignal) =>
    request<BusinessProfile>(`/assistant/business?user_id=${requireUserId()}`, { signal }),
}

export const health = () => request<{ status: string }>('/health')
