/**
 * Tests for memory-flush.js: triggers, cursor, prompt, parsing, and runFlush.
 *
 *   1. shouldFlush / shouldNudge boundaries
 *   2. cursor merge-patch round-trip
 *   3. prompt leaves out context items, elides tool results, keeps the tail
 *   4. parse tolerates fences, drops unknown workspace ids, bounds fields
 *   5. runFlush applies daily / Now / intros through the store and moves the cursor
 *   6. runFlush reports failure without throwing
 *
 * Run: node test/memory-flush.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { charLength, isoDay, parseSections, renderSections, sectionEntries } from '../entry.js'
import {
  buildFlushPrompt,
  FLUSH_TRANSCRIPT_CHARS,
  parseFlushOutput,
  readCursor,
  runFlush,
  shouldFlush,
  shouldNudge,
  writeCursor,
} from '../memory-flush.js'

/** In-memory store with the memory.js / activity.js signatures the flush calls. */
function fakeStore({ user, memory, daily = {}, cards = {} } = {}) {
  const layers = {
    user: user ?? '# USER\n\n## Preferences\n\n## Now\n',
    memory: memory ?? '# MEMORY\n\n## Facts\n',
  }
  const hashOf = (text) => createHash('sha256').update(text).digest('hex')
  const calls = { appendDaily: [], replaceNow: [], setWorkspaceIntro: [] }
  return {
    layers,
    daily,
    cards,
    calls,
    async readLayer(homeDir, target) {
      const text = layers[target]
      return { text, doc: parseSections(text), hash: hashOf(text) }
    },
    async appendDaily(homeDir, entries, { day }) {
      calls.appendDaily.push({ entries, day })
      daily[day] = [...(daily[day] ?? []), ...entries]
    },
    async readDaily(homeDir, day) {
      return [...(daily[day] ?? [])]
    },
    async listDailyDays() {
      return Object.keys(daily).sort()
    },
    async replaceNow(homeDir, entries, { now, source }) {
      calls.replaceNow.push({ entries, source })
      const doc = parseSections(layers.user)
      const section = doc.sections.find((candidate) => candidate.heading === 'Now')
      const previous = sectionEntries(doc, 'Now')
      section.lines = entries.map((entry) => ({ entry }))
      layers.user = renderSections(doc)
      const day = isoDay(now)
      if (previous.length > 0) daily[day] = [...(daily[day] ?? []), ...previous]
    },
    async readWorkspaceCards() {
      return cards
    },
    async setWorkspaceIntro(homeDir, workspaceId, intro, { now }) {
      calls.setWorkspaceIntro.push({ workspaceId, intro })
      if (workspaceId === 'ws-broken') throw new Error('card store unavailable')
      if (charLength(intro) > 200) throw new Error('intro too long')
      cards[workspaceId] = { ...(cards[workspaceId] ?? {}), intro, updatedAt: isoDay(now) }
    },
  }
}

const home = await mkdtemp(join(tmpdir(), 'whale-flush-'))
const now = new Date(2026, 9, 22, 10, 30)

try {
  // 1. Triggers.
  {
    const base = { compactThreshold: 838000, flushedThisCycle: false }
    assert.equal(shouldFlush({ ...base, contextTokens: 838000 - 32768 - 1 }), false, 'just below the margin waits')
    assert.equal(shouldFlush({ ...base, contextTokens: 838000 - 32768 }), true, 'exactly at threshold − margin flushes')
    assert.equal(shouldFlush({ ...base, contextTokens: 900000, flushedThisCycle: true }), false, 'once per cycle')
    assert.equal(shouldFlush({ ...base, contextTokens: 1000, margin: 837000 }), true, 'margin is configurable')
    assert.equal(shouldFlush({ ...base, contextTokens: undefined }), false, 'unknown token count waits')
    assert.equal(shouldNudge({ userTurnsSinceLast: 9 }), false)
    assert.equal(shouldNudge({ userTurnsSinceLast: 10 }), true)
    assert.equal(shouldNudge({ userTurnsSinceLast: 3, interval: 3 }), true)
    console.log('ok 1 — shouldFlush / shouldNudge boundaries')
  }

  // 2. Cursor.
  {
    assert.deepEqual(await readCursor(home), {}, 'missing cursor reads empty')
    await writeCursor(home, { lastFlushAt: 'a', lastNudgeTurn: 4 })
    const merged = await writeCursor(home, { lastDreamAt: 'b', lastNudgeTurn: 9 })
    assert.deepEqual(merged, { lastFlushAt: 'a', lastNudgeTurn: 9, lastDreamAt: 'b' })
    assert.deepEqual(await readCursor(home), merged, 'written atomically and read back')
    await writeCursor(home, { lastDreamAt: null })
    assert.equal((await readCursor(home)).lastDreamAt, undefined, 'null deletes a key')
    console.log('ok 2 — cursor merge-patch round-trip')
  }

  // 3. Prompt.
  {
    const transcript = [
      { role: 'context', text: 'INJECTED-MEMORY-SNAPSHOT Always reply in five lines' },
      { role: 'user', text: '以后周报都用中文写' },
      { role: 'tool', toolName: 'read_report', text: 'SECRET-TOOL-RESULT body' },
      { role: 'assistant', text: '好的，记下了。' },
    ]
    const prompt = buildFlushPrompt({
      transcript,
      user: '# USER\n\n## Preferences\n- Prefer short answers [source: user; added: 2026-10-01]\n',
      workspaces: [{ id: 'ws-blog', title: 'blog', intro: 'Astro migration' }],
      now,
    })
    assert.ok(!prompt.user.includes('INJECTED-MEMORY-SNAPSHOT'), 'context items stay out of the prompt')
    assert.ok(!prompt.user.includes('SECRET-TOOL-RESULT'), 'tool results are elided')
    assert.ok(prompt.user.includes('→ read_report'), 'tool calls render as one line')
    assert.ok(prompt.user.includes('User: 以后周报都用中文写') && prompt.user.includes('Assistant: 好的'), 'user and assistant text kept')
    assert.ok(prompt.user.includes('Prefer short answers'), 'current USER.md included')
    assert.ok(prompt.user.includes('ws-blog · blog · Astro migration'), 'workspace list with intro included')
    assert.ok(prompt.user.includes('Today is 2026-10-22'), 'absolute date given')
    assert.match(prompt.system, /usually nothing is worth saving/i)
    assert.match(prompt.system, /"user_now"/)

    const long = Array.from({ length: 400 }, (_, index) => ({ role: 'user', text: `turn-${index} ${'x'.repeat(1000)}` }))
    const tail = buildFlushPrompt({ transcript: long, now }).user
    assert.ok(tail.includes('turn-399'), 'the newest turn is kept')
    assert.ok(!tail.includes('turn-0 '), 'the oldest turns are dropped')
    const section = tail.split('# Recent conversation\n')[1].split('\n\nAnswer with')[0]
    assert.ok(charLength(section) <= FLUSH_TRANSCRIPT_CHARS, 'transcript tail fits the limit')
    console.log('ok 3 — prompt drops context items, elides tool results, keeps the newest 160K chars')
  }

  // 4. Parse.
  {
    const answer = [
      'Here you go:',
      '```json',
      JSON.stringify({
        daily: [{ text: 'a'.repeat(400) }, { text: '  ' }, 'plain string entry'],
        user_now: ['one', 'two', 'three', 'four', 'five', 'six'],
        workspace_intros: { 'ws-blog': 'b'.repeat(250), 'ws-ghost': 'unknown workspace' },
      }),
      '```',
    ].join('\n')
    const parsed = parseFlushOutput(answer, { workspaceIds: ['ws-blog'] })
    assert.equal(parsed.daily.length, 2, 'blank entries dropped, string entries accepted')
    assert.equal(charLength(parsed.daily[0].text), 300, 'daily text clipped to 300')
    assert.deepEqual(parsed.user_now, ['one', 'two', 'three', 'four', 'five'], 'user_now capped at 5')
    assert.deepEqual(Object.keys(parsed.workspace_intros), ['ws-blog'], 'unknown workspace ids dropped')
    assert.equal(charLength(parsed.workspace_intros['ws-blog']), 200, 'intro clipped to 200')

    const quiet = parseFlushOutput('{"daily": [], "user_now": null, "workspace_intros": {}}')
    assert.deepEqual(quiet, { daily: [], user_now: null, workspace_intros: {} })
    assert.equal(parseFlushOutput('{"daily": [], "user_now": []}').user_now, null, 'empty Now list keeps Now unchanged')
    assert.throws(() => parseFlushOutput('nothing to save'), SyntaxError)
    assert.throws(() => parseFlushOutput('{"daily": "not a list"}'), TypeError)
    console.log('ok 4 — parse tolerates fences, drops unknown ids, clips and caps')
  }

  // 5. runFlush applies through the store.
  {
    const store = fakeStore({
      user: '# USER\n\n## Preferences\n\n## Now\n- 做鲸鱼 memory [source: session:main#t1; added: 2026-10-20]\n',
      cards: { 'ws-blog': { intro: 'old' } },
    })
    let request
    const complete = async (input) => {
      request = input
      return JSON.stringify({
        daily: [{ text: '用户希望周报都用中文写' }],
        user_now: ['本周优先完成 dream 模块'],
        workspace_intros: { 'ws-blog': '个人博客，正在迁移到 Astro，下一步 RSS', 'ws-broken': 'x', 'ws-unknown': 'y' },
      })
    }
    const signal = new AbortController().signal
    const result = await runFlush({
      homeDir: home,
      transcript: [{ role: 'user', text: '以后周报都用中文写' }],
      complete,
      store,
      now,
      source: 'session:main#t42',
      workspaces: [{ id: 'ws-blog', title: 'blog' }, { id: 'ws-broken', title: 'broken' }],
      signal,
    })
    assert.deepEqual(result, { ok: true, daily: 1, now: 1, intros: 1, introErrors: 1 })
    assert.equal(request.signal, signal, 'signal passed to the model')
    assert.ok(request.user.includes('ws-blog · blog · old'), 'card intro merged into the workspace list')
    assert.deepEqual(store.calls.appendDaily[0], {
      day: '2026-10-22',
      entries: [{ text: '用户希望周报都用中文写', meta: { source: 'session:main#t42', added: '2026-10-22' } }],
    })
    assert.deepEqual(store.calls.replaceNow[0].entries, [{ text: '本周优先完成 dream 模块', meta: { source: 'session:main#t42', added: '2026-10-22' } }])
    assert.equal(store.calls.replaceNow[0].source, 'session:main#t42')
    assert.equal(store.cards['ws-blog'].intro, '个人博客，正在迁移到 Astro，下一步 RSS')
    assert.ok(!store.calls.setWorkspaceIntro.some((call) => call.workspaceId === 'ws-unknown'), 'unknown id never reaches the store')
    assert.equal((await readCursor(home)).lastFlushAt, now.toISOString(), 'cursor records the flush')

    const quietStore = fakeStore()
    const quiet = await runFlush({ homeDir: home, transcript: [], complete: async () => '{"daily":[],"user_now":null,"workspace_intros":{}}', store: quietStore, now })
    assert.deepEqual(quiet, { ok: true, daily: 0, now: null, intros: 0, introErrors: 0 })
    assert.equal(quietStore.calls.appendDaily.length + quietStore.calls.replaceNow.length, 0, 'nothing to save writes nothing')
    console.log('ok 5 — runFlush appends daily, replaces Now, sets intros, counts intro errors, moves the cursor')
  }

  // 6. runFlush never throws.
  {
    await writeCursor(home, { lastFlushAt: 'before' })
    const store = fakeStore()
    const rejected = await runFlush({ homeDir: home, transcript: [], complete: async () => { throw new Error('provider down') }, store, now })
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /provider down/)
    const garbled = await runFlush({ homeDir: home, transcript: [], complete: async () => 'I could not decide', store, now })
    assert.equal(garbled.ok, false, 'unparsable answer reports failure')
    assert.equal((await readCursor(home)).lastFlushAt, 'before', 'a failed flush leaves the cursor for the next attempt')
    assert.equal(store.calls.appendDaily.length, 0)
    console.log('ok 6 — runFlush returns ok:false without throwing when the model fails')
  }
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log('\nAll memory-flush checks passed.')
