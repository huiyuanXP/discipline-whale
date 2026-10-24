# Discipline Whale · 自律鲸鱼

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**你只跟一个主会话说话**，由它判断内容该进哪个工作区、把活派出去；工作区会话干活、派生自己的子代理，**干完必须回报**。主会话读回报，向你转述，并把你后续的新决策再分发出去。

名字来自科幻片里那种能自主判断任务、处理繁杂事务的自律机器人。英文 `Discipline Whale`，中文「自律鲸鱼」。

## 它解决什么问题

DSH 里已经有 `subagent`（同一会话内的子代理）和 `dsh-webhook`（外部事件触发建会话）。但缺少一条中间路线：**由 Agent 自己把工作分发到另一个工作区的独立会话，并在完成后收到回报**。

这个插件补的就是这条线，并且把「必须回报」做成结构性约束而不是提示词自觉。

## 侧边栏入口

自律鲸鱼在 Web 左侧边栏有一个独立入口「自律鲸鱼」，位于「上下文洞察」正上方，和「插件 / 自动化任务 / 上下文洞察 / 记忆」同级。点进去直接打开鲸鱼的**主会话**。

主会话的工作目录是鲸鱼自己的 home：`$DSH_HOME/discipline-whale/home`。它是插件的后台目录，不注册成工作区，也不出现在工作区列表里；鲸鱼工作中产生的文件写在这里。

- 插件启动时（profile 级的 `discipline-whale` 行，即 `home.js`）创建 home，并提供接口 `/api/discipline-whale/home`：`GET` 返回 home 路径和主会话 id，`POST` 新建主会话
- 主会话 id 记录在 `$DSH_HOME/discipline-whale/state.json`，换浏览器也是同一个主会话
- 入口打开时：记录的主会话仍在且未归档就直接打开；否则由 Host 以 `discipline-whale` preset、cwd = home 新建一个，标题「自律鲸鱼」，并立即发一条**唤醒**消息（自我介绍 + `list_dispatches` 汇报）。不属于任何工作区的会话要有过一轮才能在 Web 里输入，唤醒这一轮正好满足
- 主会话标题栏有「+ 新建主会话」按钮（只在主会话里显示）：Host 新建并唤醒一个主会话、记为新的主会话并直接打开；旧主会话保留在会话列表里

## 两个 preset，两种角色

安装后，Web GUI 的 preset 选择器里会多出两项：

| Preset | 角色 | 工具面 |
|---|---|---|
| **Discipline Whale** | 主会话：派工、汇报、讨论架构 | `list_workspaces` `dispatch_task` `read_report` `send_to_session` + **只读**文件（读/搜索/看图）+ 网页 + 提问 + UI 渲染。**无 shell、无写/编辑** |
| **Discipline Whale Worker** | 工作区会话：真正干活 | `report_to_main` + 完整编码工具 + 子代理 |

**关键的结构性保证**：`dispatch_task` 只存在于主会话 preset，`report_to_main` 只存在于 worker preset。worker 的子代理继承 worker preset，所以**子代理拿不到任何派工能力**——这是模块装载层面的隔离，不是靠提示词约束。

这条保证只覆盖**本 bundle 自己注册的工具**。像 `create_session` 这种由别的 bundle 注册进 Host 层的工具，不在 preset 的控制范围内（见下文「已知限制」）。

主会话不注册 `report_to_main`：它只会被回报，不会自己造一个。

## 工具

### `list_workspaces`（主会话）
列出所有已注册工作区：id、标题、路径、会话数。派工前用它决定归属。

### `dispatch_task`（主会话）
```json
{ "workspace": "soc-api-test", "task": "完整任务描述", "title": "可选标题", "topic": "可选话题", "at": "step|queue|abort", "writes": ["可选路径前缀"] }
```
创建一个 worker 会话、下任务、返回 `dispatchId` + `workerSessionId`。worker 立刻开始执行。
带了 `topic` 且同工作区有同话题的活会话时，改为把新任务插给那个会话（默认在步边界生效）并返回 `reused: true`；`writes` 与另一个活会话重叠时拒绝派工。详见下文「派工路由」。

任务描述里会自动附加「必须调用 `report_to_main`」的约定，即使 worker preset 的 persona 写得很简。

### `report_to_main`（worker）
```json
{ "summary": "一句话总结", "document": "详细文档正文", "status": "done|partial|blocked" }
```
**分成两半是有意的**：
- `summary` 被**主动推送**成主会话的一条消息，直接唤醒主 Agent —— 主会话不需要轮询、不需要调工具。
- `document` 落到磁盘，不会自动进上下文：主会话要看时用 `read_report`，而它**默认只给 head**（元信息 + 完整 `summary` + 章节标题 + 前 2000 字符），确实需要整份才显式 `mode: "full"`。

### `read_report`（主会话）
```json
{ "report_id": "r-…", "mode": "head|full|index", "workspace": "可选：列表/索引看哪个工作区", "limit": 10 }
```
**默认 `mode: "head"`。** 主会话每读一次都在付上下文的钱，所以默认行为不是「把整份文档倒出来」：

| mode | 返回什么 | 什么时候用 |
|---|---|---|
| `head`（默认，可省略） | `chars` / `estimatedTokens`、`id` / `status` / `outcome` / `reportedAt` / `workerSessionId`、**完整 `summary`**、章节标题（只取代码块之外的 ATX `#`~`###`）、文档前 2000 字符预览、`documentTruncated`，以及一句 `howToReadFull`（里面写着 `read_report(report_id="…", mode="full")`） | 判断「这份要不要读全」，通常够直接答复用户 |
| `full` | 整份 `document`，也就是旧行为 | 只在 head 的预览与标题不足以回答时 |
| `index` | 一个工作区一行一份：`- <reportedAt> [<status>/<outcome>] <summary 首行，≤120 字> — <reportId>` | 扫一眼有哪些报告，不读正文 |

`mode: "index"` 是**磁盘扫描**：M2 才会有真正的索引文件，现在没有；返回值里的 `index.source` 就是这么写的（还带 `count` / `total` / `truncated`），不会假装有索引。不带 `report_id` 的列表调用行为不变。

**短报告不走预览**：`document` 不足 3000 字符时直接整份返回，`returned: "full (small report)"`——为省 1000 字再让主会话多花一次往返不划算。这一档**不带 `sectionHeadings`**：整份文档里本来就看得见标题，再列一遍反而让它比 `mode:"full"` 还贵（实测 6 份小报告贵 8%–15%）；`test/report-head.mjs` ok 5 比较两者渲染后的字符数来防止这条退化。

**实测节省**（真实报告库里 30 份基准报告、185,374 字符文档、2 个工作区，按 `output.render` 的输出字符数算）：**228,779 → 124,729 字符，省 45.5%**（≈57,195 → 31,183 token @ 4 字符/token）。≥3000 字符的 24 份省 49.6%；不足 3000 字符的 6 份只省 4.0%——文档已经很短时，「整份给你」本来就是最省的诚实答案，这一档只是去掉了重复的元信息。**没有一份报告在 head 档下比 full 档更贵。** 复测：`node scripts/m1-measure.mjs`。

**预览的两条边界**（`previewDocument` 负责，测试 ok 8/9 看守）：
- 不切开代理对：切口正好落在 emoji 的高位/低位之间时退一个 UTF-16 单位，中文与 emoji 都不会碎成替换字符。
- 不交出半个代码块：切口落在没闭合的 fence 里时，退到该 fence 起始行之前；**fence 从第 0 个字符就开始**时退无可退，于是保留切口并补一个同标记的闭合 fence（`fenceClosed: true` 标出来），Markdown 照样能渲染。

`node test/report-head.mjs`（10 项）看守上面每一条；**默认值靠「完全不传 `mode`」的断言钉住**——把默认值改成 `full` 会让它立刻红，这是唯一能证明默认是真的、而不是测试里显式传出来的办法。

### `send_to_session`（主会话）
给运行中的 worker 追发新决策。默认 `at: "step"`：在当前回合的**下一个步边界**插话；`at: "queue"` 等整个回合跑完；`at: "abort"` 才硬中止。三种时机的准确差别见下节。

### 派工优先与「一个话题一个会话」

主会话的纪律写在 preset 的 **persona prefix**（`cordis.patch.yml` 的 `preset-discipline-whale` 行里那段中文），不靠用户每次提醒。它是 system prompt 的一个 section，每次请求重新组装；不采用「每轮强塞一条消息」的注入方式（理由见「已知限制」）。

规则要点（全文即 `cordis.patch.yml` 里那段，`node prompt-probe.mjs discipline-whale` 可打印组装后的实际文本）：

- **默认动作是派工**：第一句先给判断，同一回合内 `dispatch_task`。
- **读预算**：`list_workspaces` 之外最多 2 次读，只用于判断归属和划任务边界；禁止为写 brief 去通读实现、翻配置找密钥、跑实验、读子系统详细文档。自检判据是那句「如果继续读下去就能直接回答用户『能不能做 / 怎么做』的技术细节，就立刻停手派工」。
- **同一件事的延续 → 往正在跑的会话插话（步边界生效）**，不新建；只有主题不同或前一个已交付完成才新建。几项改动落在同一文件或同一职责时合成一个 brief 派一次。
- **例外**：纯讨论、架构权衡、选工作区、转述回报，以及用户问的是问题不是活 —— 不派工。
- **诚实边界**：派工不等于完成。

### 三种投递时机：step（= Interrupt）/ queue / abort

用户要的「Interrupt」是**第二档**：等当前这一次 tool call 收尾，在下一个 step 边界插进去，同一个 turn 内重新规划。**不是硬中止。** 三档并列如下：

| # | 时机 | 插件参数 | Host 路径 | 生效点 | 会打断正在跑的工具调用吗 |
|---|---|---|---|---|---|
| 1 | 排队 | `at: "queue"` | `prompt(mode:"queue")` → `followup` → inbox `next-turn`（`dsh-agent-loop:806`） | 当前**整个 turn 跑完** | 不会 |
| **2** | **步边界插话（= 用户说的 Interrupt，默认）** | `at: "step"`（可省略） | `prompt(mode:"steer")` → `steer` → inbox `next-step`（`dsh-agent-loop:809`） | 当前 **tool call 结束、下一步开始之前**，同一 turn 内 | **不会——这是设计意图，不是缺陷** |
| 3 | 硬中止 | `at: "abort"` | 先 `sessionController.cancel({sessionId})`，再 `steer` | 立刻打断正在执行的工具调用 | 会，且可能留下半截状态 |

**纯 `steer` 那条路径（第 2 档）全程不调用 `cancel`**：当前那一次工具调用正常收尾，worker 带着完整的上下文（已读的文件、已建立的判断）重新规划。不打断正在跑的工具调用是**有意为之**，因为硬中止会留下半截状态（brief 写一半、文件改一半），那正是这一档要避免的代价。契约测试 ok 26 专门断言这一点：只要 step 路径上出现任何 `cancel` 调用就会失败。

**代价，必须说清**：如果当前那一步是个长跑工具调用，插话得等它结束。所以这个机制的准确含义是**「最近一个步边界」，不是「立刻」**——不许对用户暗示成瞬时打断。README 与 persona 都写死了这句口径。

`queue`（第 1 档）的用途：**不想打断它当前的活、只补一条不影响方向的说明**。它等整个 turn 结束才接入。

`abort`（第 3 档）只在「它已经在写错的文件、等不起」时用，属于最后手段，用之前先说明代价：`cancel` 中止当前回合的 AbortSignal 但保留 inbox（`dsh-api-session-controller/lib/types/commands.js:466-475` → `dsh-agent-loop:815-821`）。冷会话（没有活着的 turn）时 `cancel` 抛 `session/not-found`，插件吞掉并照常投递，返回 `aborted: false` —— 不谎报中止过。

依据（都在 Host 源码里，可自行核对）：`followup` → `next-turn`、`steer` → `next-step`（`dsh-agent-loop/lib/index.js:806-811`）；`claim()` 在**每个**步边界都清空 `next-step`，而 `next-turn` 只在 target 是 `"next-turn"` 时才清（`lib/index.js:103-105`）；turn 循环以 `target = "next-turn"` 开场、首步之后切到 `"next-step"`（`lib/index.js:951`、`1008`）。所以一次 `steer` 必然会落到当前 turn 的下一个步边界。契约测试 ok 25 直接对这几行源码做断言，Host 升级改变语义会在这里失败。

### 派工路由：`topic` / `at` / `writes`

```json
{ "workspace": "soc-api-test", "task": "…", "topic": "voice-input", "at": "step", "writes": ["src/voice"] }
```

- `topic`：同工作区 + 同 topic（忽略大小写与多余空格）+ 尚未 reported/abandoned → **把这个新任务插给那个已有会话**，返回 `status: "reused"`、`reused: true`、`deliveredAs`，不新建会话。没有 topic 就没有可判定的「同一件事」，每次都是新会话。
- `at`：复用已有会话时的投递时机，`step`（默认，步边界）、`queue`（等回合结束）、`abort`（硬中止）。
- `writes`：本任务会改的路径前缀。同一工作区里两个仍活着的会话若前缀重叠（`a/b` 与 `a` 算重叠），**派工直接拒绝**并指出该找谁续。声明了不相交的前缀才允许并行。
- 已 reported 的会话不会被复用：交付完的事再提新需求属于新活。

### `list_dispatches`（主会话）
看板：本次进程里记录的所有派工，带 worker session、状态（`running` / `reported` / `abandoned`）、已派出多久。
支持按 workspace 片段过滤、按数量截断（默认 50，上限 200），新的在前。

两点口径是刻意写死的，避免把近似值当精确值用：
- `elapsed` 的终点是「报告/放弃的时间」或「现在」，起点是派工时间；时间戳缺失或早于起点时**钳到 0** 并给出 warning，不会输出负数或 `NaN`。
- `lastActivityAt` 是**注册表可见的状态跃迁**（报告、放弃、派工），**不是**最后一条消息的时间。worker 干活期间这个值不会动。
  `lastPromptAt` 单独给出，它是该 worker 会话最后一条**用户/调度方** prompt 的时间，同样不反映 worker 进度。

看板只读**进程内注册表**：重启后它是空的（这正是 `list_dispatches` 与检查点文件的分工）。

### `resume_dispatch` / `abandon_dispatch`（主会话）
```json
{ "worker_session_id": "session-…", "note": "可选，给 worker 的补充指令（仅 resume）" }
```
处理被 DeepSeek Harness 重启打断的派工，只在用户做出选择后调用：
- `resume_dispatch`：唤醒 worker，让它回顾本会话、从中断处继续，完成后照常 `report_to_main`；回报改投给发起恢复的主会话，派工重新出现在看板上
- `abandon_dispatch`：删除这条派工的检查点，并留下放弃标记 `dispatches/<workerSessionId>.abandoned`，不再提醒；worker 会话本身保持原样，但不会再被催着回报（主会话和 worker 的注册表互不共享，标记是两边都能看到的事实）

## 启动检查：被打断的派工

鲸鱼和 DeepSeek Harness 同生共死：进程退出时正在跑的 worker 不会在重启后自己继续。每次启动，Host 端扫描 `dispatches/` 里没有交付的检查点；如果有，并且已经有主会话，就给主会话发一条「启动检查」消息，列出每条中断的派工。主会话说明每条原本在做什么，用 `ask_user` 让用户逐条选择 **恢复 / 放弃 / 稍后再说**，再按选择调用 `resume_dispatch` 或 `abandon_dispatch`。「稍后再说」的派工保持原样，下次启动会再次提醒。

## 强制回报：不报告就别收工

worker 每次即将结束回合时，插件会检查本轮是否调用过 `report_to_main`：

- **没报** → 用 `agent.steer()` 把它推回去，附上具体指令（"你正要结束但没有报告，现在调用 report_to_main"）
- **连续 3 次都没报** → 停止重试，改为**向主会话推送一条失败通知**，附带 worker session id，让人能去看现场

这比无限重试或静默失败都好：前者会烧钱，后者会让你以为任务完成了。

**局限（必须说清）**：它拦的是「想收工却没报告」。拦不住 worker 什么都不做就结束，也拦不住它编一份假报告。主会话的转述只能当索引，最终验证仍应落到那个工作区的实际结果上。

## 主会话的三道刹车（`guard.js`）

主会话的文件系统是只读的，也没有 shell，所以「忍不住写代码」不是这里的问题。真正的问题是**读得太多、没有配额、不回话就一路读下去**。插件在主会话行上挂了三道机制（实现全在 `guard.js`，`main.js` 只多一行 `installGuard`）：

**1. 工具调用看门狗 —— 硬停 + 强制回话**

连续 **10** 次静默工具调用（没有任何用户可见文本）→ **终止当前回合并注入一条 prompt**，逼它立刻回话、然后 `dispatch_task` 把活派下去。注入的 prompt 同时**把读配额重置满**，否则它刚被 10 条配额卡住，被迫回话时连派工都做不了。

- **计数口径**：默认 `all` —— 除「只产出、不增加对代码库了解」的 28 个履职工具外都算。豁免四组：派工/看板/回报（`dispatch_task` 等）、对用户说话（`present`/`ask_user_question`/`todo_write`）、**渲染产出**（`render_text`/`render_ui`/`render_canvas`/`render_scene`/`render_mechanism`/`update_ui`/`patch_ui`/`validate_ui`/`inspect_ui`/`ui_catalog`/`preview_video`/`render_video`/`process_video`/`synthesize_voice`）、**文档产出**（`excel_create`/`excel_update`/`word_create`/`word_update`/`ppt_create`）。也可用 `watchdogCounting: read-only` 切到「只数 `read`/`read_image`/`grep`/`glob`/`web_fetch`/`web_search`」。取舍见下。
  - 渲染产出必须在豁免清单里：一次多图形块的回答会在正文之间连续渲染若干 UI 文档，那不是埋头调研。漏掉它们，渲染到第 10 个就会把正常交付拦腰截断。（`excel_read`/`word_read`/`ppt_read`/`inspect_video` **不**豁免——把产物读回来确实拉进了上下文。）
- **防死循环**：单轮最多强制介入 `maxInterventions`（默认 **2**）次，之后**停止干预**并推一条「主会话异常，已停止干预」给用户；用户发新消息即重新武装。配额仍然生效，所以不会失控刷钱。
- **用户可见文本**的判定用真实信号：assistant 流里出现非空白的 `text-delta` / 文本块结束。`reasoning-delta`（思考）**不算**回话。

**2. 读配额 —— 每回合 10 条，回话刷新**

每个「回话周期」最多 **10** 次读类调用（`read`/`read_image`/`grep`/`glob`/`web_fetch`/`web_search`）。**一旦产生用户可见文本就刷新**（不是每条新用户消息才刷新，否则一轮里多段回复的额度回不来）。超额不是静默失败，而是返回一条自解释的拒绝，原文：

> `[Discipline Whale] Read quota exhausted — 0 of 10 read calls left in this reply. Stop reading now: answer the user with what you already have, then route the rest of the work with `dispatch_task` (or `send_to_session` for a running worker). The quota refreshes as soon as you produce user-visible text.`

状态按会话隔离，且**只对主会话 preset 生效**——worker 要正常读几十个文件，绝不受影响。

**3. 读路径白名单 —— 读过界要说话**

| 区域 | 可读性 |
|---|---|
| 主会话自己的 home（`$DSH_HOME/discipline-whale/home`） | **完全可读**，不设路径限制（但仍受 10 条配额） |
| 其他工作区 | 只允许：根级 `README*.md`、任意层 `AGENTS.md` / `CLAUDE.md`、`docs/**/*.md`、根级 `*.md`、根级 `package.json` |
| 其余 | 拒绝 + 一句明确的话，告诉你「为什么被拦 + 该怎么替代」 |

白名单外的拒绝原文：

> `[Discipline Whale] Read blocked — "<path>" is outside the main session's read scope. Readable: anything under your own home (<home>); public documents inside a registered workspace: README*.md, AGENTS.md, CLAUDE.md, docs/**/*.md, top-level *.md, and package.json. Source files, configs, and data are not readable from the main session. To inspect this file, dispatch a worker into that workspace with `dispatch_task` and let it read it.`

- **路径穿越按解析后的真实路径判定**：`../`、符号链接指向白名单外，都会先 `realpath` 再判断（叶子文件不存在时向上找到最深的已存在祖先再拼回尾部），不是看字符串前缀。
- `grep` / `glob` 是**整树遍历**，无法事后逐文件过滤，所以它们**只允许在主会话 home 内**。否则一次 `grep` 就把白名单想拦的源码全读进来了。
- **不误伤既有能力**：`list_workspaces` / `dispatch_task` / `read_report` 都不是文件读，不受白名单或配额影响；`read_image` 算**一次读**（它确实把文件内容拉进上下文）并同样受路径白名单约束。

**为什么默认 `watchdogCounting: all`**：读配额已经把读类调用卡在同一个数字（10）上，若看门狗也只数读类，两者会在同一刻触发、只有先判的那个可见，等于少了一层保护。`all` 让两者都活着：混合型爆发（读 + todo/skill 等）由看门狗硬停，纯读爆发在被停过一次、介入预算用完后由配额兜住。想要字面的「10 个 tool call」口径，把 `watchdogCounting` 设为 `all` 即可——它本来就是默认值；想只数读类就设 `read-only`。

阈值全部是 `guard.js` 顶部的具名常量（`WATCHDOG_SILENT_THRESHOLD` / `READ_QUOTA_PER_EPOCH` / `MAX_FORCED_INTERVENTIONS_PER_TURN`），也可以在 `cordis.patch.yml` 的 `discipline-whale-main` 行里按部署覆盖。

**验证了什么、没验证什么**：逻辑与真实作用域投递都有测试（`node test/guard.mjs`，含用真实 `cordis` + `dsh-scope` 包断言 preset 监听器确实能收到 `agent/assistant-stream`、而 `session/event` 确实收不到）。**没有**做真机重启验证，因此「硬停把正在派工的回合打断」这类时序行为仍属未验证。

## 输出纪律：给 ADHD 读者的简洁回复（`adhd.js`）

主会话是唯一直接跟你说话的会话。这道机制约束**它怎么说**：正文短、第一句就是下一步、不铺垫不复述。实现全在 `adhd.js`，`main.js` 只多一行 `installBrevity`，规则原文在 `skills/whale-brevity/SKILL.md`。

改造自 [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)（**MIT**，Copyright (c) 2026 Ayoub Ghriss）。上游是「Skill + Hook」两半：Skill 存规则，`SessionStart` hook 在用户 opt-in 后把整份规则注入会话。本插件保留这两半，但**规则正文按本插件口径重写并新增了「UI 交付物豁免」一节**（上游没有画布类工具，所以没有这一节），不是逐字照抄。

**两半分别落在哪**

| 上游 | 这里 | 作用 |
|---|---|---|
| `SKILL.md` | 注册成 skill `whale-brevity`，**只进主 preset 的 scope** | 模型可以按名字加载完整规则 |
| `SessionStart` hook 注入 | 同一条 prompt section（`discipline-whale:brevity`） | 规则常驻 system prompt，每轮都在，不依赖模型主动加载 |

`SessionStart` 在 DSH 里没有对应事件，而且 preset 里的监听器收不到 `session/event`（host 平面派发会被 scope 过滤掉，见 `guard.js` 的注释）。所以「常驻」改用 prompt section 实现——这比注入一条消息更稳：它每次请求重新组装，不会被压缩掉，也不需要额外的消息。

**第三个机制：超长纠正，两个边界**

| 边界 | 钩子 | 触发 | 效果 |
|---|---|---|---|
| 回合中途 | `agent/pre-step` | 本轮已流出的可见正文超过上限 | 下一步开始前注入一条提醒，本轮余下的步变短 |
| 回合结束 | `agent/turn-stopping` | 本轮**最终答案**（最后一次模型输出）超过上限 | 注入一条「重写」提示，回合多跑一步，模型把答案压缩重写，短的那条成为本轮答案 |

回合末重写决定了用户最后读到什么。`agent-loop` 在结束回合前串行派发 `agent/turn-stopping`，派发完 `next-step` 仍为空才收尾；这里 steer 一条提示进 `next-step`，回合就继续跑一步。DSH 原生对话视图在回合完成时把「最终答案之前的所有行」折进本轮的过程控件（compact / standard / detailed 都折叠；Web 默认 detailed，Desktop 默认 standard；verbose 全部展开）。重写落地后，短答案是本轮答案，长稿是过程里的一行，默认收起。

- **只量最终答案**：每次模型输出以 `start` 帧开头，计量从那里重新开始。过程里的长旁白会被折叠，不触发重写；失败重试前的那次输出也不计入。
- **预算**：两个边界各有 `maxCorrections` 次（默认各 1 次），只由真实用户消息重置。中途提醒用掉的预算不占回合末重写的名额；重写那一步写完直接收尾，不会循环。
- **语音通话浮层**：显示和朗读的回复同样是重写稿。`client.js` 的 `withoutRewrittenDrafts` 按重写提示的 `source.summary`（`adhd.js` 的 `REWRITE_NOTICE_SUMMARY`）丢掉同一回合里提示之前的长稿。
- **看到的效果取决于视图**：DSH 原生「对话」标签里，长稿折叠在「已完成，用时 …」里，只露出短答案（隔离实例真机验证）。第三方插件 `@adamaik/dsh-better-display` 的「阅读」标签按它自己的设计把早前正文渲染成淡色旁白、始终展开，长稿留在短答案上方。

**UI 交付物豁免（本插件新增）**

- **对话正文**：受全部长度规则约束。
- **UI / 画布**：**豁免**。`render_ui` / `render_canvas` / `render_scene` / `render_mechanism` 产出的是交付物，不是闲聊；里面可以完整、密集、多段。
- **`render_text` 不豁免**：它渲染的是文字，仍然是文字通道。否则「调个 `render_text` 包一层」就成了绕过简洁要求的一行后门。它在 `render_text` 里带的字数**照算**。
- 一轮里既有渲染又有长正文 → **整轮豁免**。理由：把「围绕交付物的说明」和「交付物本身」切开不可判定，而误伤一份正常交付物的代价高于漏掉一段啰嗦说明。豁免只关掉长度纠正，形状规则（先给动作、编号、无客套）仍由常驻 prompt 约束，下一步也照常重新计量——豁免不会粘到下一轮。

判据集中在一个纯函数里（`isUiTurn(toolCalls)` / `shouldEnforceBrevity({toolCalls, chars, config})`），单测覆盖，不散落在 handler 里。

**开关与阈值**（`cordis.patch.yml` 的 `discipline-whale-brevity` 行，或沿用 `discipline-whale-main` 行）：

| 键 | 默认 | 含义 |
|---|---|---|
| `maxProseChars` | `1200` | **普通对话**正文上限；`0` = 不写正文 |
| `decisionProseChars` | `400`；省略时派生 `max(400, maxProseChars × 5)` | **选项/解释类**回合的上限 |
| `maxCorrections` | `1` | 每用户轮、每个边界（中途提醒 / 回合末重写）各最多几次；`0` = 从不注入 |
| `enabled` | `true` | `false` 关掉整套纪律（prompt 段和纠正一起） |

**两层口径：普通对话强压，选项类允许结构化**（`isDecisionTurn`）

| 回合类型 | 判据 | 处理 |
|---|---|---|
| 纯聊天 / 判断 / 边界 / 待决策 | 默认 | **强压**：结论 + 下一个动作，正文 3 行以内 |
| 选项 / 证据 / 解释 | 命中「我有哪些选项 / 对比 / 利弊 / 为什么 / explain / options」等 | **允许结构化**，但只能是编号、每项一行（一行权衡 + 推荐），**不是散文段落** |
| UI / 画布交付物 | 本轮调过渲染工具 | **整轮豁免**，不受任何长度限制 |

为什么要分层：把「我有哪些选项」压成两行等于删掉答案。这个例外只放宽**长度**，形状（编号、一行一项）不变——`decisionShapeContract()` 同时被 prompt 和测试引用，保证说的是同一句话。

**显式值永远优先。** 写一个数字就是那个数字，不与 `maxProseChars` 比较；只有**省略**时才派生。可观测面：`resolveBrevityConfig` 返回 `decisionSource`（`explicit` / `derived`）与 `notes`，`installBrevity` 把**被拒绝**的值打到 logger（例如 `decisionProseChars: 0 is not a positive integer; derived 6000`）。显式值即使低于聊天预算也照用，只在 `notes` 里注明「选项轮不比聊天宽」——按你写的执行，同时让你看得见。

> 这条规则曾经是反的：旧实现要求「必须严格大于 `maxProseChars`」，否则就丢弃并换成派生值。后果是出厂的 `1200 / 400` 实际解析成 **6000**（文档写的 400 的 15 倍），而且没有任何告警、没有任何测试发现——因为那行配置等于摆设。
>
> **现在的口径（用户拍板）**：显式值**直接采纳、不与 `maxProseChars` 比较**；只有省略、非正数或非有限数时才派生，派生值保证 `>= max(maxProseChars, 400, maxProseChars × 5)`。这样「派生值不比普通预算小」这条安全性只约束**派生**，绝不会否决操作者写下的数字。出厂的 `1200 / 400` 现在真正生效——`test/adhd.mjs` ok 15 直接断言「500 字的解释类回复会被 400 触发纠正」。

> 分类器是启发式的，且**刻意偏向宽松**：把聊天误判成选项类，代价是这一轮预算宽一点；反过来会删掉用户要的答案。

**prompt 教的是可数的锚，不是字符数**：模型数不准 1200 字符，但数得准行数。规则里写的是「正文 3 行以内」，并给出**发出前强制自检**（超了就删到 3 行内再发，删的顺序：客套 → 复述 → 背景 → 修饰 → 例子）。字符阈值只用于**事后判定**，不进 prompt。

非法值**回落**到默认而不是抛错——照 `resolveGuardConfig` 的规矩：一个坏数字不许把主行带下去。

**和 guard 的三道刹车互不干扰**：`guard.js` 数的是**读类调用次数**，这里数的是**输出字符数**，两套计数器、两套监听器，`tools/pre-execute` 这条水线上本模块**永远放行**（不 deny、不 cancel）。测试里断言了两者注册的是**两个独立的** `agent/assistant-stream` 监听器。

**作用域（最关键的一条）**：主会话有，worker **没有**。worker 的价值在于回报详细，给它加简洁约束会直接毁掉回报质量。所以每个 handler 先读 `agent.session.header.agentPreset`，不等于 `discipline-whale` 就 `next()` 放行，**连计数器都不建**。preset identity 读不出来时也放行——不确定时宁可主会话漏约束，不许误伤 worker。

**验证了什么、没验证什么**：`node test/adhd.mjs`（28 项）覆盖纯函数、真实 skill registry 的 scope 隔离、worker 放行、两个边界各自的预算、回合末只量最终答案、UI 豁免、`render_text` 不豁免、config 回落；`test/contract.mjs` ok 27 断言这行**只声明在主 preset**。回合末重写在隔离实例上用真模型跑通（3711 字单步回答 → 同一回合重写成 472 字，原生对话视图只露出短答案）。「模型首稿是否真的变简洁」「豁免会不会被滥用」仍属未验证。

## 语音对话（像打电话一样）

侧边栏「自律鲸鱼」页之外，界面上还有一个浮动的「开始通话」按钮（挂在 `shell.overlay`，所以切到会话页也不会消失）。点它之后：

1. **开始听**：页面里的 **Silero VAD**（`@ricky0123/vad-web` 的 `MicVAD`）逐帧判断有没有人在说话，状态条显示「正在听 · 说完停顿一下就发送」；
2. **说完停顿 2 秒**（可在设置里改成 1 / 2 / 3 / 5 / 8 秒）这句就结束，只把这段语音（含开头 0.5 秒）编码成 WAV 上传识别；不足 0.5 秒的短促声音算误触，不上传；
3. 上传前先过**近场音量门**：这段语音的响度低于 -45 dBFS（离麦克风太远的人声）就不上传；
4. 服务端用 `verbose_json` 转写，**逐段丢掉 Whisper 拿不准的内容**（`no_speech_prob ≥ 0.6`、`avg_logprob < -1`、`compression_ratio > 2.4`），再对一份中英「幻觉短语库」做匹配（「字幕由 Amara.org 社区提供」「谢谢观看」这类）；全被丢掉就**不发送**，浮层只显示一行「这段听起来是背景声，没有发送」；
5. 留下的识别文本通过 **`POST /api/discipline-whale/voice/say`** 交给主会话。服务端用 `sessionController.prompt` 的 **`steer`** 模式，也就是 `send_to_session` 默认的步边界插话，不另造消息通道：
   - 鲸鱼正在干活：这句是**插话**，等它当前这次工具调用结束，在同一个回合的下一步带着这句重新规划；
   - 鲸鱼空闲：这句直接唤起一个新回合。
6. **说完一句立刻就能说下一句**：一句结束后话筒继续听，不等鲸鱼回复。几句话按说出的顺序排队识别、依次发送；状态行同时说明旁边在发生什么（「识别中 · 可以接着说」「鲸鱼在想 · 接着说，会在它这次工具调用结束后插进去」）；
7. **主界面同时显示这段对话**：通话开始时、以及每一句发出时，主界面都会打开自律鲸鱼主会话，你说的话和鲸鱼的回复出现在会话里，浮层上同时显示最近说的一句和鲸鱼最新的回复——两处是同一份会话记录；
8. 鲸鱼的回复在后台跟踪（`createReplyFollower`），它这一回合结束就显示在浮层上；
9. **挂断**随时可点；挂断、切会话、页面隐藏或插件卸载都会停止收音、释放麦克风，并作废迟到的识别结果。

**人走开了也不会自己发消息**（离开防护，`createAwayGuard`）：

- 连续 **3 段**都被判成背景声（音量门或服务端过滤），自动关闭话筒，浮层提示「连续几段都像背景声，已关闭话筒。点话筒继续。」；
- 累计**收音 2 分钟**都没有发出一条消息，同样自动关闭话筒。只计「鲸鱼空闲、正在等你说」的收音时间：鲸鱼干活、朗读、静音、话筒关着的时间不算；你点过任何控件也会重新计时；
- 页面切到后台时关闭话筒（通话在独立窗口里进行时例外，因为独立窗口仍在屏幕上）。

收音时关闭浏览器的**自动增益**（`autoGainControl: false`），回声消除和降噪保留：自动增益会把房间另一头的说话声放大到近讲的音量。

> **朗读 = 浏览器语音合成（fallback，非真实 TTS），默认关闭。** 通话条右侧的喇叭按钮与设置页「通话 → 朗读回复」开关是同一个状态；打开后用 `speechSynthesis` 念出回复。它没有独立凭据、音色与配额管理，声音取决于设备，和「接入一个真实 TTS 通道」（云端 key 或本地模型）不是一回事。
>
> 真实 TTS（云端 key 或本地模型）**尚未接入**。关闭朗读时，回复只显示在浮层上，话筒一直在听，不会等待任何语音事件。打开朗读时，念回复的那几秒**暂停检测**（流保持 live，不重新申请麦克风），免得扬声器的声音被当成你的下一句；你正说到一半时，朗读会等你这句说完再开始。

### 话筒 ≠ 静音：两个独立控制

用户要求这两件事分开，实现里就是两套状态，各自可见、互不代替：

| 控件 | 管什么 | 开 | 关 |
| --- | --- | --- | --- |
| **话筒**（`data-dw-control="mic"`） | **麦克风设备/权限** | `getUserMedia` 拿到流，系统指示灯亮 | 暂停检测并停掉所有 track（静音中也一样），**设备真正释放**，指示灯灭；挂断时再销毁检测器、关闭它的 AudioContext |
| **静音**（`data-dw-control="mute"`） | **是否处理数据** | （静音态）**语音检测暂停**：流仍然 live，但不分析任何一帧、不上传、不发送；正在说的那段直接丢弃 | 在同一条流上恢复检测，不再重新申请麦克风 |

状态机的四条规则（`client.js` 的 `createCallControls`，`test/dock.mjs` ok 1 逐条钉住）：

- 话筒关着时**不能静音**：静音按钮 `disabled`，`title` 写明「话筒关闭时不需要静音」，而不是灰着不解释；
- 静音**不碰设备**：track 仍然 live，`MicVAD` 暂停在这条流上（`createTurnTaker` 的 `mute()` 用自定义 `pauseStream` 保留流），解除静音直接 `start()` 续上；
- 话筒关闭时会**清掉已按下的静音**，不会留一个悬空状态；
- 两个按钮各有自己的 `aria-pressed`；「话筒开 + 静音开」与「话筒开 + 静音关」在 DOM 上是两种明确不同的状态。

**一直在听**（`test/dock.mjs` ok 9）：一段语音结束后检测继续跑在同一条流上，下一句随时可以开始；「说完了」和 60 秒上限只是把正在说的这段切下来交出去，切完接着听。`createTurnTaker` 把静音（`mute()`，保留流）、关话筒与页面隐藏（`hold()`，停掉所有 track）、「说完了」与 60 秒上限（`finish()`）、挂断（`close()`）映射到 `MicVAD` 的 `start` / `pause` / `destroy`，并用 `onSpeaking` 报告「这句是否正说到一半」。`test/dock.mjs` ok 2、3、9 用一个按 vad-web 0.0.31 源码行为写的假 `MicVAD` 逐条钉住。

### 设置界面（API Key / Base URL / 模型 / 语言）

通话条左侧（或未通话时「开始通话」旁）的齿轮打开设置面板。面板是一级总览 + 两个二级页：

| 页面 | 内容 |
| --- | --- |
| 总览 | **通话**：「朗读回复」开关（附 fallback 说明）；**语音识别**：key 来源状态点 + 「测试连接」、当前服务摘要（模型 · 主机 · 语言）；**朗读引擎**：「真实 TTS · 未接入」入口 |
| 服务与密钥（二级） | `baseUrl`、`apiKey`、`model`（转写模型）、`language` 四个字段，「清除已保存的 key」开关，保存 / 测试连接 |
| 真实 TTS（二级） | 四个禁用占位字段与说明（见下） |

**TTS 那一块怎么写，是有分寸的**：面板里保留四个**禁用占位**——`Base URL`、`模型`、`音色`、`API Key`，每格都标「未接入，留作将来」，页尾明确写着「真实 TTS 需要它自己的那把 key，与「服务与密钥」里的转写 key 不是同一个」。措辞同时避免两个错误说法：

- 不写成「**已接入 TTS**」——它不是；
- 也不写成「本插件没有 TTS」——**当前有浏览器内置语音合成作为 fallback**（通话条上的「朗读回复」，默认关闭），这是真实存在的朗读能力，只是没有凭据、音色、配额管理，声音取决于设备。

即：**fallback 有，真实 TTS（MiniMax 等）没有**；占位留着是为了将来接入时不用改结构，而不是让人以为现在填了就能用。`/voice/status` 与 `/voice/settings` 的 `tts` 字段同样如实描述：`integrated:false`、`fallback:"browser-speech-synthesis"`、`fallbackDefaultOn:false`、`needsOwnKey:true`、`configurable:false`。

**key 放在哪、为什么**（先查了 Host 有没有现成的面）：

1. **优先用 Host 自己的凭据面 `ctx.credentials`**（`@deepseek-ai/dsh-credentials-local`）。它写 `$DSH_HOME/.credentials.yaml`、**权限 0600**、外部改动热重载、`describe(ref)` 只回 `{ configured, source }`（`source` 是 `file`/`env`）。这是产品已有的密钥设施，**没有理由再造一个**。
2. 该面**不一定挂载**（minimal/headless 组合里没有），所以 `voice-settings.js` 补一条回落：插件自己的数据文件 **`$DSH_HOME/discipline-whale/voice.json`，权限 0600**，原子写（temp + rename，temp 就以 0600 创建，不存在「先可读后 chmod」的窗口）。这个文件同时存非密字段（baseUrl / model / language），因为它们没有 Host 面可用。
3. 用了 `ctx.credentials` 时**不会**在插件文件里再留一份 key 副本；该面抛错时自动回落到插件文件，语音不会因此不可用。

**回落顺序（已定并实现）：设置界面 → 环境变量 → 未配置。**

为什么设置优先于环境变量：与 Host 自己凭据面的既定语义一致（`dsh-credentials-local` 明确让「用户在产物里存的值」压过继承环境，注释原文是保证 `a credential the user explicitly saved in the product must take effect consistently`）。同时 `DW_STT_API_KEY` / `DW_STT_BASE_URL` 仍是可用的零配置路径；`/voice/status` 会**报告 key 来自哪一层**（`keySource`：`settings` / `env` / `none`），UI 直接显示「设置界面（已保存）」或「环境变量 DW_STT_API_KEY」。

**测试连接**按钮打一次 `GET {baseUrl}/models`（轻量、不计费、不需要音频），把结果分成 `ok` / `invalid-key`(401/403) / `endpoint-not-found`(404) / `backend-unreachable` / `backend-timeout`(15s)，每条给可读原因。选 `/models` 而不是空音频探测的理由：空音频会被计费，而且可能因为容器格式失败——那会把「key 是好的」误报成「key 坏了」。

**key 的可见性**：不进日志、不进任何 HTTP 响应体、不进仓库。表单的 key 输入是 `type="password"` 且**永不回填**（服务端本来就不返回值）；「留空 = 不修改」，要清除必须打开「清除已保存的 key」开关（只在 key 来自设置界面时出现；再关掉就恢复「不修改」）——这样一次误提交不会抹掉已存的 key。`test/settings.mjs` 对每个响应与每条日志都断言 key 不出现。

### 四个端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/discipline-whale/voice/status` | 是否配置了 key（不返回 key 本身）、**key 来源 `keySource`**、baseUrl、模型、语言、大小/时长上限、朗读能力描述（`tts.integrated:false` + `fallback:"browser-speech-synthesis"` + `needsOwnKey:true`） |
| POST | `/api/discipline-whale/voice/transcribe` | 上传一段录音（`audio/wav` 或 `audio/webm` 等，见 `ACCEPTED_AUDIO_TYPES`），返回 `{ text, model, audioSeconds }` |
| POST | `/api/discipline-whale/voice/say` | `{ text }` → 以 `steer`（步边界插话；鲸鱼空闲时唤起新回合）交给**记录在案的主会话**；请求体里的 `sessionId` 会被忽略 |
| GET / POST | `/api/discipline-whale/voice/settings` | 读/写 key-free 的配置描述；写 `{ baseUrl?, apiKey?, model?, language? }` |
| POST | `/api/discipline-whale/voice/test` | 用（可选的）草稿值打一次 `/models`，回可读的成功/失败原因 |

`say` 只认 `state.json` 里的主会话 id，所以页面脚本没法借它往任意会话里塞消息。设置接口**只返回描述**：`hasApiKey` / `keySource` / `apiKeyEnv`，没有任何字段能承载 key。

### 通话条独立于会话页 / 独立窗口

**两层，边界不同，这里说清楚：**

| 层次 | 做不做得到 | 本插件怎么做 |
| --- | --- | --- |
| **浏览器内、脱离会话页存在** | ✅ 可以 | 通话条挂在 `shell.overlay`，切面板/切会话都不消失；再点「独立窗口」把它搬进一个独立小窗 |
| **浏览器最小化后依然可见** | ❌ 普通网页做不到 | **不承诺**。最小化时页面通常仍在跑（音频、定时器继续），通话**不断**，但窗口不可见，也不可能画到浏览器之外 |
| **真正的桌面宠物（浏览器外常驻）** | 需要原生壳 | **本次不做**，评估见下 |

独立窗口的实现优先用 **Document Picture-in-Picture**（`documentPictureInPicture.requestWindow()`，Chrome/Edge 116+）：一个 **always-on-top** 的 OS 窗口，由本页持有，页面关闭即消失。不可用时回落到 **`window.open()` 弹窗**（保留引用，`pagehide` 时收回状态）；两者都不可用时**留在页面内**，并在 UI 里说明「当前浏览器不支持独立窗口」——不假装成功。`requestWindow` 需要**用户手势**，没有手势会被拒，此时也回落到弹窗（`test/dock.mjs` ok 4、ok 8 覆盖三条路径）。

> **要让通话条在浏览器最小化 / 关闭浏览器后依然常驻，只有原生壳能做到**：Electron/Tauri 的 `alwaysOnTop` 原生窗口，或 macOS 菜单栏 App（`NSStatusItem`）。那是另一个工程（打包、签名、自动更新、与 `dsh web` 的 IPC），本插件是 DSH 的 Web 插件，没有这条通道。本插件提供的是「浏览器内的置顶小窗」，不是桌面常驻。

### 拖动、贴边收起与调整大小

**整块通话条都能拖**：按住卡片、控制条、任一按钮拖动即可移动；按下后移动不到 5px 仍是普通点击，拖完松手的那次点击会被吞掉，不会误触按钮。输入框保留自己的指针行为。用**原生 Pointer Events + `setPointerCapture`** 实现，不引任何依赖。

- **拖不出页面**（纯函数 `dockDragFrame`，`test/dock.mjs` ok 14 验算）：拖动中的每一帧都在视口里，碰到上下左右边就停在 16px 边距处。继续往任意一条边外推（左右超出自身宽度的 30%、上下超出自身高度的 30%，最多 120px），面板**在拖动中就变成那条边上的麦克风小悬浮窗**，指针再往外走它也只沿着这条边滑动；往回拉又变回面板。
- **松手落点**（纯函数 `dockRelease`，`test/dock.mjs` ok 12 验算）：放在页面中间就停在那里；靠近左右边 72px 内贴齐边距；松手时已经是边上的麦克风小悬浮窗，就**贴边收起，只剩麦克风按钮**，位置就是拖动时看到的位置。
- **收起后**：只显示麦克风光球，光球仍按通话状态动；点按 = 开关话筒（没在通话时 = 开始通话）；沿边拖动可挪位置，拖到另一条边 72px 内就换到那条边；**拖离边缘**就重新展开成面板。
- **调整大小**：鼠标移到卡片上，空出的那一侧顶角出现拐角把手，拖动调宽度和卡片高度（纯函数 `dockResize` 负责 clamp，最小 300×140、不超出视口边距）。控制条锚在底部，卡片向上长。
- 位置与大小存在组件 state 里：切到独立窗口再收回也保留。独立窗口里由系统窗口负责移动和缩放。

**为什么不引库**：`client.js` 是 `window.__ModuleLoader__` 里的 plain JS，**没有构建步骤**，插件也**不允许外链 CDN**。`react-rnd` 会带入 `react-draggable` → `clsx` + `prop-types`，`@dnd-kit/core` 会带入 `@dnd-kit/utilities` + `accessibility`；任何一个都得手工 vendoring 进仓库，而它们的收益（拖动+缩放）在这里只用得到「拖动 + 吸附」这一小块。原生实现几十行，含触摸/笔，且不动打包结构。

### 换外观：给接手视觉的人

视觉层与逻辑层是**分开的**，换外观只需要动样式和 DOM 构建函数，不需要碰状态机、权限、音频处理或 PiP 生命周期。以下是接手的全部信息。

#### 1. 渲染入口与挂载点

| 项 | 位置 |
| --- | --- |
| 通话条视图 | `client.js` 的 `dockView(input)` —— 纯函数，`input` 是状态快照，返回 React 元素树 |
| 设置面板视图 | `client.js` 的 `settingsView(input)` —— 同上 |
| 组件本体（状态/副作用） | `makeVoiceDock(ctx, t)` 返回的 `VoiceDock` |
| 样式唯一入口 | `client.js` 的 `dockStyles()`，返回**一整段 CSS 字符串**（已导出，可被测试与替换层直接读取） |
| 挂载 slot | `shell.overlay`，注册 id `discipline-whale-voice`，`order: VOICE_DOCK_ORDER`（`test/client.mjs` ok 5 守住） |
| 图标 | `MicGlyph`（话筒/静音）、`SpeakerGlyph`（朗读）、`HangupGlyph`（挂断）、`DetachGlyph`（独立窗口）、`GearGlyph`（设置）、`LockGlyph`（隐私小字）、`ChevronGlyph` / `CloseGlyph`（设置页导航）、`VoiceGlyph`（未开始通话时的光球按钮）；全部经 `strokeIcon()` 输出内联 SVG |

**约束**：`dockView` / `settingsView` 只读 `input`，不读 ref、不发请求、不做决定。所有决定都在组件里，因此替换这两个函数不会改变任何行为。

#### 2. 状态名与含义

`status` 是**话筒这一路**的阶段，只有这几个值。`dockVisualState()` 把它和两个控件合成**一个视觉状态**，挂在 `.dw-dock` 根节点上（`.dw-status-<state>`），状态点、光球动效都只读这一个 class：

| 状态 | 含义 | 麦克风 |
| --- | --- | --- |
| `ready` | 待命 | 视话筒开关 |
| `calibrating` | 准备收音：第一次加载语音检测组件，之后是恢复检测 | 开 |
| `listening` | 正在听；说完停顿 2 秒（可调）就发送，发送和鲸鱼干活期间也一直在听 | 开 |
| `speaking` | **仅当朗读开关打开时存在**：浏览器语音合成正在念，检测暂停 | 开（不检测） |
| `error` | 收音没能开始（权限、检测组件加载），文案见 `error` 键 | 关 |

识别与发送、鲸鱼干活和话筒**并行**，所以它们不是阶段，而是两个旁路值：`sending`（还在识别或发送的句数）与 `whaleBusy`（鲸鱼在干活，或刚发出的一句还没等到回合开始）。两者都会点亮 `.dw-busy`，并由 `dockStatusKey` 改写状态行文案：`listening` 时有句子在路上显示 `statusSending`（「识别中 · 可以接着说」），鲸鱼在干活显示 `statusListeningBusy`（「鲸鱼在想 · 接着说，会在它这次工具调用结束后插进去」）；`ready` 时鲸鱼在干活显示 `statusThinking`。某一句识别或发送失败只在卡片上显示红字，话筒照常在听。

**注意**：朗读默认关闭，此时**不存在 `speaking` 阶段**。另外有两个**优先于 status** 的派生状态，由 `dockStatusKey` 决定文案：

- `deviceoff` / `statusDeviceOff` —— 话筒关着（覆盖上面任何状态，因为此刻没有音频在处理）；
- `muted` / `statusMuted` —— 话筒开着但静音（设备在跑，帧被丢弃）。

`error`（带具体原因时）优先于这两者。

#### 3. 控件语义（不要从样式反推）

通话条是两个平面：上面的卡片（状态行、识别结果气泡、鲸鱼回复、隐私与朗读小字），下面的控制条 `(设置) ( 静音 | 光球=话筒 | 朗读 ) (挂断)`。

| 控件 | `data-dw-control` / class | 语义 | 视觉 |
| --- | --- | --- | --- |
| 话筒 | `mic` / `.dw-ctl.dw-ctl-mic.dw-orb`，开时加 `.is-on` | **麦克风权限与设备**：开 = `getUserMedia` 拿流；关 = 暂停检测并停所有 track（静音中也一样），系统指示灯灭；AudioContext 只在挂断时随 `destroy()` 关闭 | 胶囊正中的光球；动效即话筒状态（待命慢呼吸、准备收音中速呼吸 + 淡光晕、正在听快呼吸 + 旋转光晕 + 外扩波纹、朗读紫色律动、静音褪色、话筒关灰色 + 斜杠话筒、出错红色） |
| 静音 | `mute` / `.dw-ctl.dw-ctl-mute`，静音时加 `.is-on` | **不处理数据**：设备仍在，但每帧直接丢弃，不进 VAD、不上传、不发送。话筒关着时 `disabled`，`title` 说明原因 | 光球左侧的话筒图标；静音时斜杠话筒 + 琥珀底 |
| 朗读回复 | `.dw-toggle`，`aria-pressed` | 浏览器语音合成 **fallback**，**默认关**；不是真实 TTS | 光球右侧的喇叭图标；开时强调色底 |
| 挂断 | `.dw-round.dw-hangup` | 释放设备、作废迟到的转写、收回独立窗口、结束通话 | 控制条右端的红色圆钮 |
| 设置 | `.dw-round`（`GearGlyph`） | 打开 `settingsView` | 控制条左端的圆钮 |
| 说完了 | `.dw-chip`（仅 `listening`/`calibrating` 且未静音、话筒开着时出现） | 立刻切下正在说的这段并发送（`MicVAD` 暂停时提交，随即在同一条流上继续检测）；没在说话就提示「没听到有效语音」 | 状态行右侧的反色小胶囊 |
| 处理中 | `.dw-busy`（`sending > 0` 或 `whaleBusy`） | 派生指示：有句子在识别/发送，或鲸鱼在干活 | 状态行里三个跳动小点 |
| 独立窗口 | `.dw-icon-button`（`DetachGlyph`） | 把通话条搬进 Document PiP / 弹窗；在小窗里同一个按钮是「收回窗口」 | 卡片右上角图标 |
| 拖动 | 整个 `.dw-dock-host`（输入框除外） | 移动 5px 以上算拖动，否则是点击；拖不出视口；推过任意一条边时在拖动中就画成边上的麦克风按钮，松手即贴边收起 | 卡片上光标为抓手 |
| 贴边收起 | `.dw-dock-docked`，宿主带 `data-dw-docked="left|right|top|bottom"` | 只剩麦克风控件（同一个 `data-dw-control="mic"`）；拖离边缘展开 | 边缘的圆形光球 |
| 调整大小 | `.dw-resize[data-dw-resize="left|right"]` | 空出一侧的顶角把手，改宽度与卡片高度 | 悬停卡片时出现的拐角 |

图标按钮的可读名称放在 `aria-label` 和视觉隐藏的 `.dw-sr` 文本里，屏幕阅读器与测试都能读到当前状态。

两个按钮的 `aria-pressed` 是**各自独立**的：`[话筒开, 静音关] = [true,false]`、`[话筒开, 静音开] = [true,true]`。把它们合成一个开关就是错的。

#### 4. 现有实现假设过的尺寸与断点

| 假设 | 值 | 出处 |
| --- | --- | --- |
| 通话条宽度 | `380px`（`max-width: calc(100vw - 32px)`）；宿主列本身 `pointer-events:none`，只有子元素接收点击 | `.dw-dock-host` |
| 卡片高度 | 最高 `min(52vh, 440px)`，识别结果/回复区内部滚动 | `.dw-card` / `.dw-transcript` |
| 默认位置 | 右下角，距右 20px、距底 `--dw-dock-bottom`（144px）：在会话页（含自律鲸鱼主会话）浮在底部输入框之上，发送按钮可点；新会话空白页的输入框居中，矮窗口下打开的通话条会压住它的右半部分（见「已知限制」）；拖动后改由 `data-dw-anchor` + `--dw-dock-x/y` 定位 | `.dw-dock-host` |
| 窄窗断点 | **≤768px**：左右边距收到 8px，宽度占满，卡片最高 42vh | `@media (max-width:768px)` |
| 设置面板 | 与通话条同宽，最高 `min(600px, calc(100vh - var(--dw-dock-bottom) - 40px))`，内部滚动 | `.dw-settings` |
| 配色 | 全部读宿主主题 token（`--dsw-alias-label-*`、`bg-layer-2`、`border-l2`、`interactive-bg-*`、`state-*`），经 `.dw-dock-host` 上的 `--dw-*` 一层转接，自动跟随明暗主题 | `dockStyles()` |
| 拖动边距 / 吸附距离 | `margin: 16`、`snapDistance: 72`（逻辑参数，非样式） | `snapDockPosition` 调用处 |
| 拖动位置表达 | 逻辑写一个边（`data-dw-anchor="left|right"`）和两个**数字**：`--dw-dock-x` = 距该边、`--dw-dock-y` = 距底；尺寸写 `--dw-dock-w` / `--dw-card-h` 并置 `data-dw-sized`。由 CSS 决定它们移动哪些盒子 | `onDragMove` + `dockGeometryStyle` + `.dw-dock-host[data-dw-anchor]` |
| 独立窗口初始尺寸 | `400 × 340`（PiP）/ `400 × 360`（弹窗） | `detachDock()` |
| 独立窗口内的外观 | 由 `body.dw-detached` 这一条 class 决定（隐藏缩放把手、去固定定位、卡片撑满）；小窗没有宿主样式表，`dockStyles()` 在这里自带一份明/暗 token，`copyStylesInto` 照抄宿主 `<body>` 的 `data-ds-dark-theme` | `dockStyles()` |

#### 5. 换外观只需改这几处

**改 `dockStyles()` 一个函数（配色/圆角/阴影/间距/动效/布局）+ 需要改结构时改 `dockView()` / `settingsView()` 两个函数**——其余（状态机 `createCallControls`、收音 `createTurnTaker`、离开防护 `createAwayGuard`、窗口能力 `detachCapability`、落点 `dockRelease`、转写与过滤、设置路由）都不用碰。

两条硬约束，`test/dock.mjs` ok 11 会守住：

1. **所有视觉规则只能在 `dockStyles()` 里**，逻辑分支不得写 `element.style.*` 的视觉属性；
2. **几何通过 CSS 自定义属性传到样式层**（`data-dw-anchor` + `--dw-dock-x/y`，尺寸 `data-dw-sized` + `--dw-dock-w` / `--dw-card-h`），逻辑不直接写 `left/top/right/bottom`——所以换一套布局不会改坏拖动。

`data-dw-control`、`data-dw-tts`、`data-dw-test`、`data-dw-source`、`data-dw-page`、`data-dw-anchor`、`data-dw-docked`、`data-dw-sized`、`data-dw-resize` 这些 data 属性是**行为接口**，换外观时保留它们，测试和控件语义都依赖它们；`.dw-*` class 属于外观层，可随皮肤调整（`dockStyles()` 里 ok 11 点名的几个除外）。

### 收音与过滤参数

起停判断用成熟实现而不是自制规则：**Silero VAD**（LiveKit、Pipecat 等语音 Agent 框架用的同一个模型），浏览器里通过 `@ricky0123/vad-web` 运行。它依赖的 6 个文件（`ort.wasm.min.js`、`ort-wasm-simd-threaded.mjs` / `.wasm`、`bundle.min.js`、`vad.worklet.bundle.min.js`、`silero_vad_v5.onnx`）由插件自己的路由 `/api/discipline-whale/voice/vad/<name>` 从已安装的包里提供（`voice-assets.js`），**不走 CDN**。两个包写在 `package.json` 的 `dependencies` 里，安装插件时由 pnpm 拉取（onnxruntime-web 约 94 MB 解包，只用到其中 11 MB 的 wasm）。页面不是 cross-origin isolated，所以 onnxruntime 单线程运行。

浏览器端（`voice-silence.js`，`client.js` 镜像一份，`test/client.mjs` ok 1 比对两份）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `TURN_OPTIONS.model` | `v5` | Silero VAD v5 |
| `positiveSpeechThreshold` / `negativeSpeechThreshold` | 0.5 / 0.35 | 语音概率高于 0.5 开始、低于 0.35 并持续一段时间才算结束（Silero 自己的取值） |
| `redemptionMs` | 2000 | 停顿多久算说完；设置里可选 1 / 2 / 3 / 5 / 8 秒（`REDEMPTION_CHOICES_MS`，存在本浏览器） |
| `preSpeechPadMs` | 500 | 保留开口前的 0.5 秒，第一个字不丢 |
| `minSpeechMs` | 500 | 不足 0.5 秒的语音算误触，不上传 |
| `MAX_SPEECH_MS` | 60000 | 一直不停顿的语音在 60 秒处截断并发送（服务端还有 120s / 25MB 的硬上限） |
| `MIN_SPEECH_LEVEL_DBFS` | -45 | 近场音量门：低于它视为远处人声，不上传。**经验值**，按设备可能需要调 |
| `AWAY_MAX_REJECTIONS` | 3 | 连续这么多段被判为背景声就关话筒 |
| `AWAY_IDLE_MS` | 120000 | 累计收音这么久没发出消息就关话筒 |

服务端（`voice.js`）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `SEGMENT_LIMITS.noSpeechProbMax` | 0.6 | 段的 `no_speech_prob` 达到它就丢。**单独判断**：Whisper 自带的跳过规则要求「`no_speech_prob > 0.6` 且 `avg_logprob < -1`」，拦不住实测的底噪幻觉（Whisper 后端上 4 秒底噪识别成「由 Amara.org 社群提供的字幕」，`no_speech_prob` 0.83、`avg_logprob` -0.27） |
| `SEGMENT_LIMITS.avgLogprobMin` | -1.0 | 低于它的段丢弃 |
| `SEGMENT_LIMITS.compressionRatioMax` | 2.4 | 高于它（大量重复）的段丢弃 |
| `HALLUCINATIONS.markers` | 字幕致谢等 | 出现就整句丢弃（这些在对助手说的话里不会出现） |
| `HALLUCINATIONS.whole` | 「谢谢观看」等 | 只有整句完全是它才丢弃，句子里提到不受影响 |

### 隐私（必须看得见）

**录音会上传到服务端配置的转写服务**（OpenAI 兼容 `/v1/audio/transcriptions`，模型默认 `whisper-large-v3`，可在设置里改）。本地不落盘：录音只在浏览器内存里存在到上传结束，服务端转发后即丢弃，日志里不出现 key，也不出现完整音频。这条同时写在 UI 的浮层里和这里。

未配置 key 时，`/voice/status` 返回 `configured: false`、`keySource: "none"`，通话按钮点下去会明确显示「服务端没有配置语音识别的 key，语音识别不可用」，设置面板显示「还没有可用的 key」。**不会静默变灰**。

### 已知限制

- **回复的「一轮结束」是轮询近似**：客户端没有给插件提供回合结束回调，浮层读取 `ctx.sessions.binding(id).eventSource` 里的 `turn/end` / `assistant/message` 持久事件拿到**正文**（这是准的，按事件 `seq` 取「上次显示之后」的文字），但「什么时候去读」靠每 700ms 轮询会话 `running` 与事件窗口。只有工具调用、没有文字的回合不显示回复。
- **浮层显示的是主会话里鲸鱼最新的回复**：通话期间，不管这一回合是你的语音、你在输入框里打的字，还是 worker 回报唤起的，只要鲸鱼说了话，浮层都会显示（朗读打开时也会念）。这和「两处是同一份会话记录」一致。
- **朗读时听不到你**：朗读开启时，念回复的那几秒检测暂停（扬声器的声音会被麦克风收进去，`speechSynthesis` 的声音不经过浏览器回声消除）。想打断朗读，点喇叭按钮关掉朗读，话筒立刻恢复检测。
- **朗读只有浏览器语音合成 fallback，真实 TTS 未接入**：默认关闭，打开后走 `speechSynthesis`，声音与可用性取决于设备（系统没装中文声音时可能念英文或直接失败）。它没有服务端凭据、配额、音色选择与并发控制，因此**不要**把它当作「已接入 TTS」。
- **通话不被等待卡住**：发送从不等待回复，回复跟踪与话筒并行；朗读关闭（默认）时不碰任何语音接口，朗读开启时最多等到一个「有界」的结束信号（`onend` / `onerror` / 引擎拒绝 / 定时兜底，四者任一都会 settle）。三条都有 `test/client.mjs` ok 3a 看守。
- **浏览器最小化后小窗不可见**：这是 Web 平台边界，不是实现缺陷；见上面「两层」表格。
- **设置界面的 key 不显示、不回填**：这是有意的（服务端从不返回它）。要确认「存进去的是哪把」，只能靠「测试连接」的结果。
- **通话条的默认位置为会话页让路**：会话页输入框贴底，通话条默认浮在它上方（距底 144px）；新会话空白页的输入框在屏幕中部，窗口较矮时（例如 800×600、手机竖屏）**打开的**通话条会盖住它的右半部分和发送按钮。把通话条拖开即可，拖动后的位置在本次页面生命周期内保持（拆成独立窗口再收回后回到默认位置）。一个固定位置无法同时避开这两种输入框；通话条锚在底部是为了卡片变高时控制条不跳动。
- **离开防护挡不住「近处有人对着麦克风说话」**：音量门和过滤只能分出「远处的声音」和「Whisper 编出来的字」；如果旁边有人凑近麦克风正常说话，它会被当成你说的话发送。环境吵或旁边有人时，用静音按钮或直接关话筒最可靠。
- **近场音量门 -45 dBFS 是经验值**：不同麦克风的电平差异较大，声音很轻或离麦克风较远时可能被拦；如果常出现「声音离麦克风太远」，需要调低这个值。
- 麦克风权限、真人说话时的起停手感、PiP 真窗口、拖动手感都只能在真浏览器里确认。

## 记忆系统：无限对话流（`memory-row.js`）

主会话是一条不会结束的对话。它自己决定什么时候清工具输出、什么时候压缩，同时始终知道「用户是谁、我们正在做什么、做过什么」。

**分层**（OpenClaw 层级，Devin 条目格式 `- 内容 [source: …; added: YYYY-MM-DD]`）：

| 层 | 文件（`home/memory/`） | 谁写 | 怎么进上下文 |
|---|---|---|---|
| Instructions | `home/AGENTS.md` | 只经 `update_instructions`，且要附用户本轮原话 | 每步全量 |
| Soul | `SOUL.md` | `remember(target:"soul")` | 每步全量 |
| User | `USER.md`（Preferences + Now） | `remember`；Now 由后台 flush 轮换 | 每步全量 |
| Memory | `MEMORY.md` | `remember` + dream 提升 | 每步全量 |
| Activity | 由派工记录生成 | 程序 | 每次派工状态变化后刷新 |
| Daily | `daily/YYYY-MM-DD.md` | 后台 flush / nudge，只追加 | 按需 `read` |
| Review | `DREAMS.md` | dream 的整理记录 | 给人看 |

**Activity（我们正在做什么）**：
- 工作区卡片：每个工作区一段 ≤200 字的介绍，写用户拿它在做什么、下一步想做什么。可通过 `set_workspace_intro` 修改，worker 回报时也能带上 `workspace_note`。
- 对话条目：鲸鱼派出的对话里，进行中的全部注入；最近结束的注入 max(5, ⌈进行中条数 × 40%⌉) 条。
- 消息 Tag：主会话某一轮里派了活，这一轮的用户消息就打上目标工作区的 Tag，派到几个工作区就打几个。
- 派工 bootstrap：向一个工作区派新会话时，brief 开头附上该工作区的介绍、用户说过的相关话、最近的交付。

**自动机制**：
- 清工具输出：压缩压力成立时先清工具输出（`pruner.js`）。最近 3 个用户 turn 保留，更早的换成一行占位，原文仍在 session log。
- 压缩：沿用 `dsh-compaction-basic`。
- flush：距压缩阈值 32K token 时跑一次后台隐藏调用，把值得留下的观察写进 daily，并更新 Now 和工作区介绍。
- nudge：距上次 nudge 满 10 个 DSH turn 时也跑一次，逻辑同 flush；进度存在游标里，重启后接着计。
- dream：主会话空闲、且距上次 ≥24h、新 daily ≥5 条时运行。它只输出操作列表，由代码执行，并受 6 条门禁约束（删除 ≤25%、条目必须有来源、hash 校验、预算、结构可解析，失败时只追加）。`dream_now` 可以手动触发。

**和宿主 `dsh-auto-memory` 的关系**：主会话的记忆由鲸鱼接管。首次启动时，鲸鱼 home 下已有的 auto-memory 条目会被迁进 USER / MEMORY，原目录改名为 `*.migrated-YYYYMMDD` 保留；SOUL / USER / MEMORY 三个文件和 `daily/` 目录在启动时就建好。主会话 agent 创建时，`memory_*` 工具从它的工具列表里移除，guard 再兜一层：万一被调用，引导去用 `remember`。宿主注入的用户级记忆（`<memory_context>`）在主会话里是只读参考。其它会话照常使用 auto-memory。

**客户端**：主会话每轮的回复尾部显示彩色工作区标签，点击打开对应的工作会话。派出去的会话在侧栏有工作区色点。工作区颜色在鲸鱼设置面板里修改。数据来自 `/api/discipline-whale/memory/{workspaces,tags,dispatched}`。

## 安装

```bash
# 从 GitHub
dsh plugin --profile web add github:huiyuanXP/discipline-whale

# 从本地源码：打包成 tarball 放进 $DSH_HOME/plugins/packages 再安装
scripts/install-local.sh          # 默认 profile: web
```

`install-local.sh` 装进 profile 的是一份打包副本，运行中的插件不指向开发目录；源码改动后重新跑一次脚本即可。

安装后**需要重启 DSH**：preset 内的插件行不受 HMR 管理（`restart-required: unmanaged-plugin`）。

## 数据目录

插件的全部数据都在 `$DSH_HOME/discipline-whale/`，和其他 DSH 插件的数据目录并列：

```
$DSH_HOME/discipline-whale/state.json                               ← 插件状态（主会话 id）
$DSH_HOME/discipline-whale/home/                                    ← 主会话的工作目录
$DSH_HOME/discipline-whale/reports/<workspaceId>/<reportId>.json    ← 报告
$DSH_HOME/discipline-whale/dispatches/<workerSessionId>.json        ← 派工检查点
$DSH_HOME/discipline-whale/dispatches/<workerSessionId>.abandoned   ← 用户放弃的派工
$DSH_HOME/discipline-whale/voice.json                               ← 语音设置（0600；仅在没有 Host 凭据面时存 key）
$DSH_HOME/discipline-whale/home/memory/                             ← 记忆文件：SOUL / USER / MEMORY / DREAMS.md、daily/
$DSH_HOME/discipline-whale/home/AGENTS.md                           ← 主会话运行规则（只经 update_instructions 写）
$DSH_HOME/discipline-whale/memory-state/                            ← 工作区卡片与颜色、消息 Tag、flush/dream 游标与锁
$DSH_HOME/.credentials.yaml                                         ← Host 凭据面（0600；优先，由 dsh-credentials-local 写）
```

`voice.json` 与 `.credentials.yaml` 都是 **0600**。仓库里**没有**、也**不许有** key：`.gitignore` 已经忽略 `.credentials*`，而 `voice.json` 只存在于数据目录。
新增的状态各占一个子目录，例如记忆状态放在 `memory-state/`。

每个报告一个 JSON 文件，原子写入（temp + rename）。损坏的文件会被列表跳过，不会拖垮整个 listing。

检查点是**路由事实**（dispatchId / 主会话 id / 工作区 / 派工时间），不含任务正文——正文在 worker 会话日志里。
`dispatch_task` 在返回前写一次，worker 首次生命周期事件再写一次同一路径（两边共用 `checkpoint.js` 的同一套路径与记录格式，所以不会各写各的）。
报告投递成功后删除。worker **超过催报次数**被标记 abandoned 时不删，因为那个 worker 之后仍可能真的报告，删了它就会退化成 orphan；只有用户通过 `abandon_dispatch` 主动放弃时才删除并留下放弃标记。

## 测试

```bash
node test/contract.mjs
node test/voice.mjs
node test/client.mjs
node test/dock.mjs
node test/settings.mjs
node test/guard.mjs
node test/adhd.mjs
npm run test:memory
node test/report-head.mjs
```

`npm run test:memory` 覆盖记忆系统：
- 条目与分层（`memory.mjs`）
- 工作区卡片、对话条目、Tag、bootstrap（`activity.mjs`）
- flush / nudge（`memory-flush.mjs`）
- dream 与门禁（`dream.mjs`）
- 清空型 pruner（`pruner.mjs`）
- 真实 store 串起 flush → dream → 注入的集成测试（`memory-integration.mjs`）
- 接线测试（`memory-wiring.mjs`）：memory 行注册、迁移、Tag、flush 触发、路由、派工 bootstrap、`workspace_note`、guard 拦截

28 项契约测试（编号 1–27，另加 15b），用假 Host 分别挂载两半；另有 `node test/voice.mjs` 13 项语音端点、幻觉过滤、起停参数、离开防护与检测文件路由测试、`node test/client.mjs` 9 项浏览器半边测试、`node test/dock.mjs` 14 项通话条控件/收音/窗口/拖动/贴边/缩放/文案/接缝测试、`node test/settings.mjs` 10 项设置与密钥测试、`node test/guard.mjs` 10 项主会话刹车测试、`node test/adhd.mjs` 13 项输出纪律测试、`node test/report-head.mjs` 10 项 `read_report` 读取模式测试：

1. 存储往返、长度截断、路径穿越防护
2. 主会话行注册 7 个工具，schema 在受支持子集内（遍历注册表，未列入清单的工具会直接失败）
3. **worker 行只注册 1 个工具**，且没有 dispatch / list / read / send / `list_dispatches`
4. `list_workspaces` 投影正确
5. `dispatch_task` 用 worker preset、下任务、拒绝歧义/未知工作区
6. `report_to_main` 存文档并投递到主会话
7. 无 dispatch 的会话不能报告；空 summary、非法 status 被拒
8. 静默 worker 被推回两次，第三次升级到主会话；已报告的 worker 不再被打扰
9. `send_to_session` 投递新决策（默认步边界 = `mode:"steer"`），空 message、非法 `at` 被拒
10. 重启后 worker 从磁盘检查点恢复派工并完成回报
11. 连检查点都没有时，报告落盘并标记 `orphaned`，绝不猜目标会话
12. 出错/中断的回合照样写检查点，恢复后只催一次
13. 恢复之后**强制回报**也生效（不只报告工具）
14. `list_dispatches`：空注册表返回空数组、三态正确、`elapsed` 不为负也不为 `NaN`
15. `dispatch_task` 自己就把检查点落盘 —— 派工返回后、worker 首个事件前重启也不丢
15b. 检查点写失败只加 warning，**派工照常成功**
16. 看板能吃下 worker 侧写入的 `recoveredFrom` / `orphaned` / 脏时间戳
17. 已投递的派工不会被后续生命周期事件「复活」成第二个检查点
18. home 目录被创建；连点两次也只新建、唤醒、记录一个主会话（`state.json`）
19. 启动检查把中断的派工推给主会话；`resume_dispatch` 唤醒 worker 并改投回报，`abandon_dispatch` 清掉检查点并留下放弃标记，worker 看到标记后不再被催报
20. 语音路由挂载在 home 行上，`say` 只投给记录在案的主会话（请求体里的 `sessionId` 被忽略）
21. `send_to_session` 的三种时机：`queue` 等回合、`at:"step"`（默认）落步边界且**不**中止、`at:"abort"` 才中止；冷会话中止失败也不谎报
22. 同一话题续接同一会话（`reused`）、已 reported 不复用、`writes` 重叠被拒、不相交才允许并行
23. **persona 纪律真的进了 system prompt**：按 Host 的方式（`dsh-system-prompt` + `dsh-scope` 里的 `dsh-persona` 行）组装出主会话 prompt，断言读预算自检句、插话段、诚实边界段都在，并断言**没有**把插话说成瞬时（`不是「立刻」`、`上下文不丢`、`最后手段`）；同一段文本**不进** worker preset
24. **三道刹车真的挂上了**：走真实的 `main.apply(ctx, config)` 路径，断言 `tools/pre-execute` 门禁与两条回话信号都已注册、`Config` 里的阈值原样传到 guard（配 3 就按 3 拒绝，不是默认 10）、未知字段被丢掉；同一个门禁下 worker 会话连读 20 个源码文件不受影响
25. **时机语义钉在 Host 源码上**：`steer` 落 `next-step`、`claim` 每个步边界都清空它、turn 循环首步后切 target —— 直接对 Host 源码断言；并断言 `prompt.mode` 只有 `queue`/`steer`、本插件默认 `step`。Host 升级改了语义，这条会红
26. **纯 `steer` 路径全程不 cancel**：默认与显式 `at:"step"` 都走 `mode:"steer"` 且 `cancel` 调用数为 0；`queue` 也不 cancel；只有 `at:"abort"` 调一次 cancel；`dispatch_task` 复用默认同样不 cancel。step 路径上只要出现 `cancel`，这条就红
27. **输出纪律只声明在主 preset**：直接对真实 `cordis.patch.yml` 断言 `discipline-whale/adhd` 行存在于 `preset-discipline-whale`、且**不在** `preset-discipline-whale-worker`；并断言全文件里只有**一个** preset 拥有这行（防止日后复制粘贴到 worker）

假 `prompt` **故意模仿真实实现**，会解引用 `signal` —— 这条强化曾抓出三个真实缺陷（信号未传、`exec` 参数缺失、dispatch 未标记已报）。

`node test/guard.mjs` 单独覆盖三道刹车（10 组）：白名单与看门狗口径的纯函数判定、第 11 次读被配额拒绝且拒绝文案含额度与「去派工」、回话刷新配额（且思考不算回话）、连续 10 次静默调用触发硬停+注入+配额重置、介入预算用尽后不再无限干预并只告知一次、home 全开/公用文档放行/源码与 `../` 被拒、符号链接按真实目标判定、**连续 12 次渲染不触发硬停**（防「正常交付被误判成埋头调研」）、以及**用真实 `cordis` + `dsh-scope` 包**搭出与 Host 相同的作用域图，证明 preset 里的监听器确实收得到 `agent/assistant-stream`、并证明 `session/event` 收不到（这就是实现不监听它的原因）。

`node test/adhd.mjs` 单独覆盖输出纪律（13 组）：`isUiTurn` 的豁免表（`render_ui`/`render_canvas`/`render_scene`/`render_mechanism` 豁免，`render_text` 和纯文字不豁免）、`shouldEnforceBrevity` 的「刚好等于上限算合规 / 超出报告 overBy / UI 轮豁免 / `enabled:false` 关闭」、`resolveBrevityConfig` 的具名默认值与**非法值回落**（负数、小数、字符串、`NaN`、`Infinity` 都不抛错）、规则文件是 prompt 段与 skill 的**同一来源**、`countTextInArgs` 让 `render_text` 里的文字照算、**组装出的主会话 prompt 含规则而 worker prompt 不含**、**用真实 `dsh-skill` registry 证明 skill 只落进主 preset 的 scope**（主会话看得到、worker 和 host 平面都看不到）、**worker 会话触发事件时被直接放行且不建计数器**、超长正文在下一个步边界最多注入一次且带归属标记、`render_text` 不买豁免、knobs 生效、`tools/pre-execute` **永远放行**（不与 guard 抢刹车）、以及 `main.apply` 真的挂上了两套独立监听器并把 knobs 透传过 `Config`。

## 已知限制

- **看板只有工具，没有 GUI 面板**。`list_dispatches` 是给主会话调的工具（也可靠 `present` 渲染）；侧边栏入口打开的是主会话，不是派工看板。要看状态还得问主会话，或在会话列表里找 worker。
- **主会话出现在会话列表的「未分组」里**。它不属于任何工作区，DSH 把这类会话归到「未分组」；日常从侧边栏「自律鲸鱼」入口进入即可。
- **工作区无描述字段**。路由只能靠标题/路径判断，准确性有限。
- **派工记录跨重启靠检查点文件，不靠内存**。`dispatch_task` 会在返回前把路由事实（dispatchId / 主会话 id / 工作区）写到 `$DSH_HOME/discipline-whale/dispatches/<workerSessionId>.json`，worker 首次生命周期事件会再写一次同一路径，所以「派工返回后、worker 首个事件前」重启也不会丢。投递成功后删除该文件。仍有边界：**worker 会话被删除/归档后再报告**，检查点可能已被清理，此时退化为 orphan 路径；**检查点写失败**时派工会照常成功但只在本次进程内有效，并在结果里给出 warning。
  `list_dispatches` 看的是**进程内**注册表，重启后为空 —— 它回答「现在谁在飞」，检查点回答「重启后这条派工还能不能找回」。两者分工不同，不要互相替代。
- **跨 preset 不共享**。每个 preset 装载独立的插件实例，所以 `dispatch_task` 的 `workerPreset` 必须精确等于 worker preset id。不匹配时会在派工阶段直接报错，不会让 worker 到报告时才失败。
- **`create_session` 靠 profile 层关掉，不是靠 preset**。`create_session` 由 profile 级 bundle `dsh-session-kit` 注册进 Host 工具层，能创建用户可见会话并下发首条 prompt，效果等于派工。preset 内部的 `plugins` 列表由 agent-preset-registry 挂进它自己的 PresetTree，跟 Host 树是两个组合，所以**在 worker preset 里写 `- id: dsh-session-kit` + `disabled: true` 关不掉它**（而且这种没有 `name` 的行会让整个 preset 装载失败）。本包的 `cordis.patch.yml` 因此改用**一条 profile 层按 id 定向的 patch** 关掉该行；它排在本 bundle 之前插入的 `dsh-session-kit` 之后生效。代价是**全局生效**：主会话也没有这个工具了（主会话本来该用 `dispatch_task`，不受影响）。未装 `dsh-session-kit` 的 profile 上这条 patch 只会告警「entry not found」并跳过，可以安全单独安装。模板里没有「只对 worker 关闭」的可行写法 —— 若要那种效果，需要在 preset 内挂一个对 agent 调 `ctx.tools.restrict({ deny: ['create_session'] })` 的插件行，本包未提供。
- **主会话只读 + UI**。主会话 preset 里 `tool-fs` 是 `read: true, readImage: true, write: false, edit: false`，并且 `tool-bash` / `tool-pwsh` / `tool-jobs` 三行都被禁用 —— 没有 shell，就没有 bash 重定向、`tee`、`sed -i` 这类绕道写文件的路子。`tool-jobs` 一并关掉，是因为主会话既没有 shell、也没有挂 `tool-terminal` / `tool-workflow`，自己造不出后台任务，`job_*` 只剩空列表（任务注册表本身仍在 Host 层，不受影响）。因此主会话**不能写总结文档**，也不能把文档落盘：它的产出只有对话正文和 UI 渲染。如果确实需要主会话落盘一份总结，得单独给 `write` 开例外（本包没有加）。
- **这些改动都要重启才生效，且没有在运行中的进程里验证过**。preset 行不受 HMR 管理；改动 `cordis.patch.yml` 后需重启 `dsh web`，**新建的**会话才会拿到新的工具面（已存在的会话仍用旧组合）。
  能验证到什么程度：用 `dsh --profile web --dump-config` 核对过**组合后的配置树**确实包含 `dsh-session-kit: disabled: true`、`write: false` / `edit: false`、`tool-bash` / `tool-pwsh` / `tool-jobs` 全部 `disabled: true`。这只是「配置写对了」，**不等于**「重启后实测生效」——实际工具面要重启一次、新建两个 preset 的会话各看一眼才能确认。这一步本包没有做，别把它当已验证。
- **输出纪律（`adhd.js`）的重写发生在流式输出之后**。长稿在生成时会实时出现在屏幕上，回合末重写落地、回合完成时它才折进过程控件；会话日志里长稿和短答案都保留。本模块给的是 ①常驻 prompt section（让首稿就短，真正承重的那一半）②中途提醒 ③回合末重写（超长的收尾答案被压缩重写一次；重写稿的长度由模型自己控制，真机一次实测 400 预算写出 472 字）。另外两条边界：**豁免判定是轮级的**（一轮里渲染过 UI，整轮正文都不计量，代价是可能漏掉一段啰唆说明；换来的是不误伤正常交付物）；**`render_text` 不豁免**，用它是绕不过去的。
- **输出纪律同样要重启，且已存在的主会话仍用旧组合**。`discipline-whale-brevity` 是 preset 行，preset 在**会话创建时**装配；改完 `cordis.patch.yml` 需重启 `dsh web` 并**新建**主会话，已开着的会话不会中途换上这套规则。本轮**没有**重启用户正在跑的进程。
- **persona 改动同样要重启，且已存在的主会话仍用旧 prompt**。persona 是 preset 行的一部分，preset 在**会话创建时**装配进 system prompt：改完 `cordis.patch.yml` 后必须重启 `dsh web`，并且**新建**一个主会话（或换用新会话）才会拿到新纪律；已经开着的那个主会话不会中途换人格。验证只做到「组合后的配置树里有这段文本」和「按 Host 的组装方式渲染出的 system prompt 包含这段文本」（`node prompt-probe.mjs discipline-whale`、契约测试 ok 23），**没有**在真机上断言模型的派工行为是否改变——那需要 A/B 观察，本包不做这个声明。
- **为什么输出纪律没做成第二个 `dsh-persona` 行**。更「干净」的想法是单独注册一个 persona 行、可独立开关。实测不行：同一个 preset 里两行 `dsh-persona` 都要注册 `deployment:persona-prefix` 这个 section，第二行会以 `prompt section "deployment:persona-prefix" is already registered in this scope` 直接让整个 preset 装载失败。所以改用**独立命名的 prompt section**（`discipline-whale:brevity`），紧跟在 persona 之后——同样可独立识别、可独立移除，也不会和 persona 抢槽位。
- **不用「每轮注入一条提醒」的替代方案**。Host 有 `agent/pre-step` 钩子可以在每个 step 往上下文里插消息（`dsh-time-context` 就是这么做的），但那样每轮都会往**对话历史**里写一条 `user/message`：用户可见、会被压缩、会干扰正常讨论，还得按会话 id 过滤才知道是不是主会话。persona 是每个请求重新组装的 system section，天然只对主会话生效、不进对话正文、不占用户消息位。所以选了 persona。

## 命名冲突核查

2026-10-20 实测：npm 上 `discipline-whale` / `discipline-well` / `dsh-discipline-whale` / `dsh-discipline-well` 全部未被占用；GitHub 上 `huiyuanXP/discipline-whale` 等三个候选名均可用；全网仅有 2 个无关仓库含 "whale" 字样。

## License

MIT（本包）。

本包的输出纪律（`adhd.js` + `skills/whale-brevity/SKILL.md`）改造自 [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)，该上游项目同样是 **MIT** 许可：

> MIT License
> Copyright (c) 2026 Ayoub Ghriss

上游的规则正文按本包口径**重写**（新增「UI 交付物豁免」一节，调整了规则编号与措辞，删掉了上游 `SessionStart` hook 的 opt-in 文件开关），保留了它的核心诊断与规则骨架，并保留 `SKILL.md` frontmatter 里的 `upstream` / `upstream-license` / `upstream-copyright` 三项署名。按 MIT 要求，原文版权声明与许可声明继续保留在此处；本包整体仍以 MIT 发布。
