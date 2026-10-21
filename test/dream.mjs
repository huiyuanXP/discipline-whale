/**
 * Tests for dream.js: trigger, lock, prompt, ops, gates, and runDream.
 *
 *   1. shouldDream boundaries
 *   2. lock exclusivity, stale takeover, release
 *   3. prompt labels entries and states the four phases and the scope
 *   4. parseDreamOps tolerates fences and rejects garbage
 *   5. applyDreamOps: merge / rewrite / promote / remove semantics
 *   6. each gate fails on its own
 *   7. runDream full write: layers, DREAMS.md, cursor, archive, daily window
 *   8. gate failure falls back to promotions only; over-budget fallback writes nothing
 *   9. MemoryConflictError aborts the dream
 *  10. busy lock skips; a failing model never throws and releases the lock
 *
 * Run: node test/dream.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { charLength, parseSections, sectionEntries } from '../entry.js'
import {
  acquireDreamLock,
  applyDreamOps,
  buildDreamPrompt,
  checkGates,
  collectNewDaily,
  dreamLockPath,
  dreamsLogPath,
  parseDreamOps,
  releaseDreamLock,
  runDream,
  shouldDream,
} from '../dream.js'
import { readCursor, writeCursor } from '../memory-flush.js'
import { whaleHomeDir } from '../store.js'

const USER = [
  '# USER',
  '',
  '## Preferences',
  '- Always lead with the conclusion [source: user; added: 2026-10-01]',
  '- Prefer replies in Chinese [source: user; added: 2026-10-02]',
  '',
  '## Now',
  '- NOW-ENTRY finish the dream module [source: session:main#t1; added: 2026-10-21]',
  '',
].join('\n')

const MEMORY = [
  '# MEMORY',
  '',
  '## Facts',
  ...Array.from({ length: 8 }, (_, index) => `- Fact number ${index + 1} [source: report:r-${index + 1}; added: 2026-10-0${index + 1}]`),
  '',
].join('\n')

const DAILY = () => ({
  '2026-10-21': [
    { text: 'User wants weekly reports in Chinese', meta: { source: 'session:main#t10', added: '2026-10-21' } },
    { text: 'User again asked for Chinese weekly reports', meta: { source: 'session:main#t20', added: '2026-10-21' } },
    { text: 'Blog builds with bun', meta: { source: 'report:r-9', added: '2026-10-21' } },
    { text: 'Observation four', meta: { source: 'session:main#t30', added: '2026-10-21' } },
    { text: 'Observation five', meta: { source: 'session:main#t31', added: '2026-10-21' } },
  ],
  '2026-10-22': [{ text: 'A note without source', meta: {} }],
})

/** In-memory store with the memory.js / activity.js signatures dream calls. */
function fakeStore({ user = USER, memory = MEMORY, daily = DAILY(), cards = {} } = {}) {
  const layers = { user, memory }
  const budgets = { user: 4000, memory: 8000 }
  const hashOf = (text) => createHash('sha256').update(text).digest('hex')
  const writes = []
  return {
    layers,
    daily,
    writes,
    async readLayer(homeDir, target) {
      const text = layers[target]
      return { text, doc: parseSections(text), hash: hashOf(text) }
    },
    async writeLayer(homeDir, target, text, { expectHash } = {}) {
      if (expectHash !== undefined && expectHash !== hashOf(layers[target])) {
        const error = new Error(`${target} changed since it was read`)
        error.name = 'MemoryConflictError'
        throw error
      }
      if (charLength(text) > budgets[target]) {
        const error = new Error(`${target} over budget`)
        error.name = 'MemoryBudgetError'
        throw error
      }
      layers[target] = text
      writes.push(target)
    },
    async listDailyDays() {
      return Object.keys(daily).sort()
    },
    async readDaily(homeDir, day) {
      return [...(daily[day] ?? [])]
    },
    async readWorkspaceCards() {
      return cards
    },
  }
}

const exists = (path) => access(path).then(() => true, () => false)
const root = await mkdtemp(join(tmpdir(), 'whale-dream-'))
const now = new Date(2026, 9, 22, 10, 30)
const HOUR = 60 * 60 * 1000

try {
  // 1. Trigger.
  {
    assert.equal(shouldDream({ newDailyEntries: 4, now }), false, 'fewer than five entries waits')
    assert.equal(shouldDream({ newDailyEntries: 5, now }), true, 'first dream needs only entries')
    assert.equal(shouldDream({ newDailyEntries: 9, lastDreamAt: new Date(now - 24 * HOUR + 60000).toISOString(), now }), false, '23h59 waits')
    assert.equal(shouldDream({ newDailyEntries: 9, lastDreamAt: new Date(now - 24 * HOUR).toISOString(), now }), true, '24h exactly dreams')
    assert.equal(shouldDream({ newDailyEntries: 2, lastDreamAt: new Date(now - 2 * HOUR), now, minHours: 1, minEntries: 2 }), true, 'thresholds configurable')
    console.log('ok 1 — shouldDream boundaries')
  }

  // 2. Lock.
  {
    const home = join(root, 'lock')
    assert.equal(await acquireDreamLock(home, { now }), true)
    assert.equal(await acquireDreamLock(home, { now }), false, 'second holder refused')
    const held = JSON.parse(await readFile(dreamLockPath(home), 'utf8'))
    assert.equal(held.pid, process.pid)
    assert.equal(held.at, now.toISOString())
    await releaseDreamLock(home)
    assert.equal(await exists(dreamLockPath(home)), false, 'release removes the lock')

    await writeFile(dreamLockPath(home), JSON.stringify({ pid: 999999, at: new Date(now - 59 * 60000).toISOString() }))
    assert.equal(await acquireDreamLock(home, { now }), false, 'a 59-minute-old lock is honoured')
    await releaseDreamLock(home)
    assert.equal(await exists(dreamLockPath(home)), true, 'another pid keeps its lock')
    await writeFile(dreamLockPath(home), JSON.stringify({ pid: 999999, at: new Date(now - 61 * 60000).toISOString() }))
    assert.equal(await acquireDreamLock(home, { now }), true, 'a 61-minute-old lock is taken over')
    assert.equal(JSON.parse(await readFile(dreamLockPath(home), 'utf8')).pid, process.pid)
    await releaseDreamLock(home)
    console.log('ok 2 — lock is exclusive, stale locks are taken over, release is pid-scoped')
  }

  // 3. Prompt.
  {
    const prompt = buildDreamPrompt({ user: USER, memory: MEMORY, workspaces: [{ id: 'ws-blog', title: 'blog', intro: 'Astro' }], daily: DAILY(), now })
    assert.ok(prompt.user.includes('U1  Always lead with the conclusion [source: user; added: 2026-10-01]'), 'U ids with meta')
    assert.ok(prompt.user.includes('M8  Fact number 8 [source: report:r-8'), 'M ids')
    assert.ok(prompt.user.includes('D2026-10-21#3  Blog builds with bun'), 'D ids')
    assert.ok(prompt.user.includes('D2026-10-22#1  A note without source'))
    assert.ok(!prompt.user.includes('NOW-ENTRY'), 'USER Now stays out of the prompt')
    assert.ok(prompt.user.includes('ws-blog · blog · Astro'))
    for (const phase of ['Orient', 'Gather', 'Consolidate', 'Prune']) assert.ok(prompt.system.includes(phase), `phase ${phase}`)
    assert.ok(prompt.system.includes('Your scope is USER Preferences'), 'scope stated positively')
    console.log('ok 3 — prompt labels U/M/D entries, states four phases and the scope')
  }

  // 4. Parse.
  {
    assert.deepEqual(parseDreamOps('```json\n{"ops":[{"op":"remove","id":"M1","reason":"stale"}]}\n```'), [{ op: 'remove', id: 'M1', reason: 'stale' }])
    assert.deepEqual(parseDreamOps('Nothing to change. {"ops": []}'), [])
    assert.throws(() => parseDreamOps('no json here'), SyntaxError)
    assert.throws(() => parseDreamOps('{"ops": "remove all"}'), TypeError)
    console.log('ok 4 — parseDreamOps tolerates fences and rejects garbage')
  }

  // 5. Apply.
  const goodOps = [
    { op: 'merge', ids: ['M2', 'M5'], text: 'Facts two and five, merged' },
    { op: 'rewrite', id: 'M3', text: 'Fact three, dated 2026-10-03' },
    { op: 'promote', from: ['D2026-10-21#1', 'D2026-10-21#2'], target: 'user', text: 'Always write weekly reports in Chinese' },
    { op: 'promote', from: ['D2026-10-22#1'], target: 'memory', text: 'A promoted note' },
  ]
  {
    const after = applyDreamOps({ user: USER, memory: MEMORY, daily: DAILY(), ops: [...goodOps, { op: 'rewrite', id: 'M99', text: 'x' }], now })
    const facts = sectionEntries(parseSections(after.memory), 'Facts')
    const prefs = sectionEntries(parseSections(after.user), 'Preferences')
    assert.equal(after.priorCount, 10)
    assert.equal(after.removedPrior, 1, 'merge of two removes one')
    assert.deepEqual(after.counts, { user: 3, memory: 8 })
    assert.deepEqual(facts[1], { text: 'Facts two and five, merged', meta: { source: 'report:r-2, report:r-5', added: '2026-10-02' }, links: [] })
    assert.deepEqual(facts[2].meta, { source: 'report:r-3', added: '2026-10-03' }, 'rewrite keeps metadata')
    assert.ok(!facts.some((entry) => entry.text === 'Fact number 5'), 'merged-away entry gone')
    assert.deepEqual(facts[7].meta, { source: 'daily:2026-10-22', added: '2026-10-22' }, 'promote without source cites the day')
    assert.deepEqual(prefs[2].meta, { source: 'session:main#t10, session:main#t20', added: '2026-10-22' })
    assert.ok(after.user.indexOf('Always write weekly reports') < after.user.indexOf('## Now'), 'promotion lands in Preferences')
    assert.ok(after.user.includes('NOW-ENTRY'), 'Now kept')
    assert.equal(after.applied.length, 4)
    assert.equal(after.rejected.length, 1)
    assert.match(after.rejected[0].reason, /unknown id M99/)
    console.log('ok 5 — apply merges sources and earliest date, rewrites keep meta, promotions cite daily')
  }

  // 6. Gates, each failing on its own.
  {
    const before = { user: USER, memory: MEMORY }
    const gate = (ops, options = {}) => {
      const input = { ...before, ...options.layers }
      const after = applyDreamOps({ ...input, daily: DAILY(), ops, now })
      return checkGates({ before: input, after, ops, budgets: options.budgets })
    }
    const kinds = (result) => [...new Set(result.failures.map((failure) => failure.gate))]

    assert.deepEqual(gate(goodOps), { ok: true, failures: [] }, 'a sound dream passes')
    assert.equal(gate([{ op: 'remove', id: 'M1' }, { op: 'remove', id: 'M2' }]).ok, true, '2 of 10 is within 25%')

    assert.deepEqual(kinds(gate([{ op: 'remove', id: 'M1' }, { op: 'remove', id: 'M2' }, { op: 'remove', id: 'M3' }])), ['loss'], '3 of 10 exceeds 25%')
    assert.deepEqual(kinds(gate([{ op: 'merge', ids: ['M1', 'M2', 'M3', 'M4'], text: 'all four' }])), ['loss'], 'merge losses count')

    const sourceless = MEMORY.replace('- Fact number 8 [source: report:r-8; added: 2026-10-08]', '- Fact number 8 [added: 2026-10-08]')
    assert.deepEqual(gate([], { layers: { memory: sourceless } }), { ok: true, failures: [] }, 'apply gives a source-less prior entry source: unknown')
    const unsourcedAfter = { ...applyDreamOps({ ...before, daily: DAILY(), ops: [], now }), memory: sourceless }
    assert.deepEqual(kinds(checkGates({ before, after: unsourcedAfter, ops: [] })), ['source'], 'an output entry without source fails')

    assert.deepEqual(kinds(gate(goodOps, { budgets: { user: 4000, memory: 300 } })), ['budget'], 'over budget fails')

    assert.deepEqual(kinds(gate([{ op: 'remove', id: 'M42' }])), ['ids'], 'unknown id fails')
    assert.deepEqual(kinds(gate([{ op: 'explode', id: 'M1' }])), ['ids'], 'unknown kind fails')
    assert.deepEqual(kinds(gate([{ op: 'promote', from: ['D2026-01-01#1'], target: 'memory', text: 'x' }])), ['ids'], 'unknown daily id fails')

    const after = applyDreamOps({ ...before, daily: DAILY(), ops: [], now })
    const broken = checkGates({ before, after: { ...after, user: after.user.replace('## Now', '## Later') } })
    assert.deepEqual(kinds(broken), ['parse'], 'a lost section fails')
    console.log('ok 6 — gates: loss, source, budget, ids and parse each fail on their own')
  }

  // 7. runDream full write.
  {
    const home = join(root, 'full')
    const dailyDir = join(whaleHomeDir(home), 'memory', 'daily')
    await mkdir(dailyDir, { recursive: true })
    await writeFile(join(dailyDir, '2026-09-22.md'), '- thirty days old\n')
    await writeFile(join(dailyDir, '2026-09-23.md'), '- twenty-nine days old\n')
    const store = fakeStore({ cards: { 'ws-blog': { intro: 'Astro' } } })
    let request
    const complete = async (input) => {
      request = input
      return `\`\`\`json\n${JSON.stringify({ ops: goodOps })}\n\`\`\``
    }
    const result = await runDream({ homeDir: home, complete, store, now, workspaces: [{ id: 'ws-blog', title: 'blog' }] })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'full')
    assert.equal(result.dailyEntries, 6)
    assert.ok(request.user.includes('ws-blog · blog · Astro'))
    assert.ok(store.layers.memory.includes('Facts two and five, merged'))
    assert.ok(store.layers.user.includes('Always write weekly reports in Chinese'))
    assert.deepEqual(result.archived, ['2026-09-22'])
    assert.equal(await exists(join(dailyDir, 'archive', '2026-09-22.md')), true, '30-day-old daily archived')
    assert.equal(await exists(join(dailyDir, '2026-09-23.md')), true, '29-day-old daily stays')

    const log = await readFile(dreamsLogPath(home), 'utf8')
    assert.ok(log.startsWith('# Dreams\n'))
    assert.ok(log.includes('## 2026-10-22 10:30'))
    assert.ok(log.includes('- applied merge M2, M5'))
    assert.ok(log.includes('archived daily 2026-09-22'))

    const cursor = await readCursor(home)
    assert.equal(cursor.lastDreamAt, now.toISOString())
    assert.equal(cursor.dailyEntriesAtLastDream, 6)
    assert.equal(cursor.dreamDayEntries, 1)
    assert.equal(await exists(dreamLockPath(home)), false, 'lock released')

    store.daily['2026-10-22'].push({ text: 'Later the same day', meta: { source: 'session:main#t50' } })
    const next = await collectNewDaily(home, store, cursor)
    assert.equal(next.count, 1, 'the next dream reads only entries written after this one')
    assert.equal(next.daily['2026-10-22'][0].n, 2, 'D ids keep their file position')
    console.log('ok 7 — runDream writes layers, logs DREAMS.md, moves the cursor, archives ≥30-day dailies')
  }

  // 8. Fallback.
  {
    const home = join(root, 'fallback')
    const store = fakeStore()
    const ops = [
      { op: 'remove', id: 'M1', reason: 'stale' },
      { op: 'remove', id: 'M2', reason: 'stale' },
      { op: 'remove', id: 'M3', reason: 'stale' },
      { op: 'promote', from: ['D2026-10-21#3'], target: 'memory', text: 'The blog builds with bun' },
    ]
    const result = await runDream({ homeDir: home, complete: async () => JSON.stringify({ ops }), store, now })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'fallback')
    assert.deepEqual(result.failures.map((failure) => failure.gate), ['loss'])
    const facts = sectionEntries(parseSections(store.layers.memory), 'Facts')
    assert.equal(facts.length, 9, 'nothing removed, one promotion appended')
    assert.equal(facts[8].text, 'The blog builds with bun')
    assert.equal(store.layers.user, USER, 'user layer untouched')
    const log = await readFile(dreamsLogPath(home), 'utf8')
    assert.ok(log.includes('gate loss') && log.includes('fallback: promotions only'))

    const fullHome = join(root, 'fallback-full')
    const heavy = `# MEMORY\n\n## Facts\n${Array.from({ length: 8 }, (_, index) => `- ${String(index).repeat(940)} [source: user; added: 2026-10-01]`).join('\n')}\n`
    const tight = fakeStore({ memory: heavy })
    const blocked = await runDream({
      homeDir: fullHome,
      complete: async () => JSON.stringify({ ops: [...ops, { op: 'promote', from: ['D2026-10-21#4'], target: 'memory', text: 'y'.repeat(290) }] }),
      store: tight,
      now,
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.mode, 'none')
    assert.deepEqual(tight.writes, [], 'an over-budget fallback writes nothing')
    assert.match(await readFile(dreamsLogPath(fullHome), 'utf8'), /fallback blocked by budget/)
    console.log('ok 8 — gate failure falls back to promotions only; an over-budget fallback writes nothing')
  }

  // 9. Conflict.
  {
    const home = join(root, 'conflict')
    const dailyDir = join(whaleHomeDir(home), 'memory', 'daily')
    await mkdir(dailyDir, { recursive: true })
    await writeFile(join(dailyDir, '2026-09-01.md'), '- old\n')
    await writeCursor(home, { lastDreamAt: 'earlier' })
    const store = fakeStore()
    const complete = async () => {
      store.layers.memory = `${store.layers.memory}- Written by remember mid-dream [source: user; added: 2026-10-22]\n`
      return JSON.stringify({ ops: [{ op: 'rewrite', id: 'M1', text: 'Fact one, tightened' }] })
    }
    const result = await runDream({ homeDir: home, complete, store, now })
    assert.equal(result.ok, false)
    assert.equal(result.mode, 'conflict')
    assert.deepEqual(store.writes, [], 'nothing written')
    assert.ok(store.layers.memory.includes('Written by remember mid-dream'), 'the concurrent write survives')
    assert.equal(await exists(join(dailyDir, '2026-09-01.md')), true, 'no archive after a conflict')
    assert.equal((await readCursor(home)).lastDreamAt, 'earlier', 'cursor unchanged, so the dream runs again')
    assert.match(await readFile(dreamsLogPath(home), 'utf8'), /conflict/)
    assert.equal(await exists(dreamLockPath(home)), false)
    console.log('ok 9 — MemoryConflictError aborts the dream without writing or archiving')
  }

  // 10. Busy lock and failing model.
  {
    const home = join(root, 'busy')
    assert.equal(await acquireDreamLock(home, { now }), true)
    let called = false
    const skipped = await runDream({ homeDir: home, complete: async () => { called = true; return '{}' }, store: fakeStore(), now })
    assert.deepEqual(skipped, { ok: false, skipped: 'locked' })
    assert.equal(called, false, 'a busy lock skips the model call')
    await releaseDreamLock(home)

    const failed = await runDream({ homeDir: home, complete: async () => { throw new Error('provider down') }, store: fakeStore(), now })
    assert.equal(failed.ok, false)
    assert.equal(failed.mode, 'error')
    assert.match(failed.error, /provider down/)
    assert.equal(await exists(dreamLockPath(home)), false, 'lock released after a failure')
    assert.match(await readFile(dreamsLogPath(home), 'utf8'), /error: Error: provider down/)
    assert.equal((await readCursor(home)).lastDreamAt, undefined)
    console.log('ok 10 — a busy lock skips; a failing model returns ok:false and releases the lock')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('\nAll dream checks passed.')
