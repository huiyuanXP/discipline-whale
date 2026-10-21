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
 *   GET  /api/discipline-whale/home  → { home, mainSessionId }
 *   POST /api/discipline-whale/home  → creates and wakes a new main session,
 *                                      records it, answers like GET
 *
 * A new main session is woken with a first turn right away. Besides greeting
 * the user, that turn is what makes the session usable in the Web composer: a
 * session outside every workspace only accepts input once it has a turn.
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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { listDispatchCheckpoints } from './checkpoint.js'
import { registerMemoryRoutes } from './memory-routes.js'
import { dataDir, storeRoot, whaleHomeDir } from './store.js'
import { registerVoiceRoutes } from './voice.js'
import { registerVoiceSettingsRoutes } from './voice-settings.js'
import { registerVoiceAssetRoutes } from './voice-assets.js'

/** Route the Web sidebar entry reads and writes. */
export const HOME_ROUTE = '/api/discipline-whale/home'

/** Plugin state file inside the data directory. */
export const STATE_FILENAME = 'state.json'

/** Preset the main session runs. */
export const MAIN_PRESET = 'discipline-whale'

/** Title of the main session in the session list. */
export const MAIN_TITLE = '自律鲸鱼'

/** The first turn of a new main session. */
export const WAKE_PROMPT = [
  '【唤醒】自律鲸鱼主会话已建立，工作目录是你自己的 home。',
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
    `【启动检查】DeepSeek Harness 重启前有 ${checkpoints.length} 条派工没有完成回报：`,
    ...lines,
    '',
    '请结合你的会话记录，用一句话说明每条派工原本在做什么，然后用 ask_user 让用户为每条派工选择：恢复 / 放弃 / 稍后再说。',
    '按用户的选择调用 resume_dispatch（恢复）或 abandon_dispatch（放弃）；选「稍后再说」的保持原样，下次启动会再次提醒。',
  ].join('\n')
}

export const name = 'discipline-whale-home'

function statePath(homeDir) {
  return join(dataDir(homeDir), STATE_FILENAME)
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

/** Create the whale's home directory; returns its absolute path. */
export async function ensureHome(homeDir = storeRoot()) {
  const path = whaleHomeDir(homeDir)
  await mkdir(path, { recursive: true })
  return path
}

const isSessionId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)

/** Create a main session in the home, wake it with its first turn, record it. */
export async function createMainSession(sessionController) {
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

/** The route handler, bound to the Host's session controller. */
export function homeHandler(sessionController) {
  // One creation at a time: a second request joins the running one, so the
  // home never gets two main sessions from a double click.
  let creating = null
  return async function handleHomeRequest(request) {
    const headers = { 'cache-control': 'no-store' }
    try {
      if (request.method === 'POST') {
        if (creating === null) {
          creating = createMainSession(sessionController).finally(() => {
            creating = null
          })
        }
        await creating
      }
      const home = await ensureHome()
      const { mainSessionId } = await readState()
      return Response.json({ home, mainSessionId: isSessionId(mainSessionId) ? mainSessionId : null }, { headers })
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
      fetch: homeHandler(c.sessionController),
    })
  })
}
