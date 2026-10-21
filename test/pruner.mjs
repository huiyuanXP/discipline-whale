/**
 * Tests for the clearing tool-result pruner.
 *
 * A fake session implements exactly what `pruneSession` uses (`surface.nodes`,
 * `seq`, `eventAt`, `deriveEventMessage`, `append`) and applies `surfaceOp` replaces
 * with the Host's tool/result rule: only `message.content` may change.
 *
 *   1. no tool results: zero changes
 *   2. old results cleared, recent results trimmed or kept, Host append shape
 *   3. a second pass makes zero replacements
 *   4. a trimmed result that ages out is cleared at its original size
 *   5. keepRecentTurns boundary, including a window larger than the session
 *   6. tool name falls back to `tool`
 *   7. config validation and the Standard Schema
 *   8. mounted through real cordis, the service lives only in the isolated scope
 *   9. turns are DSH turns: a 10-step turn stays whole, the open turn always counts
 *
 * Run: node test/pruner.mjs
 */

import assert from 'node:assert/strict'

import { Context } from '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/cordis/lib/index.js'

import * as row from '../pruner.js'
import {
  ClearingToolResultPruner,
  Config,
  PRUNE_MARKER,
  SERVICE_NAME,
  clearedPlaceholder,
  codePointLength,
  resolveConfig,
} from '../pruner.js'

/** In-memory session with a log and an ordered surface. */
class FakeSession {
  constructor() {
    this.log = []
    this.nodes = []
  }

  get surface() {
    return { nodes: this.nodes }
  }

  get seq() {
    return this.log.length
  }

  eventAt(seq) {
    return this.log[seq]
  }

  deriveEventMessage(event) {
    return event.type === 'user/message' ? event.data : event.data.message
  }

  append(type, data, opts) {
    const event = { type, seq: this.log.length, time: 0, data, ...(opts ?? {}) }
    const op = opts?.surfaceOp
    if (op === 'append') {
      this.nodes.push(event.seq)
    } else if (op !== undefined) {
      assert.equal(op.startSeq, op.endSeq, 'a tool/result replace covers one node')
      const at = this.nodes.indexOf(op.startSeq)
      assert.notEqual(at, -1, 'replace target must be a current surface node')
      const original = this.log[op.startSeq]
      assert.equal(original.type, 'tool/result')
      assert.deepEqual(opts.sourceEventSeqs, [op.startSeq])
      const strip = (d) => ({ ...d, message: { ...d.message, content: null } })
      assert.deepEqual(strip(data), strip(original.data), 'replacement may change only content')
      this.nodes[at] = event.seq
    }
    this.log.push(event)
    return event
  }
}

const meter = {
  calls: [],
  estimateMessage(message) {
    this.calls.push(message)
    return 1000 + message.content.length
  },
}

let turnCounter = 0

/** Append `turn/start` for a new DSH turn and return its number. */
function startTurn(session) {
  turnCounter += 1
  session.append('turn/start', { turn: turnCounter })
  return turnCounter
}

/** Append `turn/end` closing `turn`. */
function endTurn(session, turn) {
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * One assistant step that calls `tools`, followed by their results.
 *
 * Without `at` the step is a whole DSH turn of its own (opened and closed);
 * with `at = { turn, step }` it is one step inside a turn the caller opened.
 */
function step(session, tools, at) {
  const turn = at?.turn ?? startTurn(session)
  const stepNo = at?.step ?? 0
  const id = (i) => `call-${turn}-${stepNo}-${i}`
  const calls = tools.map(([name], i) => ({ type: 'tool-call', id: id(i), name, arguments: '{}' }))
  session.append(
    'assistant/message',
    {
      turn,
      step: stepNo,
      message: { id: `a-${turn}-${stepNo}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: calls },
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  const results = tools.map(([, content], i) =>
    session.append(
      'tool/result',
      {
        turn,
        step: stepNo,
        message: {
          id: `t-${turn}-${stepNo}-${i}`,
          role: 'tool',
          source: { kind: 'tool', callId: id(i) },
          toolCallId: id(i),
          isError: false,
          content,
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [] },
    ),
  )
  if (at === undefined) endTurn(session, turn)
  return results
}

const text = (t) => ({ type: 'text', text: t })
const image = { type: 'image', attachment: { id: 'img-1' } }

function newSession() {
  const session = new FakeSession()
  session.append('user/message', { id: 'u-1', role: 'user', source: { kind: 'user' }, content: [text('hi')] }, { surfaceOp: 'append' })
  return session
}

/* ------------------------------------------------------------------ 1 */
{
  const session = newSession()
  session.append(
    'assistant/message',
    { turn: 1, step: 0, message: { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [text('hello')] }, stream: [] },
    { surfaceOp: 'append' },
  )
  const before = session.log.length
  const result = new ClearingToolResultPruner({ tokenMeter: meter }).pruneSession(session)
  assert.deepEqual(result, { pruned: [], charsRemoved: 0 })
  assert.equal(session.log.length, before)
  console.log('ok 1 no tool results: zero changes')
}

/* ------------------------------------------------------------------ 2, 3, 4 */
{
  const session = newSession()
  const big = '😀'.repeat(9929)
  const [old1] = step(session, [['read_report', [text(big)]]])
  const [tiny] = step(session, [['bash', [text('ok')]]])
  const [withImage] = step(session, [['view_image', [text('x'.repeat(100)), image]]])
  const [recentBig] = step(session, [['bash', [text('a'.repeat(20000))]]])
  const [recentSmall] = step(session, [['bash', [text('b'.repeat(500))]]])
  const [recentOver, recentPair] = step(session, [
    ['grep', [text('c'.repeat(9000))]],
    ['grep', [text('d'.repeat(10))]],
  ])

  meter.calls.length = 0
  const logBefore = session.log.length
  const pruner = new ClearingToolResultPruner({ tokenMeter: meter })
  const result = pruner.pruneSession(session)

  const bySeq = new Map(result.pruned.map((item) => [item.originalSeq, item]))
  assert.deepEqual([...bySeq.keys()], [old1.seq, withImage.seq, recentBig.seq, recentOver.seq])

  const trimmedChars = 4096 + codePointLength(PRUNE_MARKER) + 1024
  assert.deepEqual(bySeq.get(old1.seq), {
    originalSeq: old1.seq,
    replacementSeq: bySeq.get(old1.seq).replacementSeq,
    callId: 'call-1-0-0',
    charsBefore: 9929,
    charsAfter: codePointLength(clearedPlaceholder('read_report', 9929)),
    mode: 'cleared',
  })
  assert.equal(bySeq.get(withImage.seq).mode, 'cleared')
  assert.equal(bySeq.get(recentBig.seq).mode, 'trimmed')
  assert.equal(bySeq.get(recentBig.seq).charsAfter, trimmedChars)
  assert.equal(bySeq.get(recentOver.seq).mode, 'trimmed')
  for (const item of result.pruned) {
    assert.deepEqual(Object.keys(item), ['originalSeq', 'replacementSeq', 'callId', 'charsBefore', 'charsAfter', 'mode'])
  }
  assert.equal(
    result.charsRemoved,
    result.pruned.reduce((sum, item) => sum + item.charsBefore - item.charsAfter, 0),
  )

  // Old result: exactly one placeholder line, code points counted, id and turn kept.
  const cleared = session.log[bySeq.get(old1.seq).replacementSeq]
  assert.deepEqual(cleared.data.message.content, [text('[工具输出已清理 · read_report · 9,929 字符 · 原文在 session log]')])
  assert.equal(cleared.data.message.id, 't-1-0-0')
  assert.equal(cleared.data.turn, 1)
  assert.ok(Object.isFrozen(cleared.data.message.content[0]))

  // Old result with an image: the image block is dropped.
  const clearedImage = session.log[bySeq.get(withImage.seq).replacementSeq]
  assert.deepEqual(clearedImage.data.message.content, [text(clearedPlaceholder('view_image', 100))])

  // Old tiny result: the placeholder would be larger, so it stays.
  assert.ok(session.nodes.includes(tiny.seq))

  // Recent results: over-threshold trimmed Host-style, small ones untouched.
  const trimmed = session.log[bySeq.get(recentBig.seq).replacementSeq].data.message.content
  assert.equal(trimmed[0].text, 'a'.repeat(4096) + PRUNE_MARKER + 'a'.repeat(1024))
  assert.ok(session.nodes.includes(recentSmall.seq))
  assert.ok(session.nodes.includes(recentPair.seq))

  // Host append semantics: shadow-price event right before each replacement.
  assert.equal(session.log.length, logBefore + 2 * result.pruned.length)
  for (const item of result.pruned) {
    const shadow = session.log[item.replacementSeq - 1]
    assert.equal(shadow.type, 'compaction/prune')
    assert.deepEqual(shadow.data, {
      shadowedRange: { start: item.originalSeq, end: item.originalSeq },
      shadowedSeqs: [item.originalSeq],
      shadowedTokenCount: 1000 + session.log[item.originalSeq].data.message.content.length,
    })
    const replacement = session.log[item.replacementSeq]
    assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: item.originalSeq, endSeq: item.originalSeq })
    assert.deepEqual(replacement.sourceEventSeqs, [item.originalSeq])
  }
  assert.equal(meter.calls.length, result.pruned.length)
  console.log('ok 2 old results cleared, recent results trimmed or kept, Host append shape')

  // 3. Idempotent.
  const logAfter = session.log.length
  assert.deepEqual(pruner.pruneSession(session), { pruned: [], charsRemoved: 0 })
  assert.equal(session.log.length, logAfter)
  console.log('ok 3 a second pass makes zero replacements')

  // 4. Three more steps push the trimmed result out of the window.
  step(session, [['bash', [text('e')]]])
  step(session, [['bash', [text('f')]]])
  step(session, [['bash', [text('g')]]])
  const aged = pruner.pruneSession(session)
  const trimmedSeq = bySeq.get(recentBig.seq).replacementSeq
  const agedItem = aged.pruned.find((item) => item.originalSeq === trimmedSeq)
  assert.equal(agedItem.mode, 'cleared')
  assert.equal(agedItem.charsBefore, trimmedChars)
  assert.deepEqual(
    session.log[agedItem.replacementSeq].data.message.content,
    [text('[工具输出已清理 · bash · 20,000 字符 · 原文在 session log]')],
  )
  assert.deepEqual(pruner.pruneSession(session).pruned, [])
  console.log('ok 4 a trimmed result that ages out is cleared at its original size')
}

/* ------------------------------------------------------------------ 5 */
{
  /** Four steps of 200-char results; returns the result seqs in order. */
  function build() {
    const session = newSession()
    const seqs = []
    for (let i = 0; i < 4; i += 1) seqs.push(step(session, [['bash', [text(String(i).repeat(200))]]])[0].seq)
    return { session, seqs }
  }
  const clearedSeqs = (keepRecentTurns) => {
    const { session, seqs } = build()
    const { pruned } = new ClearingToolResultPruner({ tokenMeter: meter }, { keepRecentTurns }).pruneSession(session)
    assert.ok(pruned.every((item) => item.mode === 'cleared'))
    return pruned.map((item) => seqs.indexOf(item.originalSeq))
  }
  assert.deepEqual(clearedSeqs(3), [0])
  assert.deepEqual(clearedSeqs(2), [0, 1])
  assert.deepEqual(clearedSeqs(1), [0, 1, 2])
  assert.deepEqual(clearedSeqs(4), [])
  assert.deepEqual(clearedSeqs(10), [])
  console.log('ok 5 keepRecentTurns boundary')
}

/* ------------------------------------------------------------------ 6 */
{
  const session = newSession()
  step(session, [['bash', [text('z'.repeat(300))]]])
  // Drop the assistant node from the surface, as if its call were summarized away.
  session.nodes.splice(1, 1)
  for (let i = 0; i < 4; i += 1) step(session, [['bash', [text('k')]]])
  const { pruned } = new ClearingToolResultPruner({ tokenMeter: meter }).pruneSession(session)
  assert.equal(pruned.length, 1)
  assert.deepEqual(session.log[pruned[0].replacementSeq].data.message.content, [text(clearedPlaceholder('tool', 300))])
  console.log('ok 6 tool name falls back to `tool`')
}

/* ------------------------------------------------------------------ 7 */
{
  assert.deepEqual({ ...resolveConfig() }, { keepRecentTurns: 3, thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  assert.throws(() => resolveConfig({ bogus: 1 }), /unknown key "bogus"/)
  assert.throws(() => resolveConfig({ keepRecentTurns: 0 }), /keepRecentTurns \(0\) must be an integer >= 1/)
  assert.throws(() => resolveConfig({ thresholdChars: 0 }), /thresholdChars/)
  assert.throws(() => resolveConfig({ thresholdChars: 5000 }), /must be at most thresholdChars/)
  assert.deepEqual(Config['~standard'].validate(undefined).value, { ...resolveConfig() })
  assert.equal(Config['~standard'].validate({ keepRecentTurns: 5 }).value.keepRecentTurns, 5)
  assert.match(Config['~standard'].validate({ headChars: 9000 }).issues[0].message, /must be at most thresholdChars/)
  console.log('ok 7 config validation and the Standard Schema')
}

/* ------------------------------------------------------------------ 8 */
{
  const root = new Context()
  root.plugin({ apply: (ctx) => void ctx.reflect.provide('tokenMeter', meter) })
  const group = root.isolate(SERVICE_NAME)
  group.plugin(row, { keepRecentTurns: 2 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const service = group.get(SERVICE_NAME)
  assert.ok(service instanceof ClearingToolResultPruner)
  assert.equal(service.config.keepRecentTurns, 2)
  assert.equal(root.get(SERVICE_NAME), undefined)

  const session = newSession()
  for (let i = 0; i < 3; i += 1) step(session, [['bash', [text('m'.repeat(100))]]])
  assert.equal(service.pruneSession(session).pruned.length, 1)
  console.log('ok 8 mounted through real cordis, the service lives only in the isolated scope')
}

/* ------------------------------------------------------------------ 9 */
{
  // One closed older turn, then a long open turn of ten steps.
  const session = newSession()
  const older = startTurn(session)
  const olderResults = [
    ...step(session, [['bash', [text('o'.repeat(300))]]], { turn: older, step: 0 }),
    ...step(session, [['bash', [text('p'.repeat(300))]]], { turn: older, step: 1 }),
  ]
  endTurn(session, older)
  const long = startTurn(session)
  const longResults = []
  for (let i = 0; i < 10; i += 1) {
    longResults.push(...step(session, [['bash', [text('q'.repeat(300))]]], { turn: long, step: i }))
  }
  const { pruned } = new ClearingToolResultPruner({ tokenMeter: meter }, { keepRecentTurns: 1 }).pruneSession(session)
  assert.deepEqual(pruned.map((item) => item.originalSeq), olderResults.map((event) => event.seq))
  assert.ok(pruned.every((item) => item.mode === 'cleared'))
  for (const event of longResults) assert.ok(session.nodes.includes(event.seq))

  // The open turn counts before any of its events reach the surface.
  const fresh = newSession()
  const [first] = step(fresh, [['bash', [text('r'.repeat(300))]]])
  const [second] = step(fresh, [['bash', [text('s'.repeat(300))]]])
  startTurn(fresh)
  const window2 = new ClearingToolResultPruner({ tokenMeter: meter }, { keepRecentTurns: 2 }).pruneSession(fresh)
  assert.deepEqual(window2.pruned.map((item) => item.originalSeq), [first.seq])
  assert.ok(fresh.nodes.includes(second.seq))
  console.log('ok 9 turns are DSH turns: a 10-step turn stays whole, the open turn always counts')
}

console.log('all pruner tests passed')
