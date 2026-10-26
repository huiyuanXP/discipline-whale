/**
 * Main-session rotation.
 *
 *   1. sessionStats counts summaries, failed compactions since the last one,
 *      the latest input, human turns and the last exchange
 *   2. shouldRotate: one row per rule; R2 is 180,000 on 1M routes and 196,608
 *      on 262K routes; DW_ROTATE_* overrides take positive integers only
 *   3. buildSeed carries every running brief and the latest five summaries
 *      within 40,000 characters, cutting the earliest dispatch first
 *   4. rotateMain creates, seeds (followup notice, else a queued prompt),
 *      records the lineage, retargets checkpoints, archives the old segment
 *   5. the idle hook rotates once, never an archived segment, never a fresh
 *      segment, and gives up when the flush leaves the agent running; on 1M
 *      routes the compaction trigger is 131,072 and the flush point 98,304
 *   6. a worker reporting to a rotated-away main session pushes to the current
 *      one and records it in `deliveredTo`; while `rotation.lock` exists,
 *      `currentMainFor` waits for the rotation to settle
 *   7. GET /home returns the lineage; POST /home with a main session rotates
 *      it with reason 'manual'
 *   8. a seed neither path delivers leaves state.json on the old segment; a
 *      failed create or delivery holds automatic rotation off for 10 minutes
 *
 * Run: node test/rotation.mjs
 */

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readDispatchCheckpoint, writeDispatchCheckpoint } from '../checkpoint.js'
import { HOME_ROUTE, homeHandler } from '../home.js'
import { installMemory } from '../memory-row.js'
import { PUSH_PREFIXES } from '../pushes.js'
import { dispatches, recordDispatch, resetRegistry } from '../registry.js'
import {
  ROTATION_COOLDOWN_MS,
  ROTATION_SOURCE,
  applyRotationEnv,
  buildSeed,
  rotateInputThreshold,
  rotateMain,
  sessionStats,
  shouldRotate,
} from '../rotation.js'
import { currentMainFor, readState, resolveMainTarget, rotationLockPath, writeState } from '../state.js'
import { clearStoreRoot, dataDir, readReport, reportIndexPath, setStoreRoot, whaleHomeDir, writeReport } from '../store.js'
import * as workerRow from '../worker.js'

const root = await mkdtemp(join(tmpdir(), 'whale-rotation-'))
setStoreRoot(root)
resetRegistry()

const WS = { id: 'ws-voice', title: 'voice', path: '/tmp/voice', sessionIds: [] }

/** Mount the worker row on a fake Host that records every prompt. */
function mount(row, config = {}) {
  const tools = new Map()
  const prompts = []
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    workspaceRegistry: { list: () => [WS] },
    sessionController: {
      prompt: async (request, signal) => {
        signal.throwIfAborted()
        prompts.push(request)
        return { accepted: true }
      },
    },
    on: () => () => {},
  }
  row.apply(ctx, config)
  return { tools, prompts }
}


/* ------------------------------------------------------------------ *
 * event and host fakes for the rotation checks
 * ------------------------------------------------------------------ */

const textOf = (text) => [{ type: 'text', text }]
/** A `user/message` from `sessionController.prompt`: the human, or a push (same source kind). */
const userMessage = (text) => ({ type: 'user/message', data: { role: 'user', content: textOf(text), source: { kind: 'user' } } })
const snapshot = () => ({
  type: 'user/message',
  data: { role: 'user', content: textOf('Current runtime context.'), source: { kind: 'runtime-context' } },
})
const said = (text, inputTokens) => ({
  type: 'assistant/message',
  data: {
    message: {
      role: 'assistant',
      content: text === '' ? [{ type: 'tool-call', id: 't', name: 'read', arguments: '{}' }] : textOf(text),
    },
    ...(inputTokens === undefined ? {} : { usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 } }),
  },
})
const BRIEF = (tag, filler = '') =>
  `You are a Discipline Whale worker. Complete the task below in this workspace.\n\nTask ${tag}: ${filler}\n\nCall report_to_main when done.`

/** Wipe the plugin data directory and the registry between checks. */
async function resetData() {
  await rm(dataDir(root), { recursive: true, force: true })
  resetRegistry()
}

/** A session controller that records every call; `inspect` serves `logs[sessionId]`. */
function controller({ logs = {}, ids = [], failCreate = false, failPrompt = false } = {}) {
  const calls = { create: [], rename: [], prompt: [], inspect: [] }
  let next = 0
  return {
    calls,
    create: async (request) => {
      calls.create.push(request)
      if (failCreate) throw new Error('create refused')
      next += 1
      return { sessionId: ids[next - 1] ?? `main-new-${next}`, agentPreset: request.agentPreset }
    },
    rename: async (request) => {
      calls.rename.push(request)
      return { title: request.title }
    },
    prompt: async (request, signal) => {
      assert.ok(signal instanceof AbortSignal)
      calls.prompt.push(request)
      if (failPrompt) throw new Error('prompt refused')
      return { accepted: true }
    },
    inspect: async (sessionId) => {
      calls.inspect.push(sessionId)
      if (logs[sessionId] === undefined) throw new Error(`no session ${sessionId}`)
      return { meta: {}, events: logs[sessionId] }
    },
  }
}

/** An agent registry whose agents record the notices they are handed. */
function agentRegistry(ids, { failFollowup = false } = {}) {
  const notices = []
  const agents = new Map(
    ids.map((id) => [
      id,
      {
        status: 'idle',
        followup: (message) => {
          if (failFollowup) throw new Error('followup refused')
          notices.push({ id, message })
        },
      },
    ]),
  )
  return { agents, notices }
}

const exists = (path) => access(path).then(() => true, () => false)

const execAs = (sessionId) => ({ signal: new AbortController().signal, agent: { session: { id: sessionId } } })
const segment = (sessionId, successor) => ({
  sessionId,
  successor,
  endedAt: '2026-10-24T06:00:00.000Z',
  reason: 'compactions',
  lastInputTokens: 203324,
  compactions: 2,
  seedFile: `home/rotations/${successor}.md`,
})
const dispatchFor = (workerSessionId, extra) => ({
  dispatchId: `dispatch-${workerSessionId}`,
  mainSessionId: 'main-a',
  workspaceId: WS.id,
  workspaceTitle: WS.title,
  startedAt: '2026-10-24T05:00:00.000Z',
  ...extra,
})

try {
  // --- 1. sessionStats --------------------------------------------------
  {
    const events = [
      userMessage('先看一下语音的进度'),
      userMessage(`${PUSH_PREFIXES.report}voice (done)\n\nVoice works.`),
      snapshot(),
      said('好的，我派个工人。', 30574),
      { type: 'compaction/start', data: {} },
      { type: 'compaction/summary', data: { summary: 's1' } },
      { type: 'compaction/end', data: {} },
      userMessage('再看看 TTS'),
      said('', 140000),
      { type: 'compaction/start', data: {} },
      { type: 'compaction/summary', data: { summary: 's2' } },
      { type: 'compaction/end', data: {} },
      { type: 'compaction/start', data: {} },
      { type: 'compaction/end', data: { error: { message: 'compaction still above threshold' } } },
      { type: 'compaction/start', data: {} },
      { type: 'compaction/end', data: { error: { message: 'again' } } },
      said('长'.repeat(2000), 150000),
      userMessage(`${PUSH_PREFIXES.rotation}自律鲸鱼主会话第 2 段。`),
      userMessage(`${PUSH_PREFIXES.startup}重启前有 1 条派工没有完成回报`),
    ]
    const stats = sessionStats(events)
    assert.equal(stats.compactions, 2)
    assert.equal(stats.failedCompactionsSinceLastSuccess, 2)
    assert.equal(stats.lastInputTokens, 150000)
    assert.equal(stats.humanTurns, 2, 'pushes, snapshots and the seed are not human turns')
    assert.equal(stats.lastHumanText, '再看看 TTS')
    assert.equal(Array.from(stats.lastAssistantText).length, 1500)
    // A summary after a failure resets the failure count.
    assert.equal(sessionStats([...events, { type: 'compaction/summary', data: {} }]).failedCompactionsSinceLastSuccess, 0)
    assert.deepEqual(sessionStats([]), {
      compactions: 0,
      failedCompactionsSinceLastSuccess: 0,
      lastInputTokens: 0,
      humanTurns: 0,
      lastHumanText: '',
      lastAssistantText: '',
    })
    console.log('ok 1 — sessionStats counts summaries, failures since the last one, input, human turns and the last exchange')
  }

  // --- 2. shouldRotate --------------------------------------------------
  {
    const M1 = { contextWindow: 1_048_576, compactThreshold: 131_072 }
    const K262 = { contextWindow: 262_144, compactThreshold: 163_840 }
    const stats = (extra) => ({ compactions: 0, failedCompactionsSinceLastSuccess: 0, lastInputTokens: 50_000, humanTurns: 12, ...extra })
    assert.equal(rotateInputThreshold(M1), 180_000, '1M route: R2 = 180,000')
    assert.equal(rotateInputThreshold(K262), 196_608, '262K route: R2 = 196,608')

    assert.deepEqual(shouldRotate(stats({ compactions: 5 }), { ...M1, config: { rotateEnabled: false } }), { rotate: false })
    assert.deepEqual(shouldRotate(stats({ compactions: 5, humanTurns: 9 }), M1), { rotate: false }, 'fewer than 10 human turns')
    assert.deepEqual(shouldRotate(stats({ compactions: 2 }), M1), { rotate: true, reason: 'compactions' })
    assert.deepEqual(shouldRotate(stats({ compactions: 1 }), M1), { rotate: false })
    assert.deepEqual(shouldRotate(stats({ lastInputTokens: 180_000 }), M1), { rotate: true, reason: 'input-tokens' })
    assert.deepEqual(shouldRotate(stats({ lastInputTokens: 179_999 }), M1), { rotate: false })
    assert.deepEqual(shouldRotate(stats({ lastInputTokens: 196_607 }), K262), { rotate: false })
    assert.deepEqual(shouldRotate(stats({ lastInputTokens: 196_608 }), K262), { rotate: true, reason: 'input-tokens' })
    assert.deepEqual(shouldRotate(stats({ failedCompactionsSinceLastSuccess: 1, lastInputTokens: 131_072 }), M1), {
      rotate: true,
      reason: 'compaction-failed',
    })
    assert.deepEqual(shouldRotate(stats({ failedCompactionsSinceLastSuccess: 1, lastInputTokens: 131_071 }), M1), { rotate: false })

    // The environment overrides: positive integers only, a pinned input threshold.
    const warnings = []
    const env = { DW_ROTATE_INPUT_TOKENS: '45000', DW_ROTATE_MIN_HUMAN_TURNS: '2', DW_ROTATE_AFTER_COMPACTIONS: '1.5' }
    const config = applyRotationEnv(
      { rotateInputTokens: 180_000, rotateMinHumanTurns: 10, rotateAfterCompactions: 2 },
      env,
      (message) => warnings.push(message),
    )
    assert.equal(config.rotateInputTokens, 45_000)
    assert.equal(config.rotateMinHumanTurns, 2)
    assert.equal(config.rotateAfterCompactions, 2, 'an invalid value keeps the config value')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /DW_ROTATE_AFTER_COMPACTIONS/)
    for (const bad of ['0', '-5', 'abc', '1e3']) {
      assert.equal(applyRotationEnv({ rotateInputTokens: 7 }, { DW_ROTATE_INPUT_TOKENS: bad }).rotateInputTokens, 7, bad)
    }
    assert.equal(rotateInputThreshold({ ...M1, config }), 45_000, 'an override is the threshold as given')
    assert.deepEqual(shouldRotate(stats({ lastInputTokens: 45_000, humanTurns: 2 }), { ...M1, config }), {
      rotate: true,
      reason: 'input-tokens',
    })
    console.log('ok 2 — shouldRotate: one row per rule; R2 180,000 (1M) and 196,608 (262K); DW_ROTATE_* overrides')
  }

  // --- 3. buildSeed -----------------------------------------------------
  {
    const now = new Date('2026-10-24T07:00:00.000Z')
    const runningEntry = (index, filler) => ({
      dispatchId: `dispatch-${index}`,
      workerSessionId: `session-worker-${index}`,
      workspaceId: 'ws-whale',
      workspaceTitle: 'discipline-whale',
      title: `任务 ${index}`,
      startedAt: new Date(now.getTime() - (10 - index) * 60_000).toISOString(),
      brief: BRIEF(`#${index}`, filler),
      instructions: ['first', 'second', 'third', `latest-${index}`],
      latestStatus: `worker ${index} is halfway`,
      lastInputTokens: 118_442,
    })
    const completed = Array.from({ length: 5 }, (_, index) => ({
      id: `r-${index}`,
      dispatchId: `dispatch-done-${index}`,
      workspaceId: 'ws-harness',
      workspaceTitle: 'deepseek-harness',
      label: `交付 ${index}`,
      status: 'delivered',
      outcome: 'done',
      summary: `Summary ${index}: ${'细节'.repeat(400)}`,
      document: '# Report\n## What changed\n## Verified\n',
      reportedAt: new Date(now.getTime() - index * 3_600_000).toISOString(),
    }))
    const indexes = [{ workspaceId: 'ws-harness', workspaceTitle: 'deepseek-harness', count: 67, path: '/d/home/index/ws-harness.md' }]
    const input = {
      previousSessionId: 'main-old',
      segment: 2,
      reason: 'compactions',
      stats: { compactions: 2, lastInputTokens: 203_324 },
      completed,
      indexes,
      lastExchange: { human: '刚才那个测试派工现在怎样？', assistant: '还在跑。' },
      now,
    }
    const pair = [runningEntry(1, 'alpha'), runningEntry(2, 'beta')]
    const seed = buildSeed({ ...input, running: pair })
    assert.ok(seed.startsWith(`${PUSH_PREFIXES.rotation}自律鲸鱼主会话第 2 段。上一段 main-old 已存档`))
    assert.ok(seed.includes('203,324'))
    for (const entry of pair) {
      assert.ok(seed.includes(entry.brief), `the brief of ${entry.title} in full`)
      assert.ok(seed.includes(entry.latestStatus))
    }
    assert.ok(seed.includes('latest-1') && seed.includes('latest-2'))
    assert.ok(!seed.includes('1. first'), 'only the latest three later instructions')
    for (const report of completed) assert.ok(seed.includes(report.summary), `summary of ${report.id} in full`)
    assert.ok(seed.includes('章节：Report、What changed、Verified'))
    assert.ok(seed.includes('/d/home/index/ws-harness.md'))
    assert.ok(seed.includes('read_report(mode:"index", workspace:"deepseek-harness")'))
    assert.ok(seed.includes('## 上一段的最后一轮'))
    assert.ok(seed.includes('刚才那个测试派工现在怎样？') && seed.includes('还在跑。'))
    assert.ok(seed.includes('只回一行：「已续接：2 个进行中派工、最近 5 次交付已带上。」'))
    assert.ok(Array.from(seed).length <= 40_000)

    // One brief over its own 12,000-character budget: 3,000 characters and a pointer.
    const huge = runningEntry(3, 'h'.repeat(15_000))
    const trimmed = buildSeed({ ...input, running: [huge] })
    assert.ok(!trimmed.includes(huge.brief))
    assert.ok(trimmed.includes(huge.brief.slice(0, 2_900)))
    assert.ok(trimmed.includes(`完整 brief 在 worker 会话 ${huge.workerSessionId} 的第一条消息`))
    assert.ok(trimmed.includes('latest-3'), 'the cut brief keeps the later instructions')

    // Six long briefs: over 40,000 in total, cut down from the earliest dispatched.
    const six = Array.from({ length: 6 }, (_, index) => runningEntry(index + 1, String(index + 1).repeat(11_000)))
    const crowded = buildSeed({ ...input, running: [...six].reverse() })
    assert.ok(Array.from(crowded).length <= 40_000, `seed is ${Array.from(crowded).length} characters`)
    for (const entry of six) {
      assert.ok(crowded.includes(`### [discipline-whale] ${entry.title} — worker ${entry.workerSessionId}`), `heading of ${entry.title}`)
    }
    assert.ok(!crowded.includes(six[0].brief), 'the earliest dispatch is cut first')
    assert.ok(crowded.includes(six[0].brief.slice(0, 1_900)))
    assert.ok(crowded.includes(six[5].brief), 'the latest dispatch keeps its full brief')
    assert.ok(crowded.indexOf(six[0].title) < crowded.indexOf(six[5].title), 'running dispatches are listed oldest first')
    console.log('ok 3 — buildSeed: full briefs and summaries, index pointers, last exchange, ≤40,000 by cutting the earliest first')
  }

  // --- 4. rotateMain ------------------------------------------------------
  {
    await resetData()
    await writeState({ mainSessionId: 'main-old' })
    // A running dispatch (checkpoint + registry) and a finished one (delivered report).
    const running = dispatchFor('worker-run', { mainSessionId: 'main-old', title: '语音输入', task: 'Wire the voice input.' })
    await writeDispatchCheckpoint(root, 'worker-run', running)
    recordDispatch({ ...running, workerSessionId: 'worker-run' })
    await writeDispatchCheckpoint(root, 'worker-done', dispatchFor('worker-done', { mainSessionId: 'main-old' }))
    await writeReport(root, {
      id: 'r-done',
      dispatchId: 'dispatch-worker-done',
      workspaceId: WS.id,
      workspaceTitle: WS.title,
      label: 'TTS',
      status: 'delivered',
      outcome: 'done',
      summary: 'TTS works end to end.',
      document: '# TTS\n## Verified\n',
      reportedAt: '2026-10-24T06:30:00.000Z',
    })
    const logs = {
      'worker-run': [
        userMessage(BRIEF('voice', 'wire the mic')),
        said('Reading the code.', 40_000),
        userMessage('also handle push-to-talk'),
        said('Push-to-talk is next.', 52_000),
      ],
    }
    const host = controller({ logs, ids: ['main-new'] })
    const { agents, notices } = agentRegistry(['main-new'])
    const infos = []
    const stats = {
      compactions: 2,
      failedCompactionsSinceLastSuccess: 0,
      lastInputTokens: 203_324,
      humanTurns: 34,
      lastHumanText: '语音怎么样了',
      lastAssistantText: '在做。',
    }
    const result = await rotateMain({
      sessionController: host,
      agents,
      oldSessionId: 'main-old',
      reason: 'compactions',
      stats,
      root,
      logger: { warn() {}, info: (line) => infos.push(line) },
    })
    assert.equal(result.newSessionId, 'main-new')
    assert.equal(result.seedFile, 'home/rotations/main-new.md')
    assert.deepEqual(host.calls.create, [{ cwd: whaleHomeDir(root), agentPreset: 'discipline-whale' }])
    assert.equal(notices.length, 1, 'the seed goes through followup')
    assert.equal(host.calls.prompt.length, 0)
    const notice = notices[0].message
    assert.equal(notice.role, 'user')
    assert.equal(notice.source.kind, ROTATION_SOURCE.kind)
    assert.equal(notice.source.form, 'notice')
    assert.equal(notice.source.summary, '主会话已续接 · 1 个进行中派工 · 最近 1 次交付')
    const seed = notice.content[0].text
    assert.ok(seed.startsWith(PUSH_PREFIXES.rotation))
    assert.ok(seed.includes(BRIEF('voice', 'wire the mic')))
    assert.ok(seed.includes('also handle push-to-talk') && seed.includes('Push-to-talk is next.'))
    assert.ok(seed.includes('52,000') && seed.includes('TTS works end to end.'))
    assert.ok(seed.includes(reportIndexPath(root, WS.id)))
    assert.ok(!seed.includes('dispatch-worker-done，'), 'a delivered dispatch is not running')

    const state = await readState()
    assert.equal(state.mainSessionId, 'main-new')
    const entry = state.lineage.at(-1)
    assert.deepEqual(
      { ...entry, endedAt: typeof entry.endedAt },
      {
        sessionId: 'main-old',
        successor: 'main-new',
        endedAt: 'string',
        reason: 'compactions',
        lastInputTokens: 203_324,
        compactions: 2,
        seedFile: 'home/rotations/main-new.md',
      },
    )
    assert.equal((await readDispatchCheckpoint(root, 'worker-run')).mainSessionId, 'main-new', 'checkpoints are retargeted')
    assert.equal(dispatches.get('dispatch-worker-run').mainSessionId, 'main-new', 'registry records are retargeted')
    assert.equal(await readFile(join(dataDir(root), 'home', 'rotations', 'main-new.md'), 'utf8'), `${seed}\n`)
    assert.deepEqual(host.calls.rename[0], { sessionId: 'main-new', title: '自律鲸鱼' })
    assert.equal(host.calls.rename[1].sessionId, 'main-old')
    assert.match(host.calls.rename[1].title, /^自律鲸鱼 · 存档 \d\d-\d\d \d\d:\d\d$/)
    assert.equal(await exists(rotationLockPath(root)), false, 'the lock is released')
    assert.match(infos.at(-1), /rotation: main-old → main-new \(compactions, input 203324, compactions 2, seed \d+ chars, running 1\)/)

    // No agent registry: the seed is a queued prompt opening with 【续接】.
    const plain = controller({ ids: ['main-third'] })
    const queued = await rotateMain({ sessionController: plain, oldSessionId: 'main-new', reason: 'input-tokens', stats, root })
    assert.equal(queued.newSessionId, 'main-third')
    assert.equal(plain.calls.prompt.length, 1)
    assert.equal(plain.calls.prompt[0].sessionId, 'main-third')
    assert.equal(plain.calls.prompt[0].mode, 'queue')
    assert.ok(plain.calls.prompt[0].content[0].text.startsWith(`${PUSH_PREFIXES.rotation}自律鲸鱼主会话第 3 段`))
    assert.deepEqual((await readState()).lineage.map((item) => item.sessionId), ['main-old', 'main-new'])

    // Not the current segment, or another rotation holding the lock: nothing happens.
    const idle = controller()
    assert.deepEqual(await rotateMain({ sessionController: idle, oldSessionId: 'main-old', reason: 'compactions', stats, root }), {
      skipped: 'not-current',
    })
    await mkdir(dirname(rotationLockPath(root)), { recursive: true })
    await writeFile(rotationLockPath(root), 'other\n', 'utf8')
    assert.deepEqual(await rotateMain({ sessionController: idle, oldSessionId: 'main-third', reason: 'compactions', stats, root }), {
      skipped: 'busy',
    })
    assert.equal(idle.calls.create.length, 0)
    // A lock older than five minutes is left over from a crash and is taken over.
    const old = new Date(Date.now() - 6 * 60_000)
    await utimes(rotationLockPath(root), old, old)
    const takeover = controller({ ids: ['main-fourth'] })
    const taken = await rotateMain({ sessionController: takeover, oldSessionId: 'main-third', reason: 'compactions', stats, root })
    assert.equal(taken.newSessionId, 'main-fourth')
    console.log('ok 4 — rotateMain creates in the home, seeds by followup or prompt, records the lineage, retargets, archives')
  }

  // --- 5. the idle hook in the memory row ---------------------------------
  {
    await resetData()
    const host = controller({ ids: ['main-b'] })
    const { agents } = agentRegistry(['main-b'])
    const flushes = { count: 0, busyDuringFlush: undefined }
    const llm = {
      resolveModelInfo: async (provider) => ({
        context: { contextWindow: provider === 'soc' ? 1_048_576 : 262_144 },
        defaultMaxTokens: 32_768,
      }),
      async *stream(request) {
        if (!/dream/i.test(request.system ?? '')) {
          flushes.count += 1
          if (flushes.busyDuringFlush !== undefined) flushes.busyDuringFlush.status = 'running'
        }
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ daily: [], user_now: null, workspace_intros: {} }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const listeners = new Map()
    const services = { llm, sessionController: host, agents, workspaceRegistry: { list: () => [WS] } }
    const ctx = {
      logger: { warn() {}, info() {} },
      effect: (fn) => fn(),
      get: (key) => services[key],
      on: (event, handler) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler])
        return () => {}
      },
      tools: { register: () => () => {} },
      systemPrompt: { getSectionOrder: () => 100, section: () => () => {}, context: () => () => {} },
    }
    const policies = [
      { provider: 'soc', model: 'x-test-2', thresholdRatio: 0.125, retainRatio: 0.04 },
      { provider: 'soc', model: 'x-test-1', thresholdRatio: 0.125, retainRatio: 0.04 },
    ]
    const handle = installMemory(ctx, { compactModelPolicies: policies, dreamMinEntries: 1000 }, { root: () => root, env: {} })
    await handle.ready
    const idle = (agent) => {
      for (const handler of listeners.get('agent/status') ?? []) handler({ agent, status: 'idle' })
    }
    const mainAgent = (id, events, model = 'x-test-2') => ({
      status: 'idle',
      session: {
        id,
        header: { agentPreset: 'discipline-whale' },
        snapshotEvents: () => events,
        requestHeader: () => ({ config: { provider: 'soc', model } }),
      },
      options: {},
    })
    const busySegment = () => [...Array.from({ length: 10 }, (_, index) => userMessage(`第 ${index + 1} 句`)), said('收到。', 185_000)]

    // The 1M route's compaction trigger and flush point come from compactModelPolicies.
    const agentA = mainAgent('main-a', busySegment())
    assert.equal(await handle.thresholdFor(agentA), 131_072)
    assert.equal((await handle.thresholdFor(agentA)) - handle.config.flushMarginTokens, 98_304)
    assert.equal(await handle.thresholdFor(mainAgent('main-z', [], 'other-model')), 838_860, 'other routes keep 0.8')

    // A match rotates once, however many idle events arrive meanwhile.
    await writeState({ mainSessionId: 'main-a' })
    idle(agentA)
    idle(agentA)
    const first = await handle.rotation()
    assert.equal(first.newSessionId, 'main-b')
    assert.equal(host.calls.create.length, 1, 'rotated exactly once')
    assert.equal(flushes.count, 1, 'the flush ran before the rotation')
    assert.equal((await readState()).mainSessionId, 'main-b')

    // The new segment has no human turns yet; the archived one never rotates.
    const agentB = mainAgent('main-b', [
      userMessage(`${PUSH_PREFIXES.rotation}自律鲸鱼主会话第 2 段。`),
      said('已续接：0 个进行中派工、最近 0 次交付已带上。', 31_000),
    ])
    idle(agentB)
    assert.deepEqual(await handle.rotation(), { skipped: 'not-due' })
    assert.deepEqual(await handle.maybeRotate(agentA), { skipped: 'not-current' })
    assert.equal(host.calls.create.length, 1)

    // The flush ends with the agent running again: give up until the next idle.
    const agentBusy = mainAgent('main-b', busySegment())
    flushes.busyDuringFlush = agentBusy
    assert.deepEqual(await handle.maybeRotate(agentBusy), { skipped: 'not-idle' })
    assert.equal(host.calls.create.length, 1)
    assert.equal((await readState()).mainSessionId, 'main-b')
    flushes.busyDuringFlush = undefined
    console.log('ok 5 — the idle hook rotates once, skips fresh and archived segments, yields to a busy agent; 1M trigger 131,072 / flush 98,304')
  }

  await resetData()

  // Two rotations already happened: main-a → main-b → main-c.
  assert.equal(rotationLockPath(root), join(dataDir(root), 'memory-state', 'rotation.lock'))
  await writeState({ mainSessionId: 'main-c', lineage: [segment('main-a', 'main-b'), segment('main-b', 'main-c')] })
  const state = await readState()
  assert.equal(resolveMainTarget('main-a', state), 'main-c')
  assert.equal(resolveMainTarget('main-b', state), 'main-c')
  assert.equal(resolveMainTarget('main-c', state), 'main-c')
  assert.equal(resolveMainTarget('main-other', state), 'main-other', 'a Session outside the lineage keeps its id')
  assert.equal(resolveMainTarget('main-a', {}), 'main-a', 'no state, no change')

  // The checkpoint carries the labels across a restart.
  await writeDispatchCheckpoint(root, 'worker-1', dispatchFor('worker-1', { topic: 'voice-input', title: '语音输入' }))
  const checkpoint = await readDispatchCheckpoint(root, 'worker-1')
  assert.deepEqual([checkpoint.topic, checkpoint.title], ['voice-input', '语音输入'])

  // A fresh registry is what a restart leaves: report_to_main rebuilds the
  // dispatch from that checkpoint, which still names main-a.
  const worker = mount(workerRow)
  const result = await worker.tools.get('report_to_main').execute({ summary: 'Voice input works.' }, execAs('worker-1'))
  assert.equal(result.deliveredToMain, true)
  assert.equal(worker.prompts.length, 1)
  assert.equal(worker.prompts[0].sessionId, 'main-c', 'the push lands on the current main session')
  const report = await readReport(root, WS.id, result.reportId)
  assert.equal(report.mainSessionId, 'main-a', 'the report keeps the session that dispatched it')
  assert.deepEqual(report.deliveredTo, ['main-c'], 'deliveredTo names the session actually delivered to')
  assert.deepEqual([report.topic, report.title, report.label], ['voice-input', '语音输入', '语音输入'])

  // A rotation in flight: the lock exists, so the next push waits for it.
  await writeDispatchCheckpoint(root, 'worker-2', dispatchFor('worker-2', { topic: 'voice-tts' }))
  await mkdir(dirname(rotationLockPath(root)), { recursive: true })
  await writeFile(rotationLockPath(root), `${process.pid}\n`, 'utf8')
  const startedAt = Date.now()
  const waiting = currentMainFor('main-a', root)
  const pending = worker.tools.get('report_to_main').execute({ summary: 'TTS works.' }, execAs('worker-2'))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(worker.prompts.length, 1, 'no push while the rotation holds the lock')
  await writeState({ mainSessionId: 'main-d', lineage: [...state.lineage, segment('main-c', 'main-d')] })
  await rm(rotationLockPath(root), { force: true })
  assert.equal(await waiting, 'main-d', 'currentMainFor resolves against the state the rotation wrote')
  assert.ok(Date.now() - startedAt >= 450, 'currentMainFor waited for the lock')
  const late = await pending
  assert.equal(worker.prompts.at(-1).sessionId, 'main-d')
  const lateReport = await readReport(root, WS.id, late.reportId)
  assert.deepEqual(lateReport.deliveredTo, ['main-d'])
  assert.equal(lateReport.label, 'voice-tts', 'without a title the label is the topic')
  console.log('ok 6 — a report to a rotated-away main session lands on the current one; currentMainFor waits out rotation.lock')

  // --- 7. the home route ------------------------------------------------
  {
    await resetData()
    const segments = Array.from({ length: 25 }, (_, index) => segment(`main-${index}`, `main-${index + 1}`))
    await writeState({ mainSessionId: 'main-25', lineage: segments })
    const host = controller({ ids: ['main-26'], logs: { 'main-25': [userMessage('切一下'), said('好。', 90_000)] } })
    const { agents, notices } = agentRegistry(['main-26'])
    const handle = homeHandler(host, { agents: () => agents })
    const request = (method) => handle(new Request(`http://dsh${HOME_ROUTE}`, { method }))

    const before = await (await request('GET')).json()
    assert.equal(before.mainSessionId, 'main-25')
    assert.equal(before.lineage.length, 20, 'the latest 20 entries')
    assert.deepEqual(before.lineage[0], segments[5], 'oldest first')
    assert.deepEqual(before.lineage.at(-1), segments[24])

    const after = await (await request('POST')).json()
    assert.equal(after.mainSessionId, 'main-26', 'POST with a main session rotates it')
    assert.deepEqual(host.calls.inspect, ['main-25'], 'the stats come from the old segment')
    assert.equal(notices.length, 1)
    assert.ok(notices[0].message.content[0].text.includes('手动新建'))
    const entry = after.lineage.at(-1)
    assert.equal(entry.sessionId, 'main-25')
    assert.equal(entry.successor, 'main-26')
    assert.equal(entry.reason, 'manual')
    assert.equal(entry.lastInputTokens, 90_000)
    assert.equal(after.lineage.length, 20)
    console.log("ok 7 — GET /home returns the lineage; POST /home with a main session rotates it (reason 'manual')")
  }

  // --- 8. failures --------------------------------------------------------
  {
    await resetData()
    await writeState({ mainSessionId: 'main-f' })
    const stats = sessionStats([userMessage('hi'), said('hello', 50_000)])
    const t0 = new Date('2026-10-24T08:00:00.000Z')
    const at = (offsetMs) => () => new Date(t0.getTime() + offsetMs)

    // Both delivery paths fail: the state stays on the old segment.
    const broken = controller({ ids: ['main-g'], failPrompt: true })
    const { agents } = agentRegistry(['main-g'], { failFollowup: true })
    const failed = await rotateMain({ sessionController: broken, agents, oldSessionId: 'main-f', reason: 'compactions', stats, root, now: at(0) })
    assert.equal(failed.skipped, 'deliver-failed')
    assert.equal(broken.calls.prompt.length, 1, 'the prompt path was tried after followup')
    const state = await readState()
    assert.equal(state.mainSessionId, 'main-f', 'state.json stays on the old segment')
    assert.equal(state.lineage, undefined)
    assert.ok(broken.calls.rename.some((call) => call.sessionId === 'main-g' && call.title === '自律鲸鱼 · 续接失败'))
    assert.ok(!broken.calls.rename.some((call) => call.sessionId === 'main-f'), 'the old segment keeps its title')
    assert.equal(await exists(join(dataDir(root), 'home', 'rotations', 'main-g.md')), false)

    // Ten minutes of cooldown for automatic attempts.
    const waiting = controller({ ids: ['main-h'] })
    const cooling = await rotateMain({
      sessionController: waiting,
      oldSessionId: 'main-f',
      reason: 'compactions',
      stats,
      root,
      now: at(ROTATION_COOLDOWN_MS - 1),
    })
    assert.deepEqual(cooling, { skipped: 'cooldown' })
    assert.equal(waiting.calls.create.length, 0)

    // A failed create also starts the cooldown; the state does not move.
    const refused = controller({ failCreate: true })
    const createFailed = await rotateMain({
      sessionController: refused,
      oldSessionId: 'main-f',
      reason: 'input-tokens',
      stats,
      root,
      now: at(ROTATION_COOLDOWN_MS),
    })
    assert.equal(createFailed.skipped, 'create-failed')
    assert.equal((await readState()).mainSessionId, 'main-f')
    const again = await rotateMain({
      sessionController: waiting,
      oldSessionId: 'main-f',
      reason: 'compactions',
      stats,
      root,
      now: at(ROTATION_COOLDOWN_MS + 60_000),
    })
    assert.deepEqual(again, { skipped: 'cooldown' })

    // The manual path is the user asking: no cooldown holds it off.
    const manual = await rotateMain({
      sessionController: waiting,
      oldSessionId: 'main-f',
      reason: 'manual',
      stats,
      root,
      now: at(ROTATION_COOLDOWN_MS + 60_000),
    })
    assert.equal(manual.newSessionId, 'main-h')
    assert.equal((await readState()).mainSessionId, 'main-h')
    console.log('ok 8 — undelivered seed: state.json stays on the old segment; failed create or delivery holds auto-rotation off 10 minutes')
  }

  // --- 9. a stale checkpoint written back after the rotation --------------
  //
  // The production timeline this pins: the manual rotation at 03:10:13Z
  // retargeted the checkpoints, and 41 s later one of them was written back
  // naming the OLD segment. The write-back is real (the worker row runs in its
  // own plugin instance, so its in-memory dispatch still names the old
  // segment), but it is harmless because routing resolves through the
  // append-only lineage on every read — not through the checkpoint's field.
  {
    await resetData()
    await writeState({ mainSessionId: 'main-old' })
    const live = recordDispatch({
      dispatchId: 'dispatch-stale',
      mainSessionId: 'main-old',
      workerSessionId: 'worker-stale',
      workspaceId: WS.id,
      workspaceTitle: WS.title,
      startedAt: '2026-10-24T18:32:27.032Z',
    })
    await writeDispatchCheckpoint(root, 'worker-stale', live)
    const staleCopy = { ...live }

    const host = controller({ ids: ['main-next'] })
    const rotated = await rotateMain({ sessionController: host, oldSessionId: 'main-old', reason: 'manual', root })
    assert.equal(rotated.newSessionId, 'main-next')
    assert.equal((await readDispatchCheckpoint(root, 'worker-stale')).mainSessionId, 'main-next', 'step 8 retargeted it')

    // The write-back that production shows at 03:10:54Z.
    await writeDispatchCheckpoint(root, 'worker-stale', staleCopy)
    const stale = await readDispatchCheckpoint(root, 'worker-stale')
    assert.equal(stale.mainSessionId, 'main-old', 'the disk copy really does go back to the old segment')

    // Harmless: every reader resolves that id through the lineage.
    assert.equal(await currentMainFor('main-old', root), 'main-next', 'a report still lands on the new segment')
    const state = await readState()
    assert.deepEqual(state.lineage.map((entry) => entry.sessionId), ['main-old'], 'the old segment stays in the lineage')

    // The guarantee this rests on: the lineage is append-only. `recentLineage`
    // trims only the HTTP response, never the stored state, so a second
    // rotation keeps the first old segment resolvable too.
    const second = controller({ ids: ['main-third'] })
    await rotateMain({
      sessionController: second,
      oldSessionId: 'main-next',
      reason: 'manual',
      root,
      now: () => new Date(Date.now() + 60_000),
    })
    assert.deepEqual((await readState()).lineage.map((entry) => entry.sessionId), ['main-old', 'main-next'])
    assert.equal(await currentMainFor('main-old', root), 'main-third', 'two segments back still resolves')
    assert.equal(await currentMainFor('main-next', root), 'main-third')
    console.log('ok 9 — a stale checkpoint written back after the rotation is harmless: routing resolves through the append-only lineage')
  }

  console.log('All rotation checks passed.')
} finally {
  clearStoreRoot()
  resetRegistry()
  await rm(root, { recursive: true, force: true })
}
