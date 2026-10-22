/**
 * Main-session tool whitelist — the decisions, proved against a real registry.
 *
 * WHAT IS BEING PROVEN, and why each part needs a real `ToolRuntime`:
 *
 *   1. THE CUT LIST IS HONOURED. The heavy document/media tools (PPT, Word,
 *      Excel, video, TTS) must be absent from the main preset's visible
 *      surface. A fake registry that stores whatever `apply()` passes in would
 *      prove nothing — `tools.restrict()` is the mechanism, and only the real
 *      service implements it.
 *
 *   2. DYNAMIC UI STILL WORKS. The user's requirement was explicit: the main
 *      session must keep its own drawing board. So the `render_*` family,
 *      `inspect_ui` / `patch_ui` / `update_ui` / `validate_ui` and `ui_catalog`
 *      must remain visible AND still be callable — visible-but-broken would
 *      satisfy a membership check and fail the user.
 *
 *   3. OTHER SESSIONS ARE UNTOUCHED. A sibling scope (a plain coding session)
 *      and a worker-shaped scope must keep the exact tool surface they had
 *      before. This is checked in the same process, against the same registry,
 *      which is the only way to catch a restriction that leaked.
 *
 *   4. THE RESTRICTION IS SCOPE-ONLY. `tools.restrict()` on an unscoped context
 *      throws by design (`dsh-tools`: "a context-global restriction would mask
 *      every agent"). The whitelist must therefore only ever be installed from
 *      inside the preset row.
 *
 * Usage: node test/tool-whitelist.mjs
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

const INSTALL = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'

const moduleUrl = (specifier) => new URL(`file://${join(INSTALL, specifier)}`).href

const { Context } = await import(moduleUrl('@deepseek-ai/cordis/lib/index.js'))
const { createScope, scopeOf } = await import(moduleUrl('@deepseek-ai/dsh-scope/lib/index.js'))
const { SystemPrompt } = await import(moduleUrl('@deepseek-ai/dsh-system-prompt/lib/index.js'))
const toolsModule = await import(moduleUrl('@deepseek-ai/dsh-tools/lib/index.js'))

const ToolRuntime = toolsModule.default ?? toolsModule.ToolRuntime
const { defineTool } = toolsModule

const { HOST_TOOL_DENY, MAIN_TOOL_ALLOW_EXTRA, installToolWhitelist, resolveToolWhitelist } =
  await import('../main.js')

/** A registry-ready tool; `defineTool` requires output.render. */
const makeTool = (name) => defineTool({
  name,
  description: `fixture tool ${name}`,
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: `${name} ok` }] },
  async execute() { return null },
})

/**
 * The Host surface a real profile presents: the tools the user named for
 * removal, the Dynamic UI family, the dispatch family, and some neutral ones.
 * Names are the real ones so the deny list is exercised verbatim.
 */
const HEAVY_DOC_MEDIA = [
  'ppt_create', 'ppt_read',
  'word_create', 'word_read', 'word_update',
  'excel_create', 'excel_read', 'excel_update',
  'render_video', 'preview_video', 'process_video', 'inspect_video',
  'synthesize_voice',
]

const DYNAMIC_UI = [
  'render_ui', 'render_canvas', 'render_scene', 'render_text', 'render_mechanism',
  'inspect_ui', 'patch_ui', 'update_ui', 'validate_ui',
  'ui_catalog',
]

/** Tools the main session keeps for its own work. */
const KEEP_ALWAYS = [
  'ask_user_question', 'read', 'grep', 'glob', 'read_image',
  'web_search', 'web_fetch', 'todo_write', 'skill', 'present',
  'remember', 'update_instructions', 'working_directory',
]

/**
 * Code-intelligence tools. NOT part of this change: the mandate covered
 * document/media producers, and removing a developer tool the user did not name
 * is their call, not this row's. They stay, and the report lists them as
 * candidates with their token cost.
 */
const CODE_INTEL = ['lsp_format', 'lsp_rename', 'lsp_symbols', 'lsp_diagnostics']

/** Everything the registry will hold, inherited by every scope. */
const HOST_SURFACE = [
  ...HEAVY_DOC_MEDIA,
  ...DYNAMIC_UI,
  ...KEEP_ALWAYS,
  ...CODE_INTEL,
]

/** Workspace-root resolution: main.js resolves nothing here. */
const OWN_TOOLS = [
  'dispatch_task', 'send_to_session', 'read_report', 'list_dispatches',
  'list_workspaces', 'resume_dispatch', 'abandon_dispatch',
]

/**
 * Build a real registry with the Host surface, then mount one "preset" scope.
 *
 * @param {{whitelist?: boolean}} options - install the whitelist row or not.
 * @returns {Promise<{tools: any, main: any, sibling: any, ownNames: string[]}>}
 */
async function harness(options = {}) {
  const app = new Context()
  new SystemPrompt(app, {})
  const tools = new ToolRuntime(app, {})

  for (const name of HOST_SURFACE) tools.register(makeTool(name))

  // The main preset: its own dispatch tools (preset-scope, hence exempt from
  // its own restriction) plus — optionally — the whitelist row.
  const main = createScope(app, {})
  const mainRow = main.ctx.plugin({
    name: 'main-preset',
    inject: ['tools'],
    apply(ctx) {
      for (const name of OWN_TOOLS) ctx.tools.register(makeTool(name))
      if (options.whitelist === true) installToolWhitelist(ctx, resolveToolWhitelist({}))
    },
  })
  await mainRow.await()

  // A sibling scope: a plain coding session. It registers nothing of its own and
  // must see the full Host surface.
  const sibling = createScope(app, {})

  // A worker-shaped scope: registers its own report tool, keeps everything else.
  const worker = createScope(app, {})
  const workerRow = worker.ctx.plugin({
    name: 'worker-preset',
    inject: ['tools'],
    apply(ctx) { ctx.tools.register(makeTool('report_to_main')) },
  })
  await workerRow.await()

  return { tools, main, sibling, worker }
}

/** Visible tool names for a scope, through the public resolver. */
function visible(tools, scope) {
  return new Set(tools.view(scopeOf(scope)).visible.keys())
}

// ---------------------------------------------------------------------------
// 1. The cut list, against a real registry
// ---------------------------------------------------------------------------

test('the heavy document/media tools are gone from the main preset', async () => {
  const { tools, main } = await harness({ whitelist: true })
  const names = visible(tools, main.ctx)

  for (const name of HEAVY_DOC_MEDIA) {
    assert.ok(!names.has(name), `${name} must not be visible to the main session`)
  }
  // Spelled out once as the user's own list, so a future edit to the deny list
  // cannot quietly reintroduce one of these.
  const cut = [
    'ppt_create', 'ppt_read',
    'word_create', 'word_read', 'word_update',
    'excel_create', 'excel_read', 'excel_update',
    'render_video', 'preview_video', 'process_video', 'inspect_video',
    'synthesize_voice',
  ]
  for (const name of cut) assert.ok(!names.has(name), `${name} must be cut`)
})

test('the Dynamic UI family stays visible to the main session', async () => {
  const { tools, main } = await harness({ whitelist: true })
  const names = visible(tools, main.ctx)

  for (const name of DYNAMIC_UI) {
    assert.ok(names.has(name), `${name} must stay visible — the main session draws its own UI`)
  }
})

test('the dispatch tools stay visible even though they are preset-scope', async () => {
  const { tools, main } = await harness({ whitelist: true })
  const names = visible(tools, main.ctx)
  for (const name of OWN_TOOLS) {
    assert.ok(names.has(name), `${name} must survive the restriction (own-layer exemption)`)
  }
})

test('the tool the main session actually uses for its own work survives', async () => {
  const { tools, main } = await harness({ whitelist: true })
  const names = visible(tools, main.ctx)
  for (const name of KEEP_ALWAYS) {
    assert.ok(names.has(name), `${name} must stay visible`)
  }
  // Kept deliberately: cutting developer tooling was not in this mandate.
  for (const name of CODE_INTEL) {
    assert.ok(names.has(name), `${name} is out of scope for this change and must remain`)
  }
})

// ---------------------------------------------------------------------------
// 2. Dynamic UI is not merely visible — it still executes
// ---------------------------------------------------------------------------

test('a retained render tool still executes and returns its own output', async () => {
  const { tools, main } = await harness({ whitelist: true })
  const visibleNames = visible(tools, main.ctx)

  // Take every retained UI tool and run it, so "visible but dead" cannot pass.
  for (const name of DYNAMIC_UI) {
    assert.ok(visibleNames.has(name), `precondition: ${name} is visible`)
    const entry = tools.view(scopeOf(main.ctx)).visible.get(name)
    assert.ok(entry !== undefined, `${name} must resolve to a definition`)
    const result = await entry.execute({}, { signal: new AbortController().signal })
    const rendered = entry.output.render({}, result)
    assert.equal(rendered[0].text, `${name} ok`, `${name} must still execute and render`)
  }
})

test('a cut tool is not resolvable at all, so a stale call cannot succeed', async () => {
  const { tools, main } = await harness({ whitelist: true })
  const view = tools.view(scopeOf(main.ctx))
  for (const name of HEAVY_DOC_MEDIA) {
    assert.equal(view.visible.get(name), undefined, `${name} must not resolve`)
  }
})

// ---------------------------------------------------------------------------
// 3. Sibling and worker scopes are untouched
// ---------------------------------------------------------------------------

test('a sibling coding session keeps the entire Host surface', async () => {
  const withWhitelist = await harness({ whitelist: true })
  const withoutWhitelist = await harness({ whitelist: false })

  const after = visible(withWhitelist.tools, withWhitelist.sibling.ctx)
  const before = visible(withoutWhitelist.tools, withoutWhitelist.sibling.ctx)

  assert.deepEqual([...after].sort(), [...before].sort(), 'the sibling scope must be byte-identical before/after')
  for (const name of HEAVY_DOC_MEDIA) {
    assert.ok(after.has(name), `${name} must remain available to a coding session`)
  }
  for (const name of DYNAMIC_UI) {
    assert.ok(after.has(name), `${name} must remain available to a coding session`)
  }
})

test('a worker-shaped session keeps the entire Host surface plus its report tool', async () => {
  const withWhitelist = await harness({ whitelist: true })
  const withoutWhitelist = await harness({ whitelist: false })

  const after = visible(withWhitelist.tools, withWhitelist.worker.ctx)
  const before = visible(withoutWhitelist.tools, withoutWhitelist.worker.ctx)

  assert.deepEqual([...after].sort(), [...before].sort(), 'the worker scope must be byte-identical before/after')
  assert.ok(after.has('report_to_main'))
  for (const name of HEAVY_DOC_MEDIA) assert.ok(after.has(name))
})

test('the global view is untouched — no restriction ever lands there', async () => {
  const { tools } = await harness({ whitelist: true })
  const global = new Set(tools.view(undefined).visible.keys())
  for (const name of HOST_SURFACE) assert.ok(global.has(name), `${name} must survive in the global view`)
})

// ---------------------------------------------------------------------------
// 4. The seam itself
// ---------------------------------------------------------------------------

test('restrict() on an unscoped context throws, so the whitelist cannot leak globally', () => {
  const app = new Context()
  new SystemPrompt(app, {})
  const tools = new ToolRuntime(app, {})
  assert.throws(() => tools.restrict({ deny: ['read'] }), /requires a scoped context/)
})

test('the deny list has no overlap with the allow-extra list', () => {
  const deny = new Set(HOST_TOOL_DENY)
  for (const name of MAIN_TOOL_ALLOW_EXTRA) {
    assert.ok(!deny.has(name), `${name} is both kept and cut`)
  }
})

test('an unknown tool name in the deny list is skipped, not fatal', async () => {
  // A profile without (say) the office bundle must still mount. The install path
  // intersects the declared deny list with what is actually restrictable.
  const app = new Context()
  new SystemPrompt(app, {})
  const tools = new ToolRuntime(app, {})
  tools.register(makeTool('read'))
  const scope = createScope(app, {})
  const row = scope.ctx.plugin({
    name: 'thin-preset',
    inject: ['tools'],
    apply(ctx) {
      installToolWhitelist(ctx, { deny: ['read', 'a_tool_this_profile_never_installed'] })
    },
  })
  await row.await()
  const names = visible(tools, scope.ctx)
  assert.ok(!names.has('read'), 'the known name is still restricted')
})

test('an empty whitelist config leaves the surface exactly as it was', async () => {
  const { tools, main } = await harness({ whitelist: false })
  const names = visible(tools, main.ctx)
  for (const name of HOST_SURFACE) assert.ok(names.has(name), `${name} must be visible with no whitelist`)
})
