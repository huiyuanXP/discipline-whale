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
  { id: 'ws-blog', title: '博客', path: '/p/blog', color: '#3B82F6', intro: '', updatedAt: '2026-10-21T00:00:00Z' },
  { id: 'ws-api', title: 'API', path: '/p/api', color: '#F59E0B', intro: '', updatedAt: '2026-10-21T00:00:00Z' },
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
  assert.equal(oneChips[0].props.style['--dw-tag'], '#3B82F6', 'the chip is painted in the workspace color')

  const two = render(5)
  assert.equal(two.props.className, 'dw-tags')
  assert.equal(two.props['data-dw-turn'], 5)
  const twoChips = nodesOf(two).filter((node) => node.props?.className === 'dw-tag')
  assert.deepEqual(twoChips.map((chip) => textsOf(chip)[0]), ['博客', 'API'], 'two workspaces give two chips side by side, in record order')
  assert.deepEqual(twoChips.map((chip) => chip.props.style['--dw-tag']), ['#3B82F6', '#F59E0B'])
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

// --- 5. a color change repaints chips and dots at once ---------------------

{
  const h = await loadedHarness()
  const Tags = client.makeTurnTags(h.store, t)
  const Dot = client.makeSessionDot(h.store, t)
  const chipColor = () => nodesOf(Tags({ turn: closedTurn(3), seq: 1, openFile: () => {}, sessionId: MAIN, openSession: () => {} }))
    .find((node) => node.props?.className === 'dw-tag').props.style['--dw-tag']
  const dotColor = () => nodesOf(Dot({ sessionId: 'w-blog-1' })).find((node) => node.props?.className === 'dw-ws-dot').props.style['--dw-tag']
  assert.equal(chipColor(), '#3B82F6')
  assert.equal(dotColor(), '#3B82F6')

  let notified = 0
  h.store.subscribe(() => { notified += 1 })
  const posted = h.store.setColor('ws-blog', '#112233', 0)
  // Before the POST has even gone out, both surfaces show the new color.
  assert.equal(chipColor(), '#112233', 'the chip repaints at once')
  assert.equal(dotColor(), '#112233', 'the dot repaints at once')
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
  assert.equal(h.store.getSnapshot().workspaces.find((workspace) => workspace.id === 'ws-api').color, '#F59E0B', 'the stored color comes back')
  assert.equal(h.store.getSnapshot().colorErrors['ws-api'], 'unknown workspace: ws-api')
  console.log('ok 6 — a 400 shows the server text inline under that workspace and restores the stored color')
}

// --- 7. the sidebar dot ---------------------------------------------------

{
  const h = await loadedHarness()
  const Dot = client.makeSessionDot(h.store, t)
  const present = Dot({ sessionId: 'w-api-1' })
  assert.ok(present, 'a dispatched session has a dot')
  assert.equal(present.props['data-dw-workspace'], 'ws-api')
  const dot = nodesOf(present).find((node) => node.props?.className === 'dw-ws-dot')
  assert.equal(dot.props.style['--dw-tag'], '#F59E0B')
  assert.equal(dot.props['aria-label'], 'Workspace: API')
  assert.equal(Dot({ sessionId: MAIN }), null, 'the main session has no dot')
  assert.equal(Dot({ sessionId: 'never-dispatched' }), null, 'any other session has no dot')
  assert.equal(client.makeSessionDot(harness().store, t)({ sessionId: 'w-api-1' }), null, 'nothing renders before the map loads')

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
  console.log('ok 7 — the sidebar dot shows for dispatched sessions only')
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
  assert.equal(nodesOf(blog).find((node) => node.props?.className === 'dw-ws-swatch').props.style['--dw-tag'], '#3B82F6')
  const choices = nodesOf(blog).filter((node) => node.props?.className === 'dw-ws-choice')
  assert.deepEqual(choices.map((node) => node.props['data-dw-color']), PALETTE)
  assert.deepEqual(choices.filter((node) => node.props['aria-pressed'] === true).map((node) => node.props['data-dw-color']), ['#3B82F6'])
  choices[4].props.onClick()
  const custom = nodesOf(blog).find((node) => node.type === 'input')
  assert.equal(custom.props.type, 'color')
  assert.equal(custom.props.value, '#3b82f6', 'the color input gets the lowercase form it requires')
  custom.props.onChange({ target: { value: '#abcdef' } })
  assert.deepEqual(chosen[0], ['ws-blog', '#8B5CF6', 0], 'a palette click posts at once')
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
    'workspacePaletteColor', 'workspaceCustomColor', 'workspaceColorFailed', 'workspaceDot', 'tagOpen', 'tagNoSession']
  for (const key of keys) {
    assert.equal(typeof client.DICTIONARIES.zh[key], 'string', `zh.${key}`)
    assert.equal(typeof client.DICTIONARIES.en[key], 'string', `en.${key}`)
  }
  assert.equal(client.DICTIONARIES.zh.settingsSectionWorkspaces, '工作区颜色')
  console.log('ok 9 — chip labels keep WCAG AA contrast, the main session is shared, and both dictionaries carry the copy')
}

console.log('\nAll discipline-whale memory client checks passed.')
