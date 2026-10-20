# Discipline Whale · 端到端验证记录

日期：2026-10-20 · 环境：macOS，DSH 0.2.1-rc.2，profile `web`，模型 `soc/x-test-2`

本文件记录**真实会话**的验证结果，不是单元测试结论。每条都附原始证据位置。

---

## 1. 组件级契约测试

```
node test/contract.mjs
→ 17 项全过（含 15b）
```

覆盖两半的挂载隔离、schema 合法性、派工、回报投递、强制回报重试与升级、重启后的检查点恢复、看板三态与脏数据。

> 本文件其余各节是 **2026-10-20 早先那次**真实端到端验证的记录，当时是 9 项契约测试、主会话还能写文件。那些结论没有被本次改动推翻的部分继续有效（派工、投递、强制回报），但工具面和测试数量以本节为准。第 9 节列出的缺口已按现状更新。

---

## 1b. 配置组合核对（不是运行时验证）

用 `dsh --profile web --dump-config` 把整个 profile 的 patch 层组合出来，确认本包的改动真的进了最终配置树，而不只是写在 YAML 里：

```
$ DSH_HOME=<tmp copy> node .../dsh/lib/bin.js --profile web --dump-config
exit=0，stderr 为空
```

关键片段（原样摘自 dump 输出）：

```yaml
# == dsh-session-kit, patched by discipline-whale
- id: dsh-session-kit
  name: dsh-session-kit
  disabled: true
```

```yaml
      - id: tool-fs
        name: '@deepseek-ai/dsh-tool-fs'
        config:
          read: true
          readImage: true
          write: false
          edit: false
      - id: tool-fs-search
        name: '@deepseek-ai/dsh-tool-fs-search'
        config:
          sampleOverCapGlobResults: false
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: true
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: true
      - id: tool-jobs
        name: '@deepseek-ai/dsh-tool-jobs'
        disabled: true
```

**这只证明配置组合正确，不证明运行时生效。** preset 行不受 HMR 管理，实际工具面必须重启 `dsh web` 后新建两个 preset 的会话各看一眼才算实测 —— 那一步没做。

顺带核对到的两个实现细节（读源码，不是推测）：

- `applyEntryPatches`（`dsh-app-boot`）对非 insert patch 的顺序是：找不到 id → warn `patch: entry %C not found` 并跳过；`name` 与目标不符 → warn 并跳过。所以「未装 `dsh-session-kit` 的 profile 上安全跳过」成立，`name` 是断言而非改名。
- `entryListProblem`（`dsh-agent-preset-registry`）要求 preset 内每一行都有非空 `name`，否则整个 preset 装载失败。所以「在 preset 里写一行只有 id + `disabled: true`」不是合法写法，README 里那条说法是对的。

---

## 2. 主会话 preset 生效

创建会话 `session-acbefcf5-72f6-4667-b12f-5bc75e6c9d0a`，`agent_preset: discipline-whale`。

**证据**：`list_workspaces` 与 `dispatch_task` 都被真实调用并返回成功 JSON。

```json
// dispatch_task 返回
{ "dispatchId": "dispatch-bc92d0eb-020a-4cc9-89ad-1269aba80f0d",
  "workerSessionId": "session-47596f15-71fa-4f09-a75c-a35ede8bb504",
  "workspaceId": "f663d93b-af28-43cc-8ace-91b04b81db6d",
  "workspaceTitle": "soc-api-test",
  "status": "dispatched",
  "title": "DW worker proof" }
```

→ preset 自动出现在 GUI 选择器，无需任何 client 代码。**已验证**

---

## 3. worker 的工具面隔离

检查 worker 会话 `session-47596f15` 的 `request/header` 工具清单：

| 工具 | worker 是否有 |
|---|---|
| `report_to_main` | ✅ |
| `dispatch_task` | ❌ |
| `list_workspaces` | ❌ |
| `read_report` | ❌ |
| `send_to_session` | ❌ |

→ 「Sub Agent 不具备 DW 能力」是**结构性保证**。worker 的子代理继承该 preset，同样拿不到这些工具。**已验证**

---

## 4. worker 真实执行任务

worker 的 4 次 `bash` 调用：

1. `printf 'DISCIPLINE_WHALE_WORKER_OK\n' > dw-worker-proof.txt && cat ...`
2. `wc -c ... && cat -A ...`（macOS 的 `cat -A` 不可用，改用 `cat -e` / `od -c`）
3. `cat -e ...; od -c ...` — 字节级确认 27 字节、单行、仅一个换行
4. `rm dw-worker-proof.txt` — 删除并确认不存在

→ 真实文件操作，真实验证，不是声称。**已验证**

---

## 5. 发现并修复的三个真实缺陷

端到端验证的价值就在这里——这三个都是**契约测试最初没抓到**的：

| # | 缺陷 | 表现 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | `prompt()` 缺 `signal` 参数 | `report stored but the push failed: Cannot read properties of undefined (reading 'throwIfAborted')` | `sessionController.prompt(request, signal)` 会立即解引用 signal | 所有 4 个调用点补 `signalOf(exec)`；假 `prompt` 也改为强制解引用，防止回归 |
| 2 | `send_to_session` 的 `execute` 缺 `exec` 参数 | `ReferenceError: exec is not defined` | 函数签名写成 `execute(args)` | 改为 `execute(args, exec)` |
| 3 | dispatch 未标记已报告 | 已回报的 worker 仍被反复 steer | `report_to_main` 成功后没回写 dispatch 状态 | 推送前先写 `dispatch.reportedAt` |

另有第 4 个：`Config` 用普通对象而非 Standard Schema，导致 `Cannot read properties of undefined (reading 'validate')`。已改为手写 `~standard.validate`（本包无依赖，不能 import schema 库）。

**修复后的推送验证**（见第 6 节）证明链路已通。

---

## 6. 回报被动推送激活主会话 —— 核心验收点

因为 preset 行不受 HMR 管理（`restart-required: unmanaged-plugin`），修复需重启才在已加载的 `discipline-whale` 实例上生效。为**不重启你正在用的 dsh web**，用配置一致的临时副本 `dw-livecheck2` 做了真实验证；验证通过后，同样的修复已回写到 `discipline-whale`，临时副本已从 profile 卸载。

主会话：`session-c0e3e8c8-d4b0-44a2-bcc9-7b5aec8d9b6d`（preset `dw-livecheck2`）
worker：`session-b4aba086-81b6-45b8-8bfb-c7d715c80376`

**主会话事件流**：

```
TURN/START 1
  CALL: dispatch_task
  RESULT: { dispatchId: dispatch-7385337c..., workerSessionId: session-b4aba086..., status: dispatched }
TURN/END completed
TURN/START 2          ← 自动开启，没有人说话
  USER src=user: [Discipline Whale] Worker report — soc-api-test (done)
                 PUSH_FIX_OK — 创建 dw-livecheck2.txt（12 字节），cat/ls 确认后删除，验证已不存在…
                 report id: r-c710d8fb-4cc0-4792-a328-ae090a95bc42
  ASSISTANT step=1: Worker 回报已到达（工作区 soc-api-test，状态 done）：
                    - 创建 dw-livecheck2.txt，内容为单行 PUSH_FIX_OK（12 字节）
                    - 用 cat/ls 确认内容后删除，并验证文件已不存在（DELETE_OK）
                    …
TURN/END completed
```

**这条链的每一环都是真的**：

1. worker 完成实际工作（建文件 → 验内容 → 删除）
2. worker 调 `report_to_main`
3. 报告落盘：`/Users/huiyuan/.dsh/discipline-whale/f663d93b-.../r-c710d8fb-....json`
4. summary 作为**一条普通用户消息**推送到主会话
5. **主会话被自动唤醒**，开了 turn 2，没有任何人手动说话
6. 主 Agent 如实转述 worker 的结果，并指出可用 `read_report` 取全文
7. 主 Agent 明确说"我未自行调用 report_to_main" → 职责边界守住

→ **「报告以被动推送方式激活主会话」已完整验证。**

---

## 7. 强制回报机制

契约测试 #8 覆盖逻辑：静默 worker 被 steer 两次（`maxReportRetries: 2`），第三次不再 steer，改为向主会话推送失败通知。

**未在真实会话中验证**：真实环境里三次都让它成功报告了（worker 有遵守约定）。机制的存在与触发路径已由测试覆盖，但"真实 worker 连续三次拒绝报告"这一场景没有复现——那样的 worker 需要刻意构造，我没有为了凑一个失败用例去浪费你的 token。

**如实标注：这一项是逻辑验证，不是真实会话验证。**

---

## 8. 存储层

真实报告文件：
```
/Users/huiyuan/.dsh/discipline-whale/f663d93b-af28-43cc-8ace-91b04b81db6d/r-8e8f4382-....json
```
内容包含 `summary`、`document`、`workerSessionId`、`mainSessionId`、`outcome`、`reportedAt`、`deliveredTo`。

第一条报告（推送失败那次）显示 `"deliveredTo": []` 且 `status: "reported"` —— 存储层诚实地记录了「存了但没送出去」，而不是假装成功。

---

## 9. 未验证 / 已知缺口

| 项 | 状态 |
|---|---|
| 真实 worker 连续三次不报告 → 升级通知 | 仅逻辑测试，未做真实复现 |
| 派工 → 清空内存注册表 → worker 报告 | **已做**，见第 9b 节（模拟重启，非真实进程重启） |
| 真实 Harness 进程重启（`dsh web` 真被杀掉再起） | **未做**。检查点路径与恢复逻辑由测试和冒烟覆盖，但没有真的重启一次进程 |
| `cordis.patch.yml` 的权限收紧在运行时生效 | **未做**，只核对了 `--dump-config` 的组合结果（第 1b 节）。**需重启后实测** |
| 真实断网（TRANSPORT 错误）下的行为 | **未做**。测试里用合成的 `agent/error` 事件模拟，真实网络栈未中断过 |
| 多 worker 并发派工 | 未测（注册表支持多条，但未构造并发场景） |
| GUI 看板面板 | 未实现（无侧边栏面板；`list_dispatches` 是主会话可调的工具） |
| 工作区描述字段 | 未实现，路由仍靠标题/路径 |

## 9b. 模拟重启冒烟（非单测）

脚本在仓库里：`node test/smoke-restart.mjs`。用真实的两半模块跑完整链路：派工 → `resetRegistry()` 清空全部内存 → 换一个全新的 main 行实例 → worker 报告。断言落在**主会话真的读了哪个文件**上，而不是内部返回值。

```
1) main session dispatches
   dispatch: {"dispatchId":"dispatch-01ab6f68-...","workerSessionId":"session-1792508938731-1","status":"dispatched"}
   checkpoint on disk before worker ever runs: session-main-smoke
2) the board sees it as running
    1 of 1 dispatch(es) shown; 1 running, 0 reported, 0 abandoned. ...
3) RESTART — every in-memory record is destroyed
   board after restart (process-local registry is empty): 0 row(s)
4) worker reports with no live dispatch record
   result: {"reportId":"r-38d55222-...","deliveredToMain":true,"warnings":["this Session has no live dispatch record — the Harness most likely restarted, ..."]}
5) did the report actually reach the main session?
   pushes to main session: 1
   message:
     | [Discipline Whale] Worker report — soc-api-test (done)
     |
     | Parser refactor done; tests green.
     |
     | report id: r-38d55222-...
     | Call read_report with that id for the full document.
6) the main session reads the stored document
   read_report -> {"status":"delivered","document":"Changed 3 files.","deliveredTo":["session-main-smoke"],"recoveredFrom":"checkpoint"}
7) checkpoint cleanup
   checkpoint after delivery: removed

SMOKE PASS
```

和单测的区别：单测验证的是每个断言点；这个脚本验证的是**链路**——报告文件被 `read_report` 读到、推送真的进到主会话、检查点被删干净。它仍然不是真实 Host：`sessionController` 是假的，重启是 `resetRegistry()` 而不是杀进程。

---

## 10. 交付状态

- 主包 `discipline-whale` 已安装到 web profile（`link:/Users/huiyuan/Developer/test/soc-api-test/discipline-whale`）
- `node test/contract.mjs` **17 项全过**（含 15b）
- **需要重启 DSH 一次**：`cordis.patch.yml` 的权限收紧和 preset 内的模块代码都要重启才在已加载的插件行上生效。**本次没有重启验证**。

## 复验命令

```bash
cd discipline-whale
node test/contract.mjs        # 17 项契约测试
node test/smoke-restart.mjs  # 模拟重启冒烟（非单测）
```

真实端到端复验：**重启 DSH 后**，选 Discipline Whale preset 新建一个会话，先确认工具面符合预期（没有 `write` / `edit` / `bash`，主会话没有 `create_session`），再让它 `dispatch_task` 到一个工作区，观察 worker 完成后主会话是否自动收到一条 `[Discipline Whale] Worker report` 消息。
