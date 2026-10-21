/**
 * discipline-whale — dream: periodic consolidation of curated memory.
 *
 * Dream reads USER Preferences, MEMORY Facts, the workspace cards and the daily
 * observations gathered since the last dream, then asks a hidden model call for
 * a list of operations. Code applies them under fixed gates:
 *
 *   promote  daily observation(s) → USER Preferences or MEMORY Facts
 *   merge    several curated entries → one, keeping every source and the earliest date
 *   rewrite  one curated entry, keeping its metadata (tighten, absolute dates)
 *   remove   one curated entry, with a reason
 *
 * Every entry the model leaves unmentioned is kept. The gates (design §7.2):
 * known ids and kinds, at most 25% of prior entries lost, a source on every
 * entry, both layers inside budget, output parses back into the expected
 * sections, and an unchanged file hash at write time. When a gate fails, dream
 * applies only the promotions (append-only). Each run appends a review section
 * to `memory/DREAMS.md`.
 *
 * Model access (`complete`) and persistence (`store`) are injected, so the
 * module runs without the host. `runDream` never throws.
 *
 * @module discipline-whale/dream
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  atomicWrite,
  charLength,
  clip,
  formatEntry,
  isoDay,
  parseSections,
  renderSections,
  sectionEntries,
  withSource,
} from './entry.js'
import { extractJsonObject, MEMORY_STATE_DIRNAME, readCursor, writeCursor } from './memory-flush.js'
import { dataDir, whaleHomeDir } from './store.js'

/** Character budgets of the two layers dream rewrites. */
export const DREAM_BUDGETS = { user: 4000, memory: 8000 }

/** Share of prior curated entries one dream may remove (remove ops + merged-away entries). */
export const MAX_LOSS_RATIO = 0.25

/** Daily files at least this many days old move to `daily/archive/` after a dream writes. */
export const ARCHIVE_AFTER_DAYS = 30

/** Bound on one curated entry written by dream. */
export const DREAM_ENTRY_CHARS = 300

/** Operation kinds the model may return. */
export const OP_KINDS = ['promote', 'merge', 'rewrite', 'remove']

const PREFERENCES = 'Preferences'
const FACTS = 'Facts'
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** `<dataDir>/memory-state/dream.lock`. */
export function dreamLockPath(homeDir) {
  return join(dataDir(homeDir), MEMORY_STATE_DIRNAME, 'dream.lock')
}

/** `<whaleHome>/memory`. */
function memoryRoot(homeDir) {
  return join(whaleHomeDir(homeDir), 'memory')
}

/** `<whaleHome>/memory/DREAMS.md`. */
export function dreamsLogPath(homeDir) {
  return join(memoryRoot(homeDir), 'DREAMS.md')
}

/** Parse an ISO timestamp or Date into epoch ms, or `NaN`. */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value !== '') return Date.parse(value)
  return Number.NaN
}

/** True when ≥`minEntries` new daily entries exist and the last dream is ≥`minHours` old (or never ran). */
export function shouldDream({ lastDreamAt, newDailyEntries, now = new Date(), minHours = 24, minEntries = 5 }) {
  if (!Number.isFinite(newDailyEntries) || newDailyEntries < minEntries) return false
  const last = toMs(lastDreamAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= minHours * 60 * 60 * 1000
}

/**
 * Take the dream lock: create `dream.lock` exclusively with `{ pid, at }`.
 * A lock older than `staleMinutes` (by its `at`, or by mtime when unreadable) is taken over.
 *
 * @returns {Promise<boolean>} true when this caller now holds the lock.
 */
export async function acquireDreamLock(homeDir, { now = new Date(), staleMinutes = 60 } = {}) {
  const path = dreamLockPath(homeDir)
  await mkdir(dirname(path), { recursive: true })
  const body = `${JSON.stringify({ pid: process.pid, at: now.toISOString() })}\n`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, body, { flag: 'wx' })
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    let heldAt = Number.NaN
    try {
      heldAt = toMs(JSON.parse(await readFile(path, 'utf8'))?.at)
    } catch {
      try {
        heldAt = (await stat(path)).mtimeMs
      } catch {
        continue
      }
    }
    if (Number.isFinite(heldAt) && now.getTime() - heldAt < staleMinutes * 60 * 1000) return false
    await rm(path, { force: true })
  }
  return false
}

/** Release the dream lock this process holds. A lock held by another pid stays. */
export async function releaseDreamLock(homeDir) {
  const path = dreamLockPath(homeDir)
  try {
    const held = JSON.parse(await readFile(path, 'utf8'))
    if (held?.pid !== undefined && held.pid !== process.pid) return
  } catch {
    // An unreadable lock belongs to nobody; removing it is the right end state.
  }
  await rm(path, { force: true })
}

/**
 * Daily entries the next dream reads: days on or after the last dream's day,
 * skipping the entries that day already held when the last dream read it.
 *
 * @returns {Promise<{ daily: Record<string, Array<{ n: number, entry: object }>>, count: number }>}
 *   `n` is the entry's 1-based position in its day file, so `D<day>#<n>` stays stable.
 */
export async function collectNewDaily(homeDir, store, cursor = {}) {
  const lastMs = toMs(cursor.lastDreamAt)
  const lastDay = Number.isNaN(lastMs) ? '' : isoDay(new Date(lastMs))
  const seenOnLastDay = Number.isInteger(cursor.dreamDayEntries) ? cursor.dreamDayEntries : 0
  const days = [...(await store.listDailyDays(homeDir))].filter((day) => DAY.test(day) && day >= lastDay).sort()
  const daily = {}
  let count = 0
  for (const day of days) {
    const entries = (await store.readDaily(homeDir, day)) ?? []
    const skip = day === lastDay ? seenOnLastDay : 0
    const fresh = entries.map((entry, index) => ({ n: index + 1, entry })).filter((item) => item.n > skip)
    if (fresh.length === 0) continue
    daily[day] = fresh
    count += fresh.length
  }
  return { daily, count }
}

/** Normalise a daily map: values may be plain entries or `{ n, entry }` items. */
function dailyItems(daily) {
  const out = []
  for (const day of Object.keys(daily ?? {}).sort()) {
    const list = Array.isArray(daily[day]) ? daily[day] : []
    list.forEach((item, index) => {
      const wrapped = item !== null && typeof item === 'object' && item.entry !== undefined && Number.isInteger(item.n)
      out.push({ day, n: wrapped ? item.n : index + 1, entry: wrapped ? item.entry : item })
    })
  }
  return out
}

/**
 * Label every entry in scope with a stable id.
 *
 * @returns {Map<string, { layer: 'user'|'memory'|'daily', entry: object, day?: string }>}
 *   `U<n>` USER Preferences, `M<n>` MEMORY Facts, `D<YYYY-MM-DD>#<n>` daily.
 */
export function labelEntries({ user = '', memory = '', daily = {} }) {
  const labels = new Map()
  sectionEntries(parseSections(user), PREFERENCES).forEach((entry, index) => labels.set(`U${index + 1}`, { layer: 'user', entry }))
  sectionEntries(parseSections(memory), FACTS).forEach((entry, index) => labels.set(`M${index + 1}`, { layer: 'memory', entry }))
  for (const item of dailyItems(daily)) labels.set(`D${item.day}#${item.n}`, { layer: 'daily', entry: item.entry, day: item.day })
  return labels
}

/** One labelled entry as a prompt line. */
function labelLine(id, entry) {
  return `${id}  ${formatEntry(entry).slice(2)}`
}

const DREAM_SYSTEM = `You consolidate the long-term memory of Discipline Whale, a personal assistant that runs one endless conversation with its user.

Your scope is USER Preferences (stable preferences, imperative: "Always …", "Never …", "Prefer …") and MEMORY Facts (durable facts, lessons and conventions, declarative). Every entry carries a label: U<n> for USER Preferences, M<n> for MEMORY Facts, D<YYYY-MM-DD>#<n> for daily observations gathered since the last consolidation.

Work in four phases:
1. Orient — read every labelled entry, the workspace cards and the daily observations.
2. Gather — find daily observations that repeat, that the user confirmed, or that hold across conversations; find curated entries that drifted, duplicate each other, or that newer observations contradict.
3. Consolidate — promote observations worth keeping; merge near-duplicates into one entry; rewrite entries to tighten wording and to turn relative dates ("yesterday", "next week") into absolute dates based on the entry's added date; remove entries that newer facts contradict.
4. Prune — remove entries that are stale or cheap to look up again (task progress, PR numbers, session summaries) and keep both files compact.

Rules:
- Code applies your operations. Every entry you leave unmentioned stays exactly as it is.
- Keep more than you remove: one consolidation removes at most a quarter of the existing U and M entries, counting each merge as (ids − 1) removals.
- Promote a daily observation only when no existing entry already covers it.
- One entry is one line of at most ${DREAM_ENTRY_CHARS} characters, in the language it was written in. Keep [[path]] links.
- Write entry text only; code fills the [source; added] metadata.
- Stay inside the budgets: USER.md ≤ ${DREAM_BUDGETS.user} characters, MEMORY.md ≤ ${DREAM_BUDGETS.memory} characters.
- An empty ops list is a good answer when the memory is already in order.

Answer with one JSON object and nothing else:
{"ops": [
  {"op": "promote", "from": ["D2026-10-21#3"], "target": "user" | "memory", "text": "…"},
  {"op": "merge", "ids": ["M2", "M5"], "text": "…"},
  {"op": "rewrite", "id": "M3", "text": "…"},
  {"op": "remove", "id": "M4", "reason": "…"}
]}
Merge ids come from one layer (all U or all M).`

/**
 * Build the dream prompt.
 *
 * @param {object} input
 * @param {string} input.user USER.md text
 * @param {string} input.memory MEMORY.md text
 * @param {Array<{ id: string, title?: string, intro?: string }>} [input.workspaces]
 * @param {Record<string, Array>} [input.daily] `{ day: entries | { n, entry }[] }`
 * @param {Date} [input.now]
 * @returns {{ system: string, user: string }}
 */
export function buildDreamPrompt({ user = '', memory = '', workspaces = [], daily = {}, now = new Date() }) {
  const labels = [...labelEntries({ user, memory, daily })]
  const lines = (layer) => {
    const picked = labels.filter(([, value]) => value.layer === layer).map(([id, value]) => labelLine(id, value.entry))
    return picked.length > 0 ? picked.join('\n') : '(none)'
  }
  const cards = (Array.isArray(workspaces) ? workspaces : [])
    .map((workspace) => `- ${workspace.id} · ${workspace.title || workspace.id} · ${workspace.intro || '(no intro yet)'}`)
  const body = [
    `Today is ${isoDay(now)}. USER.md is ${charLength(user)}/${DREAM_BUDGETS.user} characters, MEMORY.md is ${charLength(memory)}/${DREAM_BUDGETS.memory}.`,
    '',
    '# USER Preferences',
    lines('user'),
    '',
    '# MEMORY Facts',
    lines('memory'),
    '',
    '# Workspace cards (context)',
    cards.length > 0 ? cards.join('\n') : '(none)',
    '',
    '# Daily observations since the last consolidation',
    lines('daily'),
    '',
    'Answer with the JSON object now.',
  ]
  return { system: DREAM_SYSTEM, user: body.join('\n') }
}

/**
 * Parse the model's dream answer.
 *
 * @returns {Array<object>} the raw ops; validation happens in {@link applyDreamOps}.
 * @throws {SyntaxError|TypeError} when the answer is unparsable or `ops` is not an array.
 */
export function parseDreamOps(text) {
  const value = extractJsonObject(text)
  const ops = value.ops ?? []
  if (!Array.isArray(ops)) throw new TypeError('"ops" must be an array')
  return ops
}

/** Distinct sources of several entries, in order, joined with ', '. */
function unionSources(sources) {
  const seen = []
  for (const source of sources) {
    for (const part of String(source ?? '').split(',').map((piece) => piece.trim())) {
      if (part !== '' && !seen.includes(part)) seen.push(part)
    }
  }
  return seen.join(', ')
}

/** The earliest valid `added` day among entries, or `undefined`. */
function earliestAdded(entries) {
  const days = entries.map((entry) => entry.meta?.added).filter((day) => typeof day === 'string' && DAY.test(day)).sort()
  return days[0]
}

/** Short description of an op for logs and rejections. */
export function describeOp(op) {
  if (op === null || typeof op !== 'object') return String(op)
  const ids = op.ids ?? op.from ?? op.id
  const target = op.target ? ` → ${op.target}` : ''
  const tail = op.text ? `: ${clip(op.text, 80)}` : op.reason ? ` (${clip(op.reason, 80)})` : ''
  return `${op.op ?? '?'} ${Array.isArray(ids) ? ids.join(', ') : ids ?? ''}${target}${tail}`.trim()
}

/** Find a section, creating it at the end of the document when absent. */
function ensureSection(doc, heading) {
  let section = doc.sections.find((candidate) => candidate.heading === heading)
  if (section === undefined) {
    section = { heading, lines: [] }
    doc.sections.push(section)
  }
  return section
}

/** Insert entries after the last non-blank line of a section. */
function appendEntries(section, entries) {
  if (entries.length === 0) return
  let at = section.lines.length
  while (at > 0 && section.lines[at - 1].raw !== undefined && section.lines[at - 1].raw.trim() === '') at -= 1
  section.lines.splice(at, 0, ...entries.map((entry) => ({ entry })))
}

/**
 * Apply dream operations to the two layer texts. Pure.
 *
 * @param {object} input
 * @param {string} input.user USER.md text
 * @param {string} input.memory MEMORY.md text
 * @param {Record<string, Array>} [input.daily] daily entries by day
 * @param {Array<object>} input.ops
 * @param {Date} [input.now]
 * @returns {{ user: string, memory: string, removedPrior: number, priorCount: number,
 *   applied: string[], rejected: Array<{ op: object, reason: string }>,
 *   counts: { user: number, memory: number } }}
 *   `counts` is the expected number of Preferences / Facts entries in the output.
 */
export function applyDreamOps({ user = '', memory = '', daily = {}, ops = [], now = new Date() }) {
  const labels = labelEntries({ user, memory, daily })
  const docs = { user: parseSections(user), memory: parseSections(memory) }
  const scope = { user: PREFERENCES, memory: FACTS }
  const priorIds = [...labels.keys()].filter((id) => !id.startsWith('D'))
  const priorCount = priorIds.length

  const consumed = new Set()
  const replaced = new Map()
  const promoted = { user: [], memory: [] }
  const applied = []
  const rejected = []
  let removedPrior = 0

  const reject = (op, reason) => rejected.push({ op, reason })
  const curated = (id) => typeof id === 'string' && labels.has(id) && labels.get(id).layer !== 'daily'
  const text = (op) => clip(typeof op.text === 'string' ? op.text : '', DREAM_ENTRY_CHARS)

  for (const op of Array.isArray(ops) ? ops : []) {
    if (op === null || typeof op !== 'object' || !OP_KINDS.includes(op.op)) {
      reject(op, `unknown op kind ${op?.op ?? typeof op}`)
      continue
    }
    if (op.op === 'promote') {
      const from = (Array.isArray(op.from) ? op.from : [op.from]).filter((id) => id !== undefined)
      const unknown = from.filter((id) => typeof id !== 'string' || labels.get(id)?.layer !== 'daily')
      if (from.length === 0 || unknown.length > 0) reject(op, `unknown daily id ${unknown.join(', ') || '(none)'}`)
      else if (op.target !== 'user' && op.target !== 'memory') reject(op, `target must be user or memory`)
      else if (text(op) === '') reject(op, 'empty text')
      else {
        const source = unionSources(from.map((id) => labels.get(id).entry.meta?.source || `daily:${labels.get(id).day}`))
        promoted[op.target].push({ text: text(op), meta: { source, added: isoDay(now) } })
        applied.push(describeOp(op))
      }
      continue
    }
    if (op.op === 'merge') {
      const ids = Array.isArray(op.ids) ? op.ids : []
      const unknown = ids.filter((id) => !curated(id))
      const layers = new Set(ids.filter(curated).map((id) => labels.get(id).layer))
      if (ids.length < 2 || unknown.length > 0) reject(op, `unknown id ${unknown.join(', ') || '(fewer than two ids)'}`)
      else if (new Set(ids).size !== ids.length || ids.some((id) => consumed.has(id))) reject(op, 'id already used by another op')
      else if (layers.size !== 1) reject(op, 'merge ids span both layers')
      else if (text(op) === '') reject(op, 'empty text')
      else {
        const entries = ids.map((id) => labels.get(id).entry)
        const meta = { ...entries[0].meta, source: unionSources(entries.map((entry) => entry.meta?.source)) }
        const added = earliestAdded(entries)
        if (added !== undefined) meta.added = added
        replaced.set(ids[0], { text: text(op), meta })
        for (const id of ids) consumed.add(id)
        for (const id of ids.slice(1)) replaced.set(id, null)
        removedPrior += ids.length - 1
        applied.push(describeOp(op))
      }
      continue
    }
    if (!curated(op.id)) {
      reject(op, `unknown id ${op.id ?? '(none)'}`)
      continue
    }
    if (consumed.has(op.id)) {
      reject(op, 'id already used by another op')
      continue
    }
    if (op.op === 'rewrite') {
      if (text(op) === '') {
        reject(op, 'empty text')
        continue
      }
      replaced.set(op.id, { text: text(op), meta: { ...labels.get(op.id).entry.meta } })
    } else {
      replaced.set(op.id, null)
      removedPrior += 1
    }
    consumed.add(op.id)
    applied.push(describeOp(op))
  }

  const counts = {}
  for (const layer of ['user', 'memory']) {
    const prefix = layer === 'user' ? 'U' : 'M'
    const section = docs[layer].sections.find((candidate) => candidate.heading === scope[layer])
    if (section !== undefined) {
      let index = 0
      const lines = []
      for (const line of section.lines) {
        if (line.entry === undefined) {
          lines.push(line)
          continue
        }
        index += 1
        const id = `${prefix}${index}`
        if (!replaced.has(id)) lines.push(line)
        else if (replaced.get(id) !== null) lines.push({ entry: replaced.get(id) })
      }
      section.lines = lines
    }
    if (promoted[layer].length > 0) appendEntries(ensureSection(docs[layer], scope[layer]), promoted[layer])
    counts[layer] = sectionEntries(docs[layer], scope[layer]).length
  }

  // Every entry leaves a dream with a provenance: entries written before sources
  // were recorded receive `source: unknown`, so the source gate judges this dream's
  // own work instead of history.
  for (const doc of [docs.user, docs.memory]) {
    for (const section of doc.sections) {
      for (const line of section.lines) {
        if (line.entry !== undefined && !line.entry.meta?.source) line.entry = { ...line.entry, meta: withSource(line.entry.meta) }
      }
    }
  }

  return {
    user: renderSections(docs.user),
    memory: renderSections(docs.memory),
    removedPrior,
    priorCount,
    applied,
    rejected,
    counts,
  }
}

/**
 * Check the §7.2 gates on an applied dream. Gate 4 (hash) runs at write time via `expectHash`.
 *
 * @param {object} input
 * @param {{ user: string, memory: string }} input.before layer texts before the dream
 * @param {ReturnType<typeof applyDreamOps>} input.after
 * @param {Array<object>} [input.ops]
 * @param {{ user: number, memory: number }} [input.budgets]
 * @returns {{ ok: boolean, failures: Array<{ gate: 'ids'|'loss'|'source'|'budget'|'parse', detail: string }> }}
 */
export function checkGates({ before = {}, after, ops = [], budgets = DREAM_BUDGETS }) {
  const failures = []

  for (const op of Array.isArray(ops) ? ops : []) {
    if (op === null || typeof op !== 'object' || !OP_KINDS.includes(op.op)) failures.push({ gate: 'ids', detail: `invalid op kind: ${describeOp(op)}` })
  }
  for (const { op, reason } of after.rejected ?? []) {
    if (op !== null && typeof op === 'object' && OP_KINDS.includes(op.op)) failures.push({ gate: 'ids', detail: `${reason}: ${describeOp(op)}` })
  }

  const priorCount = Number.isFinite(after.priorCount) ? after.priorCount : labelEntries({ user: before.user, memory: before.memory }).size
  if (after.removedPrior > priorCount * MAX_LOSS_RATIO) {
    failures.push({ gate: 'loss', detail: `removes ${after.removedPrior} of ${priorCount} prior entries (limit ${Math.round(MAX_LOSS_RATIO * 100)}%)` })
  }

  const scope = { user: PREFERENCES, memory: FACTS }
  const expected = {}
  for (const layer of ['user', 'memory']) {
    const kept = typeof before[layer] === 'string' ? parseSections(before[layer]).sections.map((section) => section.heading) : []
    expected[layer] = [...new Set([...kept, scope[layer]])]
  }
  for (const layer of ['user', 'memory']) {
    const doc = parseSections(after[layer])
    for (const section of doc.sections) {
      for (const line of section.lines) {
        if (line.entry !== undefined && String(line.entry.meta?.source ?? '').trim() === '') {
          failures.push({ gate: 'source', detail: `${layer} ${section.heading}: "${clip(line.entry.text, 60)}" has no source` })
        }
      }
    }

    const size = charLength(after[layer])
    if (size > budgets[layer]) failures.push({ gate: 'budget', detail: `${layer} is ${size} characters (budget ${budgets[layer]})` })

    const headings = doc.sections.map((section) => section.heading)
    const missing = expected[layer].filter((heading) => !headings.includes(heading))
    if (missing.length > 0) failures.push({ gate: 'parse', detail: `${layer} lacks section ${missing.join(', ')}` })
    const heading = scope[layer]
    const count = sectionEntries(doc, heading).length
    if (after.counts !== undefined && count !== after.counts[layer]) {
      failures.push({ gate: 'parse', detail: `${layer} ${heading} parses back to ${count} entries, expected ${after.counts[layer]}` })
    }
  }

  return { ok: failures.length === 0, failures }
}

/** Local `YYYY-MM-DD HH:mm`. */
function stamp(date) {
  return `${isoDay(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Append one review section to DREAMS.md. */
async function appendDreamLog(homeDir, now, bullets) {
  const path = dreamsLogPath(homeDir)
  let current = '# Dreams\n'
  try {
    current = await readFile(path, 'utf8')
  } catch {
    // First dream: start the review file with its title.
  }
  const section = [`## ${stamp(now)}`, ...bullets.map((bullet) => `- ${clip(bullet, 400)}`)].join('\n')
  await atomicWrite(path, `${current.replace(/\n+$/, '')}\n\n${section}\n`)
}

/**
 * Move daily files whose day is ≥`days` before `now` into `daily/archive/`.
 *
 * @returns {Promise<string[]>} archived days.
 */
export async function archiveDaily(homeDir, now = new Date(), days = ARCHIVE_AFTER_DAYS) {
  const dir = join(memoryRoot(homeDir), 'daily')
  const cutoff = isoDay(new Date(now.getTime() - days * DAY_MS))
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const archived = []
  for (const name of names.sort()) {
    const day = name.slice(0, -3)
    if (!name.endsWith('.md') || !DAY.test(day) || day > cutoff) continue
    await mkdir(join(dir, 'archive'), { recursive: true })
    await rename(join(dir, name), join(dir, 'archive', name))
    archived.push(day)
  }
  return archived
}

/**
 * How many entries of today's daily file this dream has read: the next dream
 * starts after them (stored as cursor `dreamDayEntries`).
 */
function seenToday(daily, cursor, now) {
  const today = isoDay(now)
  const fresh = daily[today]
  if (Array.isArray(fresh) && fresh.length > 0) return fresh[fresh.length - 1].n
  const lastMs = toMs(cursor.lastDreamAt)
  const sameDay = !Number.isNaN(lastMs) && isoDay(new Date(lastMs)) === today
  return sameDay && Number.isInteger(cursor.dreamDayEntries) ? cursor.dreamDayEntries : 0
}

/** Total entries across the store's daily days. */
async function countDaily(homeDir, store) {
  let total = 0
  for (const day of await store.listDailyDays(homeDir)) total += ((await store.readDaily(homeDir, day)) ?? []).length
  return total
}

/**
 * Run one dream end to end.
 *
 * @param {object} input
 * @param {string} input.homeDir DSH root
 * @param {(request: { system: string, user: string, signal?: AbortSignal }) => Promise<string>} input.complete
 * @param {object} input.store `readLayer`, `writeLayer`, `listDailyDays`, `readDaily`, `readWorkspaceCards`
 * @param {Date} [input.now]
 * @param {Array<{ id: string, title?: string }>} [input.workspaces] registered workspaces, for card titles
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ ok: boolean, skipped?: 'locked', mode?: 'full'|'fallback'|'none'|'conflict'|'error',
 *   applied?: string[], rejected?: Array, failures?: Array, archived?: string[], dailyEntries?: number, error?: string }>}
 *   Never rejects. `ok` is true when a full or fallback write landed.
 */
export async function runDream({ homeDir, complete, store, now = new Date(), workspaces = [], signal }) {
  let locked = false
  try {
    locked = await acquireDreamLock(homeDir, { now })
  } catch (error) {
    return { ok: false, mode: 'error', error: error instanceof Error ? error.message : String(error) }
  }
  if (!locked) return { ok: false, skipped: 'locked' }

  const result = { ok: false, mode: 'error', applied: [], rejected: [], failures: [], archived: [], dailyEntries: 0 }
  const log = []
  try {
    const cursor = await readCursor(homeDir)
    const userLayer = await store.readLayer(homeDir, 'user')
    const memoryLayer = await store.readLayer(homeDir, 'memory')
    const { daily, count } = await collectNewDaily(homeDir, store, cursor)
    result.dailyEntries = count
    const todaySeen = seenToday(daily, cursor, now)

    const cards = typeof store.readWorkspaceCards === 'function' ? (await store.readWorkspaceCards(homeDir)) ?? {} : {}
    const titles = new Map((Array.isArray(workspaces) ? workspaces : []).map((workspace) => [workspace.id, workspace.title]))
    const ids = [...new Set([...titles.keys(), ...Object.keys(cards)])]
    const cardList = ids.map((id) => ({ id, title: titles.get(id), intro: cards[id]?.intro ?? '' }))

    const prompt = buildDreamPrompt({ user: userLayer.text, memory: memoryLayer.text, workspaces: cardList, daily, now })
    const ops = parseDreamOps(await complete({ ...prompt, signal }))
    const before = { user: userLayer.text, memory: memoryLayer.text }
    const after = applyDreamOps({ ...before, daily, ops, now })
    const gates = checkGates({ before, after, ops })

    let chosen
    if (gates.ok) {
      result.mode = 'full'
      chosen = after
    } else {
      result.failures = gates.failures
      for (const failure of gates.failures) log.push(`gate ${failure.gate}: ${failure.detail}`)
      const fallback = applyDreamOps({ ...before, daily, ops: ops.filter((op) => op?.op === 'promote'), now })
      const fit = checkGates({ before, after: { ...fallback, rejected: [] }, ops: [] })
      const blocking = fit.failures.filter((failure) => failure.gate === 'budget' || failure.gate === 'parse')
      if (blocking.length === 0) {
        result.mode = 'fallback'
        chosen = fallback
        log.push('fallback: promotions only (append-only)')
      } else {
        result.mode = 'none'
        for (const failure of blocking) log.push(`fallback blocked by ${failure.gate}: ${failure.detail}`)
      }
    }

    if (chosen !== undefined) {
      try {
        // Both layers are re-checked before either is written, so a concurrent edit
        // stops the whole dream instead of leaving one layer rewritten.
        for (const [target, layer] of [['user', userLayer], ['memory', memoryLayer]]) {
          const current = await store.readLayer(homeDir, target)
          if (current.hash !== layer.hash) {
            throw Object.assign(new Error(`${target} layer changed during the dream`), { name: 'MemoryConflictError' })
          }
        }
        if (chosen.user !== userLayer.text) await store.writeLayer(homeDir, 'user', chosen.user, { expectHash: userLayer.hash })
        if (chosen.memory !== memoryLayer.text) await store.writeLayer(homeDir, 'memory', chosen.memory, { expectHash: memoryLayer.hash })
      } catch (error) {
        if (error?.name !== 'MemoryConflictError') throw error
        result.mode = 'conflict'
        result.error = error.message
        log.push(`conflict: a layer changed during the dream; this dream stops here (${error.message})`)
        chosen = undefined
      }
    }

    if (chosen !== undefined) {
      result.ok = true
      result.applied = chosen.applied
      result.rejected = chosen.rejected
      for (const line of chosen.applied) log.push(`applied ${line}`)
      if (chosen.applied.length === 0) log.push('no changes')
      result.archived = await archiveDaily(homeDir, now)
      if (result.archived.length > 0) log.push(`archived daily ${result.archived.join(', ')}`)
    }

    if (result.mode !== 'conflict') {
      await writeCursor(homeDir, {
        lastDreamAt: now.toISOString(),
        dailyEntriesAtLastDream: await countDaily(homeDir, store),
        dreamDayEntries: todaySeen,
      })
    }
  } catch (error) {
    result.ok = false
    result.mode = 'error'
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    log.push(`error: ${result.error}`)
  } finally {
    try {
      await appendDreamLog(homeDir, now, [`mode: ${result.mode}; daily entries read: ${result.dailyEntries}`, ...log])
    } catch (error) {
      result.logError = error instanceof Error ? error.message : String(error)
    }
    await releaseDreamLock(homeDir).catch(() => {})
  }
  return result
}
