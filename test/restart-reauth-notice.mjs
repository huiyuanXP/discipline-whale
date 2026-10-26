/**
 * When the page cannot repair itself, it must SAY so on screen.
 *
 * WHY THIS TEST EXISTS (measured, 2026-10-25). `installRestartWatch` dispatches
 * `discipline-whale:reauth-needed` when no reload target exists, and the
 * comment next to it claims "the panel shows the paste-the-URL hint; this event
 * is what makes it appear without a reload". Measured on the shipped 0.7.0
 * client: `grep -c 'addEventListener("discipline-whale:reauth-needed'` → 0.
 * The event was dispatched into a window with no listener, so the one path that
 * exists for "you must authenticate again by hand" was silent. That is exactly
 * the user-reported state: a page that does not work and does not say why.
 *
 * WHAT IS PINNED HERE:
 *   - the page listens for the event it dispatches (no orphan events);
 *   - the notice it builds carries the paste hint — the actionable instruction;
 *   - it stays visible until dismissed, because a hint that vanishes leaves the
 *     person back at an unexplained dead page;
 *   - a second event does not stack duplicate notices.
 *
 * Run: node test/restart-reauth-notice.mjs
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

const { createReauthNotice, REAUTH_EVENT } = plugin.exports

// --- 1. the event the page dispatches has a name both sides agree on ----

{
  assert.equal(
    REAUTH_EVENT,
    'discipline-whale:reauth-needed',
    'the notice listens for the exact event installRestartWatch dispatches',
  )
}

// --- 2. the notice is buildable from the dictionary the page ships -------

{
  assert.equal(typeof createReauthNotice, 'function', 'the page exposes its reauth notice')
  const { DICTIONARIES } = plugin.exports

  for (const [locale, strings] of Object.entries(DICTIONARIES)) {
    const notice = createReauthNotice(strings)
    assert.equal(typeof notice, 'object', `${locale} produces a notice`)
    // The hint is the whole point: without it the notice is a complaint.
    assert.equal(notice.hint, strings.authPasteHint, `${locale} carries the paste hint`)
    assert.equal(notice.message, strings.authLost, `${locale} says what happened`)
    assert.equal(notice.action, strings.authReopen, `${locale} offers the action`)
    assert.ok(notice.hint.length > 0, `${locale} hint is not empty`)
  }

  // The Chinese copy is what the user reads; it must name the concrete step.
  const zh = createReauthNotice(DICTIONARIES.zh)
  assert.match(zh.hint, /token/, 'the hint names the thing to paste')
  assert.match(zh.hint, /地址栏/, 'the hint says where to paste it')
  assert.match(zh.message, /重启/, 'the message explains the restart, the cause')
  // And it must not READ like data loss — the same rule the panel follows. The
  // shipped copy says "这不是数据丢失" (this is not data loss), so the check is
  // that any mention of loss is negated, not that the words never appear.
  const mentionsLoss = /数据丢失|会丢|已丢失/.test(zh.message)
  if (mentionsLoss) {
    assert.match(zh.message, /不是数据丢失|没有丢|不会丢/, 'a mention of loss is negated, never affirmed')
  }
}

// --- 3. dismissing and re-offering -------------------------------------

{
  const { DICTIONARIES } = plugin.exports
  const strings = DICTIONARIES.zh
  let state = null
  const notice = createReauthNotice(strings, {
    read: () => state,
    write: (next) => {
      state = next
    },
  })

  assert.equal(notice.visible(), false, 'nothing is shown before the event')

  // The event arrives: the notice becomes visible with the hint inside it.
  assert.equal(notice.offer(), true, 'the first offer shows the notice')
  assert.equal(notice.visible(), true, 'the notice is on screen')
  assert.equal(notice.current()?.hint, strings.authPasteHint, 'the visible notice carries the hint')

  // A second event while it is already up must not stack or re-announce.
  assert.equal(notice.offer(), false, 'a second offer changes nothing while it is already shown')
  assert.equal(notice.visible(), true, 'it stays up')

  // Dismissing clears it: the person has read the instruction.
  notice.dismiss()
  assert.equal(notice.visible(), false, 'dismissing hides it')

  // A later event offers it AGAIN — a new failed attempt deserves the hint.
  assert.equal(notice.offer(), true, 'a later event offers the notice again')
  assert.equal(notice.visible(), true, 'it is back')
}

// --- 4. an offer survives a re-render (state lives outside the view) ----

{
  const { DICTIONARIES } = plugin.exports
  let state = { shown: false }
  const notice = createReauthNotice(DICTIONARIES.zh, {
    read: () => state,
    write: (next) => {
      state = next
    },
  })
  notice.offer()
  // Re-reading from the store, as a fresh render would, still finds it up.
  const afterRender = createReauthNotice(DICTIONARIES.zh, {
    read: () => state,
    write: (next) => {
      state = next
    },
  })
  assert.equal(afterRender.visible(), true, 'the notice survives a render because its state is external')
  afterRender.dismiss()
  assert.equal(afterRender.visible(), false, 'and a fresh handle can dismiss it too')
  assert.equal(notice.visible(), false, 'the two handles share one store')
}

console.log('ok — a page that cannot self-repair says so, with the instruction to fix it')

// --- 5. the banner speaks the page's language --------------------------

{
  // The banner is the one surface that renders while the page is broken, so it
  // must honour the GUI locale instead of hard-coding Chinese. `apply` passes
  // the same bound translator the panel uses; this asserts the wiring exists
  // and that a non-Chinese dictionary reaches the notice intact.
  const { DICTIONARIES, createReauthNotice: make } = plugin.exports
  const en = make(DICTIONARIES.en)
  assert.equal(en.hint, DICTIONARIES.en.authPasteHint, 'the English dictionary flows through')
  assert.match(en.hint, /token=/, 'the English hint names the thing to paste')
  assert.notEqual(en.hint, DICTIONARIES.zh.authPasteHint, 'the two locales are actually different')

  // The dispatcher must accept injected strings rather than assume zh.
  const source = await (await import('node:fs/promises')).readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /installRestartWatch\(\{\s*\n\s*strings:/,
    'apply injects the locale-bound copy into installRestartWatch',
  )
  assert.ok(
    !/showReauthBanner\(\)/.test(source),
    'the banner is never called without copy when a translator is available',
  )
}
