# Deploy: feat/web-auth → internal/testing → developement-branch.onrender.com

Everything is committed and verified. One command is yours to run, because
`sathvik1607` is pull-only on `cbunny-2005/checking`:

    remote: Permission to cbunny-2005/checking.git denied to sathvik1607

## 1. Push (needs a cbunny-owner PAT)

    cd ~/Desktop/AlumnxAILabs_epa
    git push checking feat/web-auth:internal/testing

Auto-deploy is ON (trigger: commit) on srv-d9ngbetaeets73bsl4qg, so this deploys
itself in ~90s. If the Deploys tab shows nothing building within a minute, trigger
it manually — that happened on 2026-08-18.

## 2. Then tell me, and I will

  - watch the deploy to Live
  - set WEB_TOKEN_SECRET (so the web app can sign in)
  - add the web app's origin to CORS_ORIGINS
  - verify DISABLE_SCHEDULER=1 and DISABLE_RFQ_POLLER=1 SURVIVED
  - re-run the endpoint sweep against the deployed URL

🔴 Env vars are the one thing that can hurt real users here. The Render API merges
by default; anything that replaces would delete DISABLE_SCHEDULER, and a second
scheduler on the shared RDS gives every real user duplicate reminders.

## What this deploy carries — 15 commits, and only 5 are the web work

  5e624c3  fix(comments)   timestamps went out naive        <- mine
  9c37398  fix(voice-router) short-utterance ceiling        <- YOURS, was uncommitted
  3b72c8f  fix(agent)      tasks were not being created     <- mine
  1a64b05  fix(items)      record reopening                 <- mine
  f63bec9  feat(auth)      bearer tokens                    <- mine
  f6934c2 … 59feab0        the whole feat/sarvam-voice branch (10 commits)

ALL OR NOTHING, and this is not a preference. f63bec9 modifies `_sarvam_relay`,
which does not exist on internal/testing — nor does services/voice_router.py, nor
the `voice: true` flag in agent.py. So the web-auth commits cannot be cherry-picked
without the voice branch underneath them. Shipping "just the web work" means
rewriting that commit to drop the relay door.

## Behaviour changes that reach FLUTTER users

  ACTIVE, affects everyone:
    - the three new anti-fabrication guards. A reply that claims/promises/asserts a
      task with no tool behind it forces ONE re-run. This is the fix for "tasks are
      not being created". Cost: one extra model call on a turn that was already
      wrong. 18 phrasings pinned in tests, weighted against false positives.
    - comment timestamps now carry a UTC offset. Fixes the mobile display too —
      Flutter parses with DateTime.tryParse(...).toLocal(), which handles it.
    - reopening a task writes "↩️ Reopened by X" into its thread.
    - the whole voice branch: a spoken turn gets gpt-4.1-nano, an 811-char prompt
      and 7 tools instead of 31. Only on turns sending `voice: true` — the Flutter
      app does send it.

  INERT unless switched on:
    - WEB_AUTH_ENFORCE is NOT set, so the middleware passes everything through.
      Verified after these commits: all 14 Flutter endpoints answer 200 with no
      token, and login returns the same user shape plus `token`.

  CORS only:
    - allow_headers is now an explicit list instead of "*". CORS applies to browsers
      only, so Dio/mobile is unaffected. The admin panel sends X-Admin-Secret, which
      is on the list.

## Verified before handing over

  backend suite      659 passed / 25 failed — documented baseline, 0 new
  FCM leaks          0
  Flutter endpoints  14/14 → 200 with no token
  login shape        unchanged + token
  HTTP contract      26 passed / 1 skipped (auth checks need the flag)
  WS + relay         10 passed / 2 skipped, real Sarvam audio round-tripped
  realtime frames    5/5 delivered

## Rollback

Render's Deploys tab → the previous deploy → Redeploy. Or:

    git push --force-with-lease checking 278144d:internal/testing

278144d is what internal/testing pointed at before this.
