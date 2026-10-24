/**
 * Browser-half tests for the memory UI: workspace chips under main-session
 * turns, the sidebar workspace dot, and the workspace-color settings.
 *
 * Same harness as test/client.mjs: `client.js` gets the module-loader global,
 * a React stand-in whose `useSyncExternalStore` reads the store's snapshot,
 * and the store gets a scripted `fetch` and a manual timer queue. Checked:
 *
 *   1. chips render for 0 / 1 / 2 workspaces, with titles and colors
 *   2. chips render only inside the whale's main session
 *   3. a chip belongs to the turn whose number matches the tags record, a
 *      running turn shows none, and a click opens that turn's session
 *   4. tags are requested once per batch of mounted tails and again only for
 *      a newer closed turn
 *   5. a color change repaints chips and dots at once and POSTs route 2
 *   6. a refused color (HTTP 400) shows the server's text inline and puts the
 *      stored color back
 *   7. the sidebar dot is present for a dispatched session and absent otherwise
 *   8. the settings section lists every workspace with the activity.js
 *      palette and a custom color input
 *   9. chip text contrast, the main session hand-off, and the dictionaries
 *
 * Run: node test/client-memory.mjs
 */

import assert from 'node:assert/strict'

import { PALETTE } from '../activity.js'

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

// --- helpers --------------------------------------------------------------

/** The English dictionary with `{name}` interpolation, failing on a missing key. */
const t = (key, vars = {}) => {
  const text = client.DICTIONARIES.en[key]
  assert.equal(typeof text, 'string', `missing dictionary key ${key}`)
  return text.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name]))
}

const nodesOf = (tree) => {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    found.push(node)
    visit(node.children)
  }
  visit(tree)
  return found
}

const textsOf = (tree) => {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { found.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(visit); return }
    visit(node.children)
  }
  visit(tree)
  return found
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const MAIN = 'main-1'
const WORKSPACES = [
  { id: 'ws-blog', title: '博客', path: '/p/blog', color: '#6E7E91', intro: '', updatedAt: '2026-10-21T00:00:00Z' },
  { id: 'ws-api', title: 'API', path: '/p/api', color: '#748162', intro: '', updatedAt: '2026-10-21T00:00:00Z' },
]
const TURNS = [
  { turn: 3, messageId: 'm-3', at: '2026-10-21T10:00:00Z', workspaces: ['ws-blog'], sessions: { 'ws-blog': ['w-blog-1'] } },
  { turn: 5, messageId: 'm-5', at: '2026-10-21T11:00:00Z', workspaces: ['ws-blog', 'ws-api'], sessions: { 'ws-blog': ['w-blog-1', 'w-blog-2'], 'ws-api': ['w-api-1'] } },
  { turn: 6, messageId: 'm-6', at: '2026-10-21T12:00:00Z', workspaces: [], sessions: {} },
]
const DISPATCHED = { 'w-blog-1': 'ws-blog', 'w-blog-2': 'ws-blog', 'w-api-1': 'ws-api' }

/**
 * A memory store over a scripted server. The server keeps its own workspace
 * colors and refuses any color outside `#RRGGBB` and any unknown id with 400.
 */
function harness() {
  const calls = []
  const timers = []
  const server = { workspaces: WORKSPACES.map((workspace) => ({ ...workspace })), turns: TURNS }
  let clock = 0
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: init.body === undefined ? undefined : JSON.parse(init.body), cache: init.cache })
    if (url === '/api/discipline-whale/home') return json(200, { home: '/h', mainSessionId: MAIN })
    if (url === '/api/discipline-whale/memory/workspaces' && method === 'GET') return json(200, { workspaces: server.workspaces })
    if (url === '/api/discipline-whale/memory/workspaces' && method === 'POST') {
      const { id, color } = JSON.parse(init.body)
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) return json(400, { error: `invalid color: ${color}` })
      const workspace = server.workspaces.find((candidate) => candidate.id === id)
      if (workspace === undefined) return json(400, { error: `unknown workspace: ${id}` })
      workspace.color = color
      return json(200, { workspace: { ...workspace } })
    }
    if (url.startsWith('/api/discipline-whale/memory/tags?')) {
      const sessionId = new URL(url, 'http://dsh').searchParams.get('sessionId')
      return json(200, { turns: sessionId === MAIN ? server.turns : [] })
    }
    if (url === '/api/discipline-whale/memory/dispatched') return json(200, { sessions: DISPATCHED })
    return json(404, { error: 'not found' })
  }
  const store = client.createMemoryStore({
    fetch,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {} },
    now: () => clock,
  })
  /** Run every queued timer, then let the fetch chains settle. */
  const flush = async () => {
    for (let round = 0; round < 5; round += 1) {
      while (timers.some((timer) => !timer.done)) {
        const timer = timers.find((candidate) => !candidate.done)
        timer.done = true
        timer.fn()
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return { store, calls, server, flush, tick: (ms) => { clock += ms } }
}

/** A store with the main session, the workspaces, the tags and the dispatched map loaded. */
async function loadedHarness() {
  const h = harness()
  await h.store.loadMain()
  await h.store.loadWorkspaces(false)
  h.store.requestTags(MAIN, 6)
  await h.flush()
  return h
}

const closedTurn = (turn) => ({ turn, status: 'closed', start: undefined, end: undefined, steps: [] })

// --- 1. chips for 0 / 1 / 2 workspaces ------------------------------------

{
  const { store } = await loadedHarness()
  const opened = []
  const Tags = client.makeTurnTags(store, t)
  const render = (turn) => Tags({ turn: closedTurn(turn), seq: 1, openFile: () => {}, sessionId: MAIN, openSession: (id) => opened.push(id) })

  assert.equal(render(6), null, 'a tags record with no workspace renders nothing')
  assert.equal(render(4), null, 'a turn without a tags record renders nothing')

  const one = render(3)
  const oneChips = nodesOf(one).filter((node) => node.props?.className === 'dw-tag')
  assert.equal(oneChips.length, 1)
  assert.deepEqual(textsOf(oneChips[0]), ['博客'])
  assert.equal(oneChips[0].props.style['--dw-tag'], '#6E7E91', 'the chip is painted in the workspace color')

  const two = render(5)
  assert.equal(two.props.className, 'dw-tags')
  assert.equal(two.props['data-dw-turn'], 5)
  const twoChips = nodesOf(two).filter((node) => node.props?.className === 'dw-tag')
  assert.deepEqual(twoChips.map((chip) => textsOf(chip)[0]), ['博客', 'API'], 'two workspaces give two chips side by side, in record order')
  assert.deepEqual(twoChips.map((chip) => chip.props.style['--dw-tag']), ['#6E7E91', '#748162'])
  console.log('ok 1 — chips render for 0 / 1 / 2 workspaces with their titles and colors')
}

// --- 2. only inside the main session --------------------------------------

{
  const fresh = harness()
  const Tags = client.makeTurnTags(fresh.store, t)
  const props = (sessionId) => ({ turn: closedTurn(5), seq: 1, openFile: () => {}, sessionId, openSession: () => {} })
  assert.equal(Tags(props(MAIN)), null, 'before the main session is known, nothing renders')

  const { store } = await loadedHarness()
  const Loaded = client.makeTurnTags(store, t)
  assert.notEqual(Loaded({ ...props(MAIN) }), null, 'the main session shows its chips')
  assert.equal(Loaded({ ...props('w-blog-1') }), null, 'a worker session with the same turn number shows none')
  assert.equal(Loaded({ ...props('someone-else') }), null, 'an unrelated session shows none')
  console.log('ok 2 — chips render only inside the whale main session')
}

// --- 3. turn matching and the click ---------------------------------------

{
  const { store } = await loadedHarness()
  const opened = []
  const Tags = client.makeTurnTags(store, t)
  const tree = Tags({ turn: closedTurn(5), seq: 9, openFile: () => {}, sessionId: MAIN, openSession: (id) => opened.push(id) })
  const [blog, api] = nodesOf(tree).filter((node) => node.props?.className === 'dw-tag')
  assert.equal(blog.props['data-dw-session'], 'w-blog-2', 'the chip targets the latest session this turn sent to the workspace')
  blog.props.onClick()
  api.props.onClick()
  assert.deepEqual(opened, ['w-blog-2', 'w-api-1'], 'clicking a chip opens that workspace session')
  assert.equal(blog.props['aria-label'], 'Open the 博客 session')

  const running = Tags({ turn: { ...closedTurn(5), status: 'open' }, seq: 9, openFile: () => {}, sessionId: MAIN, openSession: () => {} })
  assert.equal(running, null, 'a turn still running shows no chips')
  const unknownStatus = Tags({ turn: { ...closedTurn(3), status: 'unknown' }, seq: 9, openFile: () => {}, sessionId: MAIN, openSession: () => {} })
  assert.notEqual(unknownStatus, null, 'a turn whose boundary is outside the window still shows its chips')

  // A tag whose turn named no session renders a disabled chip.
  const snapshot = { ...store.getSnapshot(), tags: { [MAIN]: { 9: { turn: 9, workspaces: ['ws-api'], sessions: {} } } } }
  const orphan = client.turnTagsView({ t, snapshot, sessionId: MAIN, turn: closedTurn(9), onOpen: () => assert.fail('no session to open') })
  const orphanChip = nodesOf(orphan).find((node) => node.props?.className === 'dw-tag')
  assert.equal(orphanChip.props.disabled, true)
  assert.equal(orphanChip.props.onClick, undefined)
  console.log('ok 3 — chips match by DSH turn number, skip running turns, and open the dispatched session')
}

// --- 4. when tags are requested -------------------------------------------

{
  const h = harness()
  await h.store.loadMain()
  const tagCalls = () => h.calls.filter((call) => call.url.startsWith('/api/discipline-whale/memory/tags?')).length
  // A page load mounts every closed turn's tail at once: one request.
  for (const turn of [1, 2, 3, 4, 5, 6]) h.store.requestTags(MAIN, turn)
  await h.flush()
  assert.equal(tagCalls(), 1, 'the tails of one page load share one tags request')
  assert.equal(h.calls.find((call) => call.url.startsWith('/api/discipline-whale/memory/tags?')).url, `/api/discipline-whale/memory/tags?sessionId=${MAIN}`)
  // Scrolling back over older turns asks for nothing new.
  h.store.requestTags(MAIN, 2)
  await h.flush()
  assert.equal(tagCalls(), 1, 'an older turn is already covered')
  // The next turn completes: its tail reports a newer closed turn.
  h.store.requestTags(MAIN, 7)
  await h.flush()
  assert.equal(tagCalls(), 2, 'a newly completed turn refetches the tags')
  assert.ok(h.calls.every((call) => call.cache === 'no-store'), 'every memory request bypasses the cache')
  // A tagged turn means dispatched sessions: the map is refreshed with it.
  assert.ok(h.calls.some((call) => call.url === '/api/discipline-whale/memory/dispatched'))
  console.log('ok 4 — tags load once per batch of mounted tails and again when a newer turn completes')
}

// --- 5. a color change repaints chips and folder rows at once --------------

{
  const h = await loadedHarness()
  const Tags = client.makeTurnTags(h.store, t)
  const chipColor = () => nodesOf(Tags({ turn: closedTurn(3), seq: 1, openFile: () => {}, sessionId: MAIN, openSession: () => {} }))
    .find((node) => node.props?.className === 'dw-tag').props.style['--dw-tag']
  // The folder row's paint is what replaced the dot: same color, same store.
  const folderColor = () => client.folderPaint(
    h.store.getSnapshot().workspaces.find((workspace) => workspace.id === 'ws-blog'),
  )['--dw-ws-folder']
  assert.equal(chipColor(), '#6E7E91')
  assert.equal(folderColor(), '#6E7E91')

  let notified = 0
  h.store.subscribe(() => { notified += 1 })
  const posted = h.store.setColor('ws-blog', '#112233', 0)
  // Before the POST has even gone out, both surfaces show the new color.
  assert.equal(chipColor(), '#112233', 'the chip repaints at once')
  assert.equal(folderColor(), '#112233', 'the folder row repaints at once')
  assert.ok(notified > 0, 'subscribers are told')
  await h.flush()
  assert.deepEqual(await posted, { ok: true })
  const post = h.calls.find((call) => call.method === 'POST')
  assert.equal(post.url, '/api/discipline-whale/memory/workspaces')
  assert.deepEqual(post.body, { id: 'ws-blog', color: '#112233' })
  assert.equal(h.server.workspaces[0].color, '#112233')
  assert.equal(chipColor(), '#112233', 'the confirmed color stays')

  // The custom input fires while dragging: only the resting color is posted.
  h.store.setColor('ws-api', '#000001', 250)
  h.store.setColor('ws-api', '#000002', 250)
  const last = h.store.setColor('ws-api', '#000003', 250)
  await h.flush()
  assert.deepEqual(await last, { ok: true })
  const apiPosts = h.calls.filter((call) => call.method === 'POST' && call.body.id === 'ws-api')
  assert.deepEqual(apiPosts.map((call) => call.body.color), ['#000003'], 'a dragged picker posts once')
  console.log('ok 5 — a color change repaints chips and dots immediately and POSTs the route')
}

// --- 5b. a late answer to an earlier POST changes nothing -----------------

{
  // Two quick palette clicks: both POSTs are in flight, the first answers last.
  const held = []
  const store = client.createMemoryStore({
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') {
        const { id, color } = JSON.parse(init.body)
        return new Promise((resolve) => held.push(() => resolve(json(200, { workspace: { ...WORKSPACES[0], id, color } }))))
      }
      return json(200, { workspaces: WORKSPACES })
    },
    setTimeout: (fn) => { fn(); return 0 },
    clearTimeout: () => {},
  })
  await store.loadWorkspaces(false)
  const first = store.setColor('ws-blog', '#111111', 0)
  const second = store.setColor('ws-blog', '#222222', 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(held.length, 2, 'both POSTs went out')
  held[1]()
  await second
  held[0]()
  await first
  assert.equal(store.getSnapshot().workspaces[0].color, '#222222', 'the newest color stays after the older answer lands')
  console.log('ok 5b — an older POST answering late cannot repaint over a newer color')
}

// --- 6. a refused color shows the server's text ----------------------------

{
  const h = await loadedHarness()
  const result = h.store.setColor('ws-api', '#zzzzzz', 0)
  await h.flush()
  assert.deepEqual(await result, { ok: false, error: 'invalid color: #zzzzzz' })
  assert.equal(h.store.getSnapshot().colorErrors['ws-api'], 'invalid color: #zzzzzz')

  const section = client.workspaceColorsSection({
    t,
    workspaces: { list: h.store.getSnapshot().workspaces, failed: false, errors: h.store.getSnapshot().colorErrors },
    choose: () => {},
  })
  const apiRow = nodesOf(section).find((node) => node.props?.['data-dw-workspace'] === 'ws-api')
  const alert = nodesOf(apiRow).find((node) => node.props?.role === 'alert')
  assert.ok(alert, 'the refused workspace shows an inline error')
  assert.deepEqual(textsOf(alert), ['Could not change the color: invalid color: #zzzzzz'])
  const blogRow = nodesOf(section).find((node) => node.props?.['data-dw-workspace'] === 'ws-blog')
  assert.equal(nodesOf(blogRow).some((node) => node.props?.role === 'alert'), false, 'other workspaces stay clean')

  // A well-formed color the server refuses was painted at once; it is put back.
  h.server.workspaces = h.server.workspaces.filter((workspace) => workspace.id !== 'ws-api')
  const refused = h.store.setColor('ws-api', '#123456', 0)
  assert.equal(h.store.getSnapshot().workspaces.find((workspace) => workspace.id === 'ws-api').color, '#123456')
  assert.equal(h.store.getSnapshot().colorErrors['ws-api'], undefined, 'a new attempt clears the old error')
  await h.flush()
  assert.equal((await refused).ok, false)
  assert.equal(h.store.getSnapshot().workspaces.find((workspace) => workspace.id === 'ws-api').color, '#748162', 'the stored color comes back')
  assert.equal(h.store.getSnapshot().colorErrors['ws-api'], 'unknown workspace: ws-api')
  console.log('ok 6 — a 400 shows the server text inline under that workspace and restores the stored color')
}

// --- 7. the sidebar rows the whale paints ---------------------------------
//
// The old dot is gone from the leading seat; what remains is the folder row's
// own color and the logo on a dispatched session. Both are DOM paints, so the
// rows here are stand-in elements carrying the Host's own markers.

/** A stand-in sidebar row: the attributes and style the paint touches. */
function rowOf(rowKey) {
  const attributes = new Map([['data-row-key', rowKey]])
  const properties = new Map()
  return {
    attributes,
    properties,
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    querySelector: () => null,
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
    },
  }
}

/** A scope whose querySelectorAll splits rows by the marker prefix. */
function sidebarScopeOf(rows) {
  return {
    querySelectorAll(selector) {
      if (selector.startsWith('[data-row-key^="workspace:"]')) return rows.filter((row) => row.getAttribute('data-row-key').startsWith('workspace:'))
      if (selector.startsWith('[data-row-key^="session:"]')) return rows.filter((row) => row.getAttribute('data-row-key').startsWith('session:'))
      return []
    },
  }
}

{
  const h = await loadedHarness()
  const folder = rowOf('workspace:ws-api')
  const whaleRow = rowOf('session:w-api-1')
  const userRow = rowOf('session:user-opened')
  assert.equal(client.decorateSidebarRows(sidebarScopeOf([folder, whaleRow, userRow]), { store: h.store }), 2, 'one folder row and one dispatched session')

  assert.equal(folder.getAttribute('data-dw-ws-folder'), '#748162', 'the folder row carries its workspace color')
  assert.equal(folder.properties.get('--dw-ws-folder'), '#748162')
  assert.equal(folder.getAttribute('title'), 'API')

  assert.equal(whaleRow.getAttribute('data-dw-whale'), '#748162', 'a dispatched session is marked with its workspace color')
  assert.equal(whaleRow.properties.get('--dw-ws-folder'), '#748162')
  assert.match(whaleRow.properties.get('--dw-whale-mask'), /^url\("data:image\/svg\+xml,/, 'the logo is the whale glyph, as a mask')
  assert.equal(whaleRow.getAttribute('data-dw-whale-label'), 'API')

  assert.equal(userRow.getAttribute('data-dw-whale'), null, 'a session the user opened is left exactly as the Host drew it')
  assert.equal(userRow.properties.get('--dw-ws-folder'), undefined)

  // A second pass writes nothing: the row already carries the color.
  assert.equal(client.decorateSidebarRows(sidebarScopeOf([folder, whaleRow, userRow]), { store: h.store }), 0, 'a repaint of an unchanged row writes nothing')

  // A color change repaints the same rows in place.
  const posted = h.store.setColor('ws-api', '#123456', 0)
  client.decorateSidebarRows(sidebarScopeOf([folder, whaleRow]), { store: h.store })
  assert.equal(folder.getAttribute('data-dw-ws-folder'), '#123456')
  assert.equal(whaleRow.getAttribute('data-dw-whale'), '#123456')
  await h.flush()
  assert.deepEqual(await posted, { ok: true })
  assert.deepEqual(h.calls.find((call) => call.method === 'POST').body, { id: 'ws-api', color: '#123456' })

  // A workspace that disappears unpaints its rows rather than leaving a stale color.
  h.server.workspaces = h.server.workspaces.filter((workspace) => workspace.id !== 'ws-api')
  await h.store.loadWorkspaces(true)
  client.decorateSidebarRows(sidebarScopeOf([folder, whaleRow]), { store: h.store })
  assert.equal(folder.getAttribute('data-dw-ws-folder'), null, 'an uncolorable folder row goes back to the Host styling')
  assert.equal(whaleRow.getAttribute('data-dw-whale'), null)

  // The map is not loaded yet: nothing is painted at all.
  assert.equal(client.decorateSidebarRows(sidebarScopeOf([rowOf('session:w-api-1'), rowOf('workspace:ws-api')]), { store: harness().store }), 0)

  // A row of an unknown session refreshes the map, at most once per window.
  const dispatchedCalls = () => h.calls.filter((call) => call.url === '/api/discipline-whale/memory/dispatched').length
  const before = dispatchedCalls()
  h.store.requestDispatched('brand-new')
  await h.flush()
  assert.equal(dispatchedCalls(), before, 'a just-read map is not re-read')
  h.tick(20000)
  h.store.requestDispatched('brand-new')
  h.store.requestDispatched('another-new')
  await h.flush()
  assert.equal(dispatchedCalls(), before + 1, 'after the window one refresh serves every unknown row')
  console.log('ok 7 — the folder row and a dispatched session paint from the store; a user session never does')
}

// --- 8. the settings section ----------------------------------------------

{
  assert.deepEqual(client.WORKSPACE_PALETTE, PALETTE, 'the browser copy matches activity.js PALETTE')
  const chosen = []
  const section = client.workspaceColorsSection({
    t,
    workspaces: { list: WORKSPACES, failed: false, errors: {} },
    choose: (...args) => chosen.push(args),
  })
  assert.equal(textsOf(section)[0], 'Workspace colors')
  const rows = nodesOf(section).filter((node) => node.props?.className === 'dw-ws-row')
  assert.deepEqual(rows.map((row) => row.props['data-dw-workspace']), ['ws-blog', 'ws-api'], 'every workspace, in registry order')
  const blog = rows[0]
  assert.ok(textsOf(blog).includes('博客'))
  assert.equal(nodesOf(blog).find((node) => node.props?.className === 'dw-ws-swatch').props.style['--dw-tag'], '#6E7E91')
  const choices = nodesOf(blog).filter((node) => node.props?.className === 'dw-ws-choice')
  assert.deepEqual(choices.map((node) => node.props['data-dw-color']), PALETTE)
  assert.deepEqual(choices.filter((node) => node.props['aria-pressed'] === true).map((node) => node.props['data-dw-color']), ['#6E7E91'])
  choices[4].props.onClick()
  const custom = nodesOf(blog).find((node) => node.type === 'input')
  assert.equal(custom.props.type, 'color')
  assert.equal(custom.props.value, '#6e7e91', 'the color input gets the lowercase form it requires')
  custom.props.onChange({ target: { value: '#abcdef' } })
  assert.deepEqual(chosen[0], ['ws-blog', PALETTE[4], 0], 'a palette click posts the clicked slot at once')
  assert.equal(chosen[1][0], 'ws-blog')
  assert.equal(chosen[1][1], '#abcdef')
  assert.ok(chosen[1][2] > 0, 'the custom picker waits for the pointer to rest')

  const loading = client.workspaceColorsSection({ t, workspaces: { list: null, failed: false, errors: {} } })
  assert.ok(textsOf(loading).includes('Loading workspaces…'))
  const failed = client.workspaceColorsSection({ t, workspaces: { list: null, failed: true, errors: {} } })
  assert.ok(textsOf(failed).includes(t('workspacesUnavailable')))
  const empty = client.workspaceColorsSection({ t, workspaces: { list: [], failed: false, errors: {} } })
  assert.ok(textsOf(empty).includes('No workspaces yet.'))

  // The settings overview carries the section when wired to the store, and
  // stays exactly as before without it.
  const settingsInput = (workspaces) => ({
    t: (key) => key,
    info: null,
    draft: { baseUrl: '', model: '', language: '', apiKey: '', apiKeyTouched: false, clearKey: false },
    set: () => {},
    error: null,
    page: 'main',
    workspaces,
    actions: { save: () => {}, test: () => {}, close: () => {}, navigate: () => {}, chooseWorkspaceColor: () => {} },
  })
  const wired = client.settingsView(settingsInput({ list: WORKSPACES, failed: false, errors: {} }))
  assert.ok(nodesOf(wired).some((node) => node.props?.['data-dw-section'] === 'workspaces'))
  const plain = client.settingsView(settingsInput(undefined))
  assert.equal(nodesOf(plain).some((node) => node.props?.['data-dw-section'] === 'workspaces'), false)
  console.log('ok 8 — settings list every workspace with the activity.js palette and a custom color input')
}

// --- 9. contrast, the main session hand-off, dictionaries ------------------

{
  const luminance = (hex) => {
    const channel = (offset) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  for (const color of [...PALETTE, '#000000', '#FFFFFF', '#777777', '#FFFF00', '#000080']) {
    const label = client.readableTextOn(color)
    const other = label === '#ffffff' ? '#000000' : '#ffffff'
    assert.ok(contrast(color, label) >= contrast(color, other), `${color}: the label takes the higher-contrast color`)
    assert.ok(contrast(color, label) >= 4.5, `${color}: the label is readable (${contrast(color, label).toFixed(2)})`)
  }

  // Opening the whale records its main session in the shared store, so the
  // chips appear without another /home read.
  const id = await client.resolveMainSession({
    fetch: async () => json(200, { mainSessionId: 'main-from-home' }),
    sessions: { list: { getSnapshot: () => ({ ids: ['main-from-home'], byId: { 'main-from-home': {} } }) } },
    workspaces: { list: { getSnapshot: () => ({}) } },
  })
  assert.equal(id, 'main-from-home')
  assert.equal(client.memoryStore.getSnapshot().mainSessionId, 'main-from-home')

  const keys = ['settingsSectionWorkspaces', 'workspacesLoading', 'workspacesEmpty', 'workspacesUnavailable', 'workspacePalette',
    'workspacePaletteColor', 'workspaceCustomColor', 'workspaceColorFailed', 'workspaceSetColor', 'workspaceColorPicker',
    'workspaceColorDone', 'workspaceCustomColorTitle', 'whaleSession', 'tagOpen', 'tagNoSession']
  for (const key of keys) {
    assert.equal(typeof client.DICTIONARIES.zh[key], 'string', `zh.${key}`)
    assert.equal(typeof client.DICTIONARIES.en[key], 'string', `en.${key}`)
  }
  assert.equal(client.DICTIONARIES.zh.settingsSectionWorkspaces, '工作区颜色')
  assert.equal(client.DICTIONARIES.zh.workspaceSetColor, '设置颜色', 'the folder menu row is the label the user asked for')
  console.log('ok 9 — chip labels keep WCAG AA contrast, the main session is shared, and both dictionaries carry the copy')
}

// --- 10. "new main session" in the main session's header -------------------

{
  const view = client.newMainActionView({ t, busy: false, failure: null, onClick: () => {} })
  assert.equal(view.type, 'button')
  assert.equal(view.props.disabled, false)
  assert.ok(textsOf(view).includes('New main session'))
  const busy = client.newMainActionView({ t, busy: true, failure: null, onClick: () => {} })
  assert.equal(busy.props.disabled, true)
  assert.ok(textsOf(busy).includes('Creating…'))
  const failed = client.newMainActionView({ t, busy: false, failure: 'HTTP 500', onClick: () => {} })
  assert.equal(failed.props.title, 'Could not create a main session: HTTP 500')

  const calls = []
  const opened = []
  const id = await client.createNewMainSession({
    fetch: async (url, init) => {
      calls.push([url, init.method])
      return json(200, { home: '/h', mainSessionId: 'session-new-main' })
    },
    openSession: (sessionId) => opened.push(sessionId),
  })
  assert.equal(id, 'session-new-main')
  assert.deepEqual(calls, [['/api/discipline-whale/home', 'POST']])
  assert.deepEqual(opened, ['session-new-main'])
  assert.equal(client.memoryStore.getSnapshot().mainSessionId, 'session-new-main', 'chips follow the new main session')
  await assert.rejects(
    client.createNewMainSession({ fetch: async () => json(500, { error: 'boom' }), openSession: () => {} }),
    /HTTP 500/,
  )
  for (const key of ['newMain', 'newMainBusy', 'newMainFailed']) {
    assert.equal(typeof client.DICTIONARIES.zh[key], 'string', `zh has ${key}`)
  }
  console.log('ok 10 — the header button posts home, opens the new main session and shows failures')
}

// --- 11. the session-row color dot is gone --------------------------------
//
// The dot sat in the `sidebar.session.row.leading` seat, which is also where
// the Host paints the session's real status dot. A workspace color must never
// take that seat: the reservation is what pushed the status aside, so hiding
// the node would not be enough — nothing may be injected there at all.

{
  assert.equal(client.makeSessionDot, undefined, 'the dot component is removed, not hidden')
  assert.equal(client.sessionDotView, undefined, 'the dot view is removed, not hidden')
  const css = client.dockStyles()
  assert.doesNotMatch(css, /dw-ws-dot/, 'no stylesheet rule reserves the leading seat any more')
  console.log('ok 11 — the workspace dot and its reserved 16px seat are gone')
}

// --- 12. the workspace folder carries its color ---------------------------
//
// The color rides a custom property on the folder row, so the title and the
// folder glyph are painted from the workspace color and the stylesheet keeps
// no literal color of its own.

{
  assert.equal(typeof client.folderPaint, 'function', 'a folder paint exists')
  const paint = client.folderPaint({ color: '#6E7E91' })
  assert.deepEqual(paint, { '--dw-ws-folder': '#6E7E91' }, 'the folder row gets its color as a custom property')
  assert.equal(client.folderPaint({ color: 'not-a-color' }), undefined, 'an invalid color paints nothing')
  assert.equal(client.folderPaint(undefined), undefined, 'no workspace paints nothing')

  // The stylesheet reads the variable and mixes it with the theme's own text
  // color: no literal hex, so light and dark both stay readable.
  assert.equal(typeof client.folderStyles, 'function', 'folder styles exist')
  const folderCss = client.folderStyles()
  assert.match(folderCss, /var\(--dw-ws-folder/)
  assert.match(folderCss, /color-mix\(in srgb/)
  assert.match(folderCss, /--dsw-alias-label-primary|--dsw-specific-sidebar-fill|--dsw-alias-bg-base/, 'the mix falls back to theme variables')
  assert.doesNotMatch(folderCss, /#[0-9a-fA-F]{6}/, 'the folder stylesheet must not hardcode a color')
  // The title's ink is RESOLVED per row, because a fixed share cannot read on
  // both themes: the 60% mix measured 20.06:1 on the light sidebar and 1.22:1
  // on the dark one (live Chromium, 2026-10-24), which is the bug this replaced.
  // The rule therefore reads `--dw-folder-ink` and keeps the 60% mix only as the
  // fallback for a row an older pass painted.
  assert.match(folderCss, /_title\]\{\s*color:var\(--dw-folder-ink,/, 'the title ink comes from the per-row resolved value')
  assert.match(folderCss, /color-mix\(in srgb,var\(--dw-ws-folder\) 60%/, 'the 60% mix stays as the fallback')
  assert.equal(typeof client.folderTitlePaint, 'function', 'the resolver exists')
  // Both themes must clear AA, which is the fact the fixed share got wrong.
  for (const [surface, label] of [['#F9FAFB', '#0F1115'], ['#1B1B1C', '#ADB2B8']]) {
    for (const color of client.WORKSPACE_PALETTE) {
      const ink = client.folderTitlePaint(color, surface, label)
      const ratio = client.contrastOf(ink.color, surface)
      assert.ok(ratio >= 4.5, `${color} on ${surface} must clear AA, got ${ratio.toFixed(2)}:1 at share ${ink.share}%`)
    }
  }
  console.log('ok 12 — the folder row paints from its workspace color through theme variables')
}

// --- 13. "set color" in the folder menu -----------------------------------

{
  // The menu row itself: one more entry beside the Host's rename and delete.
  assert.equal(typeof client.setColorMenuItem, 'function', 'a menu row exists for the third item')
  const item = client.setColorMenuItem({ t })
  assert.equal(item.props.role, 'menuitem')
  assert.deepEqual(textsOf(item), [t('workspaceSetColor')])
  assert.equal(item.props['data-dw-menu-item'], 'color')

  // The picker: the eight palette colors plus a custom hex, writing through
  // the store the settings section already uses.
  assert.equal(typeof client.workspaceColorPicker, 'function', 'a picker exists')
  const chosen = []
  const ws = { id: 'ws-blog', title: '博客', color: '#6E7E91' }
  const picker = client.workspaceColorPicker({ t, workspace: ws, choose: (...args) => chosen.push(args), onClose: () => {} })
  const swatches = nodesOf(picker).filter((node) => node.props?.className === 'dw-ws-choice')
  assert.deepEqual(swatches.map((node) => node.props['data-dw-color']), client.WORKSPACE_PALETTE, 'the eight palette colors')
  assert.deepEqual(swatches.filter((node) => node.props['aria-pressed'] === true).map((node) => node.props['data-dw-color']), ['#6E7E91'])
  swatches[2].props.onClick()
  assert.deepEqual(chosen[0], ['ws-blog', PALETTE[2], 0], 'a palette click posts the clicked slot at once')
  const custom = nodesOf(picker).find((node) => node.type === 'input' && node.props.type === 'color')
  custom.props.onChange({ target: { value: '#abcdef' } })
  assert.equal(chosen[1][1], '#abcdef', 'a custom hex is accepted too')
  assert.ok(chosen[1][2] > 0, 'the dragged picker waits for the pointer to rest')

  // The picker resolves through the store's own setColor, so the write lands
  // on the same route and the same field the settings section uses.
  const h = await loadedHarness()
  const posted = h.store.setColor('ws-blog', '#748162', 0)
  await h.flush()
  assert.deepEqual(await posted, { ok: true })
  const post = h.calls.find((call) => call.method === 'POST')
  assert.deepEqual(post.body, { id: 'ws-blog', color: '#748162' }, 'the write carries the id and the color field')
  console.log('ok 13 — the folder menu gains "set color" and writes { id, color } through the shared store')
}

// --- 14. the whale logo only on whale-opened sessions ---------------------
//
// "Opened by the whale" is the dispatch record: the worker session id in the
// checkpoint/report index the `dispatched` route serves. A session the user
// opened has no record there, so it shows no logo — that is the whole test.

{
  assert.equal(typeof client.whalePrefix, 'function', 'a title prefix exists')
  const h = await loadedHarness()
  const prefix = (sessionId) => client.whalePrefix({ t, snapshot: h.store.getSnapshot(), sessionId })

  const whale = prefix('w-blog-1')
  assert.notEqual(whale, null, 'a dispatched session carries the logo')
  assert.equal(whale.props['data-dw-whale'], '', 'the prefix is marked for the stylesheet')
  assert.equal(whale.props.title, t('whaleSession'))
  assert.equal(whale.props.role, 'img', 'the logo is announced, not decoration')
  assert.equal(whale.props['aria-label'], t('whaleSession'))
  assert.equal(whale.props.style['--dw-ws-folder'], '#6E7E91', 'the logo takes the workspace color')
  assert.match(whale.props.style['--dw-whale-mask'], /^url\("data:image\/svg\+xml,/, 'the logo glyph is the whale, painted as a mask')

  assert.equal(prefix(MAIN), null, 'the whale main session itself carries no logo')
  assert.equal(prefix('user-opened'), null, 'a session the user opened carries no logo')
  assert.equal(client.whalePrefix({ t, snapshot: harness().store.getSnapshot(), sessionId: 'w-blog-1' }), null, 'nothing renders before the map loads')
  console.log('ok 14 — only whale-dispatched sessions get the logo and workspace color')
}

// --- 15. following a rotation of the main session ------------------------
//
// `GET /home` carries `lineage`: each ended segment and its successor, oldest
// first. A header on an earlier segment links to the current main session,
// and a fresh rotation moves the main view there exactly once.

{
  const NOW = Date.parse('2026-10-25T12:00:00Z')
  const minutesAgo = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString()
  const entry = (sessionId, successor, endedAt) => ({ sessionId, successor, endedAt, reason: 'size', lastInputTokens: 180000, compactions: 3, seedFile: `home/rotations/${successor}.md` })
  const snapshot = {
    mainSessionId: 'main-c',
    lineage: [entry('main-a', 'main-b', minutesAgo(90)), entry('main-b', 'main-c', minutesAgo(2))],
  }
  assert.equal(client.rotatedTo('main-a', snapshot), 'main-c', 'two segments walk to the current main session')
  assert.equal(client.rotatedTo('main-b', snapshot), 'main-c')
  assert.equal(client.rotatedTo('main-c', snapshot), null, 'the current main session is not rotated')
  assert.equal(client.rotatedTo('worker-1', snapshot), null, 'a session outside the lineage is not rotated')
  assert.equal(client.rotatedTo('main-a', { ...snapshot, lineage: null }), null)
  const loop = { mainSessionId: 'main-c', lineage: [entry('x', 'y', minutesAgo(1)), entry('y', 'x', minutesAgo(1))] }
  assert.equal(client.rotatedTo('x', loop), null, 'a cyclic lineage ends without an answer')

  const followed = new Set()
  const ask = (viewedSessionId) => client.shouldAutoFollow({ viewedSessionId, snapshot, followed, now: NOW })
  assert.equal(ask('main-b'), true, 'a rotation two minutes old moves the view')
  assert.equal(ask('main-b'), false, 'and only once')
  assert.equal(ask('main-a'), false, 'a segment that ended 90 minutes ago only shows the chip')
  assert.equal(ask('main-c'), false, 'the current main session never follows')
  const next = { mainSessionId: 'main-d', lineage: [...snapshot.lineage, entry('main-c', 'main-d', minutesAgo(0))] }
  assert.equal(client.shouldAutoFollow({ viewedSessionId: 'main-c', snapshot: next, followed, now: NOW }), true, 'the next rotation follows once more')

  // The store keeps the lineage and `force` reads the home record again.
  let home = { home: '/h', mainSessionId: 'main-b', lineage: [snapshot.lineage[0]] }
  let reads = 0
  const store = client.createMemoryStore({
    fetch: async (url) => {
      assert.equal(url, '/api/discipline-whale/home')
      reads += 1
      return json(200, home)
    },
  })
  await store.loadMain()
  await store.loadMain()
  assert.equal(reads, 1, 'an unforced read is cached')
  assert.deepEqual(store.getSnapshot().lineage, [snapshot.lineage[0]])
  home = { home: '/h', ...snapshot }
  await store.loadMain({ force: true })
  assert.equal(reads, 2, 'a forced read asks again')
  assert.equal(store.getSnapshot().mainSessionId, 'main-c')
  assert.deepEqual(store.getSnapshot().lineage, snapshot.lineage)
  const before = store.getSnapshot()
  await store.loadMain({ force: true })
  assert.equal(store.getSnapshot(), before, 'an unchanged lineage publishes nothing')

  // The chip renders only on a lineage session's header, and opens the current main session.
  const opened = []
  const Follow = client.makeRotationFollow(store, t, { openSession: (id) => opened.push(id), sessions: {}, followed: new Set() })
  for (const sessionId of ['main-c', 'worker-1', undefined]) {
    assert.equal(Follow({ sessionId }), null, `no chip on ${sessionId}`)
  }
  for (const sessionId of ['main-a', 'main-b']) {
    const chip = Follow({ sessionId })
    assert.equal(chip.type, 'button')
    assert.ok(textsOf(chip).includes('Continued →'))
    chip.props.onClick()
  }
  assert.deepEqual(opened, ['main-c', 'main-c'])
  for (const key of ['rotated', 'rotatedTitle']) {
    assert.equal(typeof client.DICTIONARIES.zh[key], 'string', `zh has ${key}`)
  }
  assert.equal(client.DICTIONARIES.zh.rotated, '已续接 →')
  console.log('ok 15 — rotatedTo walks the lineage, auto-follow fires once per rotation, and the chip shows only on lineage headers')
}

// --- 16. the follower's effects: polling and the one automatic switch -----
//
// A second instance of the browser half whose React runs effects at once and
// keeps their cleanups, so mounting and unmounting can be observed.

{
  const cleanups = []
  const effectReact = { ...React, useEffect: (run) => { const cleanup = run(); if (typeof cleanup === 'function') cleanups.push(cleanup) } }
  const live = definition.factory(() => effectReact)
  const endedAt = new Date(Date.now() - 60 * 1000).toISOString()
  const home = { home: '/h', mainSessionId: 'main-b', lineage: [{ sessionId: 'main-a', successor: 'main-b', endedAt, reason: 'size', lastInputTokens: 1, compactions: 0, seedFile: 'home/rotations/main-b.md' }] }
  const forced = []
  const store = live.createMemoryStore({ fetch: async () => json(200, home) })
  await store.loadMain()
  const realLoad = store.loadMain
  store.loadMain = (options) => { forced.push(options?.force === true); return realLoad(options) }
  const intervals = []
  const opened = []
  const mainView = new Set(['main-a'])
  const sessions = { list: { getSnapshot: () => ({ byId: Object.fromEntries([...mainView].map((id) => [id, { id, retainedBy: { mainView: 1 } }])) }) } }
  const Follow = live.makeRotationFollow(store, t, {
    openSession: (id) => opened.push(id),
    sessions,
    followed: new Set(),
    setInterval: (fn, ms) => { intervals.push({ fn, ms, stopped: false }); return intervals.length },
    clearInterval: (id) => { intervals[id - 1].stopped = true },
  })

  Follow({ sessionId: 'worker-1' })
  assert.equal(intervals.length, 0, 'a worker header never polls')
  assert.deepEqual(forced, [true], 'but it reads the home record fresh once, so a missed rotation is caught')
  Follow({ sessionId: 'main-a' })
  assert.deepEqual(opened, ['main-b'], 'the main view leaves the ended segment on its own')
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 5000, 'a lineage header polls every 5 s')
  intervals[0].fn()
  assert.equal(forced.at(-1), true, 'the poll forces a fresh read')
  Follow({ sessionId: 'main-a' })
  assert.deepEqual(opened, ['main-b'], 'a second look at the same segment keeps the chip only')
  Follow({ sessionId: 'main-b' })
  assert.equal(intervals.length, 3, 'the main session polls too')
  for (const cleanup of cleanups.splice(0)) cleanup()
  assert.ok(intervals.every((interval) => interval.stopped), 'unmount stops every poll')

  mainView.clear()
  const other = live.makeRotationFollow(store, t, { openSession: (id) => opened.push(id), sessions, followed: new Set(), setInterval: () => 0, clearInterval: () => {} })
  other({ sessionId: 'main-a' })
  assert.deepEqual(opened, ['main-b'], 'a header outside the main view never switches it')
  console.log('ok 16 — lineage and main headers poll every 5 s until unmount; the main view switches once')
}

console.log('\nAll discipline-whale memory client checks passed.')
