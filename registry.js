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

/** Test-only reset. */
export function resetRegistry() {
  dispatches.clear()
  dispatchByWorker.clear()
  reportRetries.clear()
}
