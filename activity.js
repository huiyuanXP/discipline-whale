/**
 * discipline-whale — the Activity layer: what the user is working on right now.
 *
 * Four parts, all derived from state the plugin already owns:
 *
 *   workspace cards  one short intro and one color per registered workspace,
 *                    stored in `<dataDir>/memory-state/workspaces.json`
 *   conversations    one entry per dispatched worker session, split into
 *                    running and recently ended, derived purely from dispatch
 *                    records and reports
 *   tags             which user message led to which workspace, stored in the
 *                    append-only `<dataDir>/memory-state/tags.jsonl`
 *   bootstrap        the `## 工作区背景` block placed in front of a new worker's
 *                    task: intro, recent user words, recent report summaries
 *
 * Every rendered line is an entry in the shared bullet format (`entry.js`), and
 * every render function is deterministic: the same state gives the same text.
 *
 * @module discipline-whale/activity
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { atomicWrite, charLength, clip, formatEntry, isoDay } from './entry.js'
import { dataDir } from './store.js'

/** Directory under the plugin data directory that holds memory state files. */
export const STATE_DIRNAME = 'memory-state'

/** Longest workspace intro, in code points. */
export const INTRO_MAX = 200

/** Total budget of one bootstrap block, in code points. */
export const BOOTSTRAP_BUDGET = 3000

/** Longest running-conversation entry text, in code points. */
const RUNNING_MAX = 240

/** Report statuses that end a dispatch. */
const TERMINAL = new Set(['reported', 'delivered', 'abandoned'])

/** Placeholder shown for a workspace that has no intro yet. */
const NO_INTRO = '（待补充）'

/** Workspace colors: eight distinct, readable hues. */
export const PALETTE = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316']

/** Per-path promise chains that serialize read-modify-write cycles inside this process. */
const chains = new Map()

/** Run `task` after every earlier task queued for `key` has settled. */
function serialized(key, task) {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.catch(() => {})
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

/** `<dataDir>/memory-state/<name>`. */
function statePath(homeDir, name) {
  return join(dataDir(homeDir), STATE_DIRNAME, name)
}

/**
 * Stable color for a workspace: an FNV-1a hash of the id picks a palette slot.
 *
 * @param {string} workspaceId
 * @returns {string} a `#RRGGBB` palette entry
 */
export function defaultColor(workspaceId) {
  let hash = 0x811c9dc5
  for (const char of String(workspaceId)) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

/** Load the cards file. `strict` rethrows a corrupt file so a writer never overwrites it. */
async function loadCards(homeDir, strict) {
  let text
  try {
    text = await readFile(statePath(homeDir, 'workspaces.json'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (strict) throw new Error(`workspaces.json is not valid JSON: ${error.message}`)
    return {}
  }
}

/**
 * Read every workspace card.
 *
 * @param {string} homeDir DSH root
 * @returns {Promise<Record<string, {intro: string, color: string, updatedAt?: string}>>}
 *   `{}` when the file is missing or unreadable
 */
export async function readWorkspaceCards(homeDir) {
  return loadCards(homeDir, false)
}

/** Read-modify-write one card under the per-file chain. */
function updateCard(homeDir, workspaceId, change) {
  const path = statePath(homeDir, 'workspaces.json')
  return serialized(path, async () => {
    const cards = await loadCards(homeDir, true)
    const existing = cards[workspaceId] ?? {}
    const card = change({ ...existing })
    cards[workspaceId] = card
    await atomicWrite(path, `${JSON.stringify(cards, null, 2)}\n`)
    return card
  })
}

/**
 * Set a workspace's intro: purpose, current work and next step in ≤200 characters.
 *
 * @param {string} homeDir DSH root
 * @param {string} workspaceId
 * @param {string} intro trimmed before storing
 * @param {{ now?: Date }} [options] `now` stamps `updatedAt` (local day)
 * @returns {Promise<{intro: string, color: string, updatedAt: string}>} the stored card
 * @throws when the intro is empty or longer than 200 code points
 */
export async function setWorkspaceIntro(homeDir, workspaceId, intro, { now = new Date() } = {}) {
  const text = String(intro ?? '').trim()
  if (text === '') throw new Error('intro is empty; write the workspace purpose, current work and next step in ≤200 characters')
  const length = charLength(text)
  if (length > INTRO_MAX) {
    throw new Error(
      `intro is ${length} characters; shorten it to ≤${INTRO_MAX} characters (purpose + current work + next step) and call again`,
    )
  }
  return updateCard(homeDir, workspaceId, (card) => ({
    ...card,
    intro: text,
    color: card.color ?? defaultColor(workspaceId),
    updatedAt: isoDay(now),
  }))
}

/**
 * Set a workspace's color.
 *
 * @param {string} homeDir DSH root
 * @param {string} workspaceId
 * @param {string} color `#RRGGBB`
 * @returns {Promise<{intro: string, color: string, updatedAt?: string}>} the stored card
 * @throws when the color is not a `#RRGGBB` hex string
 */
export async function setWorkspaceColor(homeDir, workspaceId, color) {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new Error(`color must be a #RRGGBB hex string, got ${JSON.stringify(color)}`)
  }
  return updateCard(homeDir, workspaceId, (card) => ({ ...card, intro: card.intro ?? '', color }))
}

/**
 * Render the `## 工作区` block: one bullet per workspace, registry order.
 *
 * @param {{ id: string, title?: string, path?: string }[]} workspaces registry list items
 * @param {Record<string, {intro?: string, updatedAt?: string}>} cards from {@link readWorkspaceCards}
 * @returns {string} Markdown, or '' when there are no workspaces
 */
export function renderWorkspaces(workspaces, cards = {}) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return ''
  const lines = workspaces.map((workspace) => {
    const card = cards?.[workspace.id]
    const intro = typeof card?.intro === 'string' && card.intro.trim() !== '' ? card.intro.trim() : NO_INTRO
    return formatEntry({
      text: `${workspace.title ?? workspace.id} · ${intro}`,
      meta: { id: workspace.id, updated: card?.updatedAt },
    })
  })
  return `## 工作区\n${lines.join('\n')}`
}

/** `YYYY-MM-DD HH:mm` in local time, or '' for an unparseable value. */
function localMinute(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${isoDay(date)} ${hh}:${mm}`
}

/** `YYYY-MM-DD` in local time, or '' for an unparseable value. */
function localDay(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : isoDay(date)
}

/** First eight characters of a worker session id, without a leading `session-` prefix. */
function shortId(sessionId) {
  return Array.from(String(sessionId ?? '').replace(/^session[-_]/, '')).slice(0, 8).join('')
}

/** A dispatch's title, else its topic; '' when neither is set. */
function namedLabel(dispatch) {
  for (const candidate of [dispatch?.title, dispatch?.topic]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return clip(candidate, 120)
  }
  return ''
}

/** What a running dispatch is about: title, else topic, else the first 60 characters of the task. */
function dispatchLabel(dispatch) {
  return namedLabel(dispatch) || clip(dispatch?.task ?? '', 60)
}

/**
 * Derive conversation entries from dispatch records and reports. Pure.
 *
 * A dispatch is running when no terminal report (reported / delivered /
 * abandoned) exists for its id and the record itself is not abandoned or
 * reported. History holds the latest terminal report per dispatch, newest first.
 *
 * @param {{ dispatches?: object[], reports?: object[] }} input
 * @returns {{ running: {text: string, meta: object}[], history: {text: string, meta: object}[] }}
 */
export function conversationEntries({ dispatches = [], reports = [] } = {}) {
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.dispatchId, dispatch]))
  const latest = new Map()
  for (const report of reports) {
    if (!TERMINAL.has(report?.status)) continue
    const known = latest.get(report.dispatchId)
    if (known === undefined || String(report.reportedAt ?? '') >= String(known.reportedAt ?? '')) {
      latest.set(report.dispatchId, report)
    }
  }

  const running = dispatches
    .filter(
      (dispatch) =>
        !latest.has(dispatch.dispatchId) &&
        dispatch.abandoned !== true &&
        dispatch.status !== 'abandoned' &&
        dispatch.status !== 'reported',
    )
    .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
    .map((dispatch) => {
      const prefix = `[${dispatch.workspaceTitle ?? dispatch.workspaceId ?? ''}] `
      const suffix = ' — 进行中'
      const room = RUNNING_MAX - charLength(prefix) - charLength(suffix)
      return {
        text: `${prefix}${clip(dispatchLabel(dispatch), Math.max(1, room))}${suffix}`,
        meta: {
          session: shortId(dispatch.workerSessionId),
          dispatch: dispatch.dispatchId,
          started: localMinute(dispatch.startedAt),
        },
      }
    })

  const history = [...latest.values()]
    .sort((left, right) => String(right.reportedAt ?? '').localeCompare(String(left.reportedAt ?? '')))
    .map((report) => {
      const label = namedLabel(dispatchById.get(report.dispatchId))
      const outcome = report.outcome ?? report.status
      return {
        text: `[${report.workspaceTitle ?? report.workspaceId ?? ''}] ${label === '' ? '' : `${label} — `}${outcome}：${clip(report.summary, 120)}`,
        meta: { report: report.id, ended: localDay(report.reportedAt) },
      }
    })

  return { running, history }
}

/**
 * How many ended conversations to show: `max(5, ceil(running * 0.4))`.
 *
 * @param {number} runningCount
 * @returns {number}
 */
export function historyCount(runningCount) {
  return Math.max(5, Math.ceil(runningCount * 0.4))
}

/**
 * Render the two conversation blocks. A block with no entries is omitted.
 *
 * @param {{ running: object[], history: object[] }} entries from {@link conversationEntries}
 * @returns {string} Markdown, or '' when both lists are empty
 */
export function renderConversations({ running = [], history = [] } = {}) {
  const blocks = []
  if (running.length > 0) blocks.push(`## 正在进行的对话\n${running.map(formatEntry).join('\n')}`)
  const shown = history.slice(0, historyCount(running.length))
  if (shown.length > 0) blocks.push(`## 最近结束的对话\n${shown.map(formatEntry).join('\n')}`)
  return blocks.join('\n\n')
}

/** Append one JSON line to `tags.jsonl`. */
async function appendTagLine(homeDir, record) {
  const path = statePath(homeDir, 'tags.jsonl')
  await mkdir(join(dataDir(homeDir), STATE_DIRNAME), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Record one user turn (first 200 characters of its text).
 *
 * @param {string} homeDir DSH root
 * @param {{ sessionId: string, turn: number, messageId?: string, text: string, at?: string }} turn
 */
export async function recordUserTurn(homeDir, { sessionId, turn, messageId, text, at }) {
  await appendTagLine(homeDir, {
    kind: 'turn',
    sessionId,
    turn,
    messageId,
    at: at ?? new Date().toISOString(),
    text: clip(text, 200),
  })
}

/**
 * Tag a user turn with the workspace (and dispatch) it was routed to.
 * A turn that dispatches to several workspaces is tagged once per workspace.
 *
 * @param {string} homeDir DSH root
 * @param {{ sessionId: string, turn: number, workspaceId: string, dispatchId?: string, at?: string }} tag
 */
export async function tagTurn(homeDir, { sessionId, turn, workspaceId, dispatchId, at }) {
  await appendTagLine(homeDir, {
    kind: 'tag',
    sessionId,
    turn,
    workspaceId,
    dispatchId,
    at: at ?? new Date().toISOString(),
  })
}

/**
 * Read tagged turns, merged by `sessionId + turn`, in chronological order.
 *
 * A tag whose turn record is missing still yields a record with empty text.
 * Unparsable lines are skipped.
 *
 * @param {string} homeDir DSH root
 * @param {{ workspaceId?: string, limit?: number }} [options]
 * @returns {Promise<{sessionId: string, turn: number, messageId?: string, text: string, at: string, workspaces: string[], dispatches: string[]}[]>}
 */
export async function readTags(homeDir, { workspaceId, limit } = {}) {
  let text
  try {
    text = await readFile(statePath(homeDir, 'tags.jsonl'), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const merged = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object' || row.sessionId === undefined || row.turn === undefined) continue
    const key = `${row.sessionId}\u0000${row.turn}`
    let record = merged.get(key)
    if (record === undefined) {
      record = { sessionId: row.sessionId, turn: row.turn, messageId: undefined, text: '', at: undefined, workspaces: [], dispatches: [] }
      merged.set(key, record)
    }
    if (row.kind === 'turn') {
      record.messageId = row.messageId
      record.text = typeof row.text === 'string' ? row.text : ''
      record.at = row.at ?? record.at
    } else if (row.kind === 'tag') {
      if (typeof row.workspaceId === 'string' && !record.workspaces.includes(row.workspaceId)) record.workspaces.push(row.workspaceId)
      if (typeof row.dispatchId === 'string' && !record.dispatches.includes(row.dispatchId)) record.dispatches.push(row.dispatchId)
      record.at ??= row.at
    }
  }
  let records = [...merged.values()]
    .map((record, index) => ({ record, index }))
    .sort((left, right) => String(left.record.at ?? '').localeCompare(String(right.record.at ?? '')) || left.index - right.index)
    .map(({ record }) => ({ ...record, at: record.at ?? '' }))
  if (workspaceId !== undefined) records = records.filter((record) => record.workspaces.includes(workspaceId))
  if (Number.isInteger(limit) && limit >= 0) records = limit === 0 ? [] : records.slice(-limit)
  return records
}

/**
 * Build the `## 工作区背景` block for a new worker's brief.
 *
 * Holds the workspace intro, up to 8 recent tagged user messages and up to 3
 * recent report summaries, within 3,000 code points: oldest tags are dropped
 * first, then oldest reports.
 *
 * @param {string} homeDir DSH root
 * @param {{ workspace: { id: string, title?: string }, reports?: object[] }} input
 *   `reports` are the workspace's reports (any order)
 * @returns {Promise<string>} Markdown, or '' when there is nothing to say
 */
export async function buildBootstrap(homeDir, { workspace, reports = [] }) {
  const card = (await readWorkspaceCards(homeDir))[workspace.id]
  const intro = typeof card?.intro === 'string' ? card.intro.trim() : ''
  const introLine =
    intro === ''
      ? undefined
      : formatEntry({ text: `${workspace.title ?? workspace.id} · ${intro}`, meta: { updated: card.updatedAt } })

  const tags = (await readTags(homeDir, { workspaceId: workspace.id, limit: 8 }))
    .filter((tag) => tag.text !== '')
    .map((tag) => formatEntry({ text: clip(tag.text, 200), meta: { at: localDay(tag.at) } }))
  const recent = reports
    .filter((report) => report?.status !== 'pending' && typeof report?.summary === 'string')
    .sort((left, right) => String(right.reportedAt ?? '').localeCompare(String(left.reportedAt ?? '')))
    .slice(0, 3)
    .reverse()
    .map((report) =>
      formatEntry({ text: clip(report.summary, 300), meta: { report_id: report.id, ended: localDay(report.reportedAt) } }),
    )

  const render = () => {
    const parts = ['## 工作区背景']
    if (introLine !== undefined) parts.push(introLine)
    if (tags.length > 0) parts.push('### 用户最近说过', ...tags)
    if (recent.length > 0) parts.push('### 最近交付', ...recent)
    return parts.join('\n')
  }

  if (introLine === undefined && tags.length === 0 && recent.length === 0) return ''
  while (charLength(render()) > BOOTSTRAP_BUDGET && (tags.length > 0 || recent.length > 0)) {
    if (tags.length > 0) tags.shift()
    else recent.shift()
  }
  return render()
}
