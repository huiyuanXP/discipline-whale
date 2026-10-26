/**
 * discipline-whale — memory row: wires the memory modules into the main preset.
 *
 * Mounted only in the Discipline Whale preset, next to the main row. It owns:
 *
 *   injection  — a system-prompt section with Soul / User / Memory and the
 *                writing rules (stable text, rewritten only after a write),
 *                and a runtime context with the activity board: the active
 *                workspaces, re-rendered at most once per human turn
 *   notes      — each board render writes every active workspace's note to
 *                `home/notes/<key>.md`, where the main session can `read` it
 *   tools      — remember, update_instructions, set_workspace_intro, dream_now
 *   automation — the pre-compaction flush, the ten-turn nudge, and, when the
 *                main session goes idle, the dream and the rotation check
 *                (rotation.js)
 *   tags       — the current user turn per main Session, so dispatch_task and
 *                send_to_session can tag the message that caused them, and a
 *                mention row for every workspace a human message names
 *
 * Model calls for flush and dream are hidden requests through the `llm`
 * service; their text never enters the main session.
 *
 * @module discipline-whale/memory-row
 */

import { randomUUID } from 'node:crypto'
import { readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  TAGS_WARN_BYTES,
  activeWorkspaces,
  buildBootstrap,
  mentionedWorkspaces,
  readTagRows,
  readWorkspaceCards,
  recordUserTurn,
  renderBoard,
  renderWorkspaceNote,
  setWorkspaceIntro,
  tagMention,
  tagTurn,
  tagsPath,
  workspaceFacts,
  workspaceNotePath,
} from './activity.js'
import { isDispatchAbandoned, listDispatchCheckpoints } from './checkpoint.js'
import { AUTO_MEMORY_TOOLS } from './guard.js'
import { collectNewDaily, runDream, shouldDream } from './dream.js'
import { readCursor, runFlush, shouldFlush, shouldNudge, writeCursor } from './memory-flush.js'
import {
  appendDaily,
  ensureLayers,
  importAutoMemory,
  listDailyDays,
  loadMemorySection,
  readDaily,
  readLayer,
  remember,
  replaceNow,
  updateInstructions,
  writeLayer,
} from './memory.js'
import { listDispatches } from './registry.js'
import { atomicWrite, isoDay } from './entry.js'
import { isHumanMessage, messageText } from './pushes.js'
import { ROTATION_DEFAULTS, applyRotationEnv, rotateMain, sessionStats, shouldRotate } from './rotation.js'
import { readState } from './state.js'
import { listReports, storeRoot, whaleHomeDir } from './store.js'

export const name = 'discipline-whale-memory'

/** `systemPrompt` carries the injection and `tools` the four tools; the rest is read with `ctx.get`. */
export const inject = ['systemPrompt', 'tools']

/** Prompt-section and runtime-context names, unique within a preset. */
export const MEMORY_SECTION_NAME = 'discipline-whale:memory'
export const ACTIVITY_CONTEXT_NAME = 'discipline-whale:activity'

/** `source.kind` on the hidden flush/dream requests and on the notices this row writes. */
export const MEMORY_SOURCE_KIND = 'plugin:discipline-whale:memory'

/** Source kind the agent loop gives runtime-context snapshots in the Session log. */
const RUNTIME_CONTEXT_KIND = 'runtime-context'

/** Defaults; each key can be overridden on the row's config. */
export const MEMORY_DEFAULTS = Object.freeze({
  mainPreset: 'discipline-whale',
  flushMarginTokens: 32768,
  nudgeInterval: 10,
  dreamMinHours: 24,
  dreamMinEntries: 5,
  compactThresholdRatio: 0.8,
  compactHeadroomTokens: 65536,
  // Per-route compaction ratios, the same list as the main preset's
  // compaction-basic `modelPolicies`: `{ provider, model, thresholdRatio }`.
  compactModelPolicies: Object.freeze([]),
  // A reasoning route spends this budget on reasoning before it answers, so a
  // dream prompt of ~30k characters needs far more than 4096: at 4096 the model
  // returned an empty answer with every token spent thinking, which read as
  // "model answer holds no JSON object" for 18 dreams in a row (2026-10-25).
  memoryMaxTokens: 16384,
  memoryProvider: '',
  memoryModel: '',
  migrateAutoMemory: true,
  ...ROTATION_DEFAULTS,
})

/** Store functions the flush and the dream write through. */
export const memoryStore = Object.freeze({
  readLayer,
  writeLayer,
  appendDaily,
  readDaily,
  listDailyDays,
  replaceNow,
  readWorkspaceCards,
  setWorkspaceIntro,
})

/* ------------------------------------------------------------------ *
 * shared turn state: the dispatch tools read it to tag the user message
 * ------------------------------------------------------------------ */

/** main sessionId -> { turn, messageId, text, at } of the latest real user message. */
const userTurns = new Map()

/** Called when anything the activity board shows has changed. */
const activityListeners = new Set()

/** The rotation in flight in this process, or null: one at a time across every main agent. */
let rotating = null

/** The latest real user message of one main Session, or undefined. */
export function currentUserTurn(sessionId) {
  return userTurns.get(sessionId)
}

/**
 * Tag the current user turn of `sessionId` with a workspace and dispatch.
 *
 * Never throws: tagging is bookkeeping, and a dispatch must succeed whether or
 * not its tag lands.
 */
export async function noteDispatch({ sessionId, workspaceId, dispatchId }, root = storeRoot()) {
  for (const listener of activityListeners) listener()
  const current = userTurns.get(sessionId)
  if (current === undefined || workspaceId === undefined) return false
  try {
    await tagTurn(root, { sessionId, turn: current.turn, workspaceId: String(workspaceId), dispatchId })
    return true
  } catch {
    return false
  }
}

/** The `## 工作区背景` block for a new dispatch into `workspace`, or '' when there is nothing to say. */
export async function dispatchBootstrap(workspace, root = storeRoot()) {
  try {
    const reports = await listReports(root, workspace.id)
    return await buildBootstrap(root, { workspace: { id: String(workspace.id), title: workspace.title }, reports })
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * pure helpers
 * ------------------------------------------------------------------ */

/** Resolve the row config: unknown keys are ignored, a malformed value keeps its default. */
export function resolveMemoryConfig(input = {}) {
  const out = { ...MEMORY_DEFAULTS }
  for (const [key, fallback] of Object.entries(MEMORY_DEFAULTS)) {
    const value = input?.[key]
    if (value === undefined) continue
    if (typeof fallback === 'number' && Number.isFinite(value) && value > 0) out[key] = value
    else if (typeof fallback === 'string' && typeof value === 'string') out[key] = value
    else if (typeof fallback === 'boolean' && typeof value === 'boolean') out[key] = value
    else if (Array.isArray(fallback) && Array.isArray(value)) out[key] = value.filter(isModelPolicy)
  }
  return out
}

/** A `compactModelPolicies` entry: a provider/model route and a ratio in (0, 1]. */
function isModelPolicy(policy) {
  return (
    typeof policy?.provider === 'string' &&
    policy.provider !== '' &&
    typeof policy.model === 'string' &&
    policy.model !== '' &&
    Number.isFinite(policy.thresholdRatio) &&
    policy.thresholdRatio > 0 &&
    policy.thresholdRatio <= 1
  )
}

/**
 * The token count at which compaction-basic condenses, computed the same way:
 * the smaller of `window × ratio` and `window − reserved output − headroom`.
 */
export function compactThreshold({ contextWindow, reservedTokens = 0, ratio, headroom }) {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  return Math.floor(Math.min(contextWindow * ratio, contextWindow - reservedTokens - headroom))
}

/**
 * Turn Session log events into the flush transcript.
 *
 * Runtime-context snapshots (this row's activity board among them) become
 * `context` items, which the flush prompt leaves out: injected memory is never
 * extracted again. Tool calls keep only their names.
 */
export function transcriptFromEvents(events = []) {
  const items = []
  for (const event of events) {
    if (event?.type === 'user/message') {
      const kind = event.data?.source?.kind
      const text = messageText(event.data)
      if (text === '') continue
      items.push({ role: kind === RUNTIME_CONTEXT_KIND ? 'context' : 'user', text })
    } else if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      const text = messageText(event.data?.message)
      if (text !== '') items.push({ role: 'assistant', text })
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool-call') items.push({ role: 'tool', toolName: String(block.name ?? 'tool') })
        }
      }
    }
  }
  return items
}

/**
 * The directory dsh-auto-memory keeps for one cwd: `--<key>--` under its memory
 * root, with the Session-store path encoding (separators fold to `-`, any other
 * character outside `[A-Za-z0-9._-]` becomes `~XXXX`, leading `-` trimmed).
 */
export function autoMemoryProjectDir(memoryRoot, cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of String(cwd)) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const key = readable.replace(/^-+/, '') || 'root'
  return join(memoryRoot, `--${key.slice(0, 251)}--`)
}

/**
 * Move the whale home's dsh-auto-memory entries into the whale's own layers.
 *
 * The source directory is renamed to `<dir>.migrated-<YYYYMMDD>` afterwards, so
 * the host's index for the whale home reads empty while the originals stay on
 * disk. Returns the number of imported entries, or 0 when there is nothing to do.
 */
export async function migrateAutoMemory(root = storeRoot(), now = new Date()) {
  const dir = autoMemoryProjectDir(join(root, 'memory'), whaleHomeDir(root))
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return 0
  } catch {
    return 0
  }
  const names = (await readdir(dir)).filter((entry) => entry.endsWith('.md') && entry !== 'MEMORY.md')
  const imported = names.length === 0 ? [] : await importAutoMemory(root, dir)
  await rename(dir, `${dir}.migrated-${isoDay(now).replace(/-/g, '')}`)
  return imported.length
}

/**
 * Take dsh-auto-memory's tools out of one agent's tool list, so the main
 * session has a single memory surface. Names the composition never registered
 * are skipped. The restriction lives as long as the agent.
 *
 * @returns the tool names now hidden from the agent.
 */
export function hideAutoMemoryTools(agent) {
  const tools = agent?.ctx?.tools
  if (typeof tools?.restrict !== 'function') return []
  const hidden = []
  for (const name of AUTO_MEMORY_TOOLS) {
    try {
      tools.restrict({ deny: [name] })
      hidden.push(name)
    } catch {
      // Not registered in this composition: nothing to hide.
    }
  }
  return hidden
}

/* ------------------------------------------------------------------ *
 * the row
 * ------------------------------------------------------------------ */

function textResult(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

const OK_OUTPUT = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => textResult(value),
}

/**
 * Install the memory row on a main-preset context.
 *
 * @param ctx - the row context.
 * @param {object} [config] - see {@link MEMORY_DEFAULTS}.
 * @param {object} [deps] - test seams: `root()` for the DSH root, `now()`.
 * @returns a handle with the caches and the internal triggers, for tests.
 */
export function installMemory(ctx, config = {}, deps = {}) {
  const resolved = applyRotationEnv(resolveMemoryConfig(config), deps.env ?? process.env, (message) =>
    ctx.logger?.warn?.(`discipline-whale memory: ${message}`),
  )
  const root = () => (typeof deps.root === 'function' ? deps.root() : storeRoot())
  const now = () => (typeof deps.now === 'function' ? deps.now() : new Date())
  const service = (key) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
    } catch {
      return undefined
    }
  }
  const workspaces = () => {
    try {
      return service('workspaceRegistry')?.list?.() ?? []
    } catch {
      return []
    }
  }
  const warn = (message) => ctx.logger?.warn?.(`discipline-whale memory: ${message}`)

  const isMainAgent = (agent) => {
    const preset = agent?.session?.header?.agentPreset
    if (typeof preset === 'string' && preset !== '') return preset === resolved.mainPreset
    try {
      return service('agentPresets')?.composedPreset?.(agent?.ctx) === resolved.mainPreset
    } catch {
      return false
    }
  }
  const sessionIdOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /* -------- caches behind the synchronous prompt providers -------- */

  const cache = { memory: '', activity: '', memoryDirty: true, activityDirty: true }

  /**
   * The board re-renders only when `epoch` moves past `rendered`. The epoch
   * steps on a Session's first step and on every claimed human message, so
   * between two human turns the context provider returns the same string and
   * the host appends no new snapshot. `activityDirty` records that board state
   * changed since the last render; the next epoch picks that change up.
   */
  const board = { epoch: 0, rendered: -1 }
  /** main sessionIds whose first step already stepped the epoch. */
  const boardSessions = new Set()
  /** main sessionId -> the turn and mention writes of its latest human message. */
  const pendingTurnWrites = new Map()
  let tagsWarned = false

  async function refreshMemory() {
    cache.memoryDirty = false
    try {
      const parts = [await loadMemorySection(root()), MEMORY_RULES]
      cache.memory = parts.filter((part) => typeof part === 'string' && part.trim() !== '').join('\n\n')
    } catch (error) {
      cache.memoryDirty = true
      warn(`could not render the memory section: ${error?.message ?? error}`)
    }
  }

  /** Everything the board and the notes are derived from, read from disk and the registry. */
  async function boardInput() {
    const byId = new Map()
    for (const record of await listDispatchCheckpoints(root())) {
      const abandoned = isDispatchAbandoned(root(), record.workerSessionId)
      byId.set(record.dispatchId, { ...record, ...(abandoned ? { status: 'abandoned' } : {}) })
    }
    for (const record of listDispatches()) byId.set(record.dispatchId, { ...byId.get(record.dispatchId), ...record })
    const listed = workspaces()
    const reports = []
    for (const workspace of listed) {
      reports.push(...(await listReports(root(), workspace.id).catch(() => [])))
    }
    return {
      workspaces: listed,
      cards: await readWorkspaceCards(root()),
      tags: await readTagRows(root()),
      reports,
      dispatches: [...byId.values()],
    }
  }

  async function warnLargeTags() {
    if (tagsWarned) return
    const size = await stat(tagsPath(root())).then((info) => info.size, () => 0)
    if (size <= TAGS_WARN_BYTES) return
    tagsWarned = true
    warn(`tags.jsonl is ${size} bytes (over ${TAGS_WARN_BYTES}); every human turn reads it whole`)
  }

  /** Render the board for the current epoch and write each active workspace's note. */
  async function refreshActivity() {
    const epoch = board.epoch
    cache.activityDirty = false
    try {
      await warnLargeTags()
      const input = await boardInput()
      // A render that started before a newer one finished keeps the newer board.
      if (epoch < board.rendered) return
      cache.activity = renderBoard(input)
      board.rendered = epoch
      const facts = workspaceFacts(input)
      for (const workspace of activeWorkspaces(input).active) {
        const note = renderWorkspaceNote(workspace, facts.get(String(workspace.id)))
        await atomicWrite(workspaceNotePath(root(), workspace.id), note).catch((error) =>
          warn(`could not write the note for ${workspace.id}: ${error?.message ?? error}`),
        )
      }
    } catch (error) {
      cache.activityDirty = true
      warn(`could not render the activity board: ${error?.message ?? error}`)
    }
  }

  const markActivity = () => {
    cache.activityDirty = true
  }
  activityListeners.add(markActivity)
  if (typeof ctx.effect === 'function') ctx.effect(() => () => activityListeners.delete(markActivity), 'memory.activity-listener')

  /* -------- hidden model calls -------- */

  function targetOf(agent) {
    const config = agent?.session?.requestHeader?.()?.config
    const provider = resolved.memoryProvider || config?.provider || agent?.options?.provider
    const model = resolved.memoryModel || config?.model || agent?.options?.model
    return provider && model ? { provider, model } : undefined
  }

  function completeFor(agent) {
    return async ({ system, user, signal }) => {
      const llm = service('llm')
      if (llm === undefined) throw new Error('the llm service is not available')
      const target = targetOf(agent)
      if (target === undefined) throw new Error('no provider/model for the memory call')
      const request = {
        ...target,
        system,
        messages: [
          { id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: MEMORY_SOURCE_KIND } },
        ],
        maxTokens: resolved.memoryMaxTokens,
        sessionId: sessionIdOf(agent),
        signal,
      }
      let text = ''
      for await (const chunk of llm.stream(request)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(`memory call finished with ${chunk.reason.kind}`)
        }
      }
      return text
    }
  }

  /* -------- per-Session automation state -------- */

  const sessions = new Map()
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = { nudging: false, flushedThisCycle: false, flushing: null, threshold: undefined, contextWindow: undefined }
      sessions.set(sessionId, state)
    }
    return state
  }

  /** The provider/model this main session runs on (the compaction route, not the memory model). */
  function routeOf(agent) {
    const config = agent?.session?.requestHeader?.()?.config
    const provider = config?.provider || agent?.options?.provider
    const model = config?.model || agent?.options?.model
    return provider && model ? { provider, model } : undefined
  }

  /**
   * The compaction trigger of this session's route; also caches its context
   * window. The ratio is the route's `compactModelPolicies` entry, else
   * `compactThresholdRatio`.
   */
  async function thresholdFor(agent, state) {
    if (state.threshold !== undefined) return state.threshold
    const route = routeOf(agent)
    const llm = service('llm')
    if (route === undefined || llm?.resolveModelInfo === undefined) return undefined
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      const reservedTokens = agent?.session?.requestHeader?.()?.config?.maxTokens ?? info?.defaultMaxTokens ?? 0
      const policy = resolved.compactModelPolicies.find(
        (candidate) => candidate.provider === route.provider && candidate.model === route.model,
      )
      state.contextWindow = info?.context?.contextWindow
      state.threshold = compactThreshold({
        contextWindow: state.contextWindow,
        reservedTokens,
        ratio: policy?.thresholdRatio ?? resolved.compactThresholdRatio,
        headroom: resolved.compactHeadroomTokens,
      })
    } catch {
      state.threshold = undefined
    }
    return state.threshold
  }

  /** Run one flush over the events since the last one; one at a time per Session. */
  function startFlush(agent, reason) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return undefined
    const state = stateFor(sessionId)
    if (state.flushing !== null) return state.flushing
    state.flushing = (async () => {
      try {
        const cursor = await readCursor(root())
        const recorded = Number.isInteger(cursor.flushSeq?.[sessionId]) ? cursor.flushSeq[sessionId] : 0
        const events = agent.session?.snapshotEvents?.() ?? []
        // A log shorter than the recorded position was rewritten: read it from the start.
        const fresh = events.slice(recorded > events.length ? 0 : recorded)
        const transcript = transcriptFromEvents(fresh)
        if (transcript.every((item) => item.role === 'context')) return { ok: true, skipped: 'nothing new' }
        const turn = userTurns.get(sessionId)?.turn
        const result = await runFlush({
          homeDir: root(),
          transcript,
          complete: completeFor(agent),
          store: memoryStore,
          now: now(),
          source: turn === undefined ? `session:${sessionId}` : `session:${sessionId}#t${turn}`,
          workspaces: workspaces().map((workspace) => ({ id: String(workspace.id), title: workspace.title })),
        })
        if (result.ok) {
          await writeCursor(root(), { flushSeq: { ...(cursor.flushSeq ?? {}), [sessionId]: events.length } })
          cache.memoryDirty = true
          // The flush runs beside the turn, so the idle check may have looked
          // before these daily entries existed; check again now that they do.
          if (result.daily > 0) startDream(agent)
        } else {
          warn(`${reason} flush failed: ${result.error}`)
        }
        return result
      } catch (error) {
        warn(`${reason} flush failed: ${error?.message ?? error}`)
        return { ok: false, error: String(error?.message ?? error) }
      } finally {
        state.flushing = null
      }
    })()
    return state.flushing
  }

  let dreaming = null
  function startDream(agent, { force = false } = {}) {
    // A forced dream that meets an idle check still in flight runs once more if that check skipped.
    if (dreaming !== null) {
      return force ? dreaming.then((result) => (result?.skipped ? startDream(agent, { force: true }) : result)) : dreaming
    }
    dreaming = (async () => {
      try {
        const cursor = await readCursor(root())
        const { count } = await collectNewDaily(root(), memoryStore, cursor)
        const due = shouldDream({
          lastDreamAt: cursor.lastDreamAt,
          newDailyEntries: count,
          now: now(),
          minHours: resolved.dreamMinHours,
          minEntries: resolved.dreamMinEntries,
        })
        if (!force && !due) return { ok: true, skipped: 'not due', newDailyEntries: count }
        const result = await runDream({
          homeDir: root(),
          complete: completeFor(agent),
          store: memoryStore,
          now: now(),
          workspaces: workspaces().map((workspace) => ({ id: String(workspace.id), title: workspace.title })),
        })
        cache.memoryDirty = true
        return result
      } catch (error) {
        warn(`dream failed: ${error?.message ?? error}`)
        return { ok: false, error: String(error?.message ?? error) }
      } finally {
        dreaming = null
      }
    })()
    return dreaming
  }

  /**
   * Rotate this main session when the rule says so (rotation.js).
   *
   * Only the current segment (`state.mainSessionId`) rotates, and only one
   * rotation runs per process at a time: a call while one is in flight joins
   * it. The rotation flushes memory first and gives up when the agent is busy
   * again afterwards; the next idle point checks again.
   */
  function maybeRotate(agent) {
    if (resolved.rotateEnabled === false) return Promise.resolve({ skipped: 'disabled' })
    if (rotating !== null) return rotating
    const run = (async () => {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return { skipped: 'no-session' }
      const { mainSessionId } = await readState(root())
      if (mainSessionId !== sessionId) return { skipped: 'not-current' }
      const stats = sessionStats(agent.session?.snapshotEvents?.() ?? [])
      const state = stateFor(sessionId)
      const threshold = await thresholdFor(agent, state)
      const decision = shouldRotate(stats, { config: resolved, contextWindow: state.contextWindow, compactThreshold: threshold })
      if (!decision.rotate) return { skipped: 'not-due' }
      return rotateMain({
        sessionController: service('sessionController'),
        agents: service('agents'),
        oldSessionId: sessionId,
        reason: decision.reason,
        stats,
        root: root(),
        flush: () => startFlush(agent, 'pre-rotation'),
        logger: ctx.logger,
        agent,
        config: resolved,
        now,
      })
    })()
      .catch((error) => {
        warn(`rotation failed: ${error?.message ?? error}`)
        return { skipped: 'error', error: String(error?.message ?? error) }
      })
      .finally(() => {
        rotating = null
      })
    rotating = run
    return run
  }

  /* -------- hooks -------- */

  /**
   * Every `nudgeInterval` DSH turns since the last nudge start one flush. The
   * position is kept per Session in the cursor, so it carries across restarts.
   */
  async function noteNudge(agent, sessionId, turn) {
    if (!Number.isInteger(turn)) return
    const state = stateFor(sessionId)
    if (state.nudging) return
    state.nudging = true
    try {
      const cursor = await readCursor(root())
      const stored = Number.isInteger(cursor.nudgeTurn?.[sessionId]) ? cursor.nudgeTurn[sessionId] : 0
      // A turn number below the stored one means the numbering restarted: count from zero.
      const last = stored > turn ? 0 : stored
      if (!shouldNudge({ turnsSinceLast: turn - last, interval: resolved.nudgeInterval })) return
      await writeCursor(root(), { nudgeTurn: { ...(cursor.nudgeTurn ?? {}), [sessionId]: turn } })
      startFlush(agent, 'nudge')
    } catch (error) {
      warn(`could not check the nudge: ${error?.message ?? error}`)
    } finally {
      state.nudging = false
    }
  }

  // The main session sees one memory surface: dsh-auto-memory's tools leave its
  // tool list as soon as the agent exists (startup, resume, clear, compact).
  ctx.on('agent/created', ({ agent }) => {
    if (isMainAgent(agent)) hideAutoMemoryTools(agent)
  })

  // A human message: remember its turn for tagging, record the turn and every
  // workspace it names, step the board epoch, and check the nudge. The writes
  // are kept per Session so the next pre-step renders after they land, whether
  // or not the host awaits this listener.
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (!isMainAgent(agent)) return
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    cache.activityDirty = true
    if (!isHumanMessage(message)) return
    const text = messageText(message)
    const record = { turn, messageId: message?.id, text, at: now().toISOString() }
    userTurns.set(sessionId, record)
    const named = mentionedWorkspaces(text, workspaces())
    const previous = pendingTurnWrites.get(sessionId) ?? Promise.resolve()
    const writes = previous.then(async () => {
      try {
        await recordUserTurn(root(), { sessionId, ...record })
        for (const workspace of named) {
          await tagMention(root(), { sessionId, turn, workspaceId: String(workspace.id), at: record.at })
        }
      } catch (error) {
        warn(`could not record the user turn: ${error?.message ?? error}`)
      }
    })
    pendingTurnWrites.set(sessionId, writes)
    void writes.then(() => {
      if (pendingTurnWrites.get(sessionId) === writes) pendingTurnWrites.delete(sessionId)
    })
    board.epoch += 1
    return noteNudge(agent, sessionId, turn)
  })

  // Before each step: bring the cached blocks up to date, and start the flush
  // once the context nears the compaction threshold. The flush runs beside the
  // turn; the margin leaves it room to finish before compaction condenses.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (isMainAgent(agent)) {
      if (cache.memoryDirty) await refreshMemory()
      const sessionId = sessionIdOf(agent)
      if (sessionId !== undefined && !boardSessions.has(sessionId)) {
        boardSessions.add(sessionId)
        board.epoch += 1
      }
      if (sessionId !== undefined) await pendingTurnWrites.get(sessionId)
      if (board.rendered !== board.epoch) await refreshActivity()
      const meter = service('tokenMeter')
      if (sessionId !== undefined && meter?.measure !== undefined) {
        const state = stateFor(sessionId)
        try {
          const contextTokens = meter.measure(agent.session)?.totalTokens
          const threshold = await thresholdFor(agent, state)
          if (Number.isFinite(contextTokens) && threshold !== undefined) {
            if (contextTokens < threshold - resolved.flushMarginTokens) state.flushedThisCycle = false
            else if (shouldFlush({ contextTokens, compactThreshold: threshold, margin: resolved.flushMarginTokens, flushedThisCycle: state.flushedThisCycle })) {
              state.flushedThisCycle = true
              startFlush(agent, 'pre-compaction')
            }
          }
        } catch (error) {
          warn(`could not measure context pressure: ${error?.message ?? error}`)
        }
      }
    }
    return next()
  })

  // Idle main session: the dream runs when due, then the rotation check.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !isMainAgent(agent)) return
    startDream(agent)
    maybeRotate(agent)
  })

  // `tools/result` is the observe-only feed; the result itself passes through untouched.
  ctx.on('tools/result', (exec) => {
    if (exec?.agent !== undefined && isMainAgent(exec.agent) && ACTIVITY_TOOLS.has(String(exec.name ?? ''))) {
      cache.activityDirty = true
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    sessions.delete(sessionId)
    boardSessions.delete(sessionId)
  })

  /* -------- tools -------- */

  const sourceOf = (exec) => {
    const sessionId = sessionIdOf(exec?.agent)
    const turn = sessionId === undefined ? undefined : userTurns.get(sessionId)?.turn
    if (sessionId === undefined) return undefined
    return turn === undefined ? `session:${sessionId}` : `session:${sessionId}#t${turn}`
  }

  const tools = [
    {
      name: 'remember',
      description:
        '写入鲸鱼的长期记忆（home/memory/）。target: "user" 记用户偏好（Preferences，用 Always/Never/Prefer 开头的祈使句）或用户当前意图（section "Now"）；"memory" 记稳定事实、约定、踩过的坑（陈述句）；"soul" 记用户对你语气风格的要求，写后在回复里告诉用户。只记稳定、跨会话有用、读代码读报告得不到的内容；会话摘要、任务进度、PR 号、密钥留给报告与 session log。op: add / replace / remove，replace 与 remove 用 match（旧条目里的一段原文）定位。写入超预算会报错并列出全部条目：在一次调用里先合并或删除再写。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'op'],
        properties: {
          target: { type: 'string', enum: ['user', 'memory', 'soul'] },
          op: { type: 'string', enum: ['add', 'replace', 'remove'] },
          text: { type: 'string', description: 'The entry text, one line (add / replace).' },
          match: { type: 'string', description: 'A substring of exactly one existing entry (replace / remove).' },
          section: { type: 'string', description: 'Optional: "Preferences" (default) or "Now" for target user.' },
        },
      },
      output: OK_OUTPUT,
      presentCall: (args) => ({ card: 'generic', title: 'Remember', kind: 'edit', rawInput: `${args.target}: ${args.text ?? args.match ?? ''}` }),
      async execute(args, exec) {
        const result = await remember(root(), { ...args, source: sourceOf(exec), now: now() })
        cache.memoryDirty = true
        return result
      },
    },
    {
      name: 'update_instructions',
      description:
        '修改鲸鱼 home 的 AGENTS.md（运行规则）。这是 AGENTS.md 唯一的写入口，只在用户本轮明确要求改规则时使用。user_quote 必须逐字摘自用户本轮消息（≥8 字），代码会校验。op: add / replace / remove。改完在回复里告诉用户改了哪一行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['user_quote', 'op'],
        properties: {
          user_quote: { type: 'string', description: "The user's own words from this turn asking for the rule change." },
          op: { type: 'string', enum: ['add', 'replace', 'remove'] },
          text: { type: 'string' },
          match: { type: 'string' },
        },
      },
      output: OK_OUTPUT,
      presentCall: (args) => ({ card: 'generic', title: 'Update AGENTS.md', kind: 'edit', rawInput: args.text ?? args.match ?? '' }),
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec?.agent)
        const latest = sessionId === undefined ? undefined : userTurns.get(sessionId)?.text
        return updateInstructions(root(), {
          userQuote: args.user_quote,
          latestUserText: latest ?? '',
          op: args.op,
          text: args.text,
          match: args.match,
          now: now(),
        })
      },
    },
    {
      name: 'set_workspace_intro',
      description:
        '更新一个工作区的介绍（≤200 字符）：用户用这个工作区在做什么、现在做到哪、下一步想做什么。它和 README 不同，写的是用户的用途与进度。派工后发现介绍缺失或过时就更新。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['workspace', 'intro'],
        properties: {
          workspace: { type: 'string', description: 'Workspace id or title, as list_workspaces shows it.' },
          intro: { type: 'string', description: 'At most 200 characters.' },
        },
      },
      output: OK_OUTPUT,
      presentCall: (args) => ({ card: 'generic', title: 'Workspace intro', kind: 'edit', rawInput: `${args.workspace}: ${args.intro}` }),
      async execute(args) {
        const selector = String(args.workspace ?? '')
        const workspace = workspaces().find(
          (candidate) => String(candidate.id) === selector || candidate.title === selector || candidate.path === selector,
        )
        if (workspace === undefined) throw new Error(`no registered workspace "${selector}"; call list_workspaces for ids`)
        const card = await setWorkspaceIntro(root(), String(workspace.id), String(args.intro ?? ''), { now: now() })
        cache.activityDirty = true
        return { workspaceId: String(workspace.id), ...card }
      },
    },
    {
      name: 'dream_now',
      description:
        '立即整理一次长期记忆（dream）：把 daily 笔记里反复出现、已确认的观察提升进 USER/MEMORY，合并重复，相对时间改绝对，删掉被推翻的条目。用户说「整理一下记忆」时调用。整理记录写在 home/memory/DREAMS.md。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: OK_OUTPUT,
      presentCall: () => ({ card: 'generic', title: 'Dream', kind: 'other' }),
      async execute(_args, exec) {
        return startDream(exec?.agent, { force: true })
      },
    },
  ]
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `memory.tool(${tool.name})`)

  /* -------- injection -------- */

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: MEMORY_SECTION_NAME,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 2,
        interpolate: false,
        text: () => cache.memory,
      }),
    'memory.section()',
  )
  if (typeof ctx.systemPrompt.context === 'function') {
    ctx.effect(
      () =>
        ctx.systemPrompt.context({
          name: ACTIVITY_CONTEXT_NAME,
          order: 500,
          interpolate: false,
          required: true,
          text: () => cache.activity,
        }),
      'memory.context()',
    )
  }

  /* -------- startup -------- */

  const ready = (async () => {
    if (resolved.migrateAutoMemory) {
      try {
        const count = await migrateAutoMemory(root(), now())
        if (count > 0) ctx.logger?.info?.(`discipline-whale memory: imported ${count} dsh-auto-memory entries`)
      } catch (error) {
        warn(`dsh-auto-memory migration failed: ${error?.message ?? error}`)
      }
    }
    try {
      await ensureLayers(root())
    } catch (error) {
      warn(`could not create the memory files: ${error?.message ?? error}`)
    }
    await refreshMemory()
    await refreshActivity()
  })()

  return {
    config: resolved,
    cache,
    board,
    sessions,
    ready,
    refreshMemory,
    refreshActivity,
    startFlush,
    startDream,
    maybeRotate,
    rotation: () => rotating,
    thresholdFor: (agent) => thresholdFor(agent, stateFor(sessionIdOf(agent))),
    tools,
  }
}

/** Main-session tools whose effect changes the activity board. */
const ACTIVITY_TOOLS = new Set(['dispatch_task', 'send_to_session', 'resume_dispatch', 'abandon_dispatch', 'read_report'])

/** Usage note appended to the memory section. */
const MEMORY_RULES = [
  '## 记忆的写法',
  '- 用户说「记住」、表达偏好、纠正你 → `remember`；用户说接下来想做什么 → `remember(target:"user", section:"Now")`。',
  '- 派工后工作区介绍缺失或过时 → `set_workspace_intro`（≤200 字符：用途 + 现状 + 下一步）。',
  '- 便签板只列活跃的工作区；每个活跃工作区的完整便签在 `notes/<key>.md`，需要细节时 `read` 它。',
  '- AGENTS.md 只经 `update_instructions` 修改，且只在用户本轮明确要求时。',
  '- 日常观察由后台自动写入 daily 笔记，定期整理进上面的条目；你专注于用户明确交代的内容。',
  '- 宿主注入的 `<memory_context>`（用户级记忆）是只读参考；本会话写记忆只用 `remember`。',
].join('\n')

export function apply(ctx, config = {}) {
  installMemory(ctx, config)
}
