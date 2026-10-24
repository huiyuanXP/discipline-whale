/**
 * A page that outlives a `dsh web` restart must repair itself.
 *
 * WHY THIS TEST EXISTS. The reported symptom was "after every restart the old
 * 3080 tab cannot create a session and cannot open the whale page; only a
 * manual browser refresh brings back a usable window". It was reproduced
 * against a real restarted server with headless Chromium, and it is TWO
 * distinct failures that both end in a dead-looking tab:
 *
 *   1. HTTP 401. The launch token is minted per process with
 *      `randomBytes(32)`, and `/` mints the browser cookie only for a request
 *      that carries `?token=`. A tab whose cookie the new process rejects gets
 *      `401 unauthorized` on /api and on /. Measured with the cookie dropped:
 *      clicking the sidebar's "新建会话" produced a silent 401, and the whale
 *      panel rendered "打开主会话失败：the host recorded no main session" — a
 *      data-loss message for what is really "authenticate again". No reload
 *      was ever attempted, which is exactly why a manual refresh was the only
 *      cure.
 *   2. A stale bundle revision. Plugin bundles are addressed by
 *      `?rev=<sha1 over mtime, ctime, size>` and client-modules answers 404 to
 *      any other rev ("versioned code is immutable; mismatched revisions are
 *      rejected instead of serving newer bytes"). A tab open across a plugin
 *      REINSTALL therefore asks for a rev the new process does not have.
 *      Measured on one process, one cookie: old rev 6c8d60a2e141 → 404,
 *      new rev 57e4614df9bb → 200. This is why a plain restart recovers by
 *      itself (verified: 75s of downtime, WebSocket reconnected, every API
 *      call 200) while an upgrade does not.
 *
 * WHAT IS PINNED HERE, and why each is a fact rather than taste:
 *
 *   - 401/403 mean "authenticate again", never "your whale is gone". The UI
 *     copy for that case is asserted too, because showing a data-loss message
 *     for an auth failure is the bug as the user experienced it.
 *   - A network error or a 5xx during the restart window means "retry", NOT
 *     "reload": the connection layer already retries those, and a reload
 *     there would interrupt a session that is fine.
 *   - The re-auth URL keeps `?token=`, and reuses the token from the address
 *     bar first and the stored one second, because after the first exchange
 *     the token is no longer in the URL.
 *   - A different `rev` on a /plugins/ URL is the reinstall case; the same rev
 *     and a non-plugin URL are not.
 *
 * Run: node test/restart-recovery.mjs
 */

import assert from 'node:assert/strict'

// --- load the browser half ------------------------------------------------

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

const { restartActionFor, reauthUrl, isStaleBundleUrl, createRestartWatch, whaleFailureCopy, DICTIONARIES } = plugin.exports

// --- 1. what a failure means ---------------------------------------------

{
  assert.equal(restartActionFor(401), 'reauthenticate', 'a 401 is authentication, not data loss')
  assert.equal(restartActionFor(403), 'reauthenticate', 'the trust fence reads the same to the page')
  assert.equal(restartActionFor(404), 'stale-bundle', 'a 404 is the reinstall/stale-rev case')
  assert.equal(restartActionFor('network'), 'retry', 'a dropped socket during the restart window is a retry')
  assert.equal(restartActionFor(0), 'retry', 'an aborted request is a retry')
  assert.equal(restartActionFor(502), 'retry', 'a gateway error while the server boots is a retry')
  assert.equal(restartActionFor(200), 'ignore', 'a success changes nothing')
  assert.equal(restartActionFor(422), 'ignore', 'a request the host rejected is not a restart symptom')
}

// --- 2. the re-auth URL --------------------------------------------------
//
// MEASURED CORRECTION. An earlier version of this file assumed the page could
// remember the launch token and replay it. It cannot, and the reason matters:
// `/` answers the token exchange with `303 → ./`, and Chromium records the
// final URL — measured in a real tab: `location.href` clean, `document.referrer`
// empty, no global holding it, and sessionStorage empty because the plugin's
// own script has not run yet at that point. The token exists only in the URL
// `dsh web` printed and in the server's log.
//
// What DOES survive a restart is the cookie: its signing secret lives in
// `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`) and is
// created once, not per process. Measured: a cookie signed with that stored
// secret and stamped an hour BEFORE the current process started is accepted by
// the new process (GET / → 200). So the correct repair for a 401 is a plain
// reload to the same origin — which is exactly why "just refresh the browser"
// was the workaround the user discovered by hand.

{
  // A clean reload is the repair, and it keeps the route the person was on.
  assert.equal(
    reauthUrl('http://127.0.0.1:3080/', ''),
    'http://127.0.0.1:3080/',
    'a bare reload is enough: the cookie secret survives the restart',
  )
  assert.equal(
    reauthUrl('http://127.0.0.1:3080/session/abc', ''),
    'http://127.0.0.1:3080/session/abc',
    'the route survives the reload',
  )
  // When a token IS in the address bar (first visit, or the URL the restarter
  // opened), it is preserved rather than stripped: `/` needs it to mint the
  // cookie, and dropping it would leave a 401 page.
  assert.equal(
    reauthUrl('http://127.0.0.1:3080/?token=abc', ''),
    'http://127.0.0.1:3080/?token=abc',
    'an address-bar token is preserved',
  )
  // A stored token, when one was somehow captured, is still used.
  assert.equal(
    reauthUrl('http://127.0.0.1:3080/', 'stored-token'),
    'http://127.0.0.1:3080/?token=stored-token',
    'a known token is replayed when there is one',
  )
  // The fragment is dropped: a reload cannot use it and the server never sees it.
  assert.equal(
    reauthUrl('http://127.0.0.1:3080/session/abc#turn-4', ''),
    'http://127.0.0.1:3080/session/abc',
    'the fragment goes, the path stays',
  )
  assert.equal(reauthUrl('not a url', 'tok'), null, 'an unparseable location yields no URL')
}

// --- 3. the stale-bundle test --------------------------------------------

{
  const url = 'plugins/??discipline-whale/client.js&rev=6c8d60a2e141'
  assert.equal(isStaleBundleUrl(url, '57e4614df9bb'), true, 'a different rev is stale')
  assert.equal(isStaleBundleUrl(url, '6c8d60a2e141'), false, 'the boot rev is not stale')
  assert.equal(
    isStaleBundleUrl('plugins/??dsh-api-gateway/client.js&rev=aaaa', 'bbbb'),
    true,
    'any plugin bundle counts, not just this one',
  )
  assert.equal(
    isStaleBundleUrl('/api/discipline-whale/home?rev=zzz', 'boot'),
    false,
    'an API route with a rev is not a bundle',
  )
  assert.equal(isStaleBundleUrl(url, ''), false, 'without a boot rev nothing can be stale')
  assert.equal(isStaleBundleUrl(undefined, 'boot'), false, 'a missing URL is not a failure')
}

// --- 4. the copy says "authenticate", not "your data is gone" ------------

{
  // The measured wrong message: an auth failure rendered as
  // "打开主会话失败：the host recorded no main session".
  for (const [locale, dictionary] of Object.entries(DICTIONARIES)) {
    assert.equal(typeof dictionary.authLost, 'string', `${locale} explains a lost session`)
    assert.equal(typeof dictionary.authReopen, 'string', `${locale} offers the reopen action`)
    assert.equal(typeof dictionary.authPasteHint, 'string', `${locale} explains what to paste`)
    assert.equal(typeof dictionary.staleBundle, 'string', `${locale} explains a stale bundle`)
    assert.ok(dictionary.authLost.length > 0, `${locale} authLost is not empty`)
    assert.ok(dictionary.authReopen.length > 0, `${locale} authReopen is not empty`)
  }
  // The Chinese copy is the one the user sees; it must not imply data loss.
  const zh = DICTIONARIES.zh
  assert.ok(!/主会话.*(丢|不存在|没有)/.test(zh.authLost), 'the auth message never claims the session is gone')
  assert.match(zh.authReopen, /重新|打开|认证/, 'the action is explicitly about authenticating again')
}

// --- 5. the watcher that actually runs in a live page --------------------

{
  // The pure rules are worth nothing unless something drives them. This is the
  // `window.onunhandledrejection`-style entry the page installs: given a
  // response (or a throw), it decides, acts at most once, and never loops.
  const calls = []
  const watcher = createRestartWatch({
    bootRev: 'boot-rev',
    storedToken: () => 'stored-token',
    location: () => ({ href: 'http://127.0.0.1:3080/' }),
    reload: (url) => calls.push({ kind: 'reload', url }),
    notify: (action) => calls.push({ kind: 'notify', action }),
    now: () => 1000,
  })

  // A healthy response changes nothing. This is the "do not interrupt a
  // working session" requirement.
  assert.equal(watcher.observe({ status: 200, url: 'http://h/api/x' }), 'ignore')
  assert.equal(calls.length, 0, 'a healthy response is silent')

  // A 401 asks to reload once, with the token that re-mints the cookie.
  assert.equal(watcher.observe({ status: 401, url: 'http://h/api/session/list' }), 'reauthenticate')
  assert.deepEqual(calls, [{ kind: 'reload', url: 'http://127.0.0.1:3080/?token=stored-token' }], 'one reload carrying the token')
  assert.equal(watcher.observe({ status: 401, url: 'http://h/api/other' }), 'reauthenticate')
  assert.equal(calls.length, 1, 'the second 401 does not reload again')

  // A stale plugin bundle asks for a reload too, but only when the page cannot
  // simply re-fetch: it is a reinstall, and the new bytes are behind the new rev.
  const calls2 = []
  const watcher2 = createRestartWatch({
    bootRev: 'boot-rev',
    storedToken: () => 'tok',
    location: () => ({ href: 'http://127.0.0.1:3080/' }),
    reload: (url) => calls2.push(url),
    notify: () => {},
    now: () => 1000,
  })
  assert.equal(watcher2.observe({ status: 404, url: 'http://h/plugins/??discipline-whale/client.js&rev=OLD' }), 'stale-bundle')
  assert.deepEqual(calls2, ['http://127.0.0.1:3080/?token=tok'], 'a stale bundle reloads through the token URL')
  assert.equal(watcher2.observe({ status: 200, url: 'http://h/api/x' }), 'ignore')

  // A network error during the restart window is a retry: the connection layer
  // already retries it, so the watcher must not reload and kill that session.
  const calls3 = []
  const watcher3 = createRestartWatch({
    bootRev: 'r', storedToken: () => 't', location: () => ({ href: 'http://h/' }),
    reload: (url) => calls3.push(url), notify: () => {}, now: () => 1000,
  })
  assert.equal(watcher3.observe({ status: 'network', url: 'http://h/api/x' }), 'retry')
  assert.equal(calls3.length, 0, 'a dropped socket never reloads the page')

  // With no token known, a 401 reloads to the SAME origin. That is the repair,
  // not a fallback: the cookie's signing secret is stored in
  // $DSH_HOME/.credentials.yaml and survives the restart (measured — an
  // old-era cookie signed with it is accepted by the new process), so a plain
  // reload re-authenticates. This is the single most important assertion in
  // the file: it is the difference between "only a manual refresh helps" and
  // "the page refreshes itself".
  const calls4 = []
  const notices = []
  const watcher4 = createRestartWatch({
    bootRev: 'r', storedToken: () => '', location: () => ({ href: 'http://127.0.0.1:3080/session/abc' }),
    reload: (url) => calls4.push(url), notify: (a) => notices.push(a), now: () => 1000,
  })
  assert.equal(watcher4.observe({ status: 401, url: 'http://h/api/x' }), 'reauthenticate')
  assert.deepEqual(calls4, ['http://127.0.0.1:3080/session/abc'], 'the page reloads itself, keeping the route')
  assert.deepEqual(notices, [], 'no manual instruction is needed when a reload suffices')
}

// --- 6. the panel separates "log in again" from "it is broken" ----------

{
  // The measured wrong message: an auth failure rendered as
  // "打开主会话失败：the host recorded no main session". The panel must choose
  // its copy by the failure, not print whatever the fetch threw.
  const zh = DICTIONARIES.zh
  const copy = whaleFailureCopy(zh, { status: 401 })
  assert.equal(copy.kind, 'auth', 'a 401 is an auth failure, not a broken main session')
  assert.equal(copy.message, zh.authLost)
  assert.equal(copy.action, zh.authReopen)
  assert.equal(copy.hint, zh.authPasteHint, 'the hint explains what to paste')

  // A genuine "no main session" answer is NOT auth, and keeps its own copy.
  const broken = whaleFailureCopy(zh, { status: 500 })
  assert.equal(broken.kind, 'failed', 'a 500 stays an ordinary failure')
  assert.match(broken.message, /^打开主会话失败：/, 'the ordinary copy still leads with the failure')
  assert.ok(!broken.message.includes('{reason}'), 'the reason placeholder is filled, not printed')
  assert.equal(broken.action, zh.retry)
  assert.equal(broken.hint, undefined, 'no auth hint on an ordinary failure')

  // A network error is the restart window: retry, do not tell the user to log in.
  assert.equal(whaleFailureCopy(zh, { status: 'network' }).kind, 'failed', 'a dropped socket is not auth')
}

console.log('ok — a restarted page knows how to repair itself')
