/**
 * Legacy workspace colors migrate only on explicit request — never silently.
 *
 * THE PROBLEM. `workspaces.json` already holds colors a user picked from the
 * old saturated palette; two workspaces on this machine are `#EF4444`, which is
 * the harness's warning red and is no longer allowed to identify a workspace.
 * A palette change must therefore answer a question the code cannot answer for
 * the user: what happens to a color somebody already chose?
 *
 * THE ANSWER THIS FILE PINS. Nothing happens on its own. The colors stay in
 * the file, still render on their folder, and are only rewritten when the user
 * runs the migration (or picks a new color in the menu). The migration:
 *
 *   - is dry-run by default; `--apply` is required to write,
 *   - maps each legacy palette slot to the Morandi slot in the same position,
 *     so a blue workspace stays blue rather than becoming a random hue,
 *   - never touches a custom hex the user typed (only exact legacy palette
 *     members are candidates), so a hand-picked color is not "migrated" away,
 *   - reports what it would do before doing it, and what it did after.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PALETTE, LEGACY_PALETTE, morandiForLegacy, planColorMigration } from '../activity.js'

const root = await mkdtemp(join(tmpdir(), 'dw-migrate-'))
let failures = 0
const check = (name, run) => {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

check('the legacy palette is the old eight, and Morandi is a positional match', () => {
  assert.equal(LEGACY_PALETTE.length, 8)
  assert.equal(PALETTE.length, 8)
  // Positional, so "blue" stays blue: the mapping is by slot, not by distance.
  assert.equal(morandiForLegacy('#3B82F6'), PALETTE[0])
  assert.equal(morandiForLegacy('#EF4444'), PALETTE[3], 'the red slot becomes the Morandi slot in the same position')
  assert.equal(morandiForLegacy('#F59E0B'), PALETTE[2])
})

check('a custom color the user typed is not a migration candidate', () => {
  assert.equal(morandiForLegacy('#abcdef'), null, 'a custom hex has no legacy slot')
  assert.equal(morandiForLegacy('#EF4445'), null, 'a near-miss is not a palette member')
  assert.equal(morandiForLegacy(undefined), null)
  assert.equal(morandiForLegacy('not-a-color'), null)
})

check('the plan lists every legacy workspace and changes nothing by itself', async () => {
  const cards = {
    'ws-whale': { color: '#EF4444', intro: 'a', updatedAt: '2026-10-23' },
    'ws-skiplec': { color: '#EF4444', intro: 'b', updatedAt: '2026-10-22' },
    'ws-custom': { color: '#123456', intro: 'c', updatedAt: '2026-10-21' },
    'ws-morandi': { color: PALETTE[5], intro: 'd', updatedAt: '2026-10-20' },
    'ws-none': { intro: 'e', updatedAt: '2026-10-19' },
  }
  const plan = planColorMigration(cards)
  const byId = Object.fromEntries(plan.map((row) => [row.id, row]))
  assert.equal(plan.length, 2, 'only the two legacy reds are candidates')
  assert.deepEqual(byId['ws-whale'], { id: 'ws-whale', from: '#EF4444', to: PALETTE[3] })
  assert.deepEqual(byId['ws-skiplec'], { id: 'ws-skiplec', from: '#EF4444', to: PALETTE[3] })
  assert.equal(byId['ws-custom'], undefined, 'a custom hex is left alone')
  assert.equal(byId['ws-morandi'], undefined, 'a current color is left alone')
  assert.equal(byId['ws-none'], undefined, 'a workspace with no color is left alone')
})

check('the same plan is returned for an empty or absent card map', () => {
  assert.deepEqual(planColorMigration({}), [])
  assert.deepEqual(planColorMigration(undefined), [])
})

check('applying writes only the candidates, and leaves every other card byte-identical', async () => {
  const home = await mkdtemp(join(root, 'h-'))
  const dir = join(home, 'discipline-whale', 'memory-state')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'workspaces.json')
  const before = {
    'ws-whale': { color: '#EF4444', intro: 'a', updatedAt: '2026-10-23' },
    'ws-custom': { color: '#123456', intro: 'c', updatedAt: '2026-10-21' },
  }
  await writeFile(file, `${JSON.stringify(before, null, 2)}\n`)

  const { applyColorMigration } = await import('../activity.js')
  const dry = await applyColorMigration(home, { apply: false })
  assert.equal(dry.changed.length, 1)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), before, 'a dry run writes nothing')

  const real = await applyColorMigration(home, { apply: true })
  assert.equal(real.changed.length, 1)
  const after = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(after['ws-whale'].color, PALETTE[3], 'the legacy red moved to the Morandi slot')
  assert.equal(after['ws-whale'].intro, 'a', 'the rest of the card survives')
  assert.deepEqual(after['ws-custom'], before['ws-custom'], 'a custom color is untouched')
})

if (failures > 0) {
  console.error(`\n${failures} migration check(s) failed.`)
  process.exit(1)
}
console.log('\nLegacy colors migrate only on request, positionally, and never silently.')
