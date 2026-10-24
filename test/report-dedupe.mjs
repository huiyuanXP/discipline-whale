/**
 * Report pushes: recognizing them, and keeping them out of the user's turns.
 *
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
import { clearStoreRoot, dataDir, readReport, setStoreRoot } from '../store.js'
import * as workerRow from '../worker.js'

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
