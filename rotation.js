/**
 * discipline-whale — main-session rotation.
 *
 * A main session grows with every dispatch brief, report push and runtime
 * context snapshot. The host compacts it first (old tool output, then the
 * oldest turns); once it has compacted twice, or its input reaches the rotation
 * threshold, the next idle point ends the segment and starts a new main
 * session that is seeded from disk:
 *
 *   flush memory → build the seed (running dispatches with their full brief,
 *   the latest deliveries, index pointers, the last exchange) → create the new
 *   main session → deliver the seed as a notice → record it in `state.json`
 *   (`mainSessionId` + `lineage`) → retarget dispatch checkpoints → rename the
 *   old session as archived
 *
 * The memory row rotates automatically on `agent/status: idle`; the home row's
 * "+ 新建主会话" rotates on request (`reason: 'manual'`, no flush). Both go
 * through {@link rotateMain}. Every fact a rotation reads or writes is on disk,
 * so the rows involved may be separate module instances.
 *
 * @module discipline-whale/rotation
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { isDispatchAbandoned, listDispatchCheckpoints, writeDispatchCheckpoint } from './checkpoint.js'
import { charLength, isoDay } from './entry.js'
import { PUSH_PREFIXES, isHumanMessage, messageText } from './pushes.js'
import { dispatches, listDispatches } from './registry.js'
import { readState, rotationLockPath, writeState } from './state.js'
import {
  REPORTS_DIRNAME,
  dataDir,
  listReports,
  reportIndexPath,
  sectionHeadings,
  storeRoot,
  whaleHomeDir,
} from './store.js'
import { BRIEF_MARKERS } from './worker.js'

/** Preset the main session runs. */
export const MAIN_PRESET = 'discipline-whale'

/** Title of the main session in the session list. */
export const MAIN_TITLE = '自律鲸鱼'

/** Source of the seed notice that opens a new segment. */
export const ROTATION_SOURCE = Object.freeze({ kind: 'plugin:discipline-whale:rotation', form: 'notice' })

/** Defaults; the memory row reads each key from its config. */
export const ROTATION_DEFAULTS = Object.freeze({
  rotateEnabled: true,
  // After the second successful summary, the next idle point rotates.
  rotateAfterCompactions: 2,
  // Input threshold before the window and compaction terms; see rotateInputThreshold.
  rotateInputTokens: 180000,
  rotateWindowFraction: 0.6,
  // A segment rotates only after this many human turns (debounce).
  rotateMinHumanTurns: 10,
  seedBudgetChars: 40000,
  seedRunningMaxChars: 12000,
  seedCompleted: 5,
})

/**
 * Environment overrides for isolated-instance verification and live demos,
 * applied after the row config: variable → config key.
 */
export const ROTATION_ENV = Object.freeze({
  DW_ROTATE_INPUT_TOKENS: 'rotateInputTokens',
  DW_ROTATE_MIN_HUMAN_TURNS: 'rotateMinHumanTurns',
  DW_ROTATE_AFTER_COMPACTIONS: 'rotateAfterCompactions',
})

/** Directory under the whale home that holds one seed file per new segment. */
export const ROTATIONS_DIRNAME = 'rotations'

/** Longest the pre-rotation flush may take before the rotation goes ahead, in milliseconds. */
export const ROTATION_FLUSH_WAIT_MS = 60_000

/** A rotation lock older than this is left over from a crash and may be taken over. */
export const ROTATION_LOCK_STALE_MS = 5 * 60_000

/** After a failed create or a failed seed delivery, automatic rotation waits this long. */
export const ROTATION_COOLDOWN_MS = 10 * 60_000

/** The last-exchange texts and each later worker instruction are cut to this many characters. */
const EXCHANGE_MAX = 1500

/** The worker's latest words in the seed. */
const STATUS_MAX = 800

/** How many later worker instructions the seed carries. */
const INSTRUCTIONS_KEPT = 3

/** A running dispatch over its own budget keeps this much of its brief. */
const BRIEF_TRIMMED = 3000

/** A running dispatch cut down for the total budget keeps this much of its brief. */
const BRIEF_REDUCED = 2000

/** Terminal report statuses: the dispatch has an answer. */
const TERMINAL = new Set(['reported', 'delivered', 'abandoned'])

/** What each reason reads as in the seed's opening line. */
const REASON_TEXT = Object.freeze({
  compactions: '压缩已满',
  'input-tokens': '输入达到门槛',
  'compaction-failed': '压缩失败',
  manual: '手动新建',
})

/** Epoch ms before which automatic rotation is not attempted again. */
let cooldownUntil = 0

/* ------------------------------------------------------------------ *
 * pure helpers
 * ------------------------------------------------------------------ */

/** Cut `text` to `max` code points, keeping its line breaks; '…' marks a cut. */
function cut(text, max) {
  const value = String(text ?? '').trim()
  const points = Array.from(value)
  if (points.length <= max) return value
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** `1,234,567`. */
function count(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '?'
}

/** `MM-DD HH:mm` in local time, or '' for an unparseable value. */
function shortMinute(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${isoDay(date).slice(5)} ${hh}:${mm}`
}

/** Text blocks of an assistant message event. */
function assistantText(event) {
  return messageText(event?.data?.message).trim()
}

/** `usage.inputTokens` of an assistant message event, or undefined. */
function inputTokensOf(event) {
  const value = event?.data?.usage?.inputTokens
  return Number.isFinite(value) ? value : undefined
}

/**
 * Rotation facts of one main session, from its events. Pure.
 *
 *   compactions                        `compaction/summary` events
 *   failedCompactionsSinceLastSuccess  `compaction/end` with `data.error` after the last summary
 *   lastInputTokens                    `usage.inputTokens` of the latest assistant message that has it
 *   humanTurns                         `user/message` events the human typed (pushes excluded)
 *   lastHumanText, lastAssistantText   the latest of each, cut to 1,500 characters
 */
export function sessionStats(events = []) {
  let compactions = 0
  let failedCompactionsSinceLastSuccess = 0
  let lastInputTokens = 0
  let humanTurns = 0
  let lastHumanText = ''
  let lastAssistantText = ''
  for (const event of Array.isArray(events) ? events : []) {
    switch (event?.type) {
      case 'compaction/summary':
        compactions += 1
        failedCompactionsSinceLastSuccess = 0
        break
      case 'compaction/end':
        if (event.data?.error !== undefined) failedCompactionsSinceLastSuccess += 1
        break
      case 'assistant/message': {
        const tokens = inputTokensOf(event)
        if (tokens !== undefined) lastInputTokens = tokens
        const text = assistantText(event)
        if (text !== '') lastAssistantText = text
        break
      }
      case 'user/message':
        if (isHumanMessage(event.data)) {
          humanTurns += 1
          lastHumanText = messageText(event.data).trim()
        }
        break
      default:
        break
    }
  }
  return {
    compactions,
    failedCompactionsSinceLastSuccess,
    lastInputTokens,
    humanTurns,
    lastHumanText: cut(lastHumanText, EXCHANGE_MAX),
    lastAssistantText: cut(lastAssistantText, EXCHANGE_MAX),
  }
}

/**
 * The input threshold R2:
 * `max(min(rotateInputTokens, ⌊rotateWindowFraction × W⌋), ⌈1.2 × compactThreshold⌉)`.
 *
 * The compaction term keeps compaction ahead of rotation on every route. A
 * `DW_ROTATE_INPUT_TOKENS` override (`rotateInputPinned`) is the threshold as
 * given, so an isolated instance can rotate early on any route.
 */
export function rotateInputThreshold({ config = ROTATION_DEFAULTS, contextWindow, compactThreshold } = {}) {
  const resolved = { ...ROTATION_DEFAULTS, ...config }
  if (resolved.rotateInputPinned === true) return resolved.rotateInputTokens
  const windowCap =
    Number.isInteger(contextWindow) && contextWindow > 0
      ? Math.floor(resolved.rotateWindowFraction * contextWindow)
      : Number.POSITIVE_INFINITY
  // Integer arithmetic: 1.2 × 163,840 must come out as exactly 196,608.
  const compactionFloor = Number.isFinite(compactThreshold) ? Math.ceil((compactThreshold * 6) / 5) : 0
  return Math.max(Math.min(resolved.rotateInputTokens, windowCap), compactionFloor)
}

/**
 * Whether this segment rotates at the current idle point. Pure; the first rule
 * that matches decides:
 *
 *   1. `rotateEnabled === false`                         → no
 *   2. fewer than `rotateMinHumanTurns` human turns      → no
 *   3. `compactions >= rotateAfterCompactions`           → 'compactions'
 *   4. `lastInputTokens >= R2`                           → 'input-tokens'
 *   5. a failed compaction since the last summary and
 *      `lastInputTokens >= compactThreshold`             → 'compaction-failed'
 */
export function shouldRotate(stats, { config = ROTATION_DEFAULTS, contextWindow, compactThreshold } = {}) {
  const resolved = { ...ROTATION_DEFAULTS, ...config }
  if (resolved.rotateEnabled === false) return { rotate: false }
  if (!(stats?.humanTurns >= resolved.rotateMinHumanTurns)) return { rotate: false }
  if (stats.compactions >= resolved.rotateAfterCompactions) return { rotate: true, reason: 'compactions' }
  if (stats.lastInputTokens >= rotateInputThreshold({ config: resolved, contextWindow, compactThreshold })) {
    return { rotate: true, reason: 'input-tokens' }
  }
  if (
    stats.failedCompactionsSinceLastSuccess >= 1 &&
    Number.isFinite(compactThreshold) &&
    stats.lastInputTokens >= compactThreshold
  ) {
    return { rotate: true, reason: 'compaction-failed' }
  }
  return { rotate: false }
}

/**
 * Apply the `DW_ROTATE_*` overrides to a resolved config.
 *
 * Only positive integers count; any other value is reported through `warn` and
 * the config value stays. A valid `DW_ROTATE_INPUT_TOKENS` also sets
 * `rotateInputPinned`, see {@link rotateInputThreshold}.
 */
export function applyRotationEnv(config, env = process.env, warn = () => {}) {
  const out = { ...config }
  for (const [name, key] of Object.entries(ROTATION_ENV)) {
    const raw = env?.[name]
    if (raw === undefined || String(raw).trim() === '') continue
    const text = String(raw).trim()
    const value = Number(text)
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0) {
      warn(`${name}=${JSON.stringify(raw)} is not a positive integer; keeping ${key}: ${config?.[key]}`)
      continue
    }
    out[key] = value
    if (key === 'rotateInputTokens') out.rotateInputPinned = true
  }
  return out
}

/** A running dispatch's label: title, else topic, else the first 60 characters of its task. */
function runningLabel(dispatch) {
  for (const candidate of [dispatch?.title, dispatch?.topic]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return cut(candidate.replace(/\s+/g, ' '), 120)
  }
  const task = String(dispatch?.task ?? '').replace(/\s+/g, ' ').trim()
  return task === '' ? '（未命名派工）' : cut(task, 60)
}

/** A report's label: its own, else the first line of its summary. */
function reportLabel(report) {
  if (typeof report?.label === 'string' && report.label.trim() !== '') return cut(report.label.replace(/\s+/g, ' '), 120)
  const first = String(report?.summary ?? '').split('\n').find((line) => line.trim() !== '') ?? ''
  return cut(first.trim(), 80)
}

/**
 * One running dispatch in the seed, at one of four levels:
 *
 *   0  full: brief, later instructions, the worker's latest words
 *   1  brief cut to 3,000 characters plus a pointer (the entry ran over seedRunningMaxChars)
 *   2  heading, brief cut to 2,000 characters, pointer (the seed ran over seedBudgetChars)
 *   3  heading and pointer only
 */
function renderRunning(entry, level, now) {
  const workspace = entry.workspaceTitle ?? entry.workspaceId ?? ''
  const started = Date.parse(entry.startedAt ?? '')
  const minutes = Number.isFinite(started) ? Math.max(0, Math.round((now.getTime() - started) / 60_000)) : undefined
  const heading = [
    `### [${workspace}] ${runningLabel(entry)} — worker ${entry.workerSessionId}，${entry.dispatchId}`,
    Number.isFinite(started) ? `，派出于 ${shortMinute(started)}，已 ${minutes} 分钟` : '',
  ].join('')
  const pointer = `完整 brief 在 worker 会话 ${entry.workerSessionId} 的第一条消息。`
  const brief = String(entry.brief ?? '').trim()
  const lines = [heading]
  if (Number.isFinite(entry.lastInputTokens)) lines.push(`- worker 当前上下文：${count(entry.lastInputTokens)} token`)
  if (level >= 3) {
    lines.push(pointer)
    return lines.join('\n')
  }
  lines.push('#### brief（原文）')
  if (brief === '') lines.push('（未能从 worker 会话读出 brief）')
  else if (level === 0) lines.push(brief)
  else lines.push(cut(brief, level === 1 ? BRIEF_TRIMMED : BRIEF_REDUCED), pointer)
  if (level >= 2) return lines.join('\n')
  const instructions = (entry.instructions ?? []).filter((text) => String(text).trim() !== '').slice(-INSTRUCTIONS_KEPT)
  if (instructions.length > 0) {
    lines.push(`#### 之后追加的指令（最近 ${instructions.length} 条，各 ≤1,500 字符）`)
    instructions.forEach((text, index) => lines.push(`${index + 1}. ${cut(text, EXCHANGE_MAX)}`))
  }
  if (String(entry.latestStatus ?? '').trim() !== '') {
    lines.push('#### worker 最近一次说的话（≤800 字符）', cut(entry.latestStatus, STATUS_MAX))
  }
  return lines.join('\n')
}

function renderCompleted(report) {
  const workspace = report.workspaceTitle ?? report.workspaceId ?? ''
  const outcome = report.outcome ?? report.status ?? ''
  const lines = [
    `### [${workspace}] ${reportLabel(report)} — ${outcome} · ${shortMinute(report.reportedAt)} · report ${report.id}`,
    cut(report.summary, 1200),
  ]
  const headings = sectionHeadings(String(report.document ?? '')).slice(0, 6).map((heading) => heading.title)
  if (headings.length > 0) lines.push(`章节：${headings.join('、')}`)
  return lines.join('\n')
}

/**
 * The seed text of a new segment. Pure (`now` is an input).
 *
 * @param input.previousSessionId - the segment that ends.
 * @param input.segment           - the new segment's number (2 for the first rotation).
 * @param input.reason            - shouldRotate's reason, or 'manual'.
 * @param input.stats             - sessionStats of the ending segment.
 * @param input.running           - running dispatches, each a dispatch record plus
 *                                  runningDispatchContext's fields; oldest first.
 * @param input.completed         - the latest terminal report per dispatch, newest first.
 * @param input.indexes           - `{ workspaceTitle, workspaceId, count, path }` per workspace with reports.
 * @param input.lastExchange      - `{ human, assistant }`.
 * @param input.config            - ROTATION_DEFAULTS keys.
 * @returns the Markdown seed, at most `seedBudgetChars` characters.
 */
export function buildSeed({
  previousSessionId,
  segment,
  reason,
  stats = {},
  running = [],
  completed = [],
  indexes = [],
  lastExchange = {},
  config = ROTATION_DEFAULTS,
  now = new Date(),
} = {}) {
  const resolved = { ...ROTATION_DEFAULTS, ...config }
  const done = completed.slice(0, resolved.seedCompleted)
  const ordered = [...running].sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')))

  const head = [
    `${PUSH_PREFIXES.rotation}自律鲸鱼主会话第 ${Number.isInteger(segment) ? segment : '?'} 段。上一段 ${previousSessionId} 已存档（原因：${REASON_TEXT[reason] ?? reason}；压缩 ${count(stats.compactions ?? 0)} 次 / 输入 ${count(stats.lastInputTokens ?? 0)} token）。`,
    '用户画像（USER 偏好与 Now、SOUL、MEMORY）和活跃工作区便签已在系统提示里，不用复述。',
  ].join('\n')
  const completedPart = [
    `## 最近完成的 ${done.length} 次派工`,
    ...(done.length === 0 ? ['（暂无）'] : done.map(renderCompleted)),
  ].join('\n\n')
  const indexPart = [
    '## 更早的工作',
    ...(indexes.length === 0
      ? ['（暂无报告）']
      : indexes.map(
          (index) =>
            `- ${index.workspaceTitle ?? index.workspaceId}：${index.count} 份 → ${index.path}，或 read_report(mode:"index", workspace:"${index.workspaceTitle ?? index.workspaceId}")`,
        )),
  ].join('\n')
  const exchangePart = [
    '## 上一段的最后一轮',
    `- 用户：${cut(lastExchange.human, EXCHANGE_MAX) || '（无）'}`,
    `- 你：${cut(lastExchange.assistant, EXCHANGE_MAX) || '（无）'}`,
  ].join('\n')
  const tail = `只回一行：「已续接：${ordered.length} 个进行中派工、最近 ${done.length} 次交付已带上。」然后等用户。`

  // Each running entry starts at the richest level that fits its own budget.
  const levels = ordered.map((entry) => (charLength(renderRunning(entry, 0, now)) <= resolved.seedRunningMaxChars ? 0 : 1))
  const assemble = () => {
    const runningPart = [
      '## 进行中的派工（完整上下文）',
      ...(ordered.length === 0 ? ['（无）'] : ordered.map((entry, index) => renderRunning(entry, levels[index], now))),
    ].join('\n\n')
    return [head, runningPart, completedPart, indexPart, exchangePart, tail].join('\n\n')
  }
  // Over the total budget: cut entries down, the earliest dispatched first.
  let text = assemble()
  for (const floor of [2, 3]) {
    for (let index = 0; index < ordered.length && charLength(text) > resolved.seedBudgetChars; index += 1) {
      if (levels[index] >= floor) continue
      levels[index] = floor
      text = assemble()
    }
  }
  return charLength(text) <= resolved.seedBudgetChars ? text : cut(text, resolved.seedBudgetChars)
}

/* ------------------------------------------------------------------ *
 * reading the facts
 * ------------------------------------------------------------------ */

/**
 * One running dispatch's full context, read from the worker's own Session log.
 *
 *   brief           the first `user/message` that carries every BRIEF_MARKERS marker
 *   instructions    later `user/message` texts with `source.kind === 'user'`, in order
 *   latestStatus    the worker's latest assistant text
 *   lastInputTokens `usage.inputTokens` of its latest assistant message
 *
 * A Session that cannot be inspected yields empty fields.
 */
export async function runningDispatchContext(sessionController, checkpoint, signal = new AbortController().signal) {
  const context = { brief: '', instructions: [], latestStatus: '', lastInputTokens: undefined }
  let events = []
  try {
    const inspected = await sessionController?.inspect?.(checkpoint?.workerSessionId, signal)
    if (Array.isArray(inspected?.events)) events = inspected.events
  } catch {
    return context
  }
  let briefSeen = false
  for (const event of events) {
    if (event?.type === 'user/message') {
      const text = messageText(event.data).trim()
      if (!briefSeen) {
        if (BRIEF_MARKERS.every((marker) => text.includes(marker))) {
          context.brief = text
          briefSeen = true
        }
      } else if (event.data?.source?.kind === 'user' && text !== '') {
        context.instructions.push(text)
      }
    } else if (event?.type === 'assistant/message') {
      const tokens = inputTokensOf(event)
      if (tokens !== undefined) context.lastInputTokens = tokens
      const text = assistantText(event)
      if (text !== '') context.latestStatus = text
    }
  }
  return context
}

/** Every report on disk, across all workspace folders. */
async function allReports(root) {
  let entries
  try {
    entries = await readdir(join(dataDir(root), REPORTS_DIRNAME), { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const reports = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const report of await listReports(root, entry.name).catch(() => [])) {
      reports.push({ ...report, workspaceId: report.workspaceId ?? entry.name })
    }
  }
  return reports
}

/** The latest terminal report per dispatch, newest first. */
function latestDeliveries(reports) {
  const latest = new Map()
  for (const report of reports) {
    if (!TERMINAL.has(report?.status)) continue
    const known = latest.get(report.dispatchId)
    if (known === undefined || String(report.reportedAt ?? '') >= String(known.reportedAt ?? '')) latest.set(report.dispatchId, report)
  }
  return [...latest.values()].sort((left, right) => String(right.reportedAt ?? '').localeCompare(String(left.reportedAt ?? '')))
}

/** Dispatches without an answer yet: checkpoints ∪ the registry, oldest first. */
async function runningDispatches(root, registry, reports) {
  const answered = new Set(reports.filter((report) => TERMINAL.has(report?.status)).map((report) => report.dispatchId))
  const byId = new Map()
  for (const record of await listDispatchCheckpoints(root)) byId.set(record.dispatchId, record)
  for (const record of registry?.listDispatches?.() ?? []) byId.set(record.dispatchId, { ...byId.get(record.dispatchId), ...record })
  return [...byId.values()]
    .filter(
      (record) =>
        typeof record?.workerSessionId === 'string' &&
        !answered.has(record.dispatchId) &&
        record.status !== 'reported' &&
        record.status !== 'abandoned' &&
        !isDispatchAbandoned(root, record.workerSessionId),
    )
    .sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')))
}

/** One index pointer per workspace with reports, the most recently reported first. */
function indexPointers(root, reports) {
  const byWorkspace = new Map()
  for (const report of reports) {
    const known = byWorkspace.get(report.workspaceId)
    if (known === undefined) {
      byWorkspace.set(report.workspaceId, { workspaceId: report.workspaceId, workspaceTitle: report.workspaceTitle, count: 1, latest: String(report.reportedAt ?? '') })
    } else {
      known.count += 1
      if (String(report.reportedAt ?? '') > known.latest) known.latest = String(report.reportedAt ?? '')
      known.workspaceTitle ??= report.workspaceTitle
    }
  }
  return [...byWorkspace.values()]
    .sort((left, right) => right.latest.localeCompare(left.latest))
    .map(({ workspaceId, workspaceTitle, count: total }) => ({ workspaceId, workspaceTitle, count: total, path: reportIndexPath(root, workspaceId) }))
}

/* ------------------------------------------------------------------ *
 * the rotation
 * ------------------------------------------------------------------ */

/** Take `rotation.lock`; a lock older than ROTATION_LOCK_STALE_MS is taken over. */
async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    try {
      const info = await stat(path)
      if (Date.now() - info.mtimeMs <= ROTATION_LOCK_STALE_MS) return false
      await rm(path, { force: true })
    } catch {
      // Gone between the open and the stat: the next attempt takes it.
    }
  }
  return false
}

async function renameQuietly(sessionController, sessionId, title) {
  try {
    await sessionController.rename({ sessionId, title })
  } catch {
    // A missing title only changes how the session is listed.
  }
}

/**
 * Deliver the seed: a notice through the new agent's `followup`, else a queued
 * prompt. Returns the path that worked, or undefined when both failed.
 */
async function deliverSeed({ sessionController, agents, sessionId, seed, summary, warn }) {
  try {
    const agent = agents?.get?.(sessionId)
    if (typeof agent?.followup === 'function') {
      agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: seed }], source: { ...ROTATION_SOURCE, summary } })
      return 'followup'
    }
  } catch (error) {
    warn(`seed followup to ${sessionId} failed: ${error?.message ?? error}`)
  }
  try {
    await sessionController.prompt(
      { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: seed }] },
      new AbortController().signal,
    )
    return 'prompt'
  } catch (error) {
    warn(`seed prompt to ${sessionId} failed: ${error?.message ?? error}`)
    return undefined
  }
}

/** `<whale home>/rotations/<sessionId>.md` and its path relative to the data directory. */
export function seedFilePath(root, sessionId) {
  return {
    absolute: join(whaleHomeDir(root), ROTATIONS_DIRNAME, `${sessionId}.md`),
    relative: `home/${ROTATIONS_DIRNAME}/${sessionId}.md`,
  }
}

/**
 * Rotate the main session `oldSessionId`. The steps run in this order:
 *
 *    1. take `rotation.lock` (busy → `{ skipped: 'busy' }`)
 *    2. `state.mainSessionId` must still be `oldSessionId` (else `'not-current'`)
 *    3. automatic path: `flush()`, at most 60 s; the agent must still be idle (else `'not-idle'`)
 *    4. collect running dispatches, reports and index pointers; build the seed
 *    5. create the new main session in the whale home and title it
 *    6. deliver the seed: `agents.get(id).followup(notice)`, else `sessionController.prompt`
 *    7. write the seed file and `state.json` (`mainSessionId` + a `lineage` entry)
 *    8. retarget checkpoints and registry records from the old session to the new one
 *    9. rename the old session as archived
 *   10. release the lock and log one line
 *
 * A failed create, a seed neither path could deliver, or a failed state write
 * leaves `state.json` on the old segment and starts a 10-minute cooldown for
 * automatic attempts; a new session that did not become the main session is
 * titled「自律鲸鱼 · 续接失败」. The manual path
 * (`reason: 'manual'`, no `flush`) runs the same steps without the flush and
 * the cooldown.
 *
 * @returns `{ newSessionId, seedFile, running, completed, seedChars }` or `{ skipped, error? }`.
 */
export async function rotateMain({
  sessionController,
  agents,
  oldSessionId,
  reason,
  stats = sessionStats([]),
  root = storeRoot(),
  flush,
  registry = { listDispatches, dispatches },
  logger,
  agent,
  config = ROTATION_DEFAULTS,
  now = () => new Date(),
} = {}) {
  const warn = (message) => logger?.warn?.(`discipline-whale rotation: ${message}`)
  const automatic = reason !== 'manual'
  if (automatic && now().getTime() < cooldownUntil) return { skipped: 'cooldown' }
  const coolDown = () => {
    if (automatic) cooldownUntil = now().getTime() + ROTATION_COOLDOWN_MS
  }

  // 1. One rotation at a time, across rows and processes.
  const lock = rotationLockPath(root)
  if (!(await acquireLock(lock))) return { skipped: 'busy' }
  try {
    // 2. Only the current segment rotates.
    const state = await readState(root)
    if (state.mainSessionId !== oldSessionId) return { skipped: 'not-current' }

    // 3. Memory first, then make sure the segment is still at rest.
    if (typeof flush === 'function') {
      await Promise.race([
        Promise.resolve().then(flush).catch(() => undefined),
        sleep(ROTATION_FLUSH_WAIT_MS, undefined, { ref: false }),
      ])
      const current = agent ?? agents?.get?.(oldSessionId)
      if (current !== undefined && current.status !== 'idle') return { skipped: 'not-idle' }
    }

    // 4. Facts and seed.
    const signal = new AbortController().signal
    const reports = await allReports(root)
    const running = []
    for (const record of await runningDispatches(root, registry, reports)) {
      running.push({ ...record, ...(await runningDispatchContext(sessionController, record, signal)) })
    }
    const completed = latestDeliveries(reports).slice(0, config.seedCompleted ?? ROTATION_DEFAULTS.seedCompleted)
    const lineage = Array.isArray(state.lineage) ? state.lineage : []
    const at = now()
    const seed = buildSeed({
      previousSessionId: oldSessionId,
      segment: lineage.length + 2,
      reason,
      stats,
      running,
      completed,
      indexes: indexPointers(root, reports),
      lastExchange: { human: stats.lastHumanText, assistant: stats.lastAssistantText },
      config,
      now: at,
    })
    const summary = `主会话已续接 · ${running.length} 个进行中派工 · 最近 ${completed.length} 次交付`

    // 5. The new segment.
    let newSessionId
    try {
      const created = await sessionController.create({ cwd: whaleHomeDir(root), agentPreset: MAIN_PRESET })
      newSessionId = String(created.sessionId)
    } catch (error) {
      coolDown()
      warn(`could not create the next main session: ${error?.message ?? error}`)
      return { skipped: 'create-failed', error: String(error?.message ?? error) }
    }
    await renameQuietly(sessionController, newSessionId, MAIN_TITLE)

    // 6. The seed wakes it.
    const delivered = await deliverSeed({ sessionController, agents, sessionId: newSessionId, seed, summary, warn })
    if (delivered === undefined) {
      coolDown()
      await renameQuietly(sessionController, newSessionId, `${MAIN_TITLE} · 续接失败`)
      warn(`the seed reached neither path; ${oldSessionId} stays the main session`)
      return { skipped: 'deliver-failed', newSessionId }
    }

    // 7. Record the new segment.
    const seedFile = seedFilePath(root, newSessionId)
    try {
      await mkdir(dirname(seedFile.absolute), { recursive: true })
      await writeFile(seedFile.absolute, `${seed}\n`, 'utf8')
      const latest = await readState(root)
      await writeState(
        {
          mainSessionId: newSessionId,
          lineage: [
            ...(Array.isArray(latest.lineage) ? latest.lineage : []),
            {
              sessionId: oldSessionId,
              successor: newSessionId,
              endedAt: at.toISOString(),
              reason,
              lastInputTokens: stats.lastInputTokens ?? 0,
              compactions: stats.compactions ?? 0,
              seedFile: seedFile.relative,
            },
          ],
        },
        root,
      )
    } catch (error) {
      coolDown()
      await renameQuietly(sessionController, newSessionId, `${MAIN_TITLE} · 续接失败`)
      warn(`could not record ${newSessionId} in state.json: ${error?.message ?? error}`)
      return { skipped: 'state-failed', newSessionId, error: String(error?.message ?? error) }
    }

    // 8. Pending dispatches now answer to the new segment.
    //
    // This retarget is a convenience, not the correctness guarantee. The worker
    // row runs in its own plugin instance with its own in-memory dispatch, so it
    // can write a checkpoint naming the OLD segment back to disk after this loop
    // ran (observed in production: the manual rotation at 03:10:13Z retargeted,
    // and at 03:10:54Z one still-running dispatch's checkpoint named the old
    // segment again). Nothing breaks, because every reader resolves the recorded
    // id through the append-only `state.lineage` — `currentMainFor` in the
    // worker's push path and `resolveMainTarget` behind it. The cost of a stale
    // field is one extra lineage lookup per report; the moment it would matter
    // is a truncated lineage, which `recentLineage` does only on the HTTP
    // response and never on disk. `test/rotation.mjs` ok 9 pins this: a
    // write-back of the old segment still delivers to the new one, two
    // rotations deep.
    for (const record of await listDispatchCheckpoints(root)) {
      if (record.mainSessionId !== oldSessionId) continue
      await writeDispatchCheckpoint(root, record.workerSessionId, { ...record, mainSessionId: newSessionId }).catch((error) =>
        warn(`could not retarget the checkpoint of ${record.workerSessionId}: ${error?.message ?? error}`),
      )
    }
    for (const record of registry?.dispatches?.values?.() ?? []) {
      if (record.mainSessionId === oldSessionId) record.mainSessionId = newSessionId
    }

    // 9. Archive the old segment.
    await renameQuietly(sessionController, oldSessionId, `${MAIN_TITLE} · 存档 ${shortMinute(at)}`)

    // 10. One line for the operator.
    const seedChars = charLength(seed)
    logger?.info?.(
      `discipline-whale rotation: ${oldSessionId} → ${newSessionId} (${reason}, input ${stats.lastInputTokens ?? 0}, compactions ${stats.compactions ?? 0}, seed ${seedChars} chars, running ${running.length})`,
    )
    return { newSessionId, seedFile: seedFile.relative, running: running.length, completed: completed.length, seedChars, delivered }
  } finally {
    await rm(lock, { force: true }).catch(() => {})
  }
}
