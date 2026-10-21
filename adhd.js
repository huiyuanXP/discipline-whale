/**
 * discipline-whale — main-session brevity discipline (ADHD rules).
 *
 * The main conversation is the only session that talks to the user, and a
 * reader with ADHD cannot act on a wall of prose. This module carries an
 * adapted version of the `i-have-adhd` skill (MIT, Ayoub Ghriss) into this
 * plugin, mounted from the main row only:
 *
 *   1. a prompt section — the ruleset is assembled into the main preset's
 *      system prompt on every request, so the soft constraint is always live;
 *   2. a skill — the same file is registered as `whale-brevity` into the main
 *      preset's *scope*, so the catalog entry and the prompt text cannot drift;
 *   3. a correction — when one reply's visible prose exceeds the limit, the
 *      next step receives one attributed reminder.
 *
 * What this module cannot do, stated plainly because the upstream mechanism is
 * the same: it cannot rewrite or truncate text the model already streamed. The
 * user has seen that reply by the time any hook runs. The correction is a
 * steer for the *next* step, never a retroactive edit. The prompt section is
 * the load-bearing half; the correction is a nudge for when the model drifts.
 *
 * Scope is the property that matters most. Every listener is process-wide (a
 * preset tree is mounted once at boot, not per Session), so each handler reads
 * `session.header.agentPreset` and returns `next()` untouched for anything that
 * is not the main preset. A worker Session is never measured, never counted,
 * and never corrected — a worker's value is in a detailed report, and a brevity
 * brake there would destroy the very thing the main session needs to read.
 *
 * @module discipline-whale/adhd
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { presetOfAgent } from './guard.js'

/* ------------------------------------------------------------------ *
 * named constants — every threshold lives here and nowhere else
 * ------------------------------------------------------------------ */

/** Visible prose characters allowed in one user-visible reply before a reminder. */
export const DEFAULT_MAX_PROSE_CHARS = 1200

/**
 * Corrections allowed per user turn.
 *
 * The same anti-loop reasoning as the guard's intervention budget: a turn that
 * is reminded and then writes another wall of text would be reminded again,
 * forever. After this many, the module stands down until the user speaks.
 */
export const DEFAULT_MAX_CORRECTIONS = 1

/** The prompt section name. Distinct from the persona slot on purpose (see below). */
export const RULES_SECTION_NAME = 'discipline-whale:brevity'

/** The skill name, kebab-case as the skill registry requires. */
export const SKILL_NAME = 'whale-brevity'

/** Where the rules file lives, relative to this module. */
export const RULES_PATH = join('skills', SKILL_NAME, 'SKILL.md')

/**
 * Tools whose output is a *deliverable*, not a chat reply.
 *
 * These render a structured artefact — a canvas, an interactive panel, a scene,
 * a mechanism — that the user reads as a thing, not as a message. Their content
 * is exempt from every length rule: a dense UI is the point of a UI.
 *
 * `render_text` is deliberately NOT here. It renders text; wrapping prose in it
 * does not change what it is. Exempting it would turn the whole discipline into
 * a one-line escape hatch (`call render_text, write anything`). Reading a UI or
 * video back (`inspect_ui`, `ui_catalog`) is not a delivery either, so those are
 * not listed.
 */
export const UI_EXEMPT_TOOLS = Object.freeze(
  new Set(['render_ui', 'render_canvas', 'render_scene', 'render_mechanism']),
)

/**
 * Tools that carry prose into the *text* channel.
 *
 * `render_text` is the only producer that does. Its text is measured like an
 * assistant message would be, so it neither exempts the turn nor hides the
 * characters it ships.
 */
export const TEXT_CHANNEL_TOOLS = Object.freeze(new Set(['render_text']))

/** Attribution stamped on every injected notice, so the model can tell them apart. */
const NOTICE_SOURCE = Object.freeze({
  kind: 'plugin:discipline-whale:brevity',
  form: 'notice',
  summary: 'Discipline Whale brevity reminder',
})

/* ------------------------------------------------------------------ *
 * the rules file
 * ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Strip a leading YAML frontmatter block and trailing newlines.
 *
 * The same shape the upstream `always-on` hooks use, for the same reason: the
 * file has to be valid for the skill registry (which parses the frontmatter)
 * and valid as injected prompt text (which must not).
 */
export function stripFrontmatter(raw) {
  return String(raw)
    .replace(/^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, '')
    .replace(/(?:\r?\n)+$/, '')
}

/**
 * Parse the frontmatter this file uses: flat `key: value` pairs plus one nested
 * `metadata:` block.
 *
 * Deliberately not a YAML parser. This package has no dependencies (it installs
 * as a link to its own directory, where profile packages do not resolve), and
 * the file is ours: the grammar above is the whole contract. The skill registry
 * parses the same frontmatter with real YAML, so anything fancier than this
 * belongs there, not here.
 */
function parseFrontmatter(raw) {
  const match = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(String(raw))
  if (match === null) return {}
  const meta = {}
  let nested
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // An indented line belongs to the block opened by the previous bare key.
    if (/^\s+\S/.test(line)) {
      if (nested === undefined) continue
      const pair = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
      if (pair !== null) nested[pair[1]] = unquote(pair[2])
      continue
    }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (pair === null) continue
    if (pair[2] === '') {
      nested = {}
      meta[pair[1]] = nested
      continue
    }
    nested = undefined
    meta[pair[1]] = unquote(pair[2])
  }
  return meta
}

/** Strip one layer of matching quotes from a scalar. */
function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, '$2').trim()
}

/**
 * Read the ruleset from disk, once per process.
 *
 * Both consumers (the prompt section and the skill definition) read this, which
 * is what keeps the advertised skill and the live prompt from drifting apart.
 * A missing file throws: a silently empty ruleset would look wired and do
 * nothing, which is the failure mode this module exists to avoid.
 *
 * @param {string} [path] - alternate rules file, for tests.
 * @returns {{body: string, meta: Record<string, string>, path: string}}
 */
export function loadRules(path = join(HERE, RULES_PATH)) {
  const raw = readFileSync(path, 'utf8')
  const body = stripFrontmatter(raw)
  if (body.trim() === '') throw new Error(`discipline-whale: the brevity rules file is empty: ${path}`)
  const parsed = parseFrontmatter(raw)
  // Attribution is read from one flat view: it lives under `metadata:` in the
  // file (where the skill registry expects it) but callers should not have to
  // know that.
  const meta = { ...parsed, ...(parsed.metadata ?? {}) }
  return { body, meta, path }
}

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Normalize the brevity config.
 *
 * Every field is optional and an invalid value falls back instead of throwing —
 * the same contract as `resolveGuardConfig`, for the same reason: a bad knob
 * must never take the main row down with it.
 *
 * `maxProseChars: 0` is legal and means "no prose at all". `maxCorrections: 0`
 * is legal and means "never inject". The preset identity comes from the
 * caller's fallback, so row config cannot move the brake onto another preset.
 *
 * @param {object} [input] - raw row config.
 * @param {{mainPreset?: string}} [fallback] - authoritative preset identity.
 */
export function resolveBrevityConfig(input = {}, fallback = {}) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const preset = fallback.mainPreset ?? source.mainPreset
  return {
    mainPreset:
      typeof preset === 'string' && preset !== '' ? preset : 'discipline-whale',
    maxProseChars:
      source.maxProseChars === 0 ? 0 : positiveInteger(source.maxProseChars, DEFAULT_MAX_PROSE_CHARS),
    maxCorrections: nonNegativeInteger(source.maxCorrections, DEFAULT_MAX_CORRECTIONS),
    enabled: source.enabled !== false,
  }
}

/* ------------------------------------------------------------------ *
 * pure decisions
 * ------------------------------------------------------------------ */

/** Normalize one tool call to its name. The stream gives strings or `{name}`. */
function toolName(call) {
  if (typeof call === 'string') return call
  if (call !== null && typeof call === 'object' && typeof call.name === 'string') return call.name
  return undefined
}

/**
 * Whether this turn delivered a UI artefact instead of (or beside) prose.
 *
 * This is the whole exemption rule, in one testable place. The reading is
 * turn-level on purpose: if the turn rendered a canvas, the turn's prose is the
 * caption around a deliverable, and separating caption from deliverable is not
 * decidable. Over-correcting a real delivery costs more than missing a chatty
 * aside, and the shape rules (lead with the action, no preamble) are carried
 * by the prompt section regardless.
 *
 * @param {Array<string|{name: string}>|undefined|null} toolCalls - tools used this turn.
 * @returns {boolean} true when at least one UI-producing tool ran.
 */
export function isUiTurn(toolCalls) {
  if (!Array.isArray(toolCalls)) return false
  for (const call of toolCalls) {
    const name = toolName(call)
    if (name !== undefined && UI_EXEMPT_TOOLS.has(name)) return true
  }
  return false
}

/**
 * Decide whether one turn's prose should be corrected.
 *
 * The single place where "how long is too long" is answered. Returns the
 * decision *and* why, so a test — and a log line, and the notice itself — can
 * state the reason instead of asserting a bare boolean.
 *
 * @param {{toolCalls?: Array, chars?: number, config?: object}} input
 * @returns {{enforce: boolean, reason: string, overBy?: number, limit?: number}}
 */
export function shouldEnforceBrevity({ toolCalls, chars, config } = {}) {
  const resolved = config ?? resolveBrevityConfig()
  if (resolved.enabled === false) return { enforce: false, reason: 'disabled' }
  if (isUiTurn(toolCalls)) return { enforce: false, reason: 'ui-deliverable' }
  const length = Number.isFinite(chars) ? chars : 0
  const limit = resolved.maxProseChars ?? DEFAULT_MAX_PROSE_CHARS
  if (length <= limit) return { enforce: false, reason: 'within-limit', limit }
  return { enforce: true, reason: 'over-limit', overBy: length - limit, limit }
}

/**
 * Count the prose one text-channel tool call ships.
 *
 * `render_text` carries text in `text`, in `blocks[].text`, or both. Counting
 * it is what closes the "wrap it in a render tool" loophole; every other tool
 * contributes zero here, because its arguments are data, not prose.
 *
 * @param {string} name - tool name.
 * @param {object} [args] - parsed arguments.
 * @returns {number} characters of prose.
 */
export function countTextInArgs(name, args) {
  if (!TEXT_CHANNEL_TOOLS.has(name)) return 0
  if (args === null || typeof args !== 'object') return 0
  let total = 0
  if (typeof args.text === 'string') total += args.text.length
  if (Array.isArray(args.blocks)) {
    for (const block of args.blocks) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') total += block.text.length
    }
  }
  // `render_ui` can carry an inner `render_text` document; it is not in
  // TEXT_CHANNEL_TOOLS, so its content never reaches this count on its own —
  // the turn-level exemption above is what covers it.
  return total
}

/* ------------------------------------------------------------------ *
 * the notice
 * ------------------------------------------------------------------ */

/** Rendered when one turn's prose crossed the limit. Kept verbatim for tests. */
export function brevityNotice({ limit, overBy }) {
  return [
    `[Discipline Whale] 这条回复的正文约 ${limit + overBy} 字，超过了简洁上限 ${limit} 字。`,
    '用户已经读到了那段话，这里不能重写它。下一条回复按下面做：',
    '1. 第一句就是下一步动作，不是背景或计划。',
    '2. 多步任务用编号列表，每步一个动作，用最少的步数。',
    '3. 结尾给一个两分钟内能开始的具体动作；不要「还需要什么随时说」。',
    '4. 没有开场白、没有复述、没有客套收尾。',
    '5. 列表每组最多 5 项；分析可以想得多，展示要少。',
    'UI / 画布（render_ui / render_canvas / render_scene / render_mechanism）是交付物，不受长度限制；',
    'render_text 渲染的仍然是文字，字数照算。',
    '细节写进 UI 或交给 worker，口头说明保持简短。',
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * the row
 * ------------------------------------------------------------------ */

/** Per-Session measurement. Only main Sessions ever get an entry. */
function emptyState() {
  return { chars: 0, tools: new Set(), corrections: 0 }
}

/**
 * Handles of the preset scopes that already carry the brevity hooks.
 *
 * Two rows install this discipline into the SAME preset scope: the
 * `discipline-whale-main` row calls `installBrevity` from `main.js`, and the
 * `discipline-whale-brevity` row calls it from its own `apply()`. Without a
 * guard, both register a full listener set: one over-long reply then earns two
 * identical corrections while `maxCorrections` says one, and every character is
 * counted twice.
 *
 * The key is the preset scope, never the Session. A preset tree is mounted once
 * and shared by every Session that selects that preset, so the scope outlives
 * any one Session and a per-Session key would let a second Session install a
 * second time.
 *
 * The key cannot be `ctx` either: each row runs in its own child context, so
 * `ctx` differs between exactly the two call sites that must dedupe. It also
 * cannot be the preset *id* string: two mounts of the same preset in one process
 * are legitimate separate compositions, and a string key would silently deny the
 * second one its hooks. `ctx.fiber.parent` — the fiber that owns the scope — is
 * shared by sibling rows, distinct across presets, and fresh on every remount.
 *
 * A WeakMap, so a disposed scope's entry is collectable rather than retained for
 * the life of the process; each first install also drops its key on disposal so
 * a row unmount cannot leave a stale "already installed" behind.
 */
const installedScopes = new WeakMap()

/**
 * Identity of the preset scope this row belongs to.
 *
 * `ctx.fiber.parent` is the scope-owning fiber. A bare context (a unit test, or
 * a host plane that mounts this row outside a preset tree) has no fiber at all,
 * so the key falls back to the context object itself: distinct callers still
 * dedupe against their own context and never collide with another composition.
 *
 * @param ctx - row context.
 * @returns a value usable as a WeakMap key, or `undefined` when there is none.
 */
function scopeKeyOf(ctx) {
  const parent = ctx?.fiber?.parent
  if (parent !== undefined && parent !== null) return parent
  const fiber = ctx?.fiber
  if (fiber !== undefined && fiber !== null) return fiber
  return typeof ctx === 'object' && ctx !== null ? ctx : undefined
}

/**
 * Whether this context's preset scope already carries the brevity hooks.
 *
 * @param ctx - row context.
 * @returns `true` when a previous install owns the scope.
 */
export function isBrevityInstalled(ctx) {
  const key = scopeKeyOf(ctx)
  return key !== undefined && installedScopes.has(key)
}

/**
 * Install the brevity discipline on the main row's context.
 *
 * Idempotent per preset scope: a second install — the sibling row, or a third
 * call site added later — registers no listener and creates no second counter,
 * and receives the existing handle so a caller never mistakes "already installed"
 * for "absent". That is what keeps `maxCorrections` meaning what it says no
 * matter how many rows ask for this discipline.
 *
 * @param ctx - the row context (`agent/assistant-stream`, `tools/pre-execute`,
 *   `agent/pre-step`, `agent/inbox/claimed`, `agent/disposed`).
 * @param {object} [config] - row config; see {@link resolveBrevityConfig}.
 * @returns {{config: object, sessions: Map, isMainAgent: Function, rules: string, installed: boolean}}
 *   handle, for tests and diagnostics. `installed` is `false` on a repeat call.
 */
export function installBrevity(ctx, config = {}) {
  const resolved = resolveBrevityConfig(config, { mainPreset: config.mainPreset })
  const { body: rulesBody } = loadRules()

  const scopeKey = scopeKeyOf(ctx)
  const existing = scopeKey === undefined ? undefined : installedScopes.get(scopeKey)
  if (existing !== undefined) return { ...existing, installed: false }

  /** sessionId -> measurement. Only main Sessions ever get an entry. */
  const sessions = new Map()

  // Fail open on anything that cannot be positively identified as the main
  // preset. A worker must never be measured; an unguarded main session is a
  // far smaller failure than a constrained worker report.
  const isMainAgent = (agent) => presetOfAgent(ctx, agent) === resolved.mainPreset

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = emptyState()
      sessions.set(sessionId, state)
    }
    return state
  }

  const sessionIdOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  const steerNotice = (agent, text, summary) => {
    try {
      if (typeof agent?.steer !== 'function') return false
      agent.steer({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { ...NOTICE_SOURCE, summary },
      })
      return true
    } catch (error) {
      ctx.logger?.warn?.(`discipline-whale: could not steer the brevity reminder: ${error?.message ?? error}`)
      return false
    }
  }

  // 1. Measure. `agent/assistant-stream` is dispatched with the Agent as the
  //    scope key, so a preset-mounted listener receives it (unlike
  //    `session/event`, which is dispatched at the host plane and filtered out).
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent === undefined || !isMainAgent(agent)) return
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    stateFor(sessionId).chars += chunk.text.length
  })

  // 2. Record deliveries and count the prose a `render_text` ships. The gate
  //    ALWAYS allows: denying a tool call belongs to the guard's brakes, and a
  //    brevity reminder must never look like a refusal.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec?.agent
    if (agent === undefined || !isMainAgent(agent)) return next()
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return next()
    const state = stateFor(sessionId)
    const name = String(exec.name ?? '')
    state.tools.add(name)
    const carried = countTextInArgs(name, exec.arguments)
    if (carried > 0) state.chars += carried
    return next()
  })

  // 3. Correct at the next step boundary — the earliest moment a reminder can
  //    still change anything, because the streamed reply is already on screen.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (agent === undefined || !isMainAgent(agent)) return decision
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return decision
    const state = sessions.get(sessionId)
    if (state === undefined) return decision
    if (state.corrections >= resolved.maxCorrections) return decision

    const verdict = shouldEnforceBrevity({
      toolCalls: [...state.tools],
      chars: state.chars,
      config: resolved,
    })
    if (verdict.enforce !== true) return decision
    signal?.throwIfAborted?.()

    // Spend the measurement even if the steer below fails: otherwise a failed
    // channel would re-measure the same text on every later step.
    state.corrections += 1
    state.chars = 0
    state.tools = new Set()

    const text = brevityNotice({ limit: verdict.limit, overBy: verdict.overBy })
    const steered = steerNotice(agent, text, 'revision: over-long prose')
    if (steered) return decision

    // No steer channel: append the reminder to this step's context instead.
    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          role: 'user',
          content: [{ type: 'text', text }],
          source: { ...NOTICE_SOURCE, summary: 'revision: over-long prose' },
        },
      ],
    }
  })

  // 4. A real user turn re-arms the budget and restarts the measurement. The
  //    `source.kind` test excludes the notices this module itself injects.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent === undefined || !isMainAgent(agent)) return
    if (message?.source?.kind !== 'user') return
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const state = sessions.get(sessionId)
    if (state === undefined) return
    state.chars = 0
    state.tools = new Set()
    state.corrections = 0
  })

  // 5. Forget a Session when it goes away.
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId !== undefined) sessions.delete(sessionId)
  })

  const handle = { config: resolved, sessions, isMainAgent, rules: rulesBody, installed: true }

  // Record the scope so the sibling row does not install a second time, and drop
  // the record when this install is torn down: a row unmount must not leave a
  // scope looking installed forever. `ctx.effect` is absent on a bare test
  // context, where the WeakMap entry is harmless — the context itself is the key
  // and dies with the test.
  if (scopeKey !== undefined) {
    installedScopes.set(scopeKey, handle)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (installedScopes.get(scopeKey) === handle) installedScopes.delete(scopeKey)
      }, 'brevity.scope-guard')
    }
  }

  return handle
}

/* ------------------------------------------------------------------ *
 * the row plugin
 * ------------------------------------------------------------------ */

/** Cordis plugin name. */
export const name = 'discipline-whale-brevity'

/**
 * `systemPrompt` is required (the rules section is the load-bearing half);
 * `skills` is optional, so a composition without a skill registry still gets
 * the prompt section instead of failing to mount.
 */
export const inject = ['systemPrompt']

/**
 * Register the rules section, the scoped skill, and the correction hook.
 *
 * The section is a *separate* prompt section rather than an edit to the persona
 * prefix. Two reasons, both structural:
 *
 *   - a second `dsh-persona` row in one preset collides — both try to register
 *     `deployment:persona-prefix`, and the second fails the mount (verified
 *     against the real package);
 *   - a separate section is independently identifiable in the assembled prompt
 *     and independently removable, which is what makes the scope test possible.
 *
 * @param ctx - the row context, inside the main preset's scope.
 * @param {object} [config] - row config; see {@link resolveBrevityConfig}.
 */
export function apply(ctx, config = {}) {
  const { body } = loadRules()

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: RULES_SECTION_NAME,
        // Immediately after the persona, so it reads as part of the identity
        // rather than as a tool note.
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
        text: [
          '## 输出纪律（ADHD 读者）',
          '',
          '下面这一节约束你的**对话正文**。它和上面的派工纪律同时生效，两者不冲突：派工讲做什么，这里讲怎么说。',
          '',
          body,
        ].join('\n'),
      }),
    'brevity.section()',
  )

  // The skill is registered into the *calling context's scope*. Inside a preset
  // mount that is the preset's own layer, so the catalog entry is visible to
  // main Sessions and invisible to workers and to the host plane. Optional
  // injection keeps a composition without a skill registry mountable.
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(
      () =>
        scoped.skills.register({
          name: SKILL_NAME,
          description:
            'Shape the main conversation for a reader with ADHD: lead with the next action, number multi-step work, ' +
            'restate state, give concrete time estimates, make wins visible — while UI and canvas deliverables stay full-size.',
          whenToUse:
            'Every reply in the main conversation. Load it when a reply is getting long and you need the exact rules, ' +
            'including which content is exempt because it ships as UI.',
          source: 'discipline-whale',
          content: body,
          metadata: {
            upstream: 'https://github.com/ayghri/i-have-adhd',
            'upstream-license': 'MIT',
            adaptation: 'rewritten for Discipline Whale',
          },
        }),
      'brevity.skill()',
    )
  })

  installBrevity(ctx, config)
}
