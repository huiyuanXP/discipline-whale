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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

import * as mainRow from '../main.js'
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

/** Mount one row against a fresh fake Host and capture what it registers. */
function mount(row, config = {}) {
  const tools = new Map()
  const calls = { create: [], rename: [], prompt: [] }
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
        return { sessionId: `worker-${calls.create.length}` }
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
  await writeFile(join(home, 'discipline-whale', 'ws-soc', 'r-broken.json'), '{not json', 'utf8')
  assert.equal((await listReports(home, 'ws-soc')).length, 1, 'corrupt file skipped, good one kept')

  assert.equal(await deleteReport(home, 'ws-soc', 'r-test-1'), true)
  assert.equal(await deleteReport(home, 'ws-soc', 'r-test-1'), false)
  console.log('ok 1 — store: round-trip, bounding, traversal-safe listing')
}

// --- 2. main row surface --------------------------------------------------

{
  const { tools } = mount(mainRow)
  const expected = ['list_workspaces', 'dispatch_task', 'read_report', 'send_to_session']
  assert.deepEqual([...tools.keys()].sort(), [...expected].sort())
  for (const name of expected) {
    const tool = tools.get(name)
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
    assert.equal(typeof tool.output.render, 'function')
  }
  console.log('ok 2 — main row registers four tools with supported schemas')
}

// --- 3. worker row surface: no upward powers ------------------------------

{
  const { tools } = mount(workerRow)
  assert.deepEqual([...tools.keys()], ['report_to_main'], 'the worker gets exactly one tool')
  for (const forbidden of ['dispatch_task', 'list_workspaces', 'read_report', 'send_to_session']) {
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
  assert.equal(calls.prompt.at(-1).sessionId, 'worker-9')
  assert.equal(calls.prompt.at(-1).mode, 'queue', 'a new decision must wake the worker')
  assert.match(calls.prompt.at(-1).content[0].text, /use Postgres/)
  await assert.rejects(
    () => run(tools, 'send_to_session', { session_id: 'w', message: '  ' }, execAs('m')),
    /`message` is empty/,
  )
  console.log('ok 9 — send_to_session delivers a new decision to an existing session')
}

await rm(home, { recursive: true, force: true })
console.log('\nAll discipline-whale contract checks passed.')
