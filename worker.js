/**
 * discipline-whale — worker half.
 *
 * Mounted only inside the worker preset. Registers `report_to_main` plus the
 * turn-end enforcement that makes the report contract real.
 *
 * The worker does NOT get list_workspaces, dispatch_task, read_report, or
 * send_to_session. Sub-agents inherit this preset, so the "no Discipline Whale
 * powers below the main session" rule holds structurally rather than by
 * instruction.
 *
 * @module discipline-whale/worker
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import {
  clearRetries,
  dispatchForWorker,
  noteRetry,
  retriesFor,
} from './registry.js'
import { MAX_DOCUMENT_CHARS, boundSummary, storeRoot, writeReport } from './store.js'

/**
 * A usable AbortSignal for a Host call.
 *
 * `sessionController.prompt(request, signal)` dereferences its signal
 * unconditionally, so every call site must supply one.
 */
function signalOf(exec) {
  return exec?.signal ?? new AbortController().signal
}

export const name = 'discipline-whale-worker'

/** The Host services this row needs. */
export const inject = ['tools', 'sessionController']

const DEFAULT_MAX_REPORT_RETRIES = 3

const NOTICE_SOURCE = Object.freeze({
  kind: 'plugin:discipline-whale',
  form: 'notice',
  summary: 'Discipline Whale report enforcement',
})

function reportToMainTool(ctx, config) {
  return {
    name: 'report_to_main',
    description:
      'Report your result to the main session that dispatched this task. Call this exactly once before finishing. The summary is pushed to the main session immediately, which wakes it; the document is stored and read only if someone needs the detail.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description:
            'One short paragraph: what you did, whether it worked, and anything the main session must know. Delivered as a message, not read from a file.',
        },
        document: {
          type: 'string',
          description:
            'The full write-up: changes made, verification performed, remaining risks. Stored on disk; the main session opens it only when needed.',
        },
        status: {
          type: 'string',
          enum: ['done', 'partial', 'blocked'],
          description: 'Outcome classification. Defaults to done.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['reportId', 'deliveredToMain'],
        properties: {
          reportId: { type: 'string' },
          deliveredToMain: { type: 'boolean' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Report to main', kind: 'other' }),
    async execute(args, exec) {
      const summary = String(args.summary ?? '').trim()
      if (summary === '') throw new Error('`summary` is empty; the main session needs at least one line')
      const document = args.document === undefined ? '' : String(args.document)
      if (document.length > MAX_DOCUMENT_CHARS) {
        throw new Error(`\`document\` is longer than ${MAX_DOCUMENT_CHARS} characters`)
      }
      const outcome = args.status ?? 'done'
      if (!['done', 'partial', 'blocked'].includes(outcome)) {
        throw new Error('`status` must be done, partial, or blocked')
      }

      const workerSessionId = exec.agent?.session?.id
      const dispatch = workerSessionId === undefined ? undefined : dispatchForWorker(workerSessionId)
      if (dispatch === undefined) {
        throw new Error(
          'this Session has no active dispatch, so there is no main session to report to. ' +
            'Either it was not started by dispatch_task, or it is running a different agent preset than the ' +
            'dispatching main session (each preset loads its own plugin instance, so the dispatch registry is ' +
            "not shared across presets). Check that dispatch_task's workerPreset names this Session's preset.",
        )
      }

      const report = {
        id: `r-${randomUUID()}`,
        dispatchId: dispatch.dispatchId,
        workspaceId: dispatch.workspaceId,
        workspaceTitle: dispatch.workspaceTitle,
        workerSessionId,
        mainSessionId: dispatch.mainSessionId,
        status: 'reported',
        outcome,
        summary: boundSummary(summary),
        document,
        reportedAt: new Date().toISOString(),
        deliveredTo: [],
        host: hostname(),
      }
      await writeReport(storeRoot(), report)

      // Mark the dispatch before pushing: enforcement reads this flag, and a
      // failed push must not cause the worker to be steered again.
      dispatch.reportedAt = report.reportedAt
      dispatch.status = 'reported'
      dispatch.reportId = report.id
      clearRetries(dispatch.dispatchId)

      const warnings = []
      let delivered = false
      if (dispatch.mainSessionId === undefined) {
        warnings.push('the dispatch recorded no main session id; the report was stored but not pushed')
      } else {
        try {
          await ctx.sessionController.prompt(
            {
              requestId: randomUUID(),
              sessionId: dispatch.mainSessionId,
              mode: 'queue',
              content: [
                {
                  type: 'text',
                  text: [
                    `[Discipline Whale] Worker report — ${dispatch.workspaceTitle} (${outcome})`,
                    '',
                    report.summary,
                    '',
                    `report id: ${report.id}`,
                    'Call read_report with that id for the full document.',
                  ].join('\n'),
                },
              ],
            },
            signalOf(exec),
          )
          report.deliveredTo = [dispatch.mainSessionId]
          report.status = 'delivered'
          await writeReport(storeRoot(), report)
          delivered = true
        } catch (error) {
          warnings.push(`report stored but the push to the main session failed: ${String(error?.message ?? error)}`)
        }
      }

      return {
        reportId: report.id,
        deliveredToMain: delivered,
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
  }
}

/**
 * Keep a worker honest: a dispatched session may not close a turn silently.
 *
 * On each closed turn without a report the worker is steered back. Once the
 * retry budget is spent, the main session is told instead — a human-visible
 * escalation beats an infinite loop or a silent no-op.
 */
export function registerEnforcement(ctx, config) {
  if (typeof ctx.on !== 'function') return

  ctx.on('agent/turn-stopping', ({ agent }) => {
    const sessionId = agent.session?.id
    if (sessionId === undefined) return
    const dispatch = dispatchForWorker(sessionId)
    if (dispatch === undefined) return
    if (dispatch.reportedAt !== undefined) return

    const attempts = retriesFor(dispatch.dispatchId) + 1
    if (attempts > config.maxReportRetries) {
      clearRetries(dispatch.dispatchId)
      dispatch.reportedAt = new Date().toISOString()
      dispatch.status = 'abandoned'
      if (dispatch.mainSessionId === undefined) return
      const text = [
        `[Discipline Whale] Worker failed to report — ${dispatch.workspaceTitle}`,
        '',
        `Worker session ${sessionId} closed ${attempts - 1} turn(s) without calling report_to_main.`,
        'The task may be incomplete. Open that session to inspect what actually happened,',
        'or re-dispatch with a clearer brief.',
      ].join('\n')
      // Fire and forget: a failed escalation must never break this worker's turn.
      ctx.sessionController
        .prompt(
          {
            requestId: randomUUID(),
            sessionId: dispatch.mainSessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
        .catch((error) => {
          ctx.logger?.warn?.(`discipline-whale: escalation push failed: ${error?.message ?? error}`)
        })
      return
    }

    noteRetry(dispatch.dispatchId)
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `You are about to end your turn without reporting (attempt ${attempts} of ${config.maxReportRetries}).`,
              'Call `report_to_main` now: one short `summary` for the main session, plus the detailed',
              '`document` if you have results to record. If the task cannot proceed, report that',
              'honestly with `status: "blocked"` instead of stopping silently.',
            ].join('\n'),
          },
        ],
        source: NOTICE_SOURCE,
      })
    } catch (error) {
      ctx.logger?.warn?.(`discipline-whale: could not steer worker ${sessionId}: ${error?.message ?? error}`)
    }
  })
}

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
      const raw = input.maxReportRetries ?? DEFAULT_MAX_REPORT_RETRIES
      if (!Number.isInteger(raw) || raw < 0) {
        return { issues: [{ message: 'maxReportRetries must be a non-negative integer', path: ['maxReportRetries'] }] }
      }
      return { value: { maxReportRetries: raw } }
    },
  },
}

export function apply(ctx, config = {}) {
  const resolved = {
    maxReportRetries:
      Number.isInteger(config.maxReportRetries) && config.maxReportRetries >= 0
        ? config.maxReportRetries
        : DEFAULT_MAX_REPORT_RETRIES,
  }

  ctx.effect(() => ctx.tools.register(reportToMainTool(ctx, resolved)))
  registerEnforcement(ctx, resolved)
}
