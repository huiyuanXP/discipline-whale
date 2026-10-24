/**
 * Report pushes: one wake-up per new piece of information, recognizing every
 * push, and keeping pushes out of the user's turns.
 *
 *   1. shouldPushReport: one row per rule 1–5
 *   2. two report_to_main calls with only a dsh-doublecheck nudge between and
 *      the same outcome: one push; the second report is a revision carrying
 *      the dispatch's label
 *   3. a `source.kind: 'user'` message between the two: two pushes
 *   4. partial, then done: two pushes
 *   5. isWhalePushText recognizes every text the worker side, the home side and
 *      the rotation seed build, and nothing the user types
 *   6. the memory row records no `kind:"turn"` for a report push or a 【续接】
 *      seed, and records one for a human message
 *
 * Run: node test/report-dedupe.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WAKE_PROMPT, interruptedNotice } from '../home.js'
import * as mainRow from '../main.js'
import { installMemory } from '../memory-row.js'
import { PUSH_PREFIXES, isHumanMessage, isWhalePushText } from '../pushes.js'
import { resetRegistry } from '../registry.js'
import { dispatchCheckpointPath } from '../checkpoint.js'
import { clearStoreRoot, dataDir, listReports, readReport, readReportIndex, setStoreRoot } from '../store.js'
import * as workerRow from '../worker.js'
import { shouldPushReport } from '../worker.js'

const root = await mkdtemp(join(tmpdir(), 'whale-report-dedupe-'))
setStoreRoot(root)
resetRegistry()

const WS = { id: 'ws-blog', title: 'blog', path: '/tmp/blog', sessionIds: [] }
const MAIN = 'main-1'

/** Mount a row on a fake Host that records every prompt. */
function mount(row, config = {}) {
  const tools = new Map()
  const listeners = new Map()
  const prompts = []
  let seq = 0
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    workspaceRegistry: { list: () => [WS] },
    sessionController: {
      create: async () => ({ sessionId: `worker-${++seq}` }),
      rename: async (request) => ({ title: request.title }),
      prompt: async (request, signal) => {
        signal.throwIfAborted()
        prompts.push(request)
        return { accepted: true }
      },
    },
    on: (event, handler) => { const list = listeners.get(event) ?? []; list.push(handler); listeners.set(event, list); return () => {} },
  }
  row.apply(ctx, config)
  return { tools, listeners, prompts }
}

const execAs = (sessionId) => ({ signal: new AbortController().signal, agent: { session: { id: sessionId } } })

/**
 * A worker Session whose `snapshotEvents()` grows the way the Host log does:
 * each report_to_main call appends its tool/call before it runs and its
 * tool/result after it returns.
 */
function workerSession(sessionId) {
  const events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'You are a Discipline Whale worker…' }] } }]
  let calls = 0
  const exec = { signal: new AbortController().signal, agent: { session: { id: sessionId, snapshotEvents: () => [...events] } } }
  return {
    say(kind, text) {
      events.push({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
    },
    async report(tool, args) {
      const callId = `call-${++calls}`
      events.push({ type: 'tool/call', data: { name: 'report_to_main', callId, arguments: JSON.stringify(args) } })
      const value = await tool.execute(args, exec)
      events.push({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
      return value
    },
  }
}

/** The reports of one dispatch on disk. */
const reportsOf = async (dispatchId) => (await listReports(root, WS.id)).filter((report) => report.dispatchId === dispatchId)

/** A fake Host context with the services the memory row reads. */
function memoryHost() {
  const listeners = new Map()
  const services = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 0 }) },
    workspaceRegistry: { list: () => [WS] },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    effect: (fn) => fn(),
    get: (key) => services[key],
    on: (event, handler) => { const list = listeners.get(event) ?? []; list.push(handler); listeners.set(event, list); return () => {} },
    tools: { register: () => () => {} },
    systemPrompt: { getSectionOrder: () => 100, section: () => () => {}, context: () => () => {} },
  }
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) ?? []) await handler(payload, async () => ({ kind: 'continue', messages: [] }))
  }
  return { ctx, emit }
}

const turnRows = async () => {
  const text = await readFile(join(dataDir(root), 'memory-state', 'tags.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line)).filter((row) => row.kind === 'turn')
}

try {
  // 1 — the decision table, one row per rule.
  {
    const previous = { id: 'r-1', outcome: 'done', deliveredTo: [MAIN] }
    const call = { type: 'tool/call', data: { name: 'report_to_main', callId: 'c-1' } }
    const result = { type: 'tool/result', data: { message: { toolCallId: 'c-1', isError: false } } }
    const nudge = { type: 'user/message', data: { source: { kind: 'dsh-doublecheck' }, content: [] } }
    const instruction = { type: 'user/message', data: { source: { kind: 'user' }, content: [] } }
    const settled = [call, result, nudge]
    const rows = [
      ['1 no previous', { previous: undefined, events: settled, outcome: 'done', target: MAIN }, true, /no earlier delivered report/],
      ['2 another main', { previous, events: settled, outcome: 'done', target: 'main-2' }, true, /never reached main-2/],
      ['3 new instruction', { previous, events: [...settled, instruction], outcome: 'done', target: MAIN }, true, /new instruction since r-1/],
      ['3 no earlier result', { previous, events: [nudge], outcome: 'done', target: MAIN }, true, /no earlier report_to_main result/],
      ['4 outcome changed', { previous: { ...previous, outcome: 'partial' }, events: settled, outcome: 'done', target: MAIN }, true, /partial → done/],
      ['5 revision', { previous, events: settled, outcome: 'done', target: MAIN }, false, /^no new instruction since r-1, same outcome$/],
    ]
    for (const [name, input, push, reason] of rows) {
      const verdict = shouldPushReport(input)
      assert.equal(verdict.push, push, name)
      assert.match(verdict.reason, reason, name)
    }
    const instructedBefore = shouldPushReport({ previous, events: [instruction, call, result, nudge], outcome: 'done', target: MAIN })
    assert.equal(instructedBefore.push, false, 'an instruction before the last report result is not a new one')
    console.log('ok 1 — shouldPushReport: rules 1–5 each decide their own row')
  }

  // 2 — a doublecheck nudge, same outcome: one push, the second report is a revision.
  {
    const main = mount(mainRow)
    const worker = mount(workerRow)
    const dispatched = await main.tools.get('dispatch_task').execute(
      { workspace: 'blog', task: 'Fix the sitemap.', topic: 'sitemap', title: '修 sitemap' },
      execAs(MAIN),
    )
    const checkpoint = JSON.parse(await readFile(dispatchCheckpointPath(root, dispatched.workerSessionId), 'utf8'))
    assert.equal(checkpoint.title, '修 sitemap')
    const session = workerSession(dispatched.workerSessionId)
    const tool = worker.tools.get('report_to_main')
    const first = await session.report(tool, { summary: 'Sitemap fixed.' })
    session.say('dsh-doublecheck', 'Double-check your work before finishing.')
    const second = await session.report(tool, { summary: 'Sitemap fixed; checked twice.' })
    assert.equal(first.deliveredToMain, true)
    assert.equal(worker.prompts.length, 1, 'the main session is woken once')
    assert.equal(second.deliveredToMain, false)
    assert.equal(second.revisionOf, first.reportId)
    assert.ok(second.warnings.includes('已存为修订版，不再唤醒主会话'))
    const stored = await reportsOf(dispatched.dispatchId)
    assert.deepEqual(stored.map((report) => report.id).sort(), [first.reportId, second.reportId].sort())
    const revision = stored.find((report) => report.id === second.reportId)
    assert.equal(revision.revisionOf, first.reportId)
    assert.equal(revision.status, 'reported')
    assert.deepEqual(revision.pushSuppressed, { reason: `no new instruction since ${first.reportId}, same outcome` })
    assert.equal(revision.label, '修 sitemap', 'the revision carries the label the checkpoint recorded')
    const index = await readReportIndex(root, WS.id)
    assert.equal(index.count, (await listReports(root, WS.id)).length, 'report_to_main leaves the index file current')
    assert.ok(index.text.includes(`(revision of ${first.reportId}) 修 sitemap · `), 'the index marks the revision')

    const head = await main.tools.get('read_report').execute({ report_id: first.reportId }, execAs(MAIN))
    assert.equal(head.report.newerRevision, second.reportId, 'reading the delivered report points at its newer revision')
    console.log('ok 2 — only a dsh-doublecheck nudge between, same outcome: 1 push, 2 reports, the second a labelled revision')
  }

  // 3 — a new instruction between: two pushes.
  {
    const main = mount(mainRow)
    const worker = mount(workerRow)
    const dispatched = await main.tools.get('dispatch_task').execute({ workspace: 'blog', task: 'Tune the feed.', topic: 'feed' }, execAs(MAIN))
    const session = workerSession(dispatched.workerSessionId)
    const tool = worker.tools.get('report_to_main')
    await session.report(tool, { summary: 'Feed tuned.' })
    session.say('user', 'Also cap the feed at 20 items.')
    const second = await session.report(tool, { summary: 'Feed tuned and capped.' })
    assert.equal(worker.prompts.length, 2)
    assert.equal(second.deliveredToMain, true)
    assert.equal(second.revisionOf, undefined)
    console.log('ok 3 — a source.kind:"user" message between the two reports: 2 pushes')
  }

  // 4 — partial, then done: two pushes.
  {
    const main = mount(mainRow)
    const worker = mount(workerRow)
    const dispatched = await main.tools.get('dispatch_task').execute({ workspace: 'blog', task: 'Port the theme.', topic: 'theme' }, execAs(MAIN))
    const session = workerSession(dispatched.workerSessionId)
    const tool = worker.tools.get('report_to_main')
    await session.report(tool, { summary: 'Half the theme is ported.', status: 'partial' })
    session.say('dsh-doublecheck', 'Double-check your work before finishing.')
    const second = await session.report(tool, { summary: 'Theme ported.', status: 'done' })
    assert.equal(worker.prompts.length, 2)
    assert.equal(second.deliveredToMain, true)
    console.log('ok 4 — the outcome moves from partial to done: 2 pushes')
  }

  // 5 — capture the texts the worker side really pushes.
  const main = mount(mainRow)
  const worker = mount(workerRow, { maxReportRetries: 1 })
  const reported = await main.tools.get('dispatch_task').execute(
    { workspace: 'blog', task: 'Move the RSS feed.', topic: 'rss', title: '迁移 RSS 生成器' },
    execAs(MAIN),
  )
  const result = await worker.tools.get('report_to_main').execute({ summary: 'RSS moved.' }, execAs(reported.workerSessionId))
  assert.equal(result.deliveredToMain, true)
  const reportText = worker.prompts.at(-1).content[0].text
  assert.ok(reportText.startsWith(`${PUSH_PREFIXES.report}blog (done)`))
  const stored = await readReport(root, WS.id, result.reportId)
  assert.deepEqual(
    { topic: stored.topic, title: stored.title, label: stored.label },
    { topic: 'rss', title: '迁移 RSS 生成器', label: '迁移 RSS 生成器' },
    'the report carries the dispatch labels',
  )

  const silent = await main.tools.get('dispatch_task').execute({ workspace: 'blog', task: 'Silent worker.' }, execAs(MAIN))
  const stopping = worker.listeners.get('agent/turn-stopping')[0]
  const silentAgent = { session: { id: silent.workerSessionId }, steer() {} }
  stopping({ agent: silentAgent, turn: 1, signal: new AbortController().signal })
  stopping({ agent: silentAgent, turn: 2, signal: new AbortController().signal })
  for (let attempt = 0; attempt < 50 && worker.prompts.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  const failedText = worker.prompts.at(-1).content[0].text
  assert.ok(failedText.startsWith(`${PUSH_PREFIXES.failed}blog`))

  const notice = interruptedNotice([{ workspaceTitle: 'blog', workerSessionId: 'worker-9', startedAt: '2026-10-24T06:00:00.000Z' }])
  const seed = `${PUSH_PREFIXES.rotation}自律鲸鱼主会话第 2 段。上一段 main-0 已存档（原因：压缩已 2 次）。`
  const pushes = [reportText, failedText, WAKE_PROMPT, `${WAKE_PROMPT}\n\n${notice}`, notice, seed]
  for (const text of pushes) assert.equal(isWhalePushText(text), true, text.split('\n')[0])
  for (const text of ['把博客 RSS 迁到 Astro', `看看这个：${PUSH_PREFIXES.report}`, ' 【续接】', '', undefined]) {
    assert.equal(isWhalePushText(text), false, String(text))
  }
  const message = (text, kind = 'user') => ({ source: { kind }, content: [{ type: 'text', text }] })
  assert.equal(isHumanMessage(message('把博客 RSS 迁到 Astro')), true)
  assert.equal(isHumanMessage(message(reportText)), false)
  assert.equal(isHumanMessage(message('把博客 RSS 迁到 Astro', 'plugin:discipline-whale:rotation')), false)
  assert.equal(isHumanMessage({ source: { kind: 'user' }, content: '直接是字符串' }), true)
  console.log('ok 5 — isWhalePushText recognizes the report, failed-to-report, wake, startup-check and 【续接】 texts, and no human text')

  // 6 — the memory row's turn recorder sees only the human message.
  const h = memoryHost()
  const handle = installMemory(h.ctx, { dreamMinEntries: 50 }, { root: () => root, now: () => new Date(2026, 9, 24, 15, 0) })
  await handle.ready
  const agent = { session: { id: MAIN, header: { agentPreset: 'discipline-whale' }, snapshotEvents: () => [] }, options: {} }
  const claim = (turn, text) => h.emit('agent/inbox/claimed', { agent, message: { id: `m-${turn}`, ...message(text) }, turn })
  await claim(1, reportText)
  await claim(2, seed)
  await claim(3, notice)
  await claim(4, '把博客 RSS 迁到 Astro')
  let rows = []
  for (let attempt = 0; attempt < 50 && rows.length === 0; attempt += 1) {
    rows = await turnRows()
    if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await new Promise((resolve) => setTimeout(resolve, 30))
  rows = await turnRows()
  assert.deepEqual(rows.map((row) => [row.turn, row.text]), [[4, '把博客 RSS 迁到 Astro']])
  console.log('ok 6 — memory-row writes no turn for a report push, a 【续接】 seed or a startup check; one for the human message')

  console.log('All report dedupe checks passed.')
} finally {
  clearStoreRoot()
  resetRegistry()
  await rm(root, { recursive: true, force: true })
}
