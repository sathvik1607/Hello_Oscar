# The web app on Vercel

## Live

  https://hellooscarweb.vercel.app  →  https://developement-branch.onrender.com

The project is owned in Vercel and deploys on push to `main`. `VITE_BACKEND_URL` is
set in the project's Environment Variables and is **baked into the bundle at build
time** — changing the backend means a redeploy, not a settings toggle.

---

## SPA rewrite — REQUIRED, and the pattern matters

`vercel.json` lives at the **repo root** (not in `dist/`):

```json
"rewrites": [{ "source": "/((?!assets/).*)", "destination": "/index.html" }]
```

🔴 **Two separate load-bearing facts here, and the second one cost a blank white page
in production.**

**1. The rewrite must exist at all.** The app uses real paths, so `/tasks` is a
request for a file that does not exist. Remove the line and every refresh and every
shared link 404s — while `npm run build` and `tsc` both stay green, because it is a
hosting concern and not a code one.

**2. It must EXCLUDE `assets/`.** The pattern used to be `/(.*)`, which matched
everything. Vercel does check the filesystem before rewrites, so this was harmless
while a file existed — but after a deploy, a **browser holding the previous
`index.html` requests the old content-hashed chunk names, which are now gone.**
Those requests then matched the catch-all and came back **`200 OK` with HTML**
instead of `404`. The browser dutifully executed HTML as JavaScript, the dynamic
`import()` behind a `lazy()` screen rejected, and with no ErrorBoundary above it
React unmounted the tree: **a blank white page, no console error a user would find,
and a redeploy did not fix it.** The negative lookahead makes a missing chunk a
clean 404, which is a failure the client can actually detect and recover from.

The app defends the same failure in two more places, deliberately — see
"Staleness" below. Any one of the three is enough; all three is on purpose, because
this failure mode is invisible in every local test.

Serving from a subpath instead of `/` would additionally require Vite's `base`.
Nothing does today.

Old `/#/...` links keep working: `adoptLegacyHash()` in `src/App.tsx` rewrites them
to the clean path on load. That is the only place it can be done, since the server
never sees a fragment.

---

## Staleness: three independent detectors

A long-lived tab is the normal case for this app, so a deploy leaves real users
running a bundle that no longer matches the server. Three layers, in the order they
fire:

| # | Where | Detects |
|---|---|---|
| 1 | `lib/freshness.ts` — **asset check** | Re-fetches `/index.html`, extracts its `<script src>` names, and reports **stale if ANY script this bundle loaded is missing** from the live one |
| 2 | `lib/freshness.ts` — **header check** | Watches `X-App-Version` on every API response; a change means the *backend* was redeployed |
| 3 | `shell/ErrorBoundary.tsx` | Catches the crash itself — `looksLikeStaleChunk()` on the error, then **one** reload guarded by a `sessionStorage` key so a genuine bug cannot loop |

🔴 **The asset check's rule is "ANY missing", not "no overlap" — and the difference
is the whole feature.** A first version required *zero* shared asset names before
declaring staleness. Measured across two real consecutive builds, **9 of 12 chunk
names were byte-identical** (content hashing only renames what changed), so that
version would have shipped permanently dormant while every isolated unit test of it
passed. If you touch this file, verify against **two real builds**, not a fixture.

🔴 **`X-App-Version` needs `expose_headers` on the backend.** A cross-origin
response header the browser has not been told JS may read is invisible — no error,
no console warning, just `null` forever. It is in the backend's CORS config; if the
header reads `null` on the deployed site but works locally, check that list first.
The header is also **absent entirely** on a backend where neither `RENDER_GIT_COMMIT`
nor `APP_BUILD_ID` is set, which the client must treat as "no information" rather
than as stale.

---

## Backend requirements

**`CORS_ORIGINS` must contain `https://hellooscarweb.vercel.app`** — no trailing
slash. 🔴 **A browser's `Origin` header never carries a trailing slash**, so an
entry written `https://hellooscarweb.vercel.app/` can never match and every request
dies in preflight. This was live once and presented as a total outage.

`expose_headers` must include `X-App-Version` (above).

🔴 **The Render API can WRITE env vars but not READ them, and a write replaces the
whole value.** Never set `CORS_ORIGINS` blind — read the current value from the
dashboard, extend it, and pass `replace:false` on the update, or you silently delete
origins you cannot see (including the admin console's).

---

## What is NOT persisted in the browser

Only the signed-in session. In particular the **backend URL is not saved** — see
`getBase()` in `lib/session.ts`. A build-time `VITE_BACKEND_URL` **wins over any
stored value and purges it**, because the reverse order (`localStorage || VITE_*`)
is a bug this repo has already shipped once: a value saved on one login outranks
every future deploy, the resulting error names a host that appears nowhere in the
shipped bundle, and neither a redeploy nor a cache clear fixes it. The override
survives only for local dev, where the built-in value is the localhost default.
`baseIsLocked()` reports which regime is in force.
