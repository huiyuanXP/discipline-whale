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
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'

import {
  dropDispatchCheckpoint,
  dispatchCheckpointPath,
  isDispatchAbandoned,
  writeDispatchCheckpoint,
} from './checkpoint.js'
import {
  clearRetries,
  dispatchForWorker,
  noteRetry,
  recordDispatch,
  retriesFor,
} from './registry.js'
import {
  MAX_DOCUMENT_CHARS,
  boundSummary,
  storeRoot,
  writeReport,
} from './store.js'

/* ------------------------------------------------------------------ *
 * dispatch checkpoints: surviving a Host restart
 * ------------------------------------------------------------------ */

/**
 * Re-export the checkpoint path so callers that reason about the worker side
 * (`dispatchCheckpointPath`) keep one name for it. The definition lives in
 * `checkpoint.js` because the main half writes the very same file.
 */
export { dispatchCheckpointPath }

/**
 * Markers every `dispatch_task` brief carries.
 *
 * They are what separates "a dispatch record was lost in a restart" from "this
 * Session was never dispatched": the brief is written into the worker's own
 * Session log by `main.js`, so it survives exactly as long as the Session does.
 */
const BRIEF_MARKERS = Object.freeze(['You are a Discipline Whale worker', 'report_to_main'])

/** Checkpoint writes already issued in this process, so a turn loop writes once. */
const checkpointed = new Set()

/**
 * Write once per (worker session, dispatch) pair; a lost write may retry.
 *
 * A dispatch that already reached a terminal state is never re-checkpointed.
 * `report_to_main` drops the file when the report is delivered, and the Session
 * is still alive afterwards: without this guard the next `agent/status` would
 * re-create the checkpoint for a finished dispatch, the following restart would
 * recover it, and a second report would be pushed for work that was already
 * reported. The guard is on the record, not only on the in-process set, so a
 * recovered-then-delivered dispatch is covered too.
 */
function checkpointOnce(ctx, workerSessionId, dispatch) {
  if (dispatch?.dispatchId === undefined) return Promise.resolve(undefined)
  if (dispatch.status === 'reported' || dispatch.status === 'abandoned') return Promise.resolve(undefined)
  if (isDispatchAbandoned(storeRoot(), workerSessionId)) return Promise.resolve(undefined)
  const key = `${workerSessionId}\u0000${dispatch.dispatchId}`
  if (checkpointed.has(key)) return Promise.resolve(undefined)
  checkpointed.add(key)
  return writeDispatchCheckpoint(storeRoot(), workerSessionId, dispatch).catch((error) => {
    checkpointed.delete(key)
    ctx.logger?.warn?.(`discipline-whale: could not checkpoint dispatch ${dispatch.dispatchId}: ${error?.message ?? error}`)
    return undefined
  })
}

/**
 * Drop a checkpoint.
 *
 * Called when a report is delivered. `force: true` makes a second drop — the
 * main half can also decide a dispatch is finished — a no-op rather than an
 * error.
 *
 * NOT called on abandonment: see the reasoning at that site.
 */
function dropCheckpoint(workerSessionId, dispatchId) {
  if (dispatchId !== undefined) checkpointed.delete(`${workerSessionId}\u0000${dispatchId}`)
  return dropDispatchCheckpoint(storeRoot(), workerSessionId)
}

/**
 * Rebuild one dispatch from its checkpoint, or `undefined` when there is none.
 *
 * The rebuilt record is re-registered, so every later lookup in this process —
 * reporting, enforcement, the main row's board — sees the same record it would
 * have seen before the restart.
 */
async function recoverDispatch(workerSessionId) {
  let stored
  try {
    stored = JSON.parse(await readFile(dispatchCheckpointPath(storeRoot(), workerSessionId), 'utf8'))
  } catch {
    // Missing (never checkpointed, or already delivered) and unreadable both
    // mean "nothing to recover"; neither may turn into a guessed dispatch.
    return undefined
  }
  if (stored?.workerSessionId !== workerSessionId) return undefined
  if (typeof stored.dispatchId !== 'string' || stored.dispatchId === '') return undefined
  return recordDispatch({
    dispatchId: stored.dispatchId,
    mainSessionId: stored.mainSessionId,
    workerSessionId,
    workspaceId: stored.workspaceId,
    workspaceTitle: stored.workspaceTitle,
    startedAt: stored.startedAt,
    recoveredFrom: 'checkpoint',
  })
}

/* ------------------------------------------------------------------ *
 * session self-evidence, for the case where even the checkpoint is gone
 * ------------------------------------------------------------------ */

/** Flatten one `user/message` payload to text. */
function textOfMessage(data) {
  const content = data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * What this Session can prove about itself, without any dispatch record.
 *
 * `inspect` reads the durable log without resuming an Agent; a live Session is
 * the fallback. Both are optional, so an undispatched Session in a bare test
 * mount simply yields no evidence.
 */
async function sessionEvidence(ctx, exec, sessionId) {
  const signal = signalOf(exec)
  let events
  let cwd
  try {
    const inspected = await ctx.sessionController?.inspect?.(sessionId, signal)
    if (Array.isArray(inspected?.events)) events = inspected.events
    cwd = inspected?.meta?.cwd
  } catch {
    // A Host that cannot inspect this Session proves nothing by itself.
  }
  if (events === undefined) {
    try {
      const session = exec?.agent?.session
      events = session?.snapshotEvents?.() ?? []
      cwd = session?.header?.cwd ?? cwd
    } catch {
      events = []
    }
  }
  const dispatched = events.some(
    (event) =>
      event?.type === 'user/message' && BRIEF_MARKERS.every((marker) => textOfMessage(event.data).includes(marker)),
  )
  return { dispatched, cwd: typeof cwd === 'string' ? cwd : undefined }
}

/** The workspace whose path is this Session's cwd, when one is registered. */
function workspaceForCwd(ctx, cwd) {
  if (cwd === undefined) return undefined
  const trim = (value) => String(value).replace(/\/+$/, '')
  let registry
  try {
    registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  } catch {
    registry = undefined
  }
  if (registry === undefined) {
    try {
      registry = ctx.workspaceRegistry
    } catch {
      registry = undefined
    }
  }
  const all = registry?.list?.() ?? []
  return all.find((workspace) => typeof workspace?.path === 'string' && trim(workspace.path) === trim(cwd))
}

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
      'Report your result to the main session that dispatched this task. Call this exactly once before finishing. The summary is pushed to the main session immediately, which wakes it; the document is stored and read only if someone needs the detail. If the Host restarted and the dispatch record is gone, the report is still written to the store and the result says deliveredToMain: false with orphaned: true, plus a warning telling the main session to fetch it with read_report.',
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
          orphaned: { type: 'boolean' },
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
      if (workerSessionId === undefined) {
        throw new Error('this Session has no id, so there is no dispatch it could belong to')
      }

      const warnings = []

      // 1. the live record. 2. the worker's own checkpoint, which is what a
      // restart leaves behind: the registry Map is gone, the Session is not.
      let dispatch = dispatchForWorker(workerSessionId)
      if (dispatch === undefined) {
        dispatch = await recoverDispatch(workerSessionId)
        if (dispatch !== undefined) {
          warnings.push(
            'this Session has no live dispatch record — the Harness most likely restarted, which empties the ' +
              'process-local dispatch registry while keeping worker Sessions durable. The dispatch was rebuilt ' +
              'from the checkpoint written by the worker before the restart; the report below is delivered ' +
              'from those recorded routing facts.',
          )
        }
      }

      // 3. nothing on disk: refuse, unless the Session itself proves dispatch.
      if (dispatch === undefined) {
        const evidence = await sessionEvidence(ctx, exec, workerSessionId)
        if (!evidence.dispatched) {
          throw new Error(
            'this Session has no active dispatch, so there is no main session to report to. ' +
              'Either it was not started by dispatch_task, or it is running a different agent preset than the ' +
              'dispatching main session (each preset loads its own plugin instance, so the dispatch registry is ' +
              "not shared across presets). Check that dispatch_task's workerPreset names this Session's preset.",
          )
        }
        const workspace = workspaceForCwd(ctx, evidence.cwd)
        if (workspace === undefined) {
          throw new Error(
            'this Session was dispatched, but every record of where to send the report is gone: the Harness ' +
              'restarted before the dispatch was checkpointed, and no registered workspace matches its working ' +
              `directory (${evidence.cwd ?? 'unknown'}). The task may still be finished — report status honestly ` +
              'to the user in this Session, because nothing can route it upward.',
          )
        }
        dispatch = {
          dispatchId: `dispatch-lost-${workerSessionId}`,
          mainSessionId: undefined,
          workerSessionId,
          workspaceId: String(workspace.id),
          workspaceTitle: workspace.title,
          recoveredFrom: 'session-log',
        }
        warnings.push(
          'the dispatch record for this Session was lost in a Harness restart and no checkpoint was written. ' +
            'The workspace was recovered from this Session\'s own working directory, but the Session that ' +
            'dispatched it is unknown, so nothing is pushed.',
          'the report is stored on disk, marked orphaned. Ask the main session to call read_report with the ' +
            'report id above to retrieve it.',
        )
      }
      const orphaned = dispatch.mainSessionId === undefined

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
        ...(orphaned ? { orphaned: true } : {}),
        ...(dispatch.recoveredFrom === undefined ? {} : { recoveredFrom: dispatch.recoveredFrom }),
      }
      await writeReport(storeRoot(), report)

      // Mark the dispatch before pushing: enforcement reads this flag, and a
      // failed push must not cause the worker to be steered again.
      dispatch.reportedAt = report.reportedAt
      dispatch.status = 'reported'
      dispatch.reportId = report.id
      clearRetries(dispatch.dispatchId)

      let delivered = false
      if (dispatch.mainSessionId === undefined) {
        if (!orphaned) {
          warnings.push('the dispatch recorded no main session id; the report was stored but not pushed')
        }
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

      if (delivered) await dropCheckpoint(workerSessionId, dispatch.dispatchId)

      return {
        reportId: report.id,
        deliveredToMain: delivered,
        ...(orphaned ? { orphaned: true } : {}),
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
  }
}

/** Steer text for one allowed turn; `why` names what ended the previous turn. */
function steerNotice(attempts, maxAttempts, why) {
  return [
    `You are about to end your turn without reporting (attempt ${attempts} of ${maxAttempts}).`,
    ...(why === undefined ? [] : [why, '']),
    'Call `report_to_main` now: one short `summary` for the main session, plus the detailed',
    '`document` if you have results to record. If the task cannot proceed, report that',
    'honestly with `status: "blocked"` instead of stopping silently.',
  ].join('\n')
}

/** Why one `turn/end` needs a recovery nudge, or `undefined` for a normal close. */
function interruptedWhy(reason) {
  if (reason?.kind === 'error') {
    const code = reason.error?.code
    const message = reason.error?.message
    return [
      'The previous turn ended with an error instead of a normal close, so the usual turn-end',
      'check never ran.',
      ...(code === undefined && message === undefined
        ? []
        : [`Recorded failure: ${[code, message].filter((part) => part !== undefined).join(' — ')}`]),
      'If that error was a transport or network failure, the work may still be finished now',
      'that the Host is back. This nudge is the recovery step, not a request to report while',
      'the network is down.',
    ].join('\n')
  }
  if (reason?.kind === 'blocked') {
    return [
      'The previous turn was blocked before it could run a step, so the usual turn-end check',
      'never ran. If the task is actually finished, report it now; otherwise report what',
      'blocked it with `status: "blocked"`.',
    ].join('\n')
  }
  if (reason?.kind === 'aborted') {
    return [
      'The previous turn was aborted instead of closing normally, so the usual turn-end check',
      'never ran. If the work is actually finished, report it now.',
    ].join('\n')
  }
  if (reason?.kind === 'interrupted') {
    return [
      'The previous turn was closed after the fact because the Host restarted mid-turn. Any work',
      'recorded before the restart is still yours; if it is complete, report it now.',
    ].join('\n')
  }
  return undefined
}

/**
 * Keep a worker honest: a dispatched session may not close a turn silently.
 *
 * On each closed turn without a report the worker is steered back. Once the
 * retry budget is spent, the main session is told instead — a human-visible
 * escalation beats an infinite loop or a silent no-op.
 *
 * `agent/turn-stopping` alone is not enough. `agent-loop` dispatches it from
 * inside the step loop (`turnEnds && inbox.nextStep.length === 0`,
 * lib/index.js:1000), while an `error` turn (e.g. TRANSPORT) or an `aborted`
 * one leaves through the catch at ~1010 and never reaches it. Those are exactly
 * the turns a network outage produces, so the abnormal exits are tracked
 * separately and answered when the driver next goes idle.
 *
 * Nothing here tries to push while the network is down: a report cannot cross a
 * dead transport. The point is that the turn is remembered, so once the Host is
 * back the worker is asked to report instead of losing the result.
 */
export function registerEnforcement(ctx, config) {
  if (typeof ctx.on !== 'function') return

  /** One enforcement decision for one Session. */
  const enforce = (agent, why) => {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    const dispatch = dispatchForWorker(sessionId)
    if (dispatch === undefined) return
    if (dispatch.reportedAt !== undefined) return
    // The user abandoned this dispatch from the main session: stop asking.
    if (isDispatchAbandoned(storeRoot(), sessionId)) {
      clearRetries(dispatch.dispatchId)
      dispatch.reportedAt = new Date().toISOString()
      dispatch.status = 'abandoned'
      return
    }

    const attempts = retriesFor(dispatch.dispatchId) + 1
    if (attempts > config.maxReportRetries) {
      clearRetries(dispatch.dispatchId)
      dispatch.reportedAt = new Date().toISOString()
      dispatch.status = 'abandoned'
      // The checkpoint is deliberately NOT dropped here.
      //
      // "Abandoned" means the main session was told this worker did not report
      // — it does not mean the worker will never report. A long task can take
      // more silent turns than the retry budget and then finish; that late
      // report is exactly the result this whole checkpoint exists to preserve.
      // Dropping the file would turn it into an orphan that nobody is told
      // about. The invariant is therefore "a checkpoint exists while no report
      // has been *delivered*", which is also why the push-failure path in
      // `report_to_main` keeps it. Delivery removes the file; nothing else does.
      if (dispatch.mainSessionId !== undefined) {
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
      }
      return
    }

    noteRetry(dispatch.dispatchId)
    try {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: steerNotice(attempts, config.maxReportRetries, why) }],
        source: NOTICE_SOURCE,
      })
    } catch (error) {
      ctx.logger?.warn?.(`discipline-whale: could not steer worker ${sessionId}: ${error?.message ?? error}`)
    }
  }

  /**
   * Keep the record alive across the next restart.
   *
   * When memory has no record — the process was restarted — the checkpoint is
   * read back and re-registered, so enforcement sees the dispatch the live
   * process would have seen instead of going quiet forever.
   *
   * Returns `undefined` when the record is already in memory, which is the
   * ordinary case and stays fully synchronous; otherwise it returns the
   * recovery so an awaited caller can enforce on the right side of it.
   */
  const remember = (agent) => {
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return undefined
    const live = dispatchForWorker(sessionId)
    if (live !== undefined) {
      void checkpointOnce(ctx, sessionId, live)
      return undefined
    }
    return recoverDispatch(sessionId)
      .then((recovered) => {
        if (recovered === undefined) return undefined
        // The recovered record already reached disk; no second write is owed.
        checkpointed.add(`${sessionId}\u0000${recovered.dispatchId}`)
        return recovered
      })
      .catch((error) => {
        ctx.logger?.warn?.(`discipline-whale: could not recover dispatch for ${sessionId}: ${error?.message ?? error}`)
        return undefined
      })
  }

  /**
   * Sessions whose last turn ended abnormally and still owe an enforcement
   * pass. `agent/turn-stopping` clears the entry for a normal close, so a turn
   * can never be counted twice no matter which exit it took.
   */
  const abnormal = new Map()

  // `serial` dispatch awaits this handler, so an in-memory dispatch is handled
  // synchronously exactly as before, while a restarted one enforces only after
  // its checkpoint has been read back.
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (sessionId !== undefined) abnormal.delete(sessionId)
    const recovery = remember(agent)
    if (recovery === undefined) {
      enforce(agent)
      return undefined
    }
    return recovery.then(() => enforce(agent))
  })

  // A failed turn reports its failure here — the only live signal an `error`
  // turn produces. Nothing is pushed: a dead network cannot accept it.
  ctx.on('agent/error', ({ agent, error }) => {
    remember(agent)
    const sessionId = agent?.session?.id
    if (sessionId === undefined || abnormal.has(sessionId)) return
    if (dispatchForWorker(sessionId) === undefined) return
    abnormal.set(
      sessionId,
      interruptedWhy({
        kind: 'error',
        error: { code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? error) },
      }),
    )
  })

  // An aborted or crash-closed turn never reaches `agent/error` either; its
  // reason exists only in the log, so record it as it lands.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    if (sessionId === undefined || abnormal.has(sessionId)) return
    // Only a dispatched Session is worth remembering; an unbounded map keyed by
    // every Session in the process would outlive its usefulness.
    if (dispatchForWorker(sessionId) === undefined) return
    const why = interruptedWhy(event.data?.reason)
    if (why !== undefined) abnormal.set(sessionId, why)
  })

  // `idle` means the driver drained, whatever ended the turn, so it is the one
  // signal common to every exit path.
  ctx.on('agent/status', ({ agent, status }) => {
    remember(agent)
    if (status !== 'idle') return
    const sessionId = agent?.session?.id
    if (sessionId === undefined) return
    const why = abnormal.get(sessionId)
    if (why === undefined) return
    abnormal.delete(sessionId)
    enforce(agent, why)
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
