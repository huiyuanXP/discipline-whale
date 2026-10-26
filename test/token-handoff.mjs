/**
 * A 401 page must be able to learn the URL that would authenticate it.
 *
 * WHY THIS TEST EXISTS (measured, live GUI 127.0.0.1:3080, 2026-10-25):
 *
 *   GET /  (no cookie) → 401, content-type: text/plain, 68-byte body,
 *                        0 <script> tags
 *
 * No document means no plugin bundle means `installRestartWatch` never runs, so
 * the client-side repair chain cannot help the exact case the user hits. And
 * refreshing cannot help either: measured three refreshes in a row, 401 each
 * time, because only a `?token=` URL mints the cookie.
 *
 * The cookie itself survives a restart (signing secret in
 * `$DSH_HOME/.credentials.yaml`), so the failing case is "this browser has no
 * usable cookie" — new browser, cleared jar, an expired 30-day cookie, or the
 * other host spelling (`localhost:3080` vs `127.0.0.1:3080` are DIFFERENT cookie
 * names, measured). This module gives that browser one unauthenticated place to
 * ask, and one stable file for a person to read.
 *
 * WHAT IS PINNED HERE, and why each is a fact rather than taste:
 *   - the handoff route answers WITHOUT a cookie (that is its entire job) and is
 *     `no-store` (the token changes every restart, so a cached answer is a stale
 *     credential);
 *   - only a loopback authority is given a token; a non-loopback caller gets 403
 *     and a null URL, because `dsh web` itself refuses to bind an unspecified
 *     address and this route must not widen that;
 *   - POST is refused, so nothing can use this route as a write path;
 *   - a failed disk write does not lose the in-memory URL — the route keeps
 *     working on a read-only home;
 *   - the file is 0600, because it holds a live credential.
 *
 * Run: node test/token-handoff.mjs
 */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TOKEN_HANDOFF_ROUTE,
  handoffBody,
  isLoopbackAuthority,
  publishTokenHandoff,
  registerTokenHandoffRoute,
  tokenHandoffFile,
} from '../token-handoff.js'

// --- 1. the loopback fence ------------------------------------------------

{
  // Every spelling the server can legitimately see for a local caller.
  for (const authority of ['127.0.0.1:3080', 'localhost:3080', '127.1.2.3:8080', '[::1]:3080', '::1']) {
    assert.equal(isLoopbackAuthority(authority), true, `${authority} is loopback`)
  }
  // Everything else is refused: this route speaks the launch token.
  for (const authority of ['203.0.113.9:3080', '198.51.100.4:3080', 'example.com', '0.0.0.0:3080', '', undefined, 'not a host']) {
    assert.equal(isLoopbackAuthority(authority), false, `${String(authority)} is not loopback`)
  }
}

// --- 2. the published body ------------------------------------------------

{
  const ok = handoffBody({ url: 'http://127.0.0.1:3080/?token=abc', origin: 'http://127.0.0.1:3080' })
  assert.equal(ok.url, 'http://127.0.0.1:3080/?token=abc')
  assert.equal(ok.reason, 'ok')
  assert.match(ok.hint, /address bar/i, 'the hint names the concrete step')

  // No URL is reported as null with a reason, never as "" — an empty string is
  // what a client would happily navigate to.
  const none = handoffBody({ url: '', origin: 'http://127.0.0.1:3080', reason: 'no-launch-token' })
  assert.equal(none.url, null, 'a missing URL is null, not empty')
  assert.equal(none.reason, 'no-launch-token')
  assert.equal(handoffBody({ url: null, origin: '', reason: 'non-loopback' }).reason, 'non-loopback')
  // Unspecified reason still yields a usable body.
  assert.equal(handoffBody({ url: null, origin: '' }).reason, 'unavailable')
}

// --- 3. the file is written 0600 and holds exactly the URL ----------------

{
  const home = await mkdtemp(join(tmpdir(), 'dw-handoff-'))
  const url = 'http://127.0.0.1:3080/?token=MEASUREDTOKEN'
  const result = await publishTokenHandoff({ dshHome: home, url })

  assert.equal(result.written, true, 'the URL is published')
  assert.equal(result.path, tokenHandoffFile(home), 'the public path helper names the file it wrote')

  const onDisk = (await readFile(result.path, 'utf8')).trim()
  assert.equal(onDisk, url, 'the file holds exactly the launch URL')

  const mode = (await stat(result.path)).mode & 0o777
  assert.equal(mode, 0o600, 'the credential file is owner-only')

  // Publishing again replaces rather than appends: a restart must not leave a
  // file with two tokens in it, where a reader could take the dead one.
  const second = 'http://127.0.0.1:3080/?token=SECOND'
  await publishTokenHandoff({ dshHome: home, url: second })
  const replaced = (await readFile(result.path, 'utf8')).trim()
  assert.equal(replaced, second, 'a republish replaces the old URL')
  assert.equal(replaced.split('\n').length, 1, 'exactly one line, never a history')
}

// --- 4. a read-only home must not lose the URL ---------------------------

{
  const home = await mkdtemp(join(tmpdir(), 'dw-handoff-ro-'))
  // Make the logs parent unwritable so the write fails for a real reason.
  await chmod(home, 0o500)
  const warned = []
  const url = 'http://127.0.0.1:3080/?token=RO'
  const result = await publishTokenHandoff({ dshHome: home, url, logger: { warn: (m) => warned.push(m) } })
  assert.equal(result.written, false, 'the write reports failure instead of throwing')
  assert.equal(result.inMemory, url, 'the in-memory URL survives, so the route still works')
  assert.equal(warned.length, 1, 'the failure is logged, not swallowed')
  await chmod(home, 0o700)
}

// --- 5. the route: no cookie needed, no-store, GET only -----------------

{
  // A minimal web-server stand-in: capture the registered route and drive it.
  let route
  const webServer = {
    register: (next) => {
      route = next
      return () => {
        route = undefined
      }
    },
  }
  const dispose = registerTokenHandoffRoute(webServer, { url: () => 'http://127.0.0.1:3080/?token=LIVE' })
  assert.equal(route.path, TOKEN_HANDOFF_ROUTE, 'the route is the documented path')
  assert.equal(route.kind, 'exact', 'an exact path, not a prefix')
  assert.equal(TOKEN_HANDOFF_ROUTE, '/api/discipline-whale/auth-handoff')

  const call = (headers, method = 'GET') => {
    let status
    let body = ''
    let sentHeaders = {}
    const res = {
      writeHead: (code, next) => {
        status = code
        sentHeaders = next ?? {}
      },
      end: (chunk) => {
        body = chunk ?? ''
      },
    }
    route.handler({ method, headers }, res)
    return { status, body, headers: sentHeaders, json: (() => { try { return JSON.parse(body) } catch { return null } })() }
  }

  // THE POINT OF THE ROUTE: it answers with no cookie at all.
  const loopback = call({ host: '127.0.0.1:3080' })
  assert.equal(loopback.status, 200, 'a loopback caller gets an answer without any cookie')
  assert.equal(loopback.json.url, 'http://127.0.0.1:3080/?token=LIVE', 'it answers with this process launch URL')
  assert.equal(loopback.json.reason, 'ok')
  assert.equal(loopback.headers['cache-control'], 'no-store', 'a cached token would be a stale credential')

  // A non-loopback caller is refused, and given no URL.
  const remote = call({ host: '203.0.113.9:3080' })
  assert.equal(remote.status, 403, 'a non-loopback caller is refused')
  assert.equal(remote.json.url, null, 'and is handed no token')
  assert.equal(remote.json.reason, 'non-loopback')

  // No write path.
  const post = call({ host: '127.0.0.1:3080' }, 'POST')
  assert.equal(post.status, 405, 'the route is read-only')
  assert.equal(post.headers.allow, 'GET')

  // A host that has no token answers honestly instead of sending the browser
  // to a URL that cannot work.
  dispose()
  registerTokenHandoffRoute(webServer, { url: () => '' })
  const empty = call({ host: '127.0.0.1:3080' })
  assert.equal(empty.status, 200)
  assert.equal(empty.json.url, null, 'no launch token yields a null URL')
  assert.equal(empty.json.reason, 'no-launch-token')
}

console.log('ok — a 401 page can find the URL that authenticates it, without a cookie')

// --- 6. the module is actually shipped --------------------------------

{
  // A module the package does not publish cannot fix anything: the exact bug
  // class this file guards against is a new source file that never reaches the
  // tarball, which fails only at install time on the user's machine.
  const { readFile } = await import('node:fs/promises')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(files.includes('token-handoff.js'), 'token-handoff.js is published in the package')

  // Every module `home.js` imports must be published too, or the plugin fails
  // to load at all. This is a cheap structural check, not a bundler.
  const homeSource = await readFile(new URL('../home.js', import.meta.url), 'utf8')
  const localImports = [...homeSource.matchAll(/^import .* from '\.\/([^']+)'/gm)].map((m) => m[1])
  assert.ok(localImports.length > 10, 'home.js imports its local modules')
  const shipped = new Set(files)
  const missing = localImports.filter((name) => !shipped.has(name))
  assert.deepEqual(missing, [], 'every module home.js imports is listed in files[]')
}

console.log('ok — and the module that does it is actually shipped')
