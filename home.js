/**
 * discipline-whale — the whale's home.
 *
 * `$DSH_HOME/discipline-whale/home` is the whale's private working directory:
 * the main session runs there and writes whatever files its work needs. It sits
 * in the plugin's data directory next to reports and dispatch checkpoints, and
 * is never registered as a workspace — it is backend storage, not a project.
 *
 * This profile-level row creates the directory at boot, keeps the plugin state
 * (`state.json`, which records the main session), and serves both to the Web
 * sidebar entry through one route:
 *
 *   GET  /api/discipline-whale/home  → { home, mainSessionId, lineage }
 *   POST /api/discipline-whale/home  → the first main session: creates, wakes
 *                                      and records it; with a main session
 *                                      already recorded: rotates it
 *                                      (rotation.js, `reason: 'manual'`);
 *                                      answers like GET
 *
 * `lineage` is the latest 20 rotations from `state.json`, oldest first; the
 * client follows it to the current main session.
 *
 * The first main session is woken with a first turn right away; a rotated one
 * is woken by its seed. Besides greeting the user, that turn is what makes the
 * session usable in the Web composer: a session outside every workspace only
 * accepts input once it has a turn.
 *
 * At boot the row also checks for dispatches a restart interrupted (dispatch
 * checkpoints that were never delivered). When there are any and a main session
 * exists, the main session is told about them and asks the user, per dispatch,
 * whether to resume or abandon it.
 *
 * The row also names the package itself, which is what makes the client-modules
 * scan serve the sidebar entry (`./client`).
 *
 * @module discipline-whale/home
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import { listDispatchCheckpoints } from './checkpoint.js'
import { installQuestionTool } from './question-host.js'
import { registerMemoryRoutes } from './memory-routes.js'
import { PUSH_PREFIXES } from './pushes.js'
import { MAIN_PRESET, MAIN_TITLE, rotateMain, sessionStats } from './rotation.js'
import { readState, writeState } from './state.js'
import { storeRoot, whaleHomeDir } from './store.js'
import { registerVoiceRoutes } from './voice.js'
import { registerVoiceSettingsRoutes } from './voice-settings.js'
import { registerVoiceAssetRoutes } from './voice-assets.js'
import { publishTokenHandoff, registerTokenHandoffRoute } from './token-handoff.js'

/** Route the Web sidebar entry reads and writes. */
export const HOME_ROUTE = '/api/discipline-whale/home'

/** Preset and title of the main session, defined with the rotation that also creates one. */
export { MAIN_PRESET, MAIN_TITLE }

/** How many lineage entries `GET /home` returns. */
export const LINEAGE_LIMIT = 20

/** The lineage fields the client reads. */
const LINEAGE_FIELDS = ['sessionId', 'successor', 'endedAt', 'reason', 'lastInputTokens', 'compactions', 'seedFile']

/** The first turn of a new main session. */
export const WAKE_PROMPT = [
  `${PUSH_PREFIXES.wake}自律鲸鱼主会话已建立，工作目录是你自己的 home。`,
  '请用两三句话告诉我你能做什么，然后调用 list_dispatches 汇报当前派工状态。',
].join('\n')

/**
 * The startup-check turn for the main session, or undefined when nothing was
 * interrupted.
 */
export function interruptedNotice(checkpoints) {
  if (checkpoints.length === 0) return undefined
  const lines = checkpoints.map(
    (checkpoint, index) =>
      `${index + 1}. 工作区「${checkpoint.workspaceTitle ?? checkpoint.workspaceId}」，worker ${checkpoint.workerSessionId}，派工时间 ${checkpoint.startedAt ?? '未知'}`,
  )
  return [
    `${PUSH_PREFIXES.startup}DeepSeek Harness 重启前有 ${checkpoints.length} 条派工没有完成回报：`,
    ...lines,
    '',
    '请结合你的会话记录，用一句话说明每条派工原本在做什么，然后用 ask_user 让用户为每条派工选择：恢复 / 放弃 / 稍后再说。',
    '按用户的选择调用 resume_dispatch（恢复）或 abandon_dispatch（放弃）；选「稍后再说」的保持原样，下次启动会再次提醒。',
  ].join('\n')
}

export const name = 'discipline-whale-home'

/** Create the whale's home directory; returns its absolute path. */
export async function ensureHome(homeDir = storeRoot()) {
  const path = whaleHomeDir(homeDir)
  await mkdir(path, { recursive: true })
  return path
}

const isSessionId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)

/** The latest `LINEAGE_LIMIT` lineage entries of a state, oldest first. */
export function recentLineage(state) {
  const lineage = Array.isArray(state?.lineage) ? state.lineage : []
  return lineage
    .filter((entry) => isSessionId(entry?.sessionId) && isSessionId(entry?.successor))
    .slice(-LINEAGE_LIMIT)
    .map((entry) => Object.fromEntries(LINEAGE_FIELDS.map((field) => [field, entry[field] ?? null])))
}

/** A Session's events through the controller, or none when it cannot be inspected. */
async function eventsOf(sessionController, sessionId) {
  try {
    const inspected = await sessionController.inspect?.(sessionId, new AbortController().signal)
    return Array.isArray(inspected?.events) ? inspected.events : []
  } catch {
    return []
  }
}

/**
 * Give the user a fresh main session.
 *
 * With a main session already recorded, this is a manual rotation: the same
 * entry as the automatic one, without the flush (the memory row's flush is out
 * of this row's reach). Otherwise the first main session is created in the
 * home, woken with its first turn and recorded.
 *
 * @param options.agents - the Host's agent registry, for the seed's notice path.
 * @returns the main session id now recorded.
 */
export async function createMainSession(sessionController, { agents, logger } = {}) {
  const { mainSessionId: current } = await readState()
  if (isSessionId(current)) {
    const result = await rotateMain({
      sessionController,
      agents,
      oldSessionId: current,
      reason: 'manual',
      stats: sessionStats(await eventsOf(sessionController, current)),
      root: storeRoot(),
      logger,
    })
    if (result.newSessionId !== undefined && result.skipped === undefined) return result.newSessionId
    // Another rotation holds the lock or already moved on: the state it writes is the answer.
    if (result.skipped === 'busy' || result.skipped === 'not-current') return (await readState()).mainSessionId
    throw new Error(`the main session could not be rotated (${result.skipped}${result.error ? `: ${result.error}` : ''})`)
  }
  const home = await ensureHome()
  const created = await sessionController.create({ cwd: home, agentPreset: MAIN_PRESET })
  const sessionId = String(created.sessionId)
  await writeState({ mainSessionId: sessionId })
  try {
    await sessionController.rename({ sessionId, title: MAIN_TITLE })
  } catch {
    // A missing title only changes how the session is listed.
  }
  const notice = interruptedNotice(await listDispatchCheckpoints(storeRoot()))
  await promptMain(sessionController, sessionId, notice === undefined ? WAKE_PROMPT : `${WAKE_PROMPT}\n\n${notice}`)
  return sessionId
}

/**
 * The route handler, bound to the Host's session controller.
 *
 * @param options.agents - `() => agents`: the Host's agent registry, read per request.
 */
export function homeHandler(sessionController, { agents, logger } = {}) {
  // One creation at a time: a second request joins the running one, so the
  // home never gets two main sessions from a double click.
  let creating = null
  return async function handleHomeRequest(request) {
    const headers = { 'cache-control': 'no-store' }
    try {
      if (request.method === 'POST') {
        if (creating === null) {
          const registry = typeof agents === 'function' ? agents() : agents
          creating = createMainSession(sessionController, { agents: registry, logger }).finally(() => {
            creating = null
          })
        }
        await creating
      }
      const home = await ensureHome()
      const state = await readState()
      const mainSessionId = isSessionId(state.mainSessionId) ? state.mainSessionId : null
      return Response.json({ home, mainSessionId, lineage: recentLineage(state) }, { headers })
    } catch (error) {
      return Response.json({ error: String(error?.message ?? error) }, { status: 500, headers })
    }
  }
}

async function promptMain(sessionController, sessionId, text) {
  await sessionController.prompt(
    { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
    new AbortController().signal,
  )
}

/**
 * Tell the recorded main session about interrupted dispatches, once per boot.
 * Returns the number of interrupted dispatches it reported.
 */
export async function startupCheck(sessionController) {
  const { mainSessionId } = await readState()
  if (!isSessionId(mainSessionId)) return 0
  const checkpoints = await listDispatchCheckpoints(storeRoot())
  const notice = interruptedNotice(checkpoints)
  if (notice === undefined) return 0
  await promptMain(sessionController, mainSessionId, notice)
  return checkpoints.length
}

export function apply(ctx) {
  ensureHome().catch((error) => {
    ctx.logger?.warn?.(`discipline-whale: could not create the whale home: ${error?.message ?? error}`)
  })
  // The question queue's main-session half. Installed here, not in `main.js`,
  // for two reasons: this row is already the profile-level one that owns the
  // main session's plumbing (`state.json`, the startup check, voice), and the
  // tool is registered on the MAIN AGENT'S scope rather than globally, so it
  // needs the agent lifecycle, which this row can observe. See
  // `question-host.js` for the two Host facts it rests on.
  ctx.inject(['tools', 'sessionController'], (c) => {
    installQuestionTool(c)
  })
  // Only the Web server carries the routes; headless and SDK profiles skip them.
  ctx.inject(['sessionController', 'connection', 'webServer'], (c) => {
    startupCheck(c.sessionController).catch((error) => {
      ctx.logger?.warn?.(`discipline-whale: startup check failed: ${error?.message ?? error}`)
    })
    // The Host's credential seam, when this composition mounts one. It is
    // optional on purpose: a minimal profile has no credential store, and voice
    // must still work off the 0600 plugin file and the environment there.
    // `ctx.get` never throws for a missing service, so this is a plain read.
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    // A 401 page cannot repair itself: the document never loads, so no plugin
    // script runs. Hand it two things instead — an unauthenticated route that
    // reports THIS process's launch URL, and a stable file at
    // `$DSH_HOME/logs/last-token-url.txt` for a person to read. Both carry the
    // token `dsh web` already prints, so no new secret is exposed; see
    // `docs/restart-and-token.md`. Registered before the authenticated routes
    // so a broken cookie still has somewhere to ask.
    try {
      const origin = c.webServer.getOrigin()
      // `authenticatedUrl` is the connection's own public API: it appends this
      // process's launch token to the base URL the listener actually bound.
      const launchUrl = c.connection.authenticatedUrl(origin)
      const home = storeRoot()
      publishTokenHandoff({ dshHome: home, url: launchUrl, logger: ctx.logger }).catch(() => {})
      ctx.effect(
        () => registerTokenHandoffRoute(c.webServer, { url: () => launchUrl, logger: ctx.logger }),
        'discipline-whale: auth handoff route',
      )
    } catch (error) {
      // A profile without a bound listener (or one whose origin cannot be
      // expressed as a URL) simply gets no handoff route; nothing else changes.
      ctx.logger?.warn?.(`discipline-whale: could not publish the auth handoff: ${error?.message ?? error}`)
    }
    // Voice rides this same connection: transcription on one route, the
    // transcript handed to the recorded main session on another, and the
    // settings pair (read/write the key-free description, probe the backend).
    // The say route owns the only `sessionController.prompt` call voice can
    // reach, so a page script cannot address an arbitrary session with it.
    registerVoiceRoutes(c.connection, {
      logger: ctx.logger,
      credentials,
      say: { sessionController: c.sessionController, readState: () => readState() },
    }).catch((error) => {
      ctx.logger?.warn?.(`discipline-whale: could not register the voice routes: ${error?.message ?? error}`)
    })
    registerVoiceSettingsRoutes(c.connection, { logger: ctx.logger, credentials }).catch((error) => {
      ctx.logger?.warn?.(`discipline-whale: could not register the voice settings routes: ${error?.message ?? error}`)
    })
    // The page's speech detector (Silero VAD via vad-web) is served from the
    // installed packages on this same connection, never from a CDN.
    registerVoiceAssetRoutes(c.connection, { logger: ctx.logger }).catch((error) => {
      ctx.logger?.warn?.(`discipline-whale: could not register the voice detector routes: ${error?.message ?? error}`)
    })
    // Workspace colors and per-turn tags for the client's chips and sidebar dots.
    registerMemoryRoutes(c.connection, {
      workspaces: () => {
        try {
          return ctx.get?.('workspaceRegistry')?.list?.() ?? []
        } catch {
          return []
        }
      },
    }).catch((error) => {
      ctx.logger?.warn?.(`discipline-whale: could not register the memory routes: ${error?.message ?? error}`)
    })
    return c.connection.fetch.register({
      path: HOME_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: homeHandler(c.sessionController, {
        agents: () => (typeof ctx.get === 'function' ? ctx.get('agents') : undefined),
        logger: ctx.logger,
      }),
    })
  })
}
