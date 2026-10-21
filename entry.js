/**
 * discipline-whale — the memory entry format shared by every memory module.
 *
 * One entry is one Markdown bullet, Devin style:
 *
 *   - Use bun, not npm; see [[workspaces/blog]] [source: report:r-3f2a; added: 2026-10-21]
 *
 * The trailing bracket holds `key: value` pairs separated by `; `. `[[path]]`
 * links inside the text point at on-demand notes under `home/memory/`, written
 * without the `.md` suffix. A memory file is a list of `## Heading` sections,
 * each holding entries; text that is not an entry bullet is kept verbatim, so a
 * hand-edited file round-trips unchanged.
 *
 * @module discipline-whale/entry
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Trailing metadata bracket: `[key: value; key: value]` at the end of a bullet. */
const META_TAIL = /\s*\[((?:[a-z][a-z0-9_]*:\s?[^\];]*)(?:;\s*[a-z][a-z0-9_]*:\s?[^\];]*)*)\]\s*$/

/** `[[path]]` links inside entry text. */
const LINK = /\[\[([^\]]+)\]\]/g

/** Provenance recorded for an entry whose origin was never captured. */
export const UNKNOWN_SOURCE = 'unknown'

/**
 * Entry meta with `source` as the first key, filled with {@link UNKNOWN_SOURCE}
 * when absent, so every entry carries a provenance.
 */
export function withSource(meta = {}, source) {
  const { source: current, ...rest } = meta
  const value = source ?? current
  return { source: value === undefined || value === '' ? UNKNOWN_SOURCE : value, ...rest }
}

/** Local calendar day as `YYYY-MM-DD`. Entries always carry absolute dates. */
export function isoDay(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Collapse whitespace to single spaces and cut to `max` code points, marking the cut with `…`. */
export function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  if (points.length <= max) return flat
  return `${points.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** Length in Unicode code points, the unit every memory budget is written in. */
export function charLength(text) {
  return Array.from(String(text ?? '')).length
}

/**
 * Parse one line into an entry.
 *
 * @returns `{ text, meta, links }` for a `- ` bullet, `null` for anything else.
 *   `meta` is a plain object in written order; `links` lists `[[path]]` targets.
 */
export function parseEntry(line) {
  const match = /^\s*-\s+(.*)$/.exec(String(line))
  if (match === null) return null
  let body = match[1]
  const meta = {}
  const tail = META_TAIL.exec(body)
  if (tail !== null) {
    for (const pair of tail[1].split(';')) {
      const at = pair.indexOf(':')
      const key = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (key !== '') meta[key] = value
    }
    body = body.slice(0, tail.index)
  }
  const text = body.trim()
  const links = [...text.matchAll(LINK)].map((link) => link[1].trim())
  return { text, meta, links }
}

/**
 * Render one entry as a single bullet line.
 *
 * Text is flattened to one line. Meta keys keep insertion order; empty values
 * are dropped. `]` and `;` inside meta values would break the bracket, so they
 * are replaced with safe look-alikes.
 */
export function formatEntry({ text, meta = {} }) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const pairs = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${key}: ${String(value).replace(/\]/g, ')').replace(/;/g, ',')}`)
  return pairs.length === 0 ? `- ${flat}` : `- ${flat} [${pairs.join('; ')}]`
}

/**
 * Split a memory document into sections.
 *
 * @returns `{ preamble: string[], sections: [{ heading, lines }] }` where each
 *   line is `{ entry }` for a bullet or `{ raw }` for anything else. Lines before
 *   the first `## ` heading form the preamble (a `# Title`, a note to humans).
 */
export function parseSections(markdown) {
  const preamble = []
  const sections = []
  let current = null
  for (const raw of String(markdown ?? '').split('\n')) {
    const heading = /^##\s+(.*)$/.exec(raw)
    if (heading !== null) {
      current = { heading: heading[1].trim(), lines: [] }
      sections.push(current)
      continue
    }
    const entry = parseEntry(raw)
    const line = entry === null ? { raw } : { entry }
    if (current === null) preamble.push(raw)
    else current.lines.push(line)
  }
  return { preamble, sections }
}

/** Inverse of {@link parseSections}. Trailing blank lines collapse to one final newline. */
export function renderSections({ preamble = [], sections = [] }) {
  const out = [...preamble]
  for (const section of sections) {
    out.push(`## ${section.heading}`)
    for (const line of section.lines) out.push(line.entry !== undefined ? formatEntry(line.entry) : line.raw)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** The entries of one section, or `[]` when the heading is absent. */
export function sectionEntries(doc, heading) {
  const section = doc.sections.find((candidate) => candidate.heading === heading)
  return section === undefined ? [] : section.lines.filter((line) => line.entry !== undefined).map((line) => line.entry)
}

/**
 * Write a file atomically: temp file with a pid+uuid suffix, then rename.
 * A reader sees either the previous file or the complete new one.
 */
export async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, path)
  return path
}
