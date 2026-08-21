# web

See the [repository README](../README.md) for setup, configuration and testing.

Quick reference:

```bash
npm install
npm run dev          # http://localhost:5174 (strictPort — fails rather than drifting)
npm run typecheck
npm run lint
npm run build        # → dist/
npm run preview
```

## Layout

```
src/
  lib/          api client, session, shared WebSocket, dates, the voice engine
  ui/           the design system — every radius, colour and state lives here
  shell/        navigation, header, connection banner
  features/     one directory per section
```

Three rules that the code depends on:

1. **`src/lib/api.ts` is the only file that calls `fetch`.** It attaches the bearer
   token, turns a 401 into a sign-out, and never accepts a `user_id` argument.
2. **`src/lib/appSocket.ts` is the only app WebSocket.** A second one delivers every
   frame twice and makes streamed chat interleave with itself.
3. **`due_at` / `scheduled_at` / `ends_at` are IST-naive.** Read them through
   `parseIstNaive()`, write them through `toIstNaive()`. `new Date(due_at)` is
   wrong by 5½ hours and by a whole day either side of midnight.
