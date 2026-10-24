/**
 * Main-session rotation: reports follow the lineage to the current main session.
 *
 *   6. a worker reporting to a rotated-away main session pushes to the current
 *      one and records it in `deliveredTo`; while `rotation.lock` exists,
 *      `currentMainFor` waits for the rotation to settle
 *
 * Run: node test/rotation.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { readDispatchCheckpoint, writeDispatchCheckpoint } from '../checkpoint.js'
import { resetRegistry } from '../registry.js'
import { currentMainFor, readState, resolveMainTarget, rotationLockPath, writeState } from '../state.js'
import { clearStoreRoot, dataDir, readReport, setStoreRoot } from '../store.js'
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

  console.log('All rotation checks passed.')
} finally {
  clearStoreRoot()
  resetRegistry()
  await rm(root, { recursive: true, force: true })
}
