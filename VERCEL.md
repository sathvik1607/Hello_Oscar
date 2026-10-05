# The web app on Vercel

## Live

  https://hellooscarweb.vercel.app  →  https://alumnxailabs-epa-3.onrender.com
  *(corrected 2026-10-02 — see the three-way discrepancy flagged below;
  previously this line said `developement-branch.onrender.com`, which was stale)*

🔴 **This repo DOES commit a backend hostname — in `web/.env.production`, not in
`vercel.json` or any doc — and it is currently `alumnxailabs-epa-3.onrender.com`,
set by commit `176f34b` ("build: production env pointing at the Flutter app's
backend") and last touched by `7ccdfce` (2026-09-29, adding Firebase push vars,
URL unchanged).** `git log -p -- web/.env.production` shows the file migrated
`developement-branch.onrender.com` → `alumnxailabs-epa-3.onrender.com` in
`bc4e837` (2026-09-02), whose commit message states plainly: *"the previous
target, developement-branch.onrender.com, serves prod and is currently
suspended"* and *".env.production points at the backend that is actually up."*
The file's own inline comment also records that `epa-3` runs against the
**dev database** (`oscar_dev`), not `cohort_main` prod, and that user ids differ
between the two (e.g. Vijender is 45 on dev, 4 on prod).

⚠️ **Caveat baked into the same file (unchanged since):** *"On a VERCEL build the
dashboard's own `VITE_BACKEND_URL` wins over this file."* So `.env.production` is
what a **local** `npm run build` produces — it is evidence of intent, not proof of
what the live Vercel deployment actually calls. **NOT VERIFIED 2026-10-02 —
Vercel dashboard/CLI not accessible in this session** to confirm the Production
environment variable matches this file.

🔴🔴 **THREE-WAY DISCREPANCY, flagged 2026-10-02, not resolved here:**
1. This repo's committed `web/.env.production` (as of `7ccdfce`, 2026-09-29) →
   `https://alumnxailabs-epa-3.onrender.com`, **against the dev DB** per its own
   comment.
2. The backend repo's `CLAUDE.md` and the cross-repo `OscarDocs/INTEGRATION.md`
   (v3.0.0, 2026-10-02) also name `alumnxailabs-epa-3.onrender.com` as the current
   production target for `remove-rfq-from-oscar` — but the backend doc itself
   says this is "owner-confirmed via dashboard, not yet machine-verified via a
   live Render API call," and separately flags that `epa-3`'s database role
   "changed" recently and is "NOT YET RE-VERIFIED."
3. **Per the user directly (2026-10-02, this session):** the Flutter mobile app
   was just submitted to both the Play Store and the App Store pointing at
   **`https://hello-oscar-backend.onrender.com`** — a hostname that appears
   **nowhere** in this repo's git history (`git log --all -p | grep -i
   "hello-oscar-backend"` returns nothing) and nowhere in the backend repo's
   `CLAUDE.md` excerpts reviewed either.

**What this means concretely:** if `hello-oscar-backend.onrender.com` is genuinely
what mobile now ships against, and this web app's committed/deployed config still
points at `alumnxailabs-epa-3.onrender.com` against the **dev** database, then
*the web app and the just-submitted mobile app are talking to two different
backends and almost certainly two different databases* — meaning a task created
in the web app would be invisible on mobile and vice versa. This is exactly the
cross-device realtime assumption `.env.production`'s own comment calls load-
bearing ("WebSocket state is process-local, so a task created on the phone only
reaches a browser connected to the SAME process"). **This needs a human decision,
not a docs fix** — resolve which backend is actually current (custom domain /
rename of the same Render service vs. a genuinely different one) before trusting
any of the three URLs above, and update `web/.env.production` + the Vercel
dashboard together once that's settled.

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
| 2 | `shell/ErrorBoundary.tsx` | Catches the crash itself — `looksLikeStaleChunk()` on the error, then **one** reload guarded by a `sessionStorage` key so a genuine bug cannot loop |

Both are **latched**: `setStale(true)` only, never `setStale(f === 'stale')`.
`checkFreshness()` answers `'unknown'` on any transient failure, so assigning its
result directly let a showing banner switch itself back off — hiding a real problem
*and*, because the bar is in the layout flow, shifting the page down and up as a
visible flicker. A build cannot un-stale itself.

⚠️ **Both are inert in `npm run dev`** — Vite serves unhashed modules, so
`OWN_ASSETS` is empty and `checkFreshness()` returns `'unknown'`. **A dev page that
keeps reloading is Vite's HMR, never this.** (It was: `tsconfig.*.tsbuildinfo` sat
git-tracked in the watched root, and every `typecheck`/`build` rewrite triggered a
full reload. Fixed via `.gitignore` **and** `server.watch.ignored` — the ignore file
alone does not stop Vite's watcher for files already on disk.)

### 🔴 There is no third detector, and the one that was removed is a trap worth naming

A `X-App-Version` header watcher used to sit here, comparing the app's build id
against the backend's. **It compared shas from two different repos** — `__BUILD_ID__`
is a commit in `Hello_Oscar`, `X-App-Version` a commit in `AlumnxAILabs_epa` — so
the equality test **could never be true**. It would have shown "a new version is
available" on the first API response, forever, on a perfectly current build, and
reloading could not clear it.

It was dormant purely by accident: the deployed backend does not send the header
yet. It would have started firing for every user the moment that commit deployed.

**A backend redeploy does not make a browser bundle stale.** Only a *web* deploy
does, which is what the asset check measures — same repo, same build, a comparison
that can actually come back false. `BUILD_ID` and `serverBuildId()` are kept for
display and diagnostics, and nothing subscribes to them.

🔴 **The asset check's rule is "ANY missing", not "no overlap" — and the difference
is the whole feature.** A first version required *zero* shared asset names before
declaring staleness. Measured across two real consecutive builds, **9 of 12 chunk
names were byte-identical** (content hashing only renames what changed), so that
version would have shipped permanently dormant while every isolated unit test of it
passed. If you touch this file, verify against **two real builds**, not a fixture.

---

## Backend requirements

**`CORS_ORIGINS` must contain `https://hellooscarweb.vercel.app`** — no trailing
slash. 🔴 **A browser's `Origin` header never carries a trailing slash**, so an
entry written `https://hellooscarweb.vercel.app/` can never match and every request
dies in preflight. This was live once and presented as a total outage.

`X-App-Version` is read off responses and surfaced for diagnostics only, so
`expose_headers` including it is a nice-to-have rather than a requirement — nothing
breaks without it. *(A cross-origin header JS has not been told it may read is
invisible, with no error and no console warning, so it simply reads `null`.)*

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
