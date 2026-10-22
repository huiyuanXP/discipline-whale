/**
 * discipline-whale — the pending-question queue (plan A: file queue, main asks).
 *
 * WHY THIS EXISTS: a dispatched worker cannot ask the user anything. The Host's
 * only asking path is `ctx.userQuestions.ask()`, and that path refuses a
 * delegated caller before the waterfall even runs — `assertLiveRoot` throws
 * `DELEGATED_CALLER` when the calling agent is owned by another live agent
 * (`@deepseek-ai/dsh-user-questions` lib/index.js:534, reached from
 * `UserQuestionService.ask`). A worker that called it would get an error, not an
 * answer, so plan A never calls `ask()` from a child:
 *
 *   worker  writes a question FILE  (ask_main)
 *   main    reads pending files, asks the user with its OWN live-root call
 *   main    writes the answer back into the same file
 *   main    steers the answer into the worker's Session (ordinary user message)
 *
 * The queue is therefore plain files under
 * `$DSH_HOME/discipline-whale/memory-state/questions/`, one JSON value per
 * question, so it survives a Host restart and needs no shared process memory
 * (the worker and main halves are different preset mounts).
 *
 * CONCURRENCY: every write is temp-file-then-rename, and the temp name carries
 * both the pid and a random suffix — two writers targeting one question cannot
 * interleave into a single temp file, and a reader sees either the previous
 * body or the complete new one. Pairing is by `id`, never by order.
 *
 * @module discipline-whale/questions
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dataDir, workspaceKey } from './store.js'

/** Directory (under the plugin data dir) that holds the question queue. */
export const QUESTIONS_DIRNAME = 'questions'

/** Directory (under the plugin data dir) that the queue lives in. */
export const STATE_DIRNAME = 'memory-state'

/** Question lifecycle. `pending` is the only state that still needs the user. */
export const QUESTION_STATUSES = ['pending', 'answered', 'expired']

/** Default time a pending question stays answerable before it is expired. */
export const DEFAULT_QUESTION_TTL_MS = 6 * 60 * 60 * 1000

/** Bound on a question text, so one worker cannot flood the main session. */
export const MAX_QUESTION_CHARS = 2000

/** Bound on one option label. */
export const MAX_OPTION_CHARS = 120

/** Most options a single question may offer. */
export const MAX_OPTIONS = 8

/** `questions` directory for one store root. */
export function questionsDir(homeDir) {
  return join(dataDir(homeDir), STATE_DIRNAME, QUESTIONS_DIRNAME)
}

/**
 * One question's file path.
 *
 * The id is `workspaceKey`-ed for the same reason report folders are: an id a
 * caller made up must never be able to escape the queue directory.
 */
export function questionPath(homeDir, id) {
  return join(questionsDir(homeDir), `${workspaceKey(id)}.json`)
}

/** Validate an opaque, filename-safe question id. */
export function isQuestionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

/** Clip a string to `max` characters without cutting a surrogate pair. */
function clip(value, max) {
  const text = String(value ?? '').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * Normalize the options a worker offered.
 *
 * Accepts either bare label strings or `{label, description}` objects, because
 * a hand-written or scripted question should not have to know the exact shape.
 * Anything unusable is dropped rather than throwing: a question with no options
 * is still a legitimate open-ended question.
 */
export function normalizeOptions(input) {
  if (!Array.isArray(input)) return []
  const options = []
  for (const entry of input) {
    if (options.length >= MAX_OPTIONS) break
    if (typeof entry === 'string') {
      const label = clip(entry, MAX_OPTION_CHARS)
      if (label !== '') options.push({ label })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const label = clip(entry.label, MAX_OPTION_CHARS)
    if (label === '') continue
    const description = typeof entry.description === 'string' ? clip(entry.description, 400) : undefined
    options.push(description === undefined ? { label } : { label, description })
  }
  return options
}

/**
 * Build a fresh pending-question record.
 *
 * `at` is injectable so a test can pin the clock; production paths pass nothing.
 */
export function newQuestion(input, at = new Date()) {
  const question = clip(input?.question, MAX_QUESTION_CHARS)
  if (question === '') throw new Error('`question` is empty')
  const sessionId = String(input?.workerSessionId ?? '').trim()
  if (sessionId === '') throw new Error('`workerSessionId` is required')
  const id = typeof input?.id === 'string' && isQuestionId(input.id) ? input.id : `q-${randomUUID()}`
  const askedAt = at.toISOString()
  return {
    id,
    version: 1,
    // Who is waiting, and where to send the answer back.
    workerSessionId: sessionId,
    mainSessionId: typeof input?.mainSessionId === 'string' ? input.mainSessionId : undefined,
    workspaceId: typeof input?.workspaceId === 'string' ? input.workspaceId : undefined,
    workspaceTitle: typeof input?.workspaceTitle === 'string' ? input.workspaceTitle : undefined,
    dispatchId: typeof input?.dispatchId === 'string' ? input.dispatchId : undefined,
    // What is being asked, in the shape ask_user_question already understands.
    header: typeof input?.header === 'string' ? clip(input.header, 80) : undefined,
    question,
    options: normalizeOptions(input?.options),
    multiSelect: input?.multiSelect === true,
    // Lifecycle.
    status: 'pending',
    askedAt,
    // Epoch ms; a numeric deadline survives serialization better than a Date.
    expiresAt: Number.isFinite(input?.expiresAt) ? Number(input.expiresAt) : at.getTime() + DEFAULT_QUESTION_TTL_MS,
    answeredAt: undefined,
    expiredAt: undefined,
    answer: undefined,
    deliveredAt: undefined,
  }
}

/**
 * Write one question atomically (temp file then rename).
 *
 * The temp suffix carries pid AND a random id: `checkpoint.js` explains why a
 * shared `${pid}.tmp` name is wrong, and the same reasoning applies here.
 */
export async function writeQuestion(homeDir, question) {
  const dir = questionsDir(homeDir)
  await mkdir(dir, { recursive: true })
  const target = questionPath(homeDir, question.id)
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(question, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return target
}

/** Read one question, or undefined when there is no such file. */
export async function readQuestion(homeDir, id) {
  if (!isQuestionId(id)) return undefined
  try {
    return JSON.parse(await readFile(questionPath(homeDir, id), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Delete one question file (used by cleanup and by tests). */
export async function deleteQuestion(homeDir, id) {
  if (!isQuestionId(id)) return false
  try {
    await unlink(questionPath(homeDir, id))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Every question on disk, newest first.
 *
 * A half-written or hand-edited file is skipped rather than failing the whole
 * listing: one bad file must not blind the main session to the rest. The same
 * rule as `store.listReports` and `checkpoint.listDispatchCheckpoints`.
 */
export async function listQuestions(homeDir) {
  let entries
  try {
    entries = await readdir(questionsDir(homeDir))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const questions = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const value = JSON.parse(await readFile(join(questionsDir(homeDir), entry), 'utf8'))
      if (typeof value?.id === 'string' && typeof value?.workerSessionId === 'string') questions.push(value)
    } catch {
      continue
    }
  }
  questions.sort((left, right) => String(right.askedAt ?? '').localeCompare(String(left.askedAt ?? '')))
  return questions
}

/**
 * Mark one pending question answered.
 *
 * Returns the updated record, or the unchanged one when it was not pending —
 * a question that expired while the user was reading must not be silently
 * revived by a late answer. `answer.selected` is the list of chosen option
 * labels; `answer.custom` is free text the user typed instead.
 */
export async function answerQuestion(homeDir, id, answer, at = new Date()) {
  const question = await readQuestion(homeDir, id)
  if (question === undefined) return undefined
  if (question.status !== 'pending') return question
  const selected = Array.isArray(answer?.selected)
    ? answer.selected.map((entry) => clip(entry, MAX_OPTION_CHARS)).filter((entry) => entry !== '')
    : []
  const custom = typeof answer?.custom === 'string' ? clip(answer.custom, MAX_QUESTION_CHARS) : undefined
  if (selected.length === 0 && (custom === undefined || custom === '')) {
    throw new Error('an answer needs at least one selected option or custom text')
  }
  const next = {
    ...question,
    status: 'answered',
    answeredAt: at.toISOString(),
    answer: { selected, ...(custom === undefined || custom === '' ? {} : { custom }) },
  }
  await writeQuestion(homeDir, next)
  return next
}

/** Mark one pending question expired. A non-pending question is left alone. */
export async function expireQuestion(homeDir, id, at = new Date(), reason = 'timeout') {
  const question = await readQuestion(homeDir, id)
  if (question === undefined) return undefined
  if (question.status !== 'pending') return question
  const next = {
    ...question,
    status: 'expired',
    expiredAt: at.toISOString(),
    expiredReason: reason,
  }
  await writeQuestion(homeDir, next)
  return next
}

/** Record that an answer was delivered into the worker Session. */
export async function markDelivered(homeDir, id, at = new Date()) {
  const question = await readQuestion(homeDir, id)
  if (question === undefined) return undefined
  const next = { ...question, deliveredAt: at.toISOString() }
  await writeQuestion(homeDir, next)
  return next
}

/**
 * The questions that still need the user, oldest first.
 *
 * Oldest first on purpose: the main session asks in arrival order, so a worker
 * that has been blocked for an hour is not overtaken by one dispatched a minute
 * ago.
 */
export function pendingQuestions(questions, now = Date.now()) {
  return questions
    .filter((question) => question.status === 'pending')
    .filter((question) => !(Number.isFinite(question.expiresAt) && question.expiresAt <= now))
    .sort((left, right) => String(left.askedAt ?? '').localeCompare(String(right.askedAt ?? '')))
}

/** Pending questions whose deadline has already passed. */
export function overdueQuestions(questions, now = Date.now()) {
  return questions
    .filter((question) => question.status === 'pending')
    .filter((question) => Number.isFinite(question.expiresAt) && question.expiresAt <= now)
}

/**
 * The `ask_user_question` request for one batch of queued questions.
 *
 * This is the whole point of plan A: the main session does not invent the
 * question, it forwards the worker's own text and options. Question ids in the
 * batch are the queue ids, so the answer comes back already paired — no
 * positional matching, and no chance of an answer landing on the wrong worker
 * when two are pending at once.
 */
export function askRequestFor(questions) {
  return {
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.header === undefined ? {} : { header: question.header }),
      ...(question.options.length === 0 ? {} : { options: question.options }),
      ...(question.multiSelect === true ? { multi_select: true } : {}),
    })),
  }
}

/**
 * The message steered back into a worker's Session once the user answered.
 *
 * Deliberately an ordinary user-role message: `ask()`'s own reply path
 * (`user-question-reply`) is rejected for a delegated caller, and it is the
 * wrong shape anyway — the worker never made a pending call for it to close.
 * The worker reads this as "the user answered the thing I filed", which is
 * exactly what happened.
 */
export function answerMessage(question) {
  const lines = [
    `[Discipline Whale] The user answered your question ${question.id}:`,
    '',
    `Q: ${question.question}`,
  ]
  if (question.answer.selected.length > 0) lines.push(`A: ${question.answer.selected.join(' / ')}`)
  if (typeof question.answer.custom === 'string' && question.answer.custom !== '') {
    lines.push(`A (typed): ${question.answer.custom}`)
  }
  lines.push(
    '',
    'Continue the task with that answer. Do not call report_to_main just to acknowledge this;',
    'report when the work is finished or genuinely blocked.',
  )
  return lines.join('\n')
}

/** Group questions by worker Session, for a compact board read. */
export function byWorker(questions) {
  const groups = new Map()
  for (const question of questions) {
    const list = groups.get(question.workerSessionId) ?? []
    list.push(question)
    groups.set(question.workerSessionId, list)
  }
  return groups
}

/* ------------------------------------------------------------------ *
 * delivery pairing
 * ------------------------------------------------------------------ */

/**
 * Pair answers with their questions and report which pairs are deliverable.
 *
 * Kept pure and separate from the Host call so the pairing rule is testable on
 * its own: an answer is deliverable only when the question is answered AND has
 * not already been delivered. That second condition is what makes a retried
 * delivery idempotent instead of double-steering the same answer.
 */
export function deliverablePairs(questions) {
  return questions
    .filter((question) => question.status === 'answered')
    .filter((question) => question.deliveredAt === undefined)
    .filter((question) => question.answer !== undefined)
}

/** Remove every expired question file older than `maxAgeMs`. */
export async function pruneExpired(homeDir, maxAgeMs = DEFAULT_QUESTION_TTL_MS, now = Date.now()) {
  const questions = await listQuestions(homeDir)
  let removed = 0
  for (const question of questions) {
    if (question.status !== 'expired') continue
    const stamp = Date.parse(String(question.expiredAt ?? ''))
    if (!Number.isFinite(stamp) || now - stamp < maxAgeMs) continue
    if (await deleteQuestion(homeDir, question.id)) removed += 1
  }
  return removed
}

/**
 * Drop the temp files a crashed writer left behind.
 *
 * A temp file is only ever live for the handful of milliseconds between
 * `writeFile` and `rename`; anything older than `maxAgeMs` is debris from a
 * process that died mid-write, and leaving it in the queue directory would make
 * `listQuestions` read it forever.
 */
export async function pruneTempFiles(homeDir, maxAgeMs = 60 * 1000, now = Date.now()) {
  let entries
  try {
    entries = await readdir(questionsDir(homeDir))
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue
    const path = join(questionsDir(homeDir), entry)
    try {
      const info = await stat(path)
      // `mtimeMs` is a rounded float that can land a fraction ABOVE `now`, which
      // would make the age negative and keep fresh debris forever. Clamping at
      // zero is the point of this line, not a stylistic choice.
      const age = Math.max(0, now - info.mtimeMs)
      if (age < maxAgeMs) continue
      await rm(path, { force: true })
      removed += 1
    } catch {
      continue
    }
  }
  return removed
}
