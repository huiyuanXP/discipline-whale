/**
 * discipline-whale — automatic memory writes: flush before compaction, nudge on a cadence.
 *
 * The main session is one endless conversation. Two moments hand its recent
 * stretch to a hidden model call that captures what is worth keeping:
 *
 *   flush — the context is about to compact; capture once per compaction cycle
 *   nudge — every N user turns since the last flush or nudge
 *
 * Both run the same pipeline: render the transcript (injected memory and
 * activity snapshots are left out, tool calls shrink to one line each), ask the
 * model for strict JSON operations, and apply them through the injected store:
 *
 *   daily             append-only observations in today's daily file
 *   user_now          replaces USER.md `## Now` as a whole (null keeps it)
 *   workspace_intros  replaces one workspace card intro each
 *
 * Model access (`complete`) and persistence (`store`) are injected, so the
 * module runs without the host. A flush never throws: compaction proceeds
 * whatever the model answers.
 *
 * @module discipline-whale/memory-flush
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { atomicWrite, charLength, clip, isoDay } from './entry.js'
import { dataDir } from './store.js'

/** Directory under the plugin data dir that holds memory bookkeeping. */
export const MEMORY_STATE_DIRNAME = 'memory-state'

/** The transcript tail handed to the model, in characters. */
export const FLUSH_TRANSCRIPT_CHARS = 160000

/** Bound on one daily observation. */
export const DAILY_ENTRY_CHARS = 300

/** Bound on one workspace intro. */
export const WORKSPACE_INTRO_CHARS = 200

/** USER.md `## Now` holds at most this many entries. */
export const NOW_MAX_ENTRIES = 5

/** Bound on one `## Now` entry, so five entries stay inside the Now budget. */
export const NOW_ENTRY_CHARS = 200

/** `<dataDir>/memory-state/cursor.json`: flush, nudge and dream progress. */
export function cursorPath(homeDir) {
  return join(dataDir(homeDir), MEMORY_STATE_DIRNAME, 'cursor.json')
}

/**
 * Read the progress cursor.
 *
 * @returns `{ lastFlushAt, lastNudgeTurn, lastDreamAt, dailyEntriesAtLastDream, … }`;
 *   a field nobody wrote yet is `undefined`, a missing or unreadable file reads as `{}`.
 */
export async function readCursor(homeDir) {
  try {
    const value = JSON.parse(await readFile(cursorPath(homeDir), 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Merge-patch the cursor and write it atomically. A `null` value deletes the key.
 *
 * @returns the merged cursor.
 */
export async function writeCursor(homeDir, patch) {
  const merged = { ...(await readCursor(homeDir)) }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete merged[key]
    else if (value !== undefined) merged[key] = value
  }
  await atomicWrite(cursorPath(homeDir), `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/** True when the context is within `margin` tokens of compaction and this cycle has not flushed yet. */
export function shouldFlush({ contextTokens, compactThreshold, margin = 32768, flushedThisCycle = false }) {
  if (flushedThisCycle) return false
  if (!Number.isFinite(contextTokens) || !Number.isFinite(compactThreshold)) return false
  return contextTokens >= compactThreshold - margin
}

/** True once `interval` DSH turns have passed since the last nudge. */
export function shouldNudge({ turnsSinceLast, interval = 10 }) {
  return Number.isFinite(turnsSinceLast) && turnsSinceLast >= interval
}

/**
 * Render transcript items as plain text, keeping the most recent `limit` characters.
 *
 * Items with role `context` are injected memory / activity snapshots: they are
 * already known, so they stay out of the text the model extracts from. A tool
 * item renders as `→ <toolName>`; its result stays in the session log.
 */
export function renderTranscript(transcript, limit = FLUSH_TRANSCRIPT_CHARS) {
  const lines = []
  for (const item of Array.isArray(transcript) ? transcript : []) {
    if (item === null || typeof item !== 'object') continue
    if (item.role === 'user') lines.push(`User: ${String(item.text ?? '').trim()}`)
    else if (item.role === 'assistant') lines.push(`Assistant: ${String(item.text ?? '').trim()}`)
    else if (item.role === 'tool') lines.push(`→ ${item.toolName || 'tool'}`)
  }
  const kept = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const size = charLength(line) + 1
    if (used + size <= limit) {
      kept.push(line)
      used += size
      continue
    }
    const room = limit - used - 2
    if (room > 0) kept.push(`…${Array.from(line).slice(-room).join('')}`)
    break
  }
  return kept.reverse().join('\n')
}

const FLUSH_SYSTEM = `You keep the long-term memory of Discipline Whale, a personal assistant that runs one endless conversation with its user and dispatches work into the user's workspaces.

Read the recent conversation and capture durable memories to disk. Usually nothing is worth saving: empty lists and null are the expected, correct answer most of the time.

What belongs in "daily" (one observation per item, one line, at most ${DAILY_ENTRY_CHARS} characters):
- a preference or working style the user voiced
- a decision the user made, with its reason when given
- a lesson learned or a pitfall hit
- a fact about the user or their projects that code, reports and files do not show

What stays in reports and the session log, so leave it out of every field:
- summaries of the session, task progress, status updates
- PR, issue, commit or dispatch numbers
- secrets: tokens, passwords, keys, credentials
- anything cheap to look up again
- anything USER.md or the workspace cards already say

"user_now": at most ${NOW_MAX_ENTRIES} short lines on what the user is doing now and wants next. It replaces the whole USER.md "## Now" section, so list every line that should remain. Use null when the current Now still holds.

"workspace_intros": only for workspaces whose situation changed in this conversation. Key = a workspace id from the list; value = at most ${WORKSPACE_INTRO_CHARS} characters covering the workspace's purpose, the current work and the next step.

Write entries in the language the user writes in. Write dates as absolute dates (YYYY-MM-DD). Write plain text only: code adds the source and date metadata.

Answer with one JSON object and nothing else:
{"daily": [{"text": "…"}], "user_now": ["…"] | null, "workspace_intros": {"<workspaceId>": "…"}}`

/**
 * Build the flush / nudge prompt.
 *
 * @param {object} input
 * @param {Array<{ role: string, text?: string, toolName?: string }>} input.transcript
 * @param {string} [input.user] current USER.md text
 * @param {Array<{ id: string, title?: string, intro?: string }>} [input.workspaces]
 * @param {Date} [input.now]
 * @returns {{ system: string, user: string }}
 */
export function buildFlushPrompt({ transcript, user = '', workspaces = [], now = new Date() }) {
  const cards = (Array.isArray(workspaces) ? workspaces : [])
    .map((workspace) => `- ${workspace.id} · ${workspace.title || workspace.id} · ${workspace.intro ? clip(workspace.intro, WORKSPACE_INTRO_CHARS) : '(no intro yet)'}`)
  const body = [
    `Today is ${isoDay(now)}.`,
    '',
    '# Current USER.md (already known)',
    String(user ?? '').trim() || '(empty)',
    '',
    '# Workspaces (id · title · current intro)',
    cards.length > 0 ? cards.join('\n') : '(none)',
    '',
    '# Recent conversation',
    renderTranscript(transcript) || '(empty)',
    '',
    'Answer with the JSON object now.',
  ]
  return { system: FLUSH_SYSTEM, user: body.join('\n') }
}

/**
 * Pull the outermost JSON object out of a model answer.
 *
 * Code fences and prose around the object are tolerated.
 *
 * @throws {SyntaxError} when the answer holds no parsable object.
 */
export function extractJsonObject(text) {
  const body = String(text ?? '').replace(/```[a-zA-Z]*/g, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) throw new SyntaxError('model answer holds no JSON object')
  const value = JSON.parse(body.slice(start, end + 1))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('model answer is not a JSON object')
  return value
}

/** A string, or the `text` of an object item; anything else reads as empty. */
function itemText(item) {
  if (typeof item === 'string') return item
  if (item !== null && typeof item === 'object' && typeof item.text === 'string') return item.text
  return ''
}

/**
 * Validate and bound the model's flush answer.
 *
 * @param {string} text raw model answer
 * @param {object} [options]
 * @param {Iterable<string>} [options.workspaceIds] valid ids; intros for other ids are dropped.
 *   When omitted, every id is kept.
 * @returns {{ daily: Array<{ text: string }>, user_now: string[] | null, workspace_intros: Record<string, string> }}
 *   An empty `user_now` list reads as `null` (Now unchanged).
 * @throws {SyntaxError|TypeError} when the answer is unparsable or a field has the wrong type.
 */
export function parseFlushOutput(text, { workspaceIds } = {}) {
  const value = extractJsonObject(text)

  const rawDaily = value.daily ?? []
  if (!Array.isArray(rawDaily)) throw new TypeError('"daily" must be an array')
  const daily = rawDaily
    .map((item) => clip(itemText(item), DAILY_ENTRY_CHARS))
    .filter((entry) => entry !== '')
    .map((entry) => ({ text: entry }))

  let userNow = null
  if (value.user_now !== null && value.user_now !== undefined) {
    if (!Array.isArray(value.user_now)) throw new TypeError('"user_now" must be an array or null')
    const lines = value.user_now
      .map((item) => clip(itemText(item), NOW_ENTRY_CHARS))
      .filter((entry) => entry !== '')
      .slice(0, NOW_MAX_ENTRIES)
    userNow = lines.length > 0 ? lines : null
  }

  const rawIntros = value.workspace_intros ?? {}
  if (rawIntros === null || typeof rawIntros !== 'object' || Array.isArray(rawIntros)) {
    throw new TypeError('"workspace_intros" must be an object')
  }
  const known = workspaceIds === undefined ? null : new Set(workspaceIds)
  const intros = {}
  for (const [id, intro] of Object.entries(rawIntros)) {
    if (known !== null && !known.has(id)) continue
    if (typeof intro !== 'string') continue
    const bounded = clip(intro, WORKSPACE_INTRO_CHARS)
    if (bounded !== '') intros[id] = bounded
  }

  return { daily, user_now: userNow, workspace_intros: intros }
}

/**
 * Run one flush or nudge end to end.
 *
 * @param {object} input
 * @param {string} input.homeDir DSH root
 * @param {Array} input.transcript items since the last flush / nudge
 * @param {(request: { system: string, user: string, signal?: AbortSignal }) => Promise<string>} input.complete
 * @param {object} input.store `readLayer`, `appendDaily`, `replaceNow`, `readWorkspaceCards`, `setWorkspaceIntro`
 * @param {Date} [input.now]
 * @param {string} [input.source] provenance for written entries, e.g. `session:<id>#t<turn>`
 * @param {Array<{ id: string, title?: string }>} [input.workspaces] registered workspaces
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ ok: boolean, daily: number, now: number | null, intros: number, introErrors: number, error?: string }>}
 *   Never rejects.
 */
export async function runFlush({ homeDir, transcript, complete, store, now = new Date(), source = 'session:main', workspaces = [], signal }) {
  const result = { ok: false, daily: 0, now: null, intros: 0, introErrors: 0 }
  try {
    const userLayer = await store.readLayer(homeDir, 'user')
    const cards = typeof store.readWorkspaceCards === 'function' ? (await store.readWorkspaceCards(homeDir)) ?? {} : {}
    const listed = (Array.isArray(workspaces) ? workspaces : []).map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      intro: cards[workspace.id]?.intro ?? '',
    }))
    const prompt = buildFlushPrompt({ transcript, user: userLayer?.text ?? '', workspaces: listed, now })
    const answer = await complete({ ...prompt, signal })
    const parsed = parseFlushOutput(answer, { workspaceIds: listed.map((workspace) => workspace.id) })

    const day = isoDay(now)
    const meta = { source, added: day }
    if (parsed.daily.length > 0) {
      await store.appendDaily(homeDir, parsed.daily.map((entry) => ({ text: entry.text, meta: { ...meta } })), { day })
      result.daily = parsed.daily.length
    }
    if (parsed.user_now !== null) {
      await store.replaceNow(homeDir, parsed.user_now.map((text) => ({ text, meta: { ...meta } })), { now, source })
      result.now = parsed.user_now.length
    }
    for (const [workspaceId, intro] of Object.entries(parsed.workspace_intros)) {
      try {
        await store.setWorkspaceIntro(homeDir, workspaceId, intro, { now })
        result.intros += 1
      } catch {
        result.introErrors += 1
      }
    }

    await writeCursor(homeDir, { lastFlushAt: now.toISOString() })
    result.ok = true
    return result
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return result
  }
}
