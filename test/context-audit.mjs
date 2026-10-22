/**
 * context-audit.mjs — regression tests for the measurement script.
 *
 * THE BUG THIS GUARDS: DSH appends to `session.v4.jsonl.zstd` by concatenating
 * zstd FRAMES. `zlib.zstdDecompressSync` decodes only the first frame and
 * returns a silent, truncated prefix. A measurement built on it reports zeros
 * for a session that is 150 KB of records — a wrong answer that looks like a
 * valid one. That is exactly what happened on the first run of the audit.
 *
 * The first test reimplements the naive read and asserts it IS truncated, so
 * the guard stays meaningful if Node ever changes behaviour: if this assertion
 * ever fails, re-check whether `decodeZstd` can be simplified.
 *
 * Usage: node test/context-audit.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import {
  auditSession,
  decodeZstd,
  listSessionLogs,
  measureSkillCatalog,
  readSessionRecords,
  sectionSystemPrompt,
} from '../scripts/context-audit.mjs'

/** A session log with many appended frames, used as the fixture. */
const FIXTURE = join(
  homedir(),
  '.dsh/sessions/--Users-huiyuan-.dsh-discipline-whale-home--',
  'session-44431ff2-3cf7-4755-ad0f-0a000e0266ee/session.v4.jsonl.zstd',
)

/** Decode with the zstd CLI — the independent reference implementation. */
function referenceDecode(path) {
  return execFileSync('zstd', ['-d', '-c', '--quiet'], {
    input: readFileSync(path),
    maxBuffer: 1 << 30,
  }).toString('utf8')
}

test('a session log is multi-frame, and the naive Node decode truncates it', () => {
  const raw = readFileSync(FIXTURE)
  const naive = zstdDecompressSync(raw).toString('utf8')
  const reference = referenceDecode(FIXTURE)

  assert.ok(
    reference.length > naive.length,
    `fixture is expected to be multi-frame: reference ${reference.length} chars, naive ${naive.length}`,
  )
  // The failure mode is silent: no throw, just a short prefix.
  assert.ok(naive.length < 4096, `naive decode should be a truncated prefix, got ${naive.length} chars`)
  assert.equal(
    naive.split('\n').filter(Boolean).length,
    1,
    'the naive decode yields a single record, which is why the audit first reported zeros',
  )
})

test('decodeZstd reproduces the reference decode byte for byte', () => {
  const raw = readFileSync(FIXTURE)
  assert.equal(decodeZstd(raw), referenceDecode(FIXTURE))
})

test('readSessionRecords returns every record, and every record parses', () => {
  const records = readSessionRecords(FIXTURE)
  const reference = referenceDecode(FIXTURE).split('\n').filter((line) => line.trim().length > 0)
  assert.equal(records.length, reference.length)
  assert.ok(records.length > 40, `expected a populated log, got ${records.length} records`)
  assert.equal(records[0].type, 'session')
  assert.equal(records[0].agentPreset, 'discipline-whale')
})

test('sections partition the system prompt exactly — no gap, no overlap', () => {
  const records = readSessionRecords(FIXTURE)
  const systemText = records
    .find((r) => r.type === 'system/message')
    .data.message.content.map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  const sections = sectionSystemPrompt(systemText)
  assert.equal(
    sections.reduce((sum, s) => sum + s.chars, 0),
    systemText.length,
    'section char counts must sum to the prompt length',
  )
  for (const [i, s] of sections.entries()) {
    assert.equal(s.end - s.start, s.chars, `section ${s.name} has inconsistent bounds`)
    if (i > 0) assert.equal(s.start, sections[i - 1].end, `section ${s.name} must start where the previous ends`)
  }

  // The markers that must be found in a main-session prompt. Section names are
  // the audit's labels, not the prompt's headings, so match case-insensitively.
  const names = sections.map((s) => s.name).join('\n').toLowerCase()
  for (const expected of ['whale-brevity', 'long-term memory', 'motion ui', 'process discipline', 'memory index']) {
    assert.ok(names.includes(expected.toLowerCase()), `expected a section mentioning "${expected}"`)
  }
})

test('auditSession prices the same system prompt it read', async () => {
  const audit = await auditSession(FIXTURE)
  const records = readSessionRecords(FIXTURE)
  const systemText = records
    .find((r) => r.type === 'system/message')
    .data.message.content.map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  assert.equal(audit.resident.systemChars, systemText.length)
  assert.equal(
    audit.sections.reduce((sum, s) => sum + s.chars, 0),
    audit.resident.systemChars,
  )
  assert.ok(audit.resident.toolsCount > 50, `expected a populated tool surface, got ${audit.resident.toolsCount}`)
  assert.ok(audit.resident.totalTokens > 10_000, 'a main session should be tens of thousands of tokens')

  // Resident total is the sum of its parts — the number the report quotes.
  assert.equal(
    audit.resident.systemTokens + audit.resident.toolsTokens + audit.resident.messageTokens,
    audit.resident.totalTokens,
  )

  // The billed number for turn 1 is NOT the resident number: it is paid per step.
  assert.ok(audit.usage.firstStepInput > 0)
  assert.equal(audit.usage.firstTurnSteps, 2, 'turn 1 of this fixture is two steps')
  assert.equal(
    audit.usage.firstTurnBilledInput,
    30_574 + 30_782,
    'turn 1 billing is the two provider samples, not the resident estimate',
  )
})

test('measureSkillCatalog counts entries and separates list from framing', () => {
  const records = readSessionRecords(FIXTURE)
  const text = records
    .find((r) => r.type === 'user/message' && r.data.source?.kind === 'skill-catalog')
    .data.content.map((b) => b.text ?? '')
    .join('')
  const measured = measureSkillCatalog(text)
  assert.ok(measured.entries > 20, `expected a real catalog, got ${measured.entries} entries`)
  assert.equal(measured.listChars + measured.framingChars, measured.chars)
})

test('listSessionLogs finds logs and reports a path per session', async () => {
  const logs = await listSessionLogs()
  assert.ok(logs.length > 10, `expected many session logs, got ${logs.length}`)
  for (const log of logs.slice(0, 5)) {
    assert.ok(log.path.endsWith('session.v4.jsonl.zstd'))
    assert.ok(log.mtime > 0)
  }
  // Newest first.
  for (let i = 1; i < logs.length; i += 1) assert.ok(logs[i - 1].mtime >= logs[i].mtime)
})

// ---------------------------------------------------------------------------
// The isolation probe — run it as a child process so its own assertions are the
// test's assertion. It prints a verdict line only when every property holds.
// ---------------------------------------------------------------------------
test('tools.restrict() isolates one scope and leaves siblings and the host alone', () => {
  const out = execFileSync(process.execPath, ['scripts/tools-restrict-probe.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.match(out, /all properties hold/)
  assert.match(out, /no change to DSH itself is required/)
  // The before/after contrast is what proves the restriction did anything.
  assert.match(out, /scope A before restrict\s+host_read,host_shell,own_dispatch/)
  assert.match(out, /scope A after restrict\s+host_read,own_dispatch/)
  assert.match(out, /scope B after restrict\s+host_read,host_shell,own_dispatch/)
  assert.match(out, /host view after restrict\s+host_read,host_shell/)
})
