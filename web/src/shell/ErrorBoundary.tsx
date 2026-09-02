import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches a render/import crash instead of letting it blank the page.
 *
 * 🔴 WITHOUT THIS, ANY THROW IN A LAZY SCREEN RENDERS NOTHING AT ALL — React
 * unmounts the whole tree and the user gets a white page with no text, no button
 * and no hint that reloading would help. That is the worst possible failure: it
 * looks like the app is "loading forever", so people wait instead of reloading.
 *
 * 🔴 The specific crash this was written for: a code-split chunk that no longer
 * exists. After a deploy the old filenames are gone, but the SPA rewrite
 * ("/(.*)" → /index.html) answers those requests with **HTTP 200 and an HTML
 * document** rather than a 404. The browser then tries to execute HTML as
 * JavaScript, which throws a SyntaxError deep inside React's lazy() machinery.
 * Verified against the live site: a chunk filename from earlier in the day returns
 * 200 and `<!doctype html>`. So this is not a hypothetical — it is what happens to
 * every open tab on every deploy, the moment the user navigates to a screen whose
 * chunk had not yet been downloaded.
 *
 * A chunk error is therefore treated as "you are running an old version" and
 * offers a reload, which genuinely fixes it. Anything else gets the generic
 * message, because guessing about an unknown error is how a wrong fix gets
 * suggested.
 */

/** One automatic reload per tab. See componentDidCatch. */
const RELOADED_KEY = 'oscar.web.chunk_reloaded'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Does this look like a stale-chunk failure rather than a real bug?
 *
 *  Matched on message text because there is no error CODE for it — the browser
 *  reports a SyntaxError from executing HTML, or a failed dynamic import, and the
 *  wording differs per engine. Kept broad on purpose: a false positive here shows
 *  a reload button for a bug that a reload will not fix, which is a much smaller
 *  harm than a white page. */
const looksLikeStaleChunk = (e: Error) =>
  /loading chunk|dynamically imported module|importing a module script|unexpected token '<'|failed to fetch dynamically/i
    .test(`${e.name} ${e.message}`)

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console only. There is no client error-reporting sink in this app, and
    // swallowing it silently would leave nothing to debug from a screenshot.
    console.error('[ErrorBoundary]', error, info.componentStack)

    /**
     * A stale chunk fixes itself, so fix it — do not make the user press a button
     * for a problem they did not cause and cannot understand.
     *
     * 🔴 GUARDED AGAINST A RELOAD LOOP, which is the obvious way this goes wrong:
     * if the reload does not resolve the error (a genuine bug that merely looks
     * like a chunk failure), reloading again would spin forever and the user could
     * never even read the message. A one-shot marker in sessionStorage allows
     * exactly ONE automatic reload per tab; after that the card is shown and the
     * button becomes the user's choice. sessionStorage rather than localStorage so
     * the allowance returns in a new tab instead of being spent permanently.
     */
    if (!looksLikeStaleChunk(error)) return
    try {
      if (sessionStorage.getItem(RELOADED_KEY)) return
      sessionStorage.setItem(RELOADED_KEY, '1')
      location.reload()
    } catch { /* storage blocked — fall through to the button */ }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const stale = looksLikeStaleChunk(error)
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <h1 className="text-[17px] font-semibold">
            {stale ? 'Oscar has been updated' : 'Something went wrong'}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed"
             style={{ color: 'var(--text-muted)' }}>
            {stale
              ? 'This page was running an older version. Reload to continue.'
              : 'This screen ran into a problem. Reloading usually fixes it.'}
          </p>
          <button type="button" onClick={() => location.reload()}
                  className="mt-5 w-full rounded-xl px-4 py-2.5 text-[14px] font-semibold text-white"
                  style={{ background: 'var(--accent)' }}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
