# 自律鲸鱼 Memory 系统设计

> 状态：定稿（2026-10-21）。依据：`docs/memory-research.md`（13 家系统调研）+ 对本插件与 DSH 0.2.1-rc.2 宿主接口的实测。
> 目标：主会话是一条**无限对话流**，它自己决定何时压缩、何时清理，同时始终知道「用户是谁、我们正在做什么、做过什么」。

---

## 0. 一页速读

- **层级用 OpenClaw**：Instructions / Soul / User / Memory / Daily / Review 六层，外加鲸鱼自创的第七层 **Activity（我们正在做什么）**。
- **条目用 Devin 格式**：一行一条 bullet，`[source: …; added: YYYY-MM-DD]`，`[[path]]` 互链。
- **检索只有两种**：自动注入、按需读文件。全程纯文本，零向量、零 embedding。
- **五个保留机制的落点**：

| 你要保留的 | 落点 | 复用 / 自建 |
|---|---|---|
| ① Claude Code 的 compact | 宿主 `dsh-compaction-basic`（已挂载） | 复用 |
| ② 先清工具 output 再摘要 | 换一个「清空型」pruner，替掉宿主的截断型 pruner | 自建 ~300 行（自包含实现，以 `toolResultPruner` 服务挂载） |
| ③ chat 自动写 memory | **压缩前 flush** + **每 10 个用户 turn 的 nudge**，后台隐藏模型调用 | 自建 ~200 行 |
| ④ AGENTS.md 只在用户要求时写 | 唯一写入口 `update_instructions`，带「用户原话」结构门 | 自建 ~60 行 |
| ⑤ AutoDream 清理 memory | 复用 dream 的四阶段 prompt + OpenClaw 的改写门禁；触发与执行自建 | 半复用，见 §7 |

---

## 1. 分层（OpenClaw 层级 + 鲸鱼 Activity 层）

所有记忆文件放在主会话 home 内：`$DSH_HOME/discipline-whale/home/memory/`。主会话对 home 有完整读权限，所以「按需读」直接用现有 `read` 工具；所有写入由插件 Node 侧完成，主会话的 `write:false` 保持原样。

| 层 | 文件 | 内容 | 写入者 | 注入方式 | 预算（字符） |
|---|---|---|---|---|---|
| **Instructions** | `home/AGENTS.md` | 运行规则 | **仅用户要求**，经 `update_instructions` | 每步全量（宿主 `dsh-agent-instructions` 已加载） | 宿主 64 KB |
| **Soul** | `memory/SOUL.md` | 语气、立场、风格、边界 | 主会话 `remember(target:"soul")`，只在用户给出风格反馈时；每次写都在回复里告知用户 | 每步全量 | 2,000 |
| **User** | `memory/USER.md` | `## Preferences` 稳定偏好 + `## Now` 用户当前意图（轮换） | Preferences：主会话 `remember` + dream 提升；Now：flush / nudge 整段替换 | 每步全量 | 4,000（Now ≤1,200 且 ≤5 条） |
| **Memory** | `memory/MEMORY.md` | 长期事实、踩过的坑、项目约定 | 主会话 `remember` + dream 提升 | 每步全量 | 8,000 |
| **Activity** | 代码生成，非文件 | 工作区卡片 + 对话条目（见 §3） | 程序确定性生成；工作区介绍由 Agent 更新 | 每个用户 turn 刷新一次 | 见 §3 |
| **Daily** | `memory/daily/YYYY-MM-DD.md` | 当天的原始观察 | flush / nudge，**只追加** | 按需读 | 无上限（dream 后可归档） |
| **Review** | `memory/DREAMS.md` | 每次 dream 的改动摘要 | 仅 dream | 给人看，模型读不到也不需要 | 无 |

**写入路径的单一原则**（OpenClaw "Fixed checks, model judgment inside them"）：

- **curated 层**（USER Preferences / MEMORY）只有两个入口：用户明说「记住」时的 `remember`，以及 dream 的提升。
- **volatile 层**（USER Now / 工作区介绍 / Daily）由 flush 与 nudge 自动维护。
- **Activity 层**的对话条目与 Tag 全部由代码从派工记录推导，模型只负责写工作区介绍那 200 字。

**超限处理**（Hermes 做法）：写入会让文件超预算时，`remember` 返回错误 + 当前全部条目，要求模型在一次调用里先合并再写。注入侧最后一道保险是 OpenClaw 的头 75% + 尾 25% 截断并显式标注。

---

## 2. 条目格式（Devin，原样采用）

```markdown
- 先给结论再给细节，单条回复不超过 5 行 [source: user; added: 2026-10-21]
- discipline-whale 的主会话没有写权限，所有落盘走插件 Node 侧 [source: report:r-3f2a; added: 2026-10-21]
- 博客站点用 bun，lockfile 是 bun.lock，详见 [[workspaces/blog]] [source: session:9c1e#t42; added: 2026-10-18]
```

- `source` 取值：`user`（用户原话）/ `session:<id>#t<turn>` / `report:<reportId>` / `daily:YYYY-MM-DD`。
- `added` 一律绝对日期。dream 时把条目里的相对时间改成绝对日期。
- `[[path]]` 指向 `memory/` 下的按需文件，路径去掉 `.md`。
- USER.md 的 Preferences 用祈使句（`Always / Never / Prefer` 开头，OpenClaw 规则），MEMORY.md 用陈述句（Hermes 规则）。两个文件职责清晰，冲突自然消失。
- 准入标准（写进 `remember` 的工具说明）：记**稳定、跨会话有用、读代码读不出来**的内容；会话摘要、任务进度、PR 号、密钥、重新查一下就能得到的东西交给报告与 session log。

---

## 3. Activity 层：我们正在做什么

这一层回答两个问题：**用户在哪些工作区做事**，**有哪些对话在跑、跑过什么**。

### 3.1 工作区卡片

每个注册工作区一张卡片，存 `discipline-whale/memory-state/workspaces.json`：

```json
{ "ws-abc": { "intro": "个人博客，正在迁移到 Astro，下一步是 RSS 与评论区", "color": "#3B82F6", "updatedAt": "2026-10-21" } }
```

注入形态（一行一个工作区，介绍 ≤200 字符）：

```markdown
## 工作区
- blog · 个人博客，正在迁移到 Astro，下一步是 RSS 与评论区 [id: ws-abc; updated: 2026-10-21]
- discipline-whale · DSH 插件「自律鲸鱼」，正在做 memory 系统 [id: ws-def; updated: 2026-10-21]
```

- 介绍写**用户用这个工作区在做什么、接下来想做什么**，与 README 的「这个项目是什么」分开。
- 更新入口三个：主会话的 `set_workspace_intro`；worker 在 `report_to_main` 里可选带 `workspace_note`（≤200 字符，worker 最清楚现场）；flush 根据对话自动刷新。
- 没有介绍的工作区显示 `（待补充）`，提示主会话在下次派工后补上。

### 3.2 对话条目

**一个对话 = 一条鲸鱼派出去的工作会话**（dispatch），每条一个独立条目，数据全部来自已有的 registry / checkpoint / reports。第二期加一个开关，用户打开后，各工作区里用户直接开的会话也进入条目。

```markdown
## 正在进行的对话
- [blog] 迁移 RSS 生成器 — 进行中 [session: 9c1e; dispatch: d-71; started: 2026-10-21 14:05]
- [discipline-whale] 实现 memory 系统 — 进行中 [session: 4b0a; dispatch: d-72; started: 2026-10-21 15:30]

## 最近结束的对话
- [blog] 修复构建脚本 — done：构建改用 bun，CI 通过 [report: r-3f2a; ended: 2026-10-20]
- …
```

**注入规则**：

1. **进行中的对话全部注入**（每条 ≤240 字符）。
2. **历史对话**按结束时间倒序，条数 = max(5, ⌈进行中条数 × **40%**⌉)；历史总数不足这个数时全部注入。
   - 例：进行中 20 条 → 历史 8 条；进行中 6 条 → ⌈2.4⌉ = 3，取下限 5 条；进行中 0 条 → 5 条。
3. 历史条目的正文用报告的 `summary` 前 120 字符，要细节时 `read_report(report_id)`。

### 3.3 用户意图：USER.md 的 `## Now`

```markdown
## Now
- Prefer 本周优先把鲸鱼的 memory 系统做完，语音 UI 暂缓 [source: session:main#t88; added: 2026-10-21]
- 下一步想做：小模型先判断工作区，再派大模型干活 [source: session:main#t91; added: 2026-10-21]
```

- 最多 5 条，flush / nudge 每次**整段替换**（轮换），旧的 Now 条目同时追加进当天 daily，留作 dream 的提升素材。
- 与工作区卡片分工：卡片说「这个工作区在干嘛」，Now 说「用户整体在忙什么、下一步想干什么」。

### 3.4 消息归类与 Tag

**归类完全由代码确定性完成**：主会话在某个用户 turn 里调用了 `dispatch_task` / `send_to_session`，这个 turn 的用户消息就打上目标工作区的 Tag。

- 捕获：`agent/inbox/claimed`（`source.kind === 'user'`）记录当前 turn 的用户消息 id、turn 号、正文前 200 字符（`adhd.js:717-731` 已有同款钩子）。
- 回填：`dispatch_task` / `send_to_session` 执行时，把 `{workspaceId, dispatchId}` 追加到当前 turn 的记录。
- 一句话派了多个工作区 → 一条记录多个 Tag。
- 存储：`discipline-whale/memory-state/tags.jsonl`，一行一个 turn：

```json
{"turn":42,"messageId":"m-…","sessionId":"main-…","at":"2026-10-21T14:05:00Z","text":"把博客 RSS 迁到 Astro，顺便…","workspaces":["ws-abc"],"dispatches":["d-71"]}
```

### 3.5 派工 bootstrap

向工作区 W 派**新会话**时，brief 在 `## Task` 之前插入 `## 工作区背景`（总长 ≤3,000 字符）：

1. W 的工作区介绍；
2. W 最近 8 条 Tag 过的用户原话（每条 ≤200 字符，按时间正序）；
3. W 最近 3 份报告的 summary（每份 ≤300 字符，附 `report_id`）。

新 worker 一上来就知道「用户在这个工作区一路说过什么、之前交付了什么」。

### 3.6 可视化

| 元素 | 实现位置（DSH 客户端槽位） |
|---|---|
| 工作区颜色 | `workspaces.json` 的 `color`；默认按工作区 id 哈希到 8 色调色板 |
| 改颜色 | 鲸鱼设置面板新增「工作区颜色」一栏（复用现有 dock 设置面板与 `/api/discipline-whale/*` 路由） |
| 对话上的 Tag | `conversation.chat.turnTail`：在主会话每个带 Tag 的 turn 尾部渲染彩色小标签，多工作区并排；点击打开对应会话 |
| 侧栏会话行色点 | `sidebar.session.row.leading`：派出去的会话在侧栏前面带工作区色点 |

用户消息气泡整体染色需要替换宿主的 `user` 节点渲染器，放到第二期，第一期用 turnTail 标签。

### 3.7 后续：小 Agent 选工作区（第二期）

第一期把两样素材备好：工作区卡片（≤200 字符/个）与 Tag 历史。第二期在 `agent/inbox/claimed` 时用一次小模型调用，只读卡片 + 用户消息，输出候选工作区，作为提示注入大模型。

---

## 4. 注入方式与缓存

| 区块 | 宿主 API | 刷新时机 | 理由 |
|---|---|---|---|
| Soul / User / Memory / 工作区卡片 | `ctx.systemPrompt.section` | 每步求值，文本只在写入后变化 | 稳定内容，前缀缓存长期命中 |
| 对话条目（Activity） | `ctx.systemPrompt.context` | 每次用户 turn 进入时刷新，落成一条 user 角色快照 | 高频变化的内容追加在历史尾部，前缀缓存保持有效 |

- 所有区块里的时间一律写绝对时间，同样的状态渲染出同样的文本，保证缓存稳定。
- 压缩后这些区块依旧由 section / context 每步注入，压缩只影响对话历史，记忆层天然「压缩后重注入」。
- flush / dream 读取对话时，过滤掉 Activity 快照与记忆区块本身（OpenClaw 反自激：被注入的内容永远当作已知，不再被抽取成新记忆）。

**注入总预算**：Soul 2,000 + User 4,000 + Memory 8,000 + 工作区 ≤3,000 + 对话 ≤6,000 ≈ **23,000 字符（约 8–10K token）**，在 1M 窗口里不到 1%。

---

## 5. 写入机制

### 5.1 主会话主动写：`remember`

```
remember({ target: "user" | "memory" | "soul", op: "add" | "replace" | "remove", text, match?, source? })
```

- `replace` / `remove` 用 `match`（子串）定位旧条目，Hermes 的 patch 语义。
- `source` 由接线层填 `session:<当前会话>#t<当前 turn>`；任何没有记录来源的条目一律写成 `source: unknown`（`remember` 与 dream 都按这条规则补齐），`added` 由代码填今天。
- 写入后 section 文本变化，下一步请求即可见（DSH section 是 live 的，比 Hermes 的冻结快照更快生效）。
- `remember` 计入 guard 的「生产性工具」名单，不触发 watchdog。

### 5.2 自动写：flush 与 nudge

| | flush（压缩前） | nudge（周期） |
|---|---|---|
| 触发 | 上下文 token ≥ 压缩阈值 − 32K，每个压缩周期一次 | 距上次 flush/nudge 满 10 个用户 turn |
| 执行 | 插件后台 `ctx.llm.stream` 隐藏调用（与 `dsh-auto-memory` 的 consolidation 同款），主会话界面无感 | 同左 |
| 输入 | 上次 flush 以来的用户/助手文本 + 工具调用一行摘要（工具结果省略）+ 当前 USER / 工作区卡片 | 同左 |
| 输出 | JSON 操作：`daily[]`、`user_now[]`（≤5）、`workspace_intros{}` | 同左 |
| 落盘 | daily 只追加；Now 整段替换；工作区介绍逐个替换 | 同左 |
| 失败 | 记日志，压缩照常进行 | 下一个 nudge 再试 |

模型默认用主会话同一个 provider/model，可在配置里指定更便宜的 `memoryModel`。

### 5.3 AGENTS.md 的唯一写入口：`update_instructions`

```
update_instructions({ user_quote, op: "add" | "replace" | "remove", text, match? })
```

- **结构门**：`user_quote` 必须是当前 turn 用户消息的原文子串（≥8 字符），代码校验，不通过直接拒绝。只有用户在这一轮明确提出要求时，模型才拿得出这句原话。
- flush、nudge、dream、`remember` 的目标集合里都只有 `memory/` 下的文件，AGENTS.md 只经这一个入口改动。
- 每次写入后在回复里告诉用户改了哪一行。

---

## 6. 压缩：Claude Code 路线

宿主已经有 Claude Code 同构的压缩链路，鲸鱼两个 preset 都已挂载：`agent/pre-step` 检测压力 → 先剪工具输出 → 仍超阈值再摘要（摘要请求复用同一前缀缓存）。

**要改的只有一处：工具输出从「截断」改成「清空」**。

| | 宿主现状 `dsh-compaction-tool-result-pruner` | 鲸鱼的 `whale-pruner` |
|---|---|---|
| 范围 | 超过 8,192 字符的工具结果 | 最近 3 个用户 turn（DSH turn，含其全部 step）之前的**全部**工具结果 |
| 处理 | 保留头 4,096 + 尾 1,024 | 换成一行占位：`[工具输出已清理 · read_report r-3f2a · 9,929 字符 · 原文在 session log]` |
| 最近 3 个 turn | 同样截断 | 沿用宿主的头尾截断 |
| 实现 | — | 自包含实现（插件安装方式下宿主包解析不稳定），`apply` 里 `ctx.reflect.provide('toolResultPruner', …)`，替换 compaction 组里宿主的 pruner 行 |

运行时机与宿主一致：只在压缩压力成立时运行；清完如果已经低于阈值，就跳过摘要。原文永远留在 session log。

**压缩阈值**沿用宿主默认（1M 窗口约 838K 时压缩），flush 在约 806K 时先跑。

---

## 7. Dream：AutoDream 的轮子盘点与结论

### 7.1 现有轮子

| 轮子 | 形态 | 能直接用在 DSH 吗 |
|---|---|---|
| Claude Code AutoDream | 官方未公开文档；社区逆向出四阶段 prompt（Orient / Gather / Consolidate / Prune & Index），触发「距上次 ≥24h 且 ≥5 个会话」+ 锁文件 | prompt 结构可借鉴，代码在 Claude Code 内部 |
| Anthropic `consolidate-memory` skill | 手动触发的整理流程（盘点 → 合并去重、相对时间改绝对、删易重查内容 → 整理索引） | 是 skill 文本，需要一个执行器 |
| `Cat-tj/auto-dream`（MIT） | OpenClaw skill：24h cron + 隔离子 agent + 四阶段 + `dream-log.json` | 依赖 OpenClaw 的 cron 与文件布局，可借 prompt |
| `grandamenium/dream-skill` | Claude Code skill + Stop hook | 仓库没有 LICENSE，法律上不可复用 |
| 宿主 `dsh-auto-memory` 0.9.0 | 只有「会话结束时抽取新事实」，鲸鱼主会话是无限会话，这个时机永远等不到 | 用不上 |

### 7.2 结论

**prompt 复用，执行器自建**。DSH 生态里没有现成的 dream 执行器，可复用的是方法论：

- **四阶段 prompt**：按 Claude Code / `consolidate-memory` 的四阶段，结合 `Cat-tj/auto-dream`（MIT）的写法改成鲸鱼版。
- **OpenClaw 的改写门禁**，由代码强制：
  1. 模型只输出**操作列表**（keep / merge / promote / rewrite-date / remove），代码执行；
  2. 一次 dream 删掉的旧条目 ≤ **25%**；
  3. 每条保留与提升的条目都带 `[source: …]`；
  4. 改写前记录文件 hash，执行时 hash 变了（期间有人写过）就放弃本次改写；
  5. 结果必须落在 §1 的预算内；
  6. 任一门禁失败 → 退化为「只追加提升条目」，改动摘要写进 `DREAMS.md`。
- **执行器**：~150 行，复用 §5.2 的隐藏调用通道。

### 7.3 Dream 做什么

| 阶段 | 动作 |
|---|---|
| Orient | 读 USER / MEMORY / 工作区卡片 / 上次 dream 以来的 daily |
| Gather | 从 daily 里找出重复出现、用户确认过、跨对话成立的观察 |
| Consolidate | daily → MEMORY / USER Preferences 的提升；合并近似重复；相对时间改绝对；删掉被新事实推翻的条目 |
| Prune | 删掉 30 天无引用、已过时的条目；把 ≥30 天前的 daily 归档到 `daily/archive/` |

- SOUL.md 与 AGENTS.md 在 dream 的操作范围之外。
- **触发**：距上次 dream ≥24h **且** 上次以来新增 daily 条目 ≥5 条；只在主会话空闲（`agent/status → idle`）时启动；`memory-state/dream.lock` 防并发。
- 主会话另有 `dream_now` 工具，用户说「整理一下记忆」时手动触发。

---

## 8. 与宿主 `dsh-auto-memory` 的关系

宿主的 `dsh-auto-memory` 是 profile 级插件，目前也在给鲸鱼 home 注入索引（`~/.dsh/memory/--Users-huiyuan-.dsh-discipline-whale-home--/`，已有 3 条）。两套记忆同时作用于主会话会出现双份真相。

**定案**：鲸鱼主会话只用鲸鱼 memory。

- 已有条目按类型迁移：`user` / `feedback` 进 USER Preferences，`project` / `reference` 进 MEMORY Facts，每条带 `[source: dsh-auto-memory:<name>; added: …]`；迁移后原目录清空，宿主那一段注入自然为空；
- guard 在主会话里拦截 `memory_*` 工具，返回「请用 remember」；
- 其它工作区与 worker 会话继续用 `dsh-auto-memory`，互不影响。

---

## 9. 存储布局

```
$DSH_HOME/discipline-whale/
├── home/                         # 主会话 cwd，主会话可读
│   ├── AGENTS.md                 # Instructions（仅 update_instructions 写）
│   └── memory/
│       ├── SOUL.md
│       ├── USER.md
│       ├── MEMORY.md
│       ├── DREAMS.md
│       ├── daily/2026-10-21.md
│       └── workspaces/<slug>.md  # [[workspaces/x]] 指向的按需长笔记（可选）
└── memory-state/                 # 插件内部状态
    ├── workspaces.json           # 工作区介绍 + 颜色
    ├── tags.jsonl                # 用户消息 → 工作区 Tag
    ├── cursor.json               # flush / nudge / dream 的进度游标
    └── dream.lock
```

所有写入走 temp + rename 原子写（复用 `checkpoint.js` 的 pid+uuid 写法）。

---

## 10. 模块与接口契约

所有模块是 ESM，函数的第一个参数 `homeDir` 一律是 DSH 根目录（`store.js` 的 `storeRoot()`），路径用 `store.js` 的 `dataDir(homeDir)` / `whaleHomeDir(homeDir)` 推导。条目解析、渲染、原子写统一用 `entry.js`。

### 10.1 `entry.js`（底座，已完成）

`isoDay` · `clip` · `charLength` · `parseEntry` · `formatEntry` · `parseSections` · `renderSections` · `sectionEntries` · `atomicWrite`

### 10.2 `memory.js`（Soul / User / Memory / Daily / Instructions）

```js
LAYERS = {
  soul:   { file: 'SOUL.md',   budget: 2000, sections: ['Voice'] },
  user:   { file: 'USER.md',   budget: 4000, sections: ['Preferences', 'Now'] },
  memory: { file: 'MEMORY.md', budget: 8000, sections: ['Facts'] },
}
NOW_MAX_ENTRIES = 5; NOW_BUDGET = 1200
memoryDir(homeDir)                       // <whaleHome>/memory
readLayer(homeDir, target)               // → { text, doc, hash }；文件不存在时返回带标题与空 section 的模板
writeLayer(homeDir, target, text, { expectHash })   // hash 不符抛 MemoryConflictError；超预算抛 MemoryBudgetError
remember(homeDir, { target, op, text, match, section, source, now })
                                         // op: add | replace | remove；超预算抛 MemoryBudgetError，message 里列出当前全部条目
appendDaily(homeDir, entries, { day })   // 只追加；entries = [{ text, meta }]
readDaily(homeDir, day) / listDailyDays(homeDir)
replaceNow(homeDir, entries, { now })    // 整段替换 USER ## Now（≤5 条、≤1,200 字符），旧 Now 条目追加进当天 daily
renderMemorySection(layers)              // Soul / User / Memory 三块的注入文本；单块超预算按头 75% + 尾 25% 截断并标注
loadMemorySection(homeDir)
updateInstructions(homeDir, { userQuote, latestUserText, op, text, match })
                                         // 写 <whaleHome>/AGENTS.md；userQuote 必须是 latestUserText 的子串且 ≥8 字符
importAutoMemory(homeDir, autoMemoryDir) // 把 dsh-auto-memory 的条目迁进 MEMORY.md
```

### 10.3 `activity.js`（工作区卡片 / 对话条目 / Tag / bootstrap）

```js
PALETTE                                  // 8 色
defaultColor(workspaceId)                // 按 id 稳定哈希取色
readWorkspaceCards(homeDir)              // → { [workspaceId]: { intro, color, updatedAt } }
setWorkspaceIntro(homeDir, workspaceId, intro, { now })   // intro >200 字符直接报错，让模型重写
setWorkspaceColor(homeDir, workspaceId, color)
renderWorkspaces(workspaces, cards)      // workspaces = registry.list() 的 { id, title, path }
conversationEntries({ dispatches, reports })   // 纯函数 → { running, history }
historyCount(runningCount)               // max(5, ceil(runningCount * 0.4))
renderConversations({ running, history })
recordUserTurn(homeDir, { sessionId, turn, messageId, text, at })
tagTurn(homeDir, { sessionId, turn, workspaceId, dispatchId })
readTags(homeDir, { workspaceId, limit })
buildBootstrap(homeDir, { workspace, reports })   // ≤3,000 字符的「## 工作区背景」
```

`tags.jsonl` 只追加：`{kind:'turn',…}` 与 `{kind:'tag',…}` 两种行，读取时按 `sessionId + turn` 合并。

### 10.4 `memory-flush.js` 与 `dream.js`（自动写与整理）

两者都通过注入的 `complete({ system, user, signal }) → Promise<string>` 调模型，通过注入的 `store`（`memory.js` / `activity.js` 的函数）落盘，因此可以脱离宿主单测。

```js
// memory-flush.js
shouldFlush({ contextTokens, compactThreshold, margin, flushedThisCycle })
shouldNudge({ userTurnsSinceLast, interval })
buildFlushPrompt({ transcript, user, workspaces })   // transcript = [{ role, text, toolName }]，已过滤注入区块
parseFlushOutput(text)                   // → { daily, user_now, workspace_intros }
runFlush({ homeDir, transcript, complete, store, now, source })

// dream.js
shouldDream({ lastDreamAt, newDailyEntries, now })
acquireDreamLock(homeDir) / releaseDreamLock(homeDir)
buildDreamPrompt({ user, memory, workspaces, daily })
parseDreamOps(text)
applyDreamOps({ user, memory, daily, ops })          // 纯函数
checkGates({ before, after, ops })                   // §7.2 的 6 条门禁
runDream({ homeDir, complete, store, now })          // 门禁失败退化为只追加；改动摘要写 DREAMS.md
```

游标存 `memory-state/cursor.json`：`{ lastFlushAt, lastNudgeTurn, lastDreamAt, dailyEntriesAtLastDream, dreamDayEntries }`。`lastFlushAt` 由 `runFlush` 写，`lastNudgeTurn` 由接线层写（它知道 turn 号），dream 三个字段由 `runDream` 写；`dreamDayEntries` 记录 dream 当天已读过的 daily 条数，同一天后写入的条目留给下一次 dream。

### 10.5 `pruner.js`（清空型工具输出 pruner）

自包含实现，`apply` 里通过 `ctx.reflect.provide('toolResultPruner', …)` 注册，替换 compaction 组里宿主的 pruner 行（同组内同名服务只能有一个）。最近 3 个用户 turn（按 `data.turn` 分组，进行中的 turn 算一个）内的工具结果沿用头尾截断，更早的整条换成一行占位；占位不比原文短的小结果保持原样；被清理结果里的图片块一并去掉，原文仍在 session log。

### 10.6 实施顺序

| 阶段 | 内容 |
|---|---|
| 第一阶段（本分支） | `entry.js` + 10.2–10.5 四个新模块与各自单测，全部是新文件 |
| 第二阶段（同步到最新代码后） | 接线：`main.js` 注册 section / context / 工具；`worker.js` 接 `workspace_note`；`guard.js` 拦截主会话 `memory_*` 并放行 `remember`；`client.js` 标签、色点、颜色设置；`home.js` 新路由；`cordis.patch.yml` 换 pruner；README / VERIFICATION |

---

## 11. 已定决策（2026-10-21）

1. **代码基线**：第一阶段在本分支做独立新模块；`feat/voice-ui-redesign` 的改动提交后，本分支同步过去再接线。
2. **对话范围**：第一期只算鲸鱼派出的会话；第二期加开关，让用户选择是否把其它会话也算进来。
3. **40% 口径**：按条数，历史条数 = max(5, ⌈进行中条数 × 40%⌉)。
4. **dsh-auto-memory**：鲸鱼主会话由鲸鱼 memory 接管，已有 3 条（均为 feedback）迁入 USER Preferences。
