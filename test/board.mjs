/**
 * The activity board: the interest rule, mentions, the budget, the once-per-
 * human-turn refresh, and the workspace notes.
 *
 *   1. activeWorkspaces: running is always active; the window is 8 human turns
 *      and pushes do not count; a mention is a touch; at most 4 active, unless
 *      more than 4 have running dispatches
 *   2. mentionedWorkspaces: title, path basename and the id's first 8
 *      characters match; titles under 3 characters do not; case-insensitive
 *   3. renderBoard: at most 2,000 characters; the last line names the inactive
 *      workspaces; over budget, deliveries go before labels shorten
 *   4. ten dispatch, report and read_report events between two human messages
 *      give the activity context only 2 distinct texts
 *   5. a `claimed` listener that is not awaited, followed at once by pre-step,
 *      still renders the workspace the message named
 *   6. the memory section carries SOUL / USER / MEMORY and no workspace cards
 *   7. after a render, `home/notes/<key>.md` equals renderWorkspaceNote
 *
 * Run: node test/board.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOARD_MAX_CHARS,
  BOARD_WORKSPACE_MAX_CHARS,
  activeWorkspaces,
  mentionedWorkspaces,
  readTagRows,
  readWorkspaceCards,
  recordUserTurn,
  renderBoard,
  renderWorkspaceNote,
  setWorkspaceIntro,
  tagTurn,
  workspaceFacts,
  workspaceNotePath,
} from '../activity.js'
import { isDispatchAbandoned, listDispatchCheckpoints, writeDispatchCheckpoint } from '../checkpoint.js'
import { charLength } from '../entry.js'
import { ACTIVITY_CONTEXT_NAME, MEMORY_SECTION_NAME, installMemory, noteDispatch } from '../memory-row.js'
import { PUSH_PREFIXES } from '../pushes.js'
import { listDispatches, recordDispatch, resetRegistry } from '../registry.js'
import { clearStoreRoot, listReports, setStoreRoot, writeReport } from '../store.js'

const roots = []
const freshRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'whale-board-'))
  roots.push(root)
  setStoreRoot(root)
  resetRegistry()
  return root
}

/** Minute `n` after 2026-10-24 09:00 local, as an ISO string. */
const at = (n) => new Date(2026, 9, 24, 9, n).toISOString()
const ws = (id, title = id, path = `/w/${title}`) => ({ id, title, path, sessionIds: [] })
const turnRow = (n, text = `第 ${n} 句`) => ({ kind: 'turn', sessionId: 'main', turn: n, text, at: at(n) })

/** A fake Host context with the services the memory row reads. */
function host(workspaces) {
  const listeners = new Map()
  const sections = []
  const contexts = []
  const services = {
    workspaceRegistry: { list: () => workspaces },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 0 }) },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    effect: (fn) => fn(),
    get: (key) => services[key],
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return () => {}
    },
    tools: { register: () => () => {} },
    systemPrompt: {
      getSectionOrder: () => 100,
      section: (section) => (sections.push(section), () => {}),
      context: (context) => (contexts.push(context), () => {}),
    },
  }
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) ?? []) await handler(payload, async () => ({ kind: 'continue', messages: [] }))
  }
  const board = () => contexts.find((context) => context.name === ACTIVITY_CONTEXT_NAME).text()
  const memory = () => sections.find((section) => section.name === MEMORY_SECTION_NAME).text()
  return { ctx, emit, board, memory }
}

const agent = {
  session: { id: 'main', header: { agentPreset: 'discipline-whale' }, snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
  options: {},
}
const human = (turn, text) => ({ agent, turn, message: { id: `m-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const step = (h) => h.emit('agent/pre-step', { agent, signal: new AbortController().signal })

try {
  // 1
  {
    const workspaces = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((id) => ws(id))
    const tags = [
      ...Array.from({ length: 10 }, (_, i) => turnRow(i + 1)),
      // Five pushes after turn 8: counted as turns they would move the window past B and E.
      ...[PUSH_PREFIXES.report, PUSH_PREFIXES.failed, PUSH_PREFIXES.startup, PUSH_PREFIXES.wake, PUSH_PREFIXES.rotation].map(
        (prefix, i) => ({ kind: 'turn', sessionId: 'main', turn: 100 + i, text: `${prefix}x`, at: new Date(2026, 9, 24, 9, 8, 10 + i).toISOString() }),
      ),
      { kind: 'tag', sessionId: 'main', turn: 1, workspaceId: 'A', at: at(1) },
      { kind: 'tag', sessionId: 'main', turn: 3, workspaceId: 'G', at: at(3) },
      { kind: 'tag', sessionId: 'main', turn: 4, workspaceId: 'E', at: at(4) },
      { kind: 'mention', sessionId: 'main', turn: 5, workspaceId: 'B', at: at(5) },
    ]
    const reports = [{ id: 'r-c', dispatchId: 'd-c', workspaceId: 'C', status: 'reported', outcome: 'done', summary: 's', reportedAt: at(9) }]
    const dispatches = [{ dispatchId: 'd-d', workspaceId: 'D', workerSessionId: 'session-d', startedAt: at(0) }]
    const { active, inactive } = activeWorkspaces({ workspaces, tags, reports, dispatches })
    // D runs (touched before the window); C, B, E are the most recent touches inside it; G
    // sits on the window's first turn but the limit of 4 is reached; A predates the window.
    assert.deepEqual(active.map((workspace) => workspace.id), ['C', 'B', 'E', 'D'])
    assert.deepEqual(inactive.map((workspace) => workspace.id), ['A', 'F', 'G'])
    assert.deepEqual(
      activeWorkspaces({ workspaces, tags: tags.filter((row) => row.workspaceId !== 'E' && row.workspaceId !== 'C'), reports: [], dispatches }).active.map(
        (workspace) => workspace.id,
      ),
      ['B', 'G', 'D'],
      'the window opens at the 8th most recent human turn, inclusive',
    )
    const crowded = activeWorkspaces({
      workspaces,
      tags,
      reports: [],
      dispatches: ['A', 'B', 'C', 'D', 'E', 'F'].map((id, i) => ({ dispatchId: `d-${id}`, workspaceId: id, workerSessionId: `session-${id}`, startedAt: at(20 + i) })),
    })
    assert.deepEqual(crowded.active.map((workspace) => workspace.id), ['F', 'E', 'D', 'C', 'B', 'A'], 'six running workspaces all stay')
    assert.deepEqual(crowded.inactive.map((workspace) => workspace.id), ['G'])
    console.log('ok 1 — activeWorkspaces: running always active, 8 human turns (pushes skipped), mentions touch, limit 4 unless more run')
  }

  // 2
  {
    const whale = ws('98db8004-1111-2222-3333-444455556666', 'Discipline-Whale', '/Users/x/projects/whale-repo')
    const chat = ws('ws-hc', 'hc', '/Users/x/huichat/')
    const tiny = ws('ws-ab', 'ab', '/x/ab')
    const all = [whale, chat, tiny]
    const ids = (text) => mentionedWorkspaces(text, all).map((workspace) => workspace.id)
    assert.deepEqual(ids('看看 DISCIPLINE-whale 的测试'), [whale.id], 'title, case-insensitive')
    assert.deepEqual(ids('WHALE-REPO 里那个分支'), [whale.id], 'path basename')
    assert.deepEqual(ids('98DB8004 那次派工怎样'), [whale.id], 'first 8 characters of a UUID id')
    assert.deepEqual(ids('HuiChat 登录挂了'), [chat.id], 'basename with a trailing slash')
    assert.deepEqual(ids('hc 和 ab 怎么样'), [], 'titles and basenames under 3 characters do not match')
    assert.deepEqual(ids('ws-ab 的进度'), [tiny.id], 'the full id matches')
    assert.deepEqual(ids('ws-hc 98db8004'), [whale.id, chat.id], 'registry order')
    assert.deepEqual(mentionedWorkspaces('ws-abcde 的进度', [ws('ws-abcdef01', 'zz', '/z')]), [], 'a non-UUID id has no prefix match')
    assert.deepEqual(ids(''), [])
    console.log('ok 2 — mentionedWorkspaces: title, basename, id prefix; short titles skipped; case-insensitive')
  }

  // 3
  {
    // A small board, exact.
    const small = renderBoard({
      workspaces: [ws('ws-whale', 'discipline-whale'), ws('ws-dsh', 'deepseek-harness'), ws('ws-soc', 'soc-api-test'), ws('ws-hui', 'huichat')],
      cards: { 'ws-whale': { intro: 'DSH 插件「自律鲸鱼」，在做渐进压缩' } },
      tags: Array.from({ length: 9 }, (_, i) => turnRow(i + 1)),
      reports: [
        { id: 'r-2', dispatchId: 'd-2', workspaceId: 'ws-whale', status: 'reported', outcome: 'done', label: '报告索引', summary: '索引文件已生成\n细节见文档', reportedAt: at(6) },
        { id: 'r-3', dispatchId: 'd-3', workspaceId: 'ws-dsh', status: 'delivered', outcome: 'partial', summary: '宿主压缩阈值已查明', reportedAt: at(5) },
        { id: 'r-old', dispatchId: 'd-old', workspaceId: 'ws-soc', status: 'reported', outcome: 'done', summary: 'old', reportedAt: at(0) },
      ],
      dispatches: [{ dispatchId: 'd-1', workspaceId: 'ws-whale', workerSessionId: 'session-6adf23f0-aaaa', title: '便签板', startedAt: at(7) }],
    })
    assert.equal(
      small,
      [
        '# 我们正在做什么（按工作区，只列活跃的）',
        '## discipline-whale · DSH 插件「自律鲸鱼」，在做渐进压缩',
        '- 进行中：便签板 [session: 6adf23f0; started: 10-24 09:07]',
        '- 最近：报告索引 — done：索引文件已生成 [report: r-2]',
        '## deepseek-harness · （待补充）',
        '- 最近：宿主压缩阈值已查明 — partial [report: r-3]',
        '其余工作区（近 8 个人类回合未涉及）：soc-api-test、huichat —— 需要时 list_workspaces / read_report(mode:"index")',
      ].join('\n'),
    )

    // Four active workspaces with full intros, one running entry and two long deliveries each.
    const many = Array.from({ length: 10 }, (_, i) => ws(`ws-${i}`, `workspace-${i}`))
    const input = {
      workspaces: many,
      cards: Object.fromEntries(many.map((workspace) => [workspace.id, { intro: '介'.repeat(200) }])),
      tags: [],
      dispatches: many.slice(0, 4).map((workspace, i) => ({
        dispatchId: `d-${i}`,
        workspaceId: workspace.id,
        workerSessionId: `session-${i}`,
        title: `运行中的任务 ${i} ${'标'.repeat(40)}`,
        startedAt: at(30 + i),
      })),
      reports: many.slice(0, 4).flatMap((workspace, i) =>
        [0, 1].map((k) => ({
          id: `r-${i}-${k}`,
          dispatchId: `d-done-${i}-${k}`,
          workspaceId: workspace.id,
          status: 'reported',
          outcome: 'done',
          label: `交付 ${i}-${k} ${'签'.repeat(50)}`,
          summary: '结'.repeat(150),
          reportedAt: at(10 + i * 2 + k),
        })),
      ),
    }
    const text = renderBoard(input)
    const lines = text.split('\n')
    assert.ok(charLength(text) <= BOARD_MAX_CHARS, `board is ${charLength(text)} characters`)
    assert.match(lines.at(-1), /^其余工作区（近 8 个人类回合未涉及）：workspace-4、workspace-5、.*workspace-9 —— /)
    for (let i = 0; i < 4; i += 1) {
      assert.ok(text.includes(`- 进行中：运行中的任务 ${i} ${'标'.repeat(40)} [`), `running label ${i} kept at full length`)
    }
    const deliveries = lines.filter((line) => line.startsWith('- 最近：'))
    assert.ok(deliveries.length < 8, 'deliveries were dropped')
    assert.ok(deliveries.every((line) => line.includes(`${'签'.repeat(50)} — done`)), 'surviving deliveries keep their labels')
    for (const block of text.split('\n## ').slice(1)) {
      const entries = block.split('\n').filter((line) => line.startsWith('- '))
      assert.ok(charLength(entries.join('\n')) <= BOARD_WORKSPACE_MAX_CHARS)
    }

    // Labels shorten once no delivery is left to drop.
    const tight = renderBoard({ ...input, maxChars: 1200 })
    assert.ok(charLength(tight) <= 1200)
    assert.ok(!tight.includes('- 最近：'), 'every delivery went first')
    assert.ok(!tight.includes('标'.repeat(40)), 'then the labels shortened')
    assert.equal(renderBoard({ workspaces: [] }), '')
    console.log('ok 3 — renderBoard: ≤2,000 characters, inactive names last, deliveries dropped before labels shorten')
  }

  // 4
  {
    const root = await freshRoot()
    const workspaces = [ws('ws-blog', 'blog'), ws('ws-whale', 'discipline-whale')]
    const h = host(workspaces)
    const handle = installMemory(h.ctx, { migrateAutoMemory: false }, { root: () => root, now: () => new Date(2026, 9, 24, 10, 0) })
    await handle.ready
    const seen = []
    await h.emit('agent/inbox/claimed', human(1, '开始'))
    await step(h)
    seen.push(h.board())
    for (let i = 0; i < 10; i += 1) {
      const kind = i % 3
      if (kind === 0) {
        recordDispatch({ dispatchId: `d-${i}`, mainSessionId: 'main', workerSessionId: `session-w${i}`, workspaceId: 'ws-blog', workspaceTitle: 'blog', title: `任务 ${i}`, startedAt: new Date(2026, 9, 24, 10, i).toISOString() })
        await noteDispatch({ sessionId: 'main', workspaceId: 'ws-blog', dispatchId: `d-${i}` }, root)
        await h.emit('tools/result', { agent, name: 'dispatch_task' })
      } else if (kind === 1) {
        await writeReport(root, { id: `r-${i}`, dispatchId: `d-${i - 1}`, workspaceId: 'ws-blog', status: 'reported', outcome: 'done', summary: `完成 ${i}`, reportedAt: new Date(2026, 9, 24, 10, i).toISOString() })
        await h.emit('agent/inbox/claimed', { agent, turn: 1, message: { id: `push-${i}`, source: { kind: 'user' }, content: [{ type: 'text', text: `${PUSH_PREFIXES.report}r-${i}` }] } })
      } else {
        await h.emit('tools/result', { agent, name: 'read_report' })
      }
      assert.equal(handle.cache.activityDirty, true, 'the dirty flag is still set')
      await step(h)
      seen.push(h.board())
    }
    await h.emit('agent/inbox/claimed', human(2, '现在呢'))
    await step(h)
    seen.push(h.board())
    assert.equal(new Set(seen).size, 2, 'one render per human turn')
    assert.equal(seen[0], seen[10])
    assert.match(seen[11], /任务 9/, 'the next human turn shows what changed in between')
    console.log('ok 4 — ten events between two human messages, two distinct activity texts')
  }

  // 5
  {
    const root = await freshRoot()
    const workspaces = [ws('ws-blog', 'blog'), ws('ws-voice', 'voice-lab')]
    for (let n = 1; n <= 9; n += 1) await recordUserTurn(root, { sessionId: 'main', turn: n, text: `闲聊 ${n}`, at: at(n) })
    await tagTurn(root, { sessionId: 'main', turn: 1, workspaceId: 'ws-voice', at: at(1) })
    const h = host(workspaces)
    const handle = installMemory(h.ctx, { migrateAutoMemory: false }, { root: () => root, now: () => new Date(2026, 9, 24, 12, 0) })
    await handle.ready
    await step(h)
    assert.doesNotMatch(h.board(), /## voice-lab/)
    assert.match(h.board(), /其余工作区[^\n]*voice-lab/)
    void h.emit('agent/inbox/claimed', human(10, '回到 Voice-Lab 那边'))
    await step(h)
    assert.match(h.board(), /## voice-lab · /, 'the named workspace is on the board')
    assert.ok((await readTagRows(root)).some((row) => row.kind === 'mention' && row.workspaceId === 'ws-voice' && row.turn === 10))
    console.log('ok 5 — claimed not awaited, pre-step right after: the mention is on disk and on the board')
  }

  // 6
  {
    const root = await freshRoot()
    const workspaces = [ws('ws-blog', 'blog')]
    await setWorkspaceIntro(root, 'ws-blog', '个人博客，正在迁移到 Astro', { now: new Date(2026, 9, 24) })
    const h = host(workspaces)
    const handle = installMemory(h.ctx, { migrateAutoMemory: false }, { root: () => root, now: () => new Date(2026, 9, 24, 12, 0) })
    await handle.ready
    for (const [target, text] of [['soul', '语气直接'], ['user', 'Prefer 先给结论'], ['memory', '博客用 bun']]) {
      await handle.tools.find((tool) => tool.name === 'remember').execute({ target, op: 'add', text }, { agent })
    }
    await h.emit('agent/inbox/claimed', human(1, '看看 blog'))
    await step(h)
    const section = h.memory()
    for (const heading of ['## Soul', '## User', '## Memory']) assert.ok(section.includes(heading), heading)
    for (const text of ['语气直接', '先给结论', '博客用 bun', '## 记忆的写法']) assert.ok(section.includes(text), text)
    assert.ok(!section.includes('## 工作区'), 'no workspace card block')
    assert.ok(!section.includes('正在迁移到 Astro') && !section.includes('blog ·'), 'no workspace card')
    assert.match(h.board(), /## blog · 个人博客，正在迁移到 Astro/, 'the intro lives on the board')
    console.log('ok 6 — the memory section has SOUL / USER / MEMORY and no workspace cards')
  }

  // 7
  {
    const root = await freshRoot()
    const workspaces = [ws('ws-blog', 'blog'), ws('ws-idle', 'idle-one')]
    await setWorkspaceIntro(root, 'ws-blog', '个人博客', { now: new Date(2026, 9, 24) })
    await writeDispatchCheckpoint(root, 'session-6adf23f0-1', { dispatchId: 'd-run', mainSessionId: 'main', workspaceId: 'ws-blog', workspaceTitle: 'blog', topic: 'rss', title: '迁移 RSS', startedAt: at(40) })
    await writeReport(root, { id: 'r-a', dispatchId: 'd-a', workspaceId: 'ws-blog', status: 'reported', outcome: 'done', label: '评论区', summary: '评论区上线\n第二行', reportedAt: at(30) })
    await writeReport(root, { id: 'r-b', dispatchId: 'd-b', workspaceId: 'ws-blog', status: 'delivered', outcome: 'partial', summary: '主题切换一半', reportedAt: at(20) })
    const h = host(workspaces)
    const handle = installMemory(h.ctx, { migrateAutoMemory: false }, { root: () => root, now: () => new Date(2026, 9, 24, 12, 0) })
    await handle.ready
    await h.emit('agent/inbox/claimed', human(1, '博客怎样了'))
    await step(h)

    const byId = new Map()
    for (const record of await listDispatchCheckpoints(root)) {
      byId.set(record.dispatchId, { ...record, ...(isDispatchAbandoned(root, record.workerSessionId) ? { status: 'abandoned' } : {}) })
    }
    for (const record of listDispatches()) byId.set(record.dispatchId, { ...byId.get(record.dispatchId), ...record })
    const input = {
      workspaces,
      cards: await readWorkspaceCards(root),
      tags: await readTagRows(root),
      reports: (await Promise.all(workspaces.map((workspace) => listReports(root, workspace.id)))).flat(),
      dispatches: [...byId.values()],
    }
    const expected = renderWorkspaceNote(workspaces[0], workspaceFacts(input).get('ws-blog'))
    assert.equal(await readFile(workspaceNotePath(root, 'ws-blog'), 'utf8'), expected)
    assert.match(expected, /^<!-- generated by discipline-whale;/)
    assert.match(expected, /\n# blog \(ws-blog\)\n介绍：个人博客 \[updated: 2026-10-24\]\n最近活跃：2026-10-24 09:40\n/)
    assert.match(expected, /\n## 进行中\n- 迁移 RSS \[session: 6adf23f0; dispatch: d-run; started: 2026-10-24 09:40\]\n/)
    assert.match(expected, /\n## 最近交付（最多 5 条，新的在前）\n- 评论区 — done：评论区上线 \[report: r-a; ended: 2026-10-24\]\n- 主题切换一半 — partial \[report: r-b; ended: 2026-10-24\]\n/)
    assert.match(expected, /\n## 更早\n- 共 2 份报告，索引：index\/ws-blog\.md\n$/)
    await assert.rejects(readFile(workspaceNotePath(root, 'ws-idle'), 'utf8'), { code: 'ENOENT' }, 'only active workspaces get a note')
    console.log('ok 7 — each render writes home/notes/<key>.md equal to renderWorkspaceNote')
  }

  console.log('All board checks passed.')
} finally {
  clearStoreRoot()
  resetRegistry()
  for (const root of roots) await rm(root, { recursive: true, force: true })
}
