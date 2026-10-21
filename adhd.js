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
 *   3. two corrections, at the two boundaries a turn has:
 *      - mid-turn: when the turn's visible prose exceeds the limit, the next
 *        step receives one attributed reminder (`agent/pre-step`);
 *      - turn end: when the turn's final answer exceeds the limit, the turn is
 *        held open for one more step and the model rewrites that answer short
 *        (`agent/turn-stopping`), so the turn closes on the rewrite.
 *
 * The turn-end rewrite is what changes what the user reads. The Web chat folds
 * a completed turn's process — every row before the final answer — behind the
 * turn's own control (`foldCompletedTurns` in the compact, standard and
 * detailed views; detailed is the Web default, standard the Desktop default).
 * After the rewrite, the short reply is the turn's answer and the long draft is
 * a process row folded above it. The verbose view shows every row unfolded.
 * The prompt section stays the load-bearing half: it keeps the first draft
 * short, so the rewrite is the backstop.
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
 * Corrections allowed per user turn, at each boundary.
 *
 * The mid-turn reminder and the turn-end rewrite each get this many. The same
 * anti-loop reasoning as the guard's intervention budget: a turn that is
 * corrected and then writes another wall of text would be corrected again,
 * forever. After this many, that boundary stands down until the user speaks.
 * The two budgets are separate so a mid-turn reminder leaves the turn-end
 * rewrite available for the answer the user actually reads.
 */
export const DEFAULT_MAX_CORRECTIONS = 1

/**
 * The floor under a derived decision budget.
 *
 * Whatever the chat budget is, an option turn gets at least this much room. It
 * is a floor, not the default: the real default is
 * `max(this, maxProseChars * DECISION_BUDGET_MULTIPLIER)`, because a decision
 * budget below the chat budget is the one thing that must not happen — it would
 * give "what are my options" less room than "how's it going".
 */
export const DEFAULT_DECISION_PROSE_CHARS = 400

/**
 * How much room a decision turn gets relative to the chat budget.
 *
 * A multiplier, not a fixed number, so an operator who tightens
 * `maxProseChars` for chat does not accidentally make option lists impossible.
 *
 * It applies to DERIVATION ONLY. An explicit `decisionProseChars` is adopted
 * verbatim; this multiplier never overrides a number the operator wrote (see
 * `resolveBrevityConfig`). */
export const DECISION_BUDGET_MULTIPLIER = 5

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

/**
 * The `source.summary` of the turn-end rewrite notice.
 *
 * Readers of the session log key on it: the assistant text of a turn before
 * this notice is a draft the rewrite replaced. `client.js` mirrors the string
 * (it cannot import this module); `test/client.mjs` proves the copies match.
 */
export const REWRITE_NOTICE_SUMMARY = 'revision: rewrite the over-long answer'

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

/**
 * The row-config keys this module reads.
 *
 * Exported so `main.js` and the tests share one list instead of three
 * hand-copied ones. See {@link GUARD_CONFIG_KEYS} in `guard.js` for why: a key
 * the resolver honours but the schema drops is invisible in every direct-call
 * test and silently inert in production.
 *
 * @type {ReadonlyArray<string>}
 */
export const BREVITY_CONFIG_KEYS = Object.freeze([
  'maxProseChars',
  'decisionProseChars',
  'maxCorrections',
  'enabled',
])

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
  const maxProseChars =
    source.maxProseChars === 0 ? 0 : positiveInteger(source.maxProseChars, DEFAULT_MAX_PROSE_CHARS)
  // The decision budget: an explicit value is adopted verbatim, full stop.
  //
  // The rule this replaces compared the explicit value against
  // `maxProseChars` and silently substituted the derived one when it was not
  // strictly greater. Consequence: the shipped `1200 / 400` resolved to 6000,
  // fifteen times the number in the docs, and nothing anywhere said so. An
  // operator who writes a number expects that number; the resolver's job is to
  // report a surprising value, never to overrule it.
  //
  // Only omission (or a value that is not a positive finite integer) derives.
  // The derived value keeps the "never below the chat budget" safety, because
  // that is a *default* — "what are my options" must not come out tighter than
  // "how's it going" when nobody said otherwise. The guarantee is deliberately
  // scoped to derivation: it must never veto an explicit choice.
  const explicitDecision = positiveInteger(source.decisionProseChars, undefined)
  const derivedDecision = Math.max(
    DEFAULT_DECISION_PROSE_CHARS,
    maxProseChars * DECISION_BUDGET_MULTIPLIER,
    // Belt and braces: keep the derivation above the chat budget even if a
    // future multiplier edit breaks that by construction.
    maxProseChars,
  )
  const decisionProseChars = explicitDecision ?? derivedDecision

  /** Diagnostics an operator can actually read: adopted, derived, or rejected. */
  const notes = []
  if (explicitDecision !== undefined) {
    notes.push(
      `decisionProseChars: ${explicitDecision} (explicit, in effect)` +
        (explicitDecision <= maxProseChars
          ? ` — NOTE: not above maxProseChars ${maxProseChars}, so option turns are no roomier than chat.`
          : ''),
    )
  } else if (source.decisionProseChars !== undefined) {
    notes.push(
      `decisionProseChars: ${JSON.stringify(source.decisionProseChars)} is not a positive integer; ` +
        `derived ${derivedDecision}.`,
    )
  } else {
    notes.push(`decisionProseChars: derived ${derivedDecision} (key omitted).`)
  }

  return {
    mainPreset:
      typeof preset === 'string' && preset !== '' ? preset : 'discipline-whale',
    maxProseChars,
    decisionProseChars,
    /** `explicit` when the operator's number is in effect, `derived` otherwise. */
    decisionSource: explicitDecision === undefined ? 'derived' : 'explicit',
    decisionDerived: explicitDecision === undefined,
    maxCorrections: nonNegativeInteger(source.maxCorrections, DEFAULT_MAX_CORRECTIONS),
    enabled: source.enabled !== false,
    notes: Object.freeze(notes),
    warnings: Object.freeze(
      explicitDecision === undefined && source.decisionProseChars !== undefined
        ? [notes[0]]
        : [],
    ),
  }
}

/* ------------------------------------------------------------------ *
 * turn classification — "compress hard" vs "structure is allowed"
 * ------------------------------------------------------------------ */

/**
 * Phrases that mean "put the options / the evidence in front of me".
 *
 * Matched case-insensitively against the user's own message for the turn. This
 * is a heuristic, and it is deliberately generous in the *permissive*
 * direction: misclassifying a chat turn as a decision turn costs a looser
 * budget for one turn, while the reverse deletes the answer the user asked for.
 */
const DECISION_CUES = Object.freeze([
  /哪些选项/,
  /什么选项/,
  /几个(选择|方案|选项|办法)/,
  /有哪些(方案|选项|做法|办法|可能)/,
  /(对比|比较|权衡)/,
  /利弊/,
  /优缺点/,
  /(解释|说明|讲讲|展开|详细)/,
  /(为什么|怎么会|原理|机制)/,
  /(pros and cons|trade-?offs?|compare|comparison|options?|alternatives?|explain|walk me through|why)/i,
])

/**
 * Whether this turn is asking for options, evidence, or an explanation.
 *
 * The user's requirement splits two cases that a single character budget
 * cannot serve at once:
 *
 *   - **plain chat / judgement / boundary / pending decision** — the reading
 *     burden the user complained about. Compress hard.
 *   - **"what are my options"** — the options *are* the answer. Structured,
 *     but numbered with one line each, never prose paragraphs.
 *
 * @param {string|undefined} userText - the user's message that opened this turn.
 * @returns {boolean} true when structure is allowed.
 */
export function isDecisionTurn(userText) {
  if (typeof userText !== 'string' || userText.trim() === '') return false
  return DECISION_CUES.some((pattern) => pattern.test(userText))
}

/**
 * The shape a decision turn must still honour.
 *
 * Exported as text, not just implemented, so the prompt and the tests assert
 * the same sentence: the exception relaxes length, never form.
 *
 * @returns {string} the one-line shape contract.
 */
export function decisionShapeContract() {
  return '选项类回答用编号，每项一行（一行权衡 + 推荐），不是散文段落；每项最多 5 个。'
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
export function shouldEnforceBrevity({ toolCalls, chars, config, userText } = {}) {
  const resolved = config ?? resolveBrevityConfig()
  if (resolved.enabled === false) return { enforce: false, reason: 'disabled' }
  // A delivered artefact outranks every length rule, including the decision
  // budget: a canvas is read as a thing, not as a message.
  if (isUiTurn(toolCalls)) return { enforce: false, reason: 'ui-deliverable' }
  const decision = isDecisionTurn(userText)
  const limit = decision
    ? (resolved.decisionProseChars ?? DEFAULT_DECISION_PROSE_CHARS)
    : (resolved.maxProseChars ?? DEFAULT_MAX_PROSE_CHARS)
  const length = Number.isFinite(chars) ? chars : 0
  if (length <= limit) return { enforce: false, reason: 'within-limit', limit, decision }
  return { enforce: true, reason: 'over-limit', overBy: length - limit, limit, decision }
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

/**
 * The plain text of one user message, for turn classification.
 *
 * Only the human's own text blocks count; notices this plugin injects carry a
 * different `source.kind` and never reach here (the caller filters on that
 * first). Joining every text block keeps multi-block input intact.
 *
 * @param {object} message - one inbox message.
 * @returns {string} its text, or `''` when it carries none.
 */
export function userTextOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * the notice
 * ------------------------------------------------------------------ */

/** The shape rules both notices carry; `decision` picks the option-turn form. */
function shapeLines(decision) {
  const shape = decision
    ? [
        '这一轮用户在问选项/证据，所以允许结构化，但只能是编号：',
        decisionShapeContract(),
        '不要用散文化段落铺开；每项的权衡压到一行。',
      ]
    : [
        '这一轮是普通对话，按最紧的口径：',
        '1. 第一句就是下一步动作，不是背景或计划。',
        '2. 结论 + 下一个动作，正文控制在 3 行以内。',
        '3. 把细节删到最少，或者放进 UI / 交给 worker——不要留在正文里。',
      ]
  return [
    ...shape,
    '4. 没有开场白、没有复述、没有客套收尾。',
    '5. 列表每组最多 5 项；分析可以想得多，展示要少。',
    'UI / 画布（render_ui / render_canvas / render_scene / render_mechanism）是交付物，不受长度限制；',
    'render_text 渲染的仍然是文字，字数照算。',
  ]
}

/** Rendered at a step boundary when the turn's prose crossed the limit. Kept verbatim for tests. */
export function brevityNotice({ limit, overBy, decision = false }) {
  return [
    `[Discipline Whale] 这条回复的正文约 ${limit + overBy} 字，超过了上限 ${limit} 字。`,
    '那段已经发出。下一条回复按下面做：',
    ...shapeLines(decision),
  ].join('\n')
}

/**
 * Rendered at turn end when the final answer crossed the limit.
 *
 * The reply the model writes next becomes the turn's answer, and the long draft
 * folds into the turn's process above it. So the rewrite has to stand alone: a
 * reader who never opens the fold must get the whole point from it.
 */
export function rewriteNotice({ limit, overBy, decision = false }) {
  return [
    `[Discipline Whale] 本轮的最终回复正文约 ${limit + overBy} 字，超过了上限 ${limit} 字。`,
    `现在把它重写成本轮的最终回复，正文 ${limit} 字以内。`,
    '这一条会成为用户看到的答案；刚才那条在本轮结束后折叠进过程区。',
    '所以它要自成一体：直接给压缩版，不道歉、不提上一条、不写「见上」，不调用工具、不做新的工作。',
    ...shapeLines(decision),
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * the row
 * ------------------------------------------------------------------ */

/**
 * Per-Session measurement. Only main Sessions ever get an entry.
 *
 * `chars` is the turn's prose since the last mid-turn reminder; `answerChars`
 * is the prose of the latest model attempt, which is the turn's answer when
 * that attempt ends the turn. `corrections` and `rewrites` are the two budgets.
 */
function emptyState() {
  return { chars: 0, answerChars: 0, tools: new Set(), corrections: 0, rewrites: 0, userText: '' }
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
 *   `agent/pre-step`, `agent/turn-stopping`, `agent/inbox/claimed`,
 *   `agent/disposed`).
 * @param {object} [config] - row config; see {@link resolveBrevityConfig}.
 * @returns {{config: object, sessions: Map, isMainAgent: Function, rules: string, installed: boolean}}
 *   handle, for tests and diagnostics. `installed` is `false` on a repeat call.
 */
export function installBrevity(ctx, config = {}) {
  const resolved = resolveBrevityConfig(config, { mainPreset: config.mainPreset })
  const { body: rulesBody } = loadRules()

  // A configuration warning that only exists in a return value is not
  // observable: nothing reads the handle. Log it once, at install, where an
  // operator looking at the row's startup output will see it. This is the
  // difference between "the value was overridden" and "the value was
  // overridden and nobody could tell" — which is what made the old rule
  // expensive.
  for (const warning of resolved.warnings ?? []) {
    try {
      ctx.logger?.warn?.(`discipline-whale: ${warning}`)
    } catch {
      // A missing logger must never stop the discipline from installing.
    }
  }

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
  //    A `start` frame opens each model attempt (a new step, or a retry of the
  //    same one), so it restarts the answer measurement: only the attempt that
  //    ends the turn is the answer.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent === undefined || !isMainAgent(agent)) return
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    if (frame?.type === 'start') {
      stateFor(sessionId).answerChars = 0
      return
    }
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') return
    const state = stateFor(sessionId)
    state.chars += chunk.text.length
    state.answerChars += chunk.text.length
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

  // 3. Remind at the next step boundary, so the rest of the turn stays short.
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
      userText: state.userText,
    })
    if (verdict.enforce !== true) return decision
    signal?.throwIfAborted?.()

    // Spend the measurement even if the steer below fails: otherwise a failed
    // channel would re-measure the same text on every later step.
    state.corrections += 1
    state.chars = 0
    state.tools = new Set()

    const text = brevityNotice({ limit: verdict.limit, overBy: verdict.overBy, decision: verdict.decision === true })
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

  // 4. Rewrite at turn end. `agent-loop` dispatches this serially after a step
  //    that ends the turn, and closes the turn only while `next-step` is still
  //    empty afterwards. A steer here fills it, so the loop runs one more step:
  //    the rewrite becomes the turn's answer and the long draft becomes a
  //    process row, which the chat folds when the turn completes.
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (agent === undefined || !isMainAgent(agent)) return
    if (signal?.aborted === true) return
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const state = sessions.get(sessionId)
    if (state === undefined) return
    if (state.rewrites >= resolved.maxCorrections) return

    const verdict = shouldEnforceBrevity({
      toolCalls: [...state.tools],
      chars: state.answerChars,
      config: resolved,
      userText: state.userText,
    })
    if (verdict.enforce !== true) return

    // Spend the budget before steering, for the same reason as above. The
    // rewrite starts from a clean measurement so the mid-turn reminder does not
    // count the draft a second time.
    state.rewrites += 1
    state.chars = 0
    state.answerChars = 0

    const text = rewriteNotice({ limit: verdict.limit, overBy: verdict.overBy, decision: verdict.decision === true })
    steerNotice(agent, text, REWRITE_NOTICE_SUMMARY)
  })

  // 5. A real user turn re-arms both budgets and restarts the measurement. The
  //    `source.kind` test excludes the notices this module itself injects.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent === undefined || !isMainAgent(agent)) return
    if (message?.source?.kind !== 'user') return
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    // `stateFor`, not `get`: the user's message may arrive before any assistant
    // frame, and the turn's classification must still be recorded. Bailing here
    // would silently leave `userText` empty, so every turn would be measured
    // against the chat budget — including the option turns that need the wider
    // one. (Caught by test 12.)
    const state = stateFor(sessionId)
    state.chars = 0
    state.answerChars = 0
    state.tools = new Set()
    state.corrections = 0
    state.rewrites = 0
    state.userText = userTextOf(message)
  })

  // 6. Forget a Session when it goes away.
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
