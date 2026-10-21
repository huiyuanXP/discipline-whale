/**
 * discipline-whale — main-session brakes.
 *
 * The main session has a read-only filesystem and no shell, yet it can still
 * spend an entire turn reading instead of talking to the user and dispatching
 * work. This module is the mechanism layer for that failure, mounted from the
 * main row only:
 *
 *   1. a tool-call watchdog — N silent tool calls in a row hard-stop the turn
 *      and inject a prompt that forces a reply plus a dispatch;
 *   2. a read quota — at most N read calls per reply epoch, refreshed whenever
 *      the main session produces user-visible text;
 *   3. a read scope — its own home is fully readable, other workspaces only
 *      expose public documents, and anything else is refused with a reason.
 *
 * Everything here is mounted from `main.js`, which exists only inside the
 * `discipline-whale` preset. The listeners are nevertheless process-wide (a
 * preset tree is mounted once at boot, not per Session), so every handler
 * re-checks `session.header.agentPreset` before touching a call. A worker
 * Session, whose preset differs, is never counted, throttled, or denied.
 *
 * @module discipline-whale/guard
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { storeRoot, whaleHomeDir } from './store.js'

/* ------------------------------------------------------------------ *
 * thresholds — every magic number lives here and nowhere else
 * ------------------------------------------------------------------ */

/** Silent tool calls in a row that hard-stop the turn. */
export const WATCHDOG_SILENT_THRESHOLD = 10

/** Read calls allowed per reply epoch (one epoch = one user-visible reply). */
export const READ_QUOTA_PER_EPOCH = 10

/**
 * How many forced interventions one user turn may receive.
 *
 * A turn that is stopped, injected, and then burns its fresh quota on more
 * reading would be stopped again — forever. After this many interventions the
 * guard stands down, tells the user, and leaves only the read quota in force,
 * which is itself a bounded, self-explaining refusal.
 */
export const MAX_FORCED_INTERVENTIONS_PER_TURN = 2

/**
 * Which tool calls the watchdog counts.
 *
 * `read-only`  — only the read class (the literal reading of "10 tool calls"
 *                suggested by the product owner).
 * `all`        — every tool call that is not in {@link PRODUCTIVITY_TOOLS}.
 *
 * Both are decided by this one constant so the trade-off can be flipped
 * without touching logic. The default is `all`, because the read quota already
 * caps the read class at the same number: with `read-only` the watchdog and
 * the quota would fire on the same call at the same count, and only one of the
 * two could ever be observable. `all` keeps both mechanisms live — a mixed
 * burst (reads plus e.g. todo/skill calls) is stopped by the watchdog, while a
 * pure read burst is stopped by the watchdog first and by the quota after the
 * intervention budget is spent.
 */
export const WATCHDOG_COUNTING_MODES = Object.freeze({
  READ_ONLY: 'read-only',
  ALL: 'all',
})

export const DEFAULT_WATCHDOG_COUNTING_MODE = WATCHDOG_COUNTING_MODES.ALL

/**
 * Tools that are the main session doing its actual job.
 *
 * The test is whether the call *adds to the main session's knowledge of the
 * codebase* or merely *hands the user something*. Dispatching, rendering,
 * asking the user, and reading a worker report are the behaviours this plugin
 * exists to produce; counting them would kill exactly the "dispatch three
 * workers, read three reports" flow — and, for the render family, would abort a
 * normal multi-block answer halfway through, because a delivery that renders ten
 * blocks between text segments looks identical to ten silent reads.
 *
 * The render/office producers are enumerated from what the deployment actually
 * registers (`dsh-motion-ui` and `dsh-office-tools`), not from a guess. The
 * matching `*_read` tools are deliberately NOT here: reading an artefact back
 * does pull content into context, so it stays counted.
 */
export const PRODUCTIVITY_TOOLS = Object.freeze(
  new Set([
    // this plugin's own surface
    'dispatch_task',
    'list_workspaces',
    'list_dispatches',
    'read_report',
    'send_to_session',
    'report_to_main',
    // this plugin's memory surface (memory-row.js)
    'remember',
    'update_instructions',
    'set_workspace_intro',
    'dream_now',
    // talking to the user
    'present',
    'ask_user_question',
    'todo_write',
    // rendering: output, not investigation (dsh-motion-ui)
    'render_text',
    'render_ui',
    'render_canvas',
    'render_scene',
    'render_mechanism',
    'update_ui',
    'patch_ui',
    'validate_ui',
    'inspect_ui',
    'ui_catalog',
    'preview_video',
    'render_video',
    'process_video',
    'synthesize_voice',
    // document builders: output, not investigation (dsh-office-tools)
    'excel_create',
    'excel_update',
    'word_create',
    'word_update',
    'ppt_create',
  ]),
)

/**
 * dsh-auto-memory's tools. In the main session the whale's own memory replaces
 * them: one store, one injection, so the main session never reads two versions
 * of the same fact.
 */
export const AUTO_MEMORY_TOOLS = Object.freeze(
  new Set(['memory_write', 'memory_read', 'memory_list', 'memory_delete', 'memory_prune', 'memory_delete_all']),
)

/** The refusal an auto-memory tool gets inside the main session. */
export function autoMemoryReason(name) {
  return (
    `${name} belongs to dsh-auto-memory; the main session keeps its memory in home/memory/. ` +
    'Write with `remember` (user / memory / soul), read the files under home/memory/ with `read`.'
  )
}

/** Tools whose single argument names a file path. */
export const FILE_PATH_TOOLS = Object.freeze(new Set(['read', 'read_image']))

/** Tools that walk a directory tree instead of one named file. */
export const TREE_WALK_TOOLS = Object.freeze(new Set(['grep', 'glob']))

/**
 * Whether one live assistant-stream frame carries text the user can see.
 *
 * This is the precise definition the brakes need: the model actually emitted
 * non-whitespace text — not a tool call, not reasoning, not a block boundary.
 * `reasoning-delta` is deliberately excluded: thinking is not replying.
 *
 * A preset-mounted row cannot listen to `session/event` (that event is
 * dispatched at the host plane with no scope key, and a scoped listener is
 * filtered out), but `agent/assistant-stream` is dispatched with the agent as
 * the scope key, so a preset listener does receive it. This helper is what
 * turns that stream into "did the main session say something?".
 */
export function frameHasVisibleText(frame) {
  if (frame?.type !== 'chunk') return false
  const chunk = frame.chunk
  if (chunk?.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk?.type === 'block-end') {
    return chunk.block?.type === 'text' && typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  }
  return false
}

/**
 * Whether one inbox message is a real turn from the human.
 *
 * Plugin notices and runtime context are `user`-role messages too but carry a
 * different `source.kind`. Only the human's own input re-arms the brake
 * budget — otherwise the injected notice would reset the very counter it was
 * meant to stop.
 */
export function isRealUserMessage(message) {
  return message?.source?.kind === 'user'
}

/**
 * The read class: everything that pulls outside information into the context.
 *
 * `read_image` is a file read and is counted here; `web_fetch` / `web_search`
 * are research and are counted too. None of them is a path check except the
 * filesystem ones, which never reach the network.
 */
export const READ_TOOLS = Object.freeze(
  new Set(['read', 'read_image', 'grep', 'glob', 'web_fetch', 'web_search']),
)

/** Public documents a main session may read inside another workspace. */
export const PUBLIC_DOC_RULES = Object.freeze({
  /** `README.md`, `README.zh.md`, `README.rst.md` — public by convention, any depth. */
  readme: /^readme(\.[^/]*)?\.md$/i,
  /** Agent instructions; subdirectory copies are meant for agents to read. */
  agentInstructions: /^(agents|claude)\.md$/i,
  /** A top-level Markdown document. */
  topLevelMarkdown: /\.md$/i,
  /** Dependency manifest, needed to judge a stack without reading source. */
  manifest: /^package\.json$/,
})

/** Rendered once per exhausted epoch; kept verbatim for the report and tests. */
export function quotaExhaustedReason(limit) {
  return (
    `[Discipline Whale] Read quota exhausted — 0 of ${limit} read calls left in this reply. ` +
    'Stop reading now: answer the user with what you already have, then route the rest of the ' +
    'work with `dispatch_task` (or `send_to_session` for a running worker). ' +
    'The quota refreshes as soon as you produce user-visible text.'
  )
}

/** Rendered for every out-of-scope path; the "speak up" half of the scope rule. */
export function readScopeReason(target, { home, workspaceRoots }) {
  const places =
    workspaceRoots.length === 0
      ? 'no workspace is registered, so only your home is readable'
      : 'inside a registered workspace: README*.md, AGENTS.md, CLAUDE.md, docs/**/*.md, top-level *.md, and package.json'
  return (
    `[Discipline Whale] Read blocked — "${target}" is outside the main session's read scope. ` +
    `Readable: anything under your own home (${home}); public documents ${places}. ` +
    'Source files, configs, and data are not readable from the main session. ' +
    'To inspect this file, dispatch a worker into that workspace with `dispatch_task` and let it read it.'
  )
}

/** The injected prompt after a hard stop. Reset-the-quota is part of the text. */
export function hardStopNotice({ threshold, quota }) {
  return [
    `[Discipline Whale] Hard stop: ${threshold} tool calls in a row produced nothing for the user.`,
    'This turn has been terminated.',
    '',
    'Do not read any more files. Do this now, in this order:',
    '1. Give the user the conclusion you already have, in plain text — even if it is incomplete.',
    '2. Dispatch the remaining work with `dispatch_task` (one dispatch per separable piece) and say',
    '   which workspace you chose and why, in one line.',
    '3. If nothing is worth dispatching, say so and ask the user what to do next.',
    '',
    `Your read budget has been reset to ${quota} for this reply. Do not spend it on more`,
    "investigation: the main session's job is to talk to the user and route work, not to read",
    'the codebase.',
  ].join('\n')
}

/** Injected once, when the brake has spent its budget and stands down. */
export function brakeExhaustedNotice(max) {
  return [
    `[Discipline Whale] 主会话异常，已停止干预：本轮已经强制回话 ${max} 次，主会话仍在连续调用工具而不回复。`,
    'The forced-reply brake has stood down for the rest of this turn. The read quota still applies,',
    'so reads beyond it will be refused. Open the session and check it manually, or send a new',
    'message to re-arm the brake.',
  ].join('\n')
}

const NOTICE_SOURCE = Object.freeze({
  kind: 'plugin:discipline-whale',
  form: 'notice',
  summary: 'Discipline Whale main-session brake',
})

/* ------------------------------------------------------------------ *
 * configuration
 * ------------------------------------------------------------------ */

export const DEFAULT_MAIN_PRESET = 'discipline-whale'

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Normalize the guard config.
 *
 * Every field is optional; an unknown or invalid value falls back instead of
 * throwing, because a bad knob must never take the main row down with it.
 * `maxInterventions: 0` is legal and means "never intervene" — useful to test
 * the quota in isolation.
 */
export function resolveGuardConfig(input = {}, fallback = {}) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const mode =
    source.watchdogCounting === WATCHDOG_COUNTING_MODES.ALL ||
    source.watchdogCounting === WATCHDOG_COUNTING_MODES.READ_ONLY
      ? source.watchdogCounting
      : DEFAULT_WATCHDOG_COUNTING_MODE
  const rawMax = source.maxInterventions
  return {
    mainPreset:
      typeof (fallback.mainPreset ?? source.mainPreset) === 'string' &&
      (fallback.mainPreset ?? source.mainPreset) !== ''
        ? String(fallback.mainPreset ?? source.mainPreset)
        : DEFAULT_MAIN_PRESET,
    watchdogThreshold: positiveInteger(source.watchdogThreshold, WATCHDOG_SILENT_THRESHOLD),
    readQuota: positiveInteger(source.readQuota, READ_QUOTA_PER_EPOCH),
    maxInterventions:
      Number.isInteger(rawMax) && rawMax >= 0 ? rawMax : MAX_FORCED_INTERVENTIONS_PER_TURN,
    watchdogCounting: mode,
  }
}

/* ------------------------------------------------------------------ *
 * pure decisions
 * ------------------------------------------------------------------ */

/** Whether `child` is `parent` or sits below it, by path-segment prefix. */
export function isInside(child, parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false
  if (child === parent) return true
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child.startsWith(base)
}

/**
 * Whether a workspace-relative path is a document anyone may read.
 *
 * The rules are deliberately about *orientation*, not about content: a README
 * or an AGENTS.md tells an arriving agent what a project is, its docs describe
 * the intent, and `package.json` names the stack. None of them can be used to
 * read the implementation, which is the work a worker is dispatched for.
 */
export function isPublicDocPath(relPath) {
  const rel = relPath.split(sep).join('/')
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const segments = rel.split('/')
  // A hidden segment is never a public document: `.env`, `.ssh`, `.git/config`.
  if (segments.some((segment) => segment.startsWith('.'))) return false
  const base = segments[segments.length - 1]
  // Nothing nested may claim these names: `src/README.md` and
  // `packages/x/package.json` are source-tree positions, not the front door.
  const nested = segments.length > 1
  if (nested && segments[0] !== 'docs') {
    return PUBLIC_DOC_RULES.agentInstructions.test(base)
  }
  if (PUBLIC_DOC_RULES.readme.test(base)) return true
  if (PUBLIC_DOC_RULES.agentInstructions.test(base)) return true
  if (PUBLIC_DOC_RULES.manifest.test(base)) return !nested
  return PUBLIC_DOC_RULES.topLevelMarkdown.test(base)
}

/**
 * Decide one already-resolved (real) path against the read scope.
 *
 * `homeReal` and `workspaceRoots` are real paths too, so a symlink inside the
 * home that points outside is judged by its target, not by its name.
 */
export function classifyReadPath(realTarget, { homeReal, workspaceRoots = [] }) {
  if (isInside(realTarget, homeReal)) return { allowed: true, zone: 'home' }
  for (const root of workspaceRoots) {
    if (!isInside(realTarget, root)) continue
    const rel = relative(root, realTarget)
    if (isPublicDocPath(rel)) return { allowed: true, zone: 'public-document', workspace: root }
  }
  return { allowed: false, zone: 'outside' }
}

/** Whether one tool call is counted by the watchdog under `mode`. */
export function countsTowardWatchdog(toolName, mode) {
  if (PRODUCTIVITY_TOOLS.has(toolName)) return false
  if (mode === WATCHDOG_COUNTING_MODES.READ_ONLY) return READ_TOOLS.has(toolName)
  return true
}

/**
 * Resolve a path to its real form without requiring the leaf to exist.
 *
 * `realpath` throws ENOENT for a file that is not there yet; walking up to the
 * deepest existing ancestor and re-appending the rest keeps the symlink
 * resolution of every directory that does exist. Without that, a symlinked
 * workspace root would make every whitelist test pass on the unresolved
 * prefix and read the link target.
 */
export async function realPathOf(target) {
  let current = resolve(target)
  const tail = []
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : join(real, ...tail.slice().reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return current
      const parent = dirname(current)
      if (parent === current) return resolve(target)
      tail.push(current.slice(parent === sep ? parent.length : parent.length + 1))
      current = parent
    }
  }
}

/* ------------------------------------------------------------------ *
 * the guard
 * ------------------------------------------------------------------ */

/** The preset a live Agent was composed from, or undefined when unknowable. */
export function presetOfAgent(ctx, agent) {
  const header = agent?.session?.header
  if (typeof header?.agentPreset === 'string' && header.agentPreset !== '') return header.agentPreset
  try {
    const registry = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined
    const composed = registry?.composedPreset?.(agent?.ctx)
    if (typeof composed === 'string' && composed !== '') return composed
  } catch {
    // An absent preset registry proves nothing; fall through to "unknown".
  }
  return undefined
}

function emptyState() {
  return { silent: 0, reads: 0, interventions: 0, cappedNotified: false }
}

/**
 * Install the three brakes on a main-row context.
 *
 * @param ctx - the row context (`tools/pre-execute`, `session/event`, `agent/disposed`).
 * @param config - raw config; see {@link resolveGuardConfig}.
 * @param deps - test seams: `storeRoot`, `whaleHomeDir`, `workspaceRegistry`.
 * @returns a handle exposing the per-Session state map, for tests and diagnostics.
 */
export function installGuard(ctx, config = {}, deps = {}) {
  const resolved = resolveGuardConfig(config, { mainPreset: config.mainPreset })
  const root = () => (typeof deps.storeRoot === 'function' ? deps.storeRoot() : storeRoot())
  const homeDir = () => (typeof deps.whaleHomeDir === 'function' ? deps.whaleHomeDir() : whaleHomeDir(root()))
  const registry = () => {
    if (typeof deps.workspaceRegistry === 'function') return deps.workspaceRegistry()
    try {
      return typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : ctx.workspaceRegistry
    } catch {
      return undefined
    }
  }

  /** sessionId -> counters. Only main Sessions ever get an entry. */
  const sessions = new Map()

  const isMainAgent = (agent) => presetOfAgent(ctx, agent) === resolved.mainPreset

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = emptyState()
      sessions.set(sessionId, state)
    }
    return state
  }

  /** One user-visible reply closes the epoch: quota and silence both restart. */
  const noteReply = (sessionId) => {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    state.reads = 0
    state.silent = 0
  }

  const steerNotice = (agent, text, summary) => {
    try {
      if (typeof agent?.steer !== 'function') return false
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { ...NOTICE_SOURCE, summary },
      })
      return true
    } catch (error) {
      ctx.logger?.warn?.(`discipline-whale: could not steer the main session: ${error?.message ?? error}`)
      return false
    }
  }

  const hardStop = (agent, state) => {
    // `keepInbox: true`: a user message queued while the main session was
    // reading must survive the stop. The injected notice is appended after the
    // cancel, so `agent.steer` classifies it as waking-after-abort and the loop
    // runs it as its own turn once the aborted driver unwinds.
    let cancelled = false
    try {
      if (typeof agent?.cancel === 'function') {
        agent.cancel({ kind: 'hook', reason: 'discipline-whale: silent tool-call hard stop' }, { keepInbox: true })
        cancelled = true
      }
    } catch (error) {
      ctx.logger?.warn?.(`discipline-whale: could not cancel the main session: ${error?.message ?? error}`)
    }
    // The injected prompt must reset the budget it was just stopped by, or the
    // forced reply could not dispatch anything at all.
    state.silent = 0
    state.reads = 0
    const steered = steerNotice(
      agent,
      hardStopNotice({ threshold: resolved.watchdogThreshold, quota: resolved.readQuota }),
      `${resolved.watchdogThreshold} silent tool calls — stopping the turn`,
    )
    return { cancelled, steered }
  }

  const workspaceRoots = async () => {
    let list = []
    try {
      list = registry()?.list?.() ?? []
    } catch {
      list = []
    }
    const roots = []
    for (const workspace of list) {
      if (typeof workspace?.path !== 'string' || workspace.path === '') continue
      roots.push(await realPathOf(workspace.path))
    }
    // The home is checked separately and wholesale; keep it out of this list so
    // a public-document decision can never be reached for a home path.
    const homeReal = await realPathOf(homeDir())
    return { homeReal, roots: roots.filter((root) => !isInside(root, homeReal)) }
  }

  const deny = (reason) => ({ kind: 'deny', reason })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec?.agent
    // Fail open for anything the guard cannot positively identify as the main
    // preset: a worker must never be throttled, and an unguarded main session
    // is a far smaller failure than a blocked worker.
    if (agent === undefined || !isMainAgent(agent)) return next()

    const sessionId = agent.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return next()

    const name = String(exec.name ?? '')
    const state = stateFor(sessionId)
    const isRead = READ_TOOLS.has(name)

    // 0. one memory store in the main session
    if (AUTO_MEMORY_TOOLS.has(name)) return deny(autoMemoryReason(name))

    // 1. the quota is the always-on budget, checked before anything may grow it
    if (isRead && state.reads >= resolved.readQuota) return deny(quotaExhaustedReason(resolved.readQuota))

    // 2. the watchdog counts calls the model makes without saying anything
    if (countsTowardWatchdog(name, resolved.watchdogCounting)) {
      state.silent += 1
      if (state.silent >= resolved.watchdogThreshold) {
        if (state.interventions < resolved.maxInterventions) {
          state.interventions += 1
          const outcome = hardStop(agent, state)
          if (outcome.cancelled || outcome.steered) return { kind: 'cancel' }
          // Neither channel worked: do not count this call as a stop, and let it
          // through rather than silently dropping it.
          state.interventions -= 1
        } else if (resolved.maxInterventions > 0 && !state.cappedNotified) {
          state.cappedNotified = true
          steerNotice(
            agent,
            brakeExhaustedNotice(resolved.maxInterventions),
            'forced-reply brake stood down after its budget',
          )
        }
      }
    }

    // 3. the read scope, decided on real paths only
    if (FILE_PATH_TOOLS.has(name)) {
      const raw = exec.arguments?.file_path
      if (typeof raw === 'string' && raw !== '') {
        const cwd = agent.session?.header?.cwd
        const base = typeof cwd === 'string' && cwd !== '' ? cwd : homeDir()
        const target = await realPathOf(isAbsolute(raw) ? raw : resolve(base, raw))
        const { homeReal, roots } = await workspaceRoots()
        const verdict = classifyReadPath(target, { homeReal, workspaceRoots: roots })
        if (!verdict.allowed) return deny(readScopeReason(target, { home: homeReal, workspaceRoots: roots }))
      }
    } else if (TREE_WALK_TOOLS.has(name)) {
      // A tree walk cannot be filtered after the fact, so it is home-only: one
      // `grep` over a repository would otherwise read every file the whitelist
      // exists to refuse.
      const raw = exec.arguments?.path
      const cwd = agent.session?.header?.cwd
      const base = typeof cwd === 'string' && cwd !== '' ? cwd : homeDir()
      const target =
        typeof raw === 'string' && raw !== '' ? await realPathOf(isAbsolute(raw) ? raw : resolve(base, raw)) : await realPathOf(base)
      const homeReal = await realPathOf(homeDir())
      if (!isInside(target, homeReal)) {
        return deny(readScopeReason(target, { home: homeReal, workspaceRoots: [] }))
      }
    }

    if (isRead) state.reads += 1
    return next()
  })

  // A preset-mounted row cannot observe `session/event`: that event is
  // dispatched on the HOST plane with no scope key, so a scoped listener is
  // filtered out and would silently never fire (proved against the real
  // cordis + dsh-scope packages in test/guard.mjs). The agent-subject
  // events below are dispatched with the Agent itself as the scope key, and an
  // Agent's scope is parented to its preset generation
  // (`AgentPresetsService.join`), so a listener registered by this row does
  // receive exactly the main Session's events.

  // User-visible text: a non-whitespace text chunk is the precise signal that
  // the main session is talking to the user rather than reading. This is what
  // refreshes the read quota.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!isMainAgent(agent) || !frameHasVisibleText(frame)) return
    noteReply(agent?.session?.id)
  })

  // A real user turn re-arms everything. `source.kind === 'user'` excludes the
  // notices this module itself injects, which are user-role messages too.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (!isMainAgent(agent) || !isRealUserMessage(message)) return
    const state = sessions.get(agent?.session?.id)
    if (state === undefined) return
    state.interventions = 0
    state.cappedNotified = false
    state.reads = 0
    state.silent = 0
  })

  // Forget a Session when it goes away, so the map cannot grow without bound in
  // a long-lived process.
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string') sessions.delete(sessionId)
  })

  return { config: resolved, sessions, isMainAgent }
}
