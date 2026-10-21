/**
 * read_report modes: head (the default), full, and index.
 *
 * The main session pays for every character this tool returns, so the default
 * read must be a *head*: metadata, section headings, and a bounded preview. The
 * tests below pin the default with NO `mode` argument at all, because an
 * explicitly passed `mode: "head"` would keep passing even if the tool's real
 * default had drifted to `full`.
 *
 * Run: node test/report-head.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

import * as mainRow from '../main.js'
import {
  PREVIEW_CHARS,
  SMALL_REPORT_CHARS,
  estimateTokens,
  previewDocument,
  sectionHeadings,
  setStoreRoot,
  writeReport,
} from '../store.js'

const home = await mkdtemp(join(tmpdir(), 'dw-head-'))
setStoreRoot(home)

const WS = { id: 'ws-head', title: 'head-workspace', path: '/workspace/head', sessionIds: [] }

/** Mount the main row exactly the way test/smoke-restart.mjs does. */
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
      prompt: async (_r, s) => { s.throwIfAborted(); return { accepted: true } },
    },
    on: (e, h) => { const l = listeners.get(e) ?? []; l.push(h); listeners.set(e, l); return () => {} },
  }
  row.apply(ctx, config); return { ctx, tools, listeners }
}

const run = (tools, name, args, sessionId = 'session-main-head') =>
  tools.get(name).execute(args, { signal: new AbortController().signal, agent: { session: { id: sessionId } } })

function makeReport(id, document, summary, reportedAt) {
  return {
    id,
    dispatchId: `dispatch-${id}`,
    workspaceId: WS.id,
    workspaceTitle: WS.title,
    workerSessionId: 'worker-head',
    mainSessionId: 'main-head',
    status: 'delivered',
    outcome: 'done',
    summary,
    document,
    reportedAt,
    deliveredTo: ['main-head'],
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const LONG_SUMMARY = `${'The parser refactor landed; three files changed. '.repeat(8)}Tail marker.`

const largeDocument = [
  '# Worker report: parser refactor',
  '',
  'Intro with 中文 and an emoji 😀.',
  '',
  '## What changed',
  '',
  'filler '.repeat(300),
  '',
  '## Verification',
  '',
  '```js',
  "const label = '中文 😀 " + 'y'.repeat(40) + "'",
  'console.log(label)',
  '```',
  '',
  '### Left over',
  '',
  'tail '.repeat(500),
].join('\n')

const smallDocument = [
  '# Small report',
  '',
  'One paragraph of detail with 中文.',
  '',
  '## Next step',
  '',
  'None.',
].join('\n')

// A fence that opens before the 2000-character cut and never closes: the
// preview must not hand back a dangling fence.
const unclosedFenceDocument = [
  '# Fence at the cut',
  '',
  'a'.repeat(1900),
  '```js',
  ...Array.from({ length: 40 }, (_, index) => `const line${index} = 'still inside the fence'`),
  '```',
].join('\n')

// A fence that opens at offset 0 and stays open past the cut: backing off is
// impossible, so the preview must be closed with the same marker instead.
const fenceAtZeroDocument = [
  '```js',
  ...Array.from({ length: 200 }, (_, index) => `const row${index} = 'value ${index}'`),
  '```',
].join('\n')

/** The 2000th UTF-16 unit is the high half of an astral emoji. */
const emojiPrefix = '# 中文标题\n\n'
const emojiRun = 'a'.repeat(PREVIEW_CHARS - emojiPrefix.length - 1)
const emojiAtCutDocument = `${emojiPrefix}${emojiRun}😀中文尾部\n\n${'z'.repeat(4000)}`

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const large = makeReport('r-head-large', largeDocument, LONG_SUMMARY, '2026-10-21T11:00:00.000Z')
const small = makeReport('r-head-small', smallDocument, 'Small report summary.', '2026-10-21T10:30:00.000Z')
const fenced = makeReport('r-head-fenced', unclosedFenceDocument, 'Unclosed fence fixture.', '2026-10-21T10:20:00.000Z')
const zeroFenced = makeReport('r-head-zero-fence', fenceAtZeroDocument, 'Fence at offset zero.', '2026-10-21T10:10:00.000Z')
const emoji = makeReport('r-head-emoji', emojiAtCutDocument, 'Emoji at the cut.', '2026-10-21T10:00:00.000Z')

for (const report of [large, small, fenced, zeroFenced, emoji]) {
  await writeReport(home, report)
}

const { tools } = mount(mainRow)
const tool = tools.get('read_report')

/* ------------------------------------------------------------------ *
 * 1. the tool surface declares the three modes
 * ------------------------------------------------------------------ */

{
  assertSupportedJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
  assert.deepEqual(tool.parameters.properties.mode.enum, ['head', 'full', 'index'])
  assert.ok(tool.output.schema.properties.index, 'the index payload must be declared in the output schema')
  assert.match(tool.description, /head/i, 'the description must name the default read')
  assert.match(tool.description, /mode:"full"|mode: "full"/, 'the description must name how to get the whole thing')
  console.log('ok 1 — parameters/output schemas stay inside the Host subset and declare head/full/index')
}

/* ------------------------------------------------------------------ *
 * 2. NO mode argument at all must be head
 * ------------------------------------------------------------------ */

let defaultHead
{
  defaultHead = await run(tools, 'read_report', { report_id: large.id })
  assert.equal(defaultHead.returned, 'head', 'the REAL default mode must be head, not full')
  assert.equal(defaultHead.report.id, large.id)
  assert.equal(defaultHead.report.status, 'delivered')
  assert.equal(defaultHead.report.outcome, 'done')
  assert.equal(defaultHead.report.reportedAt, large.reportedAt)
  assert.equal(defaultHead.report.workerSessionId, 'worker-head')
  assert.equal(defaultHead.report.summary, LONG_SUMMARY, 'the summary must be returned in full, not shortened')

  assert.equal(defaultHead.report.chars, largeDocument.length)
  assert.equal(defaultHead.report.estimatedTokens, Math.ceil(largeDocument.length / 4))
  assert.equal(defaultHead.report.documentTruncated, true)
  assert.ok(
    defaultHead.report.document.length <= PREVIEW_CHARS,
    `the head document must be bounded (got ${defaultHead.report.document.length})`,
  )
  assert.ok(
    defaultHead.report.document.length < largeDocument.length,
    'a head must not carry the whole document',
  )
  assert.ok(largeDocument.startsWith(defaultHead.report.document), 'the preview is a prefix of the document')

  assert.deepEqual(defaultHead.report.sectionHeadings, [
    { level: 1, title: 'Worker report: parser refactor' },
    { level: 2, title: 'What changed' },
    { level: 2, title: 'Verification' },
    { level: 3, title: 'Left over' },
  ], 'only ATX h1-h3 outside code fences are headings')

  const hint = String(defaultHead.howToReadFull ?? '')
  assert.ok(
    hint.includes(`read_report(report_id="${large.id}", mode="full")`),
    `the hint must spell out the exact full read (got: ${hint})`,
  )
  assert.match(hint, new RegExp(`${largeDocument.length}`), 'the hint should say how many characters are behind it')

  const violations = validateJsonSchemaValue(tool.output.schema, defaultHead, 'head')
  assert.deepEqual(violations, [], 'the head value must validate against the tool output schema')
  console.log('ok 2 — an omitted mode returns the head (the real default), with full summary and headings')
}

/* ------------------------------------------------------------------ *
 * 3. explicit head equals the default
 * ------------------------------------------------------------------ */

{
  const explicit = await run(tools, 'read_report', { report_id: large.id, mode: 'head' })
  assert.deepEqual(explicit, defaultHead, 'mode omitted and mode:"head" must be the same value')
  console.log('ok 3 — the implied head and an explicit mode:"head" are identical')
}

/* ------------------------------------------------------------------ *
 * 4. full is exactly the whole document
 * ------------------------------------------------------------------ */

{
  const full = await run(tools, 'read_report', { report_id: large.id, mode: 'full' })
  assert.equal(full.returned, 'full')
  assert.equal(full.report.document, largeDocument, 'mode:"full" must carry the whole document')
  assert.equal(full.report.id, large.id)
  assert.equal(full.howToReadFull, undefined, 'no hint is needed when the whole thing is already here')
  assert.ok(full.report.document.length > PREVIEW_CHARS)
  const violations = validateJsonSchemaValue(tool.output.schema, full, 'full')
  assert.deepEqual(violations, [])
  console.log(`ok 4 — mode:"full" returns the whole ${largeDocument.length}-character document`)
}

/* ------------------------------------------------------------------ *
 * 5. a small report comes back whole
 * ------------------------------------------------------------------ */

{
  assert.ok(smallDocument.length < SMALL_REPORT_CHARS)
  const value = await run(tools, 'read_report', { report_id: small.id })
  assert.equal(value.returned, 'full (small report)')
  assert.equal(value.report.document, smallDocument, 'a short report must not be previewed')
  assert.equal(value.report.documentTruncated, false)
  assert.equal(value.report.chars, smallDocument.length)

  // The shortcut must never cost more than the thing it replaces. Measured on
  // the rendered payload, because that string is what the main session pays.
  // The first version repeated every heading in `sectionHeadings` even though
  // the whole document was already there, which made this branch 8-15% larger
  // than mode:"full" on six real reports — inverting the point of the branch.
  const rendered = (payload) => tool.output.render({}, payload)[0].text
  const shortHead = rendered(value)
  const shortFull = rendered(await run(tools, 'read_report', { report_id: small.id, mode: 'full' }))
  assert.ok(
    shortHead.length <= shortFull.length,
    `the small-report head must not cost more than mode:"full" (head ${shortHead.length} > full ${shortFull.length})`,
  )
  assert.equal(value.report.sectionHeadings, undefined, 'the whole document already shows its own headings')
  console.log(
    `ok 5 — a report under 3000 characters returns in full as "full (small report)" ` +
      `(rendered head ${shortHead.length} <= full ${shortFull.length})`,
  )
}

/* ------------------------------------------------------------------ *
 * 6. index is a disk scan over one workspace
 * ------------------------------------------------------------------ */

{
  const value = await run(tools, 'read_report', { mode: 'index', workspace: 'head-workspace' })
  assert.equal(value.returned, 'index')
  assert.match(String(value.index.source), /disk scan/i, 'index must admit it scans the disk')
  assert.match(String(value.index.source), /no index file/i, 'and must not pretend an index file exists')
  assert.equal(value.index.count, 5)
  assert.equal(value.index.truncated, false)
  assert.equal(value.index.lines.length, 5)
  for (const line of value.index.lines) {
    assert.match(
      line,
      /^- \d{4}-\d{2}-\d{2}T[\d:.]+Z \[(?:delivered|reported)\/(?:done|partial|blocked|unknown)\] .+ — r-[A-Za-z0-9_-]+$/,
      `index lines must follow the documented shape (got: ${line})`,
    )
  }
  const emojiLine = value.index.lines.find((line) => line.includes(emoji.id))
  assert.ok(emojiLine.startsWith(`- ${emoji.reportedAt} [delivered/done] Emoji at the cut. — `), emojiLine)
  assert.ok(value.index.lines.some((line) => line.includes(large.id)), 'newest first must include the large report')

  const capped = await run(tools, 'read_report', { mode: 'index', workspace: 'head-workspace', limit: 2 })
  assert.equal(capped.index.lines.length, 2)
  assert.equal(capped.index.count, 2)
  assert.equal(capped.index.truncated, true, 'a capped index must say it truncated')
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'index')
  assert.deepEqual(violations, [])
  console.log('ok 6 — mode:"index" lists the workspace as an explicit disk scan, capped and truncated')
}

/* ------------------------------------------------------------------ *
 * 7. a list read without report_id keeps its old shape
 * ------------------------------------------------------------------ */

{
  const value = await run(tools, 'read_report', { workspace: 'head-workspace' })
  assert.equal(value.reports.length, 5)
  assert.equal(value.returned, undefined)
  assert.equal(value.reports[0].document, undefined, 'the listing never carries documents')
  assert.match(value.note, /5 report/)
  console.log('ok 7 — the no-report_id listing is unchanged (metadata only)')
}

/* ------------------------------------------------------------------ *
 * 8. truncation never leaves a dangling code fence
 * ------------------------------------------------------------------ */

{
  const back = await run(tools, 'read_report', { report_id: fenced.id })
  const text = back.report.document
  assert.equal(back.report.documentTruncated, true)
  assert.ok(!text.includes('```js'), 'a preview cut inside a fence backs off past the opening fence')
  assert.ok(text.length > 0)

  const kept = await run(tools, 'read_report', { report_id: zeroFenced.id })
  const keptText = kept.report.document
  assert.equal(keptText.slice(0, 5), '```js', 'a fence at offset 0 cannot be backed out of')
  const fences = keptText.split('\n').filter((line) => line.trimStart().startsWith('```'))
  assert.equal(fences.length % 2, 0, 'the preview must close the fence it opened')
  assert.ok(keptText.trimEnd().endsWith('```'), 'the appended closing fence is the last line')
  assert.equal(kept.report.fenceClosed, true, 'an appended fence is marked in the payload')

  // The pure function itself: every preview is fence-balanced.
  for (const report of [large, fenced, zeroFenced]) {
    const preview = previewDocument(report.document)
    const markers = preview.text.split('\n').filter((line) => line.trimStart().startsWith('```'))
    assert.equal(markers.length % 2, 0, `preview of ${report.id} leaves an odd number of fence lines`)
    assert.equal(preview.fenceSafe, true)
  }
  console.log('ok 8 — an open fence at the cut backs off, or is closed when it starts at offset 0')
}

/* ------------------------------------------------------------------ *
 * 9. no surrogate pair or Chinese character is split at the cut
 * ------------------------------------------------------------------ */

{
  assert.equal(emojiAtCutDocument.length > SMALL_REPORT_CHARS, true)
  const value = await run(tools, 'read_report', { report_id: emoji.id })
  const text = value.report.document
  assert.equal(text, `${emojiPrefix}${emojiRun}`, 'the cut backs off one unit so the emoji stays whole')
  assert.equal(text.length, PREVIEW_CHARS - 1)
  assert.ok(!LONE_SURROGATE.test(text), 'the preview must not end inside a surrogate pair')
  assert.ok(!text.includes('\uFFFD'), 'no replacement characters may appear')
  assert.ok(text.startsWith('# 中文标题'), 'Chinese text survives the cut intact')

  const preview = previewDocument(emojiAtCutDocument)
  assert.equal(preview.cutAt, PREVIEW_CHARS - 1)
  assert.ok(!LONE_SURROGATE.test(preview.text))
  assert.deepEqual(sectionHeadings(`${emojiAtCutDocument}`), [
    { level: 1, title: '中文标题' },
  ])
  console.log('ok 9 — an emoji straddling the 2000-character cut and its Chinese neighbours stay intact')
}

/* ------------------------------------------------------------------ *
 * 10. bounds, unknown modes, missing reports
 * ------------------------------------------------------------------ */

{
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(1), 1)
  assert.equal(estimateTokens(2000), 500)

  await assert.rejects(
    () => run(tools, 'read_report', { report_id: large.id, mode: 'summary' }),
    /mode/,
    'an unknown mode must be rejected with a clear error naming the parameter',
  )
  await assert.rejects(
    () => run(tools, 'read_report', { report_id: large.id, mode: 'index', workspace: 'head-workspace' }),
    /index/,
    'index cannot be combined with a single report id',
  )
  const missing = await run(tools, 'read_report', { report_id: 'r-head-nope' })
  assert.match(missing.note, /no report with id/)
  console.log('ok 10 — unknown modes and index+report_id are rejected; a missing id still returns its note')
}

await rm(home, { recursive: true, force: true })
console.log('\nAll read_report head checks passed.')
