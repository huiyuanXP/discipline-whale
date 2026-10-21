/**
 * discipline-whale — assemble one preset's system prompt, without a Host.
 *
 * The dispatch discipline lives in `cordis.patch.yml` as the preset's persona
 * prefix. A YAML string that looks right proves nothing: the question worth
 * answering is what the model actually receives. This module answers it by
 * replaying the composition the Host performs:
 *
 *   1. parse the patch list with the same YAML dialect the Loader uses (`!!js`
 *      scalars included),
 *   2. find the preset entry by its config id,
 *   3. mount `@deepseek-ai/dsh-system-prompt` on the host plane, and the preset's
 *      own `plugins` list — including the `@deepseek-ai/dsh-persona` row — inside
 *      a `dsh-scope` scope, which is how `agent-preset-registry` mounts a preset,
 *   4. assemble for that scope and render the prompt text.
 *
 * The scoping is not a detail: `dsh-persona` shadows the deployment persona in
 * the scope it is mounted in. Mounted globally it would collide; mounted in the
 * preset scope, one preset's persona cannot leak into another's. Step 3 therefore
 * verifies the isolation the design claims, not just the string's presence.
 *
 * Used by `test/contract.mjs` (ok 23). Not part of the plugin's runtime surface.
 *
 * Run it directly to print the composed prompt:
 *
 *   node prompt-probe.mjs discipline-whale
 *
 * @module discipline-whale/prompt-probe
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PATCH = join(HERE, 'cordis.patch.yml')

/**
 * Where the Host's own packages live.
 *
 * A plugin installed into a profile resolves `@deepseek-ai/*` from the profile's
 * node_modules, so the probe must use the same installation. `DSH_INSTALL` can
 * point it at a checkout; otherwise the npx cache the running GUI was started
 * from is used.
 */
const INSTALL = process.env.DSH_INSTALL
  ?? '/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules'

const moduleUrl = (specifier) => new URL(`file://${join(INSTALL, specifier)}`).href

let hostModules

/** Load the Host packages once; every probe run shares them. */
async function loadHostModules() {
  hostModules ??= Promise.all([
    import(moduleUrl('@deepseek-ai/cordis/lib/index.js')),
    import(moduleUrl('@deepseek-ai/dsh-system-prompt/lib/index.js')),
    import(moduleUrl('@deepseek-ai/dsh-scope/lib/index.js')),
    import(moduleUrl('@deepseek-ai/dsh-persona/lib/index.js')),
    import(moduleUrl('js-yaml/index.js')),
  ]).then(([cordis, systemPrompt, scope, persona, yaml]) => ({
    Context: cordis.Context,
    // `dsh-system-prompt` registers the persona section itself, so a probe that
    // mounted it globally and then added a persona would collide. The real Host
    // has the same shape — global registry, scoped preset persona.
    SystemPrompt: systemPrompt.SystemPrompt,
    renderPrompt: systemPrompt.renderPrompt,
    createScope: scope.createScope,
    persona,
    yaml: yaml.default ?? yaml,
  }))
  return hostModules
}

/**
 * Parse the bundle's patch list with the Loader's YAML dialect.
 *
 * `!!js` is a custom scalar in `dsh-app-boot` (`entryListSchema`), so a plain
 * `DEFAULT_SCHEMA` load refuses the worker preset's platform-gated shell rows.
 * Registering the same tag keeps this parser honest about the real file rather
 * than about a cleaned-up copy of it.
 */
function parsePatches(yaml, text) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  return yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([JsExpr]) }) ?? []
}

/** Every entry a patch list inserts, flattened. */
function insertedEntries(patches) {
  return patches.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []))
}

/** The declared `plugins` list of one agent preset, by preset id. */
export function presetPlugins(patches, presetId) {
  const preset = insertedEntries(patches).find(
    (entry) => entry?.config?.id === presetId && Array.isArray(entry.config.plugins),
  )
  if (preset === undefined) throw new Error(`no agent preset "${presetId}" in the patch list`)
  return preset.config.plugins
}

/**
 * Assemble the rendered system prompt for one preset.
 *
 * Only the rows this probe understands are mounted (the persona row and the
 * prompt-participating context rows); tool rows are configuration for tools and
 * contribute no prompt text, so replaying them would add failure modes without
 * adding evidence.
 *
 * @param {string} presetId - e.g. `discipline-whale`.
 * @param {{patchPath?: string}} [options] - alternate patch file, for tests.
 * @returns {Promise<string>} the prompt text the model would receive.
 */
export async function assemblePresetPrompt(presetId, options = {}) {
  const { Context, SystemPrompt, renderPrompt, createScope, persona, yaml } =
    await loadHostModules()
  const patches = parsePatches(yaml, await readFile(options.patchPath ?? DEFAULT_PATCH, 'utf8'))
  const rows = presetPlugins(patches, presetId)

  const app = new Context()
  const systemPrompt = new SystemPrompt(app, {})

  // A preset is mounted into its own scope by `agent-preset-registry`
  // (`createScope(this.owner, key)` + `mountPreset`), which is what makes its
  // persona a shadow rather than a global registration.
  const scope = createScope(app, `preset:${presetId}`)
  try {
    // This plugin's own prompt-contributing row. `adhd.js` is imported lazily
    // and by relative path: the probe is shipped with the package, and a run
    // against a patch file that names the row but cannot load it should still
    // assemble a prompt (it simply proves less) rather than crash the probe.
    const localRows = new Map()
    try {
      const { apply: brevityApply } = await import('./adhd.js')
      localRows.set('discipline-whale/brevity', brevityApply)
      localRows.set('discipline-whale/adhd', brevityApply)
    } catch {
      // No local row available; the preset still assembles its persona.
    }
    for (const row of rows) {
      const rowName = row?.name
      const config = row?.config ?? {}
      if (rowName === '@deepseek-ai/dsh-persona') {
        const fiber = scope.ctx.plugin(
          { name: 'persona', inject: ['systemPrompt'], apply: persona.apply },
          { prefix: config.prefix ?? '', suffix: config.suffix ?? '' },
        )
        await fiber.await()
      } else if (localRows.has(rowName)) {
        // The brevity row declares `skills` as an optional dependency, so it
        // mounts here with only the prompt registry present. That is the shape
        // the scope test needs: its section lands in this preset's layer.
        const fiber = scope.ctx.plugin(
          { name: rowName, inject: ['systemPrompt'], apply: localRows.get(rowName) },
          config,
        )
        await fiber.await()
      }
      // `time-context` and `agent-instructions` add runtime contexts or read
      // files; neither contributes persona text, and both need a Host. Skipped
      // on purpose rather than silently stubbed.
    }
    const assembly = await systemPrompt.assemble({ scope: `preset:${presetId}` })
    return renderPrompt(assembly)
  } finally {
    await scope.dispose()
  }
}

/** Print one preset's assembled prompt (CLI entry point). */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const presetId = process.argv[2] ?? 'discipline-whale'
  process.stdout.write(`${await assemblePresetPrompt(presetId)}\n`)
}
