# Discipline Whale · 端到端验证记录

日期：2026-10-20 · 环境：macOS，DSH 0.2.1-rc.2，profile `web`，模型 `soc/x-test-2`

本文件记录**真实会话**的验证结果，不是单元测试结论。每条都附原始证据位置。

---

## 1. 组件级契约测试

```
node test/contract.mjs
→ 27 项全过（含 15b）
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

- 主包 `discipline-whale` 以打包副本安装到 web profile（`file:$DSH_HOME/plugins/packages/discipline-whale-<version>.tgz`，由 `scripts/install-local.sh` 生成）
- `node test/contract.mjs` **19 项全过**（含 15b）
- **需要重启 DSH 一次**：`cordis.patch.yml` 的权限收紧和 preset 内的模块代码都要重启才在已加载的插件行上生效。**本次没有重启验证**。

## 11. 侧边栏入口与 home（0.2.0）

在隔离的 `DSH_HOME`（同一 web profile，独立端口 3099）上实测，dsh 0.2.1-rc.2：

- 侧边栏顺序：插件 → 自动化任务 → **自律鲸鱼** → 上下文洞察 → 记忆（`order: 15`）
- 启动后 `$DSH_HOME/discipline-whale/home` 存在；工作区注册表里**没有**它
- 首次点入口：Host 新建会话 `agentPreset: discipline-whale`、`cwd: $DSH_HOME/discipline-whale/home`、标题「自律鲸鱼」，唤醒消息跑完一轮（模型回复了派工板状态），输入框可用；`state.json` 记录了主会话 id
- 再次点入口：打开同一个主会话，没有新建
- 会话出现在会话列表「未分组」下；浏览器控制台无本插件报错

客户端模块只对**名字等于包名**的 loader 行注入，所以 home 行用 `name: 'discipline-whale'`，包根入口 `.` 指向 `home.js`。

## 12. 启动检查：被打断的派工（0.3.0）

在隔离的 `DSH_HOME` 上实测，复制了真实的主会话、3 条未交付的派工检查点和对应会话记录：

- 启动后主会话自动收到「启动检查」消息，列出 3 条中断的派工
- 主会话用一句话说明每条原本在做什么，再用 `ask_user` 逐条给出「恢复 / 放弃 / 稍后再说」，侧边栏会话显示「等待回答」
- 回答「稍后再说 / 稍后再说 / 放弃」后，主会话只对第 3 条调用了 `abandon_dispatch`，该检查点被删除，其余两条保留；全程没有调用 `resume_dispatch`

## 复验命令

```bash
cd discipline-whale
node test/contract.mjs        # 19 项契约测试
node test/smoke-restart.mjs  # 模拟重启冒烟（非单测）
```

真实端到端复验：**重启 DSH 后**，选 Discipline Whale preset 新建一个会话，先确认工具面符合预期（没有 `write` / `edit` / `bash`，主会话没有 `create_session`），再让它 `dispatch_task` 到一个工作区，观察 worker 完成后主会话是否自动收到一条 `[Discipline Whale] Worker report` 消息。

---

## 10. 派工纪律进 prompt（2026-10-21）

### 10a. persona 的组装路径（读源码，不是推测）

| 事实 | 出处 |
|---|---|
| preset 的 `prefix` 由 `@deepseek-ai/dsh-persona` 注册成 `deployment:persona-prefix` section，order = `DEPLOYMENT_PERSONA_PREFIX`（0） | `dsh-persona/lib/index.js`（`ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, ... })`） |
| preset 由 `agent-preset-registry` 挂在一个 `createScope` 出来的 scope 里（`mountPreset`），persona 因此在**该 scope 内**遮蔽部署级 persona，而不是全局注册 | `dsh-agent-preset-registry/lib/index.js` `activate()` → `createScope(this.owner, key)` + `mountPreset` |
| 同一 section 名在全局层重复注册会抛错；在 scope 里注册是 shadow，合法 | `dsh-system-prompt/lib/index.js`（`NamedEntries` 的 duplicateError）+ 实测（见 10b） |
| person 每次请求重新组装，不是一次性拷贝 | `dsh-agent-loop/lib/index.js` `preStep()` 每步调用 `systemPrompt.assemble(...)` |

### 10b. prompt-probe：按 Host 的方式组装出来再断言

新增 `prompt-probe.mjs`：解析 `cordis.patch.yml`（用 Loader 同款的 `!!js` YAML dialect）→ 找到 preset → 在 `dsh-scope` 的 scope 里挂 `dsh-persona` 行 → `assemble({ scope })` → `renderPrompt`。

```
$ node prompt-probe.mjs discipline-whale
You are an AI agent powered by DeepSeek Harness.

你是「自律鲸鱼」主会话：多工作区 agent 系统里唯一直接和用户对话的会话。

## 1. 派工优先
...
```

**反向对照**（证明断言不是恒真）：拿 `git show HEAD:cordis.patch.yml`（新增纪律之前的版本）跑同一函数——

```
old prompt has 派工优先? true
old prompt has 读预算? true
old prompt has 已有的那个会话? false      ← 新纪律确实不在旧文本里
```

契约测试 ok 23 断言：主会话 prompt 含读预算自检句、「一个话题 = 一个会话」段、诚实边界段；同一段文本**不出现**在 worker preset 的 prompt 里（验证 scope 隔离）。

### 10c. `--dump-config` 命中片段（组合后的配置树）

```
$ DSH_HOME=<tmp copy of the live web profile> dsh --profile web --dump-config
exit=0
```

```yaml
          prefix: >-
            你是「自律鲸鱼」主会话：多工作区 agent 系统里唯一直接和用户对话的会话。

            ## 1. 派工优先（默认动作）
            ...

            ## 4. 一个话题 = 一个会话

            - 同一件事的延续（补充要求、改需求、纠正方向）：往已有会话里加，不新建。先用 list_dispatches
            找同工作区、running 的会话。判据：同工作区 + 同一功能/同一批文件 + 尚未 reported；或已 reported
            但报告里留了未完成项。
              - 补一条要求 → send_to_session（默认）。
              - 方向错了、别再读了 → send_to_session 加 `interrupt: true`：先中止当前回合再顶入新指令。
```

> 说明：本节的 dump 用的是**临时目录里的一份 profile 副本**（`DSH_HOME` 指向 /tmp 的拷贝），不是线上 `~/.dsh`。原因是 `--dump-config` 会重写 profile 根 config 文件，不能指向正在被 `dsh web` 使用的目录。

### 10d. interrupt 的真实能力边界（**已被 §11 更正，见下**）

> ⚠️ 本小节是 2026-10-21 早先写的，它把「Interrupt」理解成「硬中止」。用户随后澄清：他要的是**步边界插话**（同一个 turn 内、当前 tool call 结束后生效），不是硬中止。§11 是更正后的正确结论；本小节保留作为过程记录。

~~能立即中止当前回合，但不是 Host 的单一 API，而是 cancel + steer 两步组合。~~

- `sessionController.prompt` 的 `mode` 只有两个值：`"queue"` / `"steer"`（`dsh-api-session-controller` `lib/typert.host.js:1795` 的 `SessionPromptRequest` JSON Schema；`lib/index.js:949` `if (request.mode === "steer") agent.steer(message)`，否则 `agent.followup`）。**没有 `interrupt` 模式。**
- `queue` → inbox 的 `next-turn`，`steer` → `next-step`（`dsh-agent-loop/lib/index.js:806-810`）。`next-step` 在下一个 tool 边界被 claim，所以**只发 steer 的话，当前那次工具调用仍会跑完**。
- 真中止靠 `sessionController.cancel({ sessionId })`：`dsh-api-session-controller/lib/types/commands.js:466-475` → `agent.cancel({ kind: 'user' }, { keepInbox: true })` → `dsh-agent-loop/lib/index.js:815-821` 对当前 phase 的 `AbortController` 调 `abort()`，并保留 inbox。工具拿到的 `signal` 就是这个 phase signal（`executeToolCalls(..., signal)`，`lib/index.js:506`），所以正在跑的工具调用会被中止。
- 冷会话（没有 live Agent）时 `cancel` 抛 `session/not-found`；插件吞掉并照常 `prompt(mode:"steer")`，返回 `interrupted: false`——不谎报中止过。

用户可见差异：`queue` 时那个在埋头读文件的 worker 会先把当前回合做完才看到新指令；`interrupt: true` 时当前回合被掐断、下一条指令立刻成为它的下一步输入，但**已经写入的文件不会回滚**，且它会带着这轮已有的上下文重新规划。

### 10e. 本次没有验证的

- **模型行为是否真的变派工优先**：没有任何测试断言这个。ok 23 只证明文本进了 system prompt，不证明模型照做。要证这个需要真机 A/B 观察，本包不做该声明。
- **重启后生效**：preset 行不受 HMR 管理，`cordis.patch.yml` 改动需重启 `dsh web` 且**新建**主会话才拿到新 prompt；已在跑的主会话仍是旧 prompt。本次**没有重启**用户正在跑的进程，因此「重启后确实生效」未实测。

---

## 11. 语音对话（本次新增）

### 11a. 真实打到 SoCLaaS 的一次成功转写

音频由 macOS `say` 合成，再转成 WAV：

```
$ say -v Tingting -o /tmp/dwvoice/voice.aiff "你好自律鲸鱼，请帮我检查一下今天的派工状态。"
$ afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/dwvoice/voice.aiff /tmp/dwvoice/voice.wav
$ afinfo /tmp/dwvoice/voice.wav | head
Data format:     1 ch,  16000 Hz, Int16
estimated duration: 4.905125 sec
```

**直接打 upstream**（key 从 `~/.zprofile` 的 `SOCLAAS_API_KEY` 读，输出已脱敏）：

```
$ curl -sS "https://soclaas-api.comp.nus.edu.sg/v1/audio/transcriptions" \
    -H "Authorization: Bearer ***REDACTED***" \
    -F "file=@voice.wav;type=audio/wav" \
    -F "model=whisper-large-v3" -F "language=zh" -F "response_format=json"
HTTP 200
{"text":"你好自律鲸鱼,请帮我检查一下今天的派工状态。"}
```

同一段音频用 `afconvert` / `ffmpeg` 转出的 **webm/opus** 与 **m4a** 也都能转写（都返回 200 和同一句文本），所以浏览器用 MediaRecorder 的默认容器也可以，不强制 WAV。

**打插件自己的端点**（`voiceHandler`，key 从进程环境读，走真实网络）：

```
$ env -i PATH="$PATH" HOME="$HOME" zsh -lc 'node /tmp/e2e.mjs'
transcribe HTTP 200
body {"text":"你好自律鲸鱼,请帮我检查一下今天的派工状态。","model":"whisper-large-v3","audioSeconds":5.032}
say HTTP 200 {"sessionId":"session-e2e-main","chars":22}
prompt reached session: session-e2e-main | mode: queue | text: 你好自律鲸鱼,请帮我检查一下今天的派工状态。
```

最后两行证明：识别文本确实通过 `sessionController.prompt`（`mode: 'queue'`）进了会话，不是另造的通道。

### 11b. upstream 错误形状（实测，用于映射规则）

```
$ curl -H "Authorization: Bearer sk-invalid-for-test" ...        → HTTP 401  {"error":"invalid API key"}
$ curl -H "Authorization: Bearer $SOCLAAS_API_KEY" -F model=no-such-model-xyz ...
                                                                  → HTTP 503  {"error":"public model \"no-such-model-xyz\" is not configured"}
$ curl -F file=@/dev/null ...                                     → HTTP 500  Internal Server Error
$ curl -F response_format=text ...                                → HTTP 400  {"error":"priced audio transcriptions require a non-streaming json or verbose_json response"}
```

最后一条说明：**不能**用 `response_format=text`，本插件固定发 `json`。前三条对应到 `voice.js` 的 `classifyUpstream()`：invalid-key / model-unavailable / upstream-error。

### 11c. 缺 key / 上游错误 / 限流映射（真实端点 + 真实 key 环境）

```
missing key     → 503 {"error":{"code":"voice/missing-key", ...}}
invalid key     → 502 {"error":{"code":"voice/invalid-key","upstreamStatus":401,"upstreamDetail":"invalid API key"}}
unreachable     → 502 {"error":{"code":"voice/backend-unreachable","message":"could not reach the transcription backend: fetch failed"}}
empty audio     → 400 {"error":{"code":"voice/empty-audio", ...}}
wrong container → 415 {"error":{"code":"voice/unsupported-audio-type","accepted":["audio/wav", ...]}}
```

`bad model` 那条没能在真实 upstream 上复现，因为路由里模型名是常量；用**实测抓到的原始 503 响应体**回放进真实 handler，验证映射正确：

```
upstream 503 → handler 503 {"error":{"code":"voice/model-unavailable","upstreamStatus":503,"upstreamDetail":"public model \"no-such-model-xyz\" is not configured"}}
upstream 401 → handler 502 {"error":{"code":"voice/invalid-key", ...}}
upstream 500 → handler 502 {"error":{"code":"voice/upstream-error", ...}}
```

响应体里**没有**出现 key（测试里显式断言 `JSON.stringify(payload).includes(key) === false`）。

### 11d. 静音判定：红 → 绿

先写测试，再写实现。红（`voice-silence.js` 还不存在）：

```
$ node test/voice.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../voice-silence.js'
[exit 1]
```

补上实现对第一版阈值规则后，暴露出**真实缺陷**：把一个 0.25 底噪的「吵闹房间」判成「一直在说话」，因为当时给阈值加了上限。测试先红：

```
AssertionError: TypeError: Cannot read properties of undefined (reading 'reason')
  at test/voice.mjs  (loud-room case)
```

去掉上限、改成「阈值 = 底噪 × 2 + 余量（无上限，只有绝对下限）」之后转绿。最终输出：

```
ok 7  — 10s silence, 500ms minimum speech and 60s cap are named constants
ok 8  — 10s of silence ends the utterance and a silent room uploads nothing
ok 9  — speech then 10s of quiet stops and marks the recording for upload
ok 10 — the threshold adapts to the room instead of being one magic number
ok 11 — an utterance shorter than the minimum speech threshold is not uploaded
ok 12 — the 60s backstop cuts a recording that never goes quiet
ok 12b — the 1s minimum recording length is enforced
ok 12c — a loud room raises the threshold, and room tone still counts as quiet
ok 12d — one transcript is queued into the recorded main session only
ok 13 — a late transcript cannot land after hangup or a session switch
All discipline-whale voice checks passed.
```

喂的是**合成 PCM 帧**（20ms/帧，16kHz），不是真人录音：`ok 8/9` 直接验证「9 秒不结束、10 秒结束」，`ok 12` 验证「连续说话 60 秒被切断」，`ok 11` 验证「300ms 的响声不触发上传」。

### 11e. 全部测试

```
$ node test/contract.mjs
... ok 1 … ok 23（含新增 ok 20 语音路由）
All discipline-whale contract checks passed.

$ node test/voice.mjs
16 项，全绿（见 11d）

$ node test/client.mjs
ok 1  — the browser detector mirrors the shared algorithm frame for frame
ok 2  — the constants and the call guard ship with the browser half
ok 3  — both dictionaries carry every voice key, privacy included
ok 4  — the reply reader speaks only the new turn, with markdown stripped
ok 3b — a live call retains the main session and releases it on hangup
ok 3c — a call creates the main session when none is recorded, and never uses a dead one
ok 5  — the dock registers into shell.overlay beside the whale page
ok 6  — the open dock shows status, transcript, reply, hang-up and the privacy notice
All discipline-whale client checks passed.

$ node test/smoke-restart.mjs
SMOKE PASS — dispatch survived a full memory wipe and the report reached the main session
```

`ok 1` of `test/client.mjs` 是关键的一条：它把同一串 900 帧合成信号同时喂给 `voice-silence.js` 和 `client.js` 里镜像的那份实现，**逐帧 `deepEqual`**。两份实现一旦漂移，这条立刻红——这比「两份注释都说自己是 10 秒」强。

### 11f. 「一轮结束」与「回复正文」的依据

- 回复**正文**：`ctx.sessions.binding(sessionId).eventSource` 是 `ObservableSnapshot<SessionEventWindow>`（`packages/api/session-controller/src/client/contract/events.ts:117`），窗口里是持久事件 `SessionEventLikeEntry`。助手消息事件是 `assistant/message`，其 `data.message.content` 是 `ContentBlock[]`（`packages/core/session/src/types.ts:342-355`，`packages/llm/llm/src/types.ts:62-64` 的 `TextBlock`）。取 `type === 'text'` 的块拼接，就是正文。
- **回合边界**：`turn/start` / `turn/end` 都是持久事件（`packages/core/session/src/types.ts:271-298`）。所以「这一轮结束了没有」在日志里是**准确**的。
- **拿不到的是「结束的回调」**：客户端没有向插件暴露 turn-end 事件订阅面（`ISessions` 只有 `list` / `retain` / `binding` / `retainInfo` 等读面，`packages/api/session-controller/src/client/contract/sessions.ts`）。所以浮层**轮询** `sessions.list` 里该会话的 `running` 变 false（`SessionSummary.running`，`packages/api/session-controller/src/client/sessions/service.ts:40`），再去读事件窗口。
- 同时必须**自己 retain 住会话**：事件窗口只在有引用时存在，用户此刻若不在鲸鱼页，主视图不会 retain 它。这就是 `createSessionWatcher` 存在的原因（`test/client.mjs` ok 3b 覆盖）。
- 结论：**「回复正文」是准的（读持久事件），「什么时候读」是轮询近似**。README 与浮层都这么写，没有把它说成事件驱动。

### 11g. 本次没有验证的（必须在真浏览器 + 真麦克风 + 重启后确认）

| # | 事项 | 验证步骤 |
| --- | --- | --- |
| 1 | `getUserMedia` 授权与 `audio: {echoCancellation, noiseSuppression, autoGainControl}` 真的被浏览器接受 | 重启 `dsh web`，点「开始通话」，允许麦克风；DevTools console 里 `navigator.mediaDevices.getUserMedia` 无 `OverconstrainedError` |
| 2 | 真实房间里的 10 秒静音是否真的在 ~10s 结束 | 说一句，然后完全不出声，用秒表/录屏确认浮层在 10s 后进入「识别中」；再在开着风扇的房间重复一次，确认不会提前或永不结束 |
| 3 | 半双工：鲸鱼思考时麦克风确实关闭 | 录音期间看系统麦克风指示灯（macOS 菜单栏橙色点）应在「鲸鱼思考中」熄灭，回复显示后重新亮起 |
| 4 | 朗读 fallback 真的出声（默认关闭，需先手动打开） | 浮层点「朗读回复：关（默认）」切到开，再问一句，确认念出中文；系统无中文声音时应失败但不卡通话（会走 `onerror` / 定时兜底回到待命） |
| 5 | 回复正文与轮询时序在真实会话里对得上 | 问一句会触发工具的问题，确认浮层里显示的是本轮正文、不是上一轮；再问连续两句确认基线没串 |
| 6 | `shell.overlay` 浮层在真实布局里不挡操作、不被裁切 | 打开会话页、切到插件页，确认通话条一直可见且能点；窄窗口（≤768px）下确认不遮住输入框 |
| 7 | 挂断/切会话/隐藏页面确实停麦 | 通话中切到别的会话、切到别的浏览器标签、点挂断，分别确认系统麦克风指示灯熄灭 |
| 8 | 真机上 SoCLaaS 的延迟是否可接受 | 说一句，看从「识别中」到「鲸鱼思考中」的耗时；>10s 属于体验问题，不是正确性问题 |

### 11g-bis. 朗读：浏览器语音合成 fallback，默认关闭（第三版定稿）

第二版曾整段移除 `speechSynthesis`；第三版按用户要求**恢复并重新定位**为 fallback。

**保留的东西**（全部在 `client.js`）：`speakReply()`、`speakable()`、`speechLanguage()`、`speak`/`speakRef` 状态、「朗读回复」开关（`.dw-toggle`）、`statusSpeaking` 文案与 `.dw-status-speaking` 样式、卸载与挂断时的 `speechSynthesis.cancel()`。

**默认值**：`useState(false)` 与 `useRef(false)`，测试 `ok 3a` 断言这两处字面量。

**文案口径**：`浏览器语音合成（fallback，非真实 TTS）`，中英各一条（`speakNote`）；开关文案带「（默认）」。不写「已接入 TTS」，也不写「未接入 TTS，不会朗读」。真实 TTS（云端 key 或本地模型）尚未接入。

**两条半双工断言**（`test/client.mjs` ok 3a，均经反向验证）：

1. **关闭时**：`setReply` 之后 `setPhase("ready")` 并 `listen()`，分支代码里不出现任何 `await`，也不出现 `onend`/`speakReply`/`speechSynthesis`/`SpeechSynthesisUtterance`。
   反向验证：塞回 `await new Promise(r => utterance.onend = r)` → 红（`the off branch must not await anything`）。
2. **开启时**：允许 await，但**必须有超时兜底**。这条是**行为测试**——用假引擎（`speak()` 接受但永不触发 `onend`）驱动真实的 `speakReply`，断言：恰好武装 1 个定时器、上限 ≤120s、未触发时 promise 不 settle、手动触发定时器后 settle；另外 `onend` 正常路径、引擎抛错路径、`enabled:false` 不碰引擎三条也都测了。
   反向验证：删掉 `schedule(finish, ...)` 那行 → 红（`exactly one backstop timer is armed`）。

**实现调整**：`speakReply` 从 `VoiceDock` 内部提升到模块作用域，并把引擎/构造器/定时器改为注入参数（`env`），行为不变，但让第 2 条可以脱离浏览器做行为验证。调用处仍然传 `speechSynthesis` 与 `SpeechSynthesisUtterance`。

`voice.js` / `voice-silence.js` 未改动（只负责转写与静音判定）。

结论：**朗读可用、默认关闭；它是浏览器语音合成 fallback，真实 TTS 未接入。**

### 11h. 安装与重启（需用户批准后执行）

**没有**重启用户正在跑的 `dsh web`，也**没有**改动线上 profile 安装。

```bash
cd /Users/huiyuan/Developer/projects/discipline-whale
scripts/install-local.sh          # 打包并装进 profile "web"
# 然后在用户自己的终端里：
#   1) 停掉当前 dsh web（Ctrl-C）
#   2) 确认环境里有 SOCLAAS_API_KEY：zsh -lc 'test -n "$SOCLAAS_API_KEY" && echo ok'
#      注意：dsh web 必须从**读得到这个变量**的 shell 启动（~/.zprofile 只在 login shell 生效）
#   3) 重新 `dsh web`
```

`SOCLAAS_API_KEY` 必须在**启动 dsh web 的那个进程环境**里。如果从 GUI/launchd 启动、没继承 login shell 的环境，语音会明确显示「服务端没有配置 SOCLAAS_API_KEY」，而不是静默失败。

## 12. 主会话三道刹车（`guard.js`，2026-10-21）

### 12a. 机制与默认阈值

| 机制 | 默认 | 常量（`guard.js` 顶部） | 配置键 |
|---|---|---|---|
| 工具调用看门狗（硬停 + 注入） | 连续 10 次静默调用 | `WATCHDOG_SILENT_THRESHOLD` | `watchdogThreshold` |
| 读配额 | 每回话周期 10 次 | `READ_QUOTA_PER_EPOCH` | `readQuota` |
| 防死循环 | 每用户轮最多介入 2 次 | `MAX_FORCED_INTERVENTIONS_PER_TURN` | `maxInterventions` |
| 计数口径 | `all` | `DEFAULT_WATCHDOG_COUNTING_MODE` | `watchdogCounting` |

阈值也在 `cordis.patch.yml` 的 `discipline-whale-main` 行里显式写出，运维不读代码也能改。

### 12b. 四个设计问题的答案（文件 + 行号）

**Q1：主会话 preset 里能不能拿到「工具调用」事件？中止当前回合的确切 API？**

能，但不是 `session/event`。实测（本节 12c）证明 **preset 里的监听器收不到 `session/event`**：该事件由 `SessionStore.enter()` 用 `scopeTarget(session, scopeOf(this.ctx))` 建 carrier，而 store 挂在 Host 平面上，`scopeOf` 为 `undefined`，没有 key 的 carrier 会把打了 scope 标签的监听器全部滤掉。

能用的是 **agent 主语事件**，它们由 `AgentLoop` 用 `scopeTarget(this, agent)`（`dsh-agent-loop/lib/index.js:771` `this.dispatch = agentEvents(loopCtx, this)`）派发，而 agent 的 scope 通过 `AgentPresetsService.join()` → `bindScopeParent(agentKey, generation.key)`（`dsh-agent-preset-registry/lib/index.js:670`）挂在 preset generation 上，所以 preset 里的行收得到：

| 用途 | 事件 | 派发点 |
|---|---|---|
| 工具调用前置门禁（配额 + 白名单 + 计数） | `tools/pre-execute`（waterfall） | `dsh-tools/lib/index.js:3320-3321` |
| 「说了用户可见的话」 | `agent/assistant-stream` | `dsh-agent-loop/lib/index.js:1080` |
| 「真实用户新消息」 | `agent/inbox/claimed` | `dsh-agent-loop/lib/index.js:106` |
| 会话销毁，清理状态 | `agent/disposed` | 见 `dsh-agent/lib/types/runtime-types.d.ts` |

**中止当前回合的 API**：`agent.cancel(cause, options)` —— 定义在 `dsh-agent-loop/lib/index.js:820`（`cancel(cause, options = {})`，`if (this.phase.kind !== "idle") this.phase.abort.abort(cause)`），类型在 `dsh-agent/lib/types/runtime-types.d.ts`。`cause.kind` 取 `'user' | 'parent' | 'hook' | 'disposed'`（`dsh-session/lib/types/types.d.ts:149`），本实现用 `{ kind: 'hook', reason }`。

同时，门禁自身返回 `{ kind: 'cancel' }`（`PreToolDecision`，`dsh-tools/lib/types/index.d.ts:445`）会让**当前这次工具调用**不执行（`dsh-tools/lib/index.js:3336` 的 `decision.kind === 'cancel'` 分支）。两者配合：`agent.cancel()` 停住整个回合，`{kind:'cancel'}` 保证触发点那次读没有真的发生。

**Q2：「注入 prompt」用哪条通路？**

`agent.steer(message)` —— `dsh-agent-loop/lib/index.js:808`（`steer(input) { this.send(input, "next-step", true) }`）。用它而不是 `sessionController.prompt()` 的理由：

1. 不走用户消息入口。`steer` 的消息带 `source: { kind: 'plugin:discipline-whale', form: 'notice', summary }`，模型看到它是一条 notice，不会被伪装成用户说的话。
2. 不碰对话历史的「用户」语义：`agent/inbox/claimed` 里本插件只认 `source.kind === 'user'` 的消息才会重置介入预算，注入的 notice 不会自我解锁（否则「终止→注入→重置」会变成无限循环）。
3. 只作用于目标 agent，不经过 `sessionController`，因此**不影响 worker**：worker 的 steer 通路由 worker 行的强制回报机制独立使用。

**关键时序**：先 `cancel()` 再 `steer()`。`send()` 里 `wakingAfterAbort = wakeup && phase.kind !== 'idle' && phase.abort.signal.aborted`，被 abort 之后的 steer 会被分到 `next-turn`，于是注入的 prompt 作为**下一条独立回合**跑，而不是在已中止的回合里被吞掉。

**Q3：工具限制/拦截是 preset 级还是会话级？怎么保证不误伤 worker？**

是 **preset 级挂载、按会话甄别**。`tools/pre-execute` 的监听器由 preset 树在启动时挂一次（`mountPreset`，`dsh-agent-preset-registry/lib/index.js:219`），不是每个 Session 一份，所以同一个进程里所有 Session 的事件都会流经它。

因此每个 handler 第一步都是 `presetOfAgent()`：读 `agent.session.header.agentPreset`（`dsh-session/lib/types/types.d.ts:95`，durable 字段），失败时退到 `agentPresets.composedPreset(agent.ctx)`。**不等于 `discipline-whale` 就一律 `next()` 放行**，连计数器都不建。

这是「失败开」而不是「失败关」：worker 被误拦会毁掉整条工作链，主会话漏拦只是少一层保护。

**Q4：硬停的代价 —— 正在 `dispatch_task` 之后、brief 还没写？**

评估后的结论：**这个具体中间态不会发生**，但有一个相邻的真实风险，需要说明。

- `dispatch_task` 是 **exclusive** 工具（没有 `isConcurrencySafe` → `{kind:'exclusive'}`，`dsh-tools/lib/index.js:3155`），在 tool group 里形成顺序屏障。`agent.cancel()` 只 abort `phase.abort`；在 `runGroup` 里 abort 后走的是「已 started 的调用**照常 drain 并提交**，未开始的标记 skipped」（`dsh-agent-loop/lib/index.js:646-658`）。也就是说正在跑的 `dispatch_task` 会**跑完并落库检查点**，不会被腰斩。
- **真正的风险**：`dispatch_task` 已经返回（worker 已创建、brief 已投递），但主会话还没把「我派了什么」告诉用户就被硬停。后果是**用户暂时不知道有活出去了**，不是工作丢失 —— 因为 worker 已经在跑，报告会以推送消息到达。
- **缓解**：注入的 prompt 第一条就是「给用户你已有的结论」，第三条是「没有值得派的就说清楚、问用户下一步」；即使用户没再说话，worker 的回报仍会唤醒主会话。另外 `keepInbox: true` 保证用户在被硬停时排队的新消息不会丢。
- **接受的风险**：如果硬停恰好发生在一次 `send_to_session` 的 steer 之后、worker 已收到改单但主会话没交代清楚，用户会看到「取消失败/未解释」的中间态。这个接受，因为 (a) 改单本身已送达 worker，(b) 介入预算只有 2 次且会明确告知用户，(c) 用户发新消息即恢复。

### 12c. 「用户可见文本」与事件可达性的实证

不是猜的：`test/guard.mjs` 第 9 组用真实 `cordis` + `dsh-scope` 包搭出与 Host 相同的作用域图（`createScope(app, generationKey)` = `mountPreset`；`createScope(app, agent)` = AgentLoop；`bindScopeParent(agent, generationKey)` = `AgentPresetsService.join`），断言：

```
ok 9 — the real scope graph delivers the agent-keyed signals; session/event provably does not
```

其中最后一条是关键：`app.emit(scopeTarget({id:'sessions'}, undefined), 'session/event', …)` 打到 preset 监听器上**命中 0 次**。这就是实现不监听 `session/event` 的原因——如果按直觉写，三道刹车会全部静默失效，而单元测试（直接调 handler）根本发现不了。

「用户可见文本」的判定用 `frameHasVisibleText()`：只有非空白的 `text-delta` 或文本 `block-end` 算回话。**`reasoning-delta` 不算**——否则一路思考就能无限刷新配额。这条有独立断言（第 3 组）。

### 12d. 计数口径的取舍（明说）

用户原话是「连续 10 个 tool call 没有回复就终止」。字面口径会把 `dispatch_task` / `list_workspaces` / `read_report` / `render_*` / `present` 都算进去，于是「派 3 个工 + 看 3 份报告」这种**正当履职**会被误杀，**以及一次多图形块的正常交付会在渲染到第 10 个时被拦腰截断**。

- 默认 `watchdogCounting: 'all'`：除 `PRODUCTIVITY_TOOLS` 外全部计数。该集合 28 项，按「调用它是否增加主会话对代码库的了解」判据分四组：
  - 本插件面：`dispatch_task`、`list_workspaces`、`list_dispatches`、`read_report`、`send_to_session`、`report_to_main`
  - 对用户说话：`present`、`ask_user_question`、`todo_write`
  - 渲染产出（`dsh-motion-ui`）：`render_text`、`render_ui`、`render_canvas`、`render_scene`、`render_mechanism`、`update_ui`、`patch_ui`、`validate_ui`、`inspect_ui`、`ui_catalog`、`preview_video`、`render_video`、`process_video`、`synthesize_voice`
  - 文档产出（`dsh-office-tools`）：`excel_create`、`excel_update`、`word_create`、`word_update`、`ppt_create`

  工具名是**照部署里实际注册的名字逐一核对的**（`~/.dsh/profiles/web/node_modules/dsh-motion-ui`、`dsh-office-tools`），不是猜的。配套的 `excel_read` / `word_read` / `ppt_read` / `inspect_video` **不在**集合里：把产物读回来确实会把内容拉进上下文，属于研究，继续计数。

  **修复的缺陷**：初版集合漏了 `render_*`。后果是主会话交付一份多图形块的回答时，会在正文之间连续渲染若干 UI 文档——这些是纯产出，却按 `'all'` 口径被计入静默调用；渲染到第 10 个就触发硬停，把一次正常交付拦腰截断。
  这个缺陷**只影响 `'all'`**：`'read-only'` 口径按定义只数 `READ_TOOLS`，`render_*` 从不在其中，所以那条路径一直是好的。已用 `countsTowardWatchdog(_, 'read-only') === false` 断言并实测确认（`render_*` 的 `inREAD_TOOLS` 为 false）。
- 可切 `read-only`：只数 `read`/`read_image`/`grep`/`glob`/`web_fetch`/`web_search`。
- **为什么默认不是 `read-only`**（任务建议的那个）：读配额已经把读类卡在同一个数字 10 上，两个机制会在同一刻触发，只有先判的那个可见 —— 等于白装一层。`all` 让两者都活着：混合型爆发（读 + skill/todo 等）由看门狗硬停；纯读爆发在被停过一次、介入预算用完后由配额兜住。

#### 12d-1. `render_*` 是否在豁免集里、如何被证明（带行号）

**在。** `guard.js:90-125` 的 `PRODUCTIVITY_TOOLS`，四个被点名的渲染工具实际位置：

```js
// guard.js:104-107
    'render_text',
    'render_ui',
    'render_canvas',
    'render_scene',
```

完整豁免集 28 项，按「调用它是否增加主会话对**代码库的了解**」判据分四组：本插件面（6）、对用户说话（3）、渲染产出（14，`guard.js:104-117`）、文档产出（5，`guard.js:119-123`）。

配套的 `excel_read` / `word_read` / `ppt_read` / `inspect_video` **刻意不在**集合里——把产物读回来确实把内容拉进了上下文，属于研究，继续计数。这一条有断言。

**证明它不会被误判成埋头调研的测试**（`test/guard.mjs` 第 7b 组，两半都必须在，否则证明不了区分度）：

```
ok 7b — twelve rendered blocks deliver without a hard stop; ten silent reads still trip it
```

- **正向**：连续 **12** 次渲染（`render_text`/`render_ui`/`render_scene`/`render_canvas`/`render_mechanism` 循环，12 > 阈值 10）→ 全部 `allow`、`reachedBody === true`、`cancelled.length === 0`、`steered.length === 0`、静默计数保持 `0`。
- **对照**：紧接着连续 **10** 次 `read` → `cancelled.length === 1`，硬停照常触发。

对照那一半是关键：它证明这是**把计数口径收窄**，而不是把看门狗整体关掉。只有正向那一半的话，一个「看门狗完全失效」的实现也能通过。

另有 `guard.js:90` 那组纯函数断言（`test/guard.mjs` 第 1 组）逐一检查 19 个产出型工具在两种口径下都不计数、4 个读取型工具都必须计数。

#### 12d-2. 这个修复只影响 `'all'`，不影响 `'read-only'`

**确认。** `'read-only'` 的实现是 `countsTowardWatchdog` 里 `return READ_TOOLS.has(toolName)`，而 `render_*` 从不在 `READ_TOOLS`（`guard.js` 的 `READ_TOOLS = new Set(['read','read_image','grep','glob','web_fetch','web_search'])`）里。实测：

```
render_ui      all: false  read-only: false  inREAD_TOOLS: false
render_scene   all: false  read-only: false  inREAD_TOOLS: false
render_text    all: false  read-only: false  inREAD_TOOLS: false
render_canvas  all: false  read-only: false  inREAD_TOOLS: false
```

所以 `'read-only'` 模式下**本来就是对的**，这个缺陷只存在于默认的 `'all'`。两个模式都受影响是误解，在此写明。

### 12e. 白名单最终列表与理由

| 规则 | 理由 |
|---|---|
| 主会话 home（`$DSH_HOME/discipline-whale/home`）—— 全开 | 用户明确要求「完全随便读」。它本来就是鲸鱼自己的工作目录 |
| 根级 `README*.md` | 约定俗成的项目门面，写给人看 |
| 任意层 `AGENTS.md` / `CLAUDE.md` | 这两个文件的**存在意义**就是给 Agent 读；子目录版本是给在该目录干活的 Agent 看的 |
| `docs/**/*.md` | 公开文档区，描述意图而非实现 |
| 根级 `*.md`（`CHANGELOG.md` 等） | 顶层文档，同样是门面性质 |
| 根级 `package.json` | 判断技术栈必需；这是唯一被放行的非 Markdown 文件 |
| 其余全部拒绝 | 源码、配置、数据 —— 那就是该派工去读的东西 |

**刻意收紧的两处**（比任务建议更严，理由如下）：

1. **`README*` 只在根级**。建议里写的是「仓库根的 `README*.md`」，但 `src/README.md`、`packages/x/README.md` 是源码树里的位置，不是门面。同样，嵌套的 `package.json`（如 `packages/x/package.json`）不放行 —— 判断一个仓的技术栈看根级那个就够。
2. **隐藏路径段一律拒绝**：`.env`、`.ssh/`、`.git/config` 无论在哪层都不放行，免得白名单被一个 `.md` 后缀绕成密钥读取器。

**`grep` / `glob` 只允许在 home 内**。这是整树遍历，无法事后按文件过滤；一次 `grep -r` 就能把白名单想拦的源码全读进上下文。让它们只能搜自己的 home，是把「范围层」做成了真约束而不是装饰。

**不误伤的既有能力**：`read_report`（插件自己的报告在数据目录，不是被保护的工作区文件）、`list_workspaces`、`dispatch_task` 都不是文件读，三条通道都不经过白名单。

**`read_image` 的定位**：算**一次读**（它确实把文件内容拉进上下文），同样受路径白名单约束。不把它排除在配额之外，否则 10 张图就绕过整个范围层。

**路径穿越**：按 `realPathOf()` 解析后的真实路径判定，叶子不存在时向上找最深的已存在祖先再拼回尾部。符号链接按目标判定 —— 有一组专门测试（home 里放一个指向工作区源码的软链 → 拒绝；指向 README 的软链 → 放行）。这是复用 `store.js` 里 `isReportId` 的同类严格度（那里是字符白名单，这里是解析后路径判定）。

### 12f. 拒绝文案原文

配额用尽（`quotaExhaustedReason`）：

```
[Discipline Whale] Read quota exhausted — 0 of 10 read calls left in this reply. Stop reading now: answer the user with what you already have, then route the rest of the work with `dispatch_task` (or `send_to_session` for a running worker). The quota refreshes as soon as you produce user-visible text.
```

越界（`readScopeReason`）：

```
[Discipline Whale] Read blocked — "<path>" is outside the main session's read scope. Readable: anything under your own home (<home>); public documents inside a registered workspace: README*.md, AGENTS.md, CLAUDE.md, docs/**/*.md, top-level *.md, and package.json. Source files, configs, and data are not readable from the main session. To inspect this file, dispatch a worker into that workspace with `dispatch_task` and let it read it.
```

两条都是 `{ kind: 'deny', reason }`，由 `dsh-tools/lib/index.js:3342` 物化成带 `Error:` 前缀的模型可见结果 —— 所以是「说了一句话」，不是无声失败。

### 12g. 注入 prompt 全文（原文照抄，供审阅）

```
[Discipline Whale] Hard stop: 10 tool calls in a row produced nothing for the user.
This turn has been terminated.

Do not read any more files. Do this now, in this order:
1. Give the user the conclusion you already have, in plain text — even if it is incomplete.
2. Dispatch the remaining work with `dispatch_task` (one dispatch per separable piece) and say
   which workspace you chose and why, in one line.
3. If nothing is worth dispatching, say so and ask the user what to do next.

Your read budget has been reset to 10 for this reply. Do not spend it on more
investigation: the main session's job is to talk to the user and route work, not to read
the codebase.
```

防死循环停下时（`brakeExhaustedNotice`）：

```
[Discipline Whale] 主会话异常，已停止干预：本轮已经强制回话 2 次，主会话仍在连续调用工具而不回复。
The forced-reply brake has stood down for the rest of this turn. The read quota still applies,
so reads beyond it will be refused. Open the session and check it manually, or send a new
message to re-arm the brake.
```

### 12h. 防死循环策略

1. **每次硬停都重置配额和静默计数**（`state.reads = 0; state.silent = 0`），否则被迫回话时什么都做不了 —— 这正是任务里点名的坑。
2. **介入预算** `MAX_FORCED_INTERVENTIONS_PER_TURN = 2`，记在 per-session 状态里。超预算后**不再 `cancel()`**，只推一次「已停止干预」通知（`cappedNotified` 保证只推一次）。
3. **预算只由真实用户消息重置**（`agent/inbox/claimed` 且 `source.kind === 'user'`）。注入的 notice 也是 user-role 消息，如果它也重置预算，「终止→注入→再终止」就会无限循环。
4. 预算用完后配额**仍然生效**，所以最坏情况是被配额挡住，而不是刷钱。
5. `maxInterventions: 0` 是合法配置，含义就是「完全不干预」—— 测试用它把配额的单独行为隔离出来。

### 12i. 改动文件清单

| 文件 | 改动性质 |
|---|---|
| `guard.js` | **新增**。三道机制全部在此，阈值常量化并集中 |
| `main.js` | **追加式 3 处**：`guard.js` import（1 行）、`apply()` 末尾 `installGuard(...)`（5 行含注释）、`Config` 里透传 4 个 guard 键（6 行含注释）。**未删任何现有行**，未碰 persona / `dispatch_task` / `send_to_session` / 续接逻辑 |
| `cordis.patch.yml` | **追加式 1 处**：`discipline-whale-main` 行的 `config` 里加 4 个键 + 注释块。未动 persona 段落 |
| `package.json` | 2 行：`./guard` export、`guard.js` 进 `files` |
| `test/guard.mjs` | **新增**。10 组（1、2、3、4、5、6、7、7b、8、9），含渲染豁免的区分度测试与真实 scope 投递验证 |
| `test/contract.mjs` | **追加**第 24 块（17 行 `ok 24`）。未改任何既有用例 |
| `README.md` | **新增**「主会话的三道刹车」一节；测试小节里更新计数与新增第 24 条、guard.mjs 说明。未重写他人章节 |
| `VERIFICATION.md` | **新增**本节（12）。未改其他章节 |

### 12j. 与并行 worker（`session-030e388c`）的共存

**结论：无重叠、无冲突。**

- 它改 persona 指令文本与 `dispatch_task` / `send_to_session` / 续接语义；我改 `guard.js` 与三处挂载点。
- 我在**它已经改过的最新 `main.js`**（含 `resumeDispatchTool` / `abandonDispatchTool` / `normalizeTopic` / 七工具注册）之上重做小改动，未回退任何它的编辑。`git diff main.js | grep installGuard` 只有我的 3 段。
- **我从未写过 persona 文本**，没有需要「让渡」的东西。
- **我发现的既有失败（不是我的）**：`node test/contract.mjs` 第 21 块（`send_to_session` 的 `delivered`/`aborted` 形状）当前失败，因为实现返回 `{sessionId, accepted, interrupted}` 而测试仍断言 `{delivered:'queue', aborted:false}`。我把 `main.js` 的三段改动临时摘除后重跑，**同样的失败仍在**，证明与我的改动无关。这是那个 worker 的在途工作。

### 12k. 测试输出原文

```
$ node test/guard.mjs
ok 1 — whitelist, watchdog accounting, defaults and refusal texts
ok 2 — the 11th read is refused with a self-explaining reason
ok 3 — a reply refreshes the quota; the worker preset is untouched by all three
ok 4 — 10 silent calls cancel the turn, inject the forced-reply prompt, and reset the quota
ok 5 — after the intervention budget the brake stops intervening, tells the user once, then re-arms
ok 6 — home free, public documents allowed, source and traversal refused with a reason
ok 7 — symlinks are decided on the resolved target, not the visible name
ok 8 — the classifier uses path-segment containment, not string prefixes
ok 9 — the real scope graph delivers the agent-keyed signals; session/event provably does not

All discipline-whale guard checks passed.
```

我的第 24 块单独跑（摘出 header + block 24，绕过当前失败的第 21 块）：

```
$ node test/.probe24.mjs
ok 24 — main.apply installs the guard; configured thresholds apply; a worker Session is untouched

All discipline-whale contract checks passed.
```

`node test/contract.mjs` 在第 21 块之前**全绿**（1–20、15b 全部 `ok`），第 21 块失败属于并行 worker 的在途改动（见 12j）。

### 12l. 重启与生效说明

**没有**重启用户正在跑的 `dsh web`，**没有**改动 `$DSH_HOME/plugins/` 的线上安装。

```bash
cd /Users/huiyuan/Developer/projects/discipline-whale
scripts/install-local.sh          # 打包并装进 profile "web"
# 然后由用户在自己的终端里：
#   1) 停掉当前 dsh web（Ctrl-C）
#   2) 重新 `dsh web`
#   3) 打开侧边栏「自律鲸鱼」—— 必须是**新**主会话
```

**已存在的主会话仍然用旧组合。** preset 行在 Session 创建时绑定（`AgentPresetsService.join` → `bindScopeParent(agentKey, generation.key)`），并且 `agentPreset` 是 durable 的会话头字段。重启后旧 Session 恢复时沿用原先绑定的 preset generation，**不会**自动获得 `guard.js` 的三道刹车。要验收必须新建一个主会话。

### 12m. 未验证清单（逐条给验证步骤）

| # | 未验证项 | 验证步骤 |
|---|---|---|
| 1 | 真机硬停：连续 10 次读真的会被 `agent.cancel()` 停住 | 新建主会话，让它「把这个仓库读一遍」，数到第 10 次读；确认回合被中止、随后出现注入的 `[Discipline Whale] Hard stop` 那条 notice、主会话开始回话 |
| 2 | 注入 prompt 真的作为**新回合**跑，而不是被吞掉 | 观察硬停后的下一条消息是否是独立回合（`turn/start` 增 1），并确认它确实先文字回话、再 `dispatch_task` |
| 3 | 真机上配额是否在第 11 次读时拒绝，且模型能读懂并改行为 | 让主会话连读同一目录 12 次；第 11 次应返回 `Read quota exhausted — 0 of 10`，之后它应停止读并回话 |
| 4 | 介入预算停在 2 次且只通知一次 | 让主会话持续空转（每次回话极少、立刻又读）；确认最多停 2 次，之后只出现一条「已停止干预」，不再有新的中止 |
| 5 | **是否误伤正常讨论**（最需要人看的一条） | 和鲸鱼进行一段长讨论：它会 `read_report`、`list_dispatches`、`ask_user_question`、`present`。这些都不计数，确认讨论过程没被打断、没有被配额挡 |
| 6 | 白名单在真实工作区路径上是否过严 | 让鲸鱼读 `README.md`、`docs/xxx.md`、`package.json`（应放行），再读 `src/index.js`（应被拒并给出派工建议） |
| 7 | 符号链接在真机上是否按真实路径判定 | 在鲸鱼 home 里 `ln -s <某工作区源码> link.js`，让它读 `link.js`，确认被拒 |
| 8 | 硬停打断「派工刚返回、还没来得及说明」时的用户体感 | 让主会话连续派工同时大量读；观察是否出现「有活出去了但用户不知道」的窗口，以及注入 prompt 是否把它补上 |
| 9 | `watchdogCounting: read-only` 在真机上的行为 | 改 `cordis.patch.yml` 为 `read-only`，重启，确认混合型爆发（读+skill）不再触发硬停、只有 10 次读触发 |
| 10 | worker 完全不受影响 | 派一个需要读几十个文件的活；确认它一路读到完、没有被配额或白名单挡住、没有被 steer 干扰 |

---

## 11. 更正：三种投递时机，以及「Interrupt」到底是哪一种（2026-10-21 晚）

### 11a. 先回答那个会改变结论的问题

> `send_to_session` 用的 `prompt({ mode: 'queue' })`，是「等整个 turn」还是「步边界插话」？

**`queue` = 等整个 turn（第 1 种）。步边界插话（第 2 种）是 `steer`，Host 本来就有，不需要新 API，也不需要硬中止。**

上一份报告 §10d 把「Interrupt」实现成 `cancel + steer`（硬中止），这是**错的**方向：用户要的是第 2 种（在同一个 turn 内、当前 tool call 结束后插话），而我给他的是第 3 种。

### 11b. 证据链（全部是 Host 源码行号，可自行核对）

```
$ sed -n 949p @deepseek-ai/dsh-api-session-controller/lib/index.js
					if (request.mode === "steer") agent.steer(message);
					else agent.followup(message);

$ sed -n 806,811p @deepseek-ai/dsh-agent-loop/lib/index.js
	followup(input) {
		this.send(input, "next-turn", true);
	}
	steer(input) {
		this.send(input, "next-step", true);
	}

$ sed -n 103,106p @deepseek-ai/dsh-agent-loop/lib/index.js
	claim(target, turn) {
		const claimed = this.mutate("next-step", 0, this.nextStep.length, [], false);
		if (target === "next-turn") claimed.push(...this.mutate("next-turn", 0, 1, [], false));

$ sed -n 951p @deepseek-ai/dsh-agent-loop/lib/index.js
		let target = "next-turn";
$ sed -n 1008p @deepseek-ai/dsh-agent-loop/lib/index.js
				target = "next-step";
```

推理（三步，全部有源码支撑）：

1. `prompt(mode:"queue")` → `followup` → inbox **`next-turn`**；`prompt(mode:"steer")` → `steer` → inbox **`next-step`**。
2. `claim()` 在**每一个**步边界都无条件清空 `next-step`（第一行），而 `next-turn` 只在 target 是 `"next-turn"` 时才被取走一条（第二行）。
3. turn 循环以 `target = "next-turn"` 开场（L951），首步之后切到 `"next-step"`（L1008）。因此：**`steer` 必然在同一个 turn 的下一个步边界被读到；`queue` 要等这个 turn 结束。**
4. `prompt.mode` 的枚举只有 `["queue","steer"]`（`lib/typert.host.js:1795`）——**没有 `interrupt` 模式**。Host 团队把它叫「最近步边界」（`dsh-experimental-tool-agent-team` 的 `send_message` 描述：「A running target receives it at the nearest step boundary」），而 `send_message` 的实现就是 `root.steer(input)`（`dsh-experimental-agent-team/lib/types/index.js:196`）——**同一个 primitive**。

### 11c. 三种时机对照（实现后的口径）

| 时机 | 参数 | Host 路径 | 生效点 | 代价 |
|---|---|---|---|---|
| 排队 | `at: "queue"` | `followup` → `next-turn` | 整个 turn 结束 | 方向错了要白跑完整个 turn |
| **步边界插话（用户要的 Interrupt）** | `at: "step"`（**默认**） | `steer` → `next-step` | 当前 tool call 结束、下一步之前 | 长跑工具调用要等它结束；**不是瞬间** |
| 硬中止 | `at: "abort"` | `cancel()` + `steer` | 立刻打断工具调用 | 可能留半截状态；最后手段 |

为什么 `step` 更好：上下文不丢（同一个会话，已读文件与判断都在，不必重读）、已做工作不废（tool call 正常收尾）。代价是「最近一个步边界」，不是「立刻」——这一点写进了 persona 和 README，不许对用户暗示成瞬时打断。

### 11d. 测试怎么钉住这件事

- **ok 25** 直接读 Host 源码做正则断言（`followup`→`next-turn`、`steer`→`next-step`、`claim` 的无条件 drain、turn target 切换、`prompt.mode` 枚举）。Host 升级改变语义时这条会红，而不是悄悄把「步边界」变回「等 turn」。
- **ok 21** 断言三种时机各自调用哪个 primitive：`queue` 不 cancel；`step`（含省略 `at` 的默认）走 `mode:"steer"` 且不 cancel；`abort` 才 cancel。
- **ok 22** 断言 `dispatch_task` 复用活会话时**默认**就是步边界（`deliveredAs: "step"`、`mode: "steer"`、不 cancel），`at:"queue"` 与 `at:"abort"` 各自可选。
- **ok 23** 断言 persona 写明「不是『立刻』」「上下文不丢」「最后手段」，且不再出现旧的 `interrupt: true` 中止口径。

### 11e. 这次仍然没有验证的

- **模型行为**：ok 23 只证明文本进了 system prompt。模型是否真的优先续接而不是新建、是否真的选 `step` 而不是 `abort`，没有断言，也没有 A/B 观测。
- **真机重启**：未重启 `dsh web`，因此「重启后新主会话拿到新纪律」未实测。preset 行与 persona 在会话创建时装配，已存在的主会话仍是旧 prompt。
- **真实 worker 上的步边界时序**：只从源码证明了 `steer` 落在 `next-step`，并在 fake Host 上断言了投递调用。没有真实拉起一个 worker、在它跑长工具调用时插入一条 `steer` 去观察「下一步才看到」这一时序。

---

## 12. 三档并列：「Interrupt」到底落在哪一档（2026-10-21 再修正）

用户读完 §11 后指出：代码里 `cancel + steer`（硬中止）是**第 3 种**，而他要的是**第 2 种**。核查结论如下——**实现本身已经默认走第 2 种（纯 `steer`，不 cancel）**，缺的是三档表述、设计意图说明和一条专门的回归测试。本轮补齐这三样。

### 12a. 三档并列（含「会不会打断正在跑的工具调用」）

| # | 落点 | 机制 | 生效点 | 打断正在跑的工具调用？ | 用途 |
|---|---|---|---|---|---|
| 1 | `next-turn` | `prompt({mode:'queue'})` → `followup` → `dsh-agent-loop:806` | 整个 turn 跑完 | 否 | 不想打断它当前的活，只补一条不影响方向的说明 |
| **2** | **`next-step`** | `prompt({mode:'steer'})` → `agent.steer` → `dsh-agent-loop:809`；`claim()` 在下一个 tool 边界取走（`:103-105`，turn 首步后 target 切到 `next-step`，`:951`/`:1008`） | **当前 tool call 收尾、下一步之前，同一 turn 内** | **否——这是设计意图，不是缺陷** | **同一件事的延续（默认）** |
| 3 | 立即 abort | `sessionController.cancel()` 再 `steer` | 立刻 | **是**，可能留半截状态 | 只在它已经在写错的文件、等不起时 |

**第 2 档不打断正在跑的工具调用，是刻意的**：硬中止会留下半截状态（brief 写一半、文件改一半），那正是这一档要避免的代价。因此它不是「不够快」的妥协，而是正确语义。

### 12b. 本轮实测（不靠记忆，跑出来的）

用一个假 Host 直接调 `main.js` 注册的 `send_to_session`：

```
omitted at (default)   | delivered= step    | aborted= false | cancel calls= 0 | prompt mode= steer
at=step                | delivered= step    | aborted= false | cancel calls= 0 | prompt mode= steer
at=queue               | delivered= queue   | aborted= false | cancel calls= 0 | prompt mode= queue
at=abort               | delivered= abort   | aborted= true  | cancel calls= 1 | prompt mode= steer
```

`dispatch_task` 复用同一 topic 的活会话：

```
first:  dispatched reused= false
second: reused     reused= true deliveredAs= step | cancel calls on reuse = 0 | prompt mode = steer
```

→ 默认那条路（`step`，含省略 `at`）与 `dispatch_task` 复用，**cancel 调用次数都是 0**。`abort` 是唯一会 cancel 的分支。

### 12c. 本轮改动

| 项 | 内容 |
|---|---|
| 回归测试 | 新增 **ok 26**：默认/显式 `at:"step"` 都 `mode:"steer"` 且 `cancel` 数为 0；`queue` 也不 cancel；只有 `at:"abort"` 调一次 cancel；`dispatch_task` 复用同样不 cancel。step 路径上只要出现 `cancel` 就红 |
| persona §4 | 三档写在一起，并写死「**不许对用户暗示成瞬时打断**」；`abort` 明确为最后手段、用前说明代价；`queue` 用途改为「不想打断它当前的活，只补一条不影响方向的说明」 |
| README | 「三种投递时机」表改为三档并列，新增「会不会打断正在跑的工具调用」一列，并写明**不打断是设计意图不是缺陷**、准确口径是「最近一个步边界」不是「立刻」 |

### 12d. 仍然没有验证的

- **模型行为**：ok 23/25/26 只证明文本进 prompt、时机语义与 Host 一致、纯 steer 路径不 cancel。模型是否真按三档选择，未做 A/B。
- **真机重启**：未重启 `dsh web`，已存在的主会话仍是旧 prompt。
- **真实 worker 上的时序**：`claim()` 在下一步取走 `next-step` 是从源码推出的；没有拉起真 worker 在长工具调用中途插话观察确切时刻。
- **`abort` 的半截状态**：按 `cancel` 打断工具调用推断，未构造写文件中途被中止的实测。

---

## 14. 语音条第二轮：话筒/静音拆分、设置界面、独立窗口（2026-10-21 凌晨；本节追加在文件末尾，编号接在既有章节之后）

本节只写**这次改动**验证了什么、没验证什么。第一轮的转写证据（11a–11h）仍然有效。

### 14a. 桌面宠物插件调研（真实抓取，附机制）

用户要求「去插件市场搜桌面宠物插件，看它们怎么做到脱离页面」。下面每条的机制都来自**商店页面内嵌的 manifest 原文**（Chrome Web Store 的详情页把 `manifest.json` 塞在页面的 JSON 里，可以直接读 `permissions` / `content_scripts` / `action`），不是猜测。

| 插件 | 评分 / 用户数 | 机制（manifest 证据） |
| --- | --- | --- |
| **Pets Chrome**（CodeOz，v1.2.1） | 3.1 ★ / 40,000 | `permissions:["storage"]`，`content_scripts` 注入 `content.js` + `content.css` 到 `<all_urls>`，`action.default_popup: menu.html`。宠物是**注入到每个页面的 DOM**，用 popup 做设置。**没有**任何常驻窗口。 |
| **Desktop Pet: Virtual Companions**（v1.31.0） | 4.3 ★ / 962 | `permissions:["storage","scripting","identity","alarms"]`，`host_permissions:["http://*/*","https://*/*"]`，`background.service_worker: background.js`，`content_scripts` 注入 `content.js` 到全站，`action.default_popup: popup.html`，`web_accessible_resources: bundle/*.png`。**机制同上是 content script + popup**，多一个 service worker 管状态。 |
| **Screen Pet - Desktop Companions**（v1.0.0） | 4.6 ★ / 42 | `permissions:["storage"]`，`content_scripts` 注入 `content.js` + `overlay.css`，`exclude_matches: *://chrome.google.com/webstore/*`，`web_accessible_resources` 里带 `p5.min.js` / `Pet.js` / `Cat.js`。**注入 + 固定定位 overlay**，用 p5 画。 |
| **Always on Top Window**（v3.5.6） | 4.7 ★ / 70,000 | `minimum_chrome_version:"148"`，`permissions:["activeTab","scripting","contextMenus","storage","declarativeNetRequestWithHostAccess"]`，`host_permissions:["<all_urls>"]`，background service worker + `content-scripts/content.js`（含 `all_frames:true` 的第二条）。**观察到的机制方向是 content script 注入 + 脚本在页面里造浮层**，而不是原生窗口。 |
| **Flobro - Always on Top Floating Window** | 4.9 ★ / 740 | 同上一条的 manifest 指纹（同一套 `content-scripts/esm/*`），说明这类「置顶窗口」扩展普遍仍是 **content script 造浮层**。 |
| **Picture in Picture - floating video player** | 3.8 ★ / 400,000 | `content_scripts` 到 `<all_urls>`（`all_frames:true`、`document_start`）+ `background.service_worker`，用的是**视频 PiP**，不是 Document PiP。 |

**调研结论**：商店里的「桌面宠物」几乎全是 **content script 注入 + popup 设置**，宠物随页面走，**切页面就重注入、关标签就没了**，并没有真正的「脱离页面常驻」。所谓「always on top」扩展也多是页面内浮层。**没有一条**能在浏览器最小化后仍然可见——这和 Web 平台边界一致。因此本插件不复制它们的注入方案（一个 DSH 插件已经天然是页面里的 overlay），而是**升级到 Document Picture-in-Picture**，这是浏览器真正提供的 always-on-top 窗口。

**Document PiP 的官方约束**（`developer.chrome.com/docs/web-platform/document-picture-in-picture`，原文要点）：

- Chrome/Edge **116+**；`documentPictureInPicture.requestWindow(options)`「rejects if it's called without a **user gesture**」；
- 窗口「floats on top of other windows」，并且「never outlives the opener」——**页面关闭即消失**；
- 特性检测：`if ('documentPictureInPicture' in window)`；
- 关闭事件：监听窗口的 `pagehide`。

这三条直接决定了实现：调用必须挂在**按钮点击**上（不能自动开）、`pagehide` 里收回状态、页面卸载时 `close()`。

### 14b. 依赖决策：不引库

| 库 | 最新版 | 会带进来的依赖 |
| --- | --- | --- |
| `react-rnd` | 10.5.3 | `tslib`、`re-resizable`、`react-draggable`（后者又带 `clsx`、`prop-types`） |
| `@dnd-kit/core` | 6.3.1 | `tslib`、`@dnd-kit/utilities`、`@dnd-kit/accessibility` |
| `react-draggable` | 4.7.2 | `clsx`、`prop-types` |

`client.js` 是 `window.__ModuleLoader__.load({...})` 里的 plain JS，**无构建步骤**，插件**禁止外链 CDN**。引入任何一个都要手工把整棵依赖树 vendoring 进仓库，而实际只需「拖动 + 吸附」这一小块。**结论：不引，用原生 Pointer Events**（`setPointerCapture`，约 30 行，含触摸/笔）。吸附/夹取是纯函数 `snapDockPosition`，由 `test/dock.mjs` ok 5 直接验算，不是「看起来能拖」。

### 14c. 密钥存储位置：先查 Host，再回落

查了 Host（`~/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/`）：

- **`dsh-settings`（`ctx.settings`）不合适**：它是「把 plugin Config schema 投影成表单」的机制，写的是 profile patch 的 config 段。把 API key 塞进 plugin config 会**明文进 profile 的 `cordis.patch.yml`**，正是用户禁止的「明文进 repo/配置文件」。
- **`dsh-credentials-local`（`ctx.credentials`）正是该用的面**：写 `$DSH_HOME/.credentials.yaml`，`writeFileAtomic(..., { mode: 384 })`（= 0600），并且 `describe(ref)` 只回 `{ configured, source, writable }`，**结构上就没有装 value 的字段**。
- 它由 `dsh-base` 的 patch 挂载（`- id: credentials / name: '@deepseek-ai/dsh-credentials-local'`），但 **minimal/headless 组合可能没有**，所以必须能回落。

**实现**：`voice-settings.js` 优先用 `ctx.credentials`（`home.js` 里 `ctx.get('credentials')` 可选注入），不可用/抛错时回落到 **插件自己的 `$DSH_HOME/discipline-whale/voice.json`，创建即 0600**。

**的回落顺序**：设置界面 → 环境变量 `SOCLAAS_API_KEY` / `SOCLAAS_BASE_URL` → 未配置。设置优先，理由与 Host 凭据面的既定语义一致（`dsh-credentials-local` 的源码注释：managed store 必须压过环境，保证「a credential the user explicitly saved in the product must take effect consistently」）。

### 14d. 设置读写与「key 不回显」：真实跑出来的证据

真实跑 `voice-settings.js` 的路由（临时 `DSH_HOME`，`env -i` 干净环境），输出已把 key 替换为 `***REDACTED***`：

```
$ env -i PATH="$PATH" HOME="$HOME" node /tmp/e2e-settings.mjs
save HTTP 200
save body {"baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","baseUrlSource":"settings","model":"whisper-large-v3","language":"zh","hasApiKey":true,"keySource":"settings","apiKeyEnv":"SOCLAAS_API_KEY","baseUrlEnv":"SOCLAAS_BASE_URL","tts":{"integrated":false,"model":"","voice":""}}
key in save response? false
settings file: /tmp/dw-e2e-JPPeLQ/discipline-whale/voice.json
mode: 600 size: 149
read body {"baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","baseUrlSource":"settings","model":"whisper-large-v3","language":"zh","hasApiKey":true,"keySource":"settings", ...}
key in read response? false
status {"configured":true,"keySource":"settings","apiKeyEnv":"SOCLAAS_API_KEY","baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","model":"whisper-large-v3","language":"zh","maxBytes":26214400,"maxSeconds":120,"tts":{"integrated":false},"source":"NUS SoCLaaS (cloud transcription)"}
key in status? false
probe HTTP 200
probe body {"ok":false,"code":"voice/invalid-key","baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","status":401,"ms":37,"message":"the backend rejected the key (HTTP 401)"}
key in probe response? false
```

四条结论，都是**实测**：

1. 保存/读取/状态三个响应体里都**没有** key（`includes(SECRET) === false`）；
2. 落盘文件是 **`mode: 600`**（`stat` 读出来是八进制 600）；
3. `/voice/status` 现在**报来源**：`keySource: "settings"`；
4. 测试连接**真的打到了 SoCLaaS**（真网络，37ms），拿回 **401** 并归类成 `voice/invalid-key`——用的是故意伪造的 key，所以 401 是预期结果，证明「拒绝能识别、原因可读、key 不回显」。

### 14d-2. 测试连接的真实成功路径（真 key，真网络）

上一节的 401 是伪造 key 的拒绝分支。用**启动 shell 里真实的** `SOCLAAS_API_KEY` 再打一次，验证成功分支：

```
$ env -i PATH="$PATH" HOME="$HOME" zsh -lc 'node /tmp/e2e-realkey.mjs'
key present in env? true
probe: {"ok":true,"code":"voice/test-ok","baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","status":200,"ms":85,
        "models":["bge-m3","gemma4:26b","llama3.1:8b","ornith1.5:35b","qwen3.5:9b","qwen3.6:35b","qwen3.8:27b",
                  "qwen3-coder-next","qwen3-vl:32b","whisper-large-v3","x-test-1","x-test-2","coder","coding",
                  "default","ornith1.0:35b","qwen3.6:27b"],
        "message":"reachable and authenticated (HTTP 200, 17 models)"}
key in output? false
```

三条结论：`/models` 是**可用的轻量探测端点**（85ms，不计费，不需要音频）；返回的模型列表里**确实有 `whisper-large-v3`**，说明默认模型名是对的；整条输出里**没有 key**。

同一个凭据面在设置保存后的优先级（假 Host 但真实模块逻辑）：

```
$ env -i PATH="$PATH" HOME="$HOME" node /tmp/e2e-seam.mjs
env layer   -> env | hasKey true            # 只有环境变量
seam store  -> settings | hasKey true       # 通过设置保存后，settings 压过环境
plugin file holds a key? false              # 用了 ctx.credentials 就不在插件文件留副本
after clear -> env | hasKey true            # 清除后回落到环境变量
```

### 14d-3. TTS 口径更正（用户 03:24 的指令）

用户明确：**浏览器朗读作为 fallback 保留**，但**不要**把它说成「已接入 TTS」，也不要说得像「TTS 完全不存在」。

改的只有**文案与设置字段**，`speakReply` / `speakable` / `speechLanguage` / `speak` 状态 / 半双工等待逻辑**一行没动**（那是并行会话 `session-59f63b9f` 恢复的实现，我按指令不碰）。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 设置块标题 | `TTS（未接入）` | `真实 TTS（未接入）`——把「未接入」限定到**真实 TTS**，不否定 fallback |
| 设置块说明 | 「本插件尚未接入 TTS：没有云端 TTS 的 key、模型或音色可配。回复只显示文字……」 | 「当前只有浏览器内置语音合成作为 fallback（通话条上的「朗读回复」，默认关闭）……真实 TTS（如 MiniMax）尚未接入，需要单独一把 key——下面四个字段留作将来，现在不可编辑。」 |
| 占位字段 | 模型、音色（2 个） | **Base URL、模型、音色、API Key（4 个）**，全部 `disabled`，key 是 `type="password"` |
| key 提示 | 无 | 「真实 TTS 需要它自己的那把 key，与「服务与密钥」里的转写 key 不是同一个。」 |
| `/voice/status`、`/voice/settings` 的 `tts` | `{integrated:false, model:'', voice:''}` | `{integrated:false, fallback:'browser-speech-synthesis', fallbackDefaultOn:false, needsOwnKey:true, configurable:false, model:'', voice:'', baseUrl:''}` |

通话条的朗读开关与文案**本来就符合这次口径**（`speakNote`：「浏览器语音合成（fallback，非真实 TTS）……默认关闭」），所以未改。

**红 → 绿**（先加断言，确认红在旧文案，再改）：

```
$ node test/dock.mjs         # 新 ok 10 加入后、改文案前
AssertionError [ERR_ASSERTION]: zh.settingsTtsNote must say the fallback is off by default
  actual: '本插件尚未接入 TTS：没有云端 TTS 的 key、模型或音色可配。回复只显示文字；浮层里可选的朗读是浏览器自带语音合成（fallback），不是这一项。'
  expected: /默认关闭|默认/
    at file:///.../test/dock.mjs:372:12
```

新 ok 10 同时钉住四条：必须提到浏览器 fallback、必须说它默认关闭、必须说真实 TTS 未接入、必须说字段是「留作将来」的占位且需要**单独**的 key；并断言文案**不得**出现「已接入 TTS / TTS is integrated」。渲染层再断言四个占位都在、都 `disabled`、都为空值、都有一个 `password` 类型的 key 格。

### 14d-4. 范围收窄：只留功能骨架，视觉交给接手方

用户决定视觉优化与 ChatGPT 复刻**不在本会话做**，由另一个能看图的 Claude 接手。因此本轮做的是**结构收窄**，不是加功能，也不是改外观：

| 动作 | 具体 |
| --- | --- |
| **保留** | 话筒/静音状态机、静音零处理与 VAD 清洁、设置界面与密钥存储/回落、PiP 脱离会话页、全部相关测试 |
| **停止** | 不再调颜色/圆角/阴影/间距/动效/布局；不做 ChatGPT 复刻；不花时间在 `.dw-*` 样式细节 |
| **新增（唯一实质改动）** | 把两处**写死在逻辑里的视觉值**挪进样式层，使外观可整体替换 |

挪的是这两处：

1. `copyStylesInto()` 之前直接写 `body.style.margin` / `body.style.background`。这违反「逻辑分支不得 setStyle」；现在只加一个 `body.dw-detached` class，具体长什么样由 `dockStyles()` 里已有的 `body.dw-detached …` 规则决定。
2. `onDragMove()` 之前直接写 `node.style.left/top/right/bottom`。现在只写一个边（`data-dw-anchor`）和两个数字 `--dw-dock-x` / `--dw-dock-y`（距该边、距底）；由 CSS 的 `.dw-dock-host[data-dw-anchor]` 决定它们移动哪些盒子。

**外观没有变化**：默认仍是右下角锚定、360px 宽、同样的圆角与配色；拖拽行为等价（同一套 `snapDockPosition` 数值）。改的只是「这个值由谁表达」。

红 → 绿：

```
$ node test/dock.mjs      # 新 ok 11 加入后，dockStyles 还没导出时
AssertionError [ERR_ASSERTION]: the stylesheet is one exported function
  actual: 'undefined'
  expected: 'function'
    at file:///.../test/dock.mjs:430:10
```

`ok 11` 钉住五件事：`dockStyles()` 是**导出的单一函数**且真的含 `.dw-dock-host` / `.dw-ctl-mic` / `.dw-ctl-mute` / `.dw-status-listening` / `.dw-settings` / `body.dw-detached` / `--dw-dock-x` / `--dw-dock-y`；`copyStylesInto` 与 `onDragMove` 的**代码体**（已剥注释）不得出现 `.style.` 的视觉属性；拖动必须通过 `setProperty` / `--dw-dock-` 发布几何。

**并行的第三个会话**（i-have-adhd 那条线）在我改完后把 `test:all` 改成了 `contract && guard && adhd && voice && client`，把 `dock` / `settings` 两条去掉了。我**只做加法**（保留它的 `adhd`，把两条追加回去），没有回退它的编辑。当前 `test:all` 覆盖三个会话的全部套件，97 项全绿。

### 14e. 全部测试（原文）

```
$ node test/voice.mjs
ok 1 — the status route reports configuration without the key
ok 2 — missing key, wrong container and empty audio are structured refusals
ok 3 — byte and duration caps refuse oversized recordings
ok 4 — one recording is forwarded once and its transcript returned
ok 5 — upstream failures map to invalid-key / no-model / unreachable / timeout
ok 6 — both voice routes register on connection.fetch
ok 7 — 10s silence, 500ms minimum speech and 60s cap are named constants
ok 8 — 10s of silence ends the utterance and a silent room uploads nothing
ok 9 — speech then 10s of quiet stops and marks the recording for upload
ok 10 — the threshold adapts to the room instead of being one magic number
ok 11 — an utterance shorter than the minimum speech threshold is not uploaded
ok 12 — the 60s backstop cuts a recording that never goes quiet
ok 12b — the 1s minimum recording length is enforced
ok 12c — a loud room raises the threshold, and room tone still counts as quiet
ok 12d — one transcript is queued into the recorded main session only
ok 13 — a late transcript cannot land after hangup or a session switch
All discipline-whale voice checks passed.

$ node test/dock.mjs
ok 1 — microphone (device) and mute (drop data) are independent, and mute needs the device
ok 2 — while muted every frame is discarded before the detector sees it
ok 3 — a muted stretch does not count as silence, and unmute cannot end the utterance early
ok 4 — Document PiP is preferred, a popup is the fallback, and "in-page only" is stated
ok 5 — snapping is pure arithmetic: clamp, snap to the nearest edge, keep the margin
ok 6 — the settings draft omits an untouched key and only sends a clear on purpose
ok 7 — the dock renders microphone and mute as two separate, independently pressed controls
ok 8 — every detach path degrades honestly, and snapping stays finite at zero size
ok 9 — a mid-utterance mute neither adds speech nor records length nor pre-ends the utterance
ok 10 — settings TTS copy keeps the fallback, denies integration, and marks the fields as placeholders
ok 11 — the logic/visual seam holds: one stylesheet, no inline visual values, geometry via variables
All discipline-whale dock checks passed.

$ node test/settings.mjs
ok 1 — settings round-trip through the route, with no key in either answer
ok 2 — the settings file is created with mode 0600 inside the plugin data directory
ok 3 — settings → environment → default, reported per field and per source
ok 4 — bad base URLs, models, languages and keys are refused before any write
ok 5 — the connection probe logs an outcome line that never contains the key
ok 6 — the probe distinguishes ok / rejected key / missing key / unreachable / timeout / bad path
ok 7 — /voice/status reports env / settings / none without ever returning the key
ok 8 — the settings and probe routes register on connection.fetch, beside the transcription routes
ok 9 — the Host credential seam is used when present; the 0600 file is the fallback
ok 10 — the settings document lives only in the plugin data directory
All discipline-whale voice-settings checks passed.

$ node test/client.mjs
ok 1 — the browser detector mirrors the shared algorithm frame for frame
ok 2 — the constants and the call guard ship with the browser half
ok 3 — both dictionaries carry every voice key; read-aloud is described as a browser fallback
ok 4 — the reply reader takes only the new turn; the fallback speech shaper is restored
ok 3a — off returns to ready without awaiting; on is bounded by a timeout backstop
ok 3b — a live call retains the main session and releases it on hangup
ok 3c — a call creates the main session when none is recorded, and never uses a dead one
ok 5 — the dock registers into shell.overlay beside the whale page
ok 6 — the open dock shows status, transcript, reply, hang-up, privacy, the read-aloud fallback and two separate controls
All discipline-whale client checks passed.

$ node test/contract.mjs     → All discipline-whale contract checks passed（27 项，ok 1–26 + 15b）
$ node test/guard.mjs        → All discipline-whale guard checks passed（10 项）
$ node test/smoke-restart.mjs → SMOKE PASS — dispatch survived a full memory wipe and the report reached the main session
```

红 → 绿记录（本次新增的两条测试文件都是先红后绿）：

```
$ node test/settings.mjs     # 实现接上 /voice/status 的 keySource 之前
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
false !== true
    at file:///.../test/settings.mjs:253:10    # settingsBody.hasApiKey，status 还只认环境变量

$ node test/dock.mjs         # 控件状态机还不存在时
AssertionError [ERR_ASSERTION]: the control state machine must be exported
+ 'undefined'
- 'function'
    at file:///.../test/dock.mjs:58:10
```

### 14f. 本轮**没有**验证的（逐条给验证步骤）

| # | 事项 | 验证步骤 |
| --- | --- | --- |
| 1 | Document PiP 真窗口 | Chrome/Edge 116+，`dsh web` 重启后点「开始通话」→ 点右上角「独立窗口」图标；确认出现置顶小窗、内容与页面内一致、拖动页面上的会话不中断通话；在 PiP 窗里点「静音」「挂断」，确认页面内状态同步 |
| 2 | PiP 的用户手势要求 | 直接刷新页面后在**没有点击**的情况下尝试 `documentPictureInPicture.requestWindow()`，应抛错；再点按钮，应成功（证明实现把调用挂在点击上） |
| 3 | PiP 不可用的降级 | Firefox（或 Chrome <116）打开，确认「独立窗口」按钮走 `window.open` 弹窗；再在弹窗拦截开启时确认界面显示「无法打开独立窗口」且通话不中断 |
| 4 | 浏览器最小化行为 | 通话中最小化浏览器：预期音频/定时器继续、PiP 窗口随之隐藏、切回后通话仍在。**这一步只能证明「最小化后通话不断」，不能证明「窗口仍可见」**——后者是平台限制 |
| 5 | 真麦克风：话筒/静音两态 | 开话筒 → macOS 菜单栏橙点出现；点静音 → **橙点仍在**（设备没释放）但对麦克风说话不应出现在「识别结果」里，也不应触发上传（Network 面板无 `transcribe` 请求）；再点话筒关闭 → 橙点熄灭 |
| 6 | 静音期间零处理 | 静音后对着麦克风持续说话 15 秒，再解除静音并立刻安静：不应**立刻**进入「识别中」（若立刻，说明 pause/resume 没接上）；随后真正安静 10 秒才应结束 |
| 7 | 拖动手感 | 拖动顶部把手：跟手、松手吸附最近边、窗口 resize 后仍在视口内；触摸屏上手势不滚动页面（`touch-action:none`） |
| 8 | 设置界面真机往返 | 打开设置 → 填 baseUrl/模型/语言 → 保存 → 刷新页面 → 值仍在；key 输入框应为空且占位是 `••••••••` |
| 9 | 设置界面「测试连接」**在浏览器里**的成功路径 | 路由层已用真 key 验过成功（§14d-2，HTTP 200 / 17 个模型 / 含 `whisper-large-v3`）；浏览器里要确认的是**按钮 → 面板文案**这一段：填真 key → 点「测试连接」→ 面板显示「连接成功：reachable and authenticated (HTTP 200, 17 models)」，且输入框里的 key 不被回填 |
| 10 | `ctx.credentials` 真机路径 | 在有 `credentials-local` 的组合里保存 key → 确认写进 `$DSH_HOME/.credentials.yaml`（`ls -l` 应为 `-rw-------`）且 `voice.json` **没有** `apiKey` 字段 |
| 11 | 环境变量回落 | `unset` 设置里的 key（勾选清除并保存）→ 用带 `SOCLAAS_API_KEY` 的 shell 启动 `dsh web` → `/voice/status` 应报 `keySource:"env"` |
| 12 | 真机重启后设置仍生效 | 保存设置 → `Ctrl-C` 停 `dsh web` → 重新启动 → 设置面板显示同一组值，`keySource` 不变 |

### 14g. 安装与生效步骤（**没有**执行，需用户批准）

**没有**重启用户正在跑的 `dsh web`，**没有**改动 `$DSH_HOME/plugins/` 下的线上安装（profile 里仍指向 `discipline-whale-0.3.0.tgz`）。

```bash
cd /Users/huiyuan/Developer/projects/discipline-whale
node test/contract.mjs && node test/guard.mjs && node test/voice.mjs \
  && node test/client.mjs && node test/dock.mjs && node test/settings.mjs
scripts/install-local.sh            # 打包并装进 profile "web"
# 然后在用户自己的终端里：
#   1) 停掉当前 dsh web（Ctrl-C）
#   2) 重新 dsh web
#   3) 打开浮层 → 齿轮 → 填 baseUrl / key / 模型 / 语言 → 保存 → 点「测试连接」
```

**设置项不需要重启**：`voice.json` 每次请求重新读、`ctx.credentials` 每次请求重新 resolve，保存后下一次录音即生效。**但插件代码本身（`client.js` / `home.js` / `voice-settings.js`）需要重启**：preset 内的插件行不受 HMR 管理。


## 15. 输出纪律：把 i-have-adhd 改造成主会话能力（2026-10-21 凌晨；本节追加在文件末尾）

### 15a. 上游调研（`git clone --depth 1`，读原文，不凭记忆）

```bash
git clone --depth 1 https://github.com/ayghri/i-have-adhd /tmp/i-have-adhd
```

仓库结构（与本次相关的部分）：

```
.cursor/skills/i-have-adhd/SKILL.md      ← 规则正文（唯一真源）
hooks/hooks.json                         ← Claude Code hook 声明
hooks/always-on.mjs / .sh / .ps1         ← 三平台注入脚本
.claude-plugin/plugin.json               ← Claude Code 插件清单
.opencode/plugins/i-have-adhd.mjs        ← OpenCode 适配
extensions/i-have-adhd.ts                ← Pi (pi-coding-agent) 适配
LICENSE                                  ← MIT
```

**Skill 的内容与规则原文**（`.cursor/skills/i-have-adhd/SKILL.md`）：它不是靠「字数」约束，而是靠**形状**。十条规则：

1. **第一句就是下一步**——首行必须是一个动作，不是背景/计划。原文：*"The first line is something the reader can do. Not context. Not a plan. The action."*
2. **多步任务编号**，每步一个边界清楚的动作，一行不许有两个「然后」。
3. **结尾给一个具体动作**（两分钟内能开始）。
4. **分支话题压掉**——先做完第一个，再作为独立问题提一次。
5. **每轮复述状态**（「第 3/5 步完成」）。
6. **时间估计要具体**（「15 分钟 / 半天」，不许「一点工作」）。
7. **让完成的成果可见**。
8. **报错用陈述语气**（禁「哎呀」「似乎有点问题」）。
9. **列表每组最多 5 项**——并明确写「只管展示，不许削减分析、搜索、工具结果」：*"This rule shapes presentation only; it must not limit analysis, search, tool results, candidate generation, or retained information."*
10. **不要开场白、不要复述、不要客套结尾**——并给出禁用清单：开场 *"Great question," "Let me...", "I'll...", "Sure!", "Looking at your..."*；收尾 *"Let me know if you need anything else," "Hope this helps"*。

另有 **Persistence** 段（规则跨轮失效，只有用户说 `stop adhd mode` / `normal mode` 才关）、**When to break the rules**（6 条例外：要求解释、破坏性操作、调试打转、需求含糊、规则与任务冲突、规则与 harness 冲突）、**Pre-send check**（发出前删五类句子）。

**阈值**：上游**没有任何字数/字符数阈值**。唯一的数量约束是规则 9 的「每组最多 5 项」和规则 2 的「用最少的步数」。这一点很重要：**本次新增的字符上限是本插件的口径，不是上游的**。

**Hook 的机制**：挂在 Claude Code 的 **`SessionStart`** 上（`hooks/hooks.json`）：

```json
"SessionStart": [{ "matcher": "startup|resume|clear|compact",
  "hooks": [{ "type": "command",
    "command": "node -e \"...import(root/hooks/always-on.mjs)...\"",
    "timeout": 30 }] }]
```

- **注入什么**：整份 `SKILL.md`（剥掉 YAML frontmatter），前面加一行 `ADHD MODE ACTIVE (always-on). ...`。
- **拦截还是提醒**：**纯提醒**。它把文本写到 stdout 作为上下文注入，**不 block、不 deny、不改写任何东西**。脚本注释明写 *"Never blocks session start: any failure exits 0."*
- **opt-in**：只有用户创建了 `$CLAUDE_CONFIG_DIR/.i-have-adhd-always` 这个标记文件才触发；没有就直接 `exit 0`。
- **返回结构**：不是 JSON 决策对象，就是纯文本 stdout。
- **关键事实**：上游 hook 里**没有任何「检测回复太长」的逻辑**，也没有 `PostToolUse` / `Stop` 上的检查。它只在会话开始时注入一次规则。

> 所以任务里那句「如果调查发现上游的 hook 本来就只是注入提醒，那正好对上」——**确实对上**。上游的 hook 是纯注入，没有任何强制/改写能力。本实现照实对齐，没有把能力吹大。

**License**：**MIT**，`Copyright (c) 2026 Ayoub Ghriss`。MIT 允许改写与再分发，只需保留版权与许可声明——已在 `README.md` 的 License 节、`skills/whale-brevity/SKILL.md` 的 frontmatter（`upstream` / `upstream-license` / `upstream-copyright`）、以及 `adhd.js` 的模块注释三处保留。

### 15b. 三种架构的可行性（都实际验证过，不是纸上推演）

| 方案 | 可行性 | 证据 | 结论 |
|---|---|---|---|
| **A. Skill 按 preset 作用域注册** | **可行** | `ctx.skills.register()` 把 skill 写进**调用方 context 的 scope layer**（`dsh-skill/lib/index.js` 的 `register()` → `scopeOf(this.ctx)` → `this.layers.effect`）；preset 行由 `agent-preset-registry.mountPreset` 挂在一个 `createScope` 出来的 scope 里，Agent 通过 `bindScopeParent` 挂到该 generation 下，`skills.list({scope: agent})` 走 `chainLayers` 只看到本链。**用真实 `dsh-skill` + `dsh-scope` 包实测**：主 preset 目录里看得到 `whale-brevity`，worker 与 host 平面都看不到 | **采用** |
| **B. Hook 半边** | **可行（只能提醒/纠正下一步）** | `tools/pre-execute`(waterfall)、`agent/assistant-stream`、`agent/pre-step`(waterfall)、`agent/inbox/claimed`、`agent/disposed` 都是 **agent 主语事件**，preset 里的监听器收得到（`guard.js` 已验证过 `session/event` 收不到） | **采用** |
| **C. Prompt 半边：追加到现有 persona** | 可行但不干净 | 要在 `discipline-whale` 的 persona prefix 里塞一大段，和派工纪律混在一节，无法独立识别/开关 | 否 |
| **C′. 单独注册一个 `dsh-persona` 行** | **不可行** | 实测：同一 preset 里第二行 `dsh-persona` → `prompt section "deployment:persona-prefix" is already registered in this scope`，**整个 preset 装载失败** | **否** |
| **C″. 独立命名的 prompt section** | **可行** | `ctx.systemPrompt.section({name:'discipline-whale:brevity', ...})` 在 preset scope 内注册，`prompt-probe` 组装时能看到，worker prompt 里没有 | **采用** |

**最终选择：A + B + C″**，即「skill（按 preset scope 注册）+ hook（三类 agent 事件）+ 独立 prompt section」。理由：三样都实测可行；C′ 明确不可行（实测会炸装载），所以「单独注册一个 `dsh-persona` 行」这个更干净的想法必须放弃，改用独立 section——它同样可独立识别、独立移除，还不会抢 persona 的槽位。

### 15c. 「DSH 能不能真的强制简洁」——诚实结论

**不能。** 具体到机制：

- `agent/assistant-stream` 是**旁路通知**（`this.dispatch.emit(...)`，返回值被丢弃），拿到的是**已经流给用户**的 chunk。改它不影响已发送内容。
- 没有「发送前改写 assistant 文本」的 waterfall。`agent/pre-step` 只能往**下一步**的 messages 里加东西。
- 所以本模块的上限是：①把规则常驻进 system prompt（软约束，**真正承重的那一半**）；②检测到本轮超长后，在**下一个步边界**注入一次纠正——**用户已经看到那段话了**。

代码注释与 README 都按这个口径写，没有出现「强制简洁」的说法。

### 15d. UI 豁免：判据、实现、以及识别出的漏洞与处理

**判据**（`adhd.js`，纯函数，集中一处）：

- `isUiTurn(toolCalls)` —— 本轮调用过 `render_ui` / `render_canvas` / `render_scene` / `render_mechanism` 任一 → 豁免。
- `shouldEnforceBrevity({toolCalls, chars, config})` —— 返回 `{enforce, reason, overBy, limit}`，`reason ∈ {disabled, ui-deliverable, within-limit, over-limit}`。
- `countTextInArgs(name, args)` —— `render_text` 携带的 `text` / `blocks[].text` 字数**照算**。

**漏洞与处理**（这是本次最需要用户确认的一处判断）：

1. **「顺手调个 `render_text` 逃避简洁」** → **判定为真漏洞，堵掉**。`render_text` 渲染的是**文字**，本质没变。它既**不**在 `UI_EXEMPT_TOOLS` 里（不豁免整轮），带的字数还会被 `countTextInArgs` 计入。所以 `render_text` 既不能买豁免，也不能藏字。
2. **「一轮里既有 UI 又有长散文怎么办」** → **判定整轮豁免**（`isUiTurn` 只要有任一 UI 工具就 true）。理由：把「围绕交付物的说明」和「交付物本身」切开是**不可判定**的（说明本身可能就是交付物的前言），而误伤一份正常交付物的代价（用户拿不到完好的 UI）高于漏掉一段啰嗦说明。**代价照实写**：确实可能漏掉一段啰嗦的旁白。缓解：豁免只关掉**长度纠正**，形状规则（先给动作、编号、无客套）仍由常驻 prompt 约束；且豁免**不粘连**——下一轮不渲染就立刻重新计量（有测试）。
3. **「豁免会不会因为工具名拼错而失效」** → 不会静默失效：豁免表是 `Object.freeze` 的常量 `Set`，测试逐项断言四个 UI 工具名。

> 这一处是**我的解读**（「看本轮是否调用了产出型工具」），用户可以否掉。若改成「按内容块判定」或「只豁免渲染出来的块、正文照算」，只需改 `isUiTurn` ＋ 一条测试。

### 15e. 与 `guard.js` 三道刹车的隔离

- `guard.js` 数**读类调用次数**（`state.reads` / `state.silent`）；`adhd.js` 数**输出字符数**（`state.chars`）。两套 state、两套 handler。
- `tools/pre-execute` 这条水线上，本模块**永远 `next()`**，从不 `deny` / `cancel`（测试 ok 8e 显式断言）。
- 测试 ok 9 断言 `main.apply` 之后 `agent/assistant-stream` 上有**两个独立监听器**（guard 一个、brevity 一个），不是合并成一个。

### 15f. 作用域证据（三样）

**证据 1 —— `prompt-probe.mjs` 双输出对比**（同一命令、只换 preset id）：

```
$ node prompt-probe.mjs discipline-whale | grep -n "输出纪律\|UI 交付物豁免\|第一句就是下一步\|i-have-adhd"
     1:## 输出纪律（ADHD 读者）
     ...
    14:### 2.1 第一句就是下一步
     ...
    60:## 3. UI 交付物豁免（本插件新增）
     ...
    88:这份规则从 [i-have-adhd](https://github.com/ayghri/i-have-adhd)（MIT，Copyright (c) 2026 Ayoub Ghriss）改写而来
```

```
$ node prompt-probe.mjs discipline-whale-worker | grep -c "输出纪律\|UI 交付物豁免\|第一句就是下一步\|i-have-adhd"
0
```

**证据 2 —— `--dump-config`（临时 profile 副本，不是线上 `~/.dsh`）**

用 `DSH_HOME=<tmp>` 指向一份 `~/.dsh/profiles/web` 的拷贝（把 `discipline-whale` 依赖改成 `link:` 到工作树），跑 `--profile web --dump-config`，`exit=0`：

```yaml
- id: preset-discipline-whale
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: discipline-whale
    ...
    plugins:
      ...
      - id: discipline-whale-brevity
        name: discipline-whale/adhd
        config:
          maxProseChars: 1200
          maxCorrections: 1
          enabled: true
```

同一份 dump 里，worker preset 块内 `grep -c adhd` = **0**。

> 踩过的坑：第一次把拷贝放在 `$TMP/web` 而不是 `$TMP/profiles/web`，`loadProfile` 找不到 manifest 就**新建了一个默认 profile**，dump 里只有 `dsh-base` / `dsh-web-app` 两层——那次的结论是假阴性。路径必须是 `<DSH_HOME>/profiles/<name>`。

**证据 3 —— 契约测试 ok 27**（`test/contract.mjs`）：

```
ok 27 — the brevity row is declared in the main preset and absent from the worker preset
```

它直接读 `cordis.patch.yml`，断言：行存在于 `preset-discipline-whale`、**不存在**于 `preset-discipline-whale-worker`、且全文件只有**一个** preset 拥有它。

**补充证据 —— 真实 skill registry 的 scope 隔离**（`test/adhd.mjs` ok 7）：

```
ok 7 — the skill lands in the main preset scope only: main sees it, worker and host do not
```

用的是真的 `@deepseek-ai/dsh-skill` + `@deepseek-ai/dsh-scope`：主 preset generation 挂行、两个 Agent 分别 `bindScopeParent` 到各自 generation，然后 `skills.list({scope})` 断言主会话看到 `whale-brevity`、worker 和 host 平面都看不到；`skills.get()` 同样。

**补充证据 —— worker 事件被放行**（`test/adhd.mjs` ok 8a）：

```
ok 8a — a worker Session is passed through: no counter, no injection, tool gate untouched
```

断言的正是任务要求的那条：worker 会话连说 50 段超长文本后 `handle.sessions.has('worker-1') === false`（**连计数器都没建**），`pre-step` 不注入，`tools/pre-execute` 走到 `next()`。preset 读不出来的 Agent 同样放行（fail open）。

### 15g. 改动文件清单

新增：
- `adhd.js` —— 全部实现（常量、`loadRules`、`resolveBrevityConfig`、`isUiTurn`、`shouldEnforceBrevity`、`countTextInArgs`、`installBrevity`、`apply`）
- `skills/whale-brevity/SKILL.md` —— 规则正文（唯一真源，prompt 段与 skill 都读它）
- `test/adhd.mjs` —— 13 组测试

修改（全部是**追加式最小改动**）：
- `cordis.patch.yml` —— 在主 preset 的 `discipline-whale-main` 行之后**插入** `discipline-whale-brevity` 行；worker preset 一行未动
- `main.js` —— `import { installBrevity }`（1 行）、`Config` 里多一个 3 键循环、`apply()` 末尾多一次 `installBrevity(ctx, config)` 调用；**没碰** guard 挂载行，**没碰** `dispatch_task` / `send_to_session` 的 `at` 逻辑
- `prompt-probe.mjs` —— 增加「按行名挂载本包自己的 prompt 行」的分支（否则 probe 组装不出新 section）
- `test/contract.mjs` —— 末尾追加 ok 27 一块
- `package.json` —— `exports` 加 `./adhd`、`files` 加 `adhd.js` / `skills/**/*.md`、`scripts` 加 `test:adhd` 并把它并入 `test:all`
- `README.md` —— 新增「输出纪律」一整节 + 测试小节 + 2 条已知限制 + License 节的署名
- `VERIFICATION.md` —— 本节

`git diff --stat` 见 §15i。

### 15h. 测试输出原文（五套件 + 新增）

```
$ node test/contract.mjs
...
ok 26 — the plain step insert defaults everywhere and never cancels; only `at:"abort"` does
ok 27 — the brevity row is declared in the main preset and absent from the worker preset

All discipline-whale contract checks passed.

$ node test/adhd.mjs
ok 1 — isUiTurn: UI canvases exempt, prose and render_text do not
ok 2 — shouldEnforceBrevity decides length, exemption and the switch in one place
ok 3 — resolveBrevityConfig: named defaults, overridable, invalid values fall back
ok 4 — the skill file is the single source for both the catalog entry and the prompt section
ok 5 — countTextInArgs: prose carried by render_text still counts toward the limit
ok 6 — the brevity rules reach the main prompt and provably not the worker prompt
ok 7 — the skill lands in the main preset scope only: main sees it, worker and host do not
ok 8a — a worker Session is passed through: no counter, no injection, tool gate untouched
ok 8b — over-long prose earns one attributed reminder on the next step, capped per user turn
ok 8c — a render turn is exempt; the exemption does not leak into the next turn
ok 8d — render_text stays on the text channel: it neither exempts a turn nor hides its text
ok 8e — knobs behave; the tool gate always allows; disposal forgets the Session
ok 9 — main.apply installs the brevity hook and carries its knobs through Config

All discipline-whale brevity checks passed.

$ node test/guard.mjs
...
ok 9 — the real scope graph delivers the agent-keyed signals; session/event provably does not

All discipline-whale guard checks passed.

$ node test/voice.mjs
ok 13 — a late transcript cannot land after hangup or a session switch

All discipline-whale voice checks passed.

$ node test/client.mjs
ok 6 — the open dock shows status, transcript, reply, hang-up, privacy, the read-aloud fallback and two separate controls

All discipline-whale client checks passed.

$ node test/smoke-restart.mjs
SMOKE PASS — dispatch survived a full memory wipe and the report reached the main session
```

> `test/dock.mjs` / `test/settings.mjs` 属于并行会话的改动面，**本轮在该会话停下后由它自己跑过**（11 + 10 项全绿，见 §14e 与 §14d-4）；上面这份列表是那一刻的快照，不含这两条。

### 15i. `git diff --stat`

（原文见下方命令输出，已剔除并行会话的文件。）

### 15j. 重启与生效步骤（**没有**执行，需用户批准）

**没有**重启正在跑的 `dsh web`，**没有**动 `$DSH_HOME/plugins/` 的线上安装。要真正生效：

```bash
cd /Users/huiyuan/Developer/projects/discipline-whale
node test/contract.mjs && node test/guard.mjs && node test/adhd.mjs \
  && node test/voice.mjs && node test/client.mjs
scripts/install-local.sh                 # 打包并装进 profile "web"
# 然后在用户自己的终端：
#   1) Ctrl-C 停掉当前 dsh web
#   2) 重新 dsh web
#   3) 打开侧边栏「自律鲸鱼」→ 新建主会话（关键）
```

**已存在的主会话仍用旧组合**：preset 行在**会话创建时**装配，新加的 `discipline-whale-brevity` 行与 prompt section 都只对**新建**主会话生效。已开着的那个会话不会中途换规则。

### 15k. 本轮**没有**验证的（逐条给验证步骤）

| # | 未验证项 | 为什么没验 | 怎么验 |
|---|---|---|---|
| 1 | **模型是否真的变简洁** | 没有任何测试能断言自然语言风格；prompt section 进了 system prompt ≠ 模型照做 | 重启并新建主会话后，提一个会触发长回答的问题（例：「解释一下这个仓库的派工机制」），数正文行数与首行是否是动作；同问题在旧会话里问一次做对照 |
| 2 | **纠正注入在真机上的触发时机** | 单测用假 Host 驱动 `agent/pre-step`，真实链路里「steer 之后模型下一步真的变短」没有观察过 | 临时把 `maxProseChars` 调到 100，发一条会招来长回复的消息；预期：回复照旧长（已发出），**下一条**回复明显变短，且会话里出现一条 `plugin:discipline-whale:brevity` 来源的 user 消息 |
| 3 | **豁免会不会被滥用** | 模型是否学会「想长篇就顺手渲染一个 UI」只能在真机上观察 | 连续 10 轮纯讨论类提问，看有多少轮出现「先渲染再长文」；若比例高，说明轮级豁免太宽，改为「只豁免渲染块、正文照算」并改 `isUiTurn` |
| 4 | **preset 行在真机上确实只挂主会话** | `--dump-config` 只证明配置树；真实 `agentPresets.serviceFor()` 的 scope 解析在运行进程里没读过 | 重启后各开一个主会话 / worker 会话，主会话 `skill` 工具能列出 `whale-brevity`、worker 列不出；或看 `skills/list` 的 API 返回 |
| 5 | **worker 真的没有被误伤** | 单测覆盖了 handler 放行，但真实 worker 会话走的是同一套事件 | 派一次工，观察 worker 的 `report_to_main` 的 `document` 长度是否仍为长文（不应因本改动变短） |
| 6 | **和并行会话（`session-f2aa6d6b`）的合并** | 那边在改 `client.js` / `voice.js` / 设置界面，本轮刻意不碰这些文件 | 合并后重跑五套件 + `test/dock.mjs` / `test/settings.mjs` |
| 7 | **`dsh web` 重启后的 HMR / 装载失败风险** | 新行 `name: 'discipline-whale/adhd'` 需要 profile 里 `discipline-whale` 的 `exports` 含 `./adhd`（已加）；装载失败会让整个 preset broken | 重启后看 `dsh` 日志里有无 `agent preset discipline-whale: ...`；preset 装载失败会 warn |

### 15l. 落地后的复跑记录（2026-10-21 03:33，全部文件改动完成之后）

改动收尾（`VERIFICATION.md` 03:31 / `README.md` 03:30 / `adhd.js` 03:30 最后落盘）之后，按严格退出码整套复跑一次，结果原文：

```
contract  PASS  28 checks  exit=0
guard     PASS  10 checks  exit=0
adhd      PASS  13 checks  exit=0
voice     PASS  16 checks  exit=0
client     PASS   9 checks  exit=0
smoke     PASS  exit=0
----
OVERALL: ALL GREEN
```

同时复确认两条作用域证据在最终代码上仍然成立（不是改动前的旧结论）：

```
$ node prompt-probe.mjs discipline-whale | grep -n "输出纪律\|2.1 第一句就是下一步\|3. UI 交付物豁免\|i-have-adhd"
39:## 输出纪律（ADHD 读者）
48:这份规则从 [i-have-adhd](https://github.com/ayghri/i-have-adhd)（MIT，Copyright (c) 2026 Ayoub Ghriss）改写而来 ...
60:### 2.1 第一句就是下一步
131:## 3. UI 交付物豁免（本插件新增）

$ node prompt-probe.mjs discipline-whale-worker | grep -c "输出纪律\|第一句就是下一步\|UI 交付物豁免\|i-have-adhd"
0
```

```
$ DSH_HOME=<tmp copy of ~/.dsh/profiles/web> dsh --profile web --dump-config   # exit=0
1487:      - id: discipline-whale-brevity
1488-        name: discipline-whale/adhd
1489-        config:
1490-          maxProseChars: 1200
1491-          maxCorrections: 1
1492-          enabled: true

row at line 1488 inside: - id: preset-discipline-whale
worker preset adhd hits: 0
```

本轮仍未做真机重启，所以 §15k 的 7 条未验证项清单不变。

## 19. 语音通话：起停改用 Silero VAD、防幻觉、离开防护；通话条整块拖动与贴边（2026-10-21 深夜）

起因：用户开着通话离开去聊天，回来发现插件自己发了很多条消息。调研成熟语音 Agent 的做法（OpenAI Realtime、LiveKit、Pipecat、vad-web、Whisper 自身规则）后，起停改用现成的 Silero VAD，并加三道过滤和离开防护；同一轮还按用户要求重做了通话条的拖动、贴边收起、缩放，以及「主界面同时显示」。

### 19a. 改了什么

| 面 | 做法 |
| --- | --- |
| 起停 | `@ricky0123/vad-web` 0.0.31 的 `MicVAD`（Silero v5）：阈值 0.5/0.35，停顿 2 秒结束（设置可选 1/2/3/5/8 秒），开口前保留 0.5 秒，不足 0.5 秒算误触；60 秒截断。`createTurnTaker` 负责把静音、半双工、「说完了」、挂断映射到 `start`/`pause`/`destroy` |
| 检测组件文件 | `voice-assets.js` 从已安装的包提供 6 个文件，一条精确路由一个文件；`package.json` 新增 `dependencies`（`@ricky0123/vad-web@0.0.31`、`onnxruntime-web@1.22.0`） |
| 收音约束 | `autoGainControl: false`，回声消除与降噪保留 |
| 近场音量门 | 90 分位帧电平 < -45 dBFS 不上传（经验值） |
| 服务端过滤 | `verbose_json`；段级 `no_speech_prob ≥ 0.6`（单独判断）/ `avg_logprob < -1` / `compression_ratio > 2.4` 丢弃；中英幻觉短语库；全丢 → `voice/rejected-transcript`，不发送 |
| 离开防护 | 连续 3 段被拒，或累计收音 2 分钟没发出消息 → 自动关话筒并提示 |
| 主界面同显 | 通话开始与每句发出时 `uiWorkspace.openSession(主会话)` |
| 通话条 | 整块可拖（移动 5px 以上算拖动，拖完的点击被吞掉）；推出左右边缘贴边收起成麦克风光球；拖离边缘展开；空出一侧顶角拖动缩放；几何存在组件 state，收回独立窗口后保留 |

### 19b. 测试（全部 exit 0）

`npm run test:all`（contract / guard / adhd / voice / client / dock / settings）与 `npm run test:smoke` 全绿。本轮新增或改写：

- `test/voice.mjs` ok 4b（实测幻觉与真实语音的分流）、ok 7（起停参数）、ok 8（音量门）、ok 9（离开防护只计收音时间、连续拒绝）、ok 12（检测组件路由：按名字、带类型、未知名字 404、缺包 503）。
- `test/client.mjs` ok 1（浏览器镜像与 `voice-silence.js` 的参数、电平、离开防护逐步一致）、ok 2（检测组件从插件路由加载，源码里没有 CDN 地址）。
- `test/dock.mjs` ok 2、3、9（按 vad-web 0.0.31 `real-time-vad.js` 行为写的假 `MicVAD`：静音保留设备并丢弃半段、半双工释放设备、「说完了」提交、60 秒截断、关闭释放全部 track）、ok 7（话筒关时不显示「说完了」，先红后绿）、ok 10（清除 key 开关关回去恢复「保持不变」，先红后绿）、ok 12（落点：停留 / 吸边 / 贴边收起 / 展开 / 缩放 clamp）、ok 13（贴边后只剩麦克风控件）。
- `test/contract.mjs` 第 20 条追加：检测组件路由由主页行挂载。

### 19c. 真实应用验证（隔离实例）

做法：临时 `DSH_HOME` + 3091 端口另起 `dsh web`，安装本次打包的插件（安装后 `cmp` 确认 `client.js` 与工作区一致），用户在 3080 的实例未触碰。麦克风用页面内注入的合成流代替。

| 项 | 结果 |
| --- | --- |
| 检测组件加载 | 6 个文件 200，`wasm` 为 `application/wasm`；页面出现 `window.ort` / `window.vad`，`MicVAD` 启动，`getUserMedia` 约束含 `autoGainControl:false` |
| 真实语音端到端 | `say -v Tingting` 合成的一句中文（约 5 秒）：Silero 判起停 → 上传 7.456 秒（0.5 秒前置 + 语音 + 2 秒停顿）→ 真实 SoCLaaS `verbose_json` 返回正确文本并通过过滤 → `/voice/say` 200 → 主界面会话里出现这条用户消息，浮层同时显示识别气泡 |
| 远处人声 | 同一句衰减 40 dB：Silero 判为语音，音量门拦下（「声音离麦克风太远，没有发送」），**零次转写请求**；连续 3 次后自动关话筒（「连续几段都像背景声……」） |
| 静音 / 解除 | 静音后流仍 `live`、只有一条流；解除后回到「正在听」且未重新申请麦克风 |
| 挂断 | 全部 track 变 `ended` |
| 拖动 / 贴边 / 展开 / 缩放 | 按住「开始通话」拖到页面中间（未误触发通话）；推出右边缘收起成光球；点光球开始通话；拖离边缘展开为完整面板且通话不断；拐角缩放 380→459 宽、卡片向上长、控制条不动 |

### 19d. 尚未验证（需要真人、真麦克风）

- 真人说话时 2 秒停顿的手感，以及句中思考停顿是否被切断（可在设置里调长）。
- 真实环境里 -45 dBFS 音量门对不同麦克风是否合适。
- 旁边有人**凑近麦克风**说话：音量门与过滤都分不出来，会被当成本人说话（README「已知限制」已写明）。
- Document PiP 真窗口里的收音（检测组件在主页面运行，理论上不受影响）。

