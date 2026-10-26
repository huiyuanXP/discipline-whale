/**
 * A page that got 401 must be able to find the URL that WOULD authenticate it.
 *
 * WHY THIS FILE EXISTS (measured, 2026-10-25, live GUI on 127.0.0.1:3080).
 *
 * The whole client-side self-repair chain is dead in the case the user actually
 * hits, and the reason is structural rather than a bug in the chain:
 *
 *   $ curl -s -D - http://127.0.0.1:3080/
 *   HTTP/1.1 401 Unauthorized
 *   content-type: text/plain; charset=utf-8
 *   body (68 bytes): "dsh web authentication required; reopen the URL printed
 *                     by dsh web."
 *   <script> tags in that body: 0
 *
 * A 401 for the DOCUMENT means no page was served, so no plugin bundle loaded,
 * so `installRestartWatch` never ran. The client cannot possibly show a notice
 * or reload itself on a page that does not exist. Reloading (which is what
 * "just refresh" is) re-fetches the same document and gets 401 again — measured
 * three times in a row, 401 each time. Only a `?token=` URL mints the cookie.
 *
 * The cookie does survive a restart (`client-connection/browser-session` in
 * `$DSH_HOME/.credentials.yaml` is created once, not per process; measured: a
 * cookie stamped three hours before the running process is accepted, GET / →
 * 200). So the failing case is precisely "no usable cookie in this browser" —
 * a new browser, a cleared cookie jar, a different host spelling
 * (`localhost:3080` and `127.0.0.1:3080` have DIFFERENT cookie names, measured),
 * or an expired 30-day cookie. In every one of those, a reload can never help.
 *
 * WHAT THIS ADDS, and what it deliberately does NOT do:
 *   - On boot, the running process writes the URL it printed (`?token=…`) to a
 *     stable file, so a person (and a support script) has one known location
 *     instead of grepping a log.
 *   - The same value is served on an UNAUTHENTICATED route, because the page
 *     that needs it is by definition not authenticated.
 *   - It does NOT make a token survive a restart: the token is still minted per
 *     process with `randomBytes(32)` and still dies with it. What is published
 *     is *this* process's own launch token — the same secret it already prints
 *     to stdout and writes to its log — so the security boundary is unchanged
 *     in kind. See `docs/restart-and-token.md` for the exposure argument.
 *
 * The route is loopback-only by construction: `dsh web` refuses to bind an
 * unspecified address, so publishing a token here cannot widen reachability
 * beyond the machine.
 *
 * @module discipline-whale/token-handoff
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Unauthenticated route a 401 page can call to learn where to go. */
export const TOKEN_HANDOFF_ROUTE = '/api/discipline-whale/auth-handoff'

/**
 * Stable file the running process publishes its launch URL to.
 *
 * `$DSH_HOME/logs/last-token-url.txt`, next to the per-restart log dirs, so the
 * most recent successful boot is always at the same path. Permissions are
 * `0600`: the token is a live credential for this process only, and the file
 * exists to be read by the same user, not by anything else on the machine.
 *
 * @param {string} dshHome - the Harness home (`$DSH_HOME`, normally `~/.dsh`).
 * @returns {string} absolute path.
 */
export function tokenHandoffFile(dshHome) {
  return join(dshHome, 'logs', 'last-token-url.txt')
}

/**
 * The body the handoff route answers with.
 *
 * `url` is null when the caller cannot be given one honestly — a non-loopback
 * authority, or a failed token read. The page then keeps the manual
 * instruction rather than being sent somewhere that will not work.
 *
 * @param {{url: string|null, origin: string, reason?: string}} input
 * @returns {object} JSON-serialisable body.
 */
export function handoffBody(input) {
  const url = typeof input?.url === 'string' && input.url !== '' ? input.url : null
  return {
    url,
    origin: typeof input?.origin === 'string' ? input.origin : '',
    // Named so the client can tell "the host has no token for you" apart from
    // "the host did not answer", which need different copy.
    reason: url === null ? (input?.reason ?? 'unavailable') : 'ok',
    hint: 'Paste this URL into the address bar and press Enter. The token is minted per process and changes on every restart.',
  }
}

/**
 * Decide whether an authority may be handed this process's launch token.
 *
 * Only a loopback authority qualifies. This mirrors the fence `dsh web` itself
 * enforces at bind time: it refuses to listen on an unspecified address, so a
 * token served here cannot reach further than the machine already allows.
 *
 * @param {string|undefined} authority - the request's `Host` header.
 * @returns {boolean}
 */
export function isLoopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return false
  // A bare IPv6 authority (`::1`) has no port and is not a legal `host:port`
  // URL authority, so it is recognised before the URL parse rather than after.
  if (authority === '::1') return true
  let host
  try {
    host = new URL(`http://${authority}`).hostname
  } catch {
    return false
  }
  if (host === 'localhost') return true
  if (host === '::1' || host === '[::1]') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return v4 !== null && v4[1] === '127'
}

/**
 * Publish the launch URL to disk and describe what to serve.
 *
 * Best effort by design: a read-only home must not stop the server from
 * booting, so a failed write is reported and the route still answers from
 * memory. The in-memory copy is the source of truth for the route; the file
 * exists so a person has a stable path.
 *
 * @param {{dshHome: string, url: string, logger?: object}} input
 * @returns {Promise<{path: string, written: boolean, inMemory: string}>}
 */
export async function publishTokenHandoff(input) {
  const path = tokenHandoffFile(input.dshHome)
  try {
    await mkdir(dirname(path), { recursive: true })
    // 0600: same user only. Written via the file's own path so a pre-existing
    // world-readable file is replaced rather than appended to.
    await writeFile(path, `${input.url}\n`, { mode: 0o600 })
    return { path, written: true, inMemory: input.url }
  } catch (error) {
    input.logger?.warn?.(`discipline-whale: could not publish ${path}: ${error?.message ?? error}`)
    return { path, written: false, inMemory: input.url }
  }
}

/**
 * Register the unauthenticated handoff route on the Host's web server.
 *
 * Registered on `webServer` rather than the connection's fetch registry: the
 * connection registry applies the browser-auth fence, and the caller here is
 * precisely a browser that has no valid cookie yet.
 *
 * @param {object} webServer - the Host web server service.
 * @param {{url: () => string, logger?: object}} options
 * @returns {() => void} disposer.
 */
export function registerTokenHandoffRoute(webServer, options = {}) {
  const urlOf = typeof options.url === 'function' ? options.url : () => ''
  return webServer.register({
    kind: 'exact',
    path: TOKEN_HANDOFF_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
        res.end()
        return
      }
      const authority = req.headers?.host
      if (!isLoopbackAuthority(authority)) {
        // No token for a non-loopback caller. 403, not 401: this route is
        // reachable without a cookie by design, and the refusal is about the
        // caller's address, not its credential.
        res.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(handoffBody({ url: null, origin: '', reason: 'non-loopback' })))
        return
      }
      const url = urlOf()
      const body = handoffBody({
        url,
        origin: typeof authority === 'string' ? `http://${authority}` : '',
        reason: url === '' ? 'no-launch-token' : undefined,
      })
      res.writeHead(200, {
        // Never cached: the token changes every time the process does.
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      })
      res.end(JSON.stringify(body))
    },
  })
}
