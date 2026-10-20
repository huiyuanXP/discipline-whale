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

import { recordDispatch } from './registry.js'
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
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['dispatchId', 'workerSessionId', 'workspaceId', 'workspaceTitle', 'status'],
        properties: {
          dispatchId: { type: 'string' },
          workerSessionId: { type: 'string' },
          workspaceId: { type: 'string' },
          workspaceTitle: { type: 'string' },
          status: {
            type: 'string',
            enum: ['dispatched', 'dispatch-prompt-failed'],
          },
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

      const workspace = await resolveWorkspace(ctx.workspaceRegistry, args.workspace)
      const warnings = []

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
      recordDispatch({
        dispatchId,
        mainSessionId,
        workerSessionId,
        workspaceId: String(workspace.id),
        workspaceTitle: workspace.title,
        task,
        startedAt: new Date().toISOString(),
      })

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

function sendToSessionTool(ctx) {
  return {
    name: 'send_to_session',
    description:
      'Send a new instruction to an existing Session and wake it. Use it to hand a running worker a changed decision, or to reopen finished work with a follow-up. The message is durable and queued like a user turn.',
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
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'accepted'],
        properties: {
          sessionId: { type: 'string' },
          accepted: { type: 'boolean' },
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
      // `signal` is a required parameter of session/prompt: the controller calls
      // signal.throwIfAborted() before admitting anything.
      await ctx.sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: message }],
        },
        signalOf(exec),
      )
      return { sessionId, accepted: true }
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
      return { value: { workerPreset } }
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
}
