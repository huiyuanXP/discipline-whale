/**
 * discipline-whale — how the question queue reaches the Host.
 *
 * `question-tools.js` is deliberately Host-free: it takes `deliver` and
 * `liveness` as injected functions. This module is the one place that knows how
 * to talk to a live Harness, and it exists as its own file for a specific
 * reason — the wiring point is `home.js`, the profile-level row that is already
 * mounted, while `main.js` (the preset row that owns the other main-session
 * tools) is owned by a concurrent release task.
 *
 * TWO FACTS IT RESTS ON, both verified in the installed packages:
 *
 *   1. `tools.register()` is SCOPED BY THE CALLING CONTEXT, not global
 *      (`dsh-tools` lib/index.js:2974 -> `layers.effect(this.ctx, ...)`, and
 *      `dsh-scope` lib/index.js:189 reads `scopeOf(ctx)`). Registering from
 *      `home.js` directly would land the tool in the GLOBAL layer and hand it to
 *      every coding session in the process. So the tool is registered through
 *      the main agent's own context instead, exactly as `tool-subagent` does at
 *      `dsh-tool-subagent` lib/index.js:578 (`candidate.ctx.inject([...])`).
 *   2. The reply is a plain `sessionController.prompt(..., mode:'steer')`, which
 *      reaches a cold Session by resuming it (`dsh-api-session-controller`
 *      lib/index.js:221 `resolve()` -> `resume()`, then `:950` `agent.steer`).
 *      The `user-question-reply` shape is NOT used: `answer()` needs a live root
 *      (`assertLiveRoot`, `dsh-user-questions` lib/index.js:534) and the worker
 *      never made the pending call that shape closes.
 *
 * @module discipline-whale/question-host
 */

import { randomUUID } from 'node:crypto'

import { isDispatchAbandoned } from './checkpoint.js'
import { createQuestionTools } from './question-tools.js'
import { storeRoot } from './store.js'

/** Preset the main session runs; the only agent that receives the tool. */
export const MAIN_PRESET = 'discipline-whale'

/**
 * Read one live agent's preset id without importing `dsh-agent-preset-registry`.
 *
 * The header is the durable, dependency-free source; the registry lookup is the
 * fallback for an agent whose header has not been stamped yet. This mirrors
 * `guard.presetOfAgent`, which is the same question asked for a different
 * purpose — the duplication is deliberate, because `guard.js` is a preset row's
 * module and must not be imported by a profile-level row.
 */
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

/**
 * Whether a worker Session can still receive an answer.
 *
 * Live agents are the easy case. A cold Session is NOT automatically dead: the
 * controller resumes one on the next prompt (`resolveAgent` -> `resume`), which
 * is exactly how a worker that finished a turn and idled is woken with the
 * answer. So "cold" counts as live, and only an abandoned dispatch retires the
 * question on this path.
 *
 * An abandoned dispatch is the one unambiguous "nobody is waiting": the file is
 * written by `abandon_dispatch` precisely so a later reader stops routing work
 * to that Session (`checkpoint.isDispatchAbandoned`).
 */
export function livenessFor(ctx, homeDir = storeRoot()) {
  return (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return { live: false, abandoned: false }
    if (isDispatchAbandoned(homeDir, sessionId)) return { live: false, abandoned: true }
    // A live agent is proof. A missing one is not proof of absence -- the
    // Session may simply be cold and resumable -- so it stays "live" here and
    // the delivery itself is what reports the truth.
    return { live: true }
  }
}

/**
 * Steer one answer into the worker Session that asked.
 *
 * `mode: 'steer'` puts the answer in the next-step inbox, which is the same
 * boundary `send_to_session` documents as its default: an in-flight tool call
 * finishes, then the worker re-plans with the answer in hand. `queue` would make
 * a blocked worker wait out its whole turn for an answer it is blocked on.
 */
export function deliverAnswer(ctx) {
  return async (sessionId, text) => {
    await ctx.sessionController.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'steer',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    )
    return { accepted: true }
  }
}

/**
 * Install the main session's question tool.
 *
 * The tool is bound to the MAIN agent's scope rather than this row's, so:
 *   * a worker cannot see it (a worker is a different preset, and a different
 *     scope chain entirely),
 *   * a plain coding session cannot see it (it is not in the global layer),
 *   * it disposes with the agent, so a session that goes away leaves nothing
 *     behind.
 *
 * `agent/created` is the hook `tool-subagent`, `dsh-goal` and the session
 * controller all use for exactly this. A row mounted before the agent exists
 * therefore still ends up wired, and one mounted after (a restart with a
 * resumed session) catches the next `agent/created`.
 */
export function installQuestionTool(ctx, options = {}) {
  // A composition without an event bus or a session controller (a bare profile,
  // a test double) simply has nowhere to put this tool. Skipping is the correct
  // behaviour: the queue itself is still usable through the files, and a mount
  // that cannot ask the user has nothing to install.
  if (typeof ctx?.on !== 'function' || ctx?.sessionController === undefined) {
    ctx?.logger?.warn?.('discipline-whale: pending_questions skipped — this composition has no agent lifecycle')
    return false
  }
  const homeDir = options.homeDir ?? storeRoot
  const tools = createQuestionTools({
    root: () => (typeof homeDir === 'function' ? homeDir() : homeDir),
    // Kept explicit and UNUSED by the tool: the main session calls
    // `ask_user_question` itself, from its own live-root turn.
    askUser: () => Promise.reject(new Error('main session asks with ask_user_question, never from here')),
    deliver: deliverAnswer(ctx),
    liveness: livenessFor(ctx, typeof homeDir === 'function' ? homeDir() : homeDir),
  })

  const installed = new WeakSet()
  const installFor = (agent) => {
    if (agent === undefined || installed.has(agent)) return
    if (presetOfAgent(ctx, agent) !== MAIN_PRESET) return
    installed.add(agent)
    try {
      // `agent.ctx` is the per-agent scope; registering through it is what keeps
      // this tool out of every other session's tool surface.
      agent.ctx.inject(['tools'], (agentCtx) => {
        for (const tool of Object.values(tools)) agentCtx.tools.register(tool)
      })
    } catch (error) {
      ctx.logger?.warn?.(
        `discipline-whale: could not register pending_questions on the main session: ${error?.message ?? error}`,
      )
    }
  }

  ctx.on('agent/created', ({ agent }) => installFor(agent))

  // Catch an agent that already exists when this row mounts (a hot reload, or a
  // profile row loaded after the main session was resumed).
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    for (const agent of agents?.roots?.() ?? []) installFor(agent)
  } catch {
    // No registry yet: the `agent/created` listener above still covers it.
  }
  return true
}
