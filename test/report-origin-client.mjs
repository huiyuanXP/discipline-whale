/**
 * Browser-half tests for workspace-colored report rows: a pushed Worker
 * report is painted with the color of the workspace that wrote it and carries
 * a source tag, and both degrade to neutral when the origin is unknown.
 *
 * Same harness as test/client-memory.mjs, plus a minimal DOM stand-in for the
 * rows `decorateReportRows` walks. Checked:
 *
 *   1. `reportOriginOf` reads a hit and refuses a miss or a bad color
 *   2. `reportIdOfText` reads the id from the pushed shape only
 *   3. the origin store asks once per id, caches a hit, re-asks nothing
 *   4. a hit paints the row variable and tags the workspace name
 *   5. a miss paints nothing and tags "unknown"
 *   6. a row without a report id is never claimed
 *   7. the stylesheet tints through theme variables, with no literal hex
 *
 * Run: node test/report-origin-client.mjs
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
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const client = definition.factory((id) => {
  assert.equal(id, 'react')
  return React
})
delete globalThis.window

const pass = (name) => console.log(`pass  ${name}`)
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const REPORT_ID = 'r-6dc7b86f-79c1-41d8-8e4e-b65577a59f0b'
const REPORT_ROW = [
  '[Discipline Whale] Worker report — soc-api-test (done)',
  '',
  'hello — 工作目录 /Users/huiyuan/Developer/projects/soc-api-test。',
  '',
  `report id: ${REPORT_ID}`,
  'Call read_report with that id for the full document.',
].join('\n')
const CHAT_ROW = '你帮我看一下这个配色方案，然后 report id 那种东西先别管'

const t = (key, vars = {}) => {
  const text = client.DICTIONARIES.en[key]
  assert.equal(typeof text, 'string', `missing dictionary key ${key}`)
  return text.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name]))
}

/**
 * The attributes and custom properties `decorateReportRows` writes, on one
 * stand-in row. Only the surface the decorator actually touches is modelled.
 */
function rowOf(textContent, { kind = 'user', claimed = false, turn } = {}) {
  const attributes = new Map()
  const properties = new Map()
  if (claimed) attributes.set('data-dw-report-origin', '')
  if (turn !== undefined) attributes.set('data-chat-turn', String(turn))
  return {
    textContent,
    attributes,
    properties,
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    style: { setProperty: (name, value) => properties.set(name, value) },
    kind,
  }
}

/** A scope whose `querySelectorAll` returns the rows, honouring the :not(). */
function scopeOf(rows) {
  return {
    querySelectorAll(selector) {
      assert.match(selector, /data-chat-flow-kind="user"/)
      return rows.filter((row) => row.kind === 'user' && !row.attributes.has('data-dw-report-origin'))
    },
  }
}

/** A scope for turn-tag rows: user rows not yet claimed by that pass. */
function scopeOfTurn(rows) {
  return {
    querySelectorAll(selector) {
      assert.match(selector, /data-dw-turn-ws/)
      return rows.filter((row) => row.kind === 'user' && !row.attributes.has('data-dw-turn-ws'))
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

try {
  // 1. reportOriginOf resolves a hit and refuses a miss or a bad color
  {
    const hit = client.reportOriginOf({ report: { id: 'r-1', workspaceId: 'ws-api', workspaceTitle: 'API', color: '#F59E0B' } })
    assert.deepEqual(hit, { workspaceId: 'ws-api', title: 'API', color: '#F59E0B' })
    // A missing title falls back to the id.
    assert.equal(client.reportOriginOf({ report: { workspaceId: 'ws-api', color: '#F59E0B' } }).title, 'ws-api')
    assert.equal(client.reportOriginOf({ report: null }), null)
    assert.equal(client.reportOriginOf({}), null)
    assert.equal(client.reportOriginOf(undefined), null)
    assert.equal(client.reportOriginOf({ report: { workspaceId: 'ws-x', color: 'not-a-color' } }), null)
    pass('reportOriginOf resolves a hit and refuses a miss')
  }

  // 2. reportIdOfText reads the pushed shape only
  {
    assert.equal(client.reportIdOfText(REPORT_ROW), REPORT_ID)
    assert.equal(client.reportIdOfText(`  report id:   ${REPORT_ID}  `), REPORT_ID)
    assert.equal(client.reportIdOfText(CHAT_ROW), null)
    assert.equal(client.reportIdOfText(''), null)
    assert.equal(client.reportIdOfText(undefined), null)
    pass('reportIdOfText reads the pushed shape')
  }

  // 3. the origin store asks once per id and caches the hit
  {
    const asked = []
    const store = client.createReportOriginStore({
      fetch: async (url) => {
        asked.push(url)
        return json(200, { report: { id: 'r-1', workspaceId: 'ws-api', workspaceTitle: 'API', color: '#F59E0B' } })
      },
    })
    const first = await store.resolve('r-1')
    const second = await store.resolve('r-1')
    assert.deepEqual(first, { workspaceId: 'ws-api', title: 'API', color: '#F59E0B' })
    assert.deepEqual(second, first)
    assert.equal(asked.length, 1)
    assert.match(asked[0], /\/api\/discipline-whale\/memory\/reports\?id=r-1/)
    // A miss is not cached as a hit; an empty id never asks.
    assert.equal(await client.createReportOriginStore({ fetch: async () => json(200, { report: null }) }).resolve('r-9'), null)
    assert.equal(await store.resolve(''), null)
    pass('the origin store asks once per id')
  }

  // 4. a hit paints the row variable and tags the workspace
  {
    const row = rowOf(REPORT_ROW)
    const store = { resolve: async () => ({ workspaceId: 'ws-api', title: 'API', color: '#F59E0B' }) }
    assert.equal(client.decorateReportRows(scopeOf([row]), { t, store }), 1)
    await flush()
    assert.equal(row.getAttribute('data-dw-report-origin'), '')
    assert.equal(row.properties.get('--dw-msg-ws'), '#F59E0B')
    assert.ok(String(row.getAttribute('data-dw-ws-tag')).includes('API'))
    assert.equal(row.getAttribute('data-dw-ws-unknown'), null)
    pass('a hit paints the row and tags the workspace')
  }

  // 5. a miss is neutral and labelled unknown, without throwing
  {
    const row = rowOf(REPORT_ROW)
    client.decorateReportRows(scopeOf([row]), { t, store: { resolve: async () => null } })
    await flush()
    assert.equal(row.getAttribute('data-dw-ws-unknown'), '')
    assert.equal(row.properties.has('--dw-msg-ws'), false, 'an unknown origin must not paint')
    assert.equal(row.getAttribute('data-dw-ws-tag'), t('reportOriginUnknown'))
    pass('a miss is neutral and labelled unknown')
  }

  // 6. a row without a report id is never claimed
  {
    const chat = rowOf(CHAT_ROW)
    const report = rowOf(REPORT_ROW)
    const claimed = client.decorateReportRows(scopeOf([chat, report]), { t, store: { resolve: async () => null } })
    await flush()
    assert.equal(claimed, 1)
    assert.equal(chat.getAttribute('data-dw-report-origin'), null)
    assert.equal(report.getAttribute('data-dw-report-origin'), '')
    // A second pass re-claims nothing: the marker is the claim.
    assert.equal(client.decorateReportRows(scopeOf([chat, report]), { t, store: { resolve: async () => null } }), 0)
    pass('a non-report row is never claimed, and a claim sticks')
  }

  // 8. a tagged user turn paints and tags on the row that caused it
  {
    const snapshotOf = (tags) => ({ mainSessionId: 'main-1', tags, dispatched: {}, workspaces: [
      { id: 'ws-api', title: 'API', path: '/p/api', color: '#F59E0B' },
      { id: 'ws-blog', title: '博客', path: '/p/blog', color: '#3B82F6' },
    ] })
    const asked = []
    const store = {
      getSnapshot: () => snapshotOf({ 'main-1': {
        3: { turn: 3, workspaces: ['ws-blog'], sessions: {} },
        5: { turn: 5, workspaces: ['ws-api', 'ws-blog'], sessions: {} },
      } }),
      subscribe: () => {},
      loadMain: () => Promise.resolve('main-1'),
      requestTags: (sessionId, turn) => asked.push([sessionId, turn]),
    }
    const tagged = rowOf('帮我看一下配色', { turn: 5 })
    const plain = rowOf('你自己发的普通消息', { turn: 4 })
    const claimed = client.decorateTurnTags(scopeOfTurn([tagged, plain]), { t, store })
    assert.equal(claimed, 1)
    // The first named workspace paints the row...
    assert.equal(tagged.properties.get('--dw-msg-ws'), '#F59E0B')
    // ...and every one is named, because the row caused all of them.
    const label = String(tagged.getAttribute('data-dw-ws-tag'))
    assert.ok(label.includes('API') && label.includes('博客'), `tag should name both, got ${label}`)
    // A user row whose turn dispatched nowhere keeps the Host's background.
    assert.equal(plain.getAttribute('data-dw-turn-ws'), null)
    // The pass asks the store for the main session and for the turns it saw,
    // so a row that mounts before its tags land still gets painted later.
    assert.ok(asked.length > 0, 'the pass should request the tags of the turns it saw')
    assert.ok(asked.every(([sessionId]) => sessionId === 'main-1'))
    pass('a tagged user turn paints and tags')
  }

  // 7. the stylesheet tints through theme variables and writes no hex
  {
    const css = client.reportRowStyles()
    assert.equal(typeof css, 'string')
    assert.match(css, /--dw-msg-ws/)
    assert.match(css, /attr\(data-dw-ws-tag\)/)
    assert.match(css, /color-mix\(in srgb/)
    assert.match(css, /--dsw-specific-bubble|--dsw-alias-bg-base/)
    assert.doesNotMatch(css, /#[0-9a-fA-F]{6}/, 'the stylesheet must not hardcode a color')
    pass('the paint rides theme variables')
  }

  console.log('report-origin-client: all checks passed')
} catch (error) {
  console.error('FAIL', error)
  process.exitCode = 1
}
