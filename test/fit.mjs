/**
 * A full worker is not reused.
 *
 * Topic reuse and `send_to_session` both put new work into an existing Session.
 * Once that Session's latest request carried `workerReuseMaxTokens` input tokens
 * or more, the thread moves to a new Session instead; when the Host cannot say
 * how big the Session is, it is treated as fitting and the result says so.
 *
 * Run: node test/fit.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateJsonSchemaValue } from '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

import * as mainRow from '../main.js'
import { setStoreRoot } from '../store.js'

const home = await mkdtemp(join(tmpdir(), 'dw-fit-'))
setStoreRoot(home)

const WS = { id: 'ws-fit', title: 'fit-workspace', path: '/workspace/fit', sessionIds: [] }
const MAIN = 'session-main-fit'

let passed = 0
const ok = (message) => console.log(`ok ${++passed} — ${message}`)

/**
 * Mount the main row with a fake Host.
 *
 * The returned `usage` maps a session id to the `inputTokens` of its last
 * assistant message; `inspect: 'missing'` leaves the method off the controller, `'throws'` makes it
 * reject.
 */
let mounts = 0
function mount({ inspect = 'works', config = {} } = {}) {
  const usage = {}
  const mountNo = ++mounts
  const tools = new Map()
  const prompts = []
  let seq = 0
  const sessionController = {
    create: async () => ({ sessionId: `fit-worker-${mountNo}-${++seq}` }),
    rename: async (request) => ({ title: request.title }),
    prompt: async (request, signal) => {
      signal.throwIfAborted()
      prompts.push(request)
      return { accepted: true }
    },
  }
  if (inspect === 'works') {
    sessionController.inspect = async (sessionId) => ({
      meta: {},
      events: [
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'brief' }] } } },
        { type: 'assistant/message', data: { usage: { inputTokens: 1000 } } },
        ...(usage[sessionId] === undefined
          ? []
          : [
              { type: 'assistant/message', data: { usage: { inputTokens: usage[sessionId] } } },
              { type: 'turn/end', data: {} },
            ]),
      ],
    })
  } else if (inspect === 'throws') {
    sessionController.inspect = async () => {
      throw new Error('log unreadable')
    }
  }
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    workspaceRegistry: { list: () => [WS] },
    sessionController,
    on: () => () => {},
  }
  mainRow.apply(ctx, config)
  return { tools, prompts, usage }
}

const run = (tools, name, args) =>
  tools.get(name).execute(args, { signal: new AbortController().signal, agent: { session: { id: MAIN } } })

const briefOf = (request) => request.content[0].text

/* ------------------------------------------------------------------ *
 * 1. a full worker is not reused
 * ------------------------------------------------------------------ */
{
  const { tools, prompts, usage } = mount()
  const first = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'part one', topic: 'Voice Input' })
  usage[first.workerSessionId] = 170000
  assert.equal(first.reused, false)
  assert.equal(first.continues, undefined)

  const second = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'part two', topic: 'voice  input' })
  assert.equal(second.reused, false, 'a worker at 170,000 input tokens is not reused')
  assert.equal(second.continues, first.dispatchId)
  assert.notEqual(second.workerSessionId, first.workerSessionId)
  assert.equal(second.status, 'dispatched')
  assert.deepEqual(validateJsonSchemaValue(tools.get('dispatch_task').output.schema, second, 'value'), [])

  const lines = briefOf(prompts.at(-1)).split('\n')
  assert.equal(lines[0], `接续 ${first.dispatchId}（topic: voice input）：上一会话上下文 170000 token，已另开`)
  assert.match(briefOf(prompts.at(-1)), /part two/)
  assert.doesNotMatch(briefOf(prompts.at(-2)), /接续/, 'the first brief has no continuation line')

  // The thread now lives in the new Session: the next dispatch finds it, and
  // it is small, so it is reused.
  const third = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'part three', topic: 'voice input' })
  assert.equal(third.reused, true)
  assert.equal(third.workerSessionId, second.workerSessionId, 'the newest Session of the topic is the one reused')
  ok('topic reuse opens a new Session for a full worker, with a 接续 first line and `continues`')
}

/* ------------------------------------------------------------------ *
 * 2. below the limit and at the limit
 * ------------------------------------------------------------------ */
{
  const { tools, usage } = mount()
  const small = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'a', topic: 'edge-below' })
  usage[small.workerSessionId] = 159999
  const reusedBelow = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'b', topic: 'edge-below' })
  assert.equal(reusedBelow.reused, true)
  assert.equal(reusedBelow.workerSessionId, small.workerSessionId)
  assert.deepEqual(reusedBelow.warnings, [])

  const limited = mount({ config: { workerReuseMaxTokens: 5000 } })
  const edge = await run(limited.tools, 'dispatch_task', { workspace: WS.title, task: 'a', topic: 'edge-at' })
  limited.usage[edge.workerSessionId] = 5000
  const atLimit = await run(limited.tools, 'dispatch_task', { workspace: WS.title, task: 'b', topic: 'edge-at' })
  assert.equal(atLimit.reused, false, 'the limit itself counts as full')
  assert.ok(atLimit.continues)
  ok('159,999 is reused; a configured limit of 5,000 treats 5,000 as full')
}

/* ------------------------------------------------------------------ *
 * 3. send_to_session refuses a full worker
 * ------------------------------------------------------------------ */
{
  const { tools, prompts, usage } = mount()
  const full = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'big job', topic: 'Parser Rewrite' })
  const small = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'small job', topic: 'tiny' })
  usage[full.workerSessionId] = 165432
  usage[small.workerSessionId] = 800
  const promptsBefore = prompts.length

  await assert.rejects(
    () => run(tools, 'send_to_session', { session_id: full.workerSessionId, message: 'one more thing' }),
    (error) => {
      assert.match(error.message, new RegExp(`worker ${full.workerSessionId} 的上下文已有 165432 token`))
      assert.match(error.message, /≥160,000/)
      assert.match(error.message, /dispatch_task\(workspace: "fit-workspace", topic: "parser rewrite"\)/)
      assert.match(error.message, /新会话会带上工作区背景和最近 3 份报告/)
      return true
    },
  )
  assert.equal(prompts.length, promptsBefore, 'nothing is delivered to a full worker')

  const delivered = await run(tools, 'send_to_session', { session_id: small.workerSessionId, message: 'go on' })
  assert.equal(delivered.accepted, true)
  const stranger = await run(tools, 'send_to_session', { session_id: 'not-ours', message: 'hello' })
  assert.equal(stranger.accepted, true, 'a Session this plugin did not dispatch is not sized')
  ok('send_to_session throws for a full worker (tokens, limit, dispatch_task, workspace, topic) and delivers otherwise')
}

/* ------------------------------------------------------------------ *
 * 4. inspect unavailable or failing: treated as fitting, with a warning
 * ------------------------------------------------------------------ */
for (const inspect of ['missing', 'throws']) {
  const { tools } = mount({ inspect })
  const first = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'a', topic: `blind-${inspect}` })
  const again = await run(tools, 'dispatch_task', { workspace: WS.title, task: 'b', topic: `blind-${inspect}` })
  assert.equal(again.reused, true)
  assert.equal(again.workerSessionId, first.workerSessionId)
  assert.equal(again.continues, undefined)
  assert.equal(again.warnings.length, 1)
  assert.match(again.warnings[0], /context size/)
  assert.match(again.warnings[0], /without a fit check/)
  assert.deepEqual(validateJsonSchemaValue(tools.get('dispatch_task').output.schema, again, 'value'), [])

  const sent = await run(tools, 'send_to_session', { session_id: first.workerSessionId, message: 'go on' })
  assert.equal(sent.accepted, true)
}
ok('inspect missing or throwing: the worker is reused with a warning and send_to_session still delivers')

/* ------------------------------------------------------------------ *
 * 5. Config
 * ------------------------------------------------------------------ */
{
  const validate = (value) => mainRow.Config['~standard'].validate(value)
  assert.equal(validate({ workerReuseMaxTokens: 1000 }).value.workerReuseMaxTokens, 1000)
  assert.deepEqual(mainRow.ROUTING_CONFIG_KEYS, ['workerReuseMaxTokens'])
  assert.equal(validate({}).value.workerReuseMaxTokens, undefined, 'omitted stays omitted; the default lives in apply')
  for (const bad of [0, -5, 1.5, '1000', null, Number.NaN]) {
    const result = validate({ workerReuseMaxTokens: bad })
    assert.deepEqual(result.issues?.[0]?.path, ['workerReuseMaxTokens'], `rejects ${String(bad)}`)
    assert.match(result.issues[0].message, /positive integer/)
  }
  ok('Config.validate forwards workerReuseMaxTokens and rejects values that are not positive integers')
}

console.log(`\n${passed} tests passed`)
await rm(home, { recursive: true, force: true })
