/**
 * questions — the pending-question queue (plan A: file queue, main asks).
 *
 * RED FIRST: the tool-level groups below are written against modules that do
 * not exist yet on purpose. `worker.ask_main` and `question-tools.js` are the
 * missing behaviour; the pure queue rules in `questions.js` are covered here so
 * the file is the single record for the whole feature.
 *
 * Four scenarios the task requires, each its own group:
 *
 *   1. queue write   — a question round-trips, is bounded, cannot escape the dir
 *   2. queue read    — pending listing is ordered, and maps onto
 *                      `ask_user_question` with the queue id as the question id
 *   3. pairing       — an answer lands on its own question, never a neighbour,
 *                      and an already-delivered answer is not delivered twice
 *   4. expired       — a deadline, a dead worker Session, and an abandoned
 *                      dispatch each retire the question instead of leaving it
 *                      in the main session's way
 *   5. concurrency   — two writers on the SAME id, and many writers on distinct
 *                      ids, leave no corrupt file and no stray temp file
 *
 * Usage: node test/questions.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_QUESTION_TTL_MS,
  MAX_QUESTION_CHARS,
  answerMessage,
  answerQuestion,
  askRequestFor,
  deliverablePairs,
  deleteQuestion,
  expireQuestion,
  isQuestionId,
  listQuestions,
  newQuestion,
  normalizeOptions,
  overdueQuestions,
  pendingQuestions,
  pruneExpired,
  pruneTempFiles,
  questionPath,
  questionsDir,
  readQuestion,
  writeQuestion,
} from '../questions.js'

/** A throwaway store root; each test owns one so nothing leaks between them. */
async function freshHome() {
  return mkdtemp(join(tmpdir(), 'dw-questions-'))
}

/** A question shaped like the worker tool builds it. */
function question(overrides = {}) {
  return newQuestion(
    {
      workerSessionId: 'session-worker-1',
      mainSessionId: 'session-main-1',
      workspaceId: 'ws-1',
      workspaceTitle: 'example',
      question: 'Should the migration drop the legacy column?',
      options: [{ label: 'Drop it' }, { label: 'Keep it', description: 'safer' }],
      ...overrides,
    },
    new Date('2026-10-23T00:00:00.000Z'),
  )
}

// --- 1. queue write -------------------------------------------------------

test('a question round-trips through its own file', async () => {
  const home = await freshHome()
  const value = question()
  assert.ok(isQuestionId(value.id), 'the generated id must be filename-safe')
  const path = await writeQuestion(home, value)
  assert.equal(path, questionPath(home, value.id))
  const back = await readQuestion(home, value.id)
  assert.equal(back.id, value.id)
  assert.equal(back.workerSessionId, 'session-worker-1')
  assert.equal(back.status, 'pending')
  assert.equal(back.question, value.question)
  assert.deepEqual(back.options, value.options)
  // The deadline is a number, not a Date: it has to survive JSON unchanged.
  assert.equal(typeof back.expiresAt, 'number')
  assert.equal(back.expiresAt, Date.parse('2026-10-23T00:00:00.000Z') + DEFAULT_QUESTION_TTL_MS)
})

test('a question id cannot escape the queue directory', async () => {
  const home = await freshHome()
  assert.equal(isQuestionId('../../etc/passwd'), false)
  assert.equal(isQuestionId('q-ok_1'), true)
  // A path-shaped id is refused on read AND on write-through-lookup, so a
  // hand-edited file cannot be used to read an arbitrary path.
  assert.equal(await readQuestion(home, '../../etc/passwd'), undefined)
  assert.equal(await deleteQuestion(home, '../../etc/passwd'), false)
})

test('question text and options are bounded, not rejected', async () => {
  const home = await freshHome()
  const long = 'x'.repeat(MAX_QUESTION_CHARS * 2)
  const value = newQuestion({ workerSessionId: 'w', question: long }, new Date('2026-10-23T00:00:00.000Z'))
  assert.equal(value.question.length, MAX_QUESTION_CHARS, 'text is clipped to the bound, never stored whole')
  await writeQuestion(home, value)
  assert.equal((await readQuestion(home, value.id)).question.length, MAX_QUESTION_CHARS)

  // Bare strings are accepted as options; unusable entries are dropped.
  assert.deepEqual(normalizeOptions(['a', { label: 'b' }, '', null, { label: '' }]), [
    { label: 'a' },
    { label: 'b' },
  ])
  // More than the cap is truncated rather than refused.
  assert.equal(normalizeOptions(Array.from({ length: 20 }, (_, i) => `o${i}`)).length, 8)
})

test('an empty question is refused at construction', async () => {
  assert.throws(() => newQuestion({ workerSessionId: 'w', question: '   ' }), /empty/)
  assert.throws(() => newQuestion({ question: 'x' }), /workerSessionId/)
})

// --- 2. queue read --------------------------------------------------------

test('pending questions are listed oldest first and shaped for ask_user_question', async () => {
  const home = await freshHome()
  const older = newQuestion(
    { workerSessionId: 'session-worker-1', question: 'older?' },
    new Date('2026-10-22T23:00:00.000Z'),
  )
  const newer = newQuestion(
    { workerSessionId: 'session-worker-2', question: 'newer?', header: 'Confirm', options: [{ label: 'yes' }] },
    new Date('2026-10-23T01:00:00.000Z'),
  )
  await writeQuestion(home, newer)
  await writeQuestion(home, older)

  const listed = await listQuestions(home)
  assert.deepEqual(
    listed.map((entry) => entry.id),
    [newer.id, older.id],
    'listing is newest first, which is what a board read wants',
  )

  const pending = pendingQuestions(listed, Date.parse('2026-10-23T02:00:00.000Z'))
  assert.deepEqual(
    pending.map((entry) => entry.id),
    [older.id, newer.id],
    'asking order is oldest first: a blocked worker is not overtaken',
  )

  const request = askRequestFor(pending)
  assert.deepEqual(
    request.questions.map((entry) => entry.id),
    [older.id, newer.id],
  )
  // The worker's own words and options are forwarded verbatim — the main
  // session asks the question it was handed, it does not paraphrase it.
  assert.equal(request.questions[0].question, 'older?')
  assert.equal(request.questions[1].header, 'Confirm')
  assert.deepEqual(request.questions[1].options, [{ label: 'yes' }])
  // An optionless question stays an open question: no empty `options` array.
  assert.equal('options' in request.questions[0], false)
})

test('a half-written or hand-edited file cannot blind the listing', async () => {
  const home = await freshHome()
  const good = question()
  await writeQuestion(home, good)
  await writeFile(join(questionsDir(home), 'broken.json'), '{ not json', 'utf8')
  await writeFile(join(questionsDir(home), 'notes.txt'), 'ignore me', 'utf8')
  const listed = await listQuestions(home)
  assert.deepEqual(listed.map((entry) => entry.id), [good.id])
})

// --- 3. pairing -----------------------------------------------------------

test('an answer lands on its own question when two are pending', async () => {
  const home = await freshHome()
  const first = question({ workerSessionId: 'session-worker-1', question: 'first?' })
  const second = question({ workerSessionId: 'session-worker-2', question: 'second?' })
  await writeQuestion(home, first)
  await writeQuestion(home, second)

  // Answer out of order, by id: pairing is by id, never by position.
  await answerQuestion(home, second.id, { selected: ['Keep it'] })
  await answerQuestion(home, first.id, { custom: 'neither, wait for legal' })

  const a = await readQuestion(home, first.id)
  const b = await readQuestion(home, second.id)
  assert.equal(a.status, 'answered')
  assert.deepEqual(a.answer, { selected: [], custom: 'neither, wait for legal' })
  assert.equal(b.status, 'answered')
  assert.deepEqual(b.answer, { selected: ['Keep it'] })
  // The worker ids did not swap: each answer sits on the question that was asked.
  assert.equal(a.workerSessionId, 'session-worker-1')
  assert.equal(b.workerSessionId, 'session-worker-2')

  const message = answerMessage(b)
  assert.match(message, /second\?/)
  assert.match(message, /A: Keep it/)
})

test('an answer needs content, and a non-pending question is not revived', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  await assert.rejects(() => answerQuestion(home, value.id, { selected: [] }), /at least one/)
  await expireQuestion(home, value.id, new Date('2026-10-23T03:00:00.000Z'))
  const late = await answerQuestion(home, value.id, { selected: ['Drop it'] })
  assert.equal(late.status, 'expired', 'a late answer must not reopen an expired question')
  assert.equal(late.answer, undefined)
})

test('a delivered answer is not deliverable again', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  await answerQuestion(home, value.id, { selected: ['Drop it'] })
  let pairs = deliverablePairs(await listQuestions(home))
  assert.deepEqual(pairs.map((entry) => entry.id), [value.id], 'an answered question is deliverable once')

  const { markDelivered } = await import('../questions.js')
  await markDelivered(home, value.id, new Date('2026-10-23T04:00:00.000Z'))
  pairs = deliverablePairs(await listQuestions(home))
  assert.deepEqual(pairs, [], 'a retried sweep must not steer the same answer twice')
})

// --- 4. expired -----------------------------------------------------------

test('a question past its deadline stops needing the user', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  const afterDeadline = value.expiresAt + 1
  assert.deepEqual(overdueQuestions(await listQuestions(home), afterDeadline).map((q) => q.id), [value.id])
  assert.deepEqual(
    pendingQuestions(await listQuestions(home), afterDeadline),
    [],
    'an overdue question is not something to ask the user any more',
  )
  // Still `pending` on disk: the sweep decides, a clock read does not.
  assert.equal((await readQuestion(home, value.id)).status, 'pending')
})

test('a retired question records why, and expired files are pruned later', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  const gone = await expireQuestion(home, value.id, new Date('2026-10-23T05:00:00.000Z'), 'session-gone')
  assert.equal(gone.status, 'expired')
  assert.equal(gone.expiredReason, 'session-gone')

  // Not pruned while fresh, pruned once past the retention window.
  assert.equal(await pruneExpired(home, DEFAULT_QUESTION_TTL_MS, Date.parse('2026-10-23T06:00:00.000Z')), 0)
  assert.equal(await pruneExpired(home, 60 * 1000, Date.parse('2026-10-23T06:00:00.000Z')), 1)
  assert.equal(await readQuestion(home, value.id), undefined)
})

// --- 5. concurrency -------------------------------------------------------

test('two writers on the same id never leave a corrupt file', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  // The same question rewritten concurrently: whoever renames last wins, and
  // the reader must never observe half a JSON body.
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      writeQuestion(home, { ...value, question: `edit ${index}` }),
    ),
  )
  const back = await readQuestion(home, value.id)
  assert.match(back.question, /^edit \d+$/)
  const entries = await readdir(questionsDir(home))
  assert.deepEqual(entries.filter((entry) => entry.endsWith('.tmp')), [], 'no temp file survives a finished write')
})

test('many distinct questions written at once all land intact', async () => {
  const home = await freshHome()
  const values = Array.from({ length: 30 }, (_, index) =>
    question({ workerSessionId: `session-worker-${index}`, question: `question ${index}?` }),
  )
  await Promise.all(values.map((value) => writeQuestion(home, value)))
  const listed = await listQuestions(home)
  assert.equal(listed.length, 30)
  assert.deepEqual(new Set(listed.map((entry) => entry.id)).size, 30)
  // Each one still belongs to the worker that asked it.
  for (const value of listed) {
    assert.equal(value.question, `question ${value.workerSessionId.split('-').at(-1)}?`)
  }
})

test('a crashed writer\'s temp file is debris, not a question', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  const temp = `${questionPath(home, value.id)}.999.dead.tmp`
  await writeFile(temp, '{"half":', 'utf8')
  // listQuestions ignores it...
  assert.deepEqual((await listQuestions(home)).map((entry) => entry.id), [value.id])
  // ...and the sweep removes it once it is old enough.
  assert.equal(await pruneTempFiles(home, 0, Date.now()), 1)
  assert.deepEqual((await readdir(questionsDir(home))).filter((entry) => entry.endsWith('.tmp')), [])
})

// --- 6. the worker's side: ask_main --------------------------------------

test('the worker row registers ask_main beside report_to_main', async () => {
  const workerRow = await import('../worker.js')
  const tools = new Map()
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: () => () => {},
  }
  workerRow.apply(ctx, {})
  assert.ok(tools.has('report_to_main'), 'the report contract stays')
  assert.ok(tools.has('ask_main'), 'the worker gets a way to ask upward')
  // Still no upward POWERS: asking is not dispatching or reading.
  for (const forbidden of ['dispatch_task', 'list_workspaces', 'read_report', 'send_to_session']) {
    assert.equal(tools.get(forbidden), undefined, `worker must not have ${forbidden}`)
  }
})

test('ask_main parks the question on disk and returns its id', async () => {
  const home = await freshHome()
  const workerRow = await import('../worker.js')
  const tools = new Map()
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: () => () => {},
    get: () => undefined,
  }
  workerRow.apply(ctx, { questionsRoot: home })
  const tool = tools.get('ask_main')
  const value = await tool.execute(
    {
      question: 'Delete the old table?',
      options: [{ label: 'Yes' }, { label: 'No' }],
      header: 'Confirm',
    },
    { agent: { session: { id: 'session-worker-1' } }, signal: new AbortController().signal },
  )
  assert.ok(isQuestionId(value.id), 'the tool returns the queue id the answer will be matched by')
  assert.equal(value.status, 'pending')
  const stored = await readQuestion(home, value.id)
  assert.equal(stored.question, 'Delete the old table?')
  assert.equal(stored.workerSessionId, 'session-worker-1')
  assert.deepEqual(stored.options, [{ label: 'Yes' }, { label: 'No' }])
})

// --- 7. the main session's side: pending_questions -----------------------

test('the main tool asks nothing itself: it hands back the ask_user_question request', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  const { createQuestionTools } = await import('../question-tools.js')
  const queries = []
  const tools = createQuestionTools({
    root: () => home,
    // The tool must NOT call the asking seam: a delegated caller is refused
    // there, and the main session is the one that asks.
    askUser: async (request) => {
      queries.push(request)
      throw new Error('must not be called')
    },
    deliver: async () => ({ accepted: true }),
    liveness: () => ({ live: true }),
  })
  const listed = await tools.pending_questions.execute(
    { action: 'list' },
    { agent: { session: { id: 'session-main-1' } }, signal: new AbortController().signal },
  )
  assert.equal(queries.length, 0, 'listing must not ask the user anything')
  assert.equal(listed.pending.length, 1)
  assert.equal(listed.pending[0].id, value.id)
  assert.equal(listed.pending[0].question, value.question)
  // Directly feedable to ask_user_question.
  assert.deepEqual(listed.ask.questions.map((entry) => entry.id), [value.id])
})

test('answering delivers once, to the right session, and never twice', async () => {
  const home = await freshHome()
  const first = question({ workerSessionId: 'session-worker-1', question: 'first?' })
  const second = question({ workerSessionId: 'session-worker-2', question: 'second?' })
  await writeQuestion(home, first)
  await writeQuestion(home, second)
  const { createQuestionTools } = await import('../question-tools.js')
  const deliveries = []
  const tools = createQuestionTools({
    root: () => home,
    askUser: async () => {
      throw new Error('must not be called')
    },
    deliver: async (sessionId, text) => {
      deliveries.push({ sessionId, text })
      return { accepted: true }
    },
    liveness: () => ({ live: true }),
  })
  const result = await tools.pending_questions.execute(
    { action: 'answer', answers: [{ id: second.id, selected: ['Keep it'] }] },
    { agent: { session: { id: 'session-main-1' } }, signal: new AbortController().signal },
  )
  assert.equal(result.answered.length, 1)
  assert.deepEqual(result.answered[0].id, second.id)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].sessionId, 'session-worker-2', 'the answer goes to the worker that asked')
  assert.match(deliveries[0].text, /Keep it/)

  // A second sweep with nothing to do delivers nothing.
  const again = await tools.pending_questions.execute(
    { action: 'answer', answers: [{ id: second.id, selected: ['Keep it'] }] },
    { agent: { session: { id: 'session-main-1' } }, signal: new AbortController().signal },
  )
  assert.deepEqual(again.answered, [])
  assert.equal(deliveries.length, 1)
})

test('an unknown answer id is reported, not silently matched to a neighbour', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  const { createQuestionTools } = await import('../question-tools.js')
  const deliveries = []
  const tools = createQuestionTools({
    root: () => home,
    askUser: async () => ({ answers: [] }),
    deliver: async (sessionId, text) => { deliveries.push({ sessionId, text }); return { accepted: true } },
    liveness: () => ({ live: true }),
  })
  const result = await tools.pending_questions.execute(
    { action: 'answer', answers: [{ id: 'q-does-not-exist', selected: ['x'] }] },
    { agent: { session: { id: 'session-main-1' } }, signal: new AbortController().signal },
  )
  assert.deepEqual(result.answered, [])
  assert.equal(result.unknown.length, 1)
  assert.equal(result.unknown[0], 'q-does-not-exist')
  assert.equal(deliveries.length, 0)
  // The real question is still pending: an unmatched answer changes nothing.
  assert.equal((await readQuestion(home, value.id)).status, 'pending')
})

test('a question whose worker is gone is expired, not asked', async () => {
  const home = await freshHome()
  const dead = question({ workerSessionId: 'session-worker-dead', question: 'still there?' })
  const live = question({ workerSessionId: 'session-worker-live', question: 'and this one?' })
  await writeQuestion(home, dead)
  await writeQuestion(home, live)
  const { createQuestionTools } = await import('../question-tools.js')
  const tools = createQuestionTools({
    root: () => home,
    askUser: async () => ({ answers: [] }),
    deliver: async () => ({ accepted: true }),
    liveness: (sessionId) =>
      sessionId === 'session-worker-dead'
        ? { live: false, abandoned: true }
        : { live: true },
  })
  const listed = await tools.pending_questions.execute(
    { action: 'list' },
    { agent: { session: { id: 'session-main-1' } }, signal: new AbortController().signal },
  )
  assert.deepEqual(listed.pending.map((entry) => entry.id), [live.id])
  assert.deepEqual(listed.expired.map((entry) => entry.id), [dead.id])
  const stored = await readQuestion(home, dead.id)
  assert.equal(stored.status, 'expired')
  // An abandoned dispatch is reported as `abandoned`, not folded into
  // `session-gone`: the two need different words in front of the user, because
  // "abandoned" is a decision someone made and "session-gone" is an accident.
  assert.equal(stored.expiredReason, 'abandoned')
})

test('a delivery failure leaves the answer deliverable for the next sweep', async () => {
  const home = await freshHome()
  const value = question()
  await writeQuestion(home, value)
  const { createQuestionTools } = await import('../question-tools.js')
  let fail = true
  const deliveries = []
  const tools = createQuestionTools({
    root: () => home,
    askUser: async () => ({ answers: [] }),
    deliver: async (sessionId, text) => {
      deliveries.push(sessionId)
      if (fail) throw new Error('session/not-found')
      return { accepted: true }
    },
    liveness: () => ({ live: true }),
  })
  const args = { action: 'answer', answers: [{ id: value.id, selected: ['Drop it'] }] }
  const exec = { agent: { session: { id: 'session-main-1' } }, signal: new AbortController().signal }

  const first = await tools.pending_questions.execute(args, exec)
  assert.equal(first.answered.length, 0)
  assert.equal(first.failed.length, 1, 'the failure is reported instead of swallowed')
  // The answer is on disk but NOT marked delivered, so the next sweep retries.
  assert.equal((await readQuestion(home, value.id)).status, 'answered')
  assert.deepEqual(deliverablePairs(await listQuestions(home)).map((entry) => entry.id), [value.id])

  fail = false
  const second = await tools.pending_questions.execute({ action: 'deliver' }, exec)
  assert.deepEqual(second.delivered.map((entry) => entry.id), [value.id])
  assert.equal(deliveries.length, 2)
  assert.deepEqual(deliverablePairs(await listQuestions(home)), [])
})

// --- 8. scope isolation, proved against a real registry ------------------

/**
 * The tool MUST land in the main agent's own scope. Registered from the
 * profile row instead (which is where `home.js` lives), it would land in the
 * GLOBAL layer and hand `pending_questions` to every coding session in the
 * process. Only a real `ToolRuntime` proves which layer received it, so this
 * group builds one.
 */
test('pending_questions is visible to the main agent and to nobody else', async () => {
  const { join } = await import('node:path')
  const INSTALL = process.env.DSH_INSTALL
    ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'
  const moduleUrl = (specifier) => new URL(`file://${join(INSTALL, specifier)}`).href
  const { Context } = await import(moduleUrl('@deepseek-ai/cordis/lib/index.js'))
  const { createScope, scopeOf } = await import(moduleUrl('@deepseek-ai/dsh-scope/lib/index.js'))
  const { SystemPrompt } = await import(moduleUrl('@deepseek-ai/dsh-system-prompt/lib/index.js'))
  const toolsModule = await import(moduleUrl('@deepseek-ai/dsh-tools/lib/index.js'))
  const ToolRuntime = toolsModule.default ?? toolsModule.ToolRuntime
  const { defineTool } = toolsModule

  const fixture = (name) => defineTool({
    name,
    description: `fixture ${name}`,
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() { return null },
  })

  const { installQuestionTool } = await import('../question-host.js')

  const app = new Context()
  new SystemPrompt(app, {})
  const tools = new ToolRuntime(app, {})
  tools.register(fixture('ask_user_question'))
  tools.register(fixture('read'))

  // The profile-level row: exactly what home.js is. Its own context is unscoped.
  let created
  const profileCtx = {
    logger: { warn() {} },
    get: () => undefined,
    sessionController: {
      prompt: async (_request, signal) => { signal.throwIfAborted(); return { accepted: true } },
    },
    on: (event, handler) => {
      if (event === 'agent/created') created = handler
      return () => {}
    },
  }
  const installed = installQuestionTool(profileCtx, { homeDir: tmpdir() })
  assert.equal(installed, true, 'a composition with a session controller installs the tool')

  // The main agent's own scope, handed over the way `agent/created` does.
  const mainAgentScope = createScope(app, {})
  const mainAgent = {
    id: 'session-main-1',
    session: { id: 'session-main-1', header: { agentPreset: 'discipline-whale' } },
    ctx: mainAgentScope.ctx,
  }
  created({ agent: mainAgent })
  // The registration is effect-scoped; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 20))

  // A worker-shaped preset scope and a plain coding session.
  const workerScope = createScope(app, {})
  const siblingScope = createScope(app, {})

  const namesIn = (ctx) => new Set(tools.view(scopeOf(ctx)).visible.keys())
  assert.ok(namesIn(mainAgentScope.ctx).has('pending_questions'), 'the main agent gets the tool')
  assert.ok(!namesIn(workerScope.ctx).has('pending_questions'), 'a worker must not get it')
  assert.ok(!namesIn(siblingScope.ctx).has('pending_questions'), 'a plain coding session must not get it')
  assert.ok(!tools.view(undefined).visible.has('pending_questions'), 'it must not reach the global layer')

  // A second agent/created for the SAME agent must not double-register: the
  // real registry throws on a duplicate name in one layer, so this would fail.
  created({ agent: mainAgent })
  await new Promise((resolve) => setTimeout(resolve, 10))

  // And a non-main preset is ignored outright.
  const otherScope = createScope(app, {})
  created({
    agent: {
      id: 'session-other',
      session: { id: 'session-other', header: { agentPreset: 'standard' } },
      ctx: otherScope.ctx,
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(!namesIn(otherScope.ctx).has('pending_questions'), 'only the main preset is wired')
})

// --- 9. the token cost is a MEASURED number, not a claim ----------------

/**
 * Plan A's whole cost is "the main session must read the question". This group
 * prices that with the harness's OWN estimator
 * (`@deepseek-ai/dsh-token-meter/estimate`, CHARS_PER_TOKEN = 4) — the same
 * function the GUI's context breakdown uses — so a later edit that makes the
 * payload fat fails here instead of quietly costing the main session.
 */
test('the round trip costs what the report says it costs', async () => {
  const { join } = await import('node:path')
  const INSTALL = process.env.DSH_INSTALL
    ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'
  const est = await import(
    new URL(`file://${join(INSTALL, '@deepseek-ai/dsh-token-meter/lib/types/estimate.js')}`).href
  )
  const { createQuestionTools } = await import('../question-tools.js')
  const tool = createQuestionTools({
    root: () => tmpdir(),
    askUser: async () => ({}),
    deliver: async () => ({ accepted: true }),
  }).pending_questions

  // The tool schema is the RESIDENT cost: it is in every request the main
  // session makes, whether or not a question is pending. Priced on the
  // MODEL-FACING projection only (`dsh-tools` `schemaOf` sends name,
  // description and parameters; `output.schema` never reaches the model), which
  // is why this does not price the whole definition.
  const modelFacing = { name: tool.name, description: tool.description, parameters: tool.parameters }
  const schema = est.estimateToolsTokens({ tools: [modelFacing] })
  assert.ok(schema > 0 && schema < 600, `tool schema must stay under 600 tokens, measured ${schema}`)

  // One round trip: the list result, the ask_user_question arguments, the
  // answer steered back.
  const value = newQuestion(
    {
      workerSessionId: 'session-worker-1',
      workspaceTitle: 'discipline-whale',
      header: 'Confirm',
      question: 'Delete the legacy tasks table before the migration runs?',
      options: [
        { label: 'Yes, delete it (Recommended)', description: 'the migration recreates it' },
        { label: 'No, keep it' },
      ],
    },
    new Date('2026-10-23T00:00:00.000Z'),
  )
  const listBody = JSON.stringify({
    pending: [{
      id: value.id,
      workerSessionId: value.workerSessionId,
      workspaceTitle: value.workspaceTitle,
      header: value.header,
      question: value.question,
      askedAt: value.askedAt,
      expiresAt: value.expiresAt,
      options: value.options,
    }],
    ask: askRequestFor([value]),
    expired: [], answered: [], delivered: [], failed: [], unknown: [],
    note: '1 pending question(s)',
  }, null, 2)
  const listTokens = est.estimateMessage({ role: 'assistant', content: [{ type: 'text', text: listBody }] })
  const askTokens = est.estimateMessage({
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify({ questions: askRequestFor([value]).questions }) }],
  })
  const answerTokens = est.estimateMessage({
    role: 'user',
    content: [{ type: 'text', text: answerMessage({ ...value, answer: { selected: ['No, keep it'] } }) }],
  })
  const total = listTokens + askTokens + answerTokens
  assert.ok(total < 700, `one question round trip must stay under 700 tokens, measured ${total}`)
  // The compressed form (a compact summary instead of the full pretty payload)
  // is what the report quotes as the floor.
  const compactTokens = est.estimateMessage({
    role: 'assistant',
    content: [{ type: 'text', text: JSON.stringify({ pending: [{ id: value.id, q: value.question }], ask: askRequestFor([value]) }) }],
  })
  assert.ok(compactTokens < listTokens, 'the compact summary must be cheaper than the full listing')
  console.log(`  measured: schema ${schema}, round trip ${total} (list ${listTokens} + ask ${askTokens} + answer ${answerTokens}), compact list ${compactTokens}`)
})
