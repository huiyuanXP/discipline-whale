/**
 * Guard tests: the three main-session brakes.
 *
 * Mounted against a fake Host that speaks the real `tools/pre-execute`
 * waterfall contract (`next()` = allow, returned decision = the gate) and the
 * real `session/event` stream, so a brake that only exists in prose cannot
 * pass. Every assertion about "the worker is unaffected" runs the same handler
 * with a worker-preset Agent and expects `next()` to be reached untouched.
 *
 * Run: node test/guard.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_FORCED_INTERVENTIONS_PER_TURN,
  READ_QUOTA_PER_EPOCH,
  WATCHDOG_SILENT_THRESHOLD,
  WATCHDOG_COUNTING_MODES,
  PRODUCTIVITY_TOOLS,
  classifyReadPath,
  countsTowardWatchdog,
  installGuard,
  isPublicDocPath,
  quotaExhaustedReason,
  readScopeReason,
  realPathOf,
  resolveGuardConfig,
} from '../guard.js'

const root = await mkdtemp(join(tmpdir(), 'dw-guard-'))

/* ------------------------------------------------------------------ *
 * fake Host
 * ------------------------------------------------------------------ */

/**
 * Build one guard mount plus a per-Agent harness.
 *
 * The pre-execute handler takes `(exec, next)`; `call()` mirrors the registry:
 * a `deny` decision is materialized as an error result, `cancel` as the
 * canonical cancellation, and only `allow` reaches `next()` and the tool body.
 */
function mountGuard(config = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { warn() {} },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  }
  const handle = installGuard(ctx, config, {
    storeRoot: () => root,
    whaleHomeDir: () => join(root, 'discipline-whale', 'home'),
    workspaceRegistry: () => ({
      list: () => [
        { id: 'ws-a', title: 'repo-a', path: join(root, 'repo-a'), sessionIds: [] },
        { id: 'ws-b', title: 'repo-b', path: join(root, 'repo-b'), sessionIds: [] },
      ],
    }),
  })
  const preExecute = listeners.get('tools/pre-execute') ?? []
  assert.equal(preExecute.length, 1, 'the guard must register one pre-execute gate')

  /** Dispatch one agent-subject event the way AgentLoop does. */
  const emit = (name, payload) => {
    for (const handler of listeners.get(name) ?? []) handler(payload)
  }

  /** The precise "the main session spoke" signal: a visible text chunk. */
  const saySomething = (agent, text = 'here is the answer') =>
    emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text } } })

  /** A real user turn (distinct from the notices the guard itself injects). */
  const userTurn = (agent) =>
    emit('agent/inbox/claimed', { agent, message: { source: { kind: 'user' }, content: [] }, turn: 1 })

  /** One main-session Agent: a fake we can cancel and steer. */
  const mainAgent = (sessionId, preset = 'discipline-whale', cwd = join(root, 'discipline-whale', 'home')) => {
    const agent = {
      cancelled: [],
      steered: [],
      session: { id: sessionId, header: { agentPreset: preset, cwd } },
      cancel(cause, options) {
        agent.cancelled.push({ cause, options })
      },
      steer(message) {
        agent.steered.push(message)
      },
    }
    return agent
  }

  /**
   * Dispatch one tool call through the gate.
   * @returns {{decision: string, reason?: string, reachedBody: boolean}}
   */
  const call = async (agent, name, args = {}) => {
    let reachedBody = false
    const next = async () => {
      reachedBody = true
      return { kind: 'allow' }
    }
    const decision = await preExecute[0](
      { callId: `c-${Math.random()}`, name, arguments: args, agent, signal: new AbortController().signal },
      next,
    )
    if (decision.kind === 'allow') return { decision: 'allow', reachedBody }
    return { decision: decision.kind, reason: decision.reason, reachedBody }
  }

  const mount = { handle, emit, saySomething, userTurn, mainAgent, call, listeners }
  /** Reasoning-only chunk: the model is thinking, not replying to the user. */
  mount.think = (agent) =>
    emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } },
    })
  return mount
}

/* ------------------------------------------------------------------ *
 * 1. pure decisions
 * ------------------------------------------------------------------ */

{
  assert.equal(isPublicDocPath('README.md'), true)
  assert.equal(isPublicDocPath('README.zh.md'), true)
  assert.equal(isPublicDocPath('AGENTS.md'), true)
  assert.equal(isPublicDocPath('packages/x/AGENTS.md'), true, 'nested agent instructions are public')
  assert.equal(isPublicDocPath('docs/guide.md'), true)
  assert.equal(isPublicDocPath('docs/deep/nested/note.md'), true)
  assert.equal(isPublicDocPath('CHANGELOG.md'), true, 'a top-level Markdown document')
  assert.equal(isPublicDocPath('package.json'), true)
  assert.equal(isPublicDocPath('src/index.js'), false, 'source is not public')
  assert.equal(isPublicDocPath('src/README.md'), false, 'README only counts at the root or in docs')
  assert.equal(isPublicDocPath('packages/x/package.json'), false, 'a nested manifest is not needed to judge a stack')
  assert.equal(isPublicDocPath('.env'), false)
  assert.equal(isPublicDocPath('.git/config'), false, 'hidden segments are never public')
  assert.equal(isPublicDocPath('../etc/passwd'), false)
  assert.equal(isPublicDocPath('docs/../../etc/passwd'), false)

  assert.equal(countsTowardWatchdog('read', WATCHDOG_COUNTING_MODES.READ_ONLY), true)
  assert.equal(countsTowardWatchdog('dispatch_task', WATCHDOG_COUNTING_MODES.ALL), false, 'dispatching is the job')
  assert.equal(countsTowardWatchdog('read_report', WATCHDOG_COUNTING_MODES.ALL), false)
  assert.equal(countsTowardWatchdog('present', WATCHDOG_COUNTING_MODES.ALL), false)
  assert.equal(countsTowardWatchdog('todo_write', WATCHDOG_COUNTING_MODES.ALL), false)
  assert.equal(countsTowardWatchdog('todo_write', WATCHDOG_COUNTING_MODES.READ_ONLY), false)
  assert.equal(countsTowardWatchdog('skill', WATCHDOG_COUNTING_MODES.ALL), true, 'a non-read, non-job call is counted')
  assert.equal(countsTowardWatchdog('skill', WATCHDOG_COUNTING_MODES.READ_ONLY), false)

  const defaults = resolveGuardConfig()
  assert.equal(defaults.watchdogThreshold, WATCHDOG_SILENT_THRESHOLD)
  assert.equal(defaults.readQuota, READ_QUOTA_PER_EPOCH)
  assert.equal(defaults.maxInterventions, MAX_FORCED_INTERVENTIONS_PER_TURN)
  assert.equal(defaults.mainPreset, 'discipline-whale')
  assert.equal(resolveGuardConfig({ readQuota: -3 }).readQuota, READ_QUOTA_PER_EPOCH, 'junk falls back, never throws')
  assert.equal(resolveGuardConfig({ maxInterventions: 0 }).maxInterventions, 0, '0 is a legal "never intervene"')

  // The refusal texts are the product here: they must name the limit and the
  // way out, not merely fail.
  assert.match(quotaExhaustedReason(10), /0 of 10/)
  assert.match(quotaExhaustedReason(10), /dispatch_task/)
  assert.match(quotaExhaustedReason(10), /refreshes/)
  const scopeText = readScopeReason('/elsewhere/secret.js', { home: '/h', workspaceRoots: ['/w'] })
  assert.match(scopeText, /outside the main session's read scope/)
  assert.match(scopeText, /dispatch a worker/)
  // Producing output is not investigating. Every render/builder tool hands the
  // user a finished artefact and adds nothing to the main session's knowledge of
  // the codebase, so counting it would make the watchdog abort a delivery that
  // is doing exactly what it should.
  for (const producer of [
    'render_ui',
    'render_scene',
    'render_text',
    'render_canvas',
    'render_mechanism',
    'preview_video',
    'render_video',
    'process_video',
    'synthesize_voice',
    'update_ui',
    'patch_ui',
    'validate_ui',
    'inspect_ui',
    'ui_catalog',
    'excel_create',
    'excel_update',
    'word_create',
    'word_update',
    'ppt_create',
  ]) {
    assert.equal(
      countsTowardWatchdog(producer, WATCHDOG_COUNTING_MODES.ALL),
      false,
      `${producer} produces output; counting it would abort a normal delivery`,
    )
    assert.equal(countsTowardWatchdog(producer, WATCHDOG_COUNTING_MODES.READ_ONLY), false)
  }
  // Reading an artefact back IS investigation: it pulls content into context.
  for (const reader of ['excel_read', 'word_read', 'ppt_read', 'inspect_video']) {
    assert.equal(countsTowardWatchdog(reader, WATCHDOG_COUNTING_MODES.ALL), true, `${reader} reads, it does not produce`)
  }

  // The four render tools named by the product decision must be present by name,
  // not merely "the render family is fine". A regression that drops one of them
  // is exactly what shipped once already.
  for (const named of ['render_ui', 'render_scene', 'render_text', 'render_canvas']) {
    assert.equal(PRODUCTIVITY_TOOLS.has(named), true, `${named} must be in PRODUCTIVITY_TOOLS by name`)
  }
  console.log(
    `ok 1 — whitelist, watchdog accounting (${PRODUCTIVITY_TOOLS.size} exempt, 4 render tools named), defaults and refusal texts`,
  )
}

/* ------------------------------------------------------------------ *
 * 2. quota: the 11th read is refused, and the refusal explains itself
 * ------------------------------------------------------------------ */

{
  const { call, mainAgent } = mountGuard({ maxInterventions: 0 })
  const agent = mainAgent('main-quota')
  for (let index = 1; index <= READ_QUOTA_PER_EPOCH; index += 1) {
    const result = await call(agent, 'read', { file_path: join(root, 'discipline-whale', 'home', `note-${index}.md`) })
    assert.equal(result.decision, 'allow', `read ${index} must be allowed`)
  }
  const eleventh = await call(agent, 'read', { file_path: join(root, 'discipline-whale', 'home', 'note-11.md') })
  assert.equal(eleventh.decision, 'deny', 'the 11th read must be refused')
  assert.equal(eleventh.reachedBody, false, 'a refused read must not reach the tool body')
  assert.match(eleventh.reason, /0 of 10/, 'the refusal states the remaining budget')
  assert.match(eleventh.reason, /dispatch_task/, 'the refusal says what to do instead')
  assert.match(eleventh.reason, /Stop reading now/)

  // The refusal is per read call, not per file: even the same file is refused,
  // so the model cannot reinterpret the limit as "read something else".
  const again = await call(agent, 'read', { file_path: join(root, 'discipline-whale', 'home', 'note-1.md') })
  assert.equal(again.decision, 'deny', 'the quota does not reset just because a different call runs')
  console.log('ok 2 — the 11th read is refused with a self-explaining reason')
}

/* ------------------------------------------------------------------ *
 * 3. a reply refreshes the quota; a worker never sees the quota
 * ------------------------------------------------------------------ */

{
  const { call, saySomething, think, mainAgent } = mountGuard({ maxInterventions: 0 })
  const agent = mainAgent('main-refresh')
  for (let index = 0; index < READ_QUOTA_PER_EPOCH; index += 1) {
    await call(agent, 'read', { file_path: join(root, 'discipline-whale', 'home', 'x.md') })
  }
  assert.equal((await call(agent, 'read', { file_path: join(root, 'discipline-whale', 'home', 'y.md') })).decision, 'deny')

  saySomething(agent)
  const after = await call(agent, 'read', { file_path: join(root, 'discipline-whale', 'home', 'z.md') })
  assert.equal(after.decision, 'allow', 'user-visible text refreshes the quota')

  // Reasoning and tool-call deltas are NOT replies: thinking must not refresh
  // the budget, or a silent chain-of-thought would read forever.
  const spent = mainAgent('main-thinking')
  for (let index = 0; index < READ_QUOTA_PER_EPOCH; index += 1) {
    await call(spent, 'read', { file_path: join(root, 'discipline-whale', 'home', 't.md') })
  }
  think(spent)
  assert.equal(
    (await call(spent, 'read', { file_path: join(root, 'discipline-whale', 'home', 't2.md') })).decision,
    'deny',
    'reasoning deltas do not count as a reply',
  )
  saySomething(spent)
  assert.equal(
    (await call(spent, 'read', { file_path: join(root, 'discipline-whale', 'home', 't3.md') })).decision,
    'allow',
    'an actual text chunk does',
  )


  // A worker preset Agent shares the process and this very listener: it must be
  // invisible to every brake. `maxInterventions: 0` makes any counting obvious.
  const worker = mainAgent('worker-1', 'discipline-whale-worker', join(root, 'repo-a'))
  for (let index = 0; index < READ_QUOTA_PER_EPOCH * 3; index += 1) {
    const result = await call(worker, 'read', { file_path: join(root, 'repo-a', 'src', 'deep', `f${index}.js`) })
    assert.equal(result.decision, 'allow', 'a worker reads dozens of source files and is never throttled')
    assert.equal(result.reachedBody, true)
  }
  for (let index = 0; index < WATCHDOG_SILENT_THRESHOLD * 2; index += 1) {
    await call(worker, 'grep', { pattern: 'x', path: join(root, 'repo-a') })
  }
  assert.equal(worker.cancelled.length, 0, 'a worker turn is never hard-stopped')
  assert.equal(worker.steered.length, 0, 'a worker is never steered by the main-session brakes')
  console.log('ok 3 — a reply refreshes the quota; the worker preset is untouched by all three')
}

/* ------------------------------------------------------------------ *
 * 4. watchdog: N silent calls hard-stop, inject, and reset the quota
 * ------------------------------------------------------------------ */

{
  const { call, mainAgent, handle } = mountGuard()
  const agent = mainAgent('main-watchdog')
  const home = join(root, 'discipline-whale', 'home')

  for (let index = 1; index < WATCHDOG_SILENT_THRESHOLD; index += 1) {
    const result = await call(agent, 'read', { file_path: join(home, `r${index}.md`) })
    assert.equal(result.decision, 'allow', `silent call ${index} is still allowed`)
    assert.equal(agent.cancelled.length, 0)
  }
  const tenth = await call(agent, 'read', { file_path: join(home, 'r10.md') })
  assert.equal(tenth.decision, 'cancel', 'the threshold call cancels the turn instead of running')
  assert.equal(tenth.reachedBody, false)
  assert.equal(agent.cancelled.length, 1, 'the turn is hard-stopped exactly once')
  assert.deepEqual(agent.cancelled[0].cause.kind, 'hook')
  assert.equal(agent.cancelled[0].options.keepInbox, true, 'queued user input must survive the stop')
  assert.equal(agent.steered.length, 1, 'a prompt is injected after the stop')
  assert.match(agent.steered[0].content[0].text, /Hard stop: 10 tool calls/)
  assert.match(agent.steered[0].content[0].text, /Do not read any more files/)
  assert.match(agent.steered[0].content[0].text, /dispatch_task/)
  assert.match(agent.steered[0].content[0].text, /reset to 10/, 'the injected prompt must reset the quota')
  assert.equal(agent.steered[0].source.kind, 'plugin:discipline-whale')

  // The reset is real, not just promised in the text: the read budget had been
  // fully spent before the stop, and nine more reads are now allowed instead of
  // refused. (The tenth would trip the watchdog again on its own budget.)
  const state = handle.sessions.get('main-watchdog')
  assert.equal(state.reads, 0, 'the quota counter restarted at zero')
  assert.equal(state.silent, 0, 'the silence counter restarted at zero')
  for (let index = 1; index <= READ_QUOTA_PER_EPOCH - 1; index += 1) {
    const result = await call(agent, 'read', { file_path: join(root, 'repo-a', 'README.md') })
    assert.equal(result.decision, 'allow', 'after the reset the read budget is available again')
  }
  console.log('ok 4 — 10 silent calls cancel the turn, inject the forced-reply prompt, and reset the quota')
}

/* ------------------------------------------------------------------ *
 * 5. anti-loop: the brake spends its budget, then stands down for good
 * ------------------------------------------------------------------ */

{
  const { call, mainAgent, userTurn } = mountGuard()
  const agent = mainAgent('main-loop')
  const home = join(root, 'discipline-whale', 'home')

  // Two interventions are allowed (MAX_FORCED_INTERVENTIONS_PER_TURN).
  for (let round = 0; round < MAX_FORCED_INTERVENTIONS_PER_TURN; round += 1) {
    for (let index = 0; index < WATCHDOG_SILENT_THRESHOLD; index += 1) {
      await call(agent, 'read', { file_path: join(home, `loop-${round}-${index}.md`) })
    }
  }
  assert.equal(agent.cancelled.length, MAX_FORCED_INTERVENTIONS_PER_TURN, 'the stop fires once per allowance')

  // Round three: the budget is spent. It must NOT cancel again.
  for (let index = 0; index < WATCHDOG_SILENT_THRESHOLD; index += 1) {
    await call(agent, 'read', { file_path: join(root, 'repo-a', 'README.md') })
  }
  assert.equal(agent.cancelled.length, MAX_FORCED_INTERVENTIONS_PER_TURN, 'no third hard stop: no infinite loop')
  const standDown = agent.steered.filter((message) => /已停止干预|stood down/.test(message.content[0].text))
  assert.equal(standDown.length, 1, 'the user is told once that intervention stopped')

  // Further silent calls must not repeat the announcement.
  await call(agent, 'read', { file_path: join(root, 'repo-a', 'README.md') })
  const again = agent.steered.filter((message) => /已停止干预|stood down/.test(message.content[0].text))
  assert.equal(again.length, 1, 'the stand-down is announced exactly once')

  // A real user message re-arms everything, including the brake budget.
  userTurn(agent)
  for (let index = 0; index < WATCHDOG_SILENT_THRESHOLD; index += 1) {
    await call(agent, 'read', { file_path: join(root, 'repo-a', 'README.md') })
  }
  assert.equal(agent.cancelled.length, MAX_FORCED_INTERVENTIONS_PER_TURN + 1, 'a new user turn re-arms the brake')
  console.log('ok 5 — after the intervention budget the brake stops intervening, tells the user once, then re-arms')
}

/* ------------------------------------------------------------------ *
 * 6. path scope: home free, public docs allowed, everything else refused
 * ------------------------------------------------------------------ */

{
  const { call, mainAgent } = mountGuard({ maxInterventions: 0 })
  const agent = mainAgent('main-scope', 'discipline-whale', join(root, 'discipline-whale', 'home'))
  const home = join(root, 'discipline-whale', 'home')
  const repoA = join(root, 'repo-a')
  await mkdir(join(repoA, 'src'), { recursive: true })
  await mkdir(join(repoA, 'docs'), { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(repoA, 'README.md'), '# repo a\n', 'utf8')
  await writeFile(join(repoA, 'docs', 'guide.md'), '# guide\n', 'utf8')
  await writeFile(join(repoA, 'src', 'secret.js'), 'secret\n', 'utf8')
  await writeFile(join(repoA, 'package.json'), '{}\n', 'utf8')
  await writeFile(join(root, 'outside.txt'), 'outside\n', 'utf8')

  const allowed = async (name, args, why) => {
    const result = await call(agent, name, args)
    assert.equal(result.decision, 'allow', `${name} ${args.file_path ?? args.path} must be allowed: ${why}`)
    assert.equal(result.reachedBody, true)
  }
  const refused = async (name, args, why) => {
    const result = await call(agent, name, args)
    assert.equal(result.decision, 'deny', `${name} on ${args.file_path ?? args.path} must be refused: ${why}`)
    assert.equal(result.reachedBody, false)
    assert.match(result.reason, /outside the main session's read scope/, 'the refusal speaks, it does not fail silently')
    assert.match(result.reason, /dispatch a worker/)
  }

  // The main session's own home is fully readable: source, config, anything.
  await mkdir(join(home, 'notes'), { recursive: true })
  await writeFile(join(home, 'scratch.js'), 'x\n', 'utf8')
  await writeFile(join(home, 'notes', 'chart.json'), '{}\n', 'utf8')
  await allowed('read', { file_path: join(home, 'scratch.js') }, 'own home is unrestricted')
  await allowed('read', { file_path: join(home, 'notes', 'chart.json') }, 'own home, nested')
  await allowed('read', { file_path: 'scratch.js' }, 'a relative path resolves against the home cwd')

  await allowed('read', { file_path: join(repoA, 'README.md') }, 'public document')
  await allowed('read', { file_path: join(repoA, 'docs', 'guide.md') }, 'public document in docs/')
  await allowed('read', { file_path: join(repoA, 'package.json') }, 'manifest, to judge the stack')

  await refused('read', { file_path: join(repoA, 'src', 'secret.js') }, 'source code in a workspace')
  await refused('read', { file_path: join(root, 'outside.txt') }, 'not in any workspace')
  await refused('read', { file_path: '../../etc/passwd' }, 'relative traversal escapes the home')
  await refused('read', { file_path: '/etc/passwd' }, 'absolute path outside every root')
  await refused('read', { file_path: join(repoA, 'src', '..', '..', 'outside.txt') }, 'dot-dot inside a component')

  // The tree-walk tools cannot be filtered after the fact, so they are home-only.
  await allowed('grep', { pattern: 'x', path: home }, 'searching your own home')
  await refused('grep', { pattern: 'secret', path: repoA }, 'a repo-wide grep would read every source file')
  await refused('glob', { pattern: '**/*.js', path: repoA }, 'a repo-wide glob is a tree walk')

  // contract/system tools are not file reads at all
  await allowed('list_workspaces', {}, 'not a filesystem read')
  await allowed('dispatch_task', { workspace: 'repo-a', task: 'x' }, 'dispatch is never blocked')
  await allowed('read_report', { report_id: 'r-1' }, 'plugin-stored reports are not workspace files')
  console.log('ok 6 — home free, public documents allowed, source and traversal refused with a reason')
}

/* ------------------------------------------------------------------ *
 * 7. symlinks are judged by their real target, not their name
 * ------------------------------------------------------------------ */

{
  const { call, mainAgent } = mountGuard({ maxInterventions: 0 })
  const agent = mainAgent('main-link', 'discipline-whale', join(root, 'discipline-whale', 'home'))
  const home = join(root, 'discipline-whale', 'home')
  const repoA = join(root, 'repo-a')
  await mkdir(home, { recursive: true })
  await mkdir(join(repoA, 'src'), { recursive: true })
  await writeFile(join(repoA, 'src', 'secret.js'), 'secret\n', 'utf8')

  // A symlink inside the home pointing at a workspace source file: allowed by
  // its name, refused by its target.
  const link = join(home, 'handy-link')
  await symlink(join(repoA, 'src', 'secret.js'), link).catch(() => undefined)
  const viaLink = await call(agent, 'read', { file_path: link })
  assert.equal(viaLink.decision, 'deny', 'a symlink out of the home is judged by its real path')
  assert.match(viaLink.reason, /outside the main session's read scope/)

  // And a public document reached through a link is still a public document.
  const docsLink = join(home, 'readme-link.md')
  await writeFile(join(repoA, 'README.md'), '# a\n', 'utf8')
  await symlink(join(repoA, 'README.md'), docsLink).catch(() => undefined)
  const viaDocs = await call(agent, 'read', { file_path: docsLink })
  assert.equal(viaDocs.decision, 'allow', 'the real target decides, so a public document stays readable')

  // `realPathOf` resolves an existing path and keeps a missing tail.
  assert.equal(await realPathOf(join(root, 'repo-a')), await realPathOf(join(root, 'repo-a')))
  const missing = await realPathOf(join(repoA, 'does', 'not', 'exist.md'))
  assert.match(missing, /does\/not\/exist\.md$/, 'a missing leaf keeps its unresolved tail')
  console.log('ok 7 — symlinks are decided on the resolved target, not the visible name')
}

/* ------------------------------------------------------------------ *
 * 7b. a delivery full of rendered blocks is not "digging in"
 *
 * The defect this guards: with `watchdogCounting: 'all'`, a main session that
 * answers with several rendered blocks calls render_* between text segments.
 * Those calls produce output and teach it nothing, yet the watchdog counted
 * them, so a normal multi-block delivery was aborted mid-answer at the tenth
 * one. This test renders MORE blocks than the threshold on purpose.
 * ------------------------------------------------------------------ */

{
  const { call, mainAgent, handle } = mountGuard()
  const agent = mainAgent('main-delivery')
  const home = join(root, 'discipline-whale', 'home')
  const renders = [
    'render_text',
    'render_ui',
    'render_scene',
    'render_canvas',
    'render_mechanism',
    'render_text',
    'render_ui',
    'render_scene',
    'render_canvas',
    'render_mechanism',
    'render_ui',
    'render_text',
  ]
  assert.ok(renders.length > WATCHDOG_SILENT_THRESHOLD, 'the delivery must exceed the threshold to be a real test')

  for (const [index, name] of renders.entries()) {
    const result = await call(agent, name, { title: `block ${index}` })
    assert.equal(result.decision, 'allow', `${name} #${index + 1} of a normal delivery must not be stopped`)
    assert.equal(result.reachedBody, true)
  }
  assert.equal(agent.cancelled.length, 0, 'rendering twelve blocks must never hard-stop the turn')
  assert.equal(agent.steered.length, 0, 'and must never inject a forced-reply prompt')
  assert.equal(handle.sessions.get('main-delivery').silent, 0, 'renders do not accumulate watchdog silence')

  // The brake is not merely disabled: real investigation still trips it, so the
  // fix narrows the counter instead of turning the watchdog off.
  for (let index = 0; index < WATCHDOG_SILENT_THRESHOLD; index += 1) {
    await call(agent, 'read', { file_path: join(home, `probe-${index}.md`) })
  }
  assert.equal(agent.cancelled.length, 1, 'ten silent reads still hard-stop: the watchdog itself is intact')
  console.log('ok 7b — twelve rendered blocks deliver without a hard stop; ten silent reads still trip it')
}

/* ------------------------------------------------------------------ *
 * 8. the pure classifier, without any Host
 * ------------------------------------------------------------------ */

{
  const home = '/home/whale'
  const repo = '/repos/a'
  assert.deepEqual(classifyReadPath('/home/whale/x', { homeReal: home, workspaceRoots: [repo] }), {
    allowed: true,
    zone: 'home',
  })
  assert.equal(classifyReadPath('/repos/a/README.md', { homeReal: home, workspaceRoots: [repo] }).allowed, true)
  assert.equal(classifyReadPath('/repos/a/src/x.ts', { homeReal: home, workspaceRoots: [repo] }).allowed, false)
  assert.equal(classifyReadPath('/home/whale-evil/x', { homeReal: home, workspaceRoots: [] }).allowed, false, 'a sibling with a shared prefix is not inside the home')
  assert.equal(classifyReadPath('/repos/ab/README.md', { homeReal: home, workspaceRoots: [repo] }).allowed, false, 'same prefix rule for workspaces')
  console.log('ok 8 — the classifier uses path-segment containment, not string prefixes')
}

/* ------------------------------------------------------------------ *
 * 9. delivery through the REAL scope machinery
 *
 * Everything above drives the handlers directly, which proves the logic but
 * not that a preset-mounted row ever *receives* the events. That is exactly
 * the failure this section exists to catch: `session/event` is dispatched on
 * the host plane with no scope key, so a scoped listener is filtered out and
 * would never fire. These assertions use the same cordis + dsh-scope packages
 * the Harness runs, and build the same scope graph an Agent gets:
 *
 *   preset tree  = createScope(app, generationKey)      (mountPreset)
 *   agent scope  = createScope(app, agent)              (AgentLoop)
 *   agent → preset = bindScopeParent(agent, key)        (AgentPresetsService.join)
 *
 * If this section is skipped (packages unavailable) the file still passes, but
 * it prints a loud SKIP so nobody mistakes silence for proof.
 * ------------------------------------------------------------------ */

{
  let cordis
  let scopeApi
  try {
    cordis = await import('/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/cordis/lib/index.js')
    scopeApi = await import('/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/dsh-scope/lib/index.js')
  } catch {
    cordis = undefined
  }

  if (cordis === undefined) {
    console.log('SKIP 9 — the DSH packages are not installed at the expected path; scope delivery NOT verified')
  } else {
    const { createScope, scopeTarget, bindScopeParent } = scopeApi
    const app = new cordis.Context()

    // The preset tree, mounted once at boot.
    const generationKey = {}
    const preset = createScope(app, generationKey)

    // The guard is installed by a row inside that preset — the real mount path.
    const inner = new Map()
    const presetCtx = {
      logger: { warn() {} },
      on: (event, handler) => {
        const list = inner.get(event) ?? []
        list.push(handler)
        inner.set(event, list)
        return () => {}
      },
      get: (name) => (name === 'workspaceRegistry' ? { list: () => [] } : undefined),
    }
    installGuard(presetCtx, { maxInterventions: 0 }, {
      storeRoot: () => root,
      whaleHomeDir: () => join(root, 'discipline-whale', 'home'),
      workspaceRegistry: () => ({ list: () => [] }),
    })
    // Re-register on the REAL scoped context so delivery is what is tested.
    for (const [event, handlers] of inner) for (const handler of handlers) preset.ctx.on(event, handler)

    // One main-session Agent, scoped exactly as the Harness scopes it.
    const agent = {
      steered: [],
      cancelled: [],
      session: { id: 'scope-main', header: { agentPreset: 'discipline-whale', cwd: join(root, 'discipline-whale', 'home') } },
      cancel(cause) {
        agent.cancelled.push(cause)
      },
      steer(message) {
        agent.steered.push(message)
      },
    }
    createScope(app, agent)
    bindScopeParent(agent, generationKey)

    /** Dispatch one tool call through the real scoped waterfall. */
    const toolCall = async (name, args, who = agent) => {
      let reached = false
      const carrier = scopeTarget({ id: 'tools' }, who)
      const decision = app.events.waterfall(
        carrier,
        'tools/pre-execute',
        { callId: 'c1', name, arguments: args, agent: who, signal: new AbortController().signal },
        async () => {
          reached = true
          return { kind: 'allow' }
        },
      )
      const resolved = await decision
      return { decision: resolved.kind, reason: resolved.reason, reached }
    }

    // Reachable: an agent-keyed stream frame refreshes the quota.
    const home = join(root, 'discipline-whale', 'home')
    for (let index = 0; index < READ_QUOTA_PER_EPOCH; index += 1) {
      const result = await toolCall('read', { file_path: join(home, `s${index}.md`) })
      assert.equal(result.decision, 'allow', 'scope-delivered pre-execute allows the first ten reads')
    }
    const refused = await toolCall('read', { file_path: join(home, 's11.md') })
    assert.equal(refused.decision, 'deny', 'the real scope path reaches the quota gate')

    app.emit(scopeTarget({ id: 'loop' }, agent), 'agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'answer' } },
    })
    const refreshed = await toolCall('read', { file_path: join(home, 's12.md') })
    assert.equal(refreshed.decision, 'allow', 'a preset listener RECEIVES agent/assistant-stream through the real scope graph')

    // Not reachable — proving why the implementation does not listen for it.
    let hostPlaneHits = 0
    preset.ctx.on('session/event', () => {
      hostPlaneHits += 1
    })
    app.emit(scopeTarget({ id: 'sessions' }, undefined), 'session/event', { id: 'scope-main' }, { type: 'turn/start' })
    assert.equal(hostPlaneHits, 0, 'session/event does NOT reach a preset listener — the reason for agent-keyed wiring')

    // And a worker-preset Agent in the same process is untouched.
    const worker = {
      steered: [],
      cancelled: [],
      session: { id: 'scope-worker', header: { agentPreset: 'discipline-whale-worker', cwd: join(root, 'repo-a') } },
      cancel(cause) {
        worker.cancelled.push(cause)
      },
      steer(message) {
        worker.steered.push(message)
      },
    }
    createScope(app, worker)
    bindScopeParent(worker, generationKey)
    for (let index = 0; index < READ_QUOTA_PER_EPOCH * 2; index += 1) {
      const result = await toolCall('read', { file_path: join(root, 'repo-a', 'src', `w${index}.js`) }, worker)
      assert.equal(result.decision, 'allow', 'a worker in the same process reads freely')
    }
    assert.equal(worker.cancelled.length, 0)
    assert.equal(worker.steered.length, 0)
    console.log('ok 9 — the real scope graph delivers the agent-keyed signals; session/event provably does not')
  }
}

await rm(root, { recursive: true, force: true })
console.log('\nAll discipline-whale guard checks passed.')
