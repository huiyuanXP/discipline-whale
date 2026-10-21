/**
 * Tests for discipline-whale memory layers (memory.js).
 *
 *   1. a missing layer reads as a seeded template
 *   2. remember add / duplicate / replace / remove, and the match errors
 *   3. a budget overflow lists every current entry
 *   4. writeLayer rejects a stale expectHash and an over-budget text
 *   5. replaceNow rotates the previous Now into the daily note and enforces its limits
 *   6. daily notes append, read back and list
 *   7. the injection text skips empty blocks, truncates with a marker, is deterministic
 *   8. updateInstructions quote gate and byte preservation
 *   9. importAutoMemory maps types and is idempotent
 *  10. concurrent writes to one layer do not lose entries
 *
 * Run: node test/memory.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { charLength, parseSections, sectionEntries } from '../entry.js'
import {
  LAYERS,
  MemoryBudgetError,
  MemoryConflictError,
  NOW_BUDGET,
  appendDaily,
  importAutoMemory,
  instructionsPath,
  layerPath,
  listDailyDays,
  loadMemorySection,
  memoryDir,
  readDaily,
  readLayer,
  remember,
  renderMemorySection,
  replaceNow,
  updateInstructions,
  writeLayer,
} from '../memory.js'
import { whaleHomeDir } from '../store.js'

const root = await mkdtemp(join(tmpdir(), 'whale-memory-'))
const now = new Date(2026, 9, 21, 12)
const later = new Date(2026, 9, 22, 9)
let fresh = 0

/** A new DSH root per group, so groups cannot see each other's files. */
async function home() {
  fresh += 1
  const dir = join(root, `dsh-${fresh}`)
  await mkdir(dir, { recursive: true })
  return dir
}

function pass(label) {
  console.log(`ok - ${label}`)
}

try {
  // 1 -------------------------------------------------------------------------
  {
    const dsh = await home()
    assert.equal(memoryDir(dsh), join(whaleHomeDir(dsh), 'memory'))
    const user = await readLayer(dsh, 'user')
    assert.match(user.text, /^# USER\n.+\n\n## Preferences\n\n## Now\n$/)
    assert.equal(user.hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.deepEqual(user.doc.sections.map((section) => section.heading), ['Preferences', 'Now'])
    assert.match((await readLayer(dsh, 'soul')).text, /^# SOUL\n.+\n\n## Voice\n$/)
    assert.match((await readLayer(dsh, 'memory')).text, /^# MEMORY\n.+\n\n## Facts\n$/)
    await assert.rejects(readLayer(dsh, 'nope'), /Unknown memory target/)
    await assert.rejects(stat(layerPath(dsh, 'user')), { code: 'ENOENT' })
    pass('missing layer reads as seeded template')
  }

  // 2 -------------------------------------------------------------------------
  {
    const dsh = await home()
    const first = await remember(dsh, { target: 'user', op: 'add', text: 'Prefer conclusions first', source: 'user', now })
    assert.equal(first.ok, true)
    assert.equal(first.budget, 4000)
    assert.deepEqual(first.entry, { text: 'Prefer conclusions first', meta: { source: 'user', added: '2026-10-21' } })
    let text = await readFile(layerPath(dsh, 'user'), 'utf8')
    assert.equal(first.chars, charLength(text))
    assert.match(text, /## Preferences\n- Prefer conclusions first \[source: user; added: 2026-10-21\]\n\n## Now\n$/)

    const twin = await remember(dsh, { target: 'user', op: 'add', text: '  prefer   CONCLUSIONS first ', now })
    assert.equal(twin.duplicate, true)
    assert.equal(await readFile(layerPath(dsh, 'user'), 'utf8'), text)

    await remember(dsh, { target: 'user', op: 'add', text: 'Never paste audit details to the user', source: 'session:m#t3', now })
    await remember(dsh, { target: 'user', op: 'add', text: 'Shipping the memory system this week', section: 'Now', now })
    const doc = (await readLayer(dsh, 'user')).doc
    assert.deepEqual(sectionEntries(doc, 'Preferences').map((entry) => entry.text), ['Prefer conclusions first', 'Never paste audit details to the user'])
    assert.deepEqual(sectionEntries(doc, 'Now').map((entry) => entry.text), ['Shipping the memory system this week'])

    const replaced = await remember(dsh, { target: 'user', op: 'replace', match: 'audit details', text: 'Never paste code-level audit details to the user', now: later })
    assert.deepEqual(replaced.entry.meta, { source: 'session:m#t3', added: '2026-10-22' })
    const resourced = await remember(dsh, { target: 'user', op: 'replace', match: 'code-level', text: 'Never paste audit details', source: 'user', now: later })
    assert.equal(resourced.entry.meta.source, 'user')

    await assert.rejects(remember(dsh, { target: 'user', op: 'remove', match: 'does-not-exist', now }), /No entry in USER.md contains "does-not-exist"/)
    await assert.rejects(
      remember(dsh, { target: 'user', op: 'remove', match: 'e', now }),
      (error) => /matches 3 entries in USER.md/.test(error.message) && error.message.includes('- Prefer conclusions first'),
    )
    await assert.rejects(remember(dsh, { target: 'user', op: 'add', text: 'x', section: 'Facts', now }), /no section "Facts"/)
    await assert.rejects(remember(dsh, { target: 'user', op: 'merge', text: 'x', now }), /Unknown remember op/)

    const removed = await remember(dsh, { target: 'user', op: 'remove', match: 'conclusions', now })
    assert.equal(removed.entry.text, 'Prefer conclusions first')
    text = await readFile(layerPath(dsh, 'user'), 'utf8')
    assert.doesNotMatch(text, /conclusions/)
    assert.match(text, /^# USER\n/)

    const soul = await remember(dsh, { target: 'soul', op: 'add', text: 'Dry humour, short sentences', source: 'user', now })
    assert.equal(soul.budget, 2000)
    assert.match(await readFile(layerPath(dsh, 'soul'), 'utf8'), /## Voice\n- Dry humour/)
    const fact = await remember(dsh, { target: 'memory', op: 'add', text: 'The main session has no write permission', now })
    assert.deepEqual(fact.entry.meta, { source: 'unknown', added: '2026-10-21' })
    assert.match(await readFile(layerPath(dsh, 'memory'), 'utf8'), /## Facts\n- The main session has no write permission \[source: unknown; added: 2026-10-21\]\n$/)
    pass('remember add / duplicate / replace / remove and match errors')
  }

  // 3 -------------------------------------------------------------------------
  {
    const dsh = await home()
    const long = 'x'.repeat(800)
    await remember(dsh, { target: 'soul', op: 'add', text: `alpha ${long}`, source: 'user', now })
    await remember(dsh, { target: 'soul', op: 'add', text: `beta ${long}`, source: 'user', now })
    const before = await readFile(layerPath(dsh, 'soul'), 'utf8')
    await assert.rejects(remember(dsh, { target: 'soul', op: 'add', text: `gamma ${long}`, now }), (error) => {
      assert.ok(error instanceof MemoryBudgetError)
      assert.match(error.message, /^SOUL\.md would be \d+\/2000 chars\. Merge or remove entries in ONE remember call, then retry\./)
      assert.ok(error.message.includes(`- alpha ${long}`))
      assert.ok(error.message.includes(`- beta ${long}`))
      assert.ok(!error.message.includes('gamma'))
      assert.ok(error.chars > error.budget)
      return true
    })
    assert.equal(await readFile(layerPath(dsh, 'soul'), 'utf8'), before)
    pass('budget overflow lists every current entry and writes nothing')
  }

  // 4 -------------------------------------------------------------------------
  {
    const dsh = await home()
    const { text, hash } = await readLayer(dsh, 'memory')
    await writeLayer(dsh, 'memory', `${text}- first fact\n`, { expectHash: hash })
    await assert.rejects(writeLayer(dsh, 'memory', `${text}- second fact\n`, { expectHash: hash }), (error) => {
      assert.ok(error instanceof MemoryConflictError)
      assert.match(error.message, /MEMORY\.md changed on disk/)
      return true
    })
    const reread = await readLayer(dsh, 'memory')
    assert.match(reread.text, /- first fact\n$/)
    await assert.rejects(writeLayer(dsh, 'memory', 'y'.repeat(LAYERS.memory.budget + 1), { expectHash: reread.hash }), MemoryBudgetError)
    await writeLayer(dsh, 'memory', `${reread.text}- third fact\n`)
    assert.match(await readFile(layerPath(dsh, 'memory'), 'utf8'), /- third fact\n$/)
    pass('writeLayer rejects stale expectHash and over-budget text')
  }

  // 5 -------------------------------------------------------------------------
  {
    const dsh = await home()
    await remember(dsh, { target: 'user', op: 'add', text: 'Prefer tables', source: 'user', now })
    const first = await replaceNow(dsh, ['Finishing memory', { text: 'Then voice UI', meta: { source: 'session:m#t9' } }], { now, source: 'session:m#t8' })
    assert.deepEqual(first.rotated, [])
    let doc = (await readLayer(dsh, 'user')).doc
    assert.deepEqual(sectionEntries(doc, 'Now'), [
      { text: 'Finishing memory', meta: { source: 'session:m#t8', added: '2026-10-21' }, links: [] },
      { text: 'Then voice UI', meta: { source: 'session:m#t9', added: '2026-10-21' }, links: [] },
    ])
    await writeLayer(dsh, 'user', (await readLayer(dsh, 'user')).text.replace(' [source: session:m#t8; added: 2026-10-21]', ' [added: 2026-10-21]'))

    const second = await replaceNow(dsh, ['Small model picks the workspace'], { now: later })
    assert.equal(second.rotated.length, 2)
    doc = (await readLayer(dsh, 'user')).doc
    assert.deepEqual(sectionEntries(doc, 'Now').map((entry) => entry.text), ['Small model picks the workspace'])
    assert.deepEqual(sectionEntries(doc, 'Preferences').map((entry) => entry.text), ['Prefer tables'])
    const daily = await readDaily(dsh, '2026-10-22')
    assert.deepEqual(daily.map((entry) => [entry.text, entry.meta]), [
      ['Finishing memory', { source: 'user-now', added: '2026-10-21', rotated: '2026-10-22' }],
      ['Then voice UI', { source: 'session:m#t9', added: '2026-10-21', rotated: '2026-10-22' }],
    ])

    const userBefore = await readFile(layerPath(dsh, 'user'), 'utf8')
    await assert.rejects(replaceNow(dsh, ['1', '2', '3', '4', '5', '6'], { now }), /at most 5 entries/)
    await assert.rejects(replaceNow(dsh, ['z'.repeat(NOW_BUDGET)], { now }), MemoryBudgetError)
    await assert.rejects(
      remember(dsh, { target: 'user', op: 'add', text: 'w'.repeat(NOW_BUDGET), section: 'Now', now }),
      MemoryBudgetError,
    )
    await writeLayer(dsh, 'user', userBefore.replace('## Now', `- ${'p'.repeat(3500)}\n\n## Now`))
    const nearFull = await readFile(layerPath(dsh, 'user'), 'utf8')
    await assert.rejects(replaceNow(dsh, ['q'.repeat(900)], { now }), (error) => error instanceof MemoryBudgetError && /^USER\.md would be/.test(error.message))
    assert.equal(await readFile(layerPath(dsh, 'user'), 'utf8'), nearFull)
    assert.equal((await readDaily(dsh, '2026-10-21')).length, 0)
    pass('replaceNow rotates into daily and enforces Now and USER limits')
  }

  // 6 -------------------------------------------------------------------------
  {
    const dsh = await home()
    assert.deepEqual(await listDailyDays(dsh), [])
    assert.deepEqual(await readDaily(dsh, '2026-10-20'), [])
    await appendDaily(dsh, [{ text: 'Saw the build fail twice', meta: { source: 'session:m#t1' } }], { day: '2026-10-21' })
    await appendDaily(dsh, [{ text: 'User switched to bun', meta: { source: 'report:r-1' } }, { text: '   ' }], { day: '2026-10-21' })
    await appendDaily(dsh, [{ text: 'Earlier note', meta: {} }], { day: new Date(2026, 9, 19) })
    const path = join(memoryDir(dsh), 'daily', '2026-10-21.md')
    assert.equal(
      await readFile(path, 'utf8'),
      '# 2026-10-21\n\n- Saw the build fail twice [source: session:m#t1]\n- User switched to bun [source: report:r-1]\n',
    )
    assert.deepEqual((await readDaily(dsh, '2026-10-21')).map((entry) => entry.text), ['Saw the build fail twice', 'User switched to bun'])
    assert.deepEqual(await listDailyDays(dsh), ['2026-10-19', '2026-10-21'])
    await assert.rejects(appendDaily(dsh, [{ text: 'x' }], { day: '../escape' }), /YYYY-MM-DD/)
    pass('daily notes append, read back and list')
  }

  // 7 -------------------------------------------------------------------------
  {
    const dsh = await home()
    const empty = await loadMemorySection(dsh)
    assert.match(empty, /home\/memory\//)
    assert.doesNotMatch(empty, /## Soul|## User|## Memory/)

    await remember(dsh, { target: 'user', op: 'add', text: 'Prefer tables', source: 'user', now })
    await remember(dsh, { target: 'memory', op: 'add', text: 'Blog uses bun, see [[workspaces/blog]]', source: 'report:r-1', now })
    const section = await loadMemorySection(dsh)
    assert.match(section, /\[\[path\]\]/)
    assert.match(section, /home\/memory\/daily\//)
    assert.doesNotMatch(section, /## Soul/)
    assert.match(section, /## User\n### Preferences\n- Prefer tables \[source: user; added: 2026-10-21\]\n\n## Memory\n- Blog uses bun/)
    assert.doesNotMatch(section, /### Now/)
    assert.equal(await loadMemorySection(dsh), section)

    const huge = `# MEMORY\nnote\n\n## Facts\n${Array.from({ length: 400 }, (_, index) => `- fact number ${index} 记忆`).join('\n')}\n`
    const layers = { soul: '', user: '', memory: huge }
    const rendered = renderMemorySection(layers)
    assert.equal(renderMemorySection(layers), rendered)
    const marker = /\n\[…已截断 (\d+) 字符…\]\n/.exec(rendered)
    assert.ok(marker !== null)
    assert.match(rendered, /- fact number 0 记忆/)
    assert.match(rendered, /- fact number 399 记忆\n$/)
    const block = rendered.slice(rendered.indexOf('## Memory\n') + '## Memory\n'.length, -1)
    const kept = charLength(block) - charLength(marker[0])
    assert.equal(kept, LAYERS.memory.budget)
    const full = charLength(huge.split('## Facts\n')[1].trimEnd())
    assert.equal(Number(marker[1]), full - LAYERS.memory.budget)
    pass('injection skips empty blocks, truncates head/tail with marker, is deterministic')
  }

  // 8 -------------------------------------------------------------------------
  {
    const dsh = await home()
    const latest = '以后  派工前\n先确认工作区 is clean, please'
    await assert.rejects(
      updateInstructions(dsh, { userQuote: '先确认', latestUserText: latest, op: 'add', text: 'x', now }),
      /user_quote must be the user's own words from this turn/,
    )
    await assert.rejects(
      updateInstructions(dsh, { userQuote: '以后派工前一定要先跑测试', latestUserText: latest, op: 'add', text: 'x', now }),
      /user's own words/,
    )
    await assert.rejects(stat(instructionsPath(dsh)), { code: 'ENOENT' })

    const created = await updateInstructions(dsh, { userQuote: '派工前 先确认工作区', latestUserText: latest, op: 'add', text: 'Check the workspace is clean before dispatching', now })
    assert.equal(created.line, '- Check the workspace is clean before dispatching [source: user; added: 2026-10-21]')
    assert.equal(await readFile(instructionsPath(dsh), 'utf8'), `## 用户要求的规则\n${created.line}\n`)

    const original = '# Whale rules\r\n\r\nKeep   this   spacing.\n\n## Routing\n* Route   by workspace\n  - nested  detail\n\n## 用户要求的规则\n- Old rule [source: user; added: 2026-01-01]\n\n## Tail\ntrailing text without newline'
    await writeFile(instructionsPath(dsh), original, 'utf8')
    const quote = { userQuote: 'is clean, please', latestUserText: latest, now }
    const added = await updateInstructions(dsh, { ...quote, op: 'add', text: 'New rule' })
    const afterAdd = await readFile(instructionsPath(dsh), 'utf8')
    assert.equal(afterAdd, original.replace('2026-01-01]\n', `2026-01-01]\n${added.line}\n`))

    await assert.rejects(updateInstructions(dsh, { ...quote, op: 'remove', match: 'rule' }), /matches 2 rule lines/)
    await assert.rejects(updateInstructions(dsh, { ...quote, op: 'remove', match: 'absent rule' }), /No rule line/)
    const swapped = await updateInstructions(dsh, { ...quote, op: 'replace', match: 'nested', text: 'nested detail, rewritten' })
    assert.equal(swapped.line, '  - nested detail, rewritten [source: user; added: 2026-10-21]')
    await updateInstructions(dsh, { ...quote, op: 'remove', match: 'Old rule' })
    const finalText = await readFile(instructionsPath(dsh), 'utf8')
    assert.equal(
      finalText,
      afterAdd.replace('- Old rule [source: user; added: 2026-01-01]\n', '').replace('  - nested  detail', swapped.line),
    )
    assert.ok(finalText.startsWith('# Whale rules\r\n\r\nKeep   this   spacing.\n'))
    assert.ok(finalText.endsWith('## Tail\ntrailing text without newline'))

    const bare = await home()
    await mkdir(whaleHomeDir(bare), { recursive: true })
    await writeFile(instructionsPath(bare), '# Rules\n- keep me', 'utf8')
    await updateInstructions(bare, { ...quote, op: 'add', text: 'Appended' })
    assert.equal(await readFile(instructionsPath(bare), 'utf8'), '# Rules\n- keep me\n\n## 用户要求的规则\n- Appended [source: user; added: 2026-10-21]\n')
    pass('updateInstructions quote gate, section creation and byte preservation')
  }

  // 9 -------------------------------------------------------------------------
  {
    const dsh = await home()
    const auto = join(root, 'auto-memory')
    await mkdir(auto, { recursive: true })
    const files = {
      'MEMORY.md': '- [whale-a](whale-a.md) — index line that must not be imported\n',
      'whale-a.md': '---\nname: whale-a\ndescription: 禁止用 canvas 做汇报，改用 render_ui\ntype: feedback\ncreated: 1792597990386\nupdated: 1792597990386\n---\n\nbody text\n',
      'whale-b.md': '---\nname: whale-b\ndescription: "Main session cannot write files"\ntype: project\ntitle: Write boundary\ncreated: 1792522667557\nupdated: 1792522667557\n---\n\nignored body\n',
      'whale-c.md': `---\nname: whale-c\ndescription:\ntype: reference\ncreated: 1792594816194\n---\n\n\nFirst paragraph\nspans two lines.\n\nSecond paragraph ${'z'.repeat(400)}\n`,
      'whale-d.md': `---\nname: whale-d\ndescription: ${'长'.repeat(400)}\ntype: user\ncreated: 1792594816194\n---\nbody\n`,
      'notes.txt': 'not markdown',
    }
    for (const [name, text] of Object.entries(files)) await writeFile(join(auto, name), text, 'utf8')
    const snapshot = async () => Promise.all((await readdir(auto)).sort().map(async (name) => [name, await readFile(join(auto, name), 'utf8')]))
    const before = await snapshot()

    const imported = await importAutoMemory(dsh, auto)
    assert.equal(imported.length, 4)
    const day = (ms) => {
      const date = new Date(ms)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }
    const user = (await readLayer(dsh, 'user')).doc
    const memory = (await readLayer(dsh, 'memory')).doc
    const prefs = sectionEntries(user, 'Preferences')
    assert.deepEqual(prefs.map((entry) => entry.meta.source), ['dsh-auto-memory:whale-a', 'dsh-auto-memory:whale-d'])
    assert.equal(prefs[0].text, 'whale-a: 禁止用 canvas 做汇报，改用 render_ui')
    assert.equal(prefs[0].meta.added, day(1792597990386))
    assert.equal(charLength(prefs[1].text), 300)
    assert.ok(prefs[1].text.endsWith('…'))
    const facts = sectionEntries(memory, 'Facts')
    assert.deepEqual(facts.map((entry) => entry.text), ['Write boundary: Main session cannot write files', 'whale-c: First paragraph spans two lines.'])
    assert.deepEqual(facts[0].meta, { source: 'dsh-auto-memory:whale-b', added: day(1792522667557) })
    assert.ok(!JSON.stringify([prefs, facts]).includes('index line'))

    assert.deepEqual(await importAutoMemory(dsh, auto), [])
    assert.equal(sectionEntries((await readLayer(dsh, 'user')).doc, 'Preferences').length, 2)
    assert.deepEqual(await snapshot(), before)
    assert.deepEqual(parseSections(await readFile(layerPath(dsh, 'memory'), 'utf8')).sections.map((section) => section.heading), ['Facts'])
    pass('importAutoMemory maps types, clips, and is idempotent without touching the source')
  }

  // 10 ------------------------------------------------------------------------
  {
    const dsh = await home()
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => remember(dsh, { target: 'memory', op: 'add', text: `parallel fact ${index}`, now })),
    )
    const facts = sectionEntries((await readLayer(dsh, 'memory')).doc, 'Facts')
    assert.equal(facts.length, 20)
    assert.equal(new Set(facts.map((entry) => entry.text)).size, 20)
    await Promise.all([
      appendDaily(dsh, [{ text: 'a' }], { day: '2026-10-21' }),
      appendDaily(dsh, [{ text: 'b' }], { day: '2026-10-21' }),
      appendDaily(dsh, [{ text: 'c' }], { day: '2026-10-21' }),
    ])
    assert.deepEqual((await readDaily(dsh, '2026-10-21')).map((entry) => entry.text), ['a', 'b', 'c'])
    pass('concurrent writes to one file are serialized')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('memory: all groups passed')
