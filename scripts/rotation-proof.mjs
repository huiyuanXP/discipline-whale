/**
 * Rotation proof — every main-session segment in `state.json`'s lineage, read
 * back from the durable Session logs.
 *
 * For each segment (the archived ones in lineage order, then the current main
 * session) it prints:
 *
 *   input           first and last `usage.inputTokens` of its assistant messages
 *   compactions     `compaction/summary` events
 *   board refreshes runtime-context snapshots whose `discipline-whale:activity`
 *                   section changed, next to the human messages (acceptance
 *                   A4: board refreshes ≤ human messages + 1); other plugins'
 *                   sections add snapshots of their own, counted beside it
 *   report pushes   worker report pushes in the segment; for an archived
 *                   segment, how many still landed there after it ended
 *   seed            the seed file that opened the segment: characters and the
 *                   running dispatches it carried
 *
 * and, per rotation, where the report pushes after it landed (the archived
 * segment or its successor).
 *
 * Usage:
 *   node scripts/rotation-proof.mjs           # the table
 *   node scripts/rotation-proof.mjs --json    # the same facts as JSON
 *   node scripts/rotation-proof.mjs --watch   # one status line every 2 s:
 *                                             # main session, its latest input,
 *                                             # lineage length, running dispatches
 *
 * Reads `$DSH_HOME` (default `~/.dsh`) only, never writes. Session logs are
 * multi-frame zstd; `readSessionRecords` from `context-audit.mjs` decodes all
 * frames.
 */

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isDispatchAbandoned, listDispatchCheckpoints } from '../checkpoint.js'
import { PUSH_PREFIXES, isHumanMessage, messageText } from '../pushes.js'
import { readState } from '../state.js'
import { dataDir } from '../store.js'
import { readSessionRecords } from './context-audit.mjs'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Source kind the agent loop gives runtime-context snapshots. */
const RUNTIME_CONTEXT_KIND = 'runtime-context'

/** The board's section inside a runtime-context snapshot. */
const ACTIVITY_SECTION = 'discipline-whale:activity'

/** `$DSH_HOME/sessions/<cwd key>/<sessionId>/session.v4.jsonl.zstd`, or undefined. */
async function sessionLogPath(sessionId) {
  const root = join(DSH_HOME, 'sessions')
  let dirs = []
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const path = join(root, dir.name, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(path)) return path
  }
  return undefined
}

/** The facts of one segment's log. */
function measure(records) {
  const out = {
    firstInputTokens: undefined,
    lastInputTokens: undefined,
    compactions: 0,
    snapshots: 0,
    boardSnapshots: 0,
    humanMessages: 0,
    reportPushes: [],
  }
  let board
  for (const record of records) {
    if (record?.type === 'assistant/message') {
      const tokens = record.data?.usage?.inputTokens
      if (Number.isFinite(tokens)) {
        out.firstInputTokens ??= tokens
        out.lastInputTokens = tokens
      }
    } else if (record?.type === 'compaction/summary') {
      out.compactions += 1
    } else if (record?.type === 'user/message') {
      if (record.data?.source?.kind === RUNTIME_CONTEXT_KIND) {
        out.snapshots += 1
        // Other plugins add their own sections; A4 is about the whale's board refreshes.
        const text = record.data.source.sections?.find?.((section) => section.name === ACTIVITY_SECTION)?.text
        if (text !== undefined && text !== board) out.boardSnapshots += 1
        if (text !== undefined) board = text
      }
      else if (isHumanMessage(record.data)) out.humanMessages += 1
      else if (messageText(record.data).startsWith(PUSH_PREFIXES.report)) out.reportPushes.push(Number(record.time))
    }
  }
  return out
}

/** Characters of a seed file and the running dispatches it carried. */
async function seedFacts(seedFile) {
  if (typeof seedFile !== 'string' || seedFile === '') return undefined
  try {
    const text = await readFile(join(dataDir(DSH_HOME), seedFile), 'utf8')
    const running = text.split('\n## ')[1] ?? ''
    return {
      file: seedFile,
      chars: Array.from(text.trimEnd()).length,
      running: running.startsWith('进行中的派工') ? running.split('\n').filter((line) => line.startsWith('### ')).length : 0,
    }
  } catch {
    return { file: seedFile, missing: true }
  }
}

async function readSegment(sessionId) {
  const path = await sessionLogPath(sessionId)
  if (path === undefined) return { sessionId, log: undefined }
  try {
    return { sessionId, log: path, ...measure(readSessionRecords(path)) }
  } catch (error) {
    return { sessionId, log: path, error: String(error?.message ?? error) }
  }
}

/** Every segment of the lineage plus the current main session, with the rotations between them. */
export async function collect() {
  const state = await readState(DSH_HOME)
  const lineage = Array.isArray(state.lineage) ? state.lineage : []
  const ids = [...lineage.map((entry) => entry.sessionId)]
  if (typeof state.mainSessionId === 'string' && !ids.includes(state.mainSessionId)) ids.push(state.mainSessionId)
  const segments = []
  for (const [index, sessionId] of ids.entries()) {
    const ended = lineage.find((entry) => entry.sessionId === sessionId)
    const opened = lineage.find((entry) => entry.successor === sessionId)
    const segment = await readSegment(sessionId)
    const endedAt = Date.parse(ended?.endedAt ?? '')
    segments.push({
      number: index + 1,
      ...segment,
      current: sessionId === state.mainSessionId,
      endedAt: ended?.endedAt,
      reason: ended?.reason,
      successor: ended?.successor,
      reportPushes: segment.reportPushes?.length,
      pushesAfterEnd: Number.isFinite(endedAt) ? (segment.reportPushes ?? []).filter((time) => time > endedAt).length : undefined,
      seed: await seedFacts(opened?.seedFile),
      a4: Number.isInteger(segment.boardSnapshots) ? segment.boardSnapshots <= segment.humanMessages + 1 : undefined,
      pushTimes: segment.reportPushes ?? [],
    })
  }
  const rotations = lineage.map((entry) => {
    const endedAt = Date.parse(entry.endedAt ?? '')
    const after = (id) => segments.find((segment) => segment.sessionId === id)?.pushTimes.filter((time) => time > endedAt).length
    return {
      from: entry.sessionId,
      to: entry.successor,
      endedAt: entry.endedAt,
      reason: entry.reason,
      lastInputTokens: entry.lastInputTokens,
      compactions: entry.compactions,
      pushesAfterInOld: after(entry.sessionId),
      pushesAfterInSuccessor: after(entry.successor),
    }
  })
  for (const segment of segments) delete segment.pushTimes
  return { dshHome: DSH_HOME, mainSessionId: state.mainSessionId ?? null, segments, rotations }
}

const num = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—')
const short = (id) => String(id ?? '—').replace(/^session-/, '').slice(0, 8)

function render({ dshHome, mainSessionId, segments, rotations }) {
  const lines = [
    `# Rotation proof — ${dshHome}`,
    '',
    `main session: ${mainSessionId ?? '(none recorded)'} · segments: ${segments.length} · rotations: ${rotations.length}`,
    '',
    '| # | session | state | input first → last | compactions | board refreshes / human (A4) | all snapshots | report pushes | after end | seed chars | seed running |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const segment of segments) {
    const state = segment.current ? 'current' : `archived (${segment.reason ?? '?'})`
    if (segment.log === undefined || segment.error !== undefined) {
      lines.push(`| ${segment.number} | ${short(segment.sessionId)} | ${state} | ${segment.error ?? 'no log found'} | | | | | | | |`)
      continue
    }
    lines.push(
      [
        '',
        segment.number,
        short(segment.sessionId),
        state,
        `${num(segment.firstInputTokens)} → ${num(segment.lastInputTokens)}`,
        segment.compactions,
        `${segment.boardSnapshots} / ${segment.humanMessages} (${segment.a4 ? 'ok' : 'over'})`,
        segment.snapshots,
        segment.reportPushes,
        segment.pushesAfterEnd ?? '—',
        segment.seed?.chars === undefined ? '—' : num(segment.seed.chars),
        segment.seed?.running ?? '—',
        '',
      ].join(' | ').trim(),
    )
  }
  if (rotations.length > 0) {
    lines.push('', '| rotation | ended | reason | last input | compactions | pushes after: old / successor |', '|---|---|---|---|---|---|')
    for (const rotation of rotations) {
      lines.push(
        `| ${short(rotation.from)} → ${short(rotation.to)} | ${rotation.endedAt ?? '—'} | ${rotation.reason ?? '—'} | ${num(rotation.lastInputTokens)} | ${rotation.compactions ?? '—'} | ${rotation.pushesAfterInOld ?? '—'} / ${rotation.pushesAfterInSuccessor ?? '—'} |`,
      )
    }
  }
  return lines.join('\n')
}

/** One status line: the current main session, its latest input, the lineage, running dispatches. */
async function statusLine(previous) {
  const state = await readState(DSH_HOME)
  const lineage = Array.isArray(state.lineage) ? state.lineage.length : 0
  let input = previous.input
  if (typeof state.mainSessionId === 'string') {
    const segment = await readSegment(state.mainSessionId)
    // A log mid-append can fail to decode; keep the last reading for that tick.
    if (segment.error === undefined && segment.lastInputTokens !== undefined) input = segment.lastInputTokens
    if (state.mainSessionId !== previous.main) input = segment.lastInputTokens
  }
  let running = 0
  try {
    running = (await listDispatchCheckpoints(DSH_HOME)).filter((record) => !isDispatchAbandoned(DSH_HOME, record.workerSessionId)).length
  } catch {
    running = 0
  }
  const time = new Date().toTimeString().slice(0, 8)
  return {
    main: state.mainSessionId,
    input,
    line: `${time}  main ${short(state.mainSessionId)} · input ${num(input)} · lineage ${lineage} · running ${running}`,
  }
}

async function watch() {
  let previous = {}
  for (;;) {
    previous = await statusLine(previous)
    console.log(previous.line)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  if (args.has('--watch')) return watch()
  const facts = await collect()
  console.log(args.has('--json') ? JSON.stringify(facts, null, 2) : render(facts))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
