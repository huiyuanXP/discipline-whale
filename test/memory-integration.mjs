/**
 * Integration checks for the memory modules wired together.
 *
 * The unit suites drive flush and dream through fake stores. This suite composes
 * the real store from memory.js and activity.js and runs the whole path:
 * remember → flush → Now rotation → dream → injection text.
 *
 * Run: node test/memory-integration.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readWorkspaceCards, setWorkspaceIntro } from '../activity.js'
import { collectNewDaily, dreamsLogPath, runDream, shouldDream } from '../dream.js'
import { readCursor, runFlush } from '../memory-flush.js'
import {
  appendDaily,
  listDailyDays,
  loadMemorySection,
  readDaily,
  readLayer,
  remember,
  replaceNow,
  writeLayer,
} from '../memory.js'

const store = {
  readLayer,
  writeLayer,
  appendDaily,
  readDaily,
  listDailyDays,
  replaceNow,
  readWorkspaceCards,
  setWorkspaceIntro,
}

const workspaces = [{ id: 'ws-blog', title: 'blog', path: '/tmp/blog' }]
const now = new Date(2026, 9, 21, 15, 0)
const day = '2026-10-21'
const source = 'session:main-1#t12'

const root = await mkdtemp(join(tmpdir(), 'whale-memory-integration-'))
try {
  await remember(root, { target: 'user', op: 'add', text: 'Prefer 先给结论再给细节', source: 'user', now })
  await remember(root, { target: 'memory', op: 'add', text: '主会话没有写权限，落盘走插件 Node 侧', source: 'report:r-1', now })

  const first = await runFlush({
    homeDir: root,
    transcript: [
      { role: 'context', text: '# 我们正在做什么（按工作区，只列活跃的）…' },
      { role: 'user', text: '博客迁到 Astro，RSS 先做' },
      { role: 'tool', toolName: 'dispatch_task' },
      { role: 'assistant', text: '已派给 blog' },
    ],
    complete: async ({ user }) => {
      assert.ok(!user.includes('# 我们正在做什么'), 'injected context stays out of the flush prompt')
      return JSON.stringify({
        daily: [1, 2, 3, 4, 5].map((n) => ({ text: `观察 ${n}：博客迁移相关决定` })),
        user_now: ['Prefer 本周先把博客 RSS 做完'],
        workspace_intros: { 'ws-blog': '个人博客，正在迁移到 Astro，下一步做 RSS' },
      })
    },
    store,
    now,
    source,
    workspaces,
  })
  assert.deepEqual(
    { ok: first.ok, daily: first.daily, now: first.now, intros: first.intros },
    { ok: true, daily: 5, now: 1, intros: 1 },
  )
  assert.equal((await readDaily(root, day)).length, 5)
  assert.match((await readLayer(root, 'user')).text, /本周先把博客 RSS 做完/)
  assert.match((await readWorkspaceCards(root))['ws-blog'].intro, /正在迁移到 Astro/)
  assert.equal((await readCursor(root)).lastFlushAt, now.toISOString())
  console.log('ok 1 — flush writes daily, Now and the workspace intro through the real store')

  const second = await runFlush({
    homeDir: root,
    transcript: [{ role: 'user', text: '评论区下周再说' }],
    complete: async () => JSON.stringify({ daily: [], user_now: ['Prefer 评论区推迟到下周'], workspace_intros: {} }),
    store,
    now,
    source,
    workspaces,
  })
  assert.equal(second.ok, true)
  const rotated = await readDaily(root, day)
  assert.equal(rotated.length, 6, 'the previous Now entry rotates into the daily note')
  assert.match(rotated[5].text, /本周先把博客 RSS 做完/)
  console.log('ok 2 — a second flush rotates the previous Now into the daily note')

  const pending = await collectNewDaily(root, store, await readCursor(root))
  assert.equal(pending.count, 6)
  assert.equal(shouldDream({ lastDreamAt: undefined, newDailyEntries: pending.count, now }), true)

  const dream = await runDream({
    homeDir: root,
    complete: async ({ user }) => {
      assert.match(user, /D2026-10-21#1/)
      assert.match(user, /\bM1\b/)
      return JSON.stringify({
        ops: [
          { op: 'promote', from: ['D2026-10-21#1'], target: 'memory', text: '博客站点正在从旧框架迁移到 Astro' },
          { op: 'rewrite', id: 'M1', text: '主会话只读，所有落盘由插件 Node 侧完成' },
        ],
      })
    },
    store,
    now,
    workspaces,
  })
  assert.equal(dream.ok, true)
  assert.equal(dream.mode, 'full')
  const memoryText = (await readLayer(root, 'memory')).text
  assert.match(memoryText, /迁移到 Astro \[source: session:main-1#t12; added: 2026-10-21\]/)
  assert.match(memoryText, /主会话只读，所有落盘由插件 Node 侧完成 \[source: report:r-1; added: 2026-10-21\]/)
  assert.match(await readFile(dreamsLogPath(root), 'utf8'), /applied/)
  assert.equal((await collectNewDaily(root, store, await readCursor(root))).count, 0)
  console.log('ok 3 — dream promotes with the daily source, rewrites in place, logs and moves the cursor')

  const section = await loadMemorySection(root)
  for (const text of ['先给结论再给细节', '评论区推迟到下周', '迁移到 Astro', '主会话只读']) {
    assert.ok(section.includes(text), `injection carries: ${text}`)
  }
  assert.equal(await loadMemorySection(root), section, 'injection text is stable between reads')
  console.log('ok 4 — the injection section carries every layer and is stable')

  const legacyRoot = await mkdtemp(join(tmpdir(), 'whale-memory-legacy-'))
  try {
    const seeded = await readLayer(legacyRoot, 'memory')
    await writeLayer(legacyRoot, 'memory', seeded.text.replace('## Facts\n', '## Facts\n- 手写的旧条目，没有来源\n'), {
      expectHash: seeded.hash,
    })
    const unsourced = await remember(legacyRoot, { target: 'memory', op: 'add', text: '未传 source 的条目', now })
    assert.equal(unsourced.entry.meta.source, 'unknown')
    await appendDaily(legacyRoot, [1, 2, 3, 4, 5].map((n) => ({ text: `旧库观察 ${n}`, meta: { source, added: day } })), { day })
    const legacy = await runDream({
      homeDir: legacyRoot,
      complete: async () => JSON.stringify({ ops: [{ op: 'rewrite', id: 'M1', text: '手写的旧条目，补上措辞' }] }),
      store,
      now,
      workspaces,
    })
    assert.equal(legacy.mode, 'full', `a source-less prior entry leaves the full dream available: ${JSON.stringify(legacy.failures)}`)
    assert.match((await readLayer(legacyRoot, 'memory')).text, /手写的旧条目，补上措辞 \[source: unknown/)
  } finally {
    await rm(legacyRoot, { recursive: true, force: true })
  }
  console.log('ok 5 — entries without a recorded source get source: unknown and the full dream still runs')

  console.log('All memory integration checks passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
