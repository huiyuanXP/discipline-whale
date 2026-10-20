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
| **Discipline Whale** | 主会话：派工、汇报、讨论架构 | `list_workspaces` `dispatch_task` `read_report` `send_to_session` + 读/写/搜索/bash/提问/UI |
| **Discipline Whale Worker** | 工作区会话：真正干活 | `report_to_main` + 完整编码工具 + 子代理 |

**关键的结构性保证**：`dispatch_task` 只存在于主会话 preset，`report_to_main` 只存在于 worker preset。worker 的子代理继承 worker preset，所以**子代理拿不到任何派工能力**——这是模块装载层面的隔离，不是靠提示词约束。

主会话不注册 `report_to_main`：它只会被回报，不会自己造一个。

## 四个工具

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
$DSH_HOME/discipline-whale/<workspaceId>/<reportId>.json
```
每个报告一个 JSON 文件，原子写入（temp + rename）。损坏的文件会被列表跳过，不会拖垮整个 listing。

## 测试

```bash
node test/contract.mjs
```

9 项契约测试，用假 Host 分别挂载两半：

1. 存储往返、长度截断、路径穿越防护
2. 主会话行注册 4 个工具，schema 在受支持子集内
3. **worker 行只注册 1 个工具**，且没有 dispatch / list / read / send
4. `list_workspaces` 投影正确
5. `dispatch_task` 用 worker preset、下任务、拒绝歧义/未知工作区
6. `report_to_main` 存文档并投递到主会话
7. 无 dispatch 的会话不能报告；空 summary、非法 status 被拒
8. 静默 worker 被推回两次，第三次升级到主会话；已报告的 worker 不再被打扰
9. `send_to_session` 投递新决策

假 `prompt` **故意模仿真实实现**，会解引用 `signal` —— 这条强化曾抓出三个真实缺陷（信号未传、`exec` 参数缺失、dispatch 未标记已报）。

## 真实端到端验证

见 [`VERIFICATION.md`](./VERIFICATION.md)：真实会话、真实 worker、真实回报推送，含原始证据。

## 已知限制

- **无 GUI 看板**。worker 状态要在会话列表里看。（你勾掉了看板项）
- **工作区无描述字段**。路由只能靠标题/路径判断，准确性有限。
- **进程内状态**。dispatch 注册表是内存中的：Harness 重启后，磁盘上的报告仍可读，但「谁在等谁」会丢失。
- **跨 preset 不共享**。每个 preset 装载独立的插件实例，所以 `dispatch_task` 的 `workerPreset` 必须精确等于 worker preset id。不匹配时会在派工阶段直接报错，不会让 worker 到报告时才失败。

## 命名冲突核查

2026-10-20 实测：npm 上 `discipline-whale` / `discipline-well` / `dsh-discipline-whale` / `dsh-discipline-well` 全部未被占用；GitHub 上 `huiyuanXP/discipline-whale` 等三个候选名均可用；全网仅有 2 个无关仓库含 "whale" 字样。

## License

MIT
