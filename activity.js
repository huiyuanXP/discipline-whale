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

/**
 * Workspace colors: eight Morandi hues — low saturation, greyed, never red.
 *
 * WHY MORANDI AND NOT TAILWIND. Two constraints decided this set:
 *
 *   1. NO RED, NO ORANGE. Red is the harness's own warning color, so a red
 *      folder would read as "this workspace is broken" when nothing is wrong.
 *      The old set carried #EF4444 (red, saturation 0.79) and two oranges
 *      (#F59E0B, #F97316); #F59E0B is also the color that forced the folder
 *      title mix down to 60% to clear AA on white.
 *   2. EVERY COLOR MUST BE READABLE IN BOTH THEMES, both as the mixed title
 *      and as the raw swatch. The sidebar paints the title as
 *      `color-mix(<hue> 60%, <theme label>)`, but the menu chips and the whale
 *      logo are painted in the raw color, so the raw value has to clear the 3:1
 *      graphic bar on a white sidebar AND on a near-black one. That brackets
 *      each color's relative luminance to a narrow band, which is why these
 *      read quieter than a "designer grey" would.
 *
 * Measured in a real Chromium against the live tokens (label rgb(15,17,21) on
 * light, rgb(249,250,251) on dark; sidebar fill rgb(249,250,251) / rgb(21,21,23))
 * by letting Chromium resolve the same color-mix() the stylesheet uses:
 * title 7.54-7.62:1, folder glyph 5.59-5.66:1, raw swatch 3.96-4.41:1 — all
 * clearing their bars with room to spare. `test/palette-morandi.mjs` pins the
 * hue ban, the saturation band and those ratios, so a later edit fails there
 * instead of in the sidebar.
 *
 * KEEP THE EIGHT IN THIS ORDER: `defaultColor` hashes a workspace id into a
 * slot, so reordering reassigns the colors of workspaces that never chose one.
 */
export const PALETTE = ['#6E7E91', '#678187', '#63827E', '#648371', '#668364', '#748162', '#8F7398', '#81779D']

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

/**
 * The palette this plugin shipped BEFORE the Morandi change, in slot order.
 *
 * It exists only to recognize colors already stored in `workspaces.json`; no
 * new code path may assign one of these. `morandiForLegacy` maps a slot to the
 * Morandi color at the SAME index, so migration preserves the user's intent
 * ("my API workspace is the blue one") instead of picking a new relative hue.
 */
export const LEGACY_PALETTE = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316']

/**
 * The Morandi color that replaces a legacy palette slot, or null.
 *
 * Null means "not a legacy palette member", which includes every custom hex a
 * user typed and every color that is already Morandi. Returning null rather
 * than a fallback is the point: a color this function does not recognize must
 * never be rewritten.
 *
 * @param {unknown} color
 * @returns {string | null}
 */
export function morandiForLegacy(color) {
  if (typeof color !== 'string') return null
  const index = LEGACY_PALETTE.findIndex((legacy) => legacy.toLowerCase() === color.toLowerCase())
  return index === -1 ? null : PALETTE[index]
}

/**
 * Which stored workspace colors the Morandi change would replace, and with what.
 *
 * A PLAN, not a write: the caller shows this to the user (or logs it), because
 * silently repainting a color somebody picked is exactly what this change must
 * not do. Only exact legacy palette members are candidates — a custom hex and
 * an already-Morandi color are not.
 *
 * @param {Record<string, { color?: string }>} cards from {@link readWorkspaceCards}
 * @returns {{ id: string, from: string, to: string }[]}
 */
export function planColorMigration(cards) {
  if (cards === null || typeof cards !== 'object') return []
  const plan = []
  for (const [id, card] of Object.entries(cards)) {
    const from = typeof card?.color === 'string' ? card.color : undefined
    const to = morandiForLegacy(from)
    if (to !== null) plan.push({ id, from, to })
  }
  return plan
}

/**
 * Apply the Morandi color migration to `workspaces.json`.
 *
 * DRY RUN BY DEFAULT (`apply: false`). With `apply: true` it rewrites only the
 * cards named by {@link planColorMigration} and leaves every other field and
 * every other card exactly as it found them — a user's custom color, their
 * intros and their `updatedAt` all survive.
 *
 * @param {string} homeDir DSH root
 * @param {{ apply?: boolean }} [options]
 * @returns {Promise<{ changed: { id: string, from: string, to: string }[], applied: boolean }>}
 */
export async function applyColorMigration(homeDir, { apply = false } = {}) {
  const cards = await readWorkspaceCards(homeDir)
  const changed = planColorMigration(cards)
  if (changed.length === 0 || !apply) return { changed, applied: false }
  await updateAllCards(homeDir, (all) => {
    for (const row of changed) {
      const card = all[row.id]
      if (card === undefined) continue
      all[row.id] = { ...card, color: row.to }
    }
    return all
  })
  return { changed, applied: true }
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

/**
 * Read-modify-write the whole cards file under the per-file chain.
 *
 * Separate from {@link updateCard} because a migration touches several cards in
 * one write: doing it as N single-card writes would rewrite the file N times
 * and, if one failed midway, leave the store half-migrated.
 *
 * @param {string} homeDir DSH root
 * @param {(cards: Record<string, object>) => Record<string, object>} change
 * @returns {Promise<Record<string, object>>} the written map
 */
function updateAllCards(homeDir, change) {
  const path = statePath(homeDir, 'workspaces.json')
  return serialized(path, async () => {
    const cards = await loadCards(homeDir, true)
    const next = change({ ...cards })
    await atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`)
    return next
  })
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
