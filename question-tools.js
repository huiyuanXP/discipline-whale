/**
 * discipline-whale — the main session's side of the question queue.
 *
 * `questions.js` owns the files. This module owns the one tool the main session
 * calls, and the two rules that make plan A safe:
 *
 *   1. IT NEVER ASKS. `pending_questions` hands back an `ask_user_question`
 *      request; the main session — a live runtime root — is what calls the
 *      asking tool. A child agent that called `ask()` itself would be refused
 *      with `DELEGATED_CALLER` before any answerer ran, so routing the ask
 *      through the main session is not a stylistic choice, it is the only path
 *      that has an answerer at all.
 *   2. IT PAIRS BY ID. Every queued question carries the id it was filed under,
 *      and an answer names that id. Two workers asking at once therefore cannot
 *      swap answers: an answer that names an unknown id is reported as unknown
 *      and changes nothing, instead of landing on whichever question happens to
 *      be first.
 *
 * The tool is deliberately a small state machine over three actions, because
 * the main session's context is the scarce resource:
 *
 *   list    scan the queue; retire questions whose worker is gone; return the
 *           pending ones plus the ask request. Cheap: no Host call.
 *   answer  write one or more answers into their files, then deliver each one
 *           into its own worker Session.
 *   deliver sweep answers that were written but not yet delivered (a failed
 *           delivery leaves the answer deliverable, so a retry is not a loss).
 *
 * @module discipline-whale/question-tools
 */

import {
  answerMessage,
  answerQuestion,
  askRequestFor,
  deliverablePairs,
  expireQuestion,
  isQuestionId,
  listQuestions,
  markDelivered,
  overdueQuestions,
  pendingQuestions,
  pruneExpired,
  pruneTempFiles,
  readQuestion,
} from './questions.js'
import { storeRoot } from './store.js'

/** How a Session's liveness is described to this module. */
const LIVE = { live: true }
const GONE = { live: false, abandoned: false }

/**
 * Retire every pending question that can no longer be answered.
 *
 * Three reasons, all of them "asking would be a dead end":
 *
 *   session-gone   the worker Session is no longer live (disposed, or the Host
 *                  restarted and never resumed it). Its answer would be steered
 *                  into nothing.
 *   abandoned      the dispatch was explicitly abandoned, so nobody is waiting
 *                  for this worker any more — `dispatches/*.abandoned` is the
 *                  marker, checked by `worker.isDispatchAbandoned`.
 *   timeout        the deadline passed (`expiresAt`).
 *
 * Returns the retired records so a caller can report them instead of silently
 * dropping the question a worker is still blocked on.
 */
export async function sweepQueue({ root, liveness, now = Date.now() }) {
  const questions = await listQuestions(root)
  const retired = []

  for (const question of overdueQuestions(questions, now)) {
    const done = await expireQuestion(root, question.id, new Date(now), 'timeout')
    if (done !== undefined) retired.push(done)
  }

  const stillPending = pendingQuestions(await listQuestions(root), now)
  for (const question of stillPending) {
    const state = liveness(question.workerSessionId) ?? GONE
    if (state.live === true) continue
    const reason = state.abandoned === true ? 'abandoned' : 'session-gone'
    const done = await expireQuestion(root, question.id, new Date(now), reason)
    if (done !== undefined) retired.push(done)
  }

  // Debris cleanup rides the sweep the main session is already paying for, so
  // a crashed writer's temp file cannot accumulate in the queue directory.
  await pruneTempFiles(root).catch(() => {})
  await pruneExpired(root).catch(() => {})

  return retired
}

/**
 * Build the main session's tool set.
 *
 * Every Host dependency is injected rather than imported, which is what makes
 * the whole tool testable without a Harness:
 *
 * @param {object} deps
 * @param {() => string} deps.root          the store root, read per call so a
 *                                          test can pin it after mounting.
 * @param {(request: object) => Promise<object>} deps.askUser
 *                                          the live-root asking seam. Kept in
 *                                          the signature so the wiring point is
 *                                          explicit, and NEVER called from the
 *                                          tool itself.
 * @param {(sessionId: string, text: string) => Promise<object>} deps.deliver
 *                                          steer one answer into one worker.
 * @param {(sessionId: string) => ({live: boolean, abandoned?: boolean})} deps.liveness
 *                                          whether a worker Session still exists.
 * @returns {{pending_questions: object}} one tool, keyed by name.
 */
export function createQuestionTools(deps) {
  const root = deps.root ?? storeRoot
  const deliver = deps.deliver
  const liveness = deps.liveness ?? (() => LIVE)

  /**
   * Write one answer and try to deliver it.
   *
   * The ORDER is the whole reliability story: answer first (durable), deliver
   * second (may fail), mark delivered third (only on success). A crash anywhere
   * in that sequence leaves the answer on disk and undelivered, so the next
   * sweep retries it. Marking delivered before steering would lose the answer on
   * exactly the failure that matters — the worker session being briefly busy.
   */
  async function answerAndDeliver(id, answer, now) {
    if (!isQuestionId(id)) return { kind: 'unknown', id }
    const existing = await readQuestion(root(), id)
    if (existing === undefined) return { kind: 'unknown', id }
    if (existing.status !== 'pending') return { kind: 'settled', id, question: existing }

    const answered = await answerQuestion(root(), id, answer, new Date(now))
    if (answered === undefined) return { kind: 'unknown', id }
    // A question that was retired between the read and the write is settled,
    // not answered: `answerQuestion` refuses to revive it.
    if (answered.status !== 'answered') return { kind: 'settled', id, question: answered }

    try {
      await deliver(answered.workerSessionId, answerMessage(answered), answered)
    } catch (error) {
      return { kind: 'failed', id, error: String(error?.message ?? error), question: answered }
    }
    const done = await markDelivered(root(), id, new Date(now))
    return { kind: 'answered', id, question: done ?? answered }
  }

  return {
    pending_questions: {
      name: 'pending_questions',
      description:
        'The pending questions queued by worker sessions you dispatched. Workers cannot ask the user themselves (a delegated caller is refused before any answerer runs), so they file the question instead, and this is where you pick it up. `action:"list"` (default) returns the pending questions plus a ready-to-send `ask_user_question` request — ask the user with your own ask_user_question call, using those exact ids. `action:"answer"` writes the answers back and steers each one into the worker that asked, so it can continue without you re-reading anything. `action:"deliver"` retries answers that were written but could not be delivered. Questions whose worker session is gone, whose dispatch was abandoned, or whose deadline passed are retired automatically and reported as `expired`.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'answer', 'deliver'],
            description:
              '"list" (default): read the queue and get the ask request. "answer": write answers and steer them into their workers. "deliver": retry written-but-undelivered answers only.',
          },
          answers: {
            type: 'array',
            description:
              'For action:"answer": one entry per question, keyed by the queue id returned by "list". Each entry needs `selected` (option labels, exactly as offered) or `custom` (what the user typed).',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id'],
              properties: {
                id: { type: 'string', description: 'Queue id of the question being answered.' },
                selected: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Chosen option labels. Omit when the user typed an answer instead.',
                },
                custom: { type: 'string', description: 'Free-text answer the user typed.' },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['pending', 'expired'],
          properties: {
            pending: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'workerSessionId', 'question'],
                properties: {
                  id: { type: 'string' },
                  workerSessionId: { type: 'string' },
                  workspaceTitle: { type: 'string' },
                  header: { type: 'string' },
                  question: { type: 'string' },
                  askedAt: { type: 'string' },
                  expiresAt: { type: 'number' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['label'],
                      properties: { label: { type: 'string' }, description: { type: 'string' } },
                    },
                  },
                },
              },
            },
            ask: {
              type: 'object',
              description: 'Ready to pass straight to ask_user_question; empty when nothing is pending.',
              additionalProperties: false,
              properties: {
                questions: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
            expired: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'reason'],
                properties: { id: { type: 'string' }, reason: { type: 'string' } },
              },
            },
            answered: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'workerSessionId'],
                properties: { id: { type: 'string' }, workerSessionId: { type: 'string' } },
              },
            },
            delivered: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'workerSessionId'],
                properties: { id: { type: 'string' }, workerSessionId: { type: 'string' } },
              },
            },
            failed: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'error'],
                properties: { id: { type: 'string' }, error: { type: 'string' } },
              },
            },
            unknown: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.action === 'list' ? 'Pending questions' : 'Answer questions',
        kind: 'other',
        rawInput: args.action ?? 'list',
      }),
      async execute(args) {
        const now = Date.now()
        const action = args.action ?? 'list'

        if (action === 'answer' || action === 'deliver') {
          const results = []
          if (action === 'answer') {
            const answers = Array.isArray(args.answers) ? args.answers : []
            if (answers.length === 0) throw new Error('action:"answer" needs at least one entry in `answers`')
            for (const entry of answers) results.push(await answerAndDeliver(entry.id, entry, now))
          } else {
            // `deliver` sweeps answers that are written but undelivered. This is
            // the retry path after a failed steer, and it is also how a Host
            // restart is recovered: the answers are on disk, the marker is not.
            for (const question of deliverablePairs(await listQuestions(root()))) {
              try {
                await deliver(question.workerSessionId, answerMessage(question), question)
                const done = await markDelivered(root(), question.id, new Date(now))
                results.push({ kind: 'delivered', id: question.id, question: done ?? question })
              } catch (error) {
                results.push({
                  kind: 'failed',
                  id: question.id,
                  error: String(error?.message ?? error),
                  question,
                })
              }
            }
          }

          const retired = await sweepQueue({ root: root(), liveness, now })
          const byId = new Map(retired.filter((q) => q.status === 'expired').map((q) => [q.id, q]))
          // A question retired by this very sweep must not be reported as
          // answered: the delivery above happened before the sweep ran, but the
          // sweep's verdict is the later fact and the caller must not read a
          // retired question as a live one.
          const settled = (entry) => ({ id: entry.id, workerSessionId: entry.question.workerSessionId })
          const answered = results
            .filter((entry) => entry.kind === 'answered' && !byId.has(entry.id))
            .map(settled)
          const delivered = results
            .filter((entry) => entry.kind === 'delivered' && !byId.has(entry.id))
            .map(settled)
          const failed = results.filter((entry) => entry.kind === 'failed')
          return {
            pending: [],
            expired: [...byId.values()].map((q) => ({ id: q.id, reason: q.expiredReason ?? 'expired' })),
            answered,
            delivered,
            failed: failed.map((entry) => ({ id: entry.id, error: entry.error })),
            unknown: results.filter((entry) => entry.kind === 'unknown').map((entry) => entry.id),
            note: summarise({ answered, delivered, failed, retired: byId.size }),
          }
        }

        // list
        const retired = await sweepQueue({ root: root(), liveness, now })
        const questions = await listQuestions(root())
        const pending = pendingQuestions(questions, now)
        return {
          pending: pending.map((question) => ({
            id: question.id,
            workerSessionId: question.workerSessionId,
            ...(question.workspaceTitle === undefined ? {} : { workspaceTitle: question.workspaceTitle }),
            ...(question.header === undefined ? {} : { header: question.header }),
            question: question.question,
            askedAt: question.askedAt,
            expiresAt: question.expiresAt,
            ...(question.options.length === 0 ? {} : { options: question.options }),
          })),
          ask: askRequestFor(pending),
          expired: retired
            .filter((question) => question.status === 'expired')
            .map((question) => ({ id: question.id, reason: question.expiredReason ?? 'expired' })),
          answered: [],
          delivered: [],
          failed: [],
          unknown: [],
          note:
            pending.length === 0
              ? 'no pending questions'
              : `${pending.length} pending question(s); pass \`ask\` to ask_user_question as-is, then action:"answer" with those ids`,
        }
      },
    },
  }
}

/** One-line outcome, so the main session does not have to read the arrays. */
function summarise({ answered, failed, retired }) {
  const parts = []
  if (answered.length > 0) parts.push(`${answered.length} answered and delivered`)
  if (failed.length > 0) parts.push(`${failed.length} failed to deliver (the answer is kept; action:"deliver" retries)`)
  if (retired > 0) parts.push(`${retired} retired`)
  return parts.length === 0 ? 'nothing to do' : parts.join('; ')
}
