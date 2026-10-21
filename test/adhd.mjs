/**
 * Brevity tests: the ADHD output discipline, main preset only.
 *
 * Three properties are proved here, in the order they matter:
 *
 *   1. the pure decisions (`isUiTurn`, `shouldEnforceBrevity`,
 *      `resolveBrevityConfig`, `countTextInArgs`) — no Host, no listeners, so
 *      "UI deliverables are exempt, prose is not" is decided by functions
 *      rather than scattered through a handler;
 *   2. the scope — the main preset assembles the rules and can load the skill,
 *      the worker preset gets neither, and a worker Agent reaching a hook is
 *      passed straight through `next()` without a counter being created;
 *   3. the mechanism is two injections: over-long prose earns one reminder on
 *      the *next* step, an over-long final answer earns one rewrite at turn end,
 *      a UI turn earns neither, and the tool gate never denies anything (it
 *      must not touch the guard's brakes).
 *
 * Run: node test/adhd.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MAX_CORRECTIONS,
  DEFAULT_MAX_PROSE_CHARS,
  REWRITE_NOTICE_SUMMARY,
  RULES_SECTION_NAME,
  SKILL_NAME,
  TEXT_CHANNEL_TOOLS,
  UI_EXEMPT_TOOLS,
  apply,
  brevityNotice,
  countTextInArgs,
  decisionShapeContract,
  installBrevity,
  isDecisionTurn,
  isBrevityInstalled,
  isUiTurn,
  loadRules,
  resolveBrevityConfig,
  shouldEnforceBrevity,
} from '../adhd.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_MODULES = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'

const hostUrl = (specifier) => new URL(`file://${join(HOST_MODULES, specifier)}`).href

/* ------------------------------------------------------------------ *
 * 1. isUiTurn — the exemption predicate
 * ------------------------------------------------------------------ */

{
  for (const tool of ['render_ui', 'render_canvas', 'render_scene', 'render_mechanism']) {
    assert.equal(isUiTurn([tool]), true, `${tool} is a UI deliverable`)
    assert.equal(isUiTurn([{ name: tool }]), true, `${tool} is recognised in {name} form too`)
  }
  assert.equal(isUiTurn([]), false, 'a turn with no tools delivers nothing but prose')
  assert.equal(isUiTurn(['read', 'dispatch_task']), false, 'reading and dispatching is not a delivery')
  assert.equal(isUiTurn(undefined), false)
  assert.equal(isUiTurn(null), false)

  // The documented anti-loophole: `render_text` renders text, so it stays in
  // the text channel. Wrapping prose in it must not buy an exemption.
  assert.ok(TEXT_CHANNEL_TOOLS.has('render_text'))
  assert.equal(UI_EXEMPT_TOOLS.has('render_text'), false)
  assert.equal(isUiTurn(['render_text']), false, 'render_text must not buy an exemption')

  // A turn that did both is exempt as a whole. This is the declared trade-off:
  // splitting "the explanation around a deliverable" from "the deliverable" is
  // not decidable, and over-correcting a real delivery costs more than missing
  // a chatty aside. Changing this reading means changing this assertion.
  assert.equal(isUiTurn(['read', 'render_canvas']), true, 'one UI deliverable exempts the turn')

  console.log('ok 1 — isUiTurn: UI canvases exempt, prose and render_text do not')
}

/* ------------------------------------------------------------------ *
 * 2. shouldEnforceBrevity — length, exemption and the switch
 * ------------------------------------------------------------------ */

{
  const config = resolveBrevityConfig({ maxProseChars: 100 })

  const short = shouldEnforceBrevity({ toolCalls: [], chars: 100, config })
  assert.equal(short.enforce, false, 'exactly at the limit is inside it')
  assert.equal(short.reason, 'within-limit')

  const long = shouldEnforceBrevity({ toolCalls: [], chars: 140, config })
  assert.equal(long.enforce, true)
  assert.equal(long.reason, 'over-limit')
  assert.equal(long.overBy, 40, 'the decision reports how far over, for the notice')

  const ui = shouldEnforceBrevity({ toolCalls: ['render_ui'], chars: 10_000, config })
  assert.equal(ui.enforce, false, 'a UI turn is exempt however long the surrounding prose is')
  assert.equal(ui.reason, 'ui-deliverable')

  const textTool = shouldEnforceBrevity({ toolCalls: ['render_text'], chars: 0, config })
  assert.equal(textTool.enforce, false, 'an empty prose turn is not over the limit even with render_text')

  const disabled = shouldEnforceBrevity({
    toolCalls: [],
    chars: 10_000,
    config: resolveBrevityConfig({ enabled: false }),
  })
  assert.equal(disabled.enforce, false)
  assert.equal(disabled.reason, 'disabled')

  // Zero is a legal reading of "no prose at all".
  assert.equal(resolveBrevityConfig({ maxProseChars: 0 }).maxProseChars, 0)
  assert.equal(
    shouldEnforceBrevity({ toolCalls: [], chars: 0, config: resolveBrevityConfig({ maxProseChars: 0 }) }).enforce,
    false,
  )
  assert.equal(
    shouldEnforceBrevity({ toolCalls: [], chars: 1, config: resolveBrevityConfig({ maxProseChars: 0 }) }).enforce,
    true,
  )

  console.log('ok 2 — shouldEnforceBrevity decides length, exemption and the switch in one place')
}

/* ------------------------------------------------------------------ *
 * 3. resolveBrevityConfig — named defaults, overridable, fail-safe
 * ------------------------------------------------------------------ */

{
  const defaults = resolveBrevityConfig()
  assert.equal(defaults.maxProseChars, DEFAULT_MAX_PROSE_CHARS)
  assert.equal(defaults.maxCorrections, DEFAULT_MAX_CORRECTIONS)
  assert.equal(defaults.mainPreset, 'discipline-whale')
  assert.equal(defaults.enabled, true)

  const tuned = resolveBrevityConfig({ maxProseChars: 200, maxCorrections: 0, enabled: false })
  assert.equal(tuned.maxProseChars, 200)
  assert.equal(tuned.maxCorrections, 0, 'zero corrections is legal and means "never inject"')
  assert.equal(tuned.enabled, false)

  // Invalid values fall back instead of throwing, exactly like `resolveGuardConfig`:
  // a bad knob must never take the main row down with it.
  for (const bad of [-5, 1.5, 'many', null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      resolveBrevityConfig({ maxProseChars: bad }).maxProseChars,
      DEFAULT_MAX_PROSE_CHARS,
      `maxProseChars ${JSON.stringify(bad)} must fall back, not throw`,
    )
  }
  for (const bad of [-1, 2.5, 'one', Number.NaN]) {
    assert.equal(
      resolveBrevityConfig({ maxCorrections: bad }).maxCorrections,
      DEFAULT_MAX_CORRECTIONS,
      `maxCorrections ${JSON.stringify(bad)} must fall back`,
    )
  }
  assert.equal(resolveBrevityConfig(null).maxProseChars, DEFAULT_MAX_PROSE_CHARS)
  assert.equal(resolveBrevityConfig([]).maxProseChars, DEFAULT_MAX_PROSE_CHARS)

  // The preset identity is pinned by the caller's fallback, not by row config:
  // a main row that names itself a worker must not move the brake.
  assert.equal(
    resolveBrevityConfig({ mainPreset: 'other' }, { mainPreset: 'discipline-whale' }).mainPreset,
    'discipline-whale',
  )

  console.log('ok 3 — resolveBrevityConfig: named defaults, overridable, invalid values fall back')
}

/* ------------------------------------------------------------------ *
 * 4. the rules file is the single source for prompt and skill
 * ------------------------------------------------------------------ */

{
  const { body, meta } = loadRules()
  assert.ok(body.includes('第一句就是下一步'), 'the rules body carries the lead-with-action rule')
  assert.ok(body.includes('UI 交付物豁免'), 'the rules body carries the UI exemption section')
  assert.ok(body.includes('i-have-adhd'), 'the rules body keeps the upstream attribution')
  assert.equal(meta.upstream, 'https://github.com/ayghri/i-have-adhd')
  assert.equal(meta['upstream-license'], 'MIT')
  assert.ok(!body.startsWith('---'), 'frontmatter is stripped from the injected body')
  assert.equal(SKILL_NAME, 'whale-brevity')
  assert.ok(RULES_SECTION_NAME.includes('brevity'), 'the prompt section has a stable, identifiable name')

  const raw = await readFile(join(HERE, '..', 'skills', SKILL_NAME, 'SKILL.md'), 'utf8')
  assert.ok(raw.startsWith('---'), 'the skill file keeps its frontmatter for the skill registry')
  assert.ok(raw.includes(`name: ${SKILL_NAME}`), 'the skill frontmatter declares the registered name')

  console.log('ok 4 — the skill file is the single source for both the catalog entry and the prompt section')
}

/* ------------------------------------------------------------------ *
 * 5. countTextInArgs — render_text stays measured
 * ------------------------------------------------------------------ */

{
  assert.equal(countTextInArgs('render_text', { text: 'abc' }), 3)
  assert.equal(countTextInArgs('render_text', { blocks: [{ type: 'text', text: 'abcd' }] }), 4)
  assert.equal(countTextInArgs('render_text', { text: 'ab', blocks: [{ text: 'cde' }] }), 5)
  assert.equal(countTextInArgs('render_ui', { text: 'not prose' }), 0, 'only text-channel tools are measured')
  assert.equal(countTextInArgs('read', { file_path: '/a/very/long/path' }), 0)
  assert.equal(countTextInArgs('render_text', undefined), 0)
  assert.equal(countTextInArgs('render_text', { text: 42 }), 0, 'non-strings contribute nothing')

  console.log('ok 5 — countTextInArgs: prose carried by render_text still counts toward the limit')
}

/* ------------------------------------------------------------------ *
 * 6. the assembled prompts: main has it, worker does not
 * ------------------------------------------------------------------ */

{
  const { assemblePresetPrompt } = await import('../prompt-probe.mjs')

  const main = await assemblePresetPrompt('discipline-whale')
  for (const needle of ['第一句就是下一步', 'UI 交付物豁免', 'render_text', '不要开场白', 'i-have-adhd']) {
    assert.ok(main.includes(needle), `the main prompt must carry ${JSON.stringify(needle)}`)
  }

  const worker = await assemblePresetPrompt('discipline-whale-worker')
  assert.ok(worker.includes('Discipline Whale worker'), 'the worker prompt is the worker persona')
  for (const needle of ['UI 交付物豁免', '第一句就是下一步', 'i-have-adhd', 'whale-brevity']) {
    assert.ok(!worker.includes(needle), `the worker prompt must NOT carry ${JSON.stringify(needle)}`)
  }

  console.log('ok 6 — the brevity rules reach the main prompt and provably not the worker prompt')
}

/* ------------------------------------------------------------------ *
 * 7. the real skill registry: preset-scoped, never global
 * ------------------------------------------------------------------ */

{
  const { Context } = await import(hostUrl('@deepseek-ai/cordis/lib/index.js'))
  const { SkillRegistry } = await import(hostUrl('@deepseek-ai/dsh-skill/lib/index.js'))
  const { SystemPrompt } = await import(hostUrl('@deepseek-ai/dsh-system-prompt/lib/index.js'))
  const { createScope, bindScopeParent } = await import(hostUrl('@deepseek-ai/dsh-scope/lib/index.js'))

  const app = new Context()
  new SkillRegistry(app, {})
  new SystemPrompt(app, {})

  // Main preset generation mounts the row; the worker generation mounts nothing.
  const mainGenKey = {}
  const mainGen = createScope(app, mainGenKey)
  await mainGen.ctx.plugin({ name: 'adhd', inject: ['systemPrompt', 'skills'], apply }).await()

  const workerGenKey = {}
  const workerGen = createScope(app, workerGenKey)

  // Agents parent to their preset generation, exactly as AgentPresetsService.bind does.
  const mainAgentKey = {}
  bindScopeParent(mainAgentKey, mainGenKey)
  const workerAgentKey = {}
  bindScopeParent(workerAgentKey, workerGenKey)

  const skills = app.get('skills')
  const mainNames = (await skills.list({ scope: mainAgentKey })).map((skill) => skill.name)
  const workerNames = (await skills.list({ scope: workerAgentKey })).map((skill) => skill.name)
  const globalNames = (await skills.list({})).map((skill) => skill.name)

  assert.ok(mainNames.includes(SKILL_NAME), `the main catalog must carry ${SKILL_NAME}, got ${JSON.stringify(mainNames)}`)
  assert.ok(!workerNames.includes(SKILL_NAME), `the worker catalog must not carry ${SKILL_NAME}, got ${JSON.stringify(workerNames)}`)
  assert.ok(!globalNames.includes(SKILL_NAME), `never registered globally, got ${JSON.stringify(globalNames)}`)
  assert.ok(
    (await skills.get(SKILL_NAME, { scope: mainAgentKey }))?.content.includes('UI 交付物豁免'),
    'the main session can load the full rules body',
  )
  assert.equal(await skills.get(SKILL_NAME, { scope: workerAgentKey }), undefined, 'a worker cannot load it')
  assert.equal(await skills.get(SKILL_NAME, {}), undefined, 'the host plane cannot load it')

  await mainGen.dispose()
  await workerGen.dispose()

  console.log('ok 7 — the skill lands in the main preset scope only: main sees it, worker and host do not')
}

/* ------------------------------------------------------------------ *
 * 8. the hook: worker passthrough, main correction, UI exemption
 * ------------------------------------------------------------------ */

/**
 * Mount the brevity row against a fake Host that speaks the real event shapes.
 *
 * **Both rows are mounted, always.** `preset-discipline-whale` carries two rows
 * that each ask for this discipline: `discipline-whale-main` (which calls
 * `installBrevity` from `main.js`) and `discipline-whale-brevity` (which calls
 * it from `adhd.js`'s own `apply`). Every real Session gets both. A harness that
 * mounted only one of them was a fiction: it could not see that the pair
 * installed two listener sets, and so one over-long reply produced two
 * corrections while `maxCorrections` said one.
 *
 * The two row contexts are distinct objects that share one `fiber.parent`, which
 * is exactly the topology cordis gives sibling rows in a preset scope — so the
 * dedupe key is exercised, not bypassed. `installs` records what each row did:
 * the second must report `installed: false` and register nothing.
 *
 * `agent/pre-step` is a waterfall: `next()` returns the default decision and a
 * listener returns `{...decision, messages}` to append. `tools/pre-execute` is a
 * waterfall too, and this row must always let it through untouched.
 */
function mountBrevity(config = {}) {
  const listeners = new Map()
  /** event -> number of handlers registered by the brevity discipline */
  const registrations = new Map()
  /** The scope-owning fiber both sibling rows hang off. */
  const scopeFiber = { kind: 'preset-scope' }

  const makeRowContext = () => ({
    logger: { warn() {} },
    fiber: { parent: scopeFiber },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (event, handler) => {
      registrations.set(event, (registrations.get(event) ?? 0) + 1)
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  })

  // Row 1: the main row. Row 2: the brevity row. Same preset scope.
  const handle = installBrevity(makeRowContext(), config)
  const second = installBrevity(makeRowContext(), config)

  const emit = (name, payload) => {
    for (const handler of listeners.get(name) ?? []) handler(payload)
  }

  /** One visible assistant text chunk, as AgentLoop emits it. */
  const say = (agent, text) =>
    emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text } },
    })

  /** One tool call through the real pre-execute waterfall. */
  const callTool = async (agent, name, args = {}) => {
    const handlers = listeners.get('tools/pre-execute') ?? []
    let index = 0
    let reached = false
    const run = async () => {
      if (index < handlers.length) return handlers[index++]({ name, arguments: args, agent }, run)
      reached = true
      return { kind: 'allow' }
    }
    const decision = await run()
    return { decision, reached }
  }

  /** One step boundary, returning the messages the row appended. */
  const preStep = async (agent) => {
    const handlers = listeners.get('agent/pre-step') ?? []
    const base = { kind: 'enter', messages: [] }
    let index = 0
    const run = async () => {
      if (index < handlers.length) return handlers[index++]({ agent, turn: 1, step: 1 }, run)
      return base
    }
    const decision = await run()
    return decision.messages ?? []
  }

  const userTurn = (agent, message = { source: { kind: 'user' } }) =>
    emit('agent/inbox/claimed', { agent, message })

  /** The opening frame of one model attempt (a new step, or a retry). */
  const start = (agent, step = 1) => emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 1, step } })

  /** The serial turn-end hook, awaited the way `agent-loop` awaits it. */
  const turnStopping = async (agent, signal = new AbortController().signal) => {
    for (const handler of listeners.get('agent/turn-stopping') ?? []) await handler({ agent, turn: 1, signal })
  }

  return { handle, second, registrations, listeners, emit, say, callTool, preStep, userTurn, start, turnStopping }
}

const mainAgent = (id = 'main-adhd') => ({ session: { id, header: { agentPreset: 'discipline-whale' } } })
const workerAgent = (id = 'worker-adhd') => ({ session: { id, header: { agentPreset: 'discipline-whale-worker' } } })

/** An Agent with a live steer channel, recording what reaches `next-step`. */
const steerable = (agent) => {
  const steered = []
  agent.steer = (message) => steered.push(message)
  return { agent, steered }
}

{
  // --- the worker is never touched -----------------------------------
  const host = mountBrevity({ maxProseChars: 10 })
  const worker = workerAgent('worker-1')

  // A worker saying something enormous must not even be counted.
  for (let i = 0; i < 50; i += 1) host.say(worker, 'this worker report is deliberately very long '.repeat(20))
  assert.equal(host.handle.sessions.has('worker-1'), false, 'a worker Session must never get a counter')

  const appended = await host.preStep(worker)
  assert.equal(appended.length, 0, 'no correction is ever injected into a worker')

  const gate = await host.callTool(worker, 'read', { file_path: '/tmp/x' })
  assert.equal(gate.decision.kind, 'allow')
  assert.equal(gate.reached, true, 'the worker reaches the tool body untouched')

  // An Agent whose preset cannot be read is also left alone: fail open.
  const unknown = { session: { id: 'unknown-1', header: {} } }
  host.say(unknown, 'x'.repeat(500))
  assert.equal(host.handle.sessions.has('unknown-1'), false, 'an unidentifiable Agent gets no counter')
  assert.equal((await host.preStep(unknown)).length, 0)

  console.log('ok 8a — a worker Session is passed through: no counter, no injection, tool gate untouched')
}

{
  // --- the main session gets one reminder, on the next step ----------
  const host = mountBrevity({ maxProseChars: 100, maxCorrections: 1 })
  const main = mainAgent('main-1')

  host.userTurn(main)
  host.say(main, 'x'.repeat(60))
  assert.equal((await host.preStep(main)).length, 0, 'still inside the limit: no reminder')

  host.say(main, 'y'.repeat(60)) // cumulative 120 > 100
  // The reminder cannot rewrite what was already streamed; it arrives next step.
  const first = await host.preStep(main)
  assert.equal(first.length, 1, 'the over-long turn earns exactly one injected reminder')
  const notice = first[0].content?.[0]?.text ?? ''
  assert.ok(notice.includes('超过'), `the reminder must name the overrun, got: ${notice.slice(0, 80)}`)
  assert.ok(notice.includes('3 行'), 'the plain-chat reminder carries the countable target')
  assert.equal(first[0].role, 'user', 'the reminder is a user-role context message')
  assert.equal(first[0].source.kind, 'plugin:discipline-whale:brevity', 'the reminder is attributable')

  // The budget is spent: saying more does not nag again.
  host.say(main, 'z'.repeat(400))
  assert.equal((await host.preStep(main)).length, 0, 'the per-turn correction budget is respected')

  // A new user turn re-arms the budget and clears the measurement.
  host.userTurn(main)
  assert.equal((await host.preStep(main)).length, 0, 'a fresh turn starts inside the limit')
  host.say(main, 'w'.repeat(200))
  assert.equal((await host.preStep(main)).length, 1, 'the next user turn can be corrected again')

  console.log('ok 8b — over-long prose earns one attributed reminder on the next step, capped per user turn')
}

{
  // --- a UI turn is exempt even with a lot of prose around it --------
  const host = mountBrevity({ maxProseChars: 20 })
  const main = mainAgent('main-ui')

  host.userTurn(main)
  const gate = await host.callTool(main, 'render_canvas', { title: 'x', html: '<p>hi</p>', fallback: 'x' })
  assert.equal(gate.decision.kind, 'allow', 'the row never denies a tool call')
  host.say(main, 'y'.repeat(500))
  assert.equal((await host.preStep(main)).length, 0, 'a UI turn is exempt from the length correction')

  // The next turn, without a render, is measured again.
  host.userTurn(main)
  host.say(main, 'z'.repeat(500))
  assert.equal((await host.preStep(main)).length, 1, 'the exemption is per turn, not sticky')

  console.log('ok 8c — a render turn is exempt; the exemption does not leak into the next turn')
}

{
  // --- render_text does not buy an exemption ------------------------
  const host = mountBrevity({ maxProseChars: 50 })
  const main = mainAgent('main-text')

  host.userTurn(main)
  const gate = await host.callTool(main, 'render_text', { blocks: [{ type: 'text', text: 'q'.repeat(300) }] })
  assert.equal(gate.decision.kind, 'allow')
  assert.equal((await host.preStep(main)).length, 1, 'text carried by render_text is measured like prose')

  console.log('ok 8d — render_text stays on the text channel: it neither exempts a turn nor hides its text')
}

{
  // --- knobs: disabled, zero budget, and the tool gate never blocks ---
  const off = mountBrevity({ enabled: false, maxProseChars: 1 })
  const main = mainAgent('main-off')
  off.userTurn(main)
  off.say(main, 'x'.repeat(500))
  assert.equal((await off.preStep(main)).length, 0, '`enabled: false` turns the correction off')

  const zero = mountBrevity({ maxProseChars: 1, maxCorrections: 0 })
  zero.userTurn(mainAgent('main-zero'))
  zero.say(mainAgent('main-zero'), 'x'.repeat(500))
  assert.equal((await zero.preStep(mainAgent('main-zero'))).length, 0, '`maxCorrections: 0` means never inject')

  // Even while a correction is pending, the tool gate allows: this row must
  // never interact with the guard's three brakes.
  const gateHost = mountBrevity({ maxProseChars: 1 })
  const gated = mainAgent('main-gate')
  gateHost.userTurn(gated)
  gateHost.say(gated, 'x'.repeat(100))
  const call = await gateHost.callTool(gated, 'read', { file_path: '/tmp/a' })
  assert.equal(call.decision.kind, 'allow', 'the brevity row never denies or cancels a tool call')
  assert.equal(call.reached, true)

  // Cleanup: a disposed Agent leaves no state behind.
  gateHost.emit('agent/disposed', { agent: gated })
  assert.equal(gateHost.handle.sessions.has('main-gate'), false, 'agent/disposed forgets the Session')

  console.log('ok 8e — knobs behave; the tool gate always allows; disposal forgets the Session')
}

/* ------------------------------------------------------------------ *
 * 8f. idempotence: two rows, one preset scope, one set of hooks
 * ------------------------------------------------------------------ */

// The defect this proves fixed: `discipline-whale-main` calls `installBrevity`
// and the `discipline-whale-brevity` row calls it again from `apply()`. Both are
// non-negotiable — the main row installs it the way it installs the guard, and
// the brevity row owns the prompt section and the skill. So uniqueness has to
// come from the install itself, not from counting call sites. Without the scope
// guard, one over-long reply earned TWO corrections while the budget said one,
// and every reply's characters were counted twice.

{
  // Direct install twice on one scope: the second must register nothing.
  const listeners = new Map()
  const registerCount = new Map()
  const scopeFiber = {}
  const ctxFor = () => ({
    logger: { warn() {} },
    fiber: { parent: scopeFiber },
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on: (event, handler) => {
      registerCount.set(event, (registerCount.get(event) ?? 0) + 1)
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
  })

  const first = installBrevity(ctxFor(), { maxProseChars: 50, maxCorrections: 1 })
  const registrationsAfterFirst = new Map(registerCount)
  const second = installBrevity(ctxFor(), { maxProseChars: 50, maxCorrections: 1 })

  assert.equal(first.installed, true, 'the first install on a scope is a real install')
  assert.equal(second.installed, false, 'the second install on the SAME scope is a no-op')
  assert.deepEqual(
    [...registerCount.entries()].sort(),
    [...registrationsAfterFirst.entries()].sort(),
    'a repeat install registers no listener on any event',
  )
  assert.equal(second.sessions, first.sessions, 'a repeat install shares the existing counter, not a second one')

  // The behaviour that matters: one over-long reply, one correction.
  const agent = mainAgent('main-dup')
  const emit = (name, payload) => {
    for (const handler of listeners.get(name) ?? []) handler(payload)
  }
  emit('agent/inbox/claimed', { agent, message: { source: { kind: 'user' } } })
  emit('agent/assistant-stream', {
    agent,
    frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'x'.repeat(400) } },
  })
  const handlers = listeners.get('agent/pre-step') ?? []
  assert.equal(handlers.length, 1, 'exactly one pre-step handler after two installs')
  const base = { kind: 'enter', messages: [] }
  const appended = (await handlers[0]({ agent, turn: 1, step: 1 }, async () => base)).messages ?? []
  assert.equal(appended.length, 1, 'two installs still inject exactly one correction')

  console.log('ok 8f — installing twice on one preset scope registers one set of hooks and injects one correction')
}

/* ------------------------------------------------------------------ *
 * 8g. the scope key: sibling rows share it, other presets do not
 * ------------------------------------------------------------------ */

{
  const { Context } = await import(hostUrl('@deepseek-ai/cordis/lib/index.js'))
  const { SystemPrompt } = await import(hostUrl('@deepseek-ai/dsh-system-prompt/lib/index.js'))
  const { createScope } = await import(hostUrl('@deepseek-ai/dsh-scope/lib/index.js'))

  const app = new Context()
  new SystemPrompt(app, {})

  const installedOf = async (scopeKey) => {
    const scope = createScope(app, scopeKey)
    const results = []
    for (const label of ['rowA', 'rowB']) {
      const fiber = scope.ctx.plugin(
        {
          name: label,
          inject: ['systemPrompt'],
          apply: (ctx) => {
            results.push(installBrevity(ctx, { maxProseChars: 50 }).installed)
          },
        },
        {},
      )
      await fiber.await()
    }
    return { results, scope }
  }

  // Sibling rows in one preset scope: first installs, second is a no-op.
  const one = await installedOf('preset:discipline-whale')
  assert.deepEqual(one.results, [true, false], 'sibling rows share one scope key')
  await one.scope.dispose()

  // A different preset id is a different composition and must install.
  const two = await installedOf('preset:other-preset')
  assert.deepEqual(two.results, [true, false], 'a different preset installs on its own first row')
  await two.scope.dispose()

  // A remount of the same preset id is a fresh tree and must install again.
  const three = await installedOf('preset:discipline-whale')
  assert.deepEqual(three.results, [true, false], 'a remount installs fresh rather than inheriting a stale flag')
  await three.scope.dispose()

  console.log('ok 8g — the dedupe key is the preset scope: siblings dedupe, other presets and remounts install')
}

/* ------------------------------------------------------------------ *
 * 9. wiring: the main row installs it and carries the knobs
 * ------------------------------------------------------------------ */

{
  const mainRow = await import('../main.js')

  const listeners = []
  const ctx = {
    logger: { warn() {} },
    effect: (fn) => fn(),
    tools: { register: () => () => {} },
    workspaceRegistry: { list: () => [] },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: (event, handler) => {
      listeners.push({ event, handler })
      return () => {}
    },
  }

  const validated = mainRow.Config['~standard'].validate({
    workerPreset: 'discipline-whale-worker',
    maxProseChars: 120,
    maxCorrections: 0,
    enabled: false,
  })
  assert.equal(validated.issues, undefined, 'the row config schema accepts the brevity knobs')
  assert.equal(validated.value.maxProseChars, 120, 'maxProseChars survives schema validation')
  assert.equal(validated.value.maxCorrections, 0, 'a zero budget survives: 0 is a value, not an absence')
  assert.equal(validated.value.enabled, false, '`enabled: false` survives: false is a value, not an absence')

  mainRow.apply(ctx, validated.value)
  assert.ok(
    listeners.some((entry) => entry.event === 'agent/assistant-stream'),
    'main.apply wires the prose measurement',
  )
  assert.ok(
    listeners.some((entry) => entry.event === 'agent/pre-step'),
    'main.apply wires the correction injection',
  )
  assert.ok(
    listeners.some((entry) => entry.event === 'agent/turn-stopping'),
    'main.apply wires the turn-end rewrite',
  )
  // Both rows now share `agent/assistant-stream` and `tools/pre-execute`; they
  // must be separate listeners, not one merged handler: the guard counts reads,
  // this counts characters.
  const streamListeners = listeners.filter((entry) => entry.event === 'agent/assistant-stream')
  assert.equal(streamListeners.length, 2, 'the guard and the brevity row are independent listeners')

  // Of those two, exactly ONE belongs to brevity: the other is the guard. That
  // distinction is the point of this assertion — the count above stays 2 whether
  // brevity installs once or twice, so it could never catch a double install.
  assert.equal(
    isBrevityInstalled(ctx),
    true,
    'main.apply leaves the scope marked as installed, so the sibling row is a no-op',
  )
  const beforeRepeat = listeners.length
  installBrevity(ctx, validated.value)
  assert.equal(listeners.length, beforeRepeat, 'a repeat install adds no listener of any kind')

  console.log('ok 9 — main.apply installs the brevity hook and carries its knobs through Config')
}

{
  // --- the brevity listener count under the real two-row assembly -----
  //
  // `mountBrevity` now always mounts both rows, so counting what the discipline
  // itself registered is the direct assertion the task asks for: exactly one
  // `agent/assistant-stream` listener for brevity. The guard's own listener is
  // not part of this number.
  const host = mountBrevity({ maxProseChars: 100 })
  assert.equal(
    host.registrations.get('agent/assistant-stream') ?? 0,
    1,
    'the brevity discipline registers exactly one agent/assistant-stream listener across both rows',
  )
  assert.equal(
    host.registrations.get('agent/pre-step') ?? 0,
    1,
    'and exactly one agent/pre-step listener across both rows',
  )
  assert.equal(
    host.registrations.get('agent/turn-stopping') ?? 0,
    1,
    'and exactly one agent/turn-stopping listener across both rows',
  )
  assert.equal(host.second.installed, false, 'the sibling row reports a no-op install')

  console.log('ok 9b — two rows, one brevity listener on each event; the sibling install is a no-op')
}

/* ------------------------------------------------------------------ *
 * 10. isDecisionTurn — "compress hard" vs "structure is allowed"
 * ------------------------------------------------------------------ */

{
  // Plain chat / judgement / boundary / pending decision → compress hard.
  // `为什么` is deliberately NOT here: asking why is asking for an explanation,
  // which belongs to the structured group below.
  for (const text of ['现在进度怎么样了', '你觉得这个方向行吗', '好', '继续', '这个能不能做', '接下来呢']) {
    assert.equal(isDecisionTurn(text), false, `plain chat must compress: ${JSON.stringify(text)}`)
  }

  // A turn that needs options or evidence on the table → numbered structure.
  for (const text of [
    '我有哪些选项',
    '有哪些方案，各自利弊',
    '对比一下这两种做法',
    '给我几个选择',
    '列出 pros and cons',
    'what are my options',
    'compare the two approaches',
    'explain how this works',
    '为什么',
  ]) {
    assert.equal(isDecisionTurn(text), true, `option/evidence request allows structure: ${JSON.stringify(text)}`)
  }

  assert.equal(isDecisionTurn(undefined), false, 'no turn text means no exception')
  assert.equal(isDecisionTurn(''), false)

  // The exception must still honour the shape rule: structured, not prose.
  const contract = decisionShapeContract()
  assert.ok(contract.includes('编号'), 'the exception still demands numbering')
  assert.ok(contract.includes('一行'), 'the exception still demands one line per item')
  assert.ok(contract.includes('不是散文'), 'the exception still forbids prose paragraphs')

  console.log('ok 10 — isDecisionTurn separates plain chat (compress) from option/evidence turns (structure allowed)')
}

{
  // The classification must not weaken the UI exemption: a render turn stays
  // exempt regardless of what the user asked.
  const config = resolveBrevityConfig({ maxProseChars: 50 })
  const uiDecision = shouldEnforceBrevity({
    toolCalls: ['render_canvas'],
    chars: 5000,
    config,
    userText: '我有哪些选项',
  })
  assert.equal(uiDecision.enforce, false, 'UI still wins over every other rule')
  assert.equal(uiDecision.reason, 'ui-deliverable')

  // `render_text` is still measured, but on a decision turn it is measured
  // against the larger decision budget — it never becomes exempt.
  const textToolDecision = shouldEnforceBrevity({
    toolCalls: ['render_text'],
    chars: 5000,
    config,
    userText: '我有哪些选项',
  })
  assert.equal(textToolDecision.reason, 'over-limit', 'the larger budget is still a budget')
  assert.equal(textToolDecision.limit, config.decisionProseChars, 'the decision limit is the one applied')

  console.log('ok 10b — the decision exception raises the limit; it never cancels the UI exemption or render_text counting')
}

{
  // A decision turn gets the larger budget; plain chat gets the tight one.
  const config = resolveBrevityConfig({ maxProseChars: 80, decisionProseChars: 400 })
  const plain = shouldEnforceBrevity({ toolCalls: [], chars: 200, config, userText: '好' })
  assert.equal(plain.enforce, true, 'plain chat is held to the tight limit')
  assert.equal(plain.limit, 80)

  const decision = shouldEnforceBrevity({ toolCalls: [], chars: 200, config, userText: '我有哪些选项' })
  assert.equal(decision.enforce, false, 'the same length is fine when the user asked for options')
  assert.equal(decision.limit, 400)

  // The notice differs: a decision turn is told to structure, not merely cut.
  const plainNotice = brevityNotice({ limit: 80, overBy: 120, decision: false })
  const decisionNotice = brevityNotice({ limit: 400, overBy: 20, decision: true })
  assert.ok(plainNotice.includes('删到'), 'plain chat is told to cut')
  assert.ok(decisionNotice.includes('编号'), 'a decision turn is told to number the options')
  assert.notEqual(plainNotice, decisionNotice, 'the two paths do not share one notice')

  // Config fallback: an invalid or omitted decision limit derives a larger
  // budget from the plain one instead of throwing.
  assert.equal(resolveBrevityConfig({ maxProseChars: 100, decisionProseChars: -5 }).decisionProseChars > 100, true)
  assert.equal(resolveBrevityConfig({ maxProseChars: 100 }).decisionProseChars > 100, true)

  console.log('ok 10c — decision turns get a larger budget and a different notice; invalid values fall back')
}

/* ------------------------------------------------------------------ *
 * 11. the prompt carries the countable anchor, not a character count
 * ------------------------------------------------------------------ */

{
  const { body } = loadRules()
  // The model cannot count characters reliably; it can count lines and items.
  assert.ok(body.includes('3 行'), 'the rules give a countable anchor (3 lines)')
  assert.ok(body.includes('结论 + 下一个动作'), 'the rules name what the short form must contain')
  assert.ok(!body.includes('1200'), 'the prompt must not ask the model to count to a raw character budget')

  const { assemblePresetPrompt } = await import('../prompt-probe.mjs')
  const main = await assemblePresetPrompt('discipline-whale')
  assert.ok(main.includes('3 行'), 'the assembled main prompt carries the countable anchor')
  assert.ok(main.includes('发出前'), 'the assembled main prompt carries the pre-send self-check')

  const worker = await assemblePresetPrompt('discipline-whale-worker')
  assert.ok(!worker.includes('3 行'), 'the worker prompt must not carry the brevity anchor')

  console.log('ok 11 — the prompt teaches a countable anchor and a pre-send check, main preset only')
}

/* ------------------------------------------------------------------ *
 * 12. the decision budget actually reaches the decision
 * ------------------------------------------------------------------ */

{
  // Regression: `installBrevity` resolves its own config. A decision turn must
  // be judged against `decisionProseChars`, not the chat budget — a caller that
  // only passes `maxProseChars` must still get the larger decision limit.
  const host = mountBrevity({ maxProseChars: 80 })
  const main = mainAgent('main-decision')

  host.userTurn(main, {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '给我详细讲讲你自己' }],
  })
  host.say(main, 'x'.repeat(300)) // 300 < 400 (derived decision budget)
  assert.equal(
    (await host.preStep(main)).length,
    0,
    '300 chars on a decision turn is inside the 400-char decision budget',
  )

  // The same 300 chars on a plain-chat turn is over the 80-char budget.
  const plain = mainAgent('main-plain')
  host.userTurn(plain, { source: { kind: 'user' }, content: [{ type: 'text', text: '这个能不能做' }] })
  host.say(plain, 'x'.repeat(300))
  assert.equal((await host.preStep(plain)).length, 1, 'the same length is over budget for plain chat')

  console.log('ok 12 — the decision budget reaches the decision: 300 chars passes on a decision turn, fails on chat')
}

/* ------------------------------------------------------------------ *
 * 13. every resolver key survives the schema — the whole class, not one key
 * ------------------------------------------------------------------ */

{
  // The defect: `decisionProseChars` was honoured by the resolver, dropped by
  // `Config`, and no test noticed, because every test of it called the resolver
  // directly. The fix is not one more assertion — it is asserting the *class*:
  // for each key a resolver reads, a config carrying it must arrive intact at
  // the resolver through the real `Config.validate` path.
  const mainRow = await import('../main.js')
  const { GUARD_CONFIG_KEYS, resolveGuardConfig } = await import('../guard.js')
  const { BREVITY_CONFIG_KEYS } = await import('../adhd.js')

  // A representative, distinct value per key. `0` and `false` are included
  // where legal: they are the values a truthiness bug would drop.
  const SAMPLES = {
    watchdogThreshold: 7,
    readQuota: 3,
    maxInterventions: 0,
    watchdogCounting: 'read-only',
    maxProseChars: 120,
    decisionProseChars: 700,
    maxCorrections: 0,
    enabled: false,
  }

  const allKeys = [...GUARD_CONFIG_KEYS, ...BREVITY_CONFIG_KEYS]
  for (const key of allKeys) {
    assert.ok(Object.hasOwn(SAMPLES, key), `no sample value for key ${key}; add one to keep this exhaustive`)
  }

  // 1. Each key alone survives the schema.
  for (const key of allKeys) {
    const validated = mainRow.Config['~standard'].validate({ [key]: SAMPLES[key] })
    assert.equal(validated.issues, undefined, `Config must accept ${key}`)
    assert.equal(
      validated.value[key],
      SAMPLES[key],
      `${key} must survive Config validation (this is the check whose absence let decisionProseChars go inert)`,
    )
  }

  // 2. All of them together survive: a later key must not shadow an earlier one.
  const all = mainRow.Config['~standard'].validate({ ...SAMPLES })
  assert.equal(all.issues, undefined)
  for (const key of allKeys) {
    assert.equal(all.value[key], SAMPLES[key], `${key} must survive alongside every other key`)
  }

  // 3. The schema carries nothing the resolvers ignore, and ignores nothing
  //    they read. This is the direction that catches a key added to a resolver
  //    and forgotten in the schema — the exact shape of the original defect.
  const carried = Object.keys(all.value).filter((key) => key !== 'workerPreset').sort()
  assert.deepEqual(carried, [...allKeys].sort(), 'Config must carry exactly the keys the resolvers read')

  // 4. The values reach the resolvers, not merely the object.
  const guardCfg = resolveGuardConfig(all.value)
  assert.equal(guardCfg.watchdogThreshold, SAMPLES.watchdogThreshold)
  assert.equal(guardCfg.readQuota, SAMPLES.readQuota)
  assert.equal(guardCfg.maxInterventions, SAMPLES.maxInterventions)
  assert.equal(guardCfg.watchdogCounting, SAMPLES.watchdogCounting)

  const brevityCfg = resolveBrevityConfig(all.value)
  assert.equal(brevityCfg.maxProseChars, SAMPLES.maxProseChars)
  assert.equal(brevityCfg.decisionProseChars, SAMPLES.decisionProseChars, 'the configured decision budget is the effective one')
  assert.equal(brevityCfg.maxCorrections, SAMPLES.maxCorrections)
  assert.equal(brevityCfg.enabled, SAMPLES.enabled)

  console.log('ok 13 — every key both resolvers read survives Config; nothing extra is carried')
}

/* ------------------------------------------------------------------ *
 * 14. an explicit decisionProseChars is honoured, and never silently replaced
 * ------------------------------------------------------------------ */

{
  // The shipped pair is the case that was wrong: `1200 / 400` used to resolve
  // to 6000, fifteen times the documented number, with no warning.
  const shipped = resolveBrevityConfig({ maxProseChars: 1200, decisionProseChars: 400 })
  assert.equal(shipped.decisionProseChars, 400, 'an explicit value is the effective value')
  assert.equal(shipped.decisionDerived, false, 'and it is reported as explicit, not derived')
  // An adopted value is not an error, so it produces a NOTE, not a warning —
  // but the note is what makes "400 is in effect" observable, which is the
  // whole point. Silence is what made the old rule expensive.
  assert.equal(shipped.warnings.length, 0, 'an honoured explicit value is not a failure')
  assert.equal(shipped.notes.length, 1, 'it is still reported')
  assert.ok(shipped.notes[0].includes('400'), 'the note names the value the operator wrote')
  assert.ok(shipped.notes[0].includes('in effect'), 'and says it is in effect')
  assert.ok(shipped.notes[0].includes('1200'), 'and names the budget it sits below')

  // Omission is the only path that derives.
  const omitted = resolveBrevityConfig({ maxProseChars: 1200 })
  assert.equal(omitted.decisionProseChars, 6000, 'omitting the key derives max(400, 1200*5)')
  assert.equal(omitted.decisionDerived, true)
  assert.equal(omitted.warnings.length, 0, 'deriving is normal, not a warning')

  // Any positive explicit value wins, above or below the chat budget — the
  // whole point of the user's ruling: a written number is the number.
  for (const value of [1, 400, 800, 1200, 1201, 8000]) {
    const cfg = resolveBrevityConfig({ maxProseChars: 1200, decisionProseChars: value })
    assert.equal(cfg.decisionProseChars, value, `explicit ${value} must win`)
    assert.equal(cfg.decisionDerived, false)
    assert.equal(cfg.decisionSource, 'explicit', `explicit ${value} must be reported as explicit`)
  }
  // The three numbers from the ruling, verbatim.
  assert.equal(resolveBrevityConfig({ maxProseChars: 1200, decisionProseChars: 400 }).decisionProseChars, 400)
  assert.equal(resolveBrevityConfig({ maxProseChars: 1200 }).decisionProseChars, 6000)
  assert.equal(resolveBrevityConfig({ maxProseChars: 1200, decisionProseChars: 1201 }).decisionProseChars, 1201)

  // A value that is not a positive integer derives — and SAYS SO. This is the
  // one rejection path left, so it is the one that most needs to be visible:
  // an operator who typed `0` or `-5` must not be left believing it applied.
  for (const bad of [0, -1, 1.5, 'x', null, Number.NaN]) {
    const cfg = resolveBrevityConfig({ maxProseChars: 1200, decisionProseChars: bad })
    assert.equal(cfg.decisionProseChars, 6000, `invalid ${JSON.stringify(bad)} derives`)
    assert.equal(cfg.decisionDerived, true)
    assert.equal(cfg.decisionSource, 'derived')
    assert.equal(cfg.warnings.length, 1, `invalid ${JSON.stringify(bad)} must be reported, not swallowed`)
    assert.ok(
      cfg.warnings[0].includes('not a positive integer'),
      `the warning must say why ${JSON.stringify(bad)} was rejected`,
    )
  }

  // The warning reaches a log line, not just the return value: an unread
  // warning is the same blindness that made the old rule expensive.
  const logged = []
  const ctx = { logger: { warn: (...args) => logged.push(args.join(' ')) }, on: () => () => {}, get: () => undefined }
  installBrevity(ctx, { maxProseChars: 1200, decisionProseChars: 0 })
  assert.ok(
    logged.some((line) => line.includes('decisionProseChars') && line.includes('not a positive integer')),
    `a rejected value must be logged at install, got: ${JSON.stringify(logged)}`,
  )

  // An honoured value logs nothing to `warn` (it is not a problem) but the
  // handle still reports it, so "400 is in effect" is observable from code.
  const quiet = []
  const ctx2 = { logger: { warn: (...args) => quiet.push(args.join(' ')) }, on: () => () => {}, get: () => undefined }
  const handle = installBrevity(ctx2, { maxProseChars: 1200, decisionProseChars: 400 })
  assert.equal(quiet.length, 0, 'an honoured explicit value is not a warning')
  assert.equal(handle.config.decisionProseChars, 400, 'but the effective value is on the handle')
  assert.equal(handle.config.decisionSource, 'explicit', 'and its provenance is too')
  assert.ok(
    (handle.config.notes ?? []).some((n) => n.includes('400') && n.includes('in effect')),
    'the note states that 400 is in effect',
  )

  console.log('ok 14 — an explicit decision budget wins verbatim; only omission derives; a rejected value warns')
}

/* ------------------------------------------------------------------ *
 * 15. the shipped preset config and the documented numbers agree
 * ------------------------------------------------------------------ */

{
  const { readFile } = await import('node:fs/promises')
  const yamlModule = await import(join(HOST_MODULES, 'js-yaml/index.js'))
  const yaml = yamlModule.default ?? yamlModule
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patches = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([JsExpr]) }) ?? []
  const inserted = patches.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
  const preset = inserted.find((entry) => entry?.config?.id === 'discipline-whale')
  const row = preset.config.plugins.find((r) => r?.name === 'discipline-whale/adhd')
  assert.ok(row, 'the main preset declares the brevity row')

  const configured = row.config ?? {}
  assert.equal(configured.decisionProseChars, 400, 'the shipped decision budget is the user-ruled 400')
  assert.equal(configured.maxProseChars, 1200, 'and the shipped chat budget is 1200')

  const effective = resolveBrevityConfig(configured)
  // The defect this proves fixed: whatever the preset says must be what runs.
  assert.equal(
    effective.decisionProseChars,
    400,
    'the shipped 400 must be the effective value, not the derived 6000 the old rule substituted',
  )
  assert.equal(effective.decisionSource, 'explicit', 'and it must be reported as an explicit value')
  assert.equal(effective.warnings.length, 0, 'a deliberate explicit pair is not a failure')
  assert.ok(
    effective.notes.some((n) => n.includes('400') && n.includes('in effect')),
    'the shipped 400 is observable as "in effect"',
  )

  // The decisive consequence, stated as a behavior: a 500-char decision reply
  // is over 400 (fires) and would NOT be over the derived 6000 (silent).
  const fiveHundred = shouldEnforceBrevity({
    toolCalls: [],
    chars: 500,
    config: effective,
    userText: '解释一下这个仓库',
  })
  assert.equal(fiveHundred.enforce, true, 'the shipped config must fire on a 500-char decision reply')
  assert.equal(fiveHundred.limit, 400, 'because the limit in force is 400, not 6000')

  // And the prompt's own countable anchor must not contradict the numbers.
  const { body } = loadRules()
  assert.ok(body.includes('3 行'), 'the prompt still teaches the countable anchor')
  assert.ok(!body.includes('6000'), 'the prompt must not carry the derived number')

  console.log('ok 15 — the shipped 400 is the effective decision budget, and a 500-char decision reply fires')
}

/* ------------------------------------------------------------------ *
 * 16. turn end: a single-step over-long answer is rewritten
 * ------------------------------------------------------------------ */

{
  // The case the user hit: one step streams the whole answer and the turn
  // ends. No pre-step follows it, so the turn-end hook is the one boundary
  // that sees it. Its steer lands in `next-step`, which is what makes
  // `agent-loop` run one more step instead of closing the turn.
  const host = mountBrevity({ maxProseChars: 100 })
  const { agent: main, steered } = steerable(mainAgent('main-single-step'))

  host.userTurn(main)
  host.start(main)
  host.say(main, 'x'.repeat(5000)) // one enormous answer
  await host.turnStopping(main)

  assert.equal(steered.length, 1, 'the over-long answer earns exactly one rewrite steer')
  const text = steered[0].content?.[0]?.text ?? ''
  assert.ok(text.includes('5000'), `the rewrite names the real length, got: ${text.slice(0, 80)}`)
  assert.ok(text.includes('重写'), 'the notice asks for a rewrite, not for a shorter next reply')
  assert.ok(text.includes('100 字以内'), 'the notice states the budget the rewrite must fit')
  assert.ok(text.includes('折叠'), 'the notice tells the model the draft folds away, so the rewrite stands alone')
  assert.ok(text.includes('3 行'), 'a plain-chat rewrite carries the countable target')
  assert.equal(steered[0].role, 'user')
  assert.equal(steered[0].source.kind, 'plugin:discipline-whale:brevity', 'the rewrite steer is attributable')
  assert.equal(steered[0].source.form, 'notice', 'it renders as a notice row, not as a user bubble')
  assert.equal(steered[0].source.summary, REWRITE_NOTICE_SUMMARY, 'readers of the log key on this summary')

  // The rewrite is a fresh attempt. Still too long: the budget is spent and
  // the turn is allowed to close — no loop.
  host.start(main, 2)
  host.say(main, 'y'.repeat(300))
  await host.turnStopping(main)
  assert.equal(steered.length, 1, 'one rewrite per user turn: a second over-long answer closes the turn')

  // The next user turn re-arms it.
  host.userTurn(main)
  host.start(main)
  host.say(main, 'z'.repeat(300))
  await host.turnStopping(main)
  assert.equal(steered.length, 2, 'a new user turn can be rewritten again')

  console.log('ok 16 — a single-step over-long answer is rewritten at turn end, once per user turn')
}

/* ------------------------------------------------------------------ *
 * 17. turn end measures the answer, not the process
 * ------------------------------------------------------------------ */

{
  // Only the final attempt stays unfolded once the turn completes, so only its
  // prose decides the rewrite. A long process with a short answer is fine; a
  // short process with a long answer is not.
  const host = mountBrevity({ maxProseChars: 100, maxCorrections: 0 })
  const { agent: main, steered } = steerable(mainAgent('main-answer-only'))
  host.userTurn(main)
  host.start(main, 1)
  host.say(main, 'p'.repeat(90))
  host.start(main, 2)
  host.say(main, 'a'.repeat(90)) // turn total 180, answer 90
  await host.turnStopping(main)
  assert.equal(steered.length, 0, '`maxCorrections: 0` means the turn end never injects either')

  const live = mountBrevity({ maxProseChars: 100 })
  const { agent: other, steered: otherSteered } = steerable(mainAgent('main-answer-measure'))
  live.userTurn(other)
  live.start(other, 1)
  live.say(other, 'p'.repeat(90))
  live.start(other, 2)
  live.say(other, 'a'.repeat(90))
  await live.turnStopping(other)
  assert.equal(otherSteered.length, 0, 'a 90-char answer fits even though the turn streamed 180')

  live.userTurn(other)
  live.start(other, 1)
  live.say(other, 'p'.repeat(20))
  live.start(other, 2)
  live.say(other, 'a'.repeat(150))
  await live.turnStopping(other)
  assert.equal(otherSteered.length, 1, 'a 150-char answer is rewritten')
  assert.ok((otherSteered[0].content?.[0]?.text ?? '').includes('150'), 'the notice counts the answer only')

  // A retried attempt replaces the failed one: its own `start` restarts the count.
  live.userTurn(other)
  live.start(other, 1)
  live.say(other, 'f'.repeat(500)) // attempt fails mid-stream
  live.start(other, 1) // retry of the same step
  live.say(other, 'r'.repeat(50))
  await live.turnStopping(other)
  assert.equal(otherSteered.length, 1, 'the answer is the retried attempt, not the failed one')

  console.log('ok 17 — the turn end measures the final attempt; process prose and failed attempts do not count')
}

{
  // --- the two boundaries keep separate budgets -----------------------
  //
  // A mid-turn reminder must leave the rewrite available: the answer the user
  // reads after the fold is the one that matters most.
  const host = mountBrevity({ maxProseChars: 100, maxCorrections: 1 })
  const { agent: main, steered } = steerable(mainAgent('main-both'))
  host.userTurn(main)
  host.start(main, 1)
  host.say(main, 'p'.repeat(300))
  await host.callTool(main, 'list_workspaces')
  await host.preStep(main) // mid-turn reminder fires, through the steer channel
  assert.equal(steered.length, 1, 'the mid-turn reminder fires')
  assert.ok((steered[0].content?.[0]?.text ?? '').includes('下一条回复'), 'that one is the mid-turn reminder')

  host.start(main, 2)
  host.say(main, 'a'.repeat(300))
  await host.turnStopping(main)
  assert.equal(steered.length, 2, 'the turn-end rewrite still has its own budget')
  assert.ok((steered[1].content?.[0]?.text ?? '').includes('重写'), 'the second one is the rewrite')

  // After the rewrite the next pre-step starts clean: no double reminder.
  await host.preStep(main)
  assert.equal(steered.length, 2, 'the rewrite step is not reminded about the draft it replaces')

  console.log('ok 17b — the mid-turn reminder and the turn-end rewrite keep separate budgets')
}

{
  // --- scope and exemptions hold at turn end --------------------------
  const host = mountBrevity({ maxProseChars: 10 })

  const { agent: worker, steered: workerSteered } = steerable(workerAgent('worker-end'))
  host.start(worker)
  host.say(worker, 'w'.repeat(5000))
  await host.turnStopping(worker)
  assert.equal(workerSteered.length, 0, 'a worker turn never gets a rewrite')
  assert.equal(host.handle.sessions.has('worker-end'), false, 'and never gets a counter')

  const { agent: ui, steered: uiSteered } = steerable(mainAgent('main-ui-end'))
  host.userTurn(ui)
  await host.callTool(ui, 'render_ui', { document: {} })
  host.start(ui, 2)
  host.say(ui, 'c'.repeat(500))
  await host.turnStopping(ui)
  assert.equal(uiSteered.length, 0, 'a turn that delivered a UI is exempt at turn end too')

  const { agent: aborted, steered: abortedSteered } = steerable(mainAgent('main-aborted-end'))
  host.userTurn(aborted)
  host.start(aborted)
  host.say(aborted, 'x'.repeat(500))
  const controller = new AbortController()
  controller.abort()
  await host.turnStopping(aborted, controller.signal)
  assert.equal(abortedSteered.length, 0, 'an aborted turn is left to close')

  const off = mountBrevity({ enabled: false, maxProseChars: 1 })
  const { agent: quiet, steered: quietSteered } = steerable(mainAgent('main-off-end'))
  off.userTurn(quiet)
  off.start(quiet)
  off.say(quiet, 'x'.repeat(500))
  await off.turnStopping(quiet)
  assert.equal(quietSteered.length, 0, '`enabled: false` turns the rewrite off')

  // No steer channel: the hook stays quiet instead of throwing into the turn.
  const bare = mainAgent('main-bare-end')
  host.userTurn(bare)
  host.start(bare)
  host.say(bare, 'x'.repeat(500))
  await host.turnStopping(bare)

  console.log('ok 17c — the turn end leaves workers, UI turns, aborted turns and a disabled row alone')
}

console.log('\nAll discipline-whale brevity checks passed.')
