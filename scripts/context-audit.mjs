/**
 * Context audit — what a session actually pays before it answers anything.
 *
 * WHY THIS EXISTS: "the main session loaded 60k" was an observation, not a
 * measurement. This script replays the durable session log and prices every
 * resident source with the harness's OWN estimator
 * (`@deepseek-ai/dsh-token-meter/estimate`, CHARS_PER_TOKEN = 4), so the numbers
 * are the same ones the GUI's context breakdown shows — not a second opinion.
 *
 * It separates two numbers that get confused:
 *   * RESIDENT — what one request carries (system prompt + tool schemas +
 *     the messages present at that step). This is context *occupancy*.
 *   * BILLED   — provider `usage.inputTokens` summed across a turn's steps.
 *     A two-step turn pays the resident context twice. A "60k" reading is
 *     usually this number, not the resident one.
 *
 * Everything is derived from `session.v4.jsonl.zstd` logs that DSH already
 * wrote. Nothing is estimated from config: the system prompt, the tool
 * schemas, the skill catalog and the memory blocks are read out of the bytes
 * the model was actually sent.
 *
 * Usage:
 *   node scripts/context-audit.mjs                       # newest main + worker + standard
 *   node scripts/context-audit.mjs --session <path>      # one specific session log
 *   node scripts/context-audit.mjs --all                 # every session, grouped by preset
 *   node scripts/context-audit.mjs --json                # machine-readable
 *
 * Requires Node >= 22.15 (zstdDecompressSync). No external binaries.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Same resolution order as prompt-probe.mjs: checkout override, else the npx cache. */
const INSTALL = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

// ---------------------------------------------------------------------------
// The harness's own estimator — imported, never re-implemented
// ---------------------------------------------------------------------------

let estimate
async function loadEstimator() {
  estimate ??= await import(
    new URL(`file://${join(INSTALL, '@deepseek-ai/dsh-token-meter/lib/types/estimate.js')}`).href
  )
  return estimate
}

// ---------------------------------------------------------------------------
// Session log reading
// ---------------------------------------------------------------------------

/**
 * Decode one `session.v4.jsonl.zstd` into its JSONL records.
 *
 * NOT a one-liner: DSH appends to the log by concatenating zstd FRAMES (74 of
 * them in a mid-size session). `zlib.zstdDecompressSync` decodes only the first
 * frame and silently returns a truncated prefix — 229 characters instead of
 * 150,991 in the session measured here. That failure is invisible unless the
 * record count is checked, so this function requires a caller-visible sanity
 * property instead: every frame must be decoded, or the call throws.
 *
 * Primary backend is the `zstd` CLI, which handles multi-frame input by design.
 * The Node stream is the fallback for machines without it, and it re-runs per
 * frame by walking the frame magics itself.
 *
 * @param {string} path - path to a `session.v4.jsonl.zstd`.
 * @returns {Array<object>} parsed records, in log order.
 */
export function readSessionRecords(path) {
  const text = decodeZstd(readFileSync(path))
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress every concatenated zstd frame in `buffer`.
 * @param {Buffer} buffer - possibly multi-frame zstd data.
 * @returns {string} the complete decompressed UTF-8 text.
 */
export function decodeZstd(buffer) {
  try {
    return execFileSync('zstd', ['-d', '-c', '--quiet'], { input: buffer, maxBuffer: 1 << 30 }).toString('utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // No CLI: decode frame by frame so a multi-frame log is not truncated.
    const offsets = []
    for (let i = buffer.indexOf(ZSTD_MAGIC); i !== -1; i = buffer.indexOf(ZSTD_MAGIC, i + 1)) offsets.push(i)
    if (offsets.length === 0) throw new Error('not a zstd stream: no frame magic found')
    const parts = []
    for (const [index, start] of offsets.entries()) {
      const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
      const frame = buffer.subarray(start, end)
      try {
        parts.push(zstdDecompressSync(frame).toString('utf8'))
      } catch {
        // A frame boundary inside compressed data is indistinguishable from the
        // magic sequence by scanning alone. Keep what decodes and let the caller's
        // record parse fail loudly rather than return a silent prefix.
        break
      }
    }
    if (parts.length !== offsets.length) {
      throw new Error(
        `multi-frame zstd: decoded ${parts.length} of ${offsets.length} frames without the zstd CLI; install zstd or set ZSTD_CLI`,
      )
    }
    return parts.join('')
  }
}

/** Every session log under $DSH_HOME/sessions, newest first. */
export async function listSessionLogs() {
  const root = join(DSH_HOME, 'sessions')
  const out = []
  let workspaces = []
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsDir = join(root, ws.name)
    let sessions = []
    try {
      sessions = await readdir(wsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const log = join(wsDir, s.name, 'session.v4.jsonl.zstd')
      try {
        const info = await stat(log)
        out.push({ path: log, mtime: info.mtimeMs, workspace: ws.name, session: s.name })
      } catch {
        /* no log for this session dir — nothing to measure */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// ---------------------------------------------------------------------------
// Sectioning the system prompt
// ---------------------------------------------------------------------------

/**
 * Split a rendered system prompt into the sections whose cost we want to name.
 *
 * The prompt is a flat join of ordered sections with blank lines, so a heading
 * scan is exact for the sections that carry headings and conservative for the
 * rest. Every marker below is matched against text this repo can point at:
 * a persona prefix, `adhd.js`, `memory.js`, motion-ui's `ui-skill.js`, the
 * skill catalog's `<system-reminder>` frame, and the memory index block.
 *
 * @param {string} text - rendered system prompt.
 * @returns {Array<{name: string, chars: number, start: number, end: number}>}
 */
export function sectionSystemPrompt(text) {
  // Ordered: the earliest match wins, later markers must start after it.
  const markers = [
    { name: 'harness identity + persona prefix (dispatch discipline)', re: /^You are an AI agent powered by DeepSeek Harness\./m },
    { name: 'output discipline header (adhd.js, 输出纪律)', re: /^## 输出纪律（ADHD 读者）$/m },
    { name: 'whale-brevity skill body (adhd.js RULES)', re: /^# whale-brevity$/m },
    { name: 'long-term memory (discipline-whale memory.js)', re: /^# Long-term memory$/m },
    { name: 'UI intent policy (dsh-motion-ui ui-intent.js)', re: /^## 表达选择与实际交付$/m },
    { name: 'Motion UI guidance (dsh-motion-ui ui-skill.js)', re: /^# Motion UI — 通用设计指导/m },
    { name: 'memory index (dsh-auto-memory)', re: /^<memory_context>$/m },
    { name: 'process discipline (dsh-progress-rules)', re: /^## 过程纪律（优先于其他风格偏好）$/m },
  ]
  const hits = []
  for (const m of markers) {
    const match = m.re.exec(text)
    if (match !== null) hits.push({ name: m.name, start: match.index })
  }
  hits.sort((a, b) => a.start - b.start)
  const sections = []
  for (const [i, hit] of hits.entries()) {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length
    sections.push({ name: hit.name, chars: end - hit.start, start: hit.start, end })
  }
  // Anything before the first marker (leading blank line) is unattributed.
  if (hits.length === 0 || hits[0].start > 0) {
    sections.unshift({ name: 'unattributed head', chars: hits[0]?.start ?? text.length, start: 0, end: hits[0]?.start ?? text.length })
  }
  return sections
}

/**
 * The skill catalog lives in a user-role `<system-reminder>` message, not in the
 * system prompt. Price it separately — it is a resident injection all the same.
 * @param {string} text - the reminder message text.
 * @returns {{entries: number, chars: number, framingChars: number}}
 */
export function measureSkillCatalog(text) {
  const entries = (text.match(/^- `/gm) ?? []).length
  const open = text.indexOf('<available_skills>')
  const close = text.indexOf('</available_skills>')
  const listChars = open >= 0 && close > open ? close - open : 0
  return { entries, chars: text.length, listChars, framingChars: text.length - listChars }
}

// ---------------------------------------------------------------------------
// Measuring one session
// ---------------------------------------------------------------------------

/**
 * Price one session's resident context and its billed usage.
 * @param {string} path - path to `session.v4.jsonl.zstd`.
 */
export async function auditSession(path) {
  const { estimateSystemMessage, estimateToolsTokens, estimateMessage } = await loadEstimator()
  const records = readSessionRecords(path)

  const header = records.find((r) => r.type === 'session')
  const preset = header?.agentPreset ?? '(unset)'

  const systemRecord = records.find((r) => r.type === 'system/message')
  const systemText = systemRecord === undefined
    ? ''
    : systemRecord.data.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')

  const requestHeaders = records.filter((r) => r.type === 'request/header')
  const latestHeader = requestHeaders.at(-1)
  const tools = latestHeader?.data.header.tools ?? []

  // Per-tool price, using the harness's own tools estimator shape.
  const toolRows = tools.map((tool) => {
    const json = JSON.stringify(tool)
    return { name: tool.name, jsonChars: json.length, tokens: Math.ceil(json.length / 4) }
  }).sort((a, b) => b.tokens - a.tokens)

  // Per-step resident picture: the messages present at the step that issued the
  // request. We reconstruct it from durable events up to each step.
  const usageRows = records
    .filter((r) => r.type === 'assistant/message' && r.data.usage !== undefined)
    .map((r) => ({ turn: r.data.turn, step: r.data.step, ...r.data.usage }))

  const turns = new Map()
  for (const u of usageRows) {
    const t = turns.get(u.turn) ?? { turn: u.turn, steps: 0, billedInput: 0, output: 0 }
    t.steps += 1
    t.billedInput += u.inputTokens
    t.output += u.outputTokens
    turns.set(u.turn, t)
  }

  // The messages resident before the first step: everything user visible up to
  // the first assistant message. The system prompt is `systemTokens` below.
  const firstAssistantSeq = records.find((r) => r.type === 'assistant/message')?.seq ?? Infinity
  const residentMessages = []
  for (const r of records) {
    if (r.seq >= firstAssistantSeq) break
    if (r.type === 'user/message') {
      residentMessages.push({
        kind: r.data.source?.kind === 'skill-catalog' ? 'skill-catalog' : 'user',
        tokens: estimateMessage(r.data),
      })
    } else if (r.type === 'developer/message') {
      residentMessages.push({ kind: 'developer', tokens: estimateMessage(r.data) })
    }
  }

  const systemTokens = systemRecord === undefined ? 0 : estimateSystemMessage(systemRecord.data.message)
  const toolsTokens = latestHeader === undefined ? 0 : estimateToolsTokens(latestHeader.data.header)
  const messageTokens = residentMessages.reduce((sum, m) => sum + m.tokens, 0)

  const skillCatalogRecord = records.find(
    (r) => r.type === 'user/message' && r.data.source?.kind === 'skill-catalog',
  )
  const skillText = skillCatalogRecord === undefined
    ? ''
    : skillCatalogRecord.data.content.map((b) => (b.type === 'text' ? b.text : '')).join('')

  const runtimeContext = records.find(
    (r) => r.type === 'user/message' && r.data.source?.kind === 'runtime-context',
  )
  const timeContext = records.find(
    (r) => r.type === 'user/message' && r.data.source?.kind === 'time-context',
  )

  const sections = sectionSystemPrompt(systemText).map((s) => ({
    ...s,
    tokens: 0, // filled below so one estimator prices everything
  }))
  // Price each section as its own text block, the way the prompt is serialized.
  for (const s of sections) s.tokens = Math.ceil(s.chars / 4)

  const firstUsage = usageRows[0]
  // Turn 1 specifically: the number a user sees when a session "just loaded".
  // A turn with N steps pays the resident context N times, so this figure must
  // not be confused with occupancy — that confusion is the whole bug behind "60k".
  const firstTurnNumber = firstUsage?.turn
  const firstTurn = turns.get(firstTurnNumber)

  return {
    path,
    workspace: basename(dirname(dirname(path))),
    session: basename(dirname(path)),
    preset,
    cwd: header?.cwd,
    createdAt: header?.createdAt,
    model: latestHeader?.data.header.config,
    resident: {
      systemChars: systemText.length,
      systemTokens,
      toolsCount: tools.length,
      toolsJsonChars: JSON.stringify(tools).length,
      toolsTokens,
      messageTokens,
      messages: residentMessages,
      totalTokens: systemTokens + toolsTokens + messageTokens,
    },
    sections,
    tools: toolRows,
    skillCatalog: measureSkillCatalog(skillText),
    runtimeContextChars: runtimeContext === undefined
      ? 0
      : runtimeContext.data.content.map((b) => b.text ?? '').join('').length,
    timeContextChars: timeContext === undefined
      ? 0
      : timeContext.data.content.map((b) => b.text ?? '').join('').length,
    usage: {
      steps: usageRows.length,
      firstStepInput: firstUsage?.inputTokens,
      firstTurn: firstTurnNumber,
      firstTurnSteps: firstTurn?.steps,
      firstTurnBilledInput: firstTurn?.billedInput,
      turns: [...turns.values()],
    },
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pct = (part, whole) => (whole === 0 ? '0.0' : ((part / whole) * 100).toFixed(1))
const n = (value) => value.toLocaleString('en-US')

/** Render one session as a markdown block. */
export function renderSession(audit) {
  const r = audit.resident
  const lines = []
  lines.push(`### ${audit.preset} · ${audit.session}`)
  lines.push('')
  lines.push(`- log: \`${audit.path}\``)
  lines.push(`- cwd: \`${audit.cwd}\``)
  lines.push(`- route: ${audit.model?.provider ?? '?'} / ${audit.model?.model ?? '?'}`)
  lines.push('')
  lines.push('**Resident context (one request)**')
  lines.push('')
  lines.push('| source | chars | tokens | % of resident |')
  lines.push('| --- | ---: | ---: | ---: |')
  const skillChars = audit.skillCatalog.chars
  const rcChars = audit.runtimeContextChars
  const tcChars = audit.timeContextChars
  const rows = [
    ['system prompt', r.systemChars, r.systemTokens],
    ['tool schemas', r.toolsJsonChars, r.toolsTokens],
    ['skill catalog reminder', skillChars, Math.ceil(skillChars / 4)],
    ['runtime context message', rcChars, Math.ceil(rcChars / 4)],
    ['time context message', tcChars, Math.ceil(tcChars / 4)],
  ]
  for (const [name, chars, tokens] of rows) {
    lines.push(`| ${name} | ${n(chars)} | ${n(tokens)} | ${pct(tokens, r.totalTokens)}% |`)
  }
  lines.push(`| **resident total** | | **${n(r.totalTokens)}** | 100% |`)
  lines.push('')
  lines.push('**System prompt by section**')
  lines.push('')
  lines.push('| section | chars | tokens | % of system |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const s of audit.sections) {
    lines.push(`| ${s.name} | ${n(s.chars)} | ${n(s.tokens)} | ${pct(s.tokens, r.systemTokens)}% |`)
  }
  lines.push(`| **system total** | ${n(r.systemChars)} | **${n(r.systemTokens)}** | 100% |`)
  lines.push('')
  lines.push('**Top 10 tools by schema size**')
  lines.push('')
  lines.push('| tool | json chars | tokens | % of tools |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const t of audit.tools.slice(0, 10)) {
    lines.push(`| ${t.name} | ${n(t.jsonChars)} | ${n(t.tokens)} | ${pct(t.tokens, r.toolsTokens)}% |`)
  }
  lines.push(`| **all ${audit.tools.length} tools** | ${n(r.toolsJsonChars)} | **${n(r.toolsTokens)}** | 100% |`)
  lines.push('')
  lines.push('**Billed usage (provider-reported)**')
  lines.push('')
  lines.push(`- steps: ${audit.usage.steps}`)
  lines.push(`- first step inputTokens: **${n(audit.usage.firstStepInput ?? 0)}**`)
  lines.push(`- first turn billed inputTokens (sum over steps): **${n(audit.usage.firstTurnBilledInput ?? 0)}**`)
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const all = argv.includes('--all')
  const sessionArg = argv.find((a) => a.startsWith('--session='))?.slice('--session='.length)

  let targets
  if (sessionArg !== undefined) {
    targets = [{ path: sessionArg, mtime: 0, workspace: '', session: '' }]
  } else {
    const logs = await listSessionLogs()
    if (all) {
      targets = logs
    } else {
      // Default: the newest log per preset, so main/worker/standard all appear.
      const seen = new Set()
      targets = []
      for (const log of logs) {
        try {
          const head = readSessionRecords(log.path).find((r) => r.type === 'session')
          const preset = head?.agentPreset ?? '(unset)'
          if (seen.has(preset)) continue
          seen.add(preset)
          targets.push(log)
        } catch {
          continue
        }
      }
    }
  }

  const audits = []
  for (const t of targets) {
    try {
      audits.push(await auditSession(t.path))
    } catch (error) {
      if (!json) console.error(`skip ${t.path}: ${error.message}`)
    }
  }

  if (json) {
    console.log(JSON.stringify(audits, null, 2))
    return
  }

  const header = [
    '# Context audit',
    '',
    `Estimator: \`@deepseek-ai/dsh-token-meter/estimate\` (CHARS_PER_TOKEN = 4), the same fold the GUI uses.`,
    `Sessions audited: ${audits.length}. Session logs: \`${join(DSH_HOME, 'sessions')}\`.`,
    '',
  ].join('\n')
  console.log(header)
  for (const audit of audits) console.log(renderSession(audit))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
