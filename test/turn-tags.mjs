/**
 * Turn tags and folder colors on the CURRENT transcript DOM.
 *
 * The Host's conversation view stopped marking a user row with
 * `data-chat-turn`; the whole turn decorating pass silently claimed nothing
 * because `Number.parseInt(null)` made every row `continue`. This file is the
 * contract for the replacement: locate a user row by structure, read its turn
 * number from whatever identity the Host does expose, and keep working when
 * that identity moves again.
 *
 * DOM facts recorded from a live page (DSH 0.6.x, better-display 0.3.11),
 * 2026-10-24, `artifacts/dom-probe-before/`:
 *
 *   div.EiJPLW_userCluster[data-chat-flow-kind="user"][data-reader-key="13:input-message<id>"]
 *     └ div.Sixlwa_userRow > div.Sixlwa_userStack > div.Sixlwa_bubble
 *   section.EiJPLW_turn[data-reader-turn="1"][data-reader-turn-state="closed"]
 *
 * Checked:
 *
 *   1. a row without `data-chat-turn` is still located and tagged
 *   2. the turn number comes from `data-chat-flow-key`, then `data-reader-turn`
 *      on the enclosing section, then `data-chat-*key` variants
 *   3. a row the anchor rules cannot place is skipped silently, not thrown
 *   4. the tag is a real element with a click handler that opens the session
 *   5. the bubble is found by class convention, so the tint lands on it
 *   6. a folder row paints even before the workspace list finished loading
 *   7. a page whose DOM is entirely foreign decorates nothing and throws nothing
 *
 * Run: node test/turn-tags.mjs
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

const t = (key, vars = {}) => {
  const text = client.DICTIONARIES.en[key]
  assert.equal(typeof text, 'string', `missing dictionary key ${key}`)
  return text.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name]))
}

// --- a real-DOM-shaped stand-in ------------------------------------------

/**
 * One element with just the surface a decorator touches: attributes, inline
 * style custom properties, children, and a working `querySelectorAll`.
 *
 * The selector support is deliberately narrow — the exact shapes the
 * decorators use — so a selector that the real page could not satisfy fails
 * here too instead of quietly matching everything.
 */
function element({ tagName = 'div', className = '', attrs = {}, children = [], text = '' } = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    className,
    children,
    textContent: text,
    attributes: new Map(Object.entries(attrs)),
    properties: new Map(),
    listeners: new Map(),
    getAttribute: (name) => (node.attributes.has(name) ? node.attributes.get(name) : null),
    hasAttribute: (name) => node.attributes.has(name),
    setAttribute: (name, value) => node.attributes.set(name, String(value)),
    removeAttribute: (name) => node.attributes.delete(name),
    getAttributeNames: () => [...node.attributes.keys()],
    addEventListener: (type, handler) => node.listeners.set(type, handler),
    dispatch: (type, event = {}) => {
      const handler = node.listeners.get(type)
      if (typeof handler === 'function') handler(event)
      return handler !== undefined
    },
    style: {
      setProperty: (name, value) => node.properties.set(name, value),
      removeProperty: (name) => node.properties.delete(name),
    },
    appendChild: (child) => {
      child.parentElement = node
      node.children.push(child)
      return child
    },
    closest: (selector) => {
      if (!selector.startsWith('[') || !selector.endsWith(']')) return null
      const name = selector.slice(1, -1)
      let current = node.parentElement ?? null
      while (current !== null) {
        if (current.attributes?.has(name)) return current
        current = current.parentElement ?? null
      }
      return null
    },
    querySelectorAll: (selector) => query(node, selector),
    querySelector: (selector) => query(node, selector)[0] ?? null,
    parentElement: null,
  }
  for (const child of children) child.parentElement = node
  return node
}

/** The descendants of `root`, in document order. */
function descendants(root) {
  const out = []
  const walk = (node) => {
    for (const child of node.children ?? []) {
      out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

/**
 * The selector shapes this package uses, and nothing more.
 *
 * A compound selector is split on top-level spaces; each part must match. The
 * two pseudo forms used are `:not([attr])` and `:not([attr="value"])`.
 */
function matches(node, selector) {
  const parts = selector.trim().split(/\s+(?![^\[]*\])/)
  const leaf = parts[parts.length - 1]
  const negations = []
  const rest = leaf.replace(/:not\((\[[^\]]*\])\)/g, (_match, inner) => {
    negations.push(inner)
    return ''
  })
  if (!matchesCompound(node, rest)) return false
  for (const negation of negations) {
    if (matchesCompound(node, negation)) return false
  }
  // Ancestor parts must match in order, nearest first.
  let current = node.parentElement ?? null
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    let found = false
    while (current !== null) {
      if (matchesCompound(current, parts[index])) {
        found = true
        current = current.parentElement ?? null
        break
      }
      current = current.parentElement ?? null
    }
    if (!found) return false
  }
  return true
}

function matchesCompound(node, compound) {
  let rest = compound.trim()
  if (rest === '' ) return true
  // Tag name.
  const tagMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(rest)
  if (tagMatch !== null) {
    if (String(node.tagName ?? '').toUpperCase() !== tagMatch[0].toUpperCase()) return false
    rest = rest.slice(tagMatch[0].length)
  }
  // `.class` tokens: a CSS-modules class is one token of the className string.
  for (const classMatch of rest.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    const tokens = String(node.className ?? '').split(/\s+/).filter(Boolean)
    if (!tokens.includes(classMatch[1])) return false
  }
  rest = rest.replace(/\.[A-Za-z0-9_-]+/g, '')
  // `*=` substring attribute match, `^=` prefix match, `=` exact match.
  for (const attrMatch of rest.matchAll(/\[([a-zA-Z0-9_-]+)([*^]?)=?"?([^\]"]*)"?\]/g)) {
    const [, name, operator, value] = attrMatch
    // The real DOM exposes the class list through both `className` and the
    // `class` attribute; the fixture keeps them in sync the same way.
    const actual = name === 'class'
      ? String(node.className ?? '')
      : (node.attributes?.has?.(name) ? String(node.getAttribute(name)) : null)
    if (actual === null) return false
    // The operator capture is the bare symbol: `*` is the substring match,
    // `^` the prefix match, and no symbol an exact match.
    if (operator === '*' && !actual.includes(value)) return false
    if (operator === '^' && !actual.startsWith(value)) return false
    if (operator === '' && value !== '' && actual !== value) return false
  }
  return true
}

function query(root, selector) {
  const selectorList = selector.split(',').map((part) => part.trim())
  return descendants(root).filter((node) => selectorList.some((part) => matches(node, part)))
}

/** A user cluster shaped like the live one, with no `data-chat-turn` anywhere. */
function userCluster({ turnKey = '13:input-message8f2a', readerTurn = null, text = '帮我看一下配色' } = {}) {
  const bubble = element({ className: 'Sixlwa_bubble', text })
  const stack = element({ className: 'Sixlwa_userStack', children: [bubble] })
  const row = element({ className: 'Sixlwa_userRow', children: [stack] })
  const cluster = element({
    className: 'EiJPLW_userCluster',
    attrs: {
      'data-chat-flow-kind': 'user',
      'data-chat-flow-key': turnKey,
      'data-reader-key': turnKey,
    },
    children: [row],
  })
  const section = element({
    className: 'EiJPLW_turn',
    attrs: {
      'data-reader-turn-state': 'closed',
      ...(readerTurn === null ? {} : { 'data-reader-turn': String(readerTurn) }),
    },
    children: [element({ className: 'EiJPLW_column', children: [cluster] })],
  })
  return { cluster, bubble, section }
}

/** The snapshot the tag pass reads: turn 13 dispatched to two workspaces. */
function snapshotOf(tags) {
  return {
    mainSessionId: 'session-main',
    tags,
    dispatched: {},
    workspaces: [
      { id: 'ws-api', title: 'API', path: '/p/api', color: '#F59E0B' },
      { id: 'ws-blog', title: '博客', path: '/p/blog', color: '#3B82F6' },
    ],
  }
}

const storeOf = (tags, asked = []) => ({
  getSnapshot: () => snapshotOf(tags),
  subscribe: () => {},
  loadMain: () => Promise.resolve('session-main'),
  loadWorkspaces: () => Promise.resolve(),
  requestTags: (sessionId, turn) => asked.push([sessionId, turn]),
})

try {
  // 1 + 2. a row with no data-chat-turn is located, and its turn is read from
  // the flow key the Host does write.
  {
    const { cluster, section } = userCluster({ turnKey: '13:input-message8f2a' })
    const root = element({ className: 'root', children: [section] })
    const asked = []
    const store = storeOf({ 'session-main': { 13: { turn: 13, workspaces: ['ws-api', 'ws-blog'], sessions: {} } } }, asked)
    const claimed = client.decorateTurnTags(root, { t, store })
    assert.equal(cluster.getAttribute('data-chat-turn'), null, 'the live DOM has no data-chat-turn; the fixture must not either')
    assert.equal(claimed, 1, 'a user row without data-chat-turn must still be claimed')
    assert.equal(cluster.getAttribute('data-dw-turn-ws'), '')
    assert.equal(cluster.properties.get('--dw-msg-ws'), '#F59E0B')
    const label = String(cluster.getAttribute('data-dw-ws-tag'))
    assert.ok(label.includes('API') && label.includes('博客'), `tag should name both, got ${label}`)
    assert.deepEqual(asked, [], 'a turn whose tags are already loaded is not asked for again')

    // The same row before its tags land: the pass must ask for the turn the
    // flow key names, which is what makes a late arrival paint.
    const cold = userCluster({ turnKey: '13:input-message8f2a' })
    const coldAsked = []
    const coldStore = storeOf({ 'session-main': {} }, coldAsked)
    assert.equal(client.decorateTurnTags(cold.section, { t, store: coldStore }), 0, 'no tags yet means no claim')
    assert.deepEqual(coldAsked, [['session-main', 13]], 'the turn read from the flow key is the one asked for')
    // And the turn reader itself, directly: each anchor in turn.
    const keyed = userCluster({ turnKey: '13:input-message8f2a' }).cluster
    assert.equal(client.turnOfUserRow(keyed), 13, 'the flow key prefix is the turn')
    assert.equal(client.turnOfUserRow(userCluster({ turnKey: 'zz', readerTurn: 7 }).cluster), 7, 'the section is the fallback')
    const legacy = element({ attrs: { 'data-chat-turn': '9' } })
    assert.equal(client.turnOfUserRow(legacy), 9, 'the original attribute still wins when present')
    assert.equal(client.turnOfUserRow(element({ attrs: {} })), null, 'a row with nothing returns null, not NaN')
    pass('a row without data-chat-turn is claimed')
  }

  // 2b. no flow key: the enclosing section's data-reader-turn is the anchor.
  {
    const { cluster, section } = userCluster({ turnKey: 'not-a-number', readerTurn: 13 })
    const root = element({ className: 'root', children: [section] })
    const store = storeOf({ 'session-main': { 13: { turn: 13, workspaces: ['ws-api'], sessions: {} } } })
    assert.equal(client.decorateTurnTags(root, { t, store }), 1, 'data-reader-turn on the section is the second anchor')
    assert.equal(cluster.getAttribute('data-dw-turn-ws'), '')
    pass('an unreadable flow key falls back to data-reader-turn')
  }

  // 2c. THE LIVE BUG: the flow key's numeric prefix is not the turn number.
  // On a real page every user row's key starts with `13:` (a flow format
  // number) while its section reads 54, 55, 56, 60 … 65. Trusting the key
  // first made every row `turn 13`, so every chip pointed at turn 13's one
  // session and the Host answered "Session reference is released". The section
  // is the authority; the key is the fallback.
  {
    const { cluster, section } = userCluster({ turnKey: '13:input-messageabc', readerTurn: 57 })
    const root = element({ className: 'root', children: [section] })
    const asked = []
    const store = storeOf({ 'session-main': {} }, asked)
    assert.equal(client.turnOfUserRow(cluster), 57, 'the enclosing section wins over the key prefix')
    client.decorateTurnTags(root, { t, store })
    assert.deepEqual(asked, [['session-main', 57]], 'the row asks for its own turn, not the key prefix')
    pass('the section turn wins over a misleading key prefix')
  }

  // 3. a row nothing can place is skipped, silently.
  {
    const bubble = element({ className: 'Sixlwa_bubble' })
    const orphan = element({ className: 'EiJPLW_userCluster', attrs: { 'data-chat-flow-kind': 'user' }, children: [bubble] })
    const root = element({ className: 'root', children: [orphan] })
    const store = storeOf({ 'session-main': {} })
    assert.equal(client.decorateTurnTags(root, { t, store }), 0, 'an unplaceable row claims nothing')
    assert.equal(orphan.getAttribute('data-dw-turn-ws'), null)
    // And a scope that is not a DOM at all is a no-op rather than a throw.
    assert.equal(client.decorateTurnTags(null, { t, store }), 0)
    assert.equal(client.decorateTurnTags({}, { t, store }), 0)
    pass('an unplaceable row is skipped without throwing')
  }

  // 4. the tag is a real element with a click handler that opens the session.
  {
    // The chip is mounted with `document.createElement`: the transcript is the
    // Host's tree, so the chip is plain DOM. Give the test the one call the
    // mounter makes.
    globalThis.document = { createElement: (tagName) => element({ tagName }) }
    try {
      const { cluster, section } = userCluster({ turnKey: '13:input-message8f2a' })
      const root = element({ className: 'root', children: [section] })
      const target = 'session-dispatched-13'
      const store = storeOf({ 'session-main': { 13: { turn: 13, workspaces: ['ws-api'], sessions: { 'ws-api': [target] } } } })
      const opened = []
      client.decorateTurnTags(root, { t, store, open: (sessionId) => opened.push(sessionId) })
      const chip = cluster.querySelector('[data-dw-turn-chip]')
      assert.notEqual(chip, null, 'the tag must be a real element, not only a ::before')
      assert.equal(chip.tagName.toLowerCase(), 'button', 'the tag must be a button')
      assert.equal(chip.getAttribute('data-dw-session'), target)
      // Clicking it goes to that session through the injected opener.
      assert.equal(chip.dispatch('click'), true, 'the chip must have a click handler')
      assert.deepEqual(opened, [target], 'a click opens the session the turn dispatched to')
      // A second pass mounts no second chip.
      client.decorateTurnTags(section, { t, store, open: () => {} })
      assert.equal(cluster.querySelectorAll('[data-dw-turn-chip]').length, 1, 'the chip is mounted once')
      pass('the tag is a real button that opens its session')
    } finally {
      delete globalThis.document
    }
  }

  // 4b. a tag whose workspace has no dispatched session is inert, not broken.
  {
    globalThis.document = { createElement: (tagName) => element({ tagName }) }
    try {
      const { cluster, section } = userCluster({ turnKey: '13:input-message8f2a' })
      const root = element({ className: 'root', children: [section] })
      const store = storeOf({ 'session-main': { 13: { turn: 13, workspaces: ['ws-api'], sessions: {} } } })
      client.decorateTurnTags(root, { t, store, open: () => {} })
      const chip = cluster.querySelector('[data-dw-turn-chip]')
      assert.notEqual(chip, null)
      assert.equal(chip.getAttribute('data-dw-session'), null, 'no session means no target')
      assert.equal(chip.getAttribute('data-dw-inert'), '', 'and the chip says so')
      assert.equal(chip.dispatch('click'), false, 'an inert chip has no handler to fire')
      pass('a tag without a session is inert')
    } finally {
      delete globalThis.document
    }
  }

  // 5. the bubble is found by class convention, so the tint lands on it.
  {
    const { cluster, bubble, section } = userCluster({ turnKey: '11:input-messageff01' })
    const root = element({ className: 'root', children: [section] })
    const store = storeOf({ 'session-main': { 11: { turn: 11, workspaces: ['ws-api'], sessions: {} } } })
    client.decorateTurnTags(root, { t, store })
    assert.equal(bubble.getAttribute('data-dw-turn-bubble'), '', 'the bubble must be marked so the stylesheet can paint it')
    assert.equal(cluster.getAttribute('data-dw-turn-ws'), '')
    pass('the bubble is located by its class convention')
  }

  // 6. folder rows paint even when the workspace list has not loaded yet.
  {
    const folderText = element({ className: 'YDXeBa_projectText' })
    const title = element({ className: 'YDXeBa_title', children: [folderText] })
    const folderRow = element({
      className: 'YDXeBa_projectRow',
      attrs: { 'data-row-key': 'workspace:ws-api' },
      children: [title],
    })
    const root = element({ className: 'root', children: [folderRow] })
    const asked = []
    const store = {
      getSnapshot: () => ({ workspaces: [{ id: 'ws-api', title: 'API', path: '/p/api', color: '#F59E0B' }], dispatched: {} }),
      subscribe: () => {},
      loadWorkspaces: (force) => {
        asked.push(force)
        return Promise.resolve()
      },
    }
    assert.equal(client.decorateSidebarRows(root, { store }), 1)
    assert.equal(folderRow.getAttribute('data-dw-ws-folder'), '#F59E0B')
    assert.equal(folderRow.properties.get('--dw-ws-folder'), '#F59E0B')
    assert.deepEqual(asked, [], 'a loaded list must not trigger a fetch')

    // The real failure: the sidebar paints before any workspace list exists.
    const coldRow = element({ className: 'YDXeBa_projectRow', attrs: { 'data-row-key': 'workspace:ws-api' } })
    const coldRoot = element({ className: 'root', children: [coldRow] })
    const coldAsked = []
    const coldStore = {
      getSnapshot: () => ({ workspaces: null, dispatched: null }),
      subscribe: () => {},
      loadWorkspaces: (force) => {
        coldAsked.push(force)
        return Promise.resolve()
      },
    }
    assert.equal(client.decorateSidebarRows(coldRoot, { store: coldStore }), 0)
    assert.deepEqual(coldAsked, [true], 'a missing workspace list must be requested, or the folder never paints')
    pass('a folder row paints, and a missing list is requested')
  }

  // 7. an entirely foreign DOM decorates nothing and throws nothing.
  {
    const alien = element({ className: 'somethingElse', attrs: { 'data-row-key': 'workspace:ws-api' } })
    const root = element({ className: 'root', children: [alien] })
    const store = storeOf({ 'session-main': {} })
    assert.equal(client.decorateTurnTags(root, { t, store }), 0)
    assert.equal(client.decorateSidebarRows(root, { store: { getSnapshot: () => ({}), subscribe: () => {} } }), 0)
    pass('a foreign DOM is a silent no-op')
  }

  console.log('turn-tags: all checks passed')
} catch (error) {
  console.error('FAIL', error)
  process.exitCode = 1
}
