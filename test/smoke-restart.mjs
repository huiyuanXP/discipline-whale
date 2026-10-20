/**
 * Real-scenario smoke: dispatch -> lose all memory (simulated restart) -> worker
 * reports. Deliberately NOT a unit test: it drives the two rows through their
 * registered tool objects against a fake Host, and asserts on the report FILE
 * that a main session would actually read with read_report.
 */
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mainRow from '../main.js'
import * as workerRow from '../worker.js'
import { resetRegistry } from '../registry.js'
import { setStoreRoot, workspaceKey } from '../store.js'

const home = await mkdtemp(join(tmpdir(), 'dw-smoke-'))
setStoreRoot(home)
const WS = { id: 'ws-example', title: 'example-workspace', path: '/workspace/example', sessionIds: [] }
const pushes = []

function mount(row, config = {}) {
  const tools = new Map(); const listeners = new Map()
  let seq = 0
  const ctx = {
    logger: { warn: (m) => console.log('  [warn]', m) },
    effect: (fn) => fn(),
    tools: { register: (d) => { tools.set(d.name, d); return () => {} } },
    workspaceRegistry: { list: () => [WS] },
    sessionController: {
      create: async () => ({ sessionId: `session-${Date.now()}-${++seq}` }),
      rename: async (r) => ({ title: r.title }),
      prompt: async (r, s) => { s.throwIfAborted(); pushes.push({ to: r.sessionId, text: r.content[0].text }); return { accepted: true } },
    },
    on: (e, h) => { const l = listeners.get(e) ?? []; l.push(h); listeners.set(e, l); return () => {} },
  }
  row.apply(ctx, config); return { ctx, tools, listeners }
}
const run = (tools, name, args, sessionId) =>
  tools.get(name).execute(args, { signal: new AbortController().signal, agent: { session: { id: sessionId } } })

console.log('1) main session dispatches')
resetRegistry()
const main = mount(mainRow)
const dispatched = await run(main.tools, 'dispatch_task', { workspace: 'example-workspace', task: 'Refactor the parser.' }, 'session-main-smoke')
console.log('   dispatch:', JSON.stringify(dispatched))
const ckpt = join(home, 'discipline-whale', 'dispatches', `${workspaceKey(dispatched.workerSessionId)}.json`)
console.log('   checkpoint on disk before worker ever runs:', JSON.parse(await readFile(ckpt, 'utf8')).mainSessionId)

console.log('2) the board sees it as running')
const board = await run(main.tools, 'list_dispatches', {}, 'session-main-smoke')
console.log('   ', board.note)

console.log('3) RESTART — every in-memory record is destroyed')
resetRegistry()
const main2 = mount(mainRow)          // a brand-new row instance: no shared state
const afterRestart = await run(main2.tools, 'list_dispatches', {}, 'session-main-smoke')
console.log('   board after restart (process-local registry is empty):', afterRestart.counts.total, 'row(s)')

console.log('4) worker reports with no live dispatch record')
const worker = mount(workerRow)
const value = await run(worker.tools, 'report_to_main', { summary: 'Parser refactor done; tests green.', document: 'Changed 3 files.', status: 'done' }, dispatched.workerSessionId)
console.log('   result:', JSON.stringify(value))

console.log('5) did the report actually reach the main session?')
const delivered = pushes.filter((p) => p.to === 'session-main-smoke')
console.log('   pushes to main session:', delivered.length)
if (delivered.length === 1) console.log('   message:\n' + delivered[0].text.split('\n').map((l) => '     | ' + l).join('\n'))

console.log('6) the main session reads the stored document')
const read = await run(main2.tools, 'read_report', { report_id: value.reportId }, 'session-main-smoke')
console.log('   read_report ->', JSON.stringify({ id: read.report?.id, status: read.report?.status, document: read.report?.document, deliveredTo: read.report?.deliveredTo, recoveredFrom: read.report?.recoveredFrom }))

console.log('7) checkpoint cleanup')
console.log('   checkpoint after delivery:', await readFile(ckpt, 'utf8').then(() => 'STILL THERE (bad)').catch(() => 'removed'))

const reportFiles = await readdir(join(home, 'discipline-whale', WS.id))
console.log('8) store contents:', reportFiles)

const problems = []
if (!value.deliveredToMain) problems.push('report was not delivered')
if (delivered.length !== 1) problems.push(`expected exactly 1 push, got ${delivered.length}`)
if (read.report?.status !== 'delivered') problems.push('stored report is not delivered')
if (await readFile(ckpt, 'utf8').then(() => true).catch(() => false)) problems.push('checkpoint not removed')
await rm(home, { recursive: true, force: true })
console.log(problems.length === 0 ? '\nSMOKE PASS — dispatch survived a full memory wipe and the report reached the main session' : `\nSMOKE FAIL: ${problems.join('; ')}`)
process.exit(problems.length === 0 ? 0 : 1)
