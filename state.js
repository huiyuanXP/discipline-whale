/**
 * discipline-whale — the plugin state file and the main-session lineage.
 *
 * `state.json` in the plugin's data directory records which Session is the
 * main session now. A rotation ends one main session and starts the next, and
 * appends the ended one to `state.lineage`:
 *
 *   { mainSessionId, lineage: [{ sessionId, successor, endedAt, reason,
 *                                lastInputTokens, compactions, seedFile }] }
 *
 * A dispatch remembers the main session that sent it. When that Session has
 * since rotated away, its report still belongs to the user's conversation, so
 * every push resolves the recorded id through the lineage to the current main
 * session. While a rotation is in flight (`rotation.lock` exists) the state is
 * about to change, so a push waits for it to settle first.
 *
 * @module discipline-whale/state
 */

import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { MEMORY_STATE_DIRNAME } from './memory-flush.js'
import { dataDir, storeRoot } from './store.js'

/** Plugin state file inside the data directory. */
export const STATE_FILENAME = 'state.json'

/** Lock file a rotation holds while it moves the main session. */
export const ROTATION_LOCK_FILENAME = 'rotation.lock'

/** Longest a push waits for a rotation in flight, in milliseconds. */
export const ROTATION_WAIT_MS = 10_000

/** How often a waiting push checks the rotation lock, in milliseconds. */
export const ROTATION_POLL_MS = 200

/** `<dataDir>/state.json`. */
export function statePath(homeDir) {
  return join(dataDir(homeDir), STATE_FILENAME)
}

/** `<dataDir>/memory-state/rotation.lock`. */
export function rotationLockPath(homeDir) {
  return join(dataDir(homeDir), MEMORY_STATE_DIRNAME, ROTATION_LOCK_FILENAME)
}

/** Read the plugin state; a missing or unreadable file is an empty state. */
export async function readState(homeDir = storeRoot()) {
  try {
    const value = JSON.parse(await readFile(statePath(homeDir), 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** Merge `patch` into the plugin state, written atomically. */
export async function writeState(patch, homeDir = storeRoot()) {
  const next = { ...(await readState(homeDir)), ...patch }
  await mkdir(dataDir(homeDir), { recursive: true })
  const target = statePath(homeDir)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return next
}

/**
 * The Session a push for `recorded` goes to.
 *
 * `recorded` names a main session in `state.lineage` → the current main
 * session; any other id (the current main session itself, a Session the
 * lineage never saw) comes back as it is.
 */
export function resolveMainTarget(recorded, state) {
  const current = state?.mainSessionId
  if (typeof current !== 'string' || current === '') return recorded
  const lineage = Array.isArray(state?.lineage) ? state.lineage : []
  return lineage.some((entry) => entry?.sessionId === recorded) ? current : recorded
}

async function lockHeld(homeDir) {
  try {
    await access(rotationLockPath(homeDir))
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `recorded` against the state on disk, after any rotation in flight.
 *
 * Waits while the rotation lock exists, at most `ROTATION_WAIT_MS`, checking
 * every `ROTATION_POLL_MS`; then reads the state and resolves.
 */
export async function currentMainFor(recorded, homeDir = storeRoot()) {
  const deadline = Date.now() + ROTATION_WAIT_MS
  while (Date.now() < deadline && (await lockHeld(homeDir))) {
    await sleep(ROTATION_POLL_MS)
  }
  return resolveMainTarget(recorded, await readState(homeDir))
}
