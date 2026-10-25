/**
 * discipline-whale — the Activity layer: what the user is working on right now.
 *
 * Five parts, all derived from state the plugin already owns:
 *
 *   workspace cards  one short intro and one color per registered workspace,
 *                    stored in `<dataDir>/memory-state/workspaces.json`
 *   tags             the append-only `<dataDir>/memory-state/tags.jsonl`: a
 *                    `turn` row per human message, a `tag` row per workspace a
 *                    turn was dispatched to, a `mention` row per workspace a
 *                    human message names
 *   interest         which workspaces are active: every one with a running
 *                    dispatch, plus up to four touched within the last eight
 *                    human turns
 *   board and notes  the main session's runtime context lists the active
 *                    workspaces; each active one also gets a full note in
 *                    `<dataDir>/home/notes/<key>.md`, all derived from
 *                    dispatch records, reports and tags
 *   bootstrap        the `## 工作区背景` block placed in front of a new worker's
 *                    task: intro, recent user words, recent report summaries
 *
 * Every rendered line is an entry in the shared bullet format (`entry.js`), and
 * every render function is deterministic: the same state gives the same text.
 *
 * @module discipline-whale/activity
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { atomicWrite, charLength, clip, formatEntry, isoDay } from './entry.js'
import { isWhalePushText } from './pushes.js'
import { INDEX_DIRNAME, dataDir, whaleHomeDir, workspaceKey } from './store.js'

/** Directory under the plugin data directory that holds memory state files. */
export const STATE_DIRNAME = 'memory-state'

/** Longest workspace intro, in code points. */
export const INTRO_MAX = 200

/** Total budget of one bootstrap block, in code points. */
export const BOOTSTRAP_BUDGET = 3000

/** Size of `tags.jsonl` past which the memory row logs a warning. */
export const TAGS_WARN_BYTES = 1024 * 1024

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
  return namedLabel(dispatch) || clip(dispatch?.task ?? '', 60) || String(dispatch?.dispatchId ?? '')
}

/** First non-empty line of a summary, trimmed; '' when there is none. */
function firstLine(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((candidate) => candidate.trim() !== '')
  return (line ?? '').trim()
}

/** Milliseconds since the epoch, or undefined for a missing or unparseable value. */
function timeOf(value) {
  if (value === undefined || value === null || value === '') return undefined
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** `MM-DD HH:mm` in local time, or '' for an unparseable value. */
function boardMinute(value) {
  const full = localMinute(value)
  return full === '' ? '' : full.slice(5)
}

/**
 * Split dispatch records into running and ended. Pure.
 *
 * A dispatch is running when no terminal report (reported / delivered /
 * abandoned) exists for its id and the record itself is not abandoned or
 * reported. `ended` holds the latest terminal report per dispatch, newest
 * first; a report whose dispatch record is gone still counts.
 *
 * @param {{ dispatches?: object[], reports?: object[] }} input
 * @returns {{ running: object[], ended: object[] }} `running` newest first by `startedAt`
 */
export function dispatchState({ dispatches = [], reports = [] } = {}) {
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
  const ended = [...latest.values()].sort((left, right) =>
    String(right.reportedAt ?? '').localeCompare(String(left.reportedAt ?? '')),
  )
  return { running, ended }
}

/**
 * The human turns among `tags.jsonl` rows, oldest first. Pure.
 *
 * Only `kind: "turn"` rows count, and a row whose text opens with a push prefix
 * is a report, startup check, wake turn or rotation seed, not the user.
 *
 * @param {object[]} tags raw rows from {@link readTagRows}
 * @returns {object[]}
 */
export function humanTurns(tags = []) {
  return tags
    .filter((row) => row?.kind === 'turn' && !isWhalePushText(row.text) && timeOf(row.at) !== undefined)
    .map((row, index) => ({ row, index }))
    .sort((left, right) => timeOf(left.row.at) - timeOf(right.row.at) || left.index - right.index)
    .map(({ row }) => row)
}

/** workspace id -> latest touch in ms: tag and mention rows, reports, dispatch starts. */
function lastTouches({ tags = [], reports = [], dispatches = [] }) {
  const touches = new Map()
  const touch = (workspaceId, value) => {
    const ms = timeOf(value)
    if (workspaceId === undefined || workspaceId === null || ms === undefined) return
    const key = String(workspaceId)
    if (!(touches.get(key) >= ms)) touches.set(key, ms)
  }
  for (const row of tags) {
    if (row?.kind === 'tag' || row?.kind === 'mention') touch(row.workspaceId, row.at)
  }
  for (const report of reports) touch(report?.workspaceId, report?.reportedAt)
  for (const dispatch of dispatches) touch(dispatch?.workspaceId, dispatch?.startedAt)
  return touches
}

/**
 * Which workspaces the user is working on now. Pure.
 *
 * The window opens at the `windowTurns`-th most recent human turn (no window
 * while there are fewer). A workspace with a running dispatch is always
 * active; the rest fill up to `maxActive`, most recently touched first, from
 * those touched inside the window. A touch is a tag or mention row, a report's
 * `reportedAt` or a dispatch's `startedAt`. Running workspaces beyond
 * `maxActive` all stay.
 *
 * @param {{ workspaces?: object[], tags?: object[], reports?: object[], dispatches?: object[], windowTurns?: number, maxActive?: number }} input
 * @returns {{ active: object[], inactive: object[] }} `active` most recently
 *   touched first; `inactive` in registry order
 */
export function activeWorkspaces({ workspaces = [], tags = [], reports = [], dispatches = [], windowTurns = 8, maxActive = 4 } = {}) {
  const turns = humanTurns(tags)
  const size = Math.max(1, Math.floor(windowTurns))
  const windowStart = turns.length >= size ? timeOf(turns.at(-size).at) : -Infinity
  const touches = lastTouches({ tags, reports, dispatches })
  const runningIds = new Set(dispatchState({ dispatches, reports }).running.map((dispatch) => String(dispatch.workspaceId)))
  const ranked = workspaces
    .map((workspace, index) => ({ workspace, index, id: String(workspace.id), touch: touches.get(String(workspace.id)) }))
    .sort((left, right) => (right.touch ?? -Infinity) - (left.touch ?? -Infinity) || left.index - right.index)
  const chosen = new Set(ranked.filter((row) => runningIds.has(row.id)).map((row) => row.id))
  for (const row of ranked) {
    if (chosen.size >= maxActive) break
    if (!chosen.has(row.id) && row.touch !== undefined && row.touch >= windowStart) chosen.add(row.id)
  }
  return {
    active: ranked.filter((row) => chosen.has(row.id)).map((row) => row.workspace),
    inactive: workspaces.filter((workspace) => !chosen.has(String(workspace.id))),
  }
}

/** A registry id shaped like a UUID, whose first eight characters also count as a mention. */
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The workspaces a message names. Pure, case-insensitive.
 *
 * A workspace is named when the text contains its title (≥3 characters), its
 * path's basename (≥3 characters), its full id, or, for a UUID-shaped id, the
 * id's first eight characters.
 *
 * @param {string} text
 * @param {{ id: string, title?: string, path?: string }[]} workspaces
 * @returns {object[]} the named workspaces, registry order
 */
export function mentionedWorkspaces(text, workspaces = []) {
  const haystack = String(text ?? '').toLowerCase()
  if (haystack === '') return []
  return workspaces.filter((workspace) => {
    const id = String(workspace?.id ?? '')
    const needles = []
    if (typeof workspace?.title === 'string' && charLength(workspace.title) >= 3) needles.push(workspace.title)
    const base = typeof workspace?.path === 'string' ? basename(workspace.path) : ''
    if (charLength(base) >= 3) needles.push(base)
    if (id !== '') needles.push(id)
    if (UUID_ID.test(id)) needles.push(id.slice(0, 8))
    return needles.some((needle) => haystack.includes(needle.toLowerCase()))
  })
}

/**
 * What one workspace's note and board block are rendered from. Pure.
 *
 * `running` and `deliveries` carry their label: the report's `label`, else the
 * dispatch's title or topic, else '' (a delivery then shows its summary's first
 * line). `deliveries` is the latest terminal report per dispatch, newest first.
 *
 * @param {{ workspaces?: object[], cards?: object, tags?: object[], reports?: object[], dispatches?: object[] }} input
 * @returns {Map<string, { intro: string, updatedAt?: string, running: { dispatch: object, label: string }[], deliveries: { report: object, label: string }[], reportCount: number, lastTouch?: number }>}
 *   keyed by workspace id
 */
export function workspaceFacts({ workspaces = [], cards = {}, tags = [], reports = [], dispatches = [] } = {}) {
  const { running, ended } = dispatchState({ dispatches, reports })
  const dispatchById = new Map(dispatches.map((dispatch) => [dispatch.dispatchId, dispatch]))
  const touches = lastTouches({ tags, reports, dispatches })
  const facts = new Map()
  for (const workspace of workspaces) {
    const id = String(workspace.id)
    const card = cards?.[id]
    const inWorkspace = (record) => String(record?.workspaceId) === id
    facts.set(id, {
      intro: typeof card?.intro === 'string' ? card.intro.trim() : '',
      updatedAt: card?.updatedAt,
      running: running.filter(inWorkspace).map((dispatch) => ({ dispatch, label: dispatchLabel(dispatch) })),
      deliveries: ended.filter(inWorkspace).map((report) => ({
        report,
        label: (typeof report.label === 'string' ? clip(report.label, 120) : '') || namedLabel(dispatchById.get(report.dispatchId)),
      })),
      reportCount: reports.filter(inWorkspace).length,
      lastTouch: touches.get(id),
    })
  }
  return facts
}

/** One delivery's text: `<label> — <outcome>：<summary line>`, or `<summary line> — <outcome>` without a label. */
function deliveryText({ report, label }, labelMax, summaryMax) {
  const outcome = report.outcome ?? report.status
  const line = firstLine(report.summary)
  if (label === '') return `${clip(line, labelMax)} — ${outcome}`
  return `${clip(label, labelMax)} — ${outcome}：${clip(line, summaryMax)}`
}

/** First line of every note file: the file is regenerated, so hand edits do not survive. */
const NOTE_BANNER = '<!-- generated by discipline-whale; regenerated from reports, checkpoints and tags.jsonl -->'

/** Deliveries listed in a note. */
const NOTE_DELIVERIES = 5

/** Directory under the whale home that holds the workspace notes. */
export const NOTES_DIRNAME = 'notes'

/** One workspace's note file: `<dataDir>/home/notes/<key>.md`. */
export function workspaceNotePath(homeDir, workspaceId) {
  return join(whaleHomeDir(homeDir), NOTES_DIRNAME, `${workspaceKey(workspaceId)}.md`)
}

/**
 * Render one workspace's note. Pure: the same facts give the same text.
 *
 * @param {{ id: string, title?: string }} workspace
 * @param {object} facts one value of {@link workspaceFacts}
 * @returns {string} Markdown ending in a newline
 */
export function renderWorkspaceNote(workspace, facts = {}) {
  const id = String(workspace.id)
  const intro = facts.intro ? clip(facts.intro, INTRO_MAX) : NO_INTRO
  const lines = [NOTE_BANNER, `# ${workspace.title ?? id} (${id})`, `介绍：${intro}${facts.updatedAt ? ` [updated: ${facts.updatedAt}]` : ''}`]
  if (facts.lastTouch !== undefined) lines.push(`最近活跃：${localMinute(facts.lastTouch)}`)
  const running = facts.running ?? []
  if (running.length > 0) {
    lines.push('## 进行中')
    for (const { dispatch, label } of running) {
      lines.push(
        formatEntry({
          text: clip(label, 120),
          meta: { session: shortId(dispatch.workerSessionId), dispatch: dispatch.dispatchId, started: localMinute(dispatch.startedAt) },
        }),
      )
    }
  }
  const deliveries = (facts.deliveries ?? []).slice(0, NOTE_DELIVERIES)
  if (deliveries.length > 0) {
    lines.push(`## 最近交付（最多 ${NOTE_DELIVERIES} 条，新的在前）`)
    for (const delivery of deliveries) {
      lines.push(
        formatEntry({
          text: deliveryText(delivery, 120, 160),
          meta: { report: delivery.report.id, ended: localDay(delivery.report.reportedAt) },
        }),
      )
    }
  }
  if (facts.reportCount > 0) {
    lines.push('## 更早', `- 共 ${facts.reportCount} 份报告，索引：${INDEX_DIRNAME}/${workspaceKey(id)}.md`)
  }
  return `${lines.join('\n')}\n`
}

/** Total budget of the board, in code points. */
export const BOARD_MAX_CHARS = 2000

/** Budget of one workspace's entries on the board, in code points. */
export const BOARD_WORKSPACE_MAX_CHARS = 450

/** Deliveries listed per workspace on the board. */
const BOARD_DELIVERIES = 2

/** Longest summary line of a board delivery. */
const BOARD_SUMMARY_MAX = 100

/** Label lengths the board steps down through when it is over budget. */
const LABEL_STEPS = [60, 40, 24, 12]

/** Intro lengths the board steps down through once every label is at its shortest. */
const INTRO_STEPS = [INTRO_MAX, 80, 40]

/** Longest list of inactive workspace names on the board's last line. */
const INACTIVE_NAMES_MAX = 300

const BOARD_TITLE = '# 我们正在做什么（按工作区，只列活跃的）'

/**
 * Render the activity board: the active workspaces with their running
 * dispatches and latest deliveries, then one line naming the rest. Pure.
 *
 * Budget: each workspace's entries stay within 450 code points and the board
 * within `maxChars`. Over budget, deliveries go first (least recently touched
 * workspace first), then every label steps down, then intros shorten, and as a
 * last resort the longest running list folds its tail into a count line.
 *
 * @param {{ workspaces?: object[], cards?: object, tags?: object[], reports?: object[], dispatches?: object[], windowTurns?: number, maxActive?: number, maxChars?: number }} input
 * @returns {string} Markdown, or '' when there are no workspaces
 */
export function renderBoard({
  workspaces = [],
  cards = {},
  tags = [],
  reports = [],
  dispatches = [],
  windowTurns = 8,
  maxActive = 4,
  maxChars = BOARD_MAX_CHARS,
} = {}) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return ''
  const { active, inactive } = activeWorkspaces({ workspaces, tags, reports, dispatches, windowTurns, maxActive })
  const facts = workspaceFacts({ workspaces, cards, tags, reports, dispatches })
  const blocks = active.map((workspace) => {
    const fact = facts.get(String(workspace.id))
    return { workspace, intro: fact.intro, running: fact.running, deliveries: fact.deliveries.slice(0, BOARD_DELIVERIES), labelStep: 0, folded: 0 }
  })
  let introStep = 0

  const entryLines = (block) => {
    const labelMax = LABEL_STEPS[block.labelStep]
    const lines = block.running.map(({ dispatch, label }) =>
      formatEntry({
        text: `进行中：${clip(label, labelMax)}`,
        meta: { session: shortId(dispatch.workerSessionId), started: boardMinute(dispatch.startedAt) },
      }),
    )
    if (block.folded > 0) lines.push(`- 另有 ${block.folded} 个进行中（list_dispatches 查看）`)
    for (const delivery of block.deliveries) {
      lines.push(formatEntry({ text: `最近：${deliveryText(delivery, labelMax, BOARD_SUMMARY_MAX)}`, meta: { report: delivery.report.id } }))
    }
    return lines
  }
  const entriesLength = (block) => charLength(entryLines(block).join('\n'))
  const names = inactive.map((workspace) => workspace.title ?? workspace.id).join('、')
  const inactiveLine =
    inactive.length === 0
      ? undefined
      : `其余工作区（近 ${windowTurns} 个人类回合未涉及）：${clip(names, INACTIVE_NAMES_MAX)} —— 需要时 list_workspaces / read_report(mode:"index")`
  const render = () => {
    const lines = [BOARD_TITLE]
    for (const block of blocks) {
      const intro = block.intro === '' ? NO_INTRO : clip(block.intro, INTRO_STEPS[introStep])
      lines.push(`## ${block.workspace.title ?? block.workspace.id} · ${intro}`, ...entryLines(block))
    }
    if (inactiveLine !== undefined) lines.push(inactiveLine)
    return lines.join('\n')
  }

  for (const block of blocks) {
    while (entriesLength(block) > BOARD_WORKSPACE_MAX_CHARS && block.deliveries.length > 0) block.deliveries.pop()
    while (entriesLength(block) > BOARD_WORKSPACE_MAX_CHARS && block.labelStep < LABEL_STEPS.length - 1) block.labelStep += 1
  }
  while (charLength(render()) > maxChars) {
    const withDelivery = blocks.findLast((block) => block.deliveries.length > 0)
    if (withDelivery !== undefined) {
      withDelivery.deliveries.pop()
      continue
    }
    const longLabels = blocks.filter((block) => block.labelStep < LABEL_STEPS.length - 1)
    if (longLabels.length > 0) {
      for (const block of longLabels) block.labelStep += 1
      continue
    }
    if (introStep < INTRO_STEPS.length - 1) {
      introStep += 1
      continue
    }
    const crowded = blocks.reduce((most, block) => (most === undefined || block.running.length > most.running.length ? block : most), undefined)
    if (crowded !== undefined && crowded.running.length > 0) {
      crowded.running = crowded.running.slice(0, -1)
      crowded.folded += 1
      continue
    }
    return cutLines(render(), maxChars)
  }
  return render()
}

/** Keep whole lines of `text` within `max` code points, marking the cut. */
function cutLines(text, max) {
  const marker = '- …（便签板已截断，list_workspaces 查看全部）'
  const kept = []
  let length = charLength(marker)
  for (const line of text.split('\n')) {
    const next = charLength(line) + 1
    if (length + next > max) break
    kept.push(line)
    length += next
  }
  return [...kept, marker].join('\n')
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
 * Record that a human message names a workspace (see {@link mentionedWorkspaces}).
 * A mention is a touch for the interest rule; it never colors the turn's tags.
 *
 * @param {string} homeDir DSH root
 * @param {{ sessionId: string, turn: number, workspaceId: string, at?: string }} mention
 */
export async function tagMention(homeDir, { sessionId, turn, workspaceId, at }) {
  await appendTagLine(homeDir, {
    kind: 'mention',
    sessionId,
    turn,
    workspaceId,
    at: at ?? new Date().toISOString(),
  })
}

/** `<dataDir>/memory-state/tags.jsonl`. */
export function tagsPath(homeDir) {
  return statePath(homeDir, 'tags.jsonl')
}

/**
 * Read every row of `tags.jsonl` as written, in file order.
 *
 * Unparsable lines and non-object rows are skipped; a missing file reads as [].
 *
 * @param {string} homeDir DSH root
 * @returns {Promise<object[]>} `turn`, `tag` and `mention` rows
 */
export async function readTagRows(homeDir) {
  let text
  try {
    text = await readFile(tagsPath(homeDir), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
    } catch {
      // A torn or hand-edited line: skip it.
    }
  }
  return rows
}

/**
 * Read tagged turns, merged by `sessionId + turn`, in chronological order.
 *
 * Built from `turn` and `tag` rows. A tag whose turn record is missing still
 * yields a record with empty text. Unparsable lines are skipped.
 *
 * @param {string} homeDir DSH root
 * @param {{ workspaceId?: string, limit?: number }} [options]
 * @returns {Promise<{sessionId: string, turn: number, messageId?: string, text: string, at: string, workspaces: string[], dispatches: string[]}[]>}
 */
export async function readTags(homeDir, { workspaceId, limit } = {}) {
  const merged = new Map()
  for (const row of await readTagRows(homeDir)) {
    if (row.kind !== 'turn' && row.kind !== 'tag') continue
    if (row.sessionId === undefined || row.turn === undefined) continue
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

  // Older tags.jsonl rows recorded whale pushes as turns; only the user's own words go in.
  const tags = (await readTags(homeDir, { workspaceId: workspace.id }))
    .filter((tag) => tag.text !== '' && !isWhalePushText(tag.text))
    .slice(-8)
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
