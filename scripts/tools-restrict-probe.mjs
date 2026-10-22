/**
 * tools-restrict-probe — does `tools.restrict()` isolate ONE preset's tool
 * surface from every other session, without touching DSH itself?
 *
 * WHY A PROBE AND NOT A CLAIM: the answer decides whether the user needs a DSH
 * patch or just a plugin change. Reading `dsh-tools` says a restriction lives in
 * a scope LAYER and filters only what that scope INHERITS; the production caller
 * (`dsh-subagent/lib/index.js:395`) uses exactly that. Neither is proof that a
 * preset mount behaves the same way, because a preset is mounted into its own
 * `createScope()` realm with its own plugin tree.
 *
 * So this probe builds the real pieces and asserts the four properties the
 * design depends on:
 *   1. a scope's restriction hides an inherited (host) tool from that scope,
 *   2. the same restriction leaves ANOTHER scope's view untouched,
 *   3. the global view is untouched,
 *   4. a tool the scope registers ITSELF survives its own restriction —
 *      which is why the whale's dispatch tools cannot be filtered out by a
 *      whitelist that names only host tools.
 *
 * Usage: node scripts/tools-restrict-probe.mjs
 */

import assert from 'node:assert'
import { join } from 'node:path'

const INSTALL = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'

const moduleUrl = (specifier) => new URL(`file://${join(INSTALL, specifier)}`).href

const { Context } = await import(moduleUrl('@deepseek-ai/cordis/lib/index.js'))
const { createScope, scopeOf } = await import(moduleUrl('@deepseek-ai/dsh-scope/lib/index.js'))
const { SystemPrompt } = await import(moduleUrl('@deepseek-ai/dsh-system-prompt/lib/index.js'))
const toolsModule = await import(moduleUrl('@deepseek-ai/dsh-tools/lib/index.js'))
const ToolRuntime = toolsModule.default ?? toolsModule.ToolRuntime
const defineTool = toolsModule.defineTool

/**
 * A tool definition complete enough for the registry to accept it.
 *
 * `defineTool` requires `output.render` — a raw object literal without it throws
 * inside the registry, which is why this goes through `defineTool` rather than a
 * hand-rolled shape.
 */
const makeTool = (name) => defineTool({
  name,
  description: `probe tool ${name}`,
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'ok' }] },
  async execute() { return null },
})

const results = []
const record = (name, detail) => results.push({ name, detail })

// ---------------------------------------------------------------------------
// Host plane: two inherited tools every session would otherwise see.
// `ToolRuntime` injects `systemPrompt`, so both services are constructed the
// way the Host composes them rather than stubbed.
// ---------------------------------------------------------------------------
const app = new Context()
new SystemPrompt(app, {})
const hostTools = new ToolRuntime(app, {})

hostTools.register(makeTool('host_read'))
hostTools.register(makeTool('host_shell'))

const globalView = hostTools.view(undefined)
record('host registers inherited tools', [...globalView.visible?.keys?.() ?? []].join(',') || '(view shape differs)')

// ---------------------------------------------------------------------------
// Two sibling scopes, the way two presets are mounted.
// ---------------------------------------------------------------------------
// Each scope registers a tool of its OWN (the whale registers its dispatch
// tools this way — see discipline-whale/main.js:1177-1183). Registration and
// restriction both happen INSIDE a plugin body mounted on the scope, which is
// the shape a preset row actually has: `restrict()` reached through the raw
// scoped context registers but does not land in that layer, so a probe calling
// it from outside proves nothing about a preset.
async function mountScope() {
  const scope = createScope(app, {})
  const row = scope.ctx.plugin({
    name: 'probe-row',
    inject: ['tools'],
    apply(ctx) {
      ctx.tools.register(makeTool('own_dispatch'))
      // Park the restriction disposer on the scope so the caller can apply it
      // AFTER the "before" reading — the comparison is the point.
      scope.restrictLate = (filter) => ctx.tools.restrict(filter)
    },
  })
  await row.await()
  return scope
}

const scopeA = await mountScope()
const scopeB = await mountScope()

/** Visible tool names for one scope, through the public resolver. */
function visible(scope) {
  const view = hostTools.view(scopeOf(scope))
  return new Set(view.visible?.keys?.() ?? [])
}

const beforeA = visible(scopeA.ctx)
const beforeB = visible(scopeB.ctx)
record('scope A before restrict', [...beforeA].sort().join(',') || '(empty)')
record('scope B before restrict', [...beforeB].sort().join(',') || '(empty)')

// The whitelist, applied from inside A's row — the shape a preset row has.
scopeA.restrictLate({ allow: ['host_read'] })

// ---------------------------------------------------------------------------
// The whitelist: keep only what a dispatch-only main session needs.
//
// `allow` may name only INHERITED (host) tools. `restrict()` validates every
// name against `restrictableNames`, which is exactly the inherited surface; a
// scope-local tool in the allow list is rejected as an unknown global tool.
// Found the hard way, and the reason this list names `host_read` alone.
// Consequence for the real preset: the whale's own dispatch tools never need to
// appear here — property (4) shows they survive regardless.
// ---------------------------------------------------------------------------
const afterA = visible(scopeA.ctx)
const afterB = visible(scopeB.ctx)
const afterGlobal = new Set(hostTools.view(undefined).visible?.keys?.() ?? [])

record('scope A after restrict', [...afterA].sort().join(',') || '(empty)')
record('scope B after restrict', [...afterB].sort().join(',') || '(empty)')
record('host view after restrict', [...afterGlobal].sort().join(',') || '(empty)')

// ---------------------------------------------------------------------------
// The four properties.
// ---------------------------------------------------------------------------
// Property (1): the inherited surface is cut down to the allow list.
assert.ok(afterA.has('host_read'), 'the allow-listed host tool must stay visible')
assert.ok(!afterA.has('host_shell'), 'a host tool outside the allow list must be hidden')
// Property (4): the scope's OWN registrations are exempt from its restriction.
assert.ok(afterA.has('own_dispatch'), 'a tool the scope registers itself survives its own restriction')

assert.ok(afterB.has('host_read'), 'a sibling scope must be untouched')
assert.ok(afterB.has('host_shell'), 'a sibling scope must be untouched')

assert.ok(afterGlobal.has('host_read'), 'the global view must be untouched')
assert.ok(afterGlobal.has('host_shell'), 'the global view must be untouched')

console.log('tools.restrict() isolation probe — all properties hold\n')
for (const r of results) console.log(`  ${r.name.padEnd(28)} ${r.detail}`)
console.log('\nverdict: per-preset tool isolation works through a scoped context;')
console.log('         no change to DSH itself is required.')
console.log('         property 4 is why the whale keeps dispatch_task/read_report')
console.log('         even when the whitelist names only host tools.')
