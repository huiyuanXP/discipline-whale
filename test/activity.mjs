/**
 * Tests for activity.js: workspace cards, conversation entries, tags, bootstrap.
 *
 * Run: node test/activity.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PALETTE,
  buildBootstrap,
  conversationEntries,
  defaultColor,
  historyCount,
  readTags,
  readWorkspaceCards,
  recordUserTurn,
  renderConversations,
  renderWorkspaces,
  setWorkspaceColor,
  setWorkspaceIntro,
  tagTurn,
} from '../activity.js'
import { charLength, clip, parseEntry } from '../entry.js'
import { dataDir } from '../store.js'

const root = await mkdtemp(join(tmpdir(), 'dw-activity-'))
let fresh = 0
const newHome = async () => mkdtemp(join(root, `h${fresh++}-`))
const pass = (name) => console.log(`pass  ${name}`)

try {
  // 1. palette and default color
  {
    assert.equal(PALETTE.length, 8)
    assert.equal(new Set(PALETTE).size, 8)
    for (const color of PALETTE) assert.match(color, /^#[0-9A-F]{6}$/)
    assert.equal(defaultColor('ws-abc'), defaultColor('ws-abc'))
    assert.ok(PALETTE.includes(defaultColor('ws-abc')))
    const used = new Set(Array.from({ length: 200 }, (_, i) => defaultColor(`ws-${i}`)))
    assert.ok(used.size >= 6)
    pass('palette + defaultColor')
  }

  // 2. historyCount boundaries
  {
    assert.deepEqual([0, 1, 12, 13, 20].map(historyCount), [5, 5, 5, 6, 8])
    pass('historyCount boundaries')
  }

  // 3. cards: intro, color, concurrency, missing file
  {
    const home = await newHome()
    assert.deepEqual(await readWorkspaceCards(home), {})
    const card = await setWorkspaceIntro(home, 'ws-a', '  个人博客，正在迁移到 Astro  ', { now: new Date(2026, 9, 21, 12) })
    assert.deepEqual(card, { intro: '个人博客，正在迁移到 Astro', color: defaultColor('ws-a'), updatedAt: '2026-10-21' })
    await setWorkspaceColor(home, 'ws-a', '#aabbcc')
    await setWorkspaceIntro(home, 'ws-a', '新的介绍', { now: new Date(2026, 9, 22) })
    const cards = await readWorkspaceCards(home)
    assert.equal(cards['ws-a'].color, '#aabbcc')
    assert.equal(cards['ws-a'].intro, '新的介绍')
    assert.equal(cards['ws-a'].updatedAt, '2026-10-22')

    await assert.rejects(setWorkspaceIntro(home, 'ws-a', '   '), /empty/)
    await assert.rejects(setWorkspaceIntro(home, 'ws-a', '字'.repeat(201)), /shorten it to ≤200/)
    assert.equal((await setWorkspaceIntro(home, 'ws-a', '字'.repeat(200))).intro.length, 200)
    // code points, not UTF-16 units: 200 astral characters are accepted
    await setWorkspaceIntro(home, 'ws-a', '😀'.repeat(200))
    await assert.rejects(setWorkspaceIntro(home, 'ws-a', '😀'.repeat(201)), /shorten/)

    for (const bad of ['#12345', '123456', '#12345g', 'red', '#1234567', undefined]) {
      await assert.rejects(setWorkspaceColor(home, 'ws-a', bad), /#RRGGBB/, String(bad))
    }
    await setWorkspaceColor(home, 'ws-b', '#00FF00')
    assert.deepEqual((await readWorkspaceCards(home))['ws-b'], { intro: '', color: '#00FF00' })

    // concurrent writers to different workspaces do not lose updates
    const parallel = await newHome()
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => setWorkspaceIntro(parallel, `ws-${i}`, `intro ${i}`, { now: new Date(2026, 0, 1) })),
    )
    const all = await readWorkspaceCards(parallel)
    assert.equal(Object.keys(all).length, 25)
    assert.equal(all['ws-17'].intro, 'intro 17')

    // a corrupt file is never overwritten by a writer, and reads as {}
    const broken = await newHome()
    await mkdir(join(dataDir(broken), 'memory-state'), { recursive: true })
    await writeFile(join(dataDir(broken), 'memory-state', 'workspaces.json'), '{oops')
    assert.deepEqual(await readWorkspaceCards(broken), {})
    await assert.rejects(setWorkspaceIntro(broken, 'ws-a', 'x'), /not valid JSON/)
    assert.equal(await readFile(join(dataDir(broken), 'memory-state', 'workspaces.json'), 'utf8'), '{oops')
    pass('cards: intro/color/concurrency')
  }

  // 4. renderWorkspaces incl. missing card
  {
    const workspaces = [
      { id: 'ws-a', title: 'blog', path: '/w/blog' },
      { id: 'ws-b', title: 'whale', path: '/w/whale' },
    ]
    const out = renderWorkspaces(workspaces, { 'ws-a': { intro: '个人博客', color: '#000000', updatedAt: '2026-10-21' } })
    assert.equal(out, '## 工作区\n- blog · 个人博客 [id: ws-a; updated: 2026-10-21]\n- whale · （待补充） [id: ws-b]')
    assert.deepEqual(parseEntry(out.split('\n')[1]).meta, { id: 'ws-a', updated: '2026-10-21' })
    assert.equal(renderWorkspaces([], {}), '')
    assert.equal(renderWorkspaces(workspaces, { 'ws-b': { intro: '', color: '#111111' } }).split('\n')[2], '- whale · （待补充） [id: ws-b]')
    assert.equal(renderWorkspaces(workspaces, {}), renderWorkspaces(workspaces, {}))
    pass('renderWorkspaces (missing card, empty list)')
  }

  // 5. conversation classification
  const iso = (day, hour = 10) => new Date(2026, 9, day, hour, 5).toISOString()
  const dispatch = (n, extra = {}) => ({
    dispatchId: `d-${n}`,
    workerSessionId: `session-9c1e4b0a-${n}`,
    workspaceId: 'ws-a',
    workspaceTitle: 'blog',
    startedAt: iso(n),
    task: `task body number ${n} `.repeat(10),
    ...extra,
  })
  const report = (n, extra = {}) => ({
    id: `r-${n}`,
    dispatchId: `d-${n}`,
    workspaceTitle: 'blog',
    status: 'reported',
    outcome: 'done',
    summary: `summary ${n}`,
    reportedAt: iso(n, 18),
    ...extra,
  })
  {
    const dispatches = [
      dispatch(1, { title: 'Fix build' }),
      dispatch(2, { topic: 'rss migration' }),
      dispatch(3),
      dispatch(4, { status: 'abandoned' }),
      dispatch(5, { abandoned: true }),
      dispatch(6),
      dispatch(7),
    ]
    const reports = [
      report(1),
      report(3, { status: 'pending' }),
      report(6, { status: 'abandoned', outcome: 'abandoned' }),
      report(7, { status: 'delivered' }),
    ]
    const { running, history } = conversationEntries({ dispatches, reports })
    // d-1 reported, d-4/d-5 abandoned, d-6 abandoned report, d-7 delivered: only d-2 and d-3 run
    assert.deepEqual(running.map((entry) => entry.meta.dispatch), ['d-3', 'd-2'])
    assert.equal(running[1].text, '[blog] rss migration — 进行中')
    assert.equal(running[0].text, `[blog] ${clip('task body number 3 '.repeat(10), 60)} — 进行中`)
    assert.equal(running[1].meta.session, '9c1e4b0a')
    assert.match(running[1].meta.started, /^2026-10-02 10:05$/)
    assert.ok(running.every((entry) => charLength(entry.text) <= 240))
    // history: terminal reports only (pending excluded), newest first
    assert.deepEqual(history.map((entry) => entry.meta.report), ['r-7', 'r-6', 'r-1'])
    assert.equal(history[2].text, '[blog] Fix build — done：summary 1')
    assert.equal(history[2].meta.ended, '2026-10-01')
    assert.equal(history[1].text, '[blog] abandoned：summary 6')

    // latest report per dispatch wins
    const dup = conversationEntries({
      dispatches: [dispatch(1)],
      reports: [report(1, { id: 'r-old', reportedAt: iso(2) }), report(1, { id: 'r-new', reportedAt: iso(9) })],
    })
    assert.deepEqual(dup.history.map((entry) => entry.meta.report), ['r-new'])
    assert.equal(dup.running.length, 0)

    // a report whose dispatch record is gone still lands in history; long labels are clipped to 240
    const orphan = conversationEntries({
      dispatches: [dispatch(8, { title: '题'.repeat(500), workspaceTitle: 'w'.repeat(200) })],
      reports: [report(9, { summary: '字'.repeat(300) })],
    })
    assert.equal(charLength(orphan.running[0].text), 240)
    assert.ok(orphan.running[0].text.endsWith('… — 进行中'))
    assert.equal(orphan.history[0].text, `[blog] done：${'字'.repeat(119)}…`)
    pass('conversation classification (running/history/abandoned)')
  }

  // 6. renderConversations: history window
  {
    const mk = (n) => ({ text: `entry ${n}`, meta: { n } })
    const lines = (text) => text.split('\n').filter((line) => line.startsWith('- '))
    const history = Array.from({ length: 10 }, (_, i) => mk(i))
    const few = renderConversations({ running: [], history: history.slice(0, 3) })
    assert.equal(lines(few).length, 3)
    assert.ok(!few.includes('正在进行的对话'))
    const base = renderConversations({ running: [], history })
    assert.equal(lines(base).length, 5)
    const running13 = Array.from({ length: 13 }, (_, i) => mk(100 + i))
    const text = renderConversations({ running: running13, history: Array.from({ length: 12 }, (_, i) => mk(i)) })
    assert.equal(lines(text).length, 13 + 6)
    assert.ok(text.startsWith('## 正在进行的对话\n'))
    assert.ok(text.includes('\n\n## 最近结束的对话\n'))
    assert.equal(renderConversations({ running: [], history: [] }), '')
    assert.equal(renderConversations({ running: running13.slice(0, 1), history: [] }), '## 正在进行的对话\n- entry 100 [n: 100]')
    pass('renderConversations (history window, omitted headings)')
  }

  // 7. tags
  {
    const home = await newHome()
    assert.deepEqual(await readTags(home), [])
    await recordUserTurn(home, { sessionId: 's1', turn: 1, messageId: 'm1', text: '把博客 RSS 迁到 Astro', at: '2026-10-21T10:00:00.000Z' })
    await recordUserTurn(home, { sessionId: 's1', turn: 2, messageId: 'm2', text: '同时修一下 whale 的测试', at: '2026-10-21T11:00:00.000Z' })
    await recordUserTurn(home, { sessionId: 's1', turn: 3, messageId: 'm3', text: '没派工的闲聊', at: '2026-10-21T12:00:00.000Z' })
    await recordUserTurn(home, { sessionId: 's1', turn: 4, messageId: 'm4', text: 'x'.repeat(500), at: '2026-10-21T13:00:00.000Z' })
    await tagTurn(home, { sessionId: 's1', turn: 1, workspaceId: 'ws-blog', dispatchId: 'd-1' })
    await tagTurn(home, { sessionId: 's1', turn: 2, workspaceId: 'ws-blog', dispatchId: 'd-2' })
    await tagTurn(home, { sessionId: 's1', turn: 2, workspaceId: 'ws-whale', dispatchId: 'd-3' })
    await tagTurn(home, { sessionId: 's1', turn: 2, workspaceId: 'ws-whale', dispatchId: 'd-3' })
    await tagTurn(home, { sessionId: 's1', turn: 4, workspaceId: 'ws-blog', dispatchId: 'd-4' })
    // a tag whose turn record is missing, and an unparsable line
    await tagTurn(home, { sessionId: 's1', turn: 9, workspaceId: 'ws-blog', dispatchId: 'd-9', at: '2026-10-21T20:00:00.000Z' })
    await writeFile(join(dataDir(home), 'memory-state', 'tags.jsonl'), 'not json\n', { flag: 'a' })

    const all = await readTags(home)
    assert.deepEqual(all.map((r) => r.turn), [1, 2, 3, 4, 9])
    const two = all[1]
    assert.deepEqual(two.workspaces, ['ws-blog', 'ws-whale'])
    assert.deepEqual(two.dispatches, ['d-2', 'd-3'])
    assert.equal(two.messageId, 'm2')
    assert.equal(two.text, '同时修一下 whale 的测试')
    assert.deepEqual(all[2].workspaces, [])
    assert.equal(all[3].text.length, 200)
    assert.ok(all[3].text.endsWith('…'))
    assert.equal(all[4].text, '')
    assert.deepEqual(all[4].dispatches, ['d-9'])

    const blog = await readTags(home, { workspaceId: 'ws-blog' })
    assert.deepEqual(blog.map((r) => r.turn), [1, 2, 4, 9])
    assert.deepEqual((await readTags(home, { workspaceId: 'ws-whale' })).map((r) => r.turn), [2])
    assert.deepEqual((await readTags(home, { workspaceId: 'ws-none' })), [])
    assert.deepEqual((await readTags(home, { workspaceId: 'ws-blog', limit: 2 })).map((r) => r.turn), [4, 9])
    assert.deepEqual((await readTags(home, { limit: 1 })).map((r) => r.turn), [9])
    pass('tags (multi-workspace turn, filter, limit, missing turn, bad line)')
  }

  // 8. bootstrap
  {
    const workspace = { id: 'ws-blog', title: 'blog' }
    const empty = await newHome()
    assert.equal(await buildBootstrap(empty, { workspace, reports: [] }), '')

    const home = await newHome()
    await setWorkspaceIntro(home, 'ws-blog', '个人博客，迁移到 Astro', { now: new Date(2026, 9, 21) })
    const intro = await buildBootstrap(home, { workspace, reports: [] })
    assert.equal(intro, '## 工作区背景\n- blog · 个人博客，迁移到 Astro [updated: 2026-10-21]')

    // 12 tagged turns -> only the 8 most recent, chronological; 5 reports -> 3 most recent
    for (let i = 1; i <= 12; i += 1) {
      const at = `2026-10-${String(i).padStart(2, '0')}T10:00:00.000Z`
      await recordUserTurn(home, { sessionId: 's', turn: i, messageId: `m${i}`, text: `用户消息 ${i}`, at })
      await tagTurn(home, { sessionId: 's', turn: i, workspaceId: 'ws-blog', dispatchId: `d-${i}`, at })
    }
    const reports = Array.from({ length: 5 }, (_, i) => report(i + 1, { workspaceId: 'ws-blog' }))
    const block = await buildBootstrap(home, { workspace, reports })
    const bullets = block.split('\n').filter((line) => line.startsWith('- '))
    const msgs = bullets.filter((line) => line.includes('用户消息'))
    assert.deepEqual(msgs.map((line) => parseEntry(line).text), Array.from({ length: 8 }, (_, i) => `用户消息 ${i + 5}`))
    const sums = bullets.filter((line) => line.includes('summary'))
    assert.deepEqual(sums.map((line) => parseEntry(line).meta.report_id), ['r-3', 'r-4', 'r-5'])
    assert.ok(charLength(block) <= 3000)

    // budget trimming: oldest tags go first, then oldest reports
    const big = await newHome()
    await setWorkspaceIntro(big, 'ws-blog', '介'.repeat(200), { now: new Date(2026, 9, 21) })
    for (let i = 1; i <= 12; i += 1) {
      const at = `2026-10-${String(i).padStart(2, '0')}T10:00:00.000Z`
      await recordUserTurn(big, { sessionId: 's', turn: i, messageId: `m${i}`, text: `${i}`.padStart(3, '0') + '话'.repeat(300), at })
      await tagTurn(big, { sessionId: 's', turn: i, workspaceId: 'ws-blog', at })
    }
    const long = Array.from({ length: 3 }, (_, i) => report(i + 1, { summary: `S${i + 1}` + '述'.repeat(400) }))
    const trimmed = await buildBootstrap(big, { workspace, reports: long })
    assert.ok(charLength(trimmed) <= 3000, `len ${charLength(trimmed)}`)
    assert.ok(trimmed.includes('r-1') && trimmed.includes('r-2') && trimmed.includes('r-3'), 'reports survive while tags can be dropped')
    assert.ok(trimmed.includes('012话') || trimmed.includes('011话'), 'newest tags survive')
    assert.ok(!trimmed.includes('005话'), 'oldest tag dropped first')
    const tagCount = (trimmed.match(/\d{3}话/g) ?? []).length
    assert.ok(tagCount < 8 && tagCount > 0)

    // when the tags alone cannot fix it, reports lose their oldest first
    const hugeReports = Array.from({ length: 3 }, (_, i) => report(i + 1, { summary: `S${i + 1}` + '述'.repeat(400) }))
    const noTags = await newHome()
    await setWorkspaceIntro(noTags, 'ws-blog', '介'.repeat(200), { now: new Date(2026, 9, 21) })
    const small = await buildBootstrap(noTags, { workspace, reports: hugeReports })
    assert.ok(small.includes('r-1') && small.includes('r-3'), 'within budget nothing is dropped')
    assert.equal(await buildBootstrap(noTags, { workspace: { id: 'ws-other' }, reports: [] }), '')
    pass('bootstrap (limits, trimming order, empty)')
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
