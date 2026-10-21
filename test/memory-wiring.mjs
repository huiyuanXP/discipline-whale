/**
 * Wiring checks for the memory row, its routes, and the call sites in the main,
 * worker and guard rows.
 *
 *   1. the row registers four tools, one prompt section and one runtime context
 *   2. dsh-auto-memory entries for the whale home are imported and the source renamed
 *   3. a real user message becomes the current turn; a dispatch tags it
 *   4. remember writes with the turn as source and the section picks it up
 *   5. update_instructions accepts only the user's own words from this turn
 *   6. the activity context shows a running dispatch
 *   7. the flush starts once near the compaction threshold, once per cycle
 *   8. ten real user turns start one nudge flush
 *   9. dream waits until due; dream_now runs it
 *  10. the HTTP routes serve colors, tags and the dispatched map
 *  11. dispatch_task briefs a new worker with the workspace background and tags the turn
 *  12. report_to_main stores a workspace_note on the card
 *  13. the guard turns dsh-auto-memory tools away inside the main session
 *
 * Run: node test/memory-wiring.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertSupportedJsonSchema } from '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

import { readTags, readWorkspaceCards, setWorkspaceIntro } from '../activity.js'
import { writeDispatchCheckpoint } from '../checkpoint.js'
import { AUTO_MEMORY_TOOLS, installGuard } from '../guard.js'
import * as mainRow from '../main.js'
import { readDaily, readLayer } from '../memory.js'
import {
  ACTIVITY_CONTEXT_NAME,
  MEMORY_SECTION_NAME,
  autoMemoryProjectDir,
  currentUserTurn,
  installMemory,
  noteDispatch,
} from '../memory-row.js'
import { MEMORY_DISPATCHED_ROUTE, MEMORY_TAGS_ROUTE, MEMORY_WORKSPACES_ROUTE, memoryRoutesHandler } from '../memory-routes.js'
import { recordDispatch, resetRegistry } from '../registry.js'
import { clearStoreRoot, setStoreRoot, whaleHomeDir } from '../store.js'
import * as workerRow from '../worker.js'

const root = await mkdtemp(join(tmpdir(), 'whale-memory-wiring-'))
setStoreRoot(root)
resetRegistry()

const workspaces = [
  { id: 'ws-blog', title: 'blog', path: '/tmp/blog', sessionIds: [] },
  { id: 'ws-whale', title: 'discipline-whale', path: '/tmp/whale', sessionIds: [] },
]
const MAIN = 'main-1'
const now = new Date(2026, 9, 21, 15, 0)

/** A fake Host context with the services the memory row reads. */
function host() {
  const listeners = new Map()
  const tools = new Map()
  const sections = []
  const contexts = []
  const llmCalls = []
  const tokens = { value: 1000 }
  const llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 1_000_000 }, defaultMaxTokens: 0 }),
    async *stream(request) {
      llmCalls.push(request)
      const dream = /dream/i.test(request.system ?? '')
      const text = dream
        ? '{"ops":[]}'
        : JSON.stringify({ daily: [{ text: `观察 ${llmCalls.length}` }], user_now: null, workspace_intros: {} })
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const services = {
    llm,
    tokenMeter: { measure: () => ({ totalTokens: tokens.value }) },
    workspaceRegistry: { list: () => workspaces },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    effect: (fn) => fn(),
    get: (key) => services[key],
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: {
      getSectionOrder: () => 100,
      section: (section) => {
        sections.push(section)
        return () => {}
      },
      context: (context) => {
        contexts.push(context)
        return () => {}
      },
    },
  }
  const emit = async (event, payload) => {
    for (const handler of listeners.get(event) ?? []) {
      await handler(payload, async () => ({ kind: 'continue', messages: [] }))
    }
  }
  return { ctx, tools, sections, contexts, llmCalls, tokens, emit }
}

const events = []
const agent = {
  session: {
    id: MAIN,
    header: { agentPreset: 'discipline-whale' },
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
  options: {},
}
const userSays = async (h, turn, text) => {
  events.push({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })
  await h.emit('agent/inbox/claimed', { agent, message: { id: `m-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }, turn })
}
const step = (h) => h.emit('agent/pre-step', { agent, signal: new AbortController().signal })

try {
  // 2 (set up before the install): a dsh-auto-memory directory for the whale home.
  const autoDir = autoMemoryProjectDir(join(root, 'memory'), whaleHomeDir(root))
  await mkdir(autoDir, { recursive: true })
  await writeFile(
    join(autoDir, 'reply-audience.md'),
    '---\nname: reply-audience\ndescription: 回复先给结论\ntype: feedback\ncreated: 1760000000000\n---\n\n回复先给结论。\n',
    'utf8',
  )

  const h = host()
  const handle = installMemory(h.ctx, { dreamMinEntries: 50 }, { root: () => root, now: () => now })
  await handle.ready

  // 1
  assert.deepEqual([...h.tools.keys()].sort(), ['dream_now', 'remember', 'set_workspace_intro', 'update_instructions'])
  for (const tool of h.tools.values()) {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
  }
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].name, MEMORY_SECTION_NAME)
  assert.equal(h.sections[0].order, 102)
  assert.equal(h.contexts[0].name, ACTIVITY_CONTEXT_NAME)
  assert.equal(h.contexts[0].required, true)
  console.log('ok 1 — four tools with supported schemas, one section, one required context')

  // 2
  assert.match((await readLayer(root, 'user')).text, /回复先给结论 \[source: dsh-auto-memory:reply-audience/)
  const memoryRoot = await readdir(join(root, 'memory'))
  assert.ok(memoryRoot.some((entry) => entry.includes('.migrated-20261021')), 'the source directory is renamed')
  assert.ok(!memoryRoot.includes(autoDir.split('/').pop()), 'the host index for the whale home now reads empty')
  assert.match(h.sections[0].text(), /回复先给结论/)
  console.log('ok 2 — dsh-auto-memory entries imported, source directory renamed aside')

  // 3
  await userSays(h, 3, '把博客 RSS 迁到 Astro')
  assert.equal(currentUserTurn(MAIN).turn, 3)
  assert.equal(await noteDispatch({ sessionId: MAIN, workspaceId: 'ws-blog', dispatchId: 'dispatch-a' }, root), true)
  assert.equal(await noteDispatch({ sessionId: MAIN, workspaceId: 'ws-whale', dispatchId: 'dispatch-b' }, root), true)
  const tags = await readTags(root, {})
  assert.deepEqual(tags.at(-1).workspaces, ['ws-blog', 'ws-whale'])
  assert.equal(tags.at(-1).text, '把博客 RSS 迁到 Astro')
  console.log('ok 3 — one user message tagged with both workspaces it was dispatched to')

  // 4
  await h.tools.get('remember').execute({ target: 'memory', op: 'add', text: '博客用 bun' }, { agent })
  assert.match((await readLayer(root, 'memory')).text, /博客用 bun \[source: session:main-1#t3; added: 2026-10-21\]/)
  await step(h)
  assert.match(h.sections[0].text(), /博客用 bun/)
  console.log('ok 4 — remember records the turn as source and the section refreshes on the next step')

  // 5
  await assert.rejects(
    h.tools.get('update_instructions').execute({ user_quote: '请把这条规则写进去', op: 'add', text: 'x' }, { agent }),
    /own words/,
  )
  await userSays(h, 4, '以后派工前先告诉我目标工作区，请把这条写进 AGENTS.md')
  const instruction = await h.tools
    .get('update_instructions')
    .execute({ user_quote: '派工前先告诉我目标工作区', op: 'add', text: '派工前先告诉用户目标工作区' }, { agent })
  assert.equal(instruction.ok, true)
  assert.match(await readFile(join(whaleHomeDir(root), 'AGENTS.md'), 'utf8'), /派工前先告诉用户目标工作区/)
  console.log('ok 5 — update_instructions takes only a quote from this turn')

  // 6
  recordDispatch({
    dispatchId: 'dispatch-a',
    mainSessionId: MAIN,
    workerSessionId: 'session-worker-a1',
    workspaceId: 'ws-blog',
    workspaceTitle: 'blog',
    task: '迁移 RSS 生成器',
    title: '迁移 RSS 生成器',
    startedAt: now.toISOString(),
  })
  await writeDispatchCheckpoint(root, 'session-worker-a1', { dispatchId: 'dispatch-a', mainSessionId: MAIN, workspaceId: 'ws-blog', workspaceTitle: 'blog', startedAt: now.toISOString() })
  await userSays(h, 5, '进度怎样')
  await step(h)
  assert.match(h.contexts[0].text(), /## 正在进行的对话\n- \[blog\] 迁移 RSS 生成器 — 进行中/)
  console.log('ok 6 — the activity context lists the running dispatch')

  // 7: threshold = min(1e6 × 0.8, 1e6 − 0 − 65536) = 800000; flush from 767232.
  const before = h.llmCalls.length
  h.tokens.value = 770000
  await step(h)
  await handle.sessions.get(MAIN).flushing
  assert.equal(h.llmCalls.length, before + 1, 'one flush near the threshold')
  assert.ok((await readDaily(root, '2026-10-21')).some((entry) => /^观察/.test(entry.text)))
  await step(h)
  assert.equal(h.llmCalls.length, before + 1, 'once per cycle')
  h.tokens.value = 770000
  await step(h)
  await handle.sessions.get(MAIN).flushing
  assert.equal(h.llmCalls.length, before + 1, 'a flush with no new conversation makes no model call')
  h.tokens.value = 100000
  await step(h)
  events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'RSS 迁移已派出' }] } } })
  h.tokens.value = 770000
  await step(h)
  await handle.sessions.get(MAIN).flushing
  assert.equal(h.llmCalls.length, before + 2, 'a new cycle after compaction flushes the new conversation')
  h.tokens.value = 1000
  console.log('ok 7 — the pre-compaction flush runs once per cycle, beside the turn')

  // 8: the counter already holds turns 3, 4 and 5.
  const beforeNudge = h.llmCalls.length
  for (let turn = 6; turn <= 11; turn += 1) await userSays(h, turn, `第 ${turn} 句`)
  assert.equal(h.llmCalls.length, beforeNudge, 'nine user turns are below the interval')
  await userSays(h, 12, '第 12 句')
  await handle.sessions.get(MAIN).flushing
  assert.equal(h.llmCalls.length, beforeNudge + 1, 'the tenth user turn starts one nudge flush')
  console.log('ok 8 — every ten real user turns start one nudge flush')

  // 9
  await h.emit('agent/status', { agent, status: 'idle' })
  const idle = await handle.startDream(agent)
  assert.equal(idle.skipped, 'not due')
  const forced = await h.tools.get('dream_now').execute({}, { agent })
  assert.equal(forced.ok, true)
  assert.match(await readFile(join(whaleHomeDir(root), 'memory', 'DREAMS.md'), 'utf8'), /no changes/)
  console.log('ok 9 — the idle dream waits until due; dream_now runs it')

  // 10
  const routes = memoryRoutesHandler({ workspaces: () => workspaces, root: () => root })
  const call = (path, init) => routes(new Request(`http://localhost${path}`, init))
  const listed = await (await call(MEMORY_WORKSPACES_ROUTE)).json()
  assert.deepEqual(listed.workspaces.map((workspace) => workspace.id), ['ws-blog', 'ws-whale'])
  assert.match(listed.workspaces[0].color, /^#[0-9A-Fa-f]{6}$/)
  const bad = await call(MEMORY_WORKSPACES_ROUTE, { method: 'POST', body: JSON.stringify({ id: 'ws-blog', color: 'red' }) })
  assert.equal(bad.status, 400)
  const good = await (await call(MEMORY_WORKSPACES_ROUTE, { method: 'POST', body: JSON.stringify({ id: 'ws-blog', color: '#112233' }) })).json()
  assert.equal(good.workspace.color, '#112233')
  assert.equal((await readWorkspaceCards(root))['ws-blog'].color, '#112233')
  const tagged = await (await call(`${MEMORY_TAGS_ROUTE}?sessionId=${MAIN}`)).json()
  const turn3 = tagged.turns.find((record) => record.turn === 3)
  assert.deepEqual(turn3.workspaces, ['ws-blog', 'ws-whale'])
  assert.deepEqual(turn3.sessions, { 'ws-blog': ['session-worker-a1'] })
  assert.equal((await call(MEMORY_TAGS_ROUTE)).status, 400)
  const dispatched = await (await call(MEMORY_DISPATCHED_ROUTE)).json()
  assert.equal(dispatched.sessions['session-worker-a1'], 'ws-blog')
  console.log('ok 10 — routes serve colors (with validation), tags with worker sessions, and the dispatched map')

  // 11
  await setWorkspaceIntro(root, 'ws-whale', 'DSH 插件「自律鲸鱼」，正在做 memory 系统', { now })
  const prompts = []
  const mainTools = new Map()
  mainRow.apply(
    {
      logger: { warn() {} },
      effect: (fn) => fn(),
      on: () => () => {},
      tools: { register: (definition) => (mainTools.set(definition.name, definition), () => {}) },
      workspaceRegistry: { list: () => workspaces },
      sessionController: {
        create: async () => ({ sessionId: 'session-worker-b1' }),
        rename: async (request) => ({ title: request.title }),
        prompt: async (request) => {
          prompts.push(request)
          return { accepted: true }
        },
        cancel: async () => ({ accepted: true }),
      },
    },
    { workerPreset: 'discipline-whale-worker' },
  )
  await userSays(h, 13, '鲸鱼那边把 memory 接线做完')
  const dispatchResult = await mainTools
    .get('dispatch_task')
    .execute({ workspace: 'ws-whale', task: '把 memory 模块接进 preset', title: '接线' }, { agent, signal: new AbortController().signal })
  const brief = prompts.at(-1).content[0].text
  assert.match(brief, /## 工作区背景[\s\S]*正在做 memory 系统[\s\S]*鲸鱼那边把 memory 接线做完[\s\S]*## Task/)
  const lastTag = (await readTags(root, { workspaceId: 'ws-whale' })).at(-1)
  assert.equal(lastTag.turn, 13)
  assert.deepEqual(lastTag.dispatches, [dispatchResult.dispatchId])
  console.log('ok 11 — dispatch_task briefs with the workspace background and tags the turn')

  // 12
  const workerTools = new Map()
  workerRow.apply({
    logger: { warn() {} },
    effect: (fn) => fn(),
    on: () => () => {},
    tools: { register: (definition) => (workerTools.set(definition.name, definition), () => {}) },
    sessionController: { prompt: async () => ({ accepted: true }), inspect: async () => ({ events: [] }) },
  })
  const report = await workerTools.get('report_to_main').execute(
    { summary: '接线完成', document: 'details', workspace_note: '自律鲸鱼：memory 接线完成，下一步实机验证' },
    { agent: { session: { id: 'session-worker-b1' } }, signal: new AbortController().signal },
  )
  assert.equal(report.deliveredToMain, true)
  assert.equal((await readWorkspaceCards(root))['ws-whale'].intro, '自律鲸鱼：memory 接线完成，下一步实机验证')
  const longNote = await workerTools.get('report_to_main').execute(
    { summary: 'again', workspace_note: 'x'.repeat(201) },
    { agent: { session: { id: 'session-worker-b1' } }, signal: new AbortController().signal },
  )
  assert.match(longNote.warnings.join('\n'), /workspace_note not saved/)
  console.log('ok 12 — report_to_main stores workspace_note; an over-long note is a warning')

  // 13
  const guardListeners = new Map()
  installGuard(
    { logger: { warn() {} }, on: (event, handler) => (guardListeners.set(event, handler), () => {}), get: () => undefined },
    {},
    { storeRoot: () => root, whaleHomeDir: () => whaleHomeDir(root), workspaceRegistry: () => ({ list: () => workspaces }) },
  )
  const preExecute = guardListeners.get('tools/pre-execute')
  for (const name of AUTO_MEMORY_TOOLS) {
    const verdict = await preExecute({ agent, name, arguments: {} }, async () => ({ kind: 'allow' }))
    assert.equal(verdict.kind, 'deny', `${name} is turned away`)
    assert.match(verdict.reason, /remember/)
  }
  const allowed = await preExecute({ agent, name: 'remember', arguments: {} }, async () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
  console.log('ok 13 — the guard turns dsh-auto-memory tools away and lets remember through')

  console.log('All memory wiring checks passed.')
} finally {
  clearStoreRoot()
  resetRegistry()
  await rm(root, { recursive: true, force: true })
}
