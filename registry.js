/**
 * discipline-whale — the process-local dispatch registry.
 *
 * Shared by both halves of the plugin: the main-side row records a dispatch,
 * the worker-side row looks it up when the worker reports. Keeping it in its
 * own module means the two rows share one map inside a single Harness process
 * without either row importing the other.
 *
 * This state is deliberately transient. After a restart the reports already on
 * disk stay readable, but "who is waiting on whom" is a fact about this run.
 *
 * @module discipline-whale/registry
 */

/** dispatchId -> dispatch record */
export const dispatches = new Map()

/** workerSessionId -> dispatchId */
export const dispatchByWorker = new Map()

/** dispatchId -> number of enforcement steers already issued */
export const reportRetries = new Map()

/** Create and index one dispatch record. */
export function recordDispatch(record) {
  dispatches.set(record.dispatchId, record)
  dispatchByWorker.set(record.workerSessionId, record.dispatchId)
  return record
}

/** Resolve the dispatch a worker session belongs to. */
export function dispatchForWorker(workerSessionId) {
  const id = dispatchByWorker.get(workerSessionId)
  return id === undefined ? undefined : dispatches.get(id)
}

/** How many enforcement steers this dispatch has already received. */
export function retriesFor(dispatchId) {
  return reportRetries.get(dispatchId) ?? 0
}

/** Record one enforcement steer. */
export function noteRetry(dispatchId) {
  const next = retriesFor(dispatchId) + 1
  reportRetries.set(dispatchId, next)
  return next
}

/** Forget one dispatch's retry budget. */
export function clearRetries(dispatchId) {
  reportRetries.delete(dispatchId)
}

/**
 * Snapshot every dispatch record.
 *
 * Returns plain copies so a caller (the dispatch board tool) can read the board
 * without holding a live handle on the maps: mutating a returned object must
 * never change the registry, and iterating a copy must not race a record that
 * the worker row updates mid-read.
 *
 * @returns {object[]} shallow copies, in insertion order (oldest dispatch first).
 */
export function listDispatches() {
  return [...dispatches.values()].map((record) => ({ ...record }))
}

/**
 * Drop terminal dispatches whose last known activity is older than `maxAgeMs`.
 *
 * The registry is process-local and unbounded: a long-lived Host that dispatches
 * once an hour would otherwise keep every finished record (and every task brief)
 * in memory for the life of the process. Only `reported` / `abandoned` records are
 * eligible — a running dispatch is never pruned, because its row is the only
 * thing that can still route a report and identify the worker session.
 *
 * This is deliberately NOT called automatically. A board that silently deletes
 * its own rows is worse than a board that grows: pruning stays an explicit
 * maintenance action, and a caller must opt in with a retention window.
 *
 * @param {number} maxAgeMs - retention window in milliseconds.
 * @param {number} [now] - reference time, for tests.
 * @returns {number} how many records were removed.
 */
export function pruneDispatches(maxAgeMs, now = Date.now()) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('maxAgeMs must be a non-negative finite number')
  }
  let removed = 0
  for (const [dispatchId, record] of dispatches) {
    if (record.status !== 'reported' && record.status !== 'abandoned') continue
    const last = Date.parse(record.reportedAt ?? record.startedAt)
    // An unparseable timestamp is treated as "old": a record we cannot date is
    // exactly the record we cannot justify keeping forever.
    if (Number.isFinite(last) && now - last < maxAgeMs) continue
    dispatches.delete(dispatchId)
    if (record.workerSessionId !== undefined && dispatchByWorker.get(record.workerSessionId) === dispatchId) {
      dispatchByWorker.delete(record.workerSessionId)
    }
    reportRetries.delete(dispatchId)
    removed += 1
  }
  return removed
}

/** Test-only reset. */
export function resetRegistry() {
  dispatches.clear()
  dispatchByWorker.clear()
  reportRetries.clear()
}
