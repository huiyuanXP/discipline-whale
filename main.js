/**
 * discipline-whale — main-session half.
 *
 * Mounted only inside the Discipline Whale preset. Registers the tools the main
 * session is allowed to use: look at workspaces, dispatch work, talk to a
 * worker, and read a stored report in full.
 *
 * The main session deliberately does NOT get `report_to_main`; that belongs to
 * workers. It also does not get any worker enforcement, because it is the party
 * being reported to.
 *
 * @module discipline-whale/main
 */

import { randomUUID } from 'node:crypto'

import {
  dropDispatchCheckpoint,
  markDispatchAbandoned,
  readDispatchCheckpoint,
  writeDispatchCheckpoint,
} from './checkpoint.js'
import { dispatchForWorker, listDispatches, recordDispatch } from './registry.js'
import { installGuard, resolveGuardConfig } from './guard.js'
import { installBrevity } from './adhd.js'
import { isReportId, listReports, readReport, storeRoot } from './store.js'

/**
 * A usable AbortSignal for a Host call.
 *
 * `sessionController.prompt(request, signal)` dereferences its signal
 * unconditionally, so every call site must supply one. Tool executions normally
 * carry one; a test mount may not.
 */
function signalOf(exec) {
  return exec?.signal ?? new AbortController().signal
}

export const name = 'discipline-whale-main'

/** The Host services this row needs. */
export const inject = ['tools', 'sessionController', 'workspaceRegistry']

function describeWorkspace(workspace) {
  return `${workspace.title} (${workspace.id}) ${workspace.path}`
}

/** Resolve one registered workspace from an id, title, path, or unique fragment. */
export function resolveWorkspace(registry, selector) {
  const all = registry.list()
  if (selector === undefined || selector === '') {
    throw new Error('a workspace is required; call list_workspaces to see the registered ones')
  }
  const exact = all.find(
    (workspace) => workspace.id === selector || workspace.title === selector || workspace.path === selector,
  )
  if (exact !== undefined) return exact

  const needle = String(selector).toLowerCase()
  const loose = all.filter(
    (workspace) =>
      workspace.title.toLowerCase().includes(needle) || workspace.path.toLowerCase().includes(needle),
  )
  if (loose.length === 1) return loose[0]
  if (loose.length > 1) {
    throw new Error(
      `workspace selector "${selector}" is ambiguous; candidates:\n- ${loose.map(describeWorkspace).join('\n- ')}`,
    )
  }
  throw new Error(
    `no registered workspace matches "${selector}"; registered workspaces:\n- ${all.map(describeWorkspace).join('\n- ')}`,
  )
}

/* ------------------------------------------------------------------ *
 * continuation routing
 * ------------------------------------------------------------------ */

/**
 * Canonical form of a work-thread name, or `undefined` when there is none.
 *
 * Case and inner whitespace are folded because "Voice-Input", "voice-input "
 * and "voice  input" are the same thread to a human, and a routing rule that
 * disagrees with a human's reading would either duplicate Sessions or merge
 * unrelated ones. Nothing else is normalised: the topic stays an opaque label,
 * so the rule needs no per-project knowledge.
 */
function normalizeTopic(value) {
  if (typeof value !== 'string') return undefined
  const collapsed = value.trim().replace(/\s+/g, ' ').toLowerCase()
  return collapsed === '' ? undefined : collapsed
}

/** Canonical workspace-relative write prefixes; blank entries are dropped. */
function normalizeWrites(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry !== ''))]
}

/** Whether two workspace-relative path prefixes cover a common file. */
function prefixesOverlap(a, b) {
  // Prefix equality is covered by the prefixes() test both ways; comparing the
  // strings first keeps the common identical case obvious.
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/** Whether one dispatch is still able to take more work. */
function isLive(record) {
  return record.status !== 'reported' && record.status !== 'abandoned'
}

/**
 * The Session that should continue instead of a new one being created.
 *
 * Decidable, not a judgement call: same workspace, same normalised topic, and
 * still live (never reported, never abandoned). A reported Session is finished
 * work — the user asking for more is a new piece of work, so it starts fresh.
 * Without a topic there is nothing to compare, so nothing is reused.
 */
function findReusableDispatch(workspace, topic) {
  if (topic === undefined) return undefined
  const workspaceId = String(workspace.id)
  return listDispatches().find(
    (record) =>
      record.workspaceId === workspaceId && record.topic === topic && isLive(record),
  )
}

/**
 * The live dispatch whose declared write scope overlaps `writes`, if any.
 *
 * This is the guard that keeps two Sessions from editing one tree. Scoped to a
 * workspace on purpose: two workspaces are two checkouts, and a path prefix in
 * one says nothing about the other. A dispatch that declared no scope cannot be
 * proven disjoint, so it is treated as disjoint — the rule only fires on
 * declared overlaps, and claiming more than that would refuse work for a reason
 * the caller never supplied.
 */
function findWriteClash(workspace, writes) {
  if (writes.length === 0) return undefined
  const workspaceId = String(workspace.id)
  for (const record of listDispatches()) {
    if (record.workspaceId !== workspaceId || !isLive(record)) continue
    const declared = Array.isArray(record.writes) ? record.writes : []
    if (!declared.some((prefix) => writes.some((mine) => prefixesOverlap(prefix, mine)))) continue
    return record
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * dispatch board helpers
 * ------------------------------------------------------------------ */

/**
 * Parse an ISO timestamp into epoch milliseconds, or `undefined` when the value
 * is absent or not a real date.
 *
 * Records are plain mutable objects written by two different rows, so this must
 * tolerate junk (`startedAt: 'soon'`, a missing field) without throwing inside a
 * read-only board tool.
 */
function timeOf(value) {
  if (typeof value !== 'string' || value === '') return undefined
  // Both rows always write `new Date().toISOString()`, so require the shape
  // before parsing. `Date.parse` alone is far too lenient: it happily turns
  // garbage like "bad-1" into the year 2000, which would surface as a bogus
  // ~25-year elapsed time instead of the warning this case deserves.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Human-readable duration: `450ms`, `12s`, `3m 12s`, `2h 05m`. */
function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(ms) || 0)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** Collapse whitespace and cut a task brief down to a scannable excerpt. */
function excerpt(text, max = 120) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Derive the three-state board status from what the two rows actually write.
 *
 * The worker row sets `status` only on a terminal transition, so an absent field
 * is the running signal. Any value that is not one of the two known terminal
 * markers is treated as running rather than inventing a fourth state.
 */
function boardStatus(record) {
  if (record.status === 'reported') return 'reported'
  if (record.status === 'abandoned') return 'abandoned'
  return 'running'
}

/* ------------------------------------------------------------------ *
 * tools
 * ------------------------------------------------------------------ */

function listWorkspacesTool(ctx) {
  return {
    name: 'list_workspaces',
    description:
      'List every registered DeepSeek Harness workspace with its id, title, path, and session count. Use it to decide where a piece of work belongs before dispatching it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['workspaces'],
        properties: {
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'path', 'sessionCount'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                path: { type: 'string' },
                sessionCount: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'List workspaces', kind: 'read' }),
    execute() {
      const workspaces = ctx.workspaceRegistry.list().map((workspace) => ({
        id: String(workspace.id),
        title: workspace.title,
        path: workspace.path,
        sessionCount: workspace.sessionIds.length,
      }))
      return Promise.resolve({ workspaces })
    },
  }
}

function dispatchTaskTool(ctx, config) {
  return {
    name: 'dispatch_task',
    description:
      'Create a worker Session in a workspace and give it a task. The worker runs the worker preset: it has coding tools but no dispatch tools, and neither do its sub-agents. Reports arrive in this session as pushed messages — do not poll for them. Returns a dispatch id and the worker session id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'task'],
      properties: {
        workspace: {
          type: 'string',
          description: 'Target workspace: id, exact title, absolute path, or a unique fragment of either.',
        },
        task: {
          type: 'string',
          description:
            'The complete brief. State the goal, the acceptance criteria, and anything it must not do. The worker starts immediately with this as its first message.',
        },
        title: {
          type: 'string',
          description: 'Optional worker Session title shown in the Session List (max 120 chars).',
        },
        topic: {
          type: 'string',
          description:
            'Stable name for the thread of work, e.g. "voice-input". Two dispatches in one workspace with the same topic (compared case-insensitively, whitespace collapsed) are the same job: the second continues the first Session instead of creating one. Omit it and every dispatch is a new Session.',
        },
        at: {
          type: 'string',
          enum: DELIVERY_TIMINGS,
          description:
            'When to deliver when this continues a live dispatch. "step" (default): at the next step boundary of the current turn — the in-flight tool call finishes, then the worker re-plans with this work and keeps its context. "queue": after the turn ends. "abort": cancel the running turn first (last resort). Ignored when a new Session is created.',
        },
        writes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Workspace-relative path prefixes this task will modify (e.g. ["src/voice"]). Declare it so a second concurrent dispatch in the same workspace is refused when its prefixes overlap: two Sessions editing one tree is what this check exists to prevent.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dispatchId', 'workerSessionId', 'workspaceId', 'workspaceTitle', 'status', 'reused'],
        properties: {
          dispatchId: { type: 'string' },
          workerSessionId: { type: 'string' },
          workspaceId: { type: 'string' },
          workspaceTitle: { type: 'string' },
          status: {
            type: 'string',
            enum: ['dispatched', 'dispatch-prompt-failed', 'reused'],
          },
          /** True when this continued an existing Session instead of creating one. */
          reused: { type: 'boolean' },
          /** Timing actually honoured when this continued an existing Session. */
          deliveredAs: { type: 'string', enum: DELIVERY_TIMINGS },
          title: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Dispatch task', kind: 'other', rawInput: args.workspace }),
    async execute(args, exec) {
      const task = String(args.task ?? '').trim()
      if (task === '') throw new Error('`task` is empty; a worker needs a brief')
      if (task.length > 60000) throw new Error('`task` is longer than 60000 characters')
      const title = args.title
      if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
        throw new Error('`title` must be a non-empty string when given')
      }
      if (title !== undefined && title.length > 120) {
        throw new Error('`title` is longer than 120 characters')
      }
      const timing = resolveTiming(args.at)
      const topic = normalizeTopic(args.topic)
      if (args.topic !== undefined && topic === undefined) {
        throw new Error('`topic` must be a non-empty string when given')
      }
      const writes = normalizeWrites(args.writes)

      const workspace = await resolveWorkspace(ctx.workspaceRegistry, args.workspace)
      const warnings = []

      // Route before creating: a live Session on the same thread of work is
      // continued, never duplicated. Two Sessions on one topic in one
      // workspace is exactly the conflict this rule prevents.
      const live = findReusableDispatch(workspace, topic)
      if (live !== undefined) {
        const delivered = await deliverInstruction(ctx, exec, live.workerSessionId, task, timing)
        live.status = live.status ?? 'running'
        // Keep the checkpoint's routing facts fresh even though the Session did
        // not change: the brief that now matters is this one.
        try {
          await writeDispatchCheckpoint(storeRoot(), live.workerSessionId, live)
        } catch (error) {
          warnings.push(`the dispatch record could not be refreshed on disk: ${String(error?.message ?? error)}`)
        }
        return {
          dispatchId: live.dispatchId,
          workerSessionId: live.workerSessionId,
          workspaceId: live.workspaceId,
          workspaceTitle: live.workspaceTitle,
          status: 'reused',
          reused: true,
          deliveredAs: delivered.delivered,
          warnings,
        }
      }

      // A new Session may still collide with a different thread writing the
      // same tree. Refuse that loudly instead of letting the two fight.
      const clash = findWriteClash(workspace, writes)
      if (clash !== undefined) {
        throw new Error(
          `write scope overlap in workspace "${workspace.title}": this dispatch declares ` +
            `${JSON.stringify(writes)} and worker ${clash.workerSessionId} (dispatch ${clash.dispatchId}, ` +
            `topic "${clash.topic ?? '(none)'}") already declared ${JSON.stringify(clash.writes)}. ` +
            'Two Session in one workspace must not edit the same files. Continue that Session with ' +
            'send_to_session, give this one a disjoint `writes` scope, or wait for its report.',
        )
      }

      const created = await ctx.sessionController.create({
        workspaceId: workspace.id,
        agentPreset: config.workerPreset,
      })
      const workerSessionId = String(created.sessionId)
      // A worker running a different preset holds a different dispatch registry,
      // so its report could never find this dispatch. Fail loudly instead of
      // letting the worker discover it at report time.
      if (created.agentPreset !== undefined && created.agentPreset !== config.workerPreset) {
        throw new Error(
          `worker preset mismatch: asked for "${config.workerPreset}" but the Host used "${created.agentPreset}"; ` +
            'set config.workerPreset on the discipline-whale/main row to the exact worker preset id',
        )
      }

      let appliedTitle
      if (title !== undefined) {
        try {
          const renamed = await ctx.sessionController.rename({ sessionId: workerSessionId, title })
          appliedTitle = renamed.title
        } catch (error) {
          warnings.push(`title not applied: ${String(error?.message ?? error)}`)
        }
      }

      const dispatchId = `dispatch-${randomUUID()}`
      const mainSessionId = exec.agent?.session?.id
      if (mainSessionId === undefined) {
        warnings.push('no calling Session id; the worker cannot push a report back to it')
      }
      const dispatch = recordDispatch({
        dispatchId,
        mainSessionId,
        workerSessionId,
        workspaceId: String(workspace.id),
        workspaceTitle: workspace.title,
        task,
        startedAt: new Date().toISOString(),
        // Routing facts for the continuation rule. `topic` is what makes "the
        // same job" decidable rather than a judgement call; `writes` is what
        // keeps two live Sessions out of one tree.
        ...(topic === undefined ? {} : { topic }),
        ...(writes.length === 0 ? {} : { writes }),
      })

      // Persist the routing facts now, to the same file the worker half reads.
      //
      // The worker checkpoints on its first lifecycle event, which leaves a
      // window: a restart after this tool returns but before that first event
      // would still lose the record and degrade the report to the orphan path.
      // Writing here closes that window — the two halves are then aligned by
      // construction, not by timing.
      //
      // A failed write must never fail the dispatch: the worker is already
      // created and about to be briefed, and the in-memory record still routes
      // the report for the lifetime of this process. The cost is only that this
      // particular dispatch would not survive a restart, which is disclosed as
      // a warning instead of silently.
      try {
        await writeDispatchCheckpoint(storeRoot(), workerSessionId, dispatch)
      } catch (error) {
        warnings.push(
          `the dispatch record could not be written to disk (${String(error?.message ?? error)}); ` +
            'the report will still be delivered in this process, but this dispatch would not survive a Harness restart',
        )
      }

      // The brief carries the report contract so enforcement has something to
      // point at even when the worker preset's persona is terse.
      const brief = [
        'You are a Discipline Whale worker. Complete the task below in this workspace.',
        '',
        '## Task',
        task,
        '',
        '## Mandatory closing step',
        'Before your turn ends you MUST call `report_to_main` exactly once:',
        '- `summary` — one short paragraph the main session can read without a tool call',
        '- `document` — the full write-up: what changed, what you verified, what is left',
        'If you stop without reporting, you will be steered back and asked to report.',
        '',
        'You cannot dispatch further work: this preset has no dispatch tools, and your sub-agents inherit it.',
      ].join('\n')

      let status = 'dispatched'
      try {
        await ctx.sessionController.prompt(
          {
            requestId: randomUUID(),
            sessionId: workerSessionId,
            mode: 'queue',
            content: [{ type: 'text', text: brief }],
          },
          signalOf(exec),
        )
      } catch (error) {
        status = 'dispatch-prompt-failed'
        warnings.push(`worker created but the brief was rejected: ${String(error?.message ?? error)}`)
      }

      return {
        dispatchId,
        workerSessionId,
        workspaceId: String(workspace.id),
        workspaceTitle: workspace.title,
        status,
        reused: false,
        ...(appliedTitle === undefined ? {} : { title: appliedTitle }),
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
  }
}

function readReportTool(ctx) {
  return {
    name: 'read_report',
    description:
      'Read one worker report in full, or list recent reports for a workspace. Summaries already arrive as pushed messages; use this only when you need the long document behind one of them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        report_id: { type: 'string', description: 'Exact report id from a pushed summary.' },
        workspace: { type: 'string', description: 'Workspace to list reports from when no report id is given.' },
        limit: { type: 'integer', description: 'Maximum reports to list (1-50, default 10).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'object', additionalProperties: true, properties: {} },
          reports: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Read report', kind: 'read' }),
    async execute(args) {
      const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50)

      if (args.report_id !== undefined) {
        if (!isReportId(args.report_id)) throw new Error('`report_id` is not a valid report id')
        for (const workspace of ctx.workspaceRegistry.list()) {
          const report = await readReport(storeRoot(), workspace.id, args.report_id)
          if (report !== undefined) return { report }
        }
        return { note: `no report with id "${args.report_id}" was found in any workspace` }
      }

      const workspace = await resolveWorkspace(ctx.workspaceRegistry, args.workspace)
      const reports = (await listReports(storeRoot(), workspace.id)).slice(0, limit)
      return {
        reports: reports.map((report) => ({
          id: report.id,
          status: report.status,
          outcome: report.outcome,
          workerSessionId: report.workerSessionId,
          summary: report.summary,
          reportedAt: report.reportedAt,
        })),
        note: reports.length === 0 ? 'this workspace has no reports yet' : `${reports.length} report(s)`,
      }
    },
  }
}

/**
 * The three delivery timings, named so a caller cannot confuse them.
 *
 *   queue  — admitted after the current TURN ends (`followup` -> inbox
 *            `next-turn`). The worker finishes everything it planned first.
 *   step   — admitted at the next STEP boundary, inside the SAME turn (`steer`
 *            -> inbox `next-step`). The in-flight tool call finishes normally,
 *            then the worker re-plans with the instruction and keeps its whole
 *            context. This is "Interrupt" in the user's sense.
 *   abort  — the running turn's AbortSignal is cancelled before the instruction
 *            is steered in. Last resort: it stops a tool call mid-flight and can
 *            leave half-written work.
 */
export const DELIVERY_TIMINGS = ['queue', 'step', 'abort']

/** Resolve the delivery timing; an omitted `at` means the step boundary. */
export function resolveTiming(at) {
  if (at === undefined) return 'step'
  if (!DELIVERY_TIMINGS.includes(at)) {
    throw new Error(`\`at\` must be one of ${DELIVERY_TIMINGS.join(' / ')}`)
  }
  return at
}

/**
 * Deliver one instruction into a Session at the requested timing.
 *
 * The Host facts this rests on (verified in VERIFICATION.md section 11):
 *
 *   * `sessionController.prompt({ mode })` accepts exactly `queue` and `steer`
 *     (`@deepseek-ai/dsh-api-session-controller` lib/typert.host.js:1795). There
 *     is no `interrupt` mode; the timing is composed here.
 *   * `followup` -> inbox `next-turn`, `steer` -> inbox `next-step`
 *     (`dsh-agent-loop` lib/index.js:806-811).
 *   * The turn loop opens with `target = "next-turn"` and switches to
 *     `"next-step"` after its first step (`lib/index.js:951`, `1008`); `claim`
 *     drains `next-step` at EVERY step boundary but drains `next-turn` only for
 *     the `"next-turn"` target (`lib/index.js:103-105`). A `steer` is therefore
 *     visible at the next step of the current turn: the step-boundary insert,
 *     with no abort needed.
 *   * To abort first: `sessionController.cancel` aborts the live turn while
 *     keeping the inbox (`dsh-api-session-controller` lib/types/commands.js:466-475
 *     -> `dsh-agent-loop` lib/index.js:815-821). A cold Session raises
 *     `session/not-found`, which is not a failure: there is no turn to abort.
 *
 * @returns the timing honoured and whether a running turn was aborted.
 */
async function deliverInstruction(ctx, exec, sessionId, message, timing) {
  let aborted = false
  if (timing === 'abort') {
    try {
      await ctx.sessionController.cancel({ sessionId })
      aborted = true
    } catch (error) {
      ctx.logger?.warn?.(
        `discipline-whale: could not abort ${sessionId} (${String(error?.message ?? error)}); ` +
          'the instruction is still delivered at the step boundary',
      )
    }
  }
  // `signal` is a required parameter of session/prompt: the controller calls
  // signal.throwIfAborted() before admitting anything.
  await ctx.sessionController.prompt(
    {
      requestId: randomUUID(),
      sessionId,
      // `queue` waits for the turn to end; `step` and `abort` both target the
      // step inbox, which is what makes the instruction land inside the turn.
      mode: timing === 'queue' ? 'queue' : 'steer',
      content: [{ type: 'text', text: message }],
    },
    signalOf(exec),
  )
  return { sessionId, accepted: true, delivered: timing, aborted }
}

function sendToSessionTool(ctx) {
  return {
    name: 'send_to_session',
    description:
      'Send a new instruction to an existing Session and wake it. Default `at: "step"` inserts the message at the next step boundary of the SAME turn: the in-flight tool call finishes, then the worker re-plans with your instruction while keeping everything it has read. Use `at: "queue"` to wait for the whole turn to end, and `at: "abort"` only when the worker is actively writing the wrong thing and must be stopped mid-call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['session_id', 'message'],
      properties: {
        session_id: {
          type: 'string',
          description: 'Target Session id, usually a worker session id from dispatch_task.',
        },
        message: { type: 'string', description: 'The instruction to deliver.' },
        at: {
          type: 'string',
          enum: DELIVERY_TIMINGS,
          description:
            'When the instruction takes effect. "step" (default): at the next step boundary inside the current turn — not instant, it waits for the in-flight tool call to finish. "queue": after the current turn ends. "abort": cancel the running turn first (last resort; can leave half-written work).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'accepted', 'delivered', 'aborted'],
        properties: {
          sessionId: { type: 'string' },
          accepted: { type: 'boolean' },
          /** Which timing was honoured: the inbox target this instruction went to. */
          delivered: { type: 'string', enum: DELIVERY_TIMINGS },
          /** True only when a running turn was actually aborted first. */
          aborted: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: (args) => ({ card: 'generic', title: 'Send to session', kind: 'other', rawInput: args.session_id }),
    async execute(args, exec) {
      const message = String(args.message ?? '').trim()
      if (message === '') throw new Error('`message` is empty')
      if (message.length > 60000) throw new Error('`message` is longer than 60000 characters')
      if (typeof args.session_id !== 'string' || args.session_id === '') {
        throw new Error('`session_id` is required')
      }
      const sessionId = String(args.session_id)
      const timing = resolveTiming(args.at)
      return deliverInstruction(ctx, exec, sessionId, message, timing)
    },
  }
}

const BOARD_LIMIT_DEFAULT = 50
const BOARD_LIMIT_MAX = 200

/**
 * Best-effort read of each worker Session's last user-authored prompt time.
 *
 * `sessionController.list()` is the only public way to see per-Session activity,
 * and what it exposes is `SessionSummary.updatedAt = max(createdAt, lastPromptAt)`
 * — the latest *human/user* message, NOT the latest message of any kind. A worker
 * produces assistant turns and tool calls after that prompt, so this value stays
 * pinned at dispatch time for a busy worker. It is therefore reported under its
 * own name, never as `lastActivityAt`.
 *
 * Never throws: a board read must survive a Host whose list call is slow, absent,
 * or rejects. Failures come back as a warning instead.
 */
async function readLastPromptTimes(ctx, exec) {
  const bySession = new Map()
  const warnings = []
  if (typeof ctx.sessionController?.list !== 'function') {
    warnings.push('`sessionController.list` is unavailable, so lastPromptAt is omitted for every row')
    return { bySession, warnings }
  }
  try {
    const listed = await ctx.sessionController.list({}, signalOf(exec))
    for (const item of listed?.items ?? []) {
      if (typeof item?.sessionId !== 'string') continue
      if (!Number.isFinite(item.updatedAt)) continue
      bySession.set(item.sessionId, new Date(item.updatedAt).toISOString())
    }
  } catch (error) {
    warnings.push(`could not read Session activity: ${String(error?.message ?? error)}`)
  }
  return { bySession, warnings }
}

function listDispatchesTool(ctx) {
  return {
    name: 'list_dispatches',
    description:
      'Show the current dispatch board: every dispatch this process recorded, with its worker session, state (running / reported / abandoned), and how long it has been out. Use it to answer "what is still in flight?" before dispatching more work, or to see which workers never reported. A running dispatch whose worker never reports is the case worth acting on.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workspace: {
          type: 'string',
          description: 'Optional filter: case-insensitive fragment of a workspace id or title. Unknown values simply match nothing.',
        },
        limit: {
          type: 'integer',
          description: `Maximum rows to return (1-${BOARD_LIMIT_MAX}, default ${BOARD_LIMIT_DEFAULT}). Newest dispatch first.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dispatches', 'counts'],
        properties: {
          dispatches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['dispatchId', 'workerSessionId', 'status', 'elapsed', 'lastActivityAt'],
              properties: {
                dispatchId: { type: 'string' },
                workerSessionId: { type: 'string' },
                status: { type: 'string', enum: ['running', 'reported', 'abandoned'] },
                elapsed: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['ms', 'human'],
                  properties: {
                    ms: { type: 'integer' },
                    human: { type: 'string' },
                    /** Which timestamp closed the interval: a report, or "now". */
                    until: { type: 'string', enum: ['reported', 'abandoned', 'now'] },
                  },
                },
                /**
                 * NOT "the last message time". See `lastActivitySource`: this is
                 * the last registry-visible transition (report/abandon) or, for a
                 * dispatch with none, its start.
                 */
                lastActivityAt: { type: 'string', description: 'Last registry-visible transition (reported/abandoned), else the dispatch start. Not the last message time.' },
                lastActivitySource: { type: 'string', enum: ['reported', 'abandoned', 'started'] },
                /** Latest user-authored prompt in the worker Session, when the Host can supply it. Never post-dispatch progress. */
                lastPromptAt: { type: 'string' },
                /** Set when the record was rebuilt after a restart; `session-log` means no checkpoint existed. */
                recoveredFrom: { type: 'string', enum: ['checkpoint', 'session-log'] },
                /** True when no main session could be recovered: a report from this worker will not be pushed. */
                orphaned: { type: 'boolean' },
                workspaceId: { type: 'string' },
                workspaceTitle: { type: 'string' },
                taskExcerpt: { type: 'string' },
                startedAt: { type: 'string' },
                reportedAt: { type: 'string' },
                reportId: { type: 'string' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: ['total', 'running', 'reported', 'abandoned'],
            properties: {
              total: { type: 'integer' },
              running: { type: 'integer' },
              reported: { type: 'integer' },
              abandoned: { type: 'integer' },
            },
          },
          note: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Dispatch board', kind: 'read' }),
    async execute(args, exec) {
      const rawLimit = args.limit === undefined ? BOARD_LIMIT_DEFAULT : Number(args.limit)
      if (!Number.isInteger(rawLimit)) throw new Error('`limit` must be an integer')
      const limit = Math.min(Math.max(rawLimit, 1), BOARD_LIMIT_MAX)

      const needle =
        typeof args.workspace === 'string' && args.workspace.trim() !== ''
          ? args.workspace.trim().toLowerCase()
          : undefined

      const { bySession, warnings } = await readLastPromptTimes(ctx, exec)
      const now = Date.now()

      const all = listDispatches().map((record) => {
        const rowWarnings = []
        const status = boardStatus(record)
        const startedMs = timeOf(record.startedAt)
        const reportedMs = timeOf(record.reportedAt)

        // The interval closes at the terminal timestamp when there is one, else now.
        const closedByReport = status !== 'running' && reportedMs !== undefined
        const rawElapsed = startedMs === undefined ? 0 : (closedByReport ? reportedMs : now) - startedMs
        if (startedMs === undefined) {
          rowWarnings.push('`startedAt` is missing or unparseable; elapsed and lastActivityAt are unknown')
        } else if (rawElapsed < 0) {
          // Dirty data: a report timestamp earlier than the dispatch start. A
          // negative duration is never meaningful, so it is clamped, not shown.
          rowWarnings.push('`reportedAt` precedes `startedAt`; elapsed clamped to 0')
        }
        const elapsedMs = Number.isFinite(rawElapsed) ? Math.max(0, Math.round(rawElapsed)) : 0

        const lastActivityAt = closedByReport
          ? record.reportedAt
          : (record.startedAt ?? record.reportedAt)
        const lastActivitySource =
          status === 'reported' || status === 'abandoned'
            ? (reportedMs === undefined ? 'started' : status === 'reported' ? 'reported' : 'abandoned')
            : 'started'

        // A recovered record is not a normal dispatch: it carries no task brief,
        // and a `session-log` recovery proves no main session at all. Both are
        // stated on the row instead of being flattened into a plain "running".
        if (record.recoveredFrom !== undefined) {
          rowWarnings.push(
            record.recoveredFrom === 'session-log'
              ? "rebuilt from this Session's own log after a restart — no checkpoint existed"
              : 'rebuilt from the checkpoint written before a restart',
          )
        }
        // `orphaned` is derived, not stored: the worker half decides "nobody to
        // push to" from a missing main session id, and the board must use the
        // same rule rather than trusting a flag only one path sets.
        const orphaned = record.mainSessionId === undefined || record.orphaned === true
        if (orphaned) {
          rowWarnings.push('no main session is recorded; a report from this worker will not be pushed')
        }

        const lastPromptAt = bySession.get(String(record.workerSessionId))

        return {
          dispatchId: String(record.dispatchId ?? ''),
          workerSessionId: String(record.workerSessionId ?? ''),
          status,
          elapsed: { ms: elapsedMs, human: humanDuration(elapsedMs), until: closedByReport ? status : 'now' },
          lastActivityAt: String(lastActivityAt ?? ''),
          lastActivitySource,
          ...(lastPromptAt === undefined ? {} : { lastPromptAt }),
          ...(record.recoveredFrom === undefined ? {} : { recoveredFrom: String(record.recoveredFrom) }),
          ...(orphaned ? { orphaned: true } : {}),
          ...(record.workspaceId === undefined ? {} : { workspaceId: String(record.workspaceId) }),
          ...(record.workspaceTitle === undefined ? {} : { workspaceTitle: String(record.workspaceTitle) }),
          ...(record.task === undefined ? {} : { taskExcerpt: excerpt(record.task) }),
          ...(record.startedAt === undefined ? {} : { startedAt: String(record.startedAt) }),
          ...(record.reportedAt === undefined ? {} : { reportedAt: String(record.reportedAt) }),
          ...(record.reportId === undefined ? {} : { reportId: String(record.reportId) }),
          ...(rowWarnings.length === 0 ? {} : { warnings: rowWarnings }),
        }
      })

      const filtered =
        needle === undefined
          ? all
          : all.filter(
              (row) =>
                String(row.workspaceId ?? '').toLowerCase().includes(needle) ||
                String(row.workspaceTitle ?? '').toLowerCase().includes(needle),
            )

      // Newest dispatch first: a board is read from "what just went out" down.
      // Undated rows sort last and keep insertion order. Compared explicitly
      // instead of subtracting, because two undated rows would subtract to
      // `-Infinity - -Infinity = NaN` and only sort stably by accident.
      const ordered = filtered
        .map((row, index) => ({ row, index, at: timeOf(row.startedAt) }))
        .sort((left, right) => {
          if (left.at === undefined || right.at === undefined) {
            if (left.at !== right.at) return left.at === undefined ? 1 : -1
            return left.index - right.index
          }
          return right.at - left.at || left.index - right.index
        })
        .slice(0, limit)
        .map((entry) => entry.row)

      const counts = { total: all.length, running: 0, reported: 0, abandoned: 0 }
      for (const row of all) counts[row.status] += 1

      const visible = { total: ordered.length, running: 0, reported: 0, abandoned: 0 }
      for (const row of ordered) visible[row.status] += 1

      return {
        dispatches: ordered,
        counts,
        note:
          (all.length === 0
            ? 'no dispatch has been recorded in this process yet'
            : `${visible.total} of ${counts.total} dispatch(es) shown; ` +
              `${counts.running} running, ${counts.reported} reported, ${counts.abandoned} abandoned`) +
          '. `lastActivityAt` is the last registry-visible transition (report, abandonment, or start), NOT the last message time; ' +
          '`lastPromptAt`, when present, is the latest user-authored prompt and does not track worker progress.',
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * interrupted dispatches
 * ------------------------------------------------------------------ */

/** The brief a resumed worker receives. */
export const RESUME_BRIEF = [
  '[Resume] A DeepSeek Harness restart interrupted the task you were dispatched in this session.',
  'Re-read this session to recover the task and what you already finished, then continue from where you stopped.',
  'When the work is done, call `report_to_main` exactly as the original brief asked.',
].join('\n')

const workerSessionParameter = {
  type: 'string',
  description: 'Worker session id of the interrupted dispatch, as listed in the startup check.',
}

const interruptedOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['dispatchId', 'workerSessionId', 'status'],
    properties: {
      dispatchId: { type: 'string' },
      workerSessionId: { type: 'string' },
      status: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

async function interruptedCheckpoint(args) {
  if (typeof args.worker_session_id !== 'string' || args.worker_session_id === '') {
    throw new Error('`worker_session_id` is required')
  }
  const checkpoint = await readDispatchCheckpoint(storeRoot(), args.worker_session_id)
  if (checkpoint === undefined) {
    throw new Error(`no interrupted dispatch for worker ${args.worker_session_id}; it may have reported or been abandoned already`)
  }
  return checkpoint
}

function resumeDispatchTool(ctx) {
  return {
    name: 'resume_dispatch',
    description:
      'Resume a dispatch that a DeepSeek Harness restart interrupted: wake its worker session so it continues the task and reports back here. Call it only for dispatches the user chose to resume.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['worker_session_id'],
      properties: {
        worker_session_id: workerSessionParameter,
        note: { type: 'string', description: 'Optional extra instruction for the worker, such as a changed decision.' },
      },
    },
    output: interruptedOutput,
    presentCall: (args) => ({ card: 'generic', title: 'Resume dispatch', kind: 'other', rawInput: args.worker_session_id }),
    async execute(args, exec) {
      const checkpoint = await interruptedCheckpoint(args)
      const mainSessionId = exec?.agent?.session?.id ?? checkpoint.mainSessionId
      const dispatch = recordDispatch({
        dispatchId: checkpoint.dispatchId,
        mainSessionId,
        workerSessionId: checkpoint.workerSessionId,
        workspaceId: checkpoint.workspaceId,
        workspaceTitle: checkpoint.workspaceTitle,
        task: '(resumed after a restart)',
        startedAt: checkpoint.startedAt,
      })
      // Route the report to the session resuming it, in case the main session changed.
      await writeDispatchCheckpoint(storeRoot(), checkpoint.workerSessionId, dispatch)
      const note = typeof args.note === 'string' ? args.note.trim() : ''
      const brief = note === '' ? RESUME_BRIEF : `${RESUME_BRIEF}\n\nNote from the main session: ${note}`
      await ctx.sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId: checkpoint.workerSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: brief }],
        },
        signalOf(exec),
      )
      return { dispatchId: checkpoint.dispatchId, workerSessionId: checkpoint.workerSessionId, status: 'resumed' }
    },
  }
}

function abandonDispatchTool() {
  return {
    name: 'abandon_dispatch',
    description:
      'Abandon a dispatch that a DeepSeek Harness restart interrupted: forget it so it is no longer reported as interrupted, and stop asking its worker for a report. The worker session itself is left as it is. Call it only for dispatches the user chose to abandon.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['worker_session_id'],
      properties: { worker_session_id: workerSessionParameter },
    },
    output: interruptedOutput,
    presentCall: (args) => ({ card: 'generic', title: 'Abandon dispatch', kind: 'other', rawInput: args.worker_session_id }),
    async execute(args) {
      const checkpoint = await interruptedCheckpoint(args)
      // The marker reaches the worker preset's own registry; the checkpoint goes.
      await markDispatchAbandoned(storeRoot(), checkpoint.workerSessionId, checkpoint.dispatchId)
      await dropDispatchCheckpoint(storeRoot(), checkpoint.workerSessionId)
      const record = dispatchForWorker(checkpoint.workerSessionId)
      if (record !== undefined) {
        record.status = 'abandoned'
        record.reportedAt = new Date().toISOString()
      }
      return { dispatchId: checkpoint.dispatchId, workerSessionId: checkpoint.workerSessionId, status: 'abandoned' }
    },
  }
}

/* ------------------------------------------------------------------ *
 * activation
 * ------------------------------------------------------------------ */

/**
 * Row config as a Standard Schema.
 *
 * The Loader validates a row's `config` through `Config['~standard'].validate`,
 * so a plain object is not enough. This package has no dependencies (it installs
 * as a link to its own directory, where profile packages do not resolve), so the
 * schema is written out by hand instead of importing a schema library.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'discipline-whale',
    validate(value) {
      const input = value ?? {}
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      const workerPreset = input.workerPreset ?? 'discipline-whale-worker'
      if (typeof workerPreset !== 'string' || workerPreset === '') {
        return { issues: [{ message: 'workerPreset must be a non-empty string', path: ['workerPreset'] }] }
      }
      // The guard knobs are validated where they are used (`resolveGuardConfig`
      // falls back on any invalid value), so this schema only has to carry them
      // through instead of dropping them: a row config that silently discarded
      // `readQuota` would look wired and do nothing.
      const guard = {}
      for (const key of ['watchdogThreshold', 'readQuota', 'maxInterventions', 'watchdogCounting']) {
        if (input[key] !== undefined) guard[key] = input[key]
      }
      // The brevity knobs (adhd.js) follow the same rule: carried through, then
      // validated where they are used. `0` and `false` are real values, so the
      // test is `!== undefined`, never truthiness.
      const brevity = {}
      for (const key of ['maxProseChars', 'maxCorrections', 'enabled']) {
        if (input[key] !== undefined) brevity[key] = input[key]
      }
      return { value: { workerPreset, ...guard, ...brevity } }
    },
  },
}

export function apply(ctx, config = {}) {
  const resolved = {
    workerPreset:
      typeof config.workerPreset === 'string' && config.workerPreset !== ''
        ? config.workerPreset
        : 'discipline-whale-worker',
  }

  ctx.effect(() => ctx.tools.register(listWorkspacesTool(ctx)))
  ctx.effect(() => ctx.tools.register(dispatchTaskTool(ctx, resolved)))
  ctx.effect(() => ctx.tools.register(readReportTool(ctx)))
  ctx.effect(() => ctx.tools.register(sendToSessionTool(ctx)))
  ctx.effect(() => ctx.tools.register(listDispatchesTool(ctx)))
  ctx.effect(() => ctx.tools.register(resumeDispatchTool(ctx)))
  ctx.effect(() => ctx.tools.register(abandonDispatchTool()))

  // The three main-session brakes live in guard.js: the silent-tool-call
  // watchdog, the per-reply read quota, and the read-path whitelist. Their whole
  // surface is read by `resolveGuardConfig`; installing them is one call so this
  // row stays a tool registry and nothing else.
  installGuard(ctx, resolveGuardConfig(config))

  // The output discipline lives in adhd.js: the ADHD ruleset as prompt text, a
  // next-step correction for over-long prose, and a UI-deliverable exemption.
  // Separate module, separate listeners: the guard counts *reads*, this counts
  // *characters*, and neither may gate the other.
  installBrevity(ctx, config)
}
