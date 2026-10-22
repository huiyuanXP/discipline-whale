/**
 * discipline-whale — HTTP routes the web client reads for workspace colors and tags.
 *
 *   GET  /api/discipline-whale/memory/workspaces   every workspace with its color and intro
 *   POST /api/discipline-whale/memory/workspaces   { id, color } sets one workspace's color
 *   GET  /api/discipline-whale/memory/tags?sessionId=<main>
 *                                                  the main Session's tagged user turns
 *   GET  /api/discipline-whale/memory/dispatched   worker Session id → workspace id
 *   GET  /api/discipline-whale/memory/reports      report id → the workspace that wrote it
 *
 * Every response is JSON with `cache-control: no-store`.
 *
 * @module discipline-whale/memory-routes
 */

import { defaultColor, readTags, readWorkspaceCards, setWorkspaceColor } from './activity.js'
import { listDispatchCheckpoints } from './checkpoint.js'
import { listReports, storeRoot } from './store.js'

export const MEMORY_WORKSPACES_ROUTE = '/api/discipline-whale/memory/workspaces'
export const MEMORY_TAGS_ROUTE = '/api/discipline-whale/memory/tags'
export const MEMORY_DISPATCHED_ROUTE = '/api/discipline-whale/memory/dispatched'
export const MEMORY_REPORTS_ROUTE = '/api/discipline-whale/memory/reports'

/** The `report id: <id>` line every pushed report carries, and its id. */
const REPORT_ID_PATTERN = /\breport id:\s*(\S+)/i

/**
 * The report id inside one pushed report message, or `null`.
 *
 * The pushed text is the push contract the worker tool writes, so the id is
 * read from the same line a human reads. Anything else is not a report.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function reportIdOf(text) {
  if (typeof text !== 'string' || text === '') return null
  const match = REPORT_ID_PATTERN.exec(text)
  return match === null ? null : match[1]
}

const HEADERS = { 'cache-control': 'no-store' }

/** One workspace as the client sees it. */
function workspaceView(workspace, card) {
  return {
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    color: card?.color ?? defaultColor(String(workspace.id)),
    intro: card?.intro ?? '',
    updatedAt: card?.updatedAt ?? null,
  }
}

/**
 * dispatchId → { workerSessionId, workspaceId } for every dispatch the store knows:
 * live checkpoints plus every written report.
 */
export async function dispatchIndex(root, workspaces) {
  const index = new Map()
  for (const record of await listDispatchCheckpoints(root).catch(() => [])) {
    index.set(record.dispatchId, { workerSessionId: record.workerSessionId, workspaceId: String(record.workspaceId) })
  }
  for (const workspace of workspaces) {
    for (const report of await listReports(root, workspace.id).catch(() => [])) {
      if (report?.dispatchId === undefined || report?.workerSessionId === undefined) continue
      index.set(report.dispatchId, { workerSessionId: report.workerSessionId, workspaceId: String(report.workspaceId) })
    }
  }
  return index
}

/**
 * The report written under `reportId`, or `undefined`.
 *
 * Reports are stored per workspace (`reports/<workspace>/<id>.json`), so the
 * id alone does not name a path; each workspace's folder is scanned. A report
 * that a worker wrote but never delivered is still found here — which is the
 * point: the row it pushed is the question, and the file is the answer.
 */
export async function findReport(root, workspaces, reportId) {
  const wanted = String(reportId)
  for (const workspace of workspaces) {
    for (const report of await listReports(root, workspace.id).catch(() => [])) {
      if (String(report?.id) === wanted) return report
    }
  }
  return undefined
}

/**
 * The route handler.
 *
 * @param {object} deps - `workspaces()` lists the registry; `root()` returns the DSH root.
 */
export function memoryRoutesHandler({ workspaces = () => [], root = storeRoot } = {}) {
  return async function handleMemoryRequest(request) {
    try {
      const url = new URL(request.url)
      const listed = workspaces()
      if (url.pathname === MEMORY_WORKSPACES_ROUTE) {
        if (request.method === 'POST') {
          let body
          try {
            body = await request.json()
          } catch {
            return Response.json({ error: 'the body must be JSON { id, color }' }, { status: 400, headers: HEADERS })
          }
          const workspace = listed.find((candidate) => String(candidate.id) === String(body?.id))
          if (workspace === undefined) {
            return Response.json({ error: `no registered workspace "${body?.id}"` }, { status: 400, headers: HEADERS })
          }
          try {
            const card = await setWorkspaceColor(root(), String(workspace.id), body?.color)
            return Response.json({ workspace: workspaceView(workspace, card) }, { headers: HEADERS })
          } catch (error) {
            return Response.json({ error: String(error?.message ?? error) }, { status: 400, headers: HEADERS })
          }
        }
        const cards = await readWorkspaceCards(root())
        return Response.json(
          { workspaces: listed.map((workspace) => workspaceView(workspace, cards[String(workspace.id)])) },
          { headers: HEADERS },
        )
      }
      if (url.pathname === MEMORY_TAGS_ROUTE) {
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId === '') {
          return Response.json({ error: 'sessionId is required' }, { status: 400, headers: HEADERS })
        }
        const index = await dispatchIndex(root(), listed)
        const turns = (await readTags(root()))
          .filter((record) => record.sessionId === sessionId && record.workspaces.length > 0)
          .map((record) => {
            const sessions = {}
            for (const dispatchId of record.dispatches) {
              const target = index.get(dispatchId)
              if (target === undefined) continue
              const list = (sessions[target.workspaceId] ??= [])
              if (!list.includes(target.workerSessionId)) list.push(target.workerSessionId)
            }
            return { turn: record.turn, messageId: record.messageId ?? null, at: record.at, workspaces: record.workspaces, sessions }
          })
        return Response.json({ turns }, { headers: HEADERS })
      }
      if (url.pathname === MEMORY_DISPATCHED_ROUTE) {
        const sessions = {}
        for (const target of (await dispatchIndex(root(), listed)).values()) sessions[target.workerSessionId] = target.workspaceId
        return Response.json({ sessions }, { headers: HEADERS })
      }
      if (url.pathname === MEMORY_REPORTS_ROUTE) {
        // A pushed report is an ordinary user row in the transcript; the id in
        // its own text is the only durable handle on the workspace that wrote
        // it. A miss is a null answer, so the client can fall back to neutral.
        const reportId = url.searchParams.get('id')
        const found = reportId === null || reportId === '' ? undefined : await findReport(root(), listed, reportId)
        if (found === undefined) return Response.json({ report: null }, { headers: HEADERS })
        const cards = await readWorkspaceCards(root())
        const workspace = listed.find((candidate) => String(candidate.id) === String(found.workspaceId))
        const id = String(found.workspaceId)
        return Response.json(
          {
            report: {
              id: found.id,
              workspaceId: id,
              workspaceTitle: found.workspaceTitle ?? workspace?.title ?? null,
              color: cards[id]?.color ?? defaultColor(id),
            },
          },
          { headers: HEADERS },
        )
      }
      return Response.json({ error: 'not found' }, { status: 404, headers: HEADERS })
    } catch (error) {
      return Response.json({ error: String(error?.message ?? error) }, { status: 500, headers: HEADERS })
    }
  }
}

/** Register the four paths on the Host's web connection. */
export function registerMemoryRoutes(connection, deps = {}) {
  const handler = memoryRoutesHandler(deps)
  return Promise.all([
    connection.fetch.register({ path: MEMORY_WORKSPACES_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }),
    connection.fetch.register({ path: MEMORY_TAGS_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: handler }),
    connection.fetch.register({ path: MEMORY_DISPATCHED_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: handler }),
    connection.fetch.register({ path: MEMORY_REPORTS_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: handler }),
  ])
}
