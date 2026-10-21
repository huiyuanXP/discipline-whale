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
 *   3. the mechanism is an injection, never a rewrite: over-long prose earns
 *      one reminder on the *next* step, a UI turn earns none, and the tool gate
 *      never denies anything (it must not touch the guard's brakes).
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
  RULES_SECTION_NAME,
  SKILL_NAME,
  TEXT_CHANNEL_TOOLS,
  UI_EXEMPT_TOOLS,
  apply,
  countTextInArgs,
  installBrevity,
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

  return { handle, second, registrations, listeners, emit, say, callTool, preStep, userTurn }
}

const mainAgent = (id = 'main-adhd') => ({ session: { id, header: { agentPreset: 'discipline-whale' } } })
const workerAgent = (id = 'worker-adhd') => ({ session: { id, header: { agentPreset: 'discipline-whale-worker' } } })

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
  assert.ok(notice.includes('简洁'), `the reminder must be about brevity, got: ${notice.slice(0, 80)}`)
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
  assert.equal(host.second.installed, false, 'the sibling row reports a no-op install')

  console.log('ok 9b — two rows, one brevity listener on each event; the sibling install is a no-op')
}

console.log('\nAll discipline-whale brevity checks passed.')
