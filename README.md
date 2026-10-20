# Discipline Whale · 自律鲸鱼

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**你只跟一个主会话说话**，由它判断内容该进哪个工作区、把活派出去；工作区会话干活、派生自己的子代理，**干完必须回报**。主会话读回报，向你转述，并把你后续的新决策再分发出去。

名字来自科幻片里那种能自主判断任务、处理繁杂事务的自律机器人。英文 `Discipline Whale`，中文「自律鲸鱼」。

## 它解决什么问题

DSH 里已经有 `subagent`（同一会话内的子代理）和 `dsh-webhook`（外部事件触发建会话）。但缺少一条中间路线：**由 Agent 自己把工作分发到另一个工作区的独立会话，并在完成后收到回报**。

这个插件补的就是这条线，并且把「必须回报」做成结构性约束而不是提示词自觉。

## 两个 preset，两种角色

安装后，Web GUI 的 preset 选择器里会多出两项：

| Preset | 角色 | 工具面 |
|---|---|---|
| **Discipline Whale** | 主会话：派工、汇报、讨论架构 | `list_workspaces` `dispatch_task` `read_report` `send_to_session` + **只读**文件（读/搜索/看图）+ 网页 + 提问 + UI 渲染。**无 shell、无写/编辑** |
| **Discipline Whale Worker** | 工作区会话：真正干活 | `report_to_main` + 完整编码工具 + 子代理 |

**关键的结构性保证**：`dispatch_task` 只存在于主会话 preset，`report_to_main` 只存在于 worker preset。worker 的子代理继承 worker preset，所以**子代理拿不到任何派工能力**——这是模块装载层面的隔离，不是靠提示词约束。

这条保证只覆盖**本 bundle 自己注册的工具**。像 `create_session` 这种由别的 bundle 注册进 Host 层的工具，不在 preset 的控制范围内（见下文「已知限制」）。

主会话不注册 `report_to_main`：它只会被回报，不会自己造一个。

## 五个工具

### `list_workspaces`（主会话）
列出所有已注册工作区：id、标题、路径、会话数。派工前用它决定归属。

### `dispatch_task`（主会话）
```json
{ "workspace": "soc-api-test", "task": "完整任务描述", "title": "可选标题" }
```
创建一个 worker 会话、下任务、返回 `dispatchId` + `workerSessionId`。worker 立刻开始执行。

任务描述里会自动附加「必须调用 `report_to_main`」的约定，即使 worker preset 的 persona 写得很简。

### `report_to_main`（worker）
```json
{ "summary": "一句话总结", "document": "详细文档正文", "status": "done|partial|blocked" }
```
**分成两半是有意的**：
- `summary` 被**主动推送**成主会话的一条消息，直接唤醒主 Agent —— 主会话不需要轮询、不需要调工具。
- `document` 落到磁盘，主会话只在需要细节时用 `read_report` 打开，不会撑爆上下文。

### `send_to_session`（主会话）
给运行中的 worker 追发新决策。`mode: 'queue'`，会立即唤醒目标。

### `list_dispatches`（主会话）
看板：本次进程里记录的所有派工，带 worker session、状态（`running` / `reported` / `abandoned`）、已派出多久。
支持按 workspace 片段过滤、按数量截断（默认 50，上限 200），新的在前。

两点口径是刻意写死的，避免把近似值当精确值用：
- `elapsed` 的终点是「报告/放弃的时间」或「现在」，起点是派工时间；时间戳缺失或早于起点时**钳到 0** 并给出 warning，不会输出负数或 `NaN`。
- `lastActivityAt` 是**注册表可见的状态跃迁**（报告、放弃、派工），**不是**最后一条消息的时间。worker 干活期间这个值不会动。
  `lastPromptAt` 单独给出，它是该 worker 会话最后一条**用户/调度方** prompt 的时间，同样不反映 worker 进度。

看板只读**进程内注册表**：重启后它是空的（这正是 `list_dispatches` 与检查点文件的分工）。

## 强制回报：不报告就别收工

worker 每次即将结束回合时，插件会检查本轮是否调用过 `report_to_main`：

- **没报** → 用 `agent.steer()` 把它推回去，附上具体指令（"你正要结束但没有报告，现在调用 report_to_main"）
- **连续 3 次都没报** → 停止重试，改为**向主会话推送一条失败通知**，附带 worker session id，让人能去看现场

这比无限重试或静默失败都好：前者会烧钱，后者会让你以为任务完成了。

**局限（必须说清）**：它拦的是「想收工却没报告」。拦不住 worker 什么都不做就结束，也拦不住它编一份假报告。主会话的转述只能当索引，最终验证仍应落到那个工作区的实际结果上。

## 安装

```bash
# 从本地目录
plugin_manager install_bundle  target: /absolute/path/to/discipline-whale

# 或 CLI
dsh plugin --profile web add /absolute/path/to/discipline-whale
```

安装后**需要重启 DSH**：preset 内的插件行不受 HMR 管理（`restart-required: unmanaged-plugin`）。

源码改动后的热更新：如果装了 `dsh-motion-ui` 那种 HMR 机制，本包因为以 symlink 安装、实体文件在 watch root 之外（`**/node_modules` 被忽略），**改代码不会自动重载**。切走再切回插件行无效，必须重启进程。

## 回报存储

```
$DSH_HOME/discipline-whale/<workspaceId>/<reportId>.json     ← 报告
$DSH_HOME/discipline-whale/dispatches/<workerSessionId>.json ← 派工检查点
```
每个报告一个 JSON 文件，原子写入（temp + rename）。损坏的文件会被列表跳过，不会拖垮整个 listing。

检查点是**路由事实**（dispatchId / 主会话 id / 工作区 / 派工时间），不含任务正文——正文在 worker 会话日志里。
`dispatch_task` 在返回前写一次，worker 首次生命周期事件再写一次同一路径（两边共用 `checkpoint.js` 的同一套路径与记录格式，所以不会各写各的）。
报告投递成功后删除；**放弃（abandoned）时不删**，因为那个 worker 之后仍可能真的报告，删了它就会退化成 orphan。

## 测试

```bash
node test/contract.mjs
```

17 项契约测试，用假 Host 分别挂载两半：

1. 存储往返、长度截断、路径穿越防护
2. 主会话行注册 5 个工具，schema 在受支持子集内（遍历注册表，未列入清单的工具会直接失败）
3. **worker 行只注册 1 个工具**，且没有 dispatch / list / read / send / `list_dispatches`
4. `list_workspaces` 投影正确
5. `dispatch_task` 用 worker preset、下任务、拒绝歧义/未知工作区
6. `report_to_main` 存文档并投递到主会话
7. 无 dispatch 的会话不能报告；空 summary、非法 status 被拒
8. 静默 worker 被推回两次，第三次升级到主会话；已报告的 worker 不再被打扰
9. `send_to_session` 投递新决策
10. 重启后 worker 从磁盘检查点恢复派工并完成回报
11. 连检查点都没有时，报告落盘并标记 `orphaned`，绝不猜目标会话
12. 出错/中断的回合照样写检查点，恢复后只催一次
13. 恢复之后**强制回报**也生效（不只报告工具）
14. `list_dispatches`：空注册表返回空数组、三态正确、`elapsed` 不为负也不为 `NaN`
15. `dispatch_task` 自己就把检查点落盘 —— 派工返回后、worker 首个事件前重启也不丢
15b. 检查点写失败只加 warning，**派工照常成功**
16. 看板能吃下 worker 侧写入的 `recoveredFrom` / `orphaned` / 脏时间戳
17. 已投递的派工不会被后续生命周期事件「复活」成第二个检查点

假 `prompt` **故意模仿真实实现**，会解引用 `signal` —— 这条强化曾抓出三个真实缺陷（信号未传、`exec` 参数缺失、dispatch 未标记已报）。

## 真实端到端验证

见 [`VERIFICATION.md`](./VERIFICATION.md)：真实会话、真实 worker、真实回报推送，含原始证据。

## 已知限制

- **看板只有工具，没有 GUI 面板**。`list_dispatches` 是给主会话调的工具（也可靠 `present` 渲染），Web GUI 侧边栏里没有一张常驻的派工看板。要看状态还得问主会话，或在会话列表里找 worker。
- **工作区无描述字段**。路由只能靠标题/路径判断，准确性有限。
- **派工记录跨重启靠检查点文件，不靠内存**。`dispatch_task` 会在返回前把路由事实（dispatchId / 主会话 id / 工作区）写到 `$DSH_HOME/discipline-whale/dispatches/<workerSessionId>.json`，worker 首次生命周期事件会再写一次同一路径，所以「派工返回后、worker 首个事件前」重启也不会丢。投递成功后删除该文件。仍有边界：**worker 会话被删除/归档后再报告**，检查点可能已被清理，此时退化为 orphan 路径；**检查点写失败**时派工会照常成功但只在本次进程内有效，并在结果里给出 warning。
  `list_dispatches` 看的是**进程内**注册表，重启后为空 —— 它回答「现在谁在飞」，检查点回答「重启后这条派工还能不能找回」。两者分工不同，不要互相替代。
- **跨 preset 不共享**。每个 preset 装载独立的插件实例，所以 `dispatch_task` 的 `workerPreset` 必须精确等于 worker preset id。不匹配时会在派工阶段直接报错，不会让 worker 到报告时才失败。
- **`create_session` 靠 profile 层关掉，不是靠 preset**。`create_session` 由 profile 级 bundle `dsh-session-kit` 注册进 Host 工具层，能创建用户可见会话并下发首条 prompt，效果等于派工。preset 内部的 `plugins` 列表由 agent-preset-registry 挂进它自己的 PresetTree，跟 Host 树是两个组合，所以**在 worker preset 里写 `- id: dsh-session-kit` + `disabled: true` 关不掉它**（而且这种没有 `name` 的行会让整个 preset 装载失败）。本包的 `cordis.patch.yml` 因此改用**一条 profile 层按 id 定向的 patch** 关掉该行；它排在本 bundle 之前插入的 `dsh-session-kit` 之后生效。代价是**全局生效**：主会话也没有这个工具了（主会话本来该用 `dispatch_task`，不受影响）。未装 `dsh-session-kit` 的 profile 上这条 patch 只会告警「entry not found」并跳过，可以安全单独安装。模板里没有「只对 worker 关闭」的可行写法 —— 若要那种效果，需要在 preset 内挂一个对 agent 调 `ctx.tools.restrict({ deny: ['create_session'] })` 的插件行，本包未提供。
- **主会话只读 + UI**。主会话 preset 里 `tool-fs` 是 `read: true, readImage: true, write: false, edit: false`，并且 `tool-bash` / `tool-pwsh` / `tool-jobs` 三行都被禁用 —— 没有 shell，就没有 bash 重定向、`tee`、`sed -i` 这类绕道写文件的路子。`tool-jobs` 一并关掉，是因为主会话既没有 shell、也没有挂 `tool-terminal` / `tool-workflow`，自己造不出后台任务，`job_*` 只剩空列表（任务注册表本身仍在 Host 层，不受影响）。因此主会话**不能写总结文档**，也不能把文档落盘：它的产出只有对话正文和 UI 渲染。如果确实需要主会话落盘一份总结，得单独给 `write` 开例外（本包没有加）。
- **这些改动都要重启才生效，且没有在运行中的进程里验证过**。preset 行不受 HMR 管理；改动 `cordis.patch.yml` 后需重启 `dsh web`，**新建的**会话才会拿到新的工具面（已存在的会话仍用旧组合）。
  能验证到什么程度：用 `dsh --profile web --dump-config` 核对过**组合后的配置树**确实包含 `dsh-session-kit: disabled: true`、`write: false` / `edit: false`、`tool-bash` / `tool-pwsh` / `tool-jobs` 全部 `disabled: true`（输出见 [`VERIFICATION.md`](./VERIFICATION.md)）。这只是「配置写对了」，**不等于**「重启后实测生效」——实际工具面要重启一次、新建两个 preset 的会话各看一眼才能确认。这一步本包没有做，别把它当已验证。

## 命名冲突核查

2026-10-20 实测：npm 上 `discipline-whale` / `discipline-well` / `dsh-discipline-whale` / `dsh-discipline-well` 全部未被占用；GitHub 上 `huiyuanXP/discipline-whale` 等三个候选名均可用；全网仅有 2 个无关仓库含 "whale" 字样。

## License

MIT
