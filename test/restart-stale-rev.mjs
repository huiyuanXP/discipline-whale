/**
 * The stale-bundle decision must compare a bundle's rev against THAT bundle's
 * rev, not against the page's single `__DSH_BOOT__.rev`.
 *
 * WHY THIS TEST EXISTS (measured, live GUI, 2026-10-25). A tab that outlives a
 * plugin reinstall keeps asking for the rev it booted with, and client-modules
 * answers 404 to every other rev. The watchdog is supposed to notice, reload
 * once, and come back on the new bytes. It never did, and the reason is a
 * wrong comparison base rather than a missing hook:
 *
 *   __DSH_BOOT__.rev                      = 216d2e17ada0   (one rev for the page)
 *   entries[discipline-whale].rev         = 1e182f53c091   (one rev per bundle)
 *
 * Measured against those two numbers, `isStaleBundleUrl` returned `true` for a
 * bundle whose rev was CURRENT — so "different from the page rev" was true for
 * every plugin, always. The predicate never distinguished stale from current,
 * which is the one thing it exists to do.
 *
 * WHAT IS PINNED HERE:
 *   - a bundle URL carrying its OWN boot rev is NOT stale (this is the case
 *     that was broken: it answered `true`);
 *   - a bundle URL carrying a different rev IS stale (the reinstall case);
 *   - a bundle the page never booted is NOT claimed stale — guessing there is
 *     what turns a single 404 into a reload loop;
 *   - the legacy single-rev form still works, so an older caller is not broken.
 *
 * Run: node test/restart-stale-rev.mjs
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

const { isStaleBundleUrl, bootBundleRevs, createRestartWatch } = plugin.exports

// The real shape, copied from a live boot payload. Only the fields the
// predicate reads are kept; the ids and revs are the measured ones.
const BOOT = {
  rev: '216d2e17ada0',
  entries: [
    { id: 'discipline-whale', rev: '1e182f53c091' },
    { id: '@deepseek-ai/dsh-api-gateway', rev: 'a36431ee6801' },
    { id: '@deepseek-ai/dsh-client-ui-chat', rev: 'be396140d6c6' },
    { id: 'no-rev-entry' },
    { rev: 'id-less' },
  ],
}

const CURRENT_DW = 'http://127.0.0.1:3080/plugins/??discipline-whale/client.js&rev=1e182f53c091'
const STALE_DW = 'http://127.0.0.1:3080/plugins/??discipline-whale/client.js&rev=e54866106cb5'

// --- 1. THE REGRESSION, stated both ways -------------------------------
//
// This section deliberately runs FIRST and builds its lookup by hand, so a red
// run fails on the DECISION the user actually suffered — "a stale bundle went
// undetected" — rather than on the shape of some helper that does not exist
// yet.

{
  // What the page knows at boot: one rev per bundle. Built literally here so
  // this assertion tests the predicate, not the reader.
  const revs = new Map([
    ['discipline-whale', '1e182f53c091'],
    ['@deepseek-ai/dsh-api-gateway', 'a36431ee6801'],
    ['@deepseek-ai/dsh-client-ui-chat', 'be396140d6c6'],
  ])

  // THE CASE THAT WAS BROKEN BOTH WAYS. With the page rev as the base, a
  // CURRENT bundle was called stale (url rev != page rev, always). With no
  // usable base at all, a STALE bundle went undetected and the tab sat broken
  // until a manual refresh. A predicate that cannot tell these two apart is
  // not doing its job, so both are asserted here.
  assert.equal(
    isStaleBundleUrl(STALE_DW, revs),
    true,
    'a different rev on the same bundle is stale — this is the reinstall the page must repair',
  )
  assert.equal(
    isStaleBundleUrl(CURRENT_DW, revs),
    false,
    'a bundle carrying its own boot rev is NOT stale — the old code answered true here',
  )

  // The old base, for contrast: the page rev names no bundle, so using it can
  // only ever say "everything is stale". Pinned as a fact about the data.
  assert.equal(isStaleBundleUrl(CURRENT_DW, BOOT.rev), true, 'the page rev as a base mislabels a current bundle')
}

// --- 2. the boot revs are read per bundle, not once per page ------------

{
  assert.equal(typeof bootBundleRevs, 'function', 'the page exposes how it reads boot revs')
  const revs = bootBundleRevs(BOOT)
  assert.equal(revs.get('discipline-whale'), '1e182f53c091', 'the bundle keeps its own rev')
  assert.equal(revs.get('@deepseek-ai/dsh-client-ui-chat'), 'be396140d6c6', 'each bundle has its own rev')
  assert.equal(revs.has('no-rev-entry'), false, 'an entry without a rev is not recorded')
  assert.equal(revs.size, 3, 'only entries carrying both id and rev are recorded')

  // The whole point: the page rev is NOT what a bundle is compared against.
  assert.notEqual(revs.get('discipline-whale'), BOOT.rev, 'the bundle rev is not the page rev')
  assert.equal(bootBundleRevs(undefined).size, 0, 'no boot payload yields no revs')
  assert.equal(bootBundleRevs({}).size, 0, 'a boot payload without entries yields no revs')
}

// --- 3. current vs stale, decided per bundle ----------------------------

{
  const revs = bootBundleRevs(BOOT)

  // A second bundle, to prove the lookup is by id and not by position.
  const chatCurrent = 'http://127.0.0.1:3080/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=be396140d6c6'
  assert.equal(isStaleBundleUrl(chatCurrent, revs), false, 'another bundle is judged by its own rev')
  const chatStale = 'http://127.0.0.1:3080/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=000000000000'
  assert.equal(isStaleBundleUrl(chatStale, revs), true, 'another stale bundle is caught too')

  // The single-bundle form client-modules uses for on-demand chunks.
  const single = 'http://127.0.0.1:3080/plugins/discipline-whale/client.js?rev=e54866106cb5'
  assert.equal(isStaleBundleUrl(single, revs), true, 'the single-bundle URL form is handled')

  // A bundle the page never booted: its rev cannot be compared to anything,
  // so it must NOT be reported stale. Guessing here is what makes one 404
  // become an endless reload.
  const unknown = 'http://127.0.0.1:3080/plugins/??some-new-plugin/client.js&rev=aaaaaaaaaaaa'
  assert.equal(isStaleBundleUrl(unknown, revs), false, 'an unbooted bundle is never claimed stale')

  // A combo naming several bundles matches on the leading id in the list.
  const combo = 'http://127.0.0.1:3080/plugins/??discipline-whale/client.js,@deepseek-ai/dsh-api-gateway/client.js&rev=e54866106cb5'
  assert.equal(isStaleBundleUrl(combo, revs), true, 'a combo URL is judged by its leading bundle')

  // Non-plugin URLs are still not bundles, whatever rev they carry.
  assert.equal(isStaleBundleUrl('/api/discipline-whale/home?rev=zzz', revs), false, 'an API route is not a bundle')
  assert.equal(isStaleBundleUrl('', revs), false, 'an empty URL is not a bundle')
  assert.equal(isStaleBundleUrl(undefined, revs), false, 'a missing URL is not a bundle')
  assert.equal(isStaleBundleUrl('http://h/plugins/??discipline-whale/client.js', revs), false, 'no rev, nothing to compare')
}

// --- 4. the legacy single-rev form still works --------------------------

{
  // An older caller passes one rev string. Keeping this working is not
  // nostalgia: it is the documented contract of the previous signature, and
  // the existing restart-recovery suite asserts it.
  const url = 'plugins/??discipline-whale/client.js&rev=6c8d60a2e141'
  assert.equal(isStaleBundleUrl(url, '57e4614df9bb'), true, 'a different rev is stale')
  assert.equal(isStaleBundleUrl(url, '6c8d60a2e141'), false, 'the same rev is not stale')
  assert.equal(isStaleBundleUrl(url, ''), false, 'without a rev nothing can be stale')
}

// --- 5. the watcher uses the per-bundle lookup end to end ---------------

{
  const revs = bootBundleRevs(BOOT)
  const reloads = []
  const watch = createRestartWatch({
    bootRevs: revs,
    storedToken: () => 'tok',
    location: () => ({ href: 'http://127.0.0.1:3080/' }),
    reload: (url) => reloads.push(url),
    notify: () => {},
  })

  // A 404 on the CURRENT bundle is the host refusing bytes it advertised: no
  // reload can fix it, so the page must stay put instead of looping.
  assert.equal(watch.observe({ status: 404, url: CURRENT_DW }), 'ignore', 'a current-bundle 404 is not a reload trigger')
  assert.deepEqual(reloads, [], 'nothing reloaded for a current bundle')

  // The genuine reinstall: one reload, carrying the token so the cookie can
  // be re-minted on the way back.
  assert.equal(watch.observe({ status: 404, url: STALE_DW }), 'stale-bundle', 'a stale bundle reloads')
  assert.deepEqual(reloads, ['http://127.0.0.1:3080/?token=tok'], 'exactly one reload, with the token')
  assert.equal(watch.observe({ status: 404, url: STALE_DW }), 'stale-bundle', 'the classification is still reported')
  assert.equal(reloads.length, 1, 'the latch holds: no second reload')
}

console.log('ok — the stale-bundle decision compares each bundle against its own rev')
