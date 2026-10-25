/**
 * When the browser has no token, the page must ASK the host for one.
 *
 * WHY THIS TEST EXISTS (measured, live GUI 127.0.0.1:3080, 2026-10-25).
 *
 * The client's repair path is "reload the page". Measured, that path cannot
 * work when the browser has no usable cookie:
 *
 *   GET /              → 401  (three refreshes in a row: 401, 401, 401)
 *   GET /?token=<old>  → 401  (the token died with the process that minted it)
 *   GET /?token=<live> → 303 → 200  (only a live token mints the cookie)
 *
 * So "reload" and "retry with the token I remember" both re-fetch something
 * already known to fail. The cookie survives a restart, which is why a plain
 * refresh usually works — but not when the cookie is ABSENT (new browser,
 * cleared jar, expired 30 days, or the other host spelling: `localhost:3080`
 * and `127.0.0.1:3080` carry DIFFERENT cookie names, measured). In that case the
 * page needs a token it has never seen, and only the host can give it one.
 *
 * WHAT IS PINNED HERE:
 *   - with no usable token, the page asks the handoff route first;
 *   - the URL it asks carries no credentials (the route is unauthenticated by
 *     design) and is same-origin;
 *   - a handoff answer with a URL is used for the reload — that is the repair;
 *   - a null/failed answer falls back to the plain reload AND raises the notice,
 *     so the person gets the instruction instead of a silent dead page;
 *   - it asks at most once, so a restart cannot become a request storm.
 *
 * Run: node test/restart-token-handoff-client.mjs
 */

import assert from 'node:assert/strict'

let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (next) => {
      definition = next
    },
  },
}

await import('../client.js')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const plugin = { exports: definition.factory((id) => {
  assert.equal(id, 'react')
  return React
}) }
delete globalThis.window

const { askForLaunchUrl, forgetLaunchUrlAsk, HANDOFF_ROUTE } = plugin.exports

// --- 1. the route it asks is the documented one ------------------------

{
  assert.equal(HANDOFF_ROUTE, '/api/discipline-whale/auth-handoff', 'the client asks the route the host serves')
}

// --- 2. a successful ask yields the host's launch URL ------------------

{
  forgetLaunchUrlAsk()
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({ url: 'http://127.0.0.1:3080/?token=FRESH', reason: 'ok' }),
    }
  }
  const url = await askForLaunchUrl({ fetch: fetchImpl, origin: 'http://127.0.0.1:3080' })
  assert.equal(url, 'http://127.0.0.1:3080/?token=FRESH', 'the host URL is handed back for the reload')
  assert.equal(seen.length, 1, 'exactly one request')
  assert.equal(seen[0].url, 'http://127.0.0.1:3080/api/discipline-whale/auth-handoff', 'same origin, documented path')
  // Same-origin, no credentials for the asking request: the whole point is
  // that this works for a browser with no cookie.
  assert.equal(seen[0].init?.credentials, 'same-origin', 'the ask carries the cookie if one happens to exist')
  assert.equal(seen[0].init?.cache, 'no-store', 'a cached answer would be a stale token')
}

// --- 3. a null answer is not a URL ------------------------------------

{
  forgetLaunchUrlAsk()
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ url: null, reason: 'no-launch-token' }),
  })
  assert.equal(
    await askForLaunchUrl({ fetch: fetchImpl, origin: 'http://127.0.0.1:3080' }),
    null,
    'a null URL stays null — never the string "null", never an empty navigation',
  )
}

// --- 4. failures and junk answers are null, not exceptions ------------

{
  const cases = [
    ['network error', async () => { throw new Error('offline') }],
    ['403', async () => ({ ok: false, status: 403, json: async () => ({ url: null }) })],
    ['500', async () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['not JSON', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })],
    ['empty body', async () => ({ ok: true, status: 200, json: async () => ({}) })],
    ['wrong type', async () => ({ ok: true, status: 200, json: async () => ({ url: 42 }) })],
    ['empty string url', async () => ({ ok: true, status: 200, json: async () => ({ url: '' }) })],
  ]
  for (const [name, fetchImpl] of cases) {
    forgetLaunchUrlAsk()
    assert.equal(
      await askForLaunchUrl({ fetch: fetchImpl, origin: 'http://127.0.0.1:3080' }),
      null,
      `${name} yields null so the caller can fall back`,
    )
  }
}

// --- 5. the client asks at most once per page ------------------------

{
  forgetLaunchUrlAsk()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => ({ url: 'http://127.0.0.1:3080/?token=X' }) }
  }
  const ask = askForLaunchUrl({ fetch: fetchImpl, origin: 'http://127.0.0.1:3080' })
  await ask
  await ask
  await ask
  assert.equal(calls, 1, 'the promise is shared, so a burst of failures asks once')
}

console.log('ok — a tokenless page asks the host for a launch URL instead of reloading into a 401')
