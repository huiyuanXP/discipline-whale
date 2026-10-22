/**
 * whitelist-effect — what the main session's tool surface becomes, measured on
 * the REAL tool names a real session actually carried.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TEST:
 * `test/tool-whitelist.mjs` proves the mechanism against a fixture surface. That
 * is necessary but not sufficient — the numbers in the report have to come from
 * the names the main session really had (77 tools, read out of a durable session
 * log), not from a list someone typed. This script reads that log, replays the
 * real surface through a real `ToolRuntime`, applies the production
 * `installToolWhitelist`, and prints the before/after account.
 *
 * It also answers the user's hard requirement directly: are the Dynamic UI tools
 * still there, and are the document/media tools actually gone?
 *
 * Usage:
 *   node scripts/whitelist-effect.mjs
 *   node scripts/whitelist-effect.mjs --json
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const INSTALL = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'
const moduleUrl = (specifier) => new URL(`file://${join(INSTALL, specifier)}`).href

const { Context } = await import(moduleUrl('@deepseek-ai/cordis/lib/index.js'))
const { createScope, scopeOf } = await import(moduleUrl('@deepseek-ai/dsh-scope/lib/index.js'))
const { SystemPrompt } = await import(moduleUrl('@deepseek-ai/dsh-system-prompt/lib/index.js'))
const toolsModule = await import(moduleUrl('@deepseek-ai/dsh-tools/lib/index.js'))

const ToolRuntime = toolsModule.default ?? toolsModule.ToolRuntime
const { defineTool } = toolsModule

const { installToolWhitelist, resolveToolWhitelist } = await import('../main.js')
const { readSessionRecords, listSessionLogs, auditSession } = await import('./context-audit.mjs')

/** The preset whose surface we replay. */
const PRESET = 'discipline-whale'

/** The main session's own registrations: preset-scope, so exempt from restrict(). */
const OWN_TOOLS = [
  'dispatch_task', 'send_to_session', 'read_report', 'list_dispatches',
  'list_workspaces', 'resume_dispatch', 'abandon_dispatch',
]

/** Names from the user's mandate, spelled out so the check is not circular. */
const MUST_KEEP_UI = [
  'render_ui', 'render_canvas', 'render_scene', 'render_text', 'render_mechanism',
  'inspect_ui', 'patch_ui', 'update_ui', 'validate_ui', 'ui_catalog',
]
const MUST_CUT = [
  'ppt_create', 'ppt_read',
  'word_create', 'word_read', 'word_update',
  'excel_create', 'excel_read', 'excel_update',
  'render_video', 'preview_video', 'process_video', 'inspect_video',
  'synthesize_voice',
]

const makeTool = (name) => defineTool({
  name,
  description: `fixture tool ${name}`,
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'ok' }] },
  async execute() { return null },
})

/** Newest session log for one preset. */
async function newestLogFor(preset) {
  for (const log of await listSessionLogs()) {
    try {
      const head = readSessionRecords(log.path).find((r) => r.type === 'session')
      if (head?.agentPreset === preset) return log.path
    } catch {
      continue
    }
  }
  return undefined
}

const logPath = process.argv.find((a) => a.startsWith('--session='))?.slice('--session='.length)
  ?? await newestLogFor(PRESET)

if (logPath === undefined) {
  console.error(`no session log found for preset ${PRESET}`)
  process.exit(1)
}

const audit = await auditSession(logPath)
const realNames = audit.tools.map((t) => t.name)
const tokenOf = Object.fromEntries(audit.tools.map((t) => [t.name, t.tokens]))

// ---------------------------------------------------------------------------
// Replay the real surface through a real registry.
// ---------------------------------------------------------------------------
const app = new Context()
new SystemPrompt(app, {})
const tools = new ToolRuntime(app, {})

// Every real name that is NOT the main session's own registration is a host tool.
const ownSet = new Set(OWN_TOOLS)
const hostNames = realNames.filter((name) => !ownSet.has(name))
for (const name of hostNames) tools.register(makeTool(name))

const mainScope = createScope(app, {})
const mainRow = mainScope.ctx.plugin({
  name: 'discipline-whale-main',
  inject: ['tools'],
  apply(ctx) {
    for (const name of OWN_TOOLS) ctx.tools.register(makeTool(name))
    installToolWhitelist(ctx, resolveToolWhitelist({}))
  },
})
await mainRow.await()

// A sibling plain coding session and a worker-shaped scope, for the no-side-effect proof.
const codingScope = createScope(app, {})
const workerScope = createScope(app, {})
const workerRow = workerScope.ctx.plugin({
  name: 'discipline-whale-worker',
  inject: ['tools'],
  apply(ctx) { ctx.tools.register(makeTool('report_to_main')) },
})
await workerRow.await()

const namesOf = (scope) => [...tools.view(scopeOf(scope)).visible.keys()].sort()

const mainBefore = realNames.slice().sort()
const mainAfter = namesOf(mainScope.ctx)
const codingAfter = namesOf(codingScope.ctx)
const workerAfter = namesOf(workerScope.ctx)
const globalAfter = [...tools.view(undefined).visible.keys()].sort()

// ---------------------------------------------------------------------------
// Assertions: the mandate, on real names.
// ---------------------------------------------------------------------------
const mainAfterSet = new Set(mainAfter)
const problems = []
for (const name of MUST_KEEP_UI) {
  if (!mainAfterSet.has(name)) problems.push(`Dynamic UI tool missing from main scope: ${name}`)
}
for (const name of MUST_CUT) {
  if (mainAfterSet.has(name)) problems.push(`document/media tool still visible to main: ${name}`)
}
for (const name of OWN_TOOLS) {
  if (!mainAfterSet.has(name)) problems.push(`dispatch tool missing from main scope: ${name}`)
}
// Sibling and worker: must hold every host tool that exists.
for (const name of hostNames) {
  if (!codingAfter.includes(name)) problems.push(`coding session lost ${name}`)
  if (!workerAfter.includes(name)) problems.push(`worker session lost ${name}`)
}
if (codingAfter.includes('report_to_main')) problems.push('coding session leaked the worker report tool')
if (!workerAfter.includes('report_to_main')) problems.push('worker session lost its report tool')

// ---------------------------------------------------------------------------
// The account.
// ---------------------------------------------------------------------------
const cut = mainBefore.filter((name) => !mainAfterSet.has(name))
const cutTokens = cut.reduce((sum, name) => sum + (tokenOf[name] ?? 0), 0)
const keptTokens = mainAfter.reduce((sum, name) => sum + (tokenOf[name] ?? 0), 0)
const resident = audit.resident.totalTokens

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    log: logPath,
    before: { count: mainBefore.length, toolsTokens: audit.resident.toolsTokens, resident },
    after: { count: mainAfter.length, toolsTokens: keptTokens },
    cut: cut.map((name) => ({ name, tokens: tokenOf[name] ?? 0 })),
    cutTokens,
    savedPctOfResident: Number(((cutTokens / resident) * 100).toFixed(1)),
    savedPctOfTools: Number(((cutTokens / audit.resident.toolsTokens) * 100).toFixed(1)),
    problems,
  }, null, 2))
} else {
  console.log(`log: ${logPath}\n`)
  console.log(`before: ${mainBefore.length} tools, ${audit.resident.toolsTokens} tokens of schemas, ${resident} resident`)
  console.log(`after : ${mainAfter.length} tools, ${keptTokens} tokens of schemas\n`)
  console.log(`cut   : ${cut.length} tools, ${cutTokens} tokens`)
  console.log(`        ${((cutTokens / audit.resident.toolsTokens) * 100).toFixed(1)}% of the tool surface, ` +
    `${((cutTokens / resident) * 100).toFixed(1)}% of resident\n`)

  console.log('CUT (name / tokens):')
  for (const name of cut.sort((a, b) => (tokenOf[b] ?? 0) - (tokenOf[a] ?? 0))) {
    console.log(`  ${name.padEnd(24)} ${String(tokenOf[name] ?? 0).padStart(5)}`)
  }

  console.log('\nKEPT — Dynamic UI:')
  for (const name of MUST_KEEP_UI) {
    console.log(`  ${name.padEnd(24)} ${String(tokenOf[name] ?? 0).padStart(5)}  ${mainAfterSet.has(name) ? 'visible' : 'MISSING'}`)
  }

  console.log('\nNO SIDE EFFECTS:')
  console.log(`  coding session : ${codingAfter.length} tools (host surface ${hostNames.length} + own)`)
  console.log(`  worker session : ${workerAfter.length} tools (host surface + report_to_main)`)
  console.log(`  global view    : ${globalAfter.length} tools`)

  console.log(problems.length === 0
    ? '\nverdict: every mandate check holds.'
    : `\nPROBLEMS:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
}

if (problems.length > 0) process.exitCode = 1
