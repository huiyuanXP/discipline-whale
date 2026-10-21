/**
 * discipline-whale — the curated memory layers, the daily notes and AGENTS.md.
 *
 * Every file lives in the main session's home, so the main session can read
 * any of them on demand with its `read` tool; every write goes through this
 * module on the Node side:
 *
 *   home/memory/SOUL.md     voice, stance, style            budget 2,000
 *   home/memory/USER.md     ## Preferences + ## Now          budget 4,000
 *   home/memory/MEMORY.md   long-term facts                  budget 8,000
 *   home/memory/daily/      raw observations, append-only    no budget
 *   home/AGENTS.md          rules, written only on the user's own words
 *
 * Budgets count Unicode code points of the whole file text. A write that would
 * exceed one fails with the layer's current entries in the message, so the
 * model can merge or remove entries and retry. Writes to one file are
 * serialized inside the process, and every file is replaced atomically.
 *
 * @module discipline-whale/memory
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  atomicWrite,
  charLength,
  clip,
  formatEntry,
  isoDay,
  parseEntry,
  parseSections,
  renderSections,
  withSource,
} from './entry.js'
import { whaleHomeDir } from './store.js'

/** The three injected layers: file name, budget in code points, sections in order. */
export const LAYERS = {
  soul: { file: 'SOUL.md', budget: 2000, sections: ['Voice'] },
  user: { file: 'USER.md', budget: 4000, sections: ['Preferences', 'Now'] },
  memory: { file: 'MEMORY.md', budget: 8000, sections: ['Facts'] },
}

/** Upper bound on entries in USER `## Now`. */
export const NOW_MAX_ENTRIES = 5

/** Upper bound on the rendered `## Now` entry lines, in code points. */
export const NOW_BUDGET = 1200

/** Section that receives the rules written by {@link updateInstructions}. */
export const INSTRUCTIONS_SECTION = '用户要求的规则'

/** Minimum length of the user quote that unlocks an AGENTS.md write, in code points. */
export const MIN_QUOTE_CHARS = 8

/** Source recorded on rotated Now entries that carried none. */
const NOW_FALLBACK_SOURCE = 'user-now'

/** Title, note to humans and default section of each layer's seeded file. */
const TEMPLATES = {
  soul: { title: '# SOUL', note: 'The whale\'s voice, stance, style and boundaries; written only when the user gives feedback on style.' },
  user: { title: '# USER', note: 'Who the user is: stable preferences, and what the user is working on now (rotated automatically).' },
  memory: { title: '# MEMORY', note: 'Long-term facts, lessons learned and project conventions the whale keeps across sessions.' },
}

/** Default section of each layer for {@link remember}. */
const DEFAULT_SECTION = { soul: 'Voice', user: 'Preferences', memory: 'Facts' }

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Thrown when a file changed on disk after the caller read it. */
export class MemoryConflictError extends Error {
  constructor({ file, expected, actual }) {
    super(`${file} changed on disk since it was read; read it again and retry the write.`)
    this.name = 'MemoryConflictError'
    this.file = file
    this.expected = expected
    this.actual = actual
  }
}

/** Thrown when a write would push a file (or USER `## Now`) past its budget. */
export class MemoryBudgetError extends Error {
  constructor({ file, chars, budget, listing }) {
    super(
      `${file} would be ${chars}/${budget} chars. Merge or remove entries in ONE remember call, then retry. ` +
        `Current entries of ${file}:\n${listing === '' ? '(none)' : listing}`,
    )
    this.name = 'MemoryBudgetError'
    this.file = file
    this.chars = chars
    this.budget = budget
  }
}

/** `<whaleHome>/memory`: the directory every memory file lives in. */
export function memoryDir(homeDir) {
  return join(whaleHomeDir(homeDir), 'memory')
}

/** `<whaleHome>/memory/daily`: one append-only note per day. */
export function dailyDir(homeDir) {
  return join(memoryDir(homeDir), 'daily')
}

/** `<whaleHome>/AGENTS.md`: the whale's run rules. */
export function instructionsPath(homeDir) {
  return join(whaleHomeDir(homeDir), 'AGENTS.md')
}

/** Path of one layer's file. */
export function layerPath(homeDir, target) {
  return join(memoryDir(homeDir), layerOf(target).file)
}

/** Seeded text of a layer whose file does not exist yet. */
export function layerTemplate(target) {
  const layer = layerOf(target)
  const { title, note } = TEMPLATES[target]
  return `${[title, note, '', ...layer.sections.map((heading) => `## ${heading}\n`)].join('\n').replace(/\n+$/, '')}\n`
}

/**
 * Read one layer.
 *
 * @returns `{ text, doc, hash }`. A missing file yields the seeded template as
 *   `text` and the hash of an empty file, so a first write can pass it back as
 *   `expectHash`.
 */
export async function readLayer(homeDir, target) {
  const onDisk = await readText(layerPath(homeDir, target))
  const text = onDisk ?? layerTemplate(target)
  return { text, doc: parseSections(text), hash: sha256(onDisk ?? '') }
}

/**
 * Replace one layer's file.
 *
 * @param options.expectHash  hash from {@link readLayer}; a different on-disk
 *   hash throws {@link MemoryConflictError}. Omit to skip the check.
 * @throws {MemoryBudgetError} when `text` is over the layer budget.
 */
/**
 * Create every layer file that is missing (from its template) and the daily
 * directory, so the whole structure is on disk and readable before the first
 * write. Existing files are left untouched.
 *
 * @returns the targets whose file was created.
 */
export async function ensureLayers(homeDir) {
  await mkdir(dailyDir(homeDir), { recursive: true })
  const created = []
  for (const target of Object.keys(LAYERS)) {
    if ((await readText(layerPath(homeDir, target))) !== undefined) continue
    try {
      await writeLayer(homeDir, target, layerTemplate(target), { expectHash: sha256('') })
      created.push(target)
    } catch (error) {
      // Another writer created it first; its content wins.
      if (error?.name !== 'MemoryConflictError') throw error
    }
  }
  return created
}

export async function writeLayer(homeDir, target, text, { expectHash } = {}) {
  return withLock(layerPath(homeDir, target), () => writeLayerLocked(homeDir, target, text, { expectHash }))
}

/**
 * Add, replace or remove one entry of a layer.
 *
 * - `add` appends to `section` (default: user → Preferences, memory → Facts,
 *   soul → Voice). Text equal to an existing entry of the layer, ignoring case
 *   and whitespace, returns `{ ok: true, duplicate: true }` and writes nothing.
 * - `replace` / `remove` locate the entry by `match`, a substring of the entry
 *   text (whitespace-normalized, case-insensitive) that must hit exactly one
 *   entry of the layer. `replace` keeps the old `source` unless a new one is
 *   given and sets `added` to today.
 *
 * @returns `{ ok, entry, chars, budget }` where `chars` is the file length after the write.
 * @throws {MemoryBudgetError} when the write would exceed the layer budget.
 */
export async function remember(homeDir, { target, op, text, match, section, source, now = new Date() } = {}) {
  const layer = layerOf(target)
  if (!['add', 'replace', 'remove'].includes(op)) throw new Error(`Unknown remember op "${op}"; use add, replace or remove.`)
  const heading = section ?? DEFAULT_SECTION[target]
  if (!layer.sections.includes(heading)) {
    throw new Error(`${layer.file} has no section "${heading}"; use one of: ${layer.sections.join(', ')}.`)
  }
  const added = isoDay(now)
  return withLock(layerPath(homeDir, target), async () => {
    const current = await readLayer(homeDir, target)
    const { doc } = current
    const all = layerEntries(doc)

    if (op === 'add') {
      const body = entryText(text)
      if (body === '') throw new Error('remember add needs a non-empty text.')
      const twin = all.find(({ entry }) => sameText(entry.text, body))
      if (twin !== undefined) {
        return { ok: true, duplicate: true, entry: twin.entry, chars: charLength(current.text), budget: layer.budget }
      }
      const entry = { text: body, meta: withSource({ added }, source) }
      insertEntries(ensureSection(doc, heading), [entry])
      if (heading === 'Now') checkNow(sectionEntriesOf(doc, 'Now'))
      const chars = await writeLayerLocked(homeDir, target, renderSections(doc), { expectHash: current.hash })
      return { ok: true, entry, chars, budget: layer.budget }
    }

    const hit = findOne(all, match, layer.file)
    if (op === 'remove') {
      hit.section.lines.splice(hit.section.lines.indexOf(hit.line), 1)
      const chars = await writeLayerLocked(homeDir, target, renderSections(doc), {
        expectHash: current.hash,
        allowShrink: charLength(current.text),
      })
      return { ok: true, entry: hit.entry, chars, budget: layer.budget }
    }

    const body = entryText(text)
    if (body === '') throw new Error('remember replace needs a non-empty text.')
    const { added: _previous, ...rest } = hit.entry.meta
    const entry = { text: body, meta: withSource({ ...rest, added }, source) }
    hit.line.entry = entry
    if (hit.section.heading === 'Now') checkNow(sectionEntriesOf(doc, 'Now'))
    const chars = await writeLayerLocked(homeDir, target, renderSections(doc), { expectHash: current.hash })
    return { ok: true, entry, chars, budget: layer.budget }
  })
}

/**
 * Append entries to one day's note. The first write creates the `# YYYY-MM-DD` title.
 *
 * @param entries  `[{ text, meta }]`; entries with empty text are skipped.
 * @param options.day  `YYYY-MM-DD` or a Date; defaults to today.
 * @returns the appended entries.
 */
export async function appendDaily(homeDir, entries, { day } = {}) {
  const name = dayName(day)
  const path = join(dailyDir(homeDir), `${name}.md`)
  const fresh = (entries ?? [])
    .map((entry) => ({ text: entryText(entry?.text), meta: { ...(entry?.meta ?? {}) } }))
    .filter((entry) => entry.text !== '')
  if (fresh.length === 0) return []
  return withLock(path, async () => {
    const existing = (await readText(path)) ?? `# ${name}\n\n`
    const head = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`
    await atomicWrite(path, `${head}${fresh.map(formatEntry).join('\n')}\n`)
    return fresh
  })
}

/** Every entry of one day's note, in file order; `[]` when the note does not exist. */
export async function readDaily(homeDir, day) {
  const text = await readText(join(dailyDir(homeDir), `${dayName(day)}.md`))
  if (text === undefined) return []
  return text.split('\n').map(parseEntry).filter((entry) => entry !== null)
}

/** Days that have a note, as sorted `YYYY-MM-DD` strings. */
export async function listDailyDays(homeDir) {
  let names
  try {
    names = await readdir(dailyDir(homeDir))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => name.slice(0, -3))
    .sort()
}

/**
 * Replace USER `## Now` wholesale and rotate the previous Now entries into today's daily note.
 *
 * @param entries  strings or `{ text, meta }`; at most {@link NOW_MAX_ENTRIES},
 *   rendered lines at most {@link NOW_BUDGET} code points.
 * @param options.source  source recorded on entries that carry none.
 * @returns `{ ok, entries, rotated, chars, budget }`.
 * @throws {MemoryBudgetError} when the Now section or USER.md would be over budget.
 */
export async function replaceNow(homeDir, entries, { now = new Date(), source } = {}) {
  const added = isoDay(now)
  const next = (entries ?? [])
    .map((item) => (typeof item === 'string' ? { text: item, meta: {} } : { text: item?.text, meta: { ...(item?.meta ?? {}) } }))
    .map(({ text, meta }) => {
      const { source: own, added: ownAdded, ...rest } = meta
      return { text: entryText(text), meta: { source: own ?? source, added: ownAdded ?? added, ...rest } }
    })
    .filter((entry) => entry.text !== '')
  checkNow(next)
  const layer = LAYERS.user
  return withLock(layerPath(homeDir, 'user'), async () => {
    const current = await readLayer(homeDir, 'user')
    const { doc } = current
    const section = ensureSection(doc, 'Now')
    const previous = section.lines.filter((line) => line.entry !== undefined).map((line) => line.entry)
    const at = section.lines.findIndex((line) => line.entry !== undefined)
    section.lines = section.lines.filter((line) => line.entry === undefined)
    if (at === -1) insertEntries(section, next)
    else section.lines.splice(at, 0, ...next.map((entry) => ({ entry })))
    const text = renderSections(doc)
    const chars = charLength(text)
    if (chars > layer.budget) throw budgetError('user', chars, parseSections(current.text))
    const rotated = previous.map((entry) => ({
      text: entry.text,
      meta: { source: entry.meta.source || NOW_FALLBACK_SOURCE, added: entry.meta.added || added, rotated: added },
    }))
    if (rotated.length > 0) await appendDaily(homeDir, rotated, { day: added })
    await writeLayerLocked(homeDir, 'user', text, { expectHash: current.hash })
    return { ok: true, entries: next, rotated, chars, budget: layer.budget }
  })
}

/**
 * The injection text for the Soul / User / Memory layers.
 *
 * Deterministic for identical input. Empty blocks are skipped; a block longer
 * than its layer budget keeps its head 75% and tail 25% around an explicit
 * `[…已截断 N 字符…]` marker.
 *
 * @param layers  `{ soul, user, memory }` file texts.
 */
export function renderMemorySection(layers = {}) {
  const out = [
    '# Long-term memory',
    'These blocks are the whale\'s long-term memory files under home/memory/ (SOUL.md, USER.md, MEMORY.md); ' +
      'read any of them on demand with the read tool. [[path]] means home/memory/<path>.md; daily notes are in home/memory/daily/YYYY-MM-DD.md.',
  ]
  for (const [target, title] of [['soul', 'Soul'], ['user', 'User'], ['memory', 'Memory']]) {
    const body = layerBody(target, layers[target])
    if (body === '') continue
    out.push('', `## ${title}`, truncateMiddle(body, LAYERS[target].budget))
  }
  return `${out.join('\n')}\n`
}

/** Read the three layers and render {@link renderMemorySection}. */
export async function loadMemorySection(homeDir) {
  const [soul, user, memory] = await Promise.all(['soul', 'user', 'memory'].map((target) => readLayer(homeDir, target)))
  return renderMemorySection({ soul: soul.text, user: user.text, memory: memory.text })
}

/**
 * The single write path for `<whaleHome>/AGENTS.md`.
 *
 * Gate: `userQuote`, whitespace-normalized, must be at least
 * {@link MIN_QUOTE_CHARS} code points and a substring of the whitespace-
 * normalized `latestUserText`. `add` appends `- text [source: user; added: day]`
 * under `## 用户要求的规则` (created at the end of the file when absent);
 * `replace` / `remove` act on the one bullet line anywhere in the file whose
 * text contains `match`. Every other line is preserved byte for byte.
 *
 * @returns `{ ok, op, line, path }` where `line` is the written or removed bullet.
 */
export async function updateInstructions(homeDir, { userQuote, latestUserText, op, text, match, now = new Date() } = {}) {
  const quote = normalize(userQuote)
  if (charLength(quote) < MIN_QUOTE_CHARS || !normalize(latestUserText).includes(quote)) {
    throw new Error(
      `user_quote must be the user's own words from this turn: copy at least ${MIN_QUOTE_CHARS} characters verbatim ` +
        'from the latest user message. AGENTS.md changes only when the user asks for it in this turn.',
    )
  }
  if (!['add', 'replace', 'remove'].includes(op)) throw new Error(`Unknown update_instructions op "${op}"; use add, replace or remove.`)
  const path = instructionsPath(homeDir)
  const day = isoDay(now)
  return withLock(path, async () => {
    const original = (await readText(path)) ?? ''
    const lines = original === '' ? [] : original.split('\n')
    if (op === 'add') {
      const body = entryText(text)
      if (body === '') throw new Error('update_instructions add needs a non-empty text.')
      const line = formatEntry({ text: body, meta: { source: 'user', added: day } })
      await atomicWrite(path, addRule(original, lines, line))
      return { ok: true, op, line, path }
    }
    const bullets = lines
      .map((raw, index) => ({ raw, index, entry: /^\s*[-*+]\s+/.test(raw) ? parseEntry(raw.replace(/^(\s*)[*+]/, '$1-')) : null }))
      .filter((candidate) => candidate.entry !== null)
    const needle = normalize(match).toLowerCase()
    if (needle === '') throw new Error(`update_instructions ${op} needs a non-empty match.`)
    const hits = bullets.filter((candidate) => normalize(candidate.entry.text).toLowerCase().includes(needle))
    if (hits.length === 0) throw new Error(`No rule line in AGENTS.md contains "${match}".`)
    if (hits.length > 1) {
      throw new Error(`"${match}" matches ${hits.length} rule lines in AGENTS.md; use a longer match that hits exactly one:\n${hits.map((hit) => hit.raw.trim()).join('\n')}`)
    }
    const [hit] = hits
    if (op === 'remove') {
      lines.splice(hit.index, 1)
      await atomicWrite(path, lines.join('\n'))
      return { ok: true, op, line: hit.raw, path }
    }
    const body = entryText(text)
    if (body === '') throw new Error('update_instructions replace needs a non-empty text.')
    const indent = /^\s*/.exec(hit.raw)[0]
    const line = `${indent}${formatEntry({ text: body, meta: { source: 'user', added: day } })}`
    lines[hit.index] = line
    await atomicWrite(path, lines.join('\n'))
    return { ok: true, op, line, path }
  })
}

/**
 * Import dsh-auto-memory entries into the whale's layers.
 *
 * Reads every `*.md` except `MEMORY.md` in `autoMemoryDir` (never modified).
 * `user` / `feedback` → USER Preferences, `project` / `reference` (and any other
 * type) → MEMORY Facts. Entry text is `<title or name>: <description>`, or the
 * first body paragraph when the description is empty, clipped to 300 code
 * points; meta is `{ source: 'dsh-auto-memory:<name>', added }`. Entries whose
 * source (or text) already exists are skipped, so a second run imports nothing.
 *
 * @returns the imported `[{ target, section, entry }]`.
 * @throws {MemoryBudgetError} when a layer would exceed its budget.
 */
export async function importAutoMemory(homeDir, autoMemoryDir) {
  let names
  try {
    names = await readdir(autoMemoryDir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const candidates = []
  for (const name of names.filter((file) => file.endsWith('.md') && file !== 'MEMORY.md').sort()) {
    const raw = await readText(join(autoMemoryDir, name))
    if (raw === undefined) continue
    const { fields, body } = parseFrontmatter(raw)
    const id = fields.name || name.slice(0, -3)
    const summary = fields.description || firstParagraph(body)
    const label = fields.title || id
    const text = clip(summary === '' ? label : `${label}: ${summary}`, 300)
    const created = Number(fields.created)
    const added = isoDay(Number.isFinite(created) && created > 0 ? new Date(created) : new Date())
    const target = fields.type === 'user' || fields.type === 'feedback' ? 'user' : 'memory'
    candidates.push({ target, section: DEFAULT_SECTION[target], entry: { text, meta: { source: `dsh-auto-memory:${id}`, added } } })
  }
  const imported = []
  for (const target of ['user', 'memory']) {
    const group = candidates.filter((candidate) => candidate.target === target)
    if (group.length === 0) continue
    await withLock(layerPath(homeDir, target), async () => {
      const current = await readLayer(homeDir, target)
      const known = await knownSourcesAndTexts(homeDir, target, current.doc)
      const fresh = group.filter(({ entry }) => !known.sources.has(entry.meta.source) && !known.texts.has(textKey(entry.text)))
      if (fresh.length === 0) return
      insertEntries(ensureSection(current.doc, DEFAULT_SECTION[target]), fresh.map((candidate) => candidate.entry))
      await writeLayerLocked(homeDir, target, renderSections(current.doc), { expectHash: current.hash })
      imported.push(...fresh)
    })
  }
  return imported
}

// ---------------------------------------------------------------------------
// internals

/** Per-path promise chains: one read-modify-write at a time per file. */
const chains = new Map()

/** Run `task` after every earlier task on the same path has settled. */
function withLock(path, task) {
  const previous = chains.get(path) ?? Promise.resolve()
  const run = previous.then(task)
  const settled = run.then(
    () => {},
    () => {},
  )
  chains.set(path, settled)
  settled.then(() => {
    if (chains.get(path) === settled) chains.delete(path)
  })
  return run
}

/**
 * Write a layer while holding its lock. `allowShrink` (the previous length)
 * lets a write that makes an over-budget file shorter pass.
 *
 * @returns the new length in code points.
 */
async function writeLayerLocked(homeDir, target, text, { expectHash, allowShrink } = {}) {
  const layer = layerOf(target)
  const path = layerPath(homeDir, target)
  const onDisk = await readText(path)
  const actual = sha256(onDisk ?? '')
  if (expectHash !== undefined && expectHash !== actual) {
    throw new MemoryConflictError({ file: layer.file, expected: expectHash, actual })
  }
  const value = String(text ?? '')
  const chars = charLength(value)
  const shrinking = allowShrink !== undefined && chars <= allowShrink
  if (chars > layer.budget && !shrinking) throw budgetError(target, chars, parseSections(onDisk ?? layerTemplate(target)))
  await atomicWrite(path, value)
  return chars
}

function budgetError(target, chars, doc) {
  const layer = LAYERS[target]
  return new MemoryBudgetError({ file: layer.file, chars, budget: layer.budget, listing: listing(doc) })
}

/** Every entry of a document, grouped under its `## heading`. */
function listing(doc) {
  const out = []
  for (const section of doc.sections) {
    const entries = section.lines.filter((line) => line.entry !== undefined)
    if (entries.length === 0) continue
    out.push(`## ${section.heading}`, ...entries.map((line) => formatEntry(line.entry)))
  }
  return out.join('\n')
}

/** Enforce the Now limits on a list of entries. */
function checkNow(entries) {
  if (entries.length > NOW_MAX_ENTRIES) {
    throw new Error(`USER.md ## Now holds at most ${NOW_MAX_ENTRIES} entries; got ${entries.length}. Merge them and retry.`)
  }
  const text = entries.map(formatEntry).join('\n')
  const chars = charLength(text)
  if (chars > NOW_BUDGET) {
    throw new MemoryBudgetError({ file: 'USER.md ## Now', chars, budget: NOW_BUDGET, listing: text })
  }
}

function layerOf(target) {
  const layer = LAYERS[target]
  if (layer === undefined) throw new Error(`Unknown memory target "${target}"; use soul, user or memory.`)
  return layer
}

/** `{ entry, line, section }` for every entry of a document. */
function layerEntries(doc) {
  const out = []
  for (const section of doc.sections) {
    for (const line of section.lines) if (line.entry !== undefined) out.push({ entry: line.entry, line, section })
  }
  return out
}

function sectionEntriesOf(doc, heading) {
  return layerEntries(doc)
    .filter((item) => item.section.heading === heading)
    .map((item) => item.entry)
}

/** The single entry whose text contains `match`, or an error naming zero or several hits. */
function findOne(all, match, file) {
  const needle = normalize(match).toLowerCase()
  if (needle === '') throw new Error(`replace and remove need a non-empty match naming one entry of ${file}.`)
  const hits = all.filter(({ entry }) => normalize(entry.text).toLowerCase().includes(needle))
  if (hits.length === 0) {
    const current = all.map(({ entry }) => formatEntry(entry)).join('\n')
    throw new Error(`No entry in ${file} contains "${match}". Current entries:\n${current === '' ? '(none)' : current}`)
  }
  if (hits.length > 1) {
    throw new Error(
      `"${match}" matches ${hits.length} entries in ${file}; use a longer match that hits exactly one:\n` +
        hits.map(({ entry }) => formatEntry(entry)).join('\n'),
    )
  }
  return hits[0]
}

/** The named section, appended at the end of the document when absent. */
function ensureSection(doc, heading) {
  const found = doc.sections.find((section) => section.heading === heading)
  if (found !== undefined) return found
  const last = doc.sections.at(-1)
  if (last !== undefined) {
    const tail = last.lines.at(-1)
    if (tail === undefined || tail.raw === undefined || tail.raw.trim() !== '') last.lines.push({ raw: '' })
  } else if (doc.preamble.length > 0 && doc.preamble.at(-1).trim() !== '') {
    doc.preamble.push('')
  }
  const section = { heading, lines: [] }
  doc.sections.push(section)
  return section
}

/** Insert entries after the section's last entry, or after its last non-blank line. */
function insertEntries(section, entries) {
  let at = -1
  section.lines.forEach((line, index) => {
    if (line.entry !== undefined) at = index
  })
  if (at === -1) {
    section.lines.forEach((line, index) => {
      if (line.raw !== undefined && line.raw.trim() !== '') at = index
    })
  }
  section.lines.splice(at + 1, 0, ...entries.map((entry) => ({ entry })))
}

/** Rendered body of one layer for injection: sections in order, blank lines dropped. */
function layerBody(target, text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const doc = parseSections(text)
  const filled = doc.sections
    .map((section) => ({
      heading: section.heading,
      lines: section.lines
        .map((line) => (line.entry !== undefined ? formatEntry(line.entry) : line.raw))
        .filter((line) => line.trim() !== ''),
    }))
    .filter((section) => section.lines.length > 0)
  if (filled.length === 0) return ''
  const headed = target === 'user' || filled.length > 1
  return filled.map((section) => (headed ? [`### ${section.heading}`, ...section.lines] : section.lines).join('\n')).join('\n')
}

/** Keep the head 75% and tail 25% of `budget` code points around an explicit marker. */
function truncateMiddle(text, budget) {
  const points = Array.from(text)
  if (points.length <= budget) return text
  const head = Math.floor(budget * 0.75)
  const tail = budget - head
  const cut = points.length - head - tail
  return `${points.slice(0, head).join('')}\n[…已截断 ${cut} 字符…]\n${points.slice(points.length - tail).join('')}`
}

/** Append a rule bullet under the instructions section, creating it at the end of the file when absent. */
function addRule(original, lines, line) {
  const start = lines.findIndex((raw) => /^##\s+/.test(raw) && raw.replace(/^##\s+/, '').trim() === INSTRUCTIONS_SECTION)
  if (start === -1) {
    if (original === '') return `## ${INSTRUCTIONS_SECTION}\n${line}\n`
    const head = original.endsWith('\n') ? original : `${original}\n`
    const gap = head.endsWith('\n\n') ? '' : '\n'
    return `${head}${gap}## ${INSTRUCTIONS_SECTION}\n${line}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+/.test(lines[index])) {
      end = index
      break
    }
  }
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at -= 1
  lines.splice(at, 0, line)
  return lines.join('\n')
}

/** A tiny YAML-frontmatter reader: flat `key: value` lines between `---` fences. */
function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const fields = {}
  if (!text.startsWith('---\n')) return { fields, body: text }
  const close = text.indexOf('\n---', 3)
  if (close === -1) return { fields, body: text }
  for (const line of text.slice(4, close).split('\n')) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null) continue
    let value = pair[2].trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
      value = value.slice(1, -1)
    }
    fields[pair[1]] = value
  }
  const after = text.indexOf('\n', close + 4)
  return { fields, body: after === -1 ? '' : text.slice(after + 1) }
}

function firstParagraph(body) {
  for (const block of String(body ?? '').split(/\n\s*\n/)) {
    const flat = normalize(block)
    if (flat !== '') return flat
  }
  return ''
}

/** Sources and text keys already present in the target layer and the other layers. */
async function knownSourcesAndTexts(homeDir, target, doc) {
  const sources = new Set()
  const texts = new Set()
  const docs = [doc]
  for (const other of Object.keys(LAYERS)) if (other !== target) docs.push((await readLayer(homeDir, other)).doc)
  for (const each of docs) {
    for (const { entry } of layerEntries(each)) {
      if (entry.meta.source) sources.add(entry.meta.source)
      if (each === doc) texts.add(textKey(entry.text))
    }
  }
  return { sources, texts }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function dayName(day) {
  const name = day instanceof Date ? isoDay(day) : day === undefined ? isoDay() : String(day)
  if (!DAY.test(name)) throw new Error(`Daily note day must be YYYY-MM-DD; got "${name}".`)
  return name
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Entry text: one line, without a leading bullet marker. */
function entryText(text) {
  return normalize(text).replace(/^[-*+]\s+/, '')
}

function textKey(text) {
  return normalize(text).toLowerCase()
}

function sameText(left, right) {
  return textKey(left) === textKey(right)
}
