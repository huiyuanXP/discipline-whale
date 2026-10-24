/**
 * discipline-whale — the dispatch checkpoint file, shared by both rows.
 *
 * The dispatch registry is a process-local Map, so a Harness restart empties it
 * while worker Sessions stay durable. The checkpoint is the on-disk record that
 * lets a worker rebuild "who is waiting for me" after that restart.
 *
 * Both halves write it, which is why it lives here rather than in either row:
 *
 *   main   writes at `dispatch_task` time, so the window between the dispatch
 *          returning and the worker's first lifecycle event is already covered
 *   worker re-writes on its first lifecycle event, and drops the file once the
 *          dispatch reaches a terminal state (delivered or abandoned)
 *
 * One path rule, one record shape, both callers: a duplicated formula in the
 * two rows is exactly how "the worker reads a file nobody wrote" happens.
 *
 * @module discipline-whale/checkpoint
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { dataDir, workspaceKey } from './store.js'

/** Directory under the store root that holds dispatch checkpoints. */
export const DISPATCH_DIRNAME = 'dispatches'

/**
 * One worker Session's checkpoint path.
 *
 * Keyed like a report directory (`workspaceKey`), so an id with a slash or a
 * space can never escape the store directory.
 */
export function dispatchCheckpointPath(homeDir, workerSessionId) {
  return join(dataDir(homeDir), DISPATCH_DIRNAME, `${workspaceKey(workerSessionId)}.json`)
}

/**
 * The durable subset of a dispatch record.
 *
 * Deliberately narrower than the in-memory record: the task brief stays in the
 * Session log, and only the routing facts a restarted worker needs are copied,
 * plus the dispatch's `topic` and `title`, which label its report after a
 * restart. Both writers produce this exact shape, so either may read the
 * other's file.
 */
export function checkpointRecord(dispatch, workerSessionId) {
  return {
    dispatchId: dispatch.dispatchId,
    workerSessionId,
    mainSessionId: dispatch.mainSessionId,
    workspaceId: dispatch.workspaceId,
    workspaceTitle: dispatch.workspaceTitle,
    topic: dispatch.topic,
    title: dispatch.title,
    startedAt: dispatch.startedAt,
    checkpointedAt: new Date().toISOString(),
    checkpointedBy: hostname(),
  }
}

/**
 * Persist one dispatch's routing facts atomically (temp file then rename).
 *
 * A reader may therefore see either the previous file or the complete new one,
 * never a half-written JSON body. The temp name carries a random suffix because
 * both rows can write the same target: a shared `${pid}.tmp` name would let two
 * concurrent writers interleave into one temp file.
 */
export async function writeDispatchCheckpoint(homeDir, workerSessionId, dispatch) {
  const target = dispatchCheckpointPath(homeDir, workerSessionId)
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(checkpointRecord(dispatch, workerSessionId), null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return target
}

/**
 * Remove one checkpoint file.
 *
 * `force: true` makes this idempotent: the two rows can both decide a dispatch
 * is finished, and a missing file is the desired end state either way.
 */
export function dropDispatchCheckpoint(homeDir, workerSessionId) {
  return rm(dispatchCheckpointPath(homeDir, workerSessionId), { force: true }).catch(() => {})
}

/** Read one checkpoint, or undefined when there is none. */
export async function readDispatchCheckpoint(homeDir, workerSessionId) {
  try {
    return JSON.parse(await readFile(dispatchCheckpointPath(homeDir, workerSessionId), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Every checkpoint on disk, oldest dispatch first.
 *
 * A checkpoint is dropped once its report reaches the main session, so after a
 * restart each remaining file is a dispatch the restart interrupted. A
 * half-written or hand-edited file is skipped rather than failing the listing.
 */
export async function listDispatchCheckpoints(homeDir) {
  const dir = join(dataDir(homeDir), DISPATCH_DIRNAME)
  let entries
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const records = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const record = JSON.parse(await readFile(join(dir, entry), 'utf8'))
      if (typeof record?.workerSessionId === 'string') records.push(record)
    } catch {
      continue
    }
  }
  records.sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')))
  return records
}

/**
 * The marker the user's "abandon" leaves behind.
 *
 * The main session and the workers run separate registries, so abandoning in
 * the main session cannot reach a worker's in-memory record. The marker is the
 * shared fact: a worker checks it before steering for a report or re-writing a
 * checkpoint. It is not a `.json` file, so the checkpoint listing ignores it.
 */
export function abandonedMarkerPath(homeDir, workerSessionId) {
  return join(dataDir(homeDir), DISPATCH_DIRNAME, `${workspaceKey(workerSessionId)}.abandoned`)
}

/** Record that the user abandoned this worker's dispatch. */
export async function markDispatchAbandoned(homeDir, workerSessionId, dispatchId) {
  const target = abandonedMarkerPath(homeDir, workerSessionId)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify({ dispatchId, abandonedAt: new Date().toISOString() })}\n`, 'utf8')
}

/** True when the user abandoned this worker's dispatch; synchronous for turn-end checks. */
export function isDispatchAbandoned(homeDir, workerSessionId) {
  return existsSync(abandonedMarkerPath(homeDir, workerSessionId))
}
