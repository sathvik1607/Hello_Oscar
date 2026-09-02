# Oscar Web

The Oscar personal-assistant, in a browser. A React + TypeScript client for the
existing **HelloOscar** FastAPI backend — no parallel backend, no reimplemented
business logic, and the proven browser voice engine reused rather than rewritten.

```
web/          the app (Vite · React 19 · TypeScript · Tailwind v4)
scripts/      integration smoke tests that run against a live backend
```

---

## Run it

The backend must be running first. From the backend repo:

```bash
DISABLE_SCHEDULER=1 DISABLE_RFQ_POLLER=1 \
  uvicorn main:app --port 8000 --workers 1 --ws-ping-interval 0
```

`DISABLE_SCHEDULER=1` is not optional locally: the backend shares one RDS with the
deployed services, and a second scheduler gives every real user duplicate reminders.

Then:

```bash
cd web
npm install
cp .env.example .env.local        # VITE_BACKEND_URL defaults to 127.0.0.1:8000
npm run dev                       # → http://localhost:5174
```

**Production build:**

```bash
cd web && npm run build           # tsc -b && vite build → web/dist
npm run preview                   # serve dist locally on 5174
```

`dist/` is static, but 🔴 **a rewrite rule IS required** — the app moved from a hash
router to real paths, so `/tasks` is a request for a file that does not exist. See
`VERCEL.md`; the pattern must also **exclude `assets/`**, or a browser holding a
previous `index.html` gets `200 OK`+HTML for a deleted chunk and renders a blank
page.

---

## Backend configuration

Two variables matter, and only one of them is required.

| Var | Effect |
|---|---|
| `WEB_TOKEN_SECRET` | **Required for web sign-in.** Signs the bearer token. Falls back to `ADMIN_SECRET` if unset. With neither, `/auth/login` returns `token: null` and the app refuses to proceed with a specific message rather than running unauthenticated. |
| `WEB_AUTH_ENFORCE` | `=1` makes a token **required**: a user-scoped request without one is 401, and one naming another user is 403. **Default off** — see below. |

`CORS_ORIGINS` already includes `http://localhost:5174` by default. A deployed web
app needs its real origin added; a literal `*` is refused at startup with an error,
because this API authorises by bearer header and a wildcard origin would let any
page read a signed-in user's data.

### Why `WEB_AUTH_ENFORCE` is off by default

The Flutter app shares this backend and sends no token. Turning enforcement on with
an un-updated app in the field signs every mobile user out. So:

* **issuance** is always on — the web app always gets and sends a token;
* **enforcement** is a separate switch.

The web app is correct either way. Until the flag is on, the backend's documented
system-wide IDOR is still open for callers that simply omit the token — the flag is
the fix, and the token layer is what makes the flag possible. Flip it once the
mobile client sends one too.

---

## Deploys and staleness

A long-lived tab is the normal case here, so a deploy leaves real users running a
bundle the server no longer has. Two detectors handle it, both **latched** — the
asset comparison in `lib/freshness.ts`, and `shell/ErrorBoundary.tsx` catching the
crash itself with one `sessionStorage`-guarded reload. Details in `VERCEL.md`.

⚠️ **Both are inert under `npm run dev`** — Vite serves unhashed modules, so there
are no asset names to compare. **A dev page that keeps reloading is Vite's HMR, not
this.**

🔴 **Do not add a detector that compares our build id to the backend's.** One
existed and was removed: `__BUILD_ID__` is a commit in this repo, `X-App-Version` a
commit in the backend repo, so the two can never be equal and it reported a
permanent false "new version available". A backend redeploy does not make a browser
bundle stale; only a web deploy does. `X-App-Version` is kept for diagnostics only.

---

## Testing

Compilation proves nothing about any of this, so there are two live-backend suites.

```bash
# HTTP contract + authorization. 35 checks.
BASE=http://127.0.0.1:8099 EMAIL=… PASSWORD=… bash scripts/smoke.sh

# WebSocket + Sarvam relays — the legs curl cannot reach. 14 checks.
BASE=http://127.0.0.1:8099 EMAIL=… PASSWORD=… ./scripts/ws_smoke.py
```

Run the backend with `WEB_AUTH_ENFORCE=1` for these; the authorization assertions
are the point of the first one. Use a **dedicated throwaway account** — every
existing user on that database is a real person, and a test turn writes into their
chat history and pushes to their phone.

Frontend gates:

```bash
cd web && npm run typecheck && npm run lint && npm run build
```

---

## What this reuses

Everything. The backend was not modified except to add authentication.

| | |
|---|---|
| Auth | `POST /auth/login` (+ a `token` field, additive) |
| Tasks | `/tasks/{uid}`, `/items`, `/items/{id}/complete`, `/items/{id}/status`, `/items/{id}` |
| Comments | `/users/{uid}/tasks/{id}/comments` |
| Meetings | `/meetings/{uid}?all=true`, `/calendar/events` |
| Chat | `/chat/stream`, `/chat`, `/chat/sessions*` |
| Notes | `/users/{uid}/notes`, `/notes/{id}`, `/notes/plan-day` |
| Team | `/teams/{id}/members`, `/teams/{id}/tasks?project=true` |
| Activity | `/notifications/{uid}`, `.../read`, `.../read-all` |
| Assistant | `/assistant/suggestions`, `/assistant/business` |
| Realtime | `WS /ws` — `chat.thinking/delta/tool/complete`, `notification.created`, `task.comment.created` |
| Voice | `WS /voice/sarvam/stt`, `WS /voice/sarvam/tts` |

## Voice

`web/src/lib/liveVoice.ts` is the admin panel's engine, ported with **one** change:
the relay is authorised by the signed-in user's bearer token (`?t=`) instead of the
panel's shared admin secret (`?k=`). A page any user can open must not carry an
operator secret.

Everything else is deliberately untouched, including the parts that look
improvable. The 100 ms framing, the 800 ms VAD window, the half-duplex mic gate
during playback, the two-timer end-of-reply detection and the off-by-default noise
gate each encode a failure that was paid for once already.

```
mic ─100ms PCM16─▶ WS /voice/sarvam/stt ─▶ saaras:v3-realtime
                                         ◀─ partials, VAD, final
   ─▶ POST /chat/stream ─▶ agent ─▶ frames on /ws
   ─▶ WS /voice/sarvam/tts ─▶ bulbul:v3 ─▶ mp3 chunks ─▶ MediaSource ─▶ speaker
```

The Sarvam credential never reaches the browser — the backend holds it and relays
frames through untouched.

**Future migration path (not done, not needed yet):** the browser orchestrates all
four legs, so none of this is reusable by a Flutter client. A server-side
`WS /voice/session` that ran STT→LLM→TTS would make every client thin. It would
also mean rewriting the working pipeline, so it is documented rather than attempted.

## Known limits

* **No registration.** All three backend registration paths need a gate code that a
  public page should not collect. Accounts are created by an administrator.
* **No image attachments in chat.** The endpoints exist; the UI does not use them.
  Oscar does not read images anyway (vision is removed, not disabled).
* **No team/direct messaging UI.** `pa_team_messages` and `pa_direct_messages` are
  fully built server-side and unused here.
* **`/calendar/free-slots` is a backend stub** returning `[]`, which is why Calendar
  is an agenda rather than a free-space finder.
* **Chat history is server-only** — no offline cache, so the transcript needs a
  connection. The mobile client keeps a local copy; this does not.
* **`is_overdue` is re-checked client-side**, via `isOverdue()` in `lib/format.ts`,
  which ANDs in `!is_all_day`. The backend now does the same (`bd4d9c6`) but that
  commit is not on a deployed branch, so without the client guard every "anytime"
  task would flip to overdue the day after it was created — against a 23:59
  placeholder nobody chose. Keep the guard; it is correct against both backends.
* **The backend URL is compiled in**, so pointing the app elsewhere is a redeploy.
  Moving it to a runtime `/config.json` or an `/api/*` Vercel rewrite would remove
  the whole class of URL bugs described in `VERCEL.md`; not done.
