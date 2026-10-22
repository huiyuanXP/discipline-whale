/**
 * Contract tests for discipline-whale.
 *
 * The plugin is split into two rows on purpose, so these tests mount each half
 * with its own tool registry and assert the separation explicitly:
 *
 *   1. store round-trip, bounding, traversal safety
 *   2. main row: four tools, schemas inside the enforced subset
 *   3. worker row: exactly one tool, and no main-session powers
 *   4. list_workspaces projects the registry
 *   5. dispatch_task creates, titles, briefs; bad selectors rejected
 *   6. report_to_main stores the document and delivers to main
 *   7. an undispatched Session cannot report
 *   8. enforcement steers, then escalates; a reporting worker is left alone
 *   9. send_to_session delivers a decision
 *
 * Run: node test/contract.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Host installation the contract tests read along with. The paths below are
 * the same installation `dsh-tools` is imported from, so a checkout or npx cache
 * move keeps the whole suite pointed at one Host.
 */
const DSH_MODULES = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'

import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

import {
  VOICE_ROUTE,
  VOICE_SAY_ROUTE,
  VOICE_STATUS_ROUTE,
} from '../voice.js'
import { VOICE_SETTINGS_ROUTE, VOICE_TEST_ROUTE } from '../voice-settings.js'
import {
  isDispatchAbandoned,
  listDispatchCheckpoints,
  markDispatchAbandoned,
  readDispatchCheckpoint,
  writeDispatchCheckpoint,
} from '../checkpoint.js'
import { HOME_ROUTE, MAIN_PRESET, MAIN_TITLE, WAKE_PROMPT, ensureHome, homeHandler, interruptedNotice, readState, startupCheck } from '../home.js'
import * as mainRow from '../main.js'
import { DELIVERY_TIMINGS, resolveTiming } from '../main.js'
import { RESUME_BRIEF } from '../main.js'
import * as workerRow from '../worker.js'
import { resetRegistry } from '../registry.js'
import {
  MAX_SUMMARY_CHARS,
  boundSummary,
  deleteReport,
  isReportId,
  listReports,
  readReport,
  setStoreRoot,
  workspaceKey,
  writeReport,
} from '../store.js'

const home = await mkdtemp(join(tmpdir(), 'dw-test-'))
setStoreRoot(home)

const workspaces = [
  { id: 'ws-soc', title: 'soc-api-test', path: '/Users/huiyuan/Developer/test/soc-api-test', sessionIds: ['a', 'b'] },
  { id: 'ws-harness', title: 'deepseek-harness', path: '/Users/huiyuan/Developer/open-source/deepseek-harness', sessionIds: [] },
  { id: 'ws-fuzz', title: 'soc-api-fuzz', path: '/Users/huiyuan/Developer/test/soc-api-fuzz', sessionIds: [] },
]

/**
 * Session ids the fake Host hands out.
 *
 * Deliberately process-unique, not per-mount: checkpoints are keyed by session
 * id on disk, so a per-mount counter that restarts at 1 would let one test block
 * read a file an earlier block wrote and mask a real path mismatch.
 */
let sessionSeq = 0

/** Mount one row against a fresh fake Host and capture what it registers. */
function mount(row, config = {}) {
  const tools = new Map()
  const calls = { create: [], rename: [], prompt: [], cancel: [] }
  const listeners = new Map()

  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    workspaceRegistry: { list: () => workspaces },
    sessionController: {
      create: async (request) => {
        calls.create.push(request)
        sessionSeq += 1
        return { sessionId: `worker-${sessionSeq}` }
      },
      rename: async (request) => {
        calls.rename.push(request)
        return { title: request.title, seq: 1 }
      },
      // Mirrors the real contract: session/prompt(request, signal) dereferences
      // the signal immediately, so a missing signal must fail here too.
      prompt: async (request, signal) => {
        signal.throwIfAborted()
        calls.prompt.push(request)
        return { accepted: true }
      },
      // Mirrors the Host: cancel aborts the active turn and keeps the inbox.
      cancel: async (request) => {
        calls.cancel.push(request)
        return { accepted: true }
      },
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }

  row.apply(ctx, config)
  return { ctx, tools, calls, listeners }
}

/** Invoke one registered tool as the registry would. */
function run(tools, name, args, exec = {}) {
  const tool = tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: new AbortController().signal, ...exec })
}

const execAs = (sessionId) => ({ agent: { session: { id: sessionId } } })

// --- 1. store -------------------------------------------------------------

{
  assert.equal(workspaceKey('f663d93b/id'), 'f663d93b_id')
  assert.ok(isReportId('r-abc_123'))
  assert.ok(!isReportId('../escape'))
  assert.ok(!isReportId('has space'))

  const long = 'x'.repeat(MAX_SUMMARY_CHARS + 50)
  assert.equal(boundSummary(long).length, MAX_SUMMARY_CHARS)
  assert.ok(boundSummary(long).endsWith('…'))
  assert.equal(boundSummary('  short  '), 'short')

  const report = {
    id: 'r-test-1',
    workspaceId: 'ws-soc',
    status: 'reported',
    summary: 'did a thing',
    document: 'long body',
    workerSessionId: 'w1',
    reportedAt: '2026-10-20T00:00:00.000Z',
    deliveredTo: [],
  }
  await writeReport(home, report)
  assert.equal((await readReport(home, 'ws-soc', 'r-test-1')).summary, 'did a thing')
  assert.equal(await readReport(home, 'ws-soc', 'missing'), undefined)
  assert.equal(await readReport(home, 'ws-soc', '../etc/passwd'), undefined, 'path traversal must not read')
  assert.equal((await listReports(home, 'ws-soc')).length, 1)
  assert.deepEqual(await listReports(home, 'ws-unknown'), [], 'an unknown workspace lists empty')

  // A hand-corrupted file must not break the listing.
  await writeFile(join(home, 'discipline-whale', 'reports', 'ws-soc', 'r-broken.json'), '{not json', 'utf8')
  assert.equal((await listReports(home, 'ws-soc')).length, 1, 'corrupt file skipped, good one kept')

  assert.equal(await deleteReport(home, 'ws-soc', 'r-test-1'), true)
  assert.equal(await deleteReport(home, 'ws-soc', 'r-test-1'), false)
  console.log('ok 1 — store: round-trip, bounding, traversal-safe listing')
}

// --- 2. main row surface --------------------------------------------------

{
  const { tools } = mount(mainRow)
  const expected = [
    'list_workspaces',
    'dispatch_task',
    'read_report',
    'send_to_session',
    'list_dispatches',
    'resume_dispatch',
    'abandon_dispatch',
  ]
  assert.deepEqual([...tools.keys()].sort(), [...expected].sort())
  // Every registered tool must be covered by this check, not just the ones this
  // list happens to name: an unchecked row could carry an unsupported schema.
  for (const [name, tool] of tools) {
    assert.ok(expected.includes(name), `tool ${name} is registered but not covered by the schema check`)
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
    assert.equal(typeof tool.output.render, 'function')
  }
  console.log('ok 2 — main row registers seven tools with supported schemas')
}

// --- 3. worker row surface: no upward powers ------------------------------

{
  const { tools } = mount(workerRow)
  // Two tools, and the pair is the point: report (finish upward) and ask (file a
  // question upward). `ask_main` is NOT a power — it writes a question file and
  // returns; it cannot dispatch, enumerate workspaces, or read a report.
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['ask_main', 'report_to_main'],
    'the worker gets exactly the two upward tools: report and ask',
  )
  // `list_dispatches` is a main-session board: a worker that could read the
  // dispatch board would learn about other workers' tasks. It must stay absent.
  for (const forbidden of [
    'dispatch_task',
    'list_workspaces',
    'read_report',
    'send_to_session',
    'list_dispatches',
  ]) {
    assert.equal(tools.get(forbidden), undefined, `worker must not have ${forbidden}`)
  }
  assertSupportedJsonSchema(tools.get('report_to_main').parameters)
  console.log('ok 3 — worker row exposes only report_to_main (no dispatch powers)')
}

// --- 4. list_workspaces ---------------------------------------------------

{
  const { tools } = mount(mainRow)
  const value = await run(tools, 'list_workspaces', {})
  assert.equal(value.workspaces.length, 3)
  assert.deepEqual(value.workspaces[0], {
    id: 'ws-soc',
    title: 'soc-api-test',
    path: '/Users/huiyuan/Developer/test/soc-api-test',
    sessionCount: 2,
  })
  console.log('ok 4 — list_workspaces projects id/title/path/sessionCount')
}

// --- 5. dispatch_task -----------------------------------------------------

{
  resetRegistry()
  const { tools, calls } = mount(mainRow, { workerPreset: 'discipline-whale-worker' })
  const value = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Refactor the parser.', title: 'DW worker 1' },
    execAs('main-1'),
  )

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].workspaceId, 'ws-soc')
  assert.equal(calls.create[0].agentPreset, 'discipline-whale-worker', 'the worker must run the worker preset')
  assert.equal(calls.rename[0].title, 'DW worker 1')
  assert.equal(calls.prompt.length, 1, 'the worker must be briefed')
  const brief = calls.prompt[0].content[0].text
  assert.match(brief, /Refactor the parser\./)
  assert.match(brief, /report_to_main/, 'the brief must state the report contract')
  assert.match(brief, /cannot dispatch further work/)
  assert.equal(value.status, 'dispatched')
  assert.equal(value.workspaceTitle, 'soc-api-test')
  assert.deepEqual(validateJsonSchemaValue(tools.get('dispatch_task').output.schema, value, 'value'), [])

  // Ambiguity between soc-api-test and soc-api-fuzz must fail loudly.
  await assert.rejects(
    () => run(tools, 'dispatch_task', { workspace: 'soc-api', task: 'x' }, execAs('main-1')),
    /ambiguous; candidates:/,
  )
  await assert.rejects(
    () => run(tools, 'dispatch_task', { workspace: 'nope', task: 'x' }, execAs('main-1')),
    /no registered workspace matches/,
  )
  await assert.rejects(() => run(tools, 'dispatch_task', { task: 'x' }, execAs('main-1')), /a workspace is required/)
  await assert.rejects(
    () => run(tools, 'dispatch_task', { workspace: 'soc-api-test', task: '   ' }, execAs('main-1')),
    /`task` is empty/,
  )
  console.log('ok 5 — dispatch_task uses the worker preset, briefs it, rejects bad selectors')
}

// --- 6. report_to_main: stored AND delivered ------------------------------

{
  resetRegistry()
  const { tools: mainTools } = mount(mainRow)
  const { tools: workerTools } = mount(workerRow)
  const dispatched = await run(
    mainTools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Do the thing.' },
    execAs('main-1'),
  )

  const value = await run(
    workerTools,
    'report_to_main',
    { summary: 'Changed three files; tests pass.', document: 'Detailed body.', status: 'done' },
    execAs(dispatched.workerSessionId),
  )

  assert.equal(value.deliveredToMain, true, 'the report must be pushed, not merely stored')
  assert.match(value.reportId, /^r-/)
  assert.deepEqual(validateJsonSchemaValue(workerTools.get('report_to_main').output.schema, value, 'value'), [])

  const stored = await readReport(home, 'ws-soc', value.reportId)
  assert.equal(stored.status, 'delivered')
  assert.equal(stored.document, 'Detailed body.')
  assert.deepEqual(stored.deliveredTo, ['main-1'])
  assert.equal(stored.workspaceTitle, 'soc-api-test')
  console.log('ok 6 — report stores the document and delivers to main')
}

// --- 7. report without a dispatch is refused ------------------------------

{
  resetRegistry()
  const { tools } = mount(workerRow)
  await assert.rejects(
    () => run(tools, 'report_to_main', { summary: 'orphan' }, execAs('some-other-session')),
    /no active dispatch/,
  )
  await assert.rejects(
    () => run(tools, 'report_to_main', { summary: '   ' }, execAs('x')),
    /`summary` is empty/,
  )
  await assert.rejects(
    () => run(tools, 'report_to_main', { summary: 's', status: 'brilliant' }, execAs('x')),
    /must be done, partial, or blocked/,
  )
  console.log('ok 7 — undispatched Session refused; empty summary and bad status rejected')
}

// --- 8. enforcement: steer, then escalate ---------------------------------

{
  resetRegistry()
  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow, { maxReportRetries: 2 })
  const dispatched = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Silent worker.' },
    execAs('main-1'),
  )
  const workerId = dispatched.workerSessionId

  const steered = []
  const agent = { session: { id: workerId }, steer: (message) => steered.push(message) }
  const handler = workerMount.listeners.get('agent/turn-stopping')[0]
  assert.ok(handler, 'the worker row must register turn enforcement')

  handler({ agent, turn: 1, signal: new AbortController().signal })
  handler({ agent, turn: 2, signal: new AbortController().signal })
  assert.equal(steered.length, 2, 'each allowed turn steers once')
  assert.match(steered[0].content[0].text, /attempt 1 of 2/)
  assert.match(steered[0].content[0].text, /report_to_main/)
  assert.equal(steered[0].source.kind, 'plugin:discipline-whale')

  const promptsBefore = workerMount.calls.prompt.length
  handler({ agent, turn: 3, signal: new AbortController().signal })
  assert.equal(steered.length, 2, 'the third silent turn no longer steers')

  // Escalation is fire-and-forget; let its promise settle.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const escalations = workerMount.calls.prompt.slice(promptsBefore)
  assert.equal(escalations.length, 1, 'exhausted retries escalate exactly once')
  assert.equal(escalations[0].sessionId, 'main-1', 'the escalation targets the main session')
  assert.match(escalations[0].content[0].text, /failed to report/)
  assert.match(escalations[0].content[0].text, /Open that session/)

  // A worker that does report must never be steered.
  const second = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Reporting worker.' },
    execAs('main-1'),
  )
  await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'done properly' },
    execAs(second.workerSessionId),
  )
  const before = steered.length
  const agent2 = { session: { id: second.workerSessionId }, steer: (m) => steered.push(m) }
  handler({ agent: agent2, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, before, 'a reporting worker is never steered')
  console.log('ok 8 — silent worker steered twice, then escalated; reported worker left alone')
}

// --- 9. send_to_session ---------------------------------------------------

{
  const { tools, calls } = mount(mainRow)
  const value = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-9', message: 'New decision: use Postgres.' },
    execAs('main-1'),
  )
  assert.equal(value.accepted, true)
  assert.equal(value.delivered, 'step', 'a new decision defaults to the step boundary')
  assert.equal(value.aborted, false)
  // The default is the PLAIN steer path: it must reach `next-step` without
  // touching cancel. `aborted` being false is not enough on its own — a future
  // refactor could cancel and still report false.
  assert.equal(calls.cancel.length, 0, 'the default decision must not abort the running turn')
  assert.equal(calls.prompt.at(-1).sessionId, 'worker-9')
  assert.equal(calls.prompt.at(-1).mode, 'steer', 'step delivery uses the steer inbox target')
  assert.match(calls.prompt.at(-1).content[0].text, /use Postgres/)
  await assert.rejects(
    () => run(tools, 'send_to_session', { session_id: 'w', message: '  ' }, execAs('m')),
    /`message` is empty/,
  )
  await assert.rejects(
    () => run(tools, 'send_to_session', { session_id: 'w', message: 'x', at: 'later' }, execAs('m')),
    /`at` must be one of/,
  )
  console.log('ok 9 — send_to_session delivers a new decision at the step boundary by default')
}


// --- 10. restart: the dispatch record survives on disk ---------------------
//
// Reproduced defect: the dispatch registry is a process-local Map, so a Host
// restart empties it while the worker Session itself is durable. A worker that
// outlives its dispatch record could not report at all. The worker half now
// checkpoints the routing record it can see, and falls back to that file when
// the in-memory lookup misses.

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

// New tests only: keeps every line above this block byte-identical to the
// original nine checks (which import no reader).
const { readFile } = await import('node:fs/promises')

/** The checkpoint path the worker half owns (same key rule as a report dir). */
const checkpointPath = (workerSessionId) =>
  join(home, 'discipline-whale', 'dispatches', `${workspaceKey(workerSessionId)}.json`)

{
  resetRegistry()
  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow)
  const dispatched = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Survive a Host restart.' },
    execAs('main-restart'),
  )
  const workerId = dispatched.workerSessionId

  // The worker starts its first turn while the dispatch is still in memory.
  for (const handler of workerMount.listeners.get('agent/status') ?? []) {
    handler({ agent: { session: { id: workerId } }, status: 'running' })
  }
  await settle()

  // Restart: every in-memory dispatch record is gone, the Session is not.
  resetRegistry()

  // This is the field defect, stated plainly: the report must still arrive.
  const value = await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'Finished after the restart.', document: 'body', status: 'done' },
    execAs(workerId),
  )
  assert.equal(value.deliveredToMain, true, 'a restarted worker must still be able to report')

  assert.equal(value.orphaned, undefined, 'a recovered dispatch is not an orphan')
  const warnings = (value.warnings ?? []).join('\n')
  assert.match(warnings, /restart/i, 'the recovery must be disclosed, not silent')

  // The routing facts the worker rebuilt came from its own checkpoint.
  const pushes = workerMount.calls.prompt.map((call) => call.sessionId)
  assert.equal(pushes.at(-1), 'main-restart', 'the checkpoint supplied the target session')

  // A delivered report leaves nothing behind to recover twice.
  await assert.rejects(
    () => readFile(checkpointPath(workerId), 'utf8'),
    /ENOENT/,
    'the checkpoint is dropped once the report is delivered',
  )

  const stored = await readReport(home, 'ws-soc', value.reportId)
  assert.equal(stored.status, 'delivered')
  assert.equal(stored.mainSessionId, 'main-restart')
  assert.deepEqual(stored.deliveredTo, ['main-restart'])
  const pushed = workerMount.calls.prompt.at(-1)
  assert.equal(pushed.sessionId, 'main-restart', 'the report is pushed to the recorded main session')
  assert.match(pushed.content[0].text, /Finished after the restart\./)
  console.log('ok 10 — a restarted worker recovers its dispatch from disk and reports')
}

// --- 11. no record at all: store the report as an orphan ------------------
//
// When even the checkpoint is gone, the worker half must not invent a main
// session. It writes the report to the store under the workspace it can prove
// from its own Session log, and says plainly that nobody was told.

{
  resetRegistry()
  const brief = [
    'You are a Discipline Whale worker. Complete the task below in this workspace.',
    '',
    '## Task',
    'Do a thing.',
    '',
    '## Mandatory closing step',
    'Before your turn ends you MUST call `report_to_main` exactly once:',
  ].join('\n')
  const workerMount = mount(workerRow)
  // A real Host can replay the Session log, which is where the dispatch brief lives.
  workerMount.ctx.sessionController.inspect = async (sessionId) => ({
    meta: { id: sessionId, cwd: '/Users/huiyuan/Developer/test/soc-api-test', createdAt: 0 },
    inheritedEventCount: 0,
    events: [
      {
        type: 'user/message',
        seq: 0,
        time: 0,
        data: { role: 'user', content: [{ type: 'text', text: brief }] },
        surfaceOp: 'append',
      },
    ],
  })

  const value = await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'Done, but nobody is listening.', document: 'orphan body', status: 'partial' },
    execAs('session-orphan-1'),
  )
  assert.ok(value, 'a dispatched Session with no recoverable record must still be able to report')
  assert.equal(value.deliveredToMain, false, 'an orphan must not claim delivery')
  assert.equal(value.orphaned, true, 'the result must be marked orphaned')
  const warnings = (value.warnings ?? []).join('\n')
  assert.match(warnings, /restart/i, 'the cause must be named')
  assert.match(warnings, /read_report/, 'the operator must be told how to retrieve it')

  const stored = await readReport(home, 'ws-soc', value.reportId)
  assert.equal(stored.status, 'reported')
  assert.equal(stored.orphaned, true)
  assert.equal(stored.document, 'orphan body')
  assert.deepEqual(stored.deliveredTo, [], 'nothing was pushed')
  assert.equal(workerMount.calls.prompt.length, 0, 'an orphan never guesses a target session')
  console.log('ok 11 — a report with no recoverable dispatch is stored and marked orphaned')
}

// --- 12. an errored turn still checkpoints, and nudges once on recovery ---
//
// agent-loop dispatches `agent/turn-stopping` only on a normal close
// (lib/index.js: turnEnds && inbox empty, inside the step loop). An `error`
// (TRANSPORT) or `aborted` turn leaves through the catch at ~1010 and never
// reaches it, so enforcement used to miss exactly the turns that fail. The
// outage itself cannot be pushed through — the goal is not to report while the
// network is down, it is to lose nothing once it is back.

{
  resetRegistry()
  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow, { maxReportRetries: 3 })
  const dispatched = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Work through an outage.' },
    execAs('main-outage'),
  )
  const workerId = dispatched.workerSessionId

  const steered = []
  const agent = { session: { id: workerId }, steer: (message) => steered.push(message) }
  const emit = (name, ...payload) => {
    for (const handler of workerMount.listeners.get(name) ?? []) handler(...payload)
  }

  emit('agent/error', { agent, turn: 1, step: 2, error: new Error('Connection error.') })
  await settle()
  assert.equal(steered.length, 0, 'nothing is steered while the transport is down')
  const pushes = workerMount.calls.prompt.filter((call) => call.sessionId === 'main-outage')
  assert.equal(pushes.length, 0, 'nothing is pushed while the transport is down')
  const checkpoint = await readFile(checkpointPath(workerId), 'utf8').catch(() => undefined)
  assert.ok(checkpoint, 'the errored turn still leaves a recoverable record')
  assert.equal(JSON.parse(checkpoint).mainSessionId, 'main-outage')

  // The transport comes back: the driver drains to idle with no report.
  emit('agent/status', { agent, status: 'running' })
  emit('agent/status', { agent, status: 'idle' })
  await settle()
  assert.equal(steered.length, 1, 'recovery nudges exactly once')

  // A later idle from the same (already answered) turn must not nudge again.
  emit('agent/status', { agent, status: 'idle' })
  await settle()
  assert.equal(steered.length, 1, 'one abnormal turn is counted once, not once per idle transition')
  assert.equal(steered.length, 1, 'recovery nudges exactly once, not once per idle transition')
  assert.match(steered[0].content[0].text, /report_to_main/)
  assert.match(steered[0].content[0].text, /restart|recover|transport|error/i)

  // A normal close is answered by turn-stopping; the following idle must not
  // count the same turn a second time.
  const turnStopping = (payload) => emit('agent/turn-stopping', payload)
  const second = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Close normally.' },
    execAs('main-outage'),
  )
  const agent2 = { session: { id: second.workerSessionId }, steer: (m) => steered.push(m) }
  turnStopping({ agent: agent2, turn: 1, signal: new AbortController().signal })
  emit('agent/status', { agent: agent2, status: 'idle' })
  await settle()
  assert.equal(steered.length, 2, 'a normal close is enforced once, not twice')

  // An aborted turn never reaches agent/error either; only the log records it.
  const abortWorker = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Abort mid-turn.' },
    execAs('main-outage'),
  )
  const agent3 = { session: { id: abortWorker.workerSessionId }, steer: (m) => steered.push(m) }
  emit('session/event', { id: abortWorker.workerSessionId }, {
    type: 'turn/end',
    seq: 3,
    time: 0,
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  emit('agent/status', { agent: agent3, status: 'idle' })
  await settle()
  assert.equal(steered.length, 3, 'an aborted turn is enforced on idle too')
  assert.match(steered[2].content[0].text, /aborted/i)

  // `blocked` returns from the step loop before turn-stopping as well.
  const blockedWorker = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Blocked before a step.' },
    execAs('main-outage'),
  )
  const agent4 = { session: { id: blockedWorker.workerSessionId }, steer: (m) => steered.push(m) }
  emit('session/event', { id: blockedWorker.workerSessionId }, {
    type: 'turn/end',
    seq: 3,
    time: 0,
    data: { turn: 1, reason: { kind: 'blocked' } },
  })
  emit('agent/status', { agent: agent4, status: 'idle' })
  await settle()
  assert.equal(steered.length, 4, 'a blocked turn is enforced on idle too')
  assert.match(steered[3].content[0].text, /blocked/i)
  console.log('ok 12 — failed turns checkpoint without pushing, then nudge once per turn on idle')
}


// --- 13. enforcement survives the restart too -----------------------------
//
// Recovery is pointless if only the report tool knows about it: a worker whose
// dispatch was lost must still be nudged to report. The checkpoint is read back
// on the first lifecycle event after the restart.

{
  resetRegistry()
  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow, { maxReportRetries: 2 })
  const dispatched = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Restart, then stay silent.' },
    execAs('main-r1'),
  )
  const workerId = dispatched.workerSessionId

  const emit = (name, ...payload) => {
    for (const handler of workerMount.listeners.get(name) ?? []) handler(...payload)
  }
  emit('agent/status', { agent: { session: { id: workerId } }, status: 'running' })
  await settle()

  // Restart again: memory is empty, only the checkpoint remains.
  resetRegistry()

  const steered = []
  const agent = { session: { id: workerId }, steer: (message) => steered.push(message) }

  // `agent/turn-stopping` is the FIRST lifecycle event after this restart and it
  // is a `serial` event: a handler that recovers must hand back a promise, or
  // enforcement runs before the record exists. Pending handler values are
  // awaited here exactly as the loop awaits them.
  const stopping = (workerMount.listeners.get('agent/turn-stopping') ?? []).map((handler) =>
    handler({ agent, turn: 2, signal: new AbortController().signal }),
  )
  await Promise.all(stopping)

  assert.equal(steered.length, 1, 'a recovered dispatch is still enforced after a restart')
  assert.match(steered[0].content[0].text, /report_to_main/)

  // Reporting then works without any further recovery step.
  const value = await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'Reported after the restart nudge.' },
    execAs(workerId),
  )
  assert.equal(value.deliveredToMain, true)
  assert.equal(workerMount.calls.prompt.at(-1).sessionId, 'main-r1')

  // And a reported worker is no longer nudged.
  const before = steered.length
  await Promise.all(
    (workerMount.listeners.get('agent/turn-stopping') ?? []).map((handler) =>
      handler({ agent, turn: 3, signal: new AbortController().signal }),
    ),
  )
  assert.equal(steered.length, before, 'a reported worker is left alone after a restart')
  console.log('ok 13 — enforcement reads the checkpoint back, nudges, then stands down')
}

// --- 14. list_dispatches: the board --------------------------------------------------
//
// The board is a read-only projection of the process-local registry. It must be
// usable with nothing dispatched, must not disagree with the registry about the
// three states, and must never emit a negative or non-finite duration from a
// record whose timestamps are missing or dirty.

{
  resetRegistry()
  const { tools } = mount(mainRow)

  const empty = await run(tools, 'list_dispatches', {}, execAs('main-board'))
  assert.deepEqual(empty.dispatches, [], 'an empty registry lists an empty board')
  assert.deepEqual(empty.counts, { total: 0, running: 0, reported: 0, abandoned: 0 })
  assert.match(empty.note, /no dispatch has been recorded/)
  assert.deepEqual(
    validateJsonSchemaValue(tools.get('list_dispatches').output.schema, empty, 'value'),
    [],
  )

  // One running, one reported, one abandoned.
  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow, { maxReportRetries: 0 })
  const running = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Still in flight.' },
    execAs('main-board'),
  )
  const reported = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Reported cleanly.' },
    execAs('main-board'),
  )
  const abandoned = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'ws-harness', task: 'Never reports.' },
    execAs('main-board'),
  )

  await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'done', status: 'done' },
    execAs(reported.workerSessionId),
  )

  // `maxReportRetries: 0` makes the first silent turn the terminal one.
  const agent = { session: { id: abandoned.workerSessionId }, steer() {} }
  for (const handler of workerMount.listeners.get('agent/turn-stopping') ?? []) {
    await handler({ agent, turn: 1, signal: new AbortController().signal })
  }
  await settle()

  const board = await run(tools, 'list_dispatches', {}, execAs('main-board'))
  assert.equal(board.counts.total, 3)
  assert.equal(board.counts.running, 1)
  assert.equal(board.counts.reported, 1)
  assert.equal(board.counts.abandoned, 1)

  const byWorker = new Map(board.dispatches.map((row) => [row.workerSessionId, row]))
  assert.equal(byWorker.get(running.workerSessionId).status, 'running')
  assert.equal(byWorker.get(reported.workerSessionId).status, 'reported')
  assert.equal(byWorker.get(abandoned.workerSessionId).status, 'abandoned')
  for (const row of board.dispatches) {
    assert.ok(Number.isInteger(row.elapsed.ms), `elapsed.ms must be an integer: ${row.elapsed.ms}`)
    assert.ok(row.elapsed.ms >= 0, `elapsed must never be negative: ${row.elapsed.ms}`)
    assert.ok(!/NaN|Infinity/.test(row.elapsed.human), `elapsed.human must be printable: ${row.elapsed.human}`)
    assert.ok(!Number.isNaN(Date.parse(row.lastActivityAt)), 'lastActivityAt must parse')
  }
  assert.deepEqual(
    validateJsonSchemaValue(tools.get('list_dispatches').output.schema, board, 'value'),
    [],
  )

  // Newest first, and the optional workspace filter narrows without throwing.
  const onlyHarness = await run(tools, 'list_dispatches', { workspace: 'harness' }, execAs('main-board'))
  assert.equal(onlyHarness.counts.total, 3, 'counts describe the whole board, not the filter')
  assert.equal(onlyHarness.dispatches.length, 1)
  assert.equal(onlyHarness.dispatches[0].workspaceId, 'ws-harness')

  const limited = await run(tools, 'list_dispatches', { limit: 1 }, execAs('main-board'))
  assert.equal(limited.dispatches.length, 1)
  assert.equal(limited.counts.total, 3, 'the limit truncates rows, not the counts')
  assert.match(limited.note, /1 of 3/)

  await assert.rejects(() => run(tools, 'list_dispatches', { limit: 2.5 }, execAs('m')), /must be an integer/)
  console.log('ok 14 — list_dispatches: empty board, three states, no negative or NaN elapsed')
}

// --- 15. the dispatch record reaches disk when dispatch_task returns --------
//
// Reproduced gap: the worker half checkpoints on its FIRST lifecycle event, so a
// restart in the window between `dispatch_task` returning and that first event
// still lost the record and fell back to the orphan path. The main half now
// writes the same checkpoint file itself, at the moment it knows the routing
// facts, so the two halves cannot disagree.

{
  resetRegistry()
  const { dispatchCheckpointPath } = await import('../worker.js')
  assert.equal(
    dispatchCheckpointPath(home, 'session/with:odd chars'),
    checkpointPath('session/with:odd chars'),
    'both halves must derive the same checkpoint path from the same session id',
  )

  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow)
  const dispatched = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Restart before the first turn.' },
    execAs('main-persist'),
  )
  const workerId = dispatched.workerSessionId

  // No lifecycle event is delivered here on purpose: this is exactly the window
  // where the worker has not yet spoken and the old checkpoint never existed.
  const onDisk = JSON.parse(await readFile(checkpointPath(workerId), 'utf8'))
  assert.equal(onDisk.mainSessionId, 'main-persist')
  assert.equal(onDisk.dispatchId, dispatched.dispatchId)
  assert.equal(onDisk.workerSessionId, workerId)
  assert.equal(onDisk.workspaceId, 'ws-soc')
  assert.equal(onDisk.workspaceTitle, 'soc-api-test')

  // Restart: memory emptied, disk untouched.
  resetRegistry()
  const value = await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'Reported from the dispatch-time checkpoint.', status: 'done' },
    execAs(workerId),
  )
  assert.equal(value.deliveredToMain, true, 'a restart before the first turn must not orphan the report')
  assert.equal(value.orphaned, undefined)
  assert.equal(workerMount.calls.prompt.at(-1).sessionId, 'main-persist')
  assert.match(workerMount.calls.prompt.at(-1).content[0].text, /main-persist|Worker report/)
  assert.deepEqual(
    validateJsonSchemaValue(workerMount.tools.get('report_to_main').output.schema, value, 'value'),
    [],
  )

  // Delivery drops the checkpoint, once, from whichever half wrote it.
  await assert.rejects(
    () => readFile(checkpointPath(workerId), 'utf8'),
    /ENOENT/,
    'the dispatch-time checkpoint is removed after delivery',
  )
  const stored = await readReport(home, 'ws-soc', value.reportId)
  assert.equal(stored.status, 'delivered')
  assert.equal(stored.recoveredFrom, 'checkpoint')
  console.log('ok 15 — dispatch_task persists the checkpoint itself, so a restart before turn 1 still reports')
}

// --- 15b. a failed checkpoint write must never fail the dispatch -----------

{
  resetRegistry()
  const { mkdir, writeFile: write } = await import('node:fs/promises')
  const brokenHome = await mkdtemp(join(tmpdir(), 'dw-broken-'))
  // A regular file where the checkpoint directory must be: `mkdir` then fails
  // with ENOTDIR, exactly the shape of an unwritable store.
  await mkdir(join(brokenHome, 'discipline-whale'), { recursive: true })
  await write(join(brokenHome, 'discipline-whale', 'dispatches'), 'not a directory', 'utf8')

  try {
    setStoreRoot(brokenHome)
    const { tools, calls } = mount(mainRow)
    const value = await run(
      tools,
      'dispatch_task',
      { workspace: 'soc-api-test', task: 'The store is unwritable.' },
      execAs('main-broken'),
    )
    assert.equal(value.status, 'dispatched', 'a checkpoint failure must not fail the dispatch')
    assert.equal(calls.prompt.length, 1, 'the worker is still briefed')
    const warnings = (value.warnings ?? []).join('\n')
    assert.match(warnings, /checkpoint|restart/i, 'the lost durability must be disclosed as a warning')
    assert.deepEqual(
      validateJsonSchemaValue(tools.get('dispatch_task').output.schema, value, 'value'),
      [],
    )
  } finally {
    setStoreRoot(home)
    await rm(brokenHome, { recursive: true, force: true })
  }
  console.log('ok 15b — an unwritable store warns but still dispatches')
}

// --- 16. the board tolerates records the worker half wrote -----------------
//
// After a recovery the same record carries fields `dispatch_task` never wrote
// (`recoveredFrom`, `orphaned`, and a `mainSessionId` that may be missing), and
// after a hand-edited store its timestamps may be junk. A read-only board must
// survive all of it instead of throwing inside a tool call.

{
  resetRegistry()
  const { recordDispatch } = await import('../registry.js')
  recordDispatch({
    dispatchId: 'dispatch-recovered',
    mainSessionId: 'main-recovered',
    workerSessionId: 'worker-recovered',
    workspaceId: 'ws-soc',
    workspaceTitle: 'soc-api-test',
    startedAt: new Date(Date.now() - 5000).toISOString(),
    reportedAt: new Date().toISOString(),
    status: 'reported',
    reportId: 'r-recovered',
    recoveredFrom: 'checkpoint',
  })
  recordDispatch({
    dispatchId: 'dispatch-orphaned',
    workerSessionId: 'worker-orphaned',
    workspaceId: 'ws-soc',
    workspaceTitle: 'soc-api-test',
    startedAt: 'soon',
    orphaned: true,
    recoveredFrom: 'session-log',
  })

  const { tools } = mount(mainRow)
  const board = await run(tools, 'list_dispatches', {}, execAs('main-board'))
  const byId = new Map(board.dispatches.map((row) => [row.dispatchId, row]))

  assert.equal(byId.get('dispatch-recovered').status, 'reported')
  assert.ok(byId.get('dispatch-recovered').elapsed.ms >= 0)
  assert.equal(byId.get('dispatch-recovered').lastActivitySource, 'reported')
  assert.equal(byId.get('dispatch-recovered').recoveredFrom, 'checkpoint')
  assert.equal(byId.get('dispatch-recovered').orphaned, undefined, 'a recovered dispatch with a main session is not orphaned')
  assert.match((byId.get('dispatch-recovered').warnings ?? []).join('\n'), /checkpoint/)

  // No main session id at all: the board still renders the row, no crash.
  const orphanRow = byId.get('dispatch-orphaned')
  assert.equal(orphanRow.status, 'running')
  assert.equal(orphanRow.elapsed.ms, 0, 'an unparseable startedAt reports 0, never NaN')
  assert.equal(orphanRow.recoveredFrom, 'session-log', 'the board keeps the recovery source visible')
  assert.equal(orphanRow.orphaned, true, 'a record with no main session is reported as orphaned')
  assert.match((orphanRow.warnings ?? []).join('\n'), /startedAt/)
  assert.match((orphanRow.warnings ?? []).join('\n'), /will not be pushed/)
  assert.deepEqual(
    validateJsonSchemaValue(tools.get('list_dispatches').output.schema, board, 'value'),
    [],
  )
  console.log('ok 16 — the board survives recovered/orphaned records and dirty timestamps')
}

// --- 17. a delivered dispatch must not come back to life --------------------
//
// The two halves now share one file, which introduces a gap neither half had
// alone: `report_to_main` drops the checkpoint on delivery, but the dispatch is
// still in memory and the Session keeps emitting lifecycle events. A later
// `agent/status` used to re-create the file for an already-delivered dispatch,
// so the next restart recovered it and enforced/pushed a SECOND report.

{
  resetRegistry()
  const mainMount = mount(mainRow)
  const workerMount = mount(workerRow)
  const dispatched = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Report once, then go quiet.' },
    execAs('main-once'),
  )
  const workerId = dispatched.workerSessionId

  const first = await run(
    workerMount.tools,
    'report_to_main',
    { summary: 'First and only report.' },
    execAs(workerId),
  )
  assert.equal(first.deliveredToMain, true)
  await assert.rejects(() => readFile(checkpointPath(workerId), 'utf8'), /ENOENT/)

  // The Session is still alive: its driver keeps reporting status transitions.
  const pushesBefore = workerMount.calls.prompt.length
  for (const handler of workerMount.listeners.get('agent/status') ?? []) {
    await handler({ agent: { session: { id: workerId } }, status: 'running' })
    await handler({ agent: { session: { id: workerId } }, status: 'idle' })
  }
  for (const handler of workerMount.listeners.get('agent/turn-stopping') ?? []) {
    await handler({ agent: { session: { id: workerId }, steer() {} }, turn: 2, signal: new AbortController().signal })
  }
  await settle()

  // Nothing may re-create the checkpoint for a dispatch that already delivered.
  await assert.rejects(
    () => readFile(checkpointPath(workerId), 'utf8'),
    /ENOENT/,
    'a later lifecycle event must not resurrect a delivered checkpoint',
  )
  assert.equal(workerMount.calls.prompt.length, pushesBefore, 'a delivered dispatch is never pushed twice')

  // And after a restart nothing is recoverable, so the next turn cannot enforce
  // a second report against the same Session.
  resetRegistry()
  await assert.rejects(
    () =>
      run(workerMount.tools, 'report_to_main', { summary: 'duplicate' }, execAs(workerId)),
    /no active dispatch/,
    'a delivered dispatch must not be recoverable as a fresh one',
  )
  console.log('ok 17 — a delivered checkpoint is never re-created by a later lifecycle event')
}

// --- 18. the whale's home ------------------------------------------------

{
  // Earlier blocks leave dispatch checkpoints behind; a fresh home has none.
  await rm(join(home, 'discipline-whale', 'dispatches'), { recursive: true, force: true })
  const homePath = await ensureHome()
  assert.equal(homePath, join(home, 'discipline-whale', 'home'))
  assert.equal((await stat(homePath)).isDirectory(), true)

  const calls = { create: [], rename: [], prompt: [] }
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const controller = {
    create: async (request) => {
      calls.create.push(request)
      await gate
      return { sessionId: `session-main-${calls.create.length}`, agentPreset: request.agentPreset }
    },
    rename: async (request) => {
      calls.rename.push(request)
      return { title: request.title }
    },
    prompt: async (request, signal) => {
      assert.ok(signal instanceof AbortSignal)
      calls.prompt.push(request)
    },
  }
  const handle = homeHandler(controller)
  const request = (method) => handle(new Request(`http://dsh${HOME_ROUTE}`, { method }))

  assert.deepEqual(await (await request('GET')).json(), { home: homePath, mainSessionId: null })

  // Two POSTs racing (a double click) create exactly one main session.
  const first = request('POST')
  const second = request('POST')
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(await a.json(), { home: homePath, mainSessionId: 'session-main-1' })
  assert.deepEqual(await b.json(), { home: homePath, mainSessionId: 'session-main-1' })
  assert.equal(calls.create.length, 1)
  assert.deepEqual(calls.create[0], { cwd: homePath, agentPreset: MAIN_PRESET })
  assert.deepEqual(calls.rename[0], { sessionId: 'session-main-1', title: MAIN_TITLE })
  assert.equal(calls.prompt.length, 1, 'a new main session is woken with its first turn')
  assert.equal(calls.prompt[0].sessionId, 'session-main-1')
  assert.equal(calls.prompt[0].content[0].text, WAKE_PROMPT)

  assert.equal((await request('GET')).headers.get('cache-control'), 'no-store')
  assert.deepEqual(await readState(), { mainSessionId: 'session-main-1' })
  console.log('ok 18 — the home exists and one main session is created, woken and recorded')
}

// --- 19. interrupted dispatches after a restart -----------------------------

{
  resetRegistry()
  await rm(join(home, 'discipline-whale', 'dispatches'), { recursive: true, force: true })

  const interrupted = (worker, startedAt) => ({
    dispatchId: `dispatch-${worker}`,
    mainSessionId: 'session-main-1',
    workspaceId: 'ws-soc',
    workspaceTitle: 'soc-api-test',
    startedAt,
  })
  await writeDispatchCheckpoint(home, 'worker-late', interrupted('worker-late', '2026-10-20T17:13:00.000Z'))
  await writeDispatchCheckpoint(home, 'worker-early', interrupted('worker-early', '2026-10-20T17:08:00.000Z'))
  await writeFile(join(home, 'discipline-whale', 'dispatches', 'broken.json'), '{not json', 'utf8')

  const listed = await listDispatchCheckpoints(home)
  assert.deepEqual(listed.map((record) => record.workerSessionId), ['worker-early', 'worker-late'])

  // The startup check tells the recorded main session, listing every dispatch.
  const prompts = []
  const controller = {
    prompt: async (request, signal) => {
      signal.throwIfAborted()
      prompts.push(request)
    },
  }
  assert.equal(await startupCheck(controller), 2)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'session-main-1')
  const notice = prompts[0].content[0].text
  for (const needle of ['worker-early', 'worker-late', 'soc-api-test', 'ask_user', 'resume_dispatch', 'abandon_dispatch']) {
    assert.ok(notice.includes(needle), `the startup notice must mention ${needle}`)
  }
  assert.equal(interruptedNotice([]), undefined)

  // Resume wakes the worker, reroutes its report to the resuming session and
  // puts the dispatch back on the board.
  const { tools, calls } = mount(mainRow)
  const resumed = await run(tools, 'resume_dispatch', { worker_session_id: 'worker-early', note: 'skip the docs' }, execAs('session-main-2'))
  assert.deepEqual(resumed, { dispatchId: 'dispatch-worker-early', workerSessionId: 'worker-early', status: 'resumed' })
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].sessionId, 'worker-early')
  assert.ok(calls.prompt[0].content[0].text.startsWith(RESUME_BRIEF))
  assert.ok(calls.prompt[0].content[0].text.includes('skip the docs'))
  assert.equal((await readDispatchCheckpoint(home, 'worker-early')).mainSessionId, 'session-main-2')
  const board = await run(tools, 'list_dispatches', {}, execAs('session-main-2'))
  assert.equal(board.dispatches.some((row) => row.workerSessionId === 'worker-early' && row.status === 'running'), true)

  // Abandon forgets the checkpoint; a second call finds nothing to act on.
  const abandoned = await run(tools, 'abandon_dispatch', { worker_session_id: 'worker-late' }, execAs('session-main-2'))
  assert.equal(abandoned.status, 'abandoned')
  assert.equal(await readDispatchCheckpoint(home, 'worker-late'), undefined)
  await assert.rejects(() => run(tools, 'abandon_dispatch', { worker_session_id: 'worker-late' }), /no interrupted dispatch/)
  assert.equal(isDispatchAbandoned(home, 'worker-late'), true)

  // The worker preset keeps its own registry, so the abandon must reach it
  // through disk. Simulate that realm: a fresh registry recovers the resumed
  // dispatch from its checkpoint and steers once; after the main session
  // abandons it (marker written, checkpoint gone) the worker is left alone and
  // the checkpoint is not written back.
  resetRegistry()
  const workerMount = mount(workerRow, { maxReportRetries: 3 })
  const steered = []
  const agent = { session: { id: 'worker-early' }, steer: (message) => steered.push(message) }
  const stopping = workerMount.listeners.get('agent/turn-stopping')[0]
  await stopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(steered.length, 1, 'a resumed worker is asked for its report')

  await markDispatchAbandoned(home, 'worker-early', 'dispatch-worker-early')
  await rm(join(home, 'discipline-whale', 'dispatches', 'worker-early.json'), { force: true })
  await stopping({ agent, turn: 2, signal: new AbortController().signal })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(steered.length, 1, 'an abandoned dispatch is no longer enforced')
  assert.equal(workerMount.calls.prompt.length, 0, 'abandoning never escalates to the main session')
  assert.equal(await readDispatchCheckpoint(home, 'worker-early'), undefined, 'the checkpoint stays gone')
  console.log('ok 19 — interrupted dispatches are reported at startup and can be resumed or abandoned')
}

// --- 20. the voice routes ride the same connection ------------------------

{
  // The home row is the only row that holds connection + sessionController, so
  // it also owns the voice routes. Mount it and read back what it registered.
  const routes = []
  const prompts = []
  // The credential seam the real Host mounts; `home.js` reads it through
  // `ctx.get('credentials')` and must survive its absence too.
  const credentialStore = new Map()
  const credentials = {
    async describe() {
      return credentialStore.has('SOCLAAS_API_KEY')
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true }
    },
    async resolve() {
      return credentialStore.has('SOCLAAS_API_KEY')
        ? { value: credentialStore.get('SOCLAAS_API_KEY'), source: 'file' }
        : undefined
    },
    async set(_ref, value) { credentialStore.set('SOCLAAS_API_KEY', value) },
    async unset() { credentialStore.delete('SOCLAAS_API_KEY') },
  }
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    // `ctx.get('credentials')` is how home.js finds the Host's credential seam;
    // this fake Host exposes one (the same describe/resolve/set shape the real
    // provider has) so the composition path is exercised, not skipped.
    get: (name) => (name === 'credentials' ? credentials : undefined),
    inject: (_services, run) => run({
      sessionController: {
        prompt: async (request, signal) => {
          signal.throwIfAborted()
          prompts.push(request)
          return { accepted: true }
        },
      },
      connection: { fetch: { register: async (route) => { routes.push(route); return async () => {} } } },
      webServer: {},
    }),
  }
  const homeRow = await import('../home.js')
  homeRow.apply(ctx)
  // apply() registers synchronously inside ctx.inject above; the startup check
  // is fire-and-forget, so give it a tick before asserting on routes.
  await new Promise((resolve) => setTimeout(resolve, 10))

  const paths = routes.map((route) => route.path)
  assert.ok(paths.includes(HOME_ROUTE), 'the home route stays registered')
  assert.ok(paths.includes(VOICE_ROUTE), 'the transcribe route is registered')
  assert.ok(paths.includes(VOICE_STATUS_ROUTE), 'the status route is registered')
  assert.ok(paths.includes(VOICE_SAY_ROUTE), 'the say route is registered')
  // The settings pair rides the same connection, so the browser half never
  // needs a second server to configure voice.
  assert.ok(paths.includes(VOICE_SETTINGS_ROUTE), 'the settings route is registered')
  assert.ok(paths.includes(VOICE_TEST_ROUTE), 'the connection-test route is registered')
  // The page's speech detector rides the same connection: no CDN, no second server.
  assert.ok(paths.includes('/api/discipline-whale/voice/vad/bundle.min.js'), 'the detector bundle route is registered')
  assert.ok(paths.includes('/api/discipline-whale/voice/vad/silero_vad_v5.onnx'), 'the Silero model route is registered')

  const say = routes.find((route) => route.path === VOICE_SAY_ROUTE)
  assert.deepEqual(say.methods, ['POST'])
  assert.equal(say.requestBody, 'buffered')

  // The say route steers into the recorded main session and nothing else:
  // the step-boundary insert, so a sentence said while the whale works lands
  // after its current tool call instead of waiting for the whole turn.
  const response = await say.fetch(new Request(`http://dsh${VOICE_SAY_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '帮我看看今天的派工' }),
  }))
  assert.equal(response.status, 200)
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'session-main-1')
  assert.equal(prompts[0].mode, 'steer')
  assert.equal(prompts[0].content[0].text, '帮我看看今天的派工')
  console.log('ok 20 — the voice routes are mounted by the home row and reach the main session')
}

// --- 21. continuation: the two delivery timings on the same Session --------
//
// The distinction that matters (verified against the Host source, see test
// 25): `queue` waits for the whole turn, `steer` lands at the
// nearest STEP boundary — inside the same turn. The second one is "Interrupt"
// in the user's sense. `abort` is a separate, last-resort third behaviour.

{
  resetRegistry()
  const { tools, calls } = mount(mainRow)

  // queue: wait for the current TURN to finish, then take the new instruction.
  const queued = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-live', message: 'Also cover the empty case.', at: 'queue' },
    execAs('main-1'),
  )
  assert.deepEqual(queued, {
    sessionId: 'worker-live',
    accepted: true,
    delivered: 'queue',
    aborted: false,
  })
  assert.equal(calls.cancel.length, 0, 'queue must not abort anything')
  assert.equal(calls.prompt.at(-1).mode, 'queue')

  // step boundary (the user's "Interrupt"): `steer` — admitted before the next
  // step of the SAME turn, so the worker re-plans with the new instruction and
  // keeps its context. No abort: the in-flight tool call finishes normally.
  const stepped = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-live', message: 'Stop reading; the answer is in guard.js.', at: 'step' },
    execAs('main-1'),
  )
  assert.deepEqual(stepped, {
    sessionId: 'worker-live',
    accepted: true,
    delivered: 'step',
    aborted: false,
  })
  assert.equal(calls.cancel.length, 0, 'a step-boundary insert must never abort the running turn')
  assert.equal(calls.prompt.at(-1).mode, 'steer', 'step delivery is the steer inbox target')

  // abort: the last-resort third behaviour, explicit and separately named.
  const aborted = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-live', message: 'Wrong file. Stop now.', at: 'abort' },
    execAs('main-1'),
  )
  assert.deepEqual(aborted, {
    sessionId: 'worker-live',
    accepted: true,
    delivered: 'abort',
    aborted: true,
  })
  assert.deepEqual(calls.cancel.at(-1), { sessionId: 'worker-live' }, 'abort cancels that Session')
  assert.equal(calls.prompt.at(-1).mode, 'steer', 'after the abort, the instruction still steers in')

  // A cold Session has no live Agent to abort: cancelling is best effort, the
  // instruction is still delivered, and `aborted` honestly reports false.
  const coldMount = mount(mainRow)
  coldMount.ctx.sessionController.cancel = async () => {
    throw new Error('session/not-found')
  }
  const cold = await run(
    coldMount.tools,
    'send_to_session',
    { session_id: 'worker-cold', message: 'Resume this work.', at: 'abort' },
    execAs('main-1'),
  )
  assert.equal(cold.aborted, false, 'no turn was aborted, and the answer must not claim one was')
  assert.equal(cold.accepted, true, 'a failed abort must not drop the instruction')
  assert.equal(coldMount.calls.prompt.at(-1).mode, 'steer')

  // The step boundary is also the default when `at` is omitted, and that
  // default must not abort anything.
  const defaulted = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-live', message: 'One more requirement.' },
    execAs('main-1'),
  )
  assert.equal(defaulted.delivered, 'step', 'an omitted `at` means the step boundary')
  assert.equal(calls.cancel.length, 1, 'the default must not add another abort')
  console.log('ok 21 — queue waits for the turn, `at:"step"` inserts at the step boundary, `at:"abort"` aborts')
}

// --- 22. one thread of work keeps one Session ------------------------------

{
  resetRegistry()
  const mainMount = mount(mainRow, { workerPreset: 'discipline-whale-worker' })
  const workerMount = mount(workerRow)
  const { tools, calls } = mainMount

  const first = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Add the voice input toggle.', title: 'voice', topic: 'voice-input' },
    execAs('main-1'),
  )
  assert.equal(first.status, 'dispatched')
  assert.equal(first.reused, false)
  assert.equal(calls.create.length, 1)

  // Same workspace + same topic, still running: continue that Session instead
  // of minting a second one that would fight it over the same files. The
  // default delivery is the step boundary — the user's "Interrupt".
  const second = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: '也支持长按说话。', topic: 'voice-input' },
    execAs('main-1'),
  )
  assert.equal(second.status, 'reused', 'a live dispatch on the same topic is reused')
  assert.equal(second.reused, true)
  assert.equal(second.workerSessionId, first.workerSessionId)
  assert.equal(second.dispatchId, first.dispatchId)
  assert.equal(calls.create.length, 1, 'no second Session is created')
  assert.equal(second.deliveredAs, 'step', 'continuing a live dispatch inserts at the step boundary by default')
  assert.equal(calls.prompt.at(-1).sessionId, first.workerSessionId)
  assert.equal(calls.prompt.at(-1).mode, 'steer', 'step delivery uses the steer inbox target')
  assert.equal(calls.cancel.length, 0, 'the default continuation never aborts the worker')

  // `at: "queue"` is available when the caller really wants the whole turn to
  // finish first.
  const queuedContinuation = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: '不着急，跑完再说。', topic: 'voice-input', at: 'queue' },
    execAs('main-1'),
  )
  assert.equal(queuedContinuation.status, 'reused')
  assert.equal(queuedContinuation.deliveredAs, 'queue')
  assert.equal(calls.prompt.at(-1).mode, 'queue')

  // An explicit abort continues it too, but interrupts the running tool call.
  const third = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: '别再看文档了，直接改 guard.js。', topic: 'Voice-Input ', at: 'abort' },
    execAs('main-1'),
  )
  assert.equal(third.status, 'reused')
  assert.equal(third.deliveredAs, 'abort')
  assert.equal(calls.cancel.at(-1).sessionId, first.workerSessionId)
  assert.equal(calls.prompt.at(-1).mode, 'steer')

  // A different topic is a different job: a new Session is allowed — provided
  // its declared write scope does not collide with a live Session.
  const other = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Rework the voice panel.', topic: 'sdk-bump', writes: ['src/voice'] },
    execAs('main-1'),
  )
  assert.equal(other.status, 'dispatched')
  assert.equal(calls.create.length, 2)

  // Two live Sessions in one workspace may write the same tree only when their
  // declared scopes do not overlap.
  await assert.rejects(
    () =>
      run(
        tools,
        'dispatch_task',
        { workspace: 'soc-api-test', task: 'Touch the same file.', topic: 'other-work', writes: ['src/voice/panel'] },
        execAs('main-1'),
      ),
    /overlap/i,
    'overlapping write scopes in one workspace must be refused',
  )
  const disjoint = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Unrelated area.', topic: 'docs-work', writes: ['docs/'] },
    execAs('main-1'),
  )
  assert.equal(disjoint.status, 'dispatched')

  // Once the first worker reports, the thread is finished: a new dispatch on
  // that topic is a new Session, not a resurrection.
  await run(workerMount.tools, 'report_to_main', { summary: 'voice input done' }, execAs(first.workerSessionId))
  const afterReport = await run(
    tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Follow-up polish.', topic: 'voice-input' },
    execAs('main-1'),
  )
  assert.equal(afterReport.status, 'dispatched', 'a reported dispatch is never reused')
  assert.notEqual(afterReport.workerSessionId, first.workerSessionId)
  console.log('ok 22 — one topic keeps one Session; write-scope overlap is refused; reported work starts fresh')
}

// --- 23. the persona really reaches the assembled system prompt -----------

{
  const { assemblePresetPrompt } = await import('../prompt-probe.mjs')

  const main = await assemblePresetPrompt('discipline-whale')
  // The dispatch-first discipline, verbatim in the assembled prompt.
  for (const needle of [
    '派工优先',
    '最多 2 次',
    '那就该立刻停手派工',
    '往正在跑的会话插话',
    '最近一个步边界',
    '合成一个 brief',
    '派工不等于完成',
  ]) {
    assert.ok(main.includes(needle), `the main persona must contain ${JSON.stringify(needle)}`)
  }
  // The timing must not be over-promised: the persona has to say the insert is
  // NOT instant, and must keep the abort path as a last resort with its cost.
  assert.ok(main.includes('不是「立刻」'), 'the persona must not imply an instant interrupt')
  assert.ok(main.includes('上下文不丢'), 'the persona must state why the step boundary is preferred')
  assert.ok(main.includes('最后手段'), 'abort stays a last resort, not the default')
  assert.ok(!main.includes('interrupt: true'), 'the old abort-flavoured alias must be gone from the persona')
  assert.ok(main.includes('dispatch_task'), 'the persona names the dispatch tool')
  // The discussion exception must survive: talking to the whale is not work.
  assert.ok(main.includes('不派工的例外'), 'the persona keeps the no-dispatch exceptions')
  assert.ok(main.includes('架构权衡'), 'architecture discussion is an explicit exception')

  // Scoped, not global: the worker preset has its own persona and must not
  // inherit the dispatch discipline.
  const worker = await assemblePresetPrompt('discipline-whale-worker')
  assert.ok(worker.includes('Discipline Whale worker'))
  for (const needle of ['派工优先', '那就该立刻停手派工', '往正在跑的会话插话']) {
    assert.ok(!worker.includes(needle), `the worker persona must not contain ${JSON.stringify(needle)}`)
  }
  console.log('ok 23 — the main persona discipline is in the assembled system prompt, scoped to that preset')
}

// --- 24. the main row actually installs the guard, end to end --------------
//
// The guard's own tests drive `installGuard` directly. This one goes through
// the real mount path — `main.apply(ctx, config)` — so a row that forgets the
// call, or a Config schema that silently drops the knobs, fails here.

{
  const { installGuard } = await import('../guard.js')
  assert.equal(typeof installGuard, 'function')

  const listeners = []
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: () => () => {} },
    workspaceRegistry: { list: () => workspaces },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: (event, handler) => {
      listeners.push({ event, handler })
      return () => {}
    },
  }

  // Row config as the Loader would hand it over after Config validation.
  const validated = mainRow.Config['~standard'].validate({
    workerPreset: 'discipline-whale-worker',
    readQuota: 3,
    watchdogThreshold: 4,
    maxInterventions: 1,
    watchdogCounting: 'read-only',
    // A knob the schema does not know must not reach the guard.
    nonsense: true,
  })
  assert.equal(validated.issues, undefined)
  mainRow.apply(ctx, validated.value)

  const gate = listeners.find((entry) => entry.event === 'tools/pre-execute')
  assert.ok(gate, 'main.apply must install the pre-execute gate through installGuard')
  assert.ok(listeners.some((entry) => entry.event === 'agent/assistant-stream'), 'the reply signal must be wired')
  assert.ok(listeners.some((entry) => entry.event === 'agent/inbox/claimed'), 'the user-turn re-arm must be wired')
  assert.equal(validated.value.nonsense, undefined, 'unknown config never reaches the guard')

  // The configured quota (3, not the default 10) is what actually applies.
  const agent = {
    cancelled: [],
    steered: [],
    session: { id: 'contract-guard', header: { agentPreset: 'discipline-whale', cwd: home } },
    cancel(cause) {
      agent.cancelled.push(cause)
    },
    steer(message) {
      agent.steered.push(message)
    },
  }
  const call = async (name, args, who = agent) => {
    let reached = false
    const decision = await gate.handler(
      { callId: 'c1', name, arguments: args, agent: who, signal: new AbortController().signal },
      async () => {
        reached = true
        return { kind: 'allow' }
      },
    )
    return { decision: decision.kind, reason: decision.reason, reached }
  }
  const inHome = join(home, 'discipline-whale', 'home', 'note.md')
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await call('read', { file_path: inHome })).decision, 'allow', `read ${index + 1} of the configured 3`)
  }
  const fourth = await call('read', { file_path: inHome })
  assert.equal(fourth.decision, 'deny', 'the configured quota of 3 is the one enforced')
  assert.match(fourth.reason, /0 of 3/, 'the refusal quotes the configured limit')

  // A worker Session going through the very same gate is untouched.
  const workerAgent = {
    cancelled: [],
    steered: [],
    session: { id: 'contract-guard-worker', header: { agentPreset: 'discipline-whale-worker', cwd: home } },
    cancel(cause) {
      workerAgent.cancelled.push(cause)
    },
    steer(message) {
      workerAgent.steered.push(message)
    },
  }
  for (let index = 0; index < 20; index += 1) {
    const result = await call('read', { file_path: join(home, 'src', `f${index}.js`) }, workerAgent)
    assert.equal(result.decision, 'allow', 'a worker reads twenty source files through the same gate')
  }
  void workerAgent
  console.log('ok 24 — main.apply installs the guard; configured thresholds apply; a worker Session is untouched')
}

// --- 25. the timings match the Host's own inbox semantics ------------------
//
// This is the test that decides the design question: is a step-boundary insert
// already available, and does `queue` really wait for the whole turn? It reads
// the Host's agent loop source rather than trusting our own comments, so a Host
// upgrade that changes the inbox semantics fails here instead of silently
// turning "Interrupt" back into "wait for the turn".

{
  const { readFile } = await import('node:fs/promises')
  const loop = await readFile(
    join(DSH_MODULES, '@deepseek-ai/dsh-agent-loop/lib/index.js'),
    'utf8',
  )

  // followup -> next-turn, steer -> next-step.
  assert.match(
    loop,
    /followup\(input\)\s*\{\s*this\.send\(input, "next-turn", true\)/,
    'followup must target the next-turn inbox (the `queue` timing)',
  )
  assert.match(
    loop,
    /steer\(input\)\s*\{\s*this\.send\(input, "next-step", true\)/,
    'steer must target the next-step inbox (the step-boundary timing)',
  )

  // claim() drains next-step on EVERY boundary, but next-turn only for the
  // next-turn target: that is what makes steer land inside the current turn.
  assert.match(
    loop,
    /claim\(target, turn\) \{\s*const claimed = this\.mutate\("next-step"/,
    'claim must drain next-step unconditionally',
  )
  assert.match(
    loop,
    /if \(target === "next-turn"\) claimed\.push\(\.\.\.this\.mutate\("next-turn"/,
    'claim must drain next-turn only for the next-turn target',
  )

  // The turn loop opens on next-turn and switches to next-step after a step.
  assert.match(loop, /let target = "next-turn"/, 'a turn opens claiming the next-turn target')
  assert.match(loop, /target = "next-step"/, 'later steps of the same turn claim next-step')

  // And the prompt mode is the only switch: two modes, no `interrupt`.
  const controller = await readFile(
    join(DSH_MODULES, '@deepseek-ai/dsh-api-session-controller/lib/index.js'),
    'utf8',
  )
  assert.match(
    controller,
    /if \(request\.mode === "steer"\) agent\.steer\(message\);\s*else agent\.followup\(message\)/,
    'prompt mode is exactly steer / otherwise-followup',
  )
  const host = await readFile(
    join(DSH_MODULES, '@deepseek-ai/dsh-api-session-controller/lib/typert.host.js'),
    'utf8',
  )
  assert.match(host, /"mode":\{"type":"string","enum":\["queue","steer"\]\}/, 'there is no interrupt mode')

  // Our own surface must name the three timings and map them the same way.
  assert.deepEqual(DELIVERY_TIMINGS, ['queue', 'step', 'abort'])
  assert.equal(resolveTiming(undefined), 'step', 'the default is the step boundary, not queue and not abort')
  assert.equal(resolveTiming('queue'), 'queue')
  assert.throws(() => resolveTiming('interrupt'), /`at` must be one of/)
  console.log('ok 25 — `steer` is a step-boundary insert, `queue` waits for the turn; default is step')
}

// --- 26. the plain `steer` path never cancels anything ---------------------
//
// The user's "Interrupt" is exactly this and nothing more: a message that waits
// for the in-flight tool call to finish and is admitted at the next step
// boundary of the SAME turn. It carries no abort, so no half-written state.
// This block exists so that reading `cancel` anywhere in the step path fails
// the suite, even if a later refactor merges `step` and `abort` by accident.

{
  resetRegistry()
  const { tools, calls } = mount(mainRow)

  // 1. Default (no `at`): the plain step-boundary insert.
  const defaulted = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-s', message: 'Also handle the empty string.' },
    execAs('main-1'),
  )
  assert.equal(defaulted.delivered, 'step')
  assert.equal(defaulted.aborted, false)
  assert.equal(calls.cancel.length, 0, 'the default must never cancel')
  assert.equal(calls.prompt.at(-1).mode, 'steer', 'the plain path is mode:"steer"')
  assert.equal(calls.prompt.at(-1).sessionId, 'worker-s')

  // 2. Explicit `at: "step"` behaves identically.
  const explicit = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-s', message: 'Second requirement.', at: 'step' },
    execAs('main-1'),
  )
  assert.equal(explicit.delivered, 'step')
  assert.equal(calls.cancel.length, 0, '`at:"step"` must never cancel')
  assert.equal(calls.prompt.at(-1).mode, 'steer')

  // 3. The two step-path deliveries both used the step inbox and never the
  //    turn inbox: that is what makes them visible inside the current turn.
  const stepPayloads = calls.prompt.slice(-2)
  assert.equal(stepPayloads.length, 2)
  for (const payload of stepPayloads) assert.equal(payload.mode, 'steer')

  // 4. `queue` is the only branch that targets the turn inbox, and it does not
  //    cancel either — it simply waits.
  const queued = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-s', message: 'No rush, just note this.', at: 'queue' },
    execAs('main-1'),
  )
  assert.equal(queued.delivered, 'queue')
  assert.equal(calls.cancel.length, 0, '`queue` waits, it does not abort')
  assert.equal(calls.prompt.at(-1).mode, 'queue')

  // 5. Only `abort` touches `cancel`, and only then is `aborted` true.
  const aborted = await run(
    tools,
    'send_to_session',
    { session_id: 'worker-s', message: 'Wrong file — stop now.', at: 'abort' },
    execAs('main-1'),
  )
  assert.equal(aborted.delivered, 'abort')
  assert.equal(aborted.aborted, true)
  assert.equal(calls.cancel.length, 1, 'exactly one cancel, from the abort branch only')
  assert.equal(calls.prompt.at(-1).mode, 'steer', 'after aborting, the instruction still steers in')

  // 6. `dispatch_task` reuse defaults to the same plain path: no cancel.
  const mainMount = mount(mainRow, { workerPreset: 'discipline-whale-worker' })
  const first = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Add the toggle.', topic: 'toggle' },
    execAs('main-1'),
  )
  const cancelsBefore = mainMount.calls.cancel.length
  const reused = await run(
    mainMount.tools,
    'dispatch_task',
    { workspace: 'soc-api-test', task: 'Also support long-press.', topic: 'toggle' },
    execAs('main-1'),
  )
  assert.equal(reused.status, 'reused')
  assert.equal(reused.workerSessionId, first.workerSessionId)
  assert.equal(reused.deliveredAs, 'step', 'continuing a live dispatch defaults to the plain step insert')
  assert.equal(mainMount.calls.cancel.length, cancelsBefore, 'reuse must not cancel the running worker')
  assert.equal(mainMount.calls.prompt.at(-1).mode, 'steer')
  assert.equal(mainMount.calls.create.length, 1, 'no second Session')
  console.log('ok 26 — the plain step insert defaults everywhere and never cancels; only `at:"abort"` does')
}

// --- 27. the brevity row is declared in the main preset and only there -----
//
// `test/adhd.mjs` proves the behaviour. This one proves the *declaration*,
// against the real patch file rather than a rendered prompt: the row must be in
// `preset-discipline-whale`'s plugin list and absent from
// `preset-discipline-whale-worker`'s. A row that drifted into the worker preset
// would constrain the detailed reports the main session depends on.

{
  const { readFile } = await import('node:fs/promises')
  const { presetPlugins } = await import('../prompt-probe.mjs')
  const yamlModule = await import(join(DSH_MODULES, 'js-yaml/index.js'))
  const yaml = yamlModule.default ?? yamlModule

  // The Loader's YAML dialect: the worker preset pins shells with `!!js`, so a
  // plain schema load would refuse the real file.
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patches = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([JsExpr]) }) ?? []
  const inserted = patches.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))

  const rowOf = (presetId) => presetPlugins(patches, presetId).find((row) => row?.name === 'discipline-whale/adhd')

  const brevityRow = rowOf('discipline-whale')
  assert.ok(brevityRow, 'the main preset must declare the brevity row')
  assert.equal(brevityRow.id, 'discipline-whale-brevity')
  assert.ok(brevityRow.config, 'the knobs are spelled out so an operator can see and change them')
  assert.equal(brevityRow.config.maxProseChars, 1200)
  assert.equal(brevityRow.config.maxCorrections, 1)
  assert.equal(brevityRow.config.enabled, true)

  assert.equal(rowOf('discipline-whale-worker'), undefined, 'the worker preset must NOT declare the brevity row')

  // Belt and braces: exactly one preset owns the row, so a future copy-paste
  // into the worker preset fails here rather than in production.
  const owners = inserted
    .filter((entry) => Array.isArray(entry?.config?.plugins) && typeof entry.config.id === 'string')
    .map((entry) => entry.config.id)
    .filter((id) => presetPlugins(patches, id).some((row) => row?.name === 'discipline-whale/adhd'))
  assert.deepEqual(owners, ['discipline-whale'], `the brevity row belongs to one preset only, found ${JSON.stringify(owners)}`)

  console.log('ok 27 — the brevity row is declared in the main preset and absent from the worker preset')
}

await rm(home, { recursive: true, force: true })
console.log('\nAll discipline-whale contract checks passed.')
