# POSTINSTALL-AUDIT — discipline-whale 0.4.0 装后自检

**做法**：不碰用户在 3080 上跑的那个实例，用临时 `DSH_HOME` + 空闲端口另起一个独立 `dsh web`，验完杀掉、删临时目录。以后每次插件安装的自检都按这个做法走，不再等人重启后再补检查。

- 自检时间：2026-10-21 15:00–18:30 (+08:00)
- 被验对象：`discipline-whale@0.4.0`，线上 profile 依赖 `file:/Users/huiyuan/.dsh/plugins/packages/discipline-whale-0.4.0.tgz`
- 结论：**装载成功，四条能力面全部命中**。发现的 2 个「不是故障但值得知道」的现象见 §5、§6。

---

## 0. 端口与进程记录

```console
$ for p in 3180 3181 3182 3183 3184 3185; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && echo "$p BUSY" || echo "$p free"; done
3180 free
3181 free
3182 free
3183 free
3184 free
3185 free

$ lsof -nP -iTCP:3080 -sTCP:LISTEN | head -5      # 用户实例，全程只读观察，未发任何请求
COMMAND   PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    63429 huiyuan   17u  IPv4 0xf0ff4f7c189b19b3      0t0  TCP 127.0.0.1:3080 (LISTEN)
```

| 实例 | 端口 | PID | 用途 | 最终状态 |
|---|---|---|---|---|
| A | 3180 | 72473 | 工作树 `link:` 装载 + 能力面 | 已 kill |
| B | 3180 | 32255 | 工作树副本（`maxProseChars: 50`）验 ADHD | 已 kill |
| C | 3181 | 36168 | 已安装 tarball 装载 | 已 kill |
| D | 3182 | 36662 | 带 `SOCLAAS_API_KEY` 验真转写 | 已 kill |
| E | 3183 | 44213 | `maxInterventions: 0` 隔离出读配额 | 已 kill |

临时 `DSH_HOME=/tmp/dw-audit-home`，层级严格为 `<DSH_HOME>/profiles/web`。

> **踩坑复现**：第一次把拷贝放在 `$TMP/web` 时 `loadProfile` 找不到 manifest，新建了个默认 profile，dump 只出 base/web-app 两层——与前面会话踩过的是同一个坑。层级必须是 `<DSH_HOME>/profiles/<name>`。

另一个坑：`rsync` 克隆后 `node_modules/dsh-session-kit -> ../../../../Developer/...` 这个**相对软链断了**，导致第一次 dump 报 `cannot resolve profile bundle "dsh-session-kit"`、`patch: entry "dsh-session-kit" not found`。改成绝对路径软链后才干净（这是临时目录的假阴性，不是线上问题）。

---

## 1. 装载成功（A）

### 1.1 主 preset 组合树有 brevity 行与 guard 四键，worker preset 0 命中

```console
$ DSH_HOME=/tmp/dw-audit-home dsh --profile web --dump-config > /tmp/dump-worktree.yml 2>/tmp/dump-worktree.err
exit=0
$ cat /tmp/dump-worktree.err
（空）
$ wc -l /tmp/dump-worktree.yml
1651 /tmp/dump-worktree.yml
```

按 `- id: preset-*` 切块计数（不是全文 grep，避免跨 preset 串味）：

```
- id: preset-standard             brevity hit: 0 | adhd hit: 0 | guard keys: 0
- id: preset-ptc                  brevity hit: 0 | adhd hit: 0 | guard keys: 0
- id: preset-minimal              brevity hit: 0 | adhd hit: 0 | guard keys: 0
- id: preset-cordis               brevity hit: 0 | adhd hit: 0 | guard keys: 0
- id: preset-discipline-whale     brevity hit: 1 | adhd hit: 1 | guard keys: 4
- id: preset-discipline-whale-worker brevity hit: 0 | adhd hit: 0 | guard keys: 0
```

主 preset 片段原文（第 1487–1497 行）：

```yaml
          readQuota: 10
          watchdogThreshold: 10
          maxInterventions: 2
          watchdogCounting: all
      ...
      - id: discipline-whale-brevity
        name: discipline-whale/adhd
        config:
          maxProseChars: 1200
          maxCorrections: 1
          enabled: true
```

`create_session` 的 profile 层封杀也在（第 1384–1387 行）：

```yaml
- id: dsh-session-kit
  name: dsh-session-kit
  disabled: true
# == discipline-whale
```

### 1.2 启动日志干净，无装载失败

```console
$ nohup env DSH_HOME=/tmp/dw-audit-home dsh --profile web --port 3180 --no-open > /tmp/dw-audit-web.log 2>&1 &
$ cat /tmp/dw-audit-web.log
[auto-continue] 已启动(host 单实例, 文本="继续", 宽限 3000ms, 冷却 20000ms, 最多连续 3 次)
dsh web: http://127.0.0.1:3180/?token=<redacted>

$ lsof -nP -iTCP:3180 -sTCP:LISTEN
node    72473 huiyuan   14u  IPv4 0x62e98bd32c013b04      0t0  TCP 127.0.0.1:3180 (LISTEN)
```

5 个实例的日志统一扫一遍：

```console
$ grep -inE "agent preset discipline-whale|Cannot find module|ERR_MODULE_NOT_FOUND|failed to (load|mount)|Unhandled" \
    /tmp/dw-audit-web.log /tmp/dw-adhd-web.log /tmp/dw-tar-web.log /tmp/dw-key-web.log /tmp/dw-quota-web.log
NO MATCHES (clean)
```

即：**没有** `agent preset discipline-whale: ...` 装载失败，**没有** `Cannot find module`。

### 1.3 两种安装形态都验了

| 形态 | 依赖写法 | dump | 运行 |
|---|---|---|---|
| 工作树（证明当前代码） | `link:/Users/huiyuan/Developer/projects/discipline-whale` | exit=0，特征行齐 | 3180 起来，能力面全绿 |
| 已安装 tarball（证明打包） | 解包 `discipline-whale-0.4.0.tgz` 到 `node_modules/discipline-whale` | exit=0，`maxProseChars: 1200`，brevity=1 / guard=4 / worker 0 | 3181 起来，能力面全绿 |

tarball 与工作树的唯一内容差异是 `client.js` 的 42 行 i18n 文案（tarball 是打包时快照，工作树后来又改了文案），不影响装载与能力面。

---

## 2. 主会话能力面（B）

`session/create` 造了一个 `agentPreset: "discipline-whale"` 的会话，从**它真实发出的 `request/header` 事件**里读工具面（不是读源码猜）。

### 2.1 无 shell / 无写、有 dispatch 全家桶

```
main tools 79
    dispatch_task YES
    list_workspaces YES
    list_dispatches YES
    read_report YES
    send_to_session YES
    resume_dispatch YES
    abandon_dispatch YES
    report_to_main no
    bash no
    write no
    edit no
```

完整列表（79 个，原文）：

```
abandon_dispatch, ask_user_question, context_lens_code, context_lens_log, deja_blame,
deja_fix, deja_how, deja_recall, deja_remember, deja_session, dispatch_task,
doublecheck_report, doublecheck_skills, doublecheck_spec, evidence_add, excel_create,
excel_read, excel_update, glob, grep, inspect_ui, inspect_video, interrupt_agent,
ledger_query, list_agents, list_dispatches, list_workspaces, lsp_code_action,
lsp_completion, lsp_diagnostics, lsp_format, lsp_inlay_hints, lsp_rename, lsp_signature,
lsp_symbols, memory_delete, memory_delete_all, memory_list, memory_prune, memory_read,
memory_write, modlens_read_image, patch_ui, ppt_create, ppt_read, present, preview_video,
process_video, read, read_image, read_report, render_canvas, render_mechanism,
render_scene, render_text, render_ui, render_video, research_report, resume_dispatch,
send_message, send_to_session, skill, spawn_teammate, synthesize_voice, team_task_create,
team_task_get, team_task_list, team_task_update, todo_write, ui_catalog, update_ui,
validate_ui, wait_agent, web_fetch, web_search, word_create, word_read, word_update,
working_directory
```

> 观察：列表里还有 `spawn_teammate` / `team_task_*` / `send_message` 等 Team 工具。它们来自 profile 里的 `@deepseek-ai/dsh-experimental-agent-team-profile` bundle，不属于本插件的 preset 声明，是既有组合结果，不是本次安装带来的。**只读 + 无 shell 的约束仍然成立**（`bash`/`write`/`edit` 全无）。

### 2.2 `skill` 列表有 `whale-brevity`

```console
$ POST /skills/list {"request":{"sessionId":"session-d44f228b-..."}}
main 200 ok= true
agent-reach, animation-vocabulary, apple-design, code-optimizer, codex-handoff,
debug-like-expert, delivery-proof, delivery-review, frontend-design, grill-me,
grill-requirements, grilling, implementation-critic, lint, mlx-stt, neat-freak,
ponytail, prototype, red-green-tdd, review, skill-vault, test, **whale-brevity**,
writing-for-agents
```

### 2.3 实测 guard：第 11 次读被拒，文案含 `0 of 10` 与 `dispatch_task`

为了让配额可观测，把 `maxInterventions` 设为 0（只留配额闸），让主会话连续读 11 个 home 内的文件。事件流原文：

```
read#1 seq 18 note-1
read#2 seq 19 note-2
...
read#10 seq 27 note-10
read#11 seq 38 note-11
  REFUSAL seq 39 : [{"type":"text","text":"Error: [Discipline Whale] Read quota exhausted — 0 of 10 read calls left in this reply. Stop reading now: answer the user with what you already have, then route the rest of the work with `dispatch_task` (or `send_to_session` for a running worker). The quota refreshes as soon as you produce user-visible text."}]
turn/end {"turn":1,"reason":{"kind":"completed"}}
```

默认配置（`maxInterventions: 2`）下，同一个 11 连读先撞 watchdog：第 10 次静默调用即硬停并注入，`turn/end` 原因是 `aborted / hook / discipline-whale: silent tool-call hard stop`，注入 notice 的 `source` 为 `{"kind":"plugin:discipline-whale","form":"notice","summary":"10 silent tool calls — stopping the turn"}`。两条闸都在。

### 2.4 读 `main.js` 被白名单拒

```
tool/call read {"file_path":"/Users/huiyuan/Developer/projects/discipline-whale/main.js","limit":20}
tool/result:
Error: [Discipline Whale] Read blocked — "/Users/huiyuan/Developer/projects/discipline-whale/main.js" is outside the main session's read scope. Readable: anything under your own home (/private/tmp/dw-audit-home/discipline-whale/home); public documents inside a registered workspace: README*.md, AGENTS.md, CLAUDE.md, docs/**/*.md, top-level *.md, and package.json. Source files, configs, and data are not readable from the main session. To inspect this file, dispatch a worker into that workspace with `dispatch_task` and let it read it.
```

### 2.5 worker preset：只有 `report_to_main` + 编码工具，无 dispatch 类

```
worker tools 78
    dispatch_task no
    list_workspaces no
    list_dispatches no
    read_report no
    send_to_session no
    resume_dispatch no
    abandon_dispatch no
    report_to_main YES
    bash YES
    write YES
    edit YES
```

### 2.6 worker 的 `skill` 列表没有 `whale-brevity`

```console
$ POST /skills/list {"request":{"sessionId":"session-eb7fc4a5-..."}}
worker skills count 23
agent-reach, animation-vocabulary, apple-design, code-optimizer, codex-handoff,
debug-like-expert, delivery-proof, delivery-review, frontend-design, grill-me,
grill-requirements, grilling, implementation-critic, lint, mlx-stt, neat-freak,
ponytail, prototype, red-green-tdd, review, skill-vault, test, writing-for-agents
whale-brevity present? false
```

主会话 24 项 / worker 23 项，差的正好是 `whale-brevity`——**scope 隔离在真实运行时成立**。

### 2.7 用户观测到的三条对得上

| 用户在其实例观测到 | 本临时实例复核 |
|---|---|
| `whale-brevity` skill 已加载 | ✅ 主会话 `skills/list` 第 23 项，worker 无 |
| 读 `main.js` 被拒，文案含「Read blocked … dispatch a worker」 | ✅ 原文见 §2.4，逐字一致 |
| `dispatch_task` schema 有 `topic`/`writes`/`at`；`send_to_session` 有 `at` | ✅ 见下 |

```json
dispatch_task.properties: workspace, task, title, topic, at(queue|step|abort)
send_to_session.properties: session_id, message, at(queue|step|abort)
```

---

## 3. 语音路由（C）

全部对**临时实例**发真实 HTTP（先用启动日志里的 token 换 cookie，再打 `/api/...`）。

### 3.1 `GET /api/discipline-whale/voice/status` → 200，字段齐、无 key

```json
{"configured":false,"keySource":"none","apiKeyEnv":"SOCLAAS_API_KEY",
 "baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","model":"whisper-large-v3",
 "language":"","maxBytes":26214400,"maxSeconds":120,"tts":{"integrated":false},
 "source":"NUS SoCLaaS (cloud transcription)"}
```

带 key 起（实例 D）：

```json
{"configured":true,"keySource":"env", ... }
$ /sk-|Bearer/ 命中检测 → false
```

响应体里没有 key，只有 `keySource`。

### 3.2 `GET /api/discipline-whale/voice/settings` → 200，`hasApiKey` 布尔、无 key 值

```json
{"baseUrl":"https://soclaas-api.comp.nus.edu.sg/v1","baseUrlSource":"default",
 "model":"whisper-large-v3","language":"","hasApiKey":false,"keySource":"none",
 "apiKeyEnv":"SOCLAAS_API_KEY","baseUrlEnv":"SOCLAAS_BASE_URL","tts":{...}}
```

带 key 时同一路由 `hasApiKey:true`、`keySource:"env"`，仍无 key 值。

### 3.3 `POST voice/say`

```
say {}                    -> 400 {"error":{"code":"voice/empty-text","message":"there is no transcript to send"}}
say {text:"自检"}          -> 200 {"sessionId":"session-d09fd2a8-3c67-454a-b611-a77d6e344ec5","chars":2}
say 非 JSON body          -> 400 {"error":{"code":"voice/empty-text","message":"the request body must be JSON"}}
GET voice/say             -> 404 not found（该路由只注册 POST，符合预期）
```

`{text:"自检"}` 真的把 2 个字推进了主会话；`sessionId` 就是 `/api/discipline-whale/home` 记录的主会话。

### 3.4 `POST voice/transcribe`

```
空 body + content-type: audio/wav  -> 400 {"error":{"code":"voice/empty-audio","message":"the upload carried no audio"}}
空 body + 无 content-type          -> 415 {"error":{"code":"voice/unsupported-audio-type","message":"unsupported audio type (none)","accepted":[...]}}
body + content-type: text/plain    -> 415 {"error":{"code":"voice/unsupported-audio-type","message":"unsupported audio type text/plain",...}}
body + content-type: application/json -> 415 同上
1 KiB 假 WAV（无 key）             -> 503 {"error":{"code":"voice/missing-key",...}}
```

> 说明：任务书里「空 body → 400 `voice/empty-audio`」是在**带了音频 content-type** 的前提下成立；不带 content-type 时路由先按类型拒（415），这是更早的一道闸，行为正确。

### 3.5 真转写（有 key，验了）

`SOCLAAS_API_KEY` 在 `zsh -lc` 里可取（len=56），用它起实例 D：

```console
$ say -v Tingting -o /tmp/dw-selftest.aiff "这是一次语音路由自检，请确认转写结果。"
$ afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/dw-selftest.aiff /tmp/dw-selftest.wav
$ afinfo /tmp/dw-selftest.wav | head -6
Data format:     1 ch,  16000 Hz, Int16

$ POST /api/discipline-whale/voice/transcribe (audio/wav, 190 KB)
transcribe 200
keys [ 'text', 'model', 'audioSeconds' ]
text: "这是一次语音路由字简,请确认转写结果。"     ← 原文；"自检"被识别成"字简"，模型误识，非路由问题
model: whisper-large-v3 audioSeconds: 4.351
```

**整条链路（浏览器 → 路由 → 云 ASR → 返回）真实打通**，不只是 200。

---

## 4. 客户端插件面（D）

### 4.1 client 模块确实加载了

从该实例返回的 `index.html` 里解析 `globalThis["__DSH_BOOT__"]`（82 个 entry）：

```json
{"id": "discipline-whale",
 "url": "plugins/??discipline-whale/client.js&rev=71104449f324",
 "rev": "71104449f324"}
```

它不是只有登记：实际取包成功——

```console
$ curl ".../plugins/??discipline-whale/client.js&rev=71104449f324" -o /tmp/dw-client.js
200 134465 bytes
$ head -1 /tmp/dw-client.js
// discipline-whale, browser half: the whale's own entry in the Web sidebar.
```

### 4.2 浮层注册点在（`shell.overlay` + id `discipline-whale-voice`）

在实际下发的 client 源码里（第 2598–2603 行）：

```js
ctx.slots.inject("shell.overlay", () =>
  ctx.slots.register(
    { name: "shell.overlay", id: "discipline-whale-voice", order: VOICE_DOCK_ORDER, locale: NS },
    VoiceDock
  )
);
```

计数：`"discipline-whale-voice"` 出现 1 次（注册点），`shell.overlay` 出现 3 次（注释 + 注册）。

---

## 5. ADHD 纠正注入：真的会注入，但只在「本回合还有下一步」时

用户在真机上写了一篇超长回复却**没察觉到**纠正，怀疑「写了但从不注入」。经临时实例实测（`maxProseChars: 50` 的副本，`maxCorrections: 1`）：

```
=== turn 1
  step 1
  assistant text len 3047 | tools -          ← 超长，但本回合没有下一步
=== turn 2
  step 1
  assistant text len 1431 | tools todo_write
  INBOX next-step plugin:discipline-whale:brevity revision: over-long prose   ← 注入发生
  step 2   assistant 94
  step 3   assistant 96
=== turn 3
  step 1
  assistant text len 3088 | tools -          ← 又超长，仍无下一步
=== turn 4
  step 1
  assistant text len 1984 | tools todo_write
  INBOX next-step plugin:discipline-whale:brevity revision: over-long prose   ← 再次注入
  step 2   assistant 208
  step 3   assistant 123
```

**结论（可判定）**：

1. **注入真的会发生**，来源标记 `plugin:discipline-whale:brevity`、`form: notice`、`summary: "revision: over-long prose"`，正文 353 字，投递目标是 `next-step`。
2. **注入点是「本回合的下一个 step 边界」**。实现挂在 `agent/pre-step` 上，因此只有当这一回合在长回复之后**还会再走一步**（例如回复里带了工具调用）时，才有地方可注入；模型「说完就结束回合」的那种回复，回合已经 `completed`，没有下一步，纠正无处可投。
3. 所以用户在真机上「写了超长回复没感觉」的观察**与实现一致**，不是「写了但从不注入」，也不是装载失败。这是设计边界，不是本次安装引入的破损。按约束未改代码。
4. **worker 零注入**：同样的话术发给 `discipline-whale-worker` 会话，回复 3259 字，事件流里 brevity 注入数 = **0**。

```console
$ # worker session
seq 17 ASSISTANT text len 0
seq 22 ASSISTANT text len 3259
seq 24 turn/end {"turn":1,"reason":{"kind":"completed"}}
brevity injections in worker: 0
```

> 预算项说明：`maxCorrections: 1` 是「每个用户回合最多 1 次」。上述 4 个回合各注入 1 次（共 2 次，另 2 个回合没有下一步可投），符合设计。**未能**在单一回合内构造出「连写 3 段超长」的场景（模型每回合只走 1–3 步且只触发一次），这项只做了代码层与上述实测的交叉印证，未做严格的 3 连测。

---

## 6. 补充点 1：满屏 `✕ missing peer` 是不是真问题

### 6.1 事实：每一个插件都有，不只 discipline-whale

在 `/tmp` 里复刻同样一次安装（干净 `node_modules` + 同版本 tgz），完整捕获 pnpm 输出：

```
$ grep -E '^├─┬|^└─┬' (Issues with peer dependencies found 段落) | wc -l
12
├─┬ @goodandready/dsh-context-lens 0.1.34
├─┬ dsh-auto-memory 0.9.0
├─┬ dsh-client-auto-continue 0.15.0
├─┬ dsh-context 0.73.3
├─┬ dsh-doublecheck 0.9.29
├─┬ dsh-ide-git 0.19.9
├─┬ dsh-lsp-actions 0.5.15
├─┬ dsh-office-tools 1.0.6
├─┬ dsh-research-report 0.3.29
├─┬ dsh-rewind-plugin 0.17.1
├─┬ dsh-side-chat-plus 0.5.0
└─┬ dsh-motion-ui 0.8.7
（共 85 条 ✕ missing peer 行）
```

**`discipline-whale` 根本不在这个名单里**——`grep -c "missing peer"` 与按包分组后 `discipline-whale` 命中数为 0。原因是本包 `package.json` 声明的是 `dependencies: {}` / `peerDependencies: {}`（0.2.0/0.3.0/0.4.0 三个 tarball 逐一核对，三个字段全 null），它压根不参与 peer 解析。

### 6.2 这些 peer 由 Host 进程提供，不靠 pnpm 装

profile 的 `node_modules/@deepseek-ai/` 下只有两个包：

```console
$ ls ~/.dsh/profiles/web/node_modules/@deepseek-ai/
cosmokit
schemastery
```

而 DSH 插件声明的 peer 面是 `@deepseek-ai/dsh-tools` / `dsh-session` / `dsh-llm` / `dsh -fs` / `cordis` / `react` 等几十个——它们由 `dsh` 本体（`/Users/huiyuan/.npm/_npx/b86ed90107c62dab/node_modules/@deepseek-ai/*`）在运行时提供，pnpm 只负责插件自身。

### 6.3 同样满屏警告的 `dsh-motion-ui` 在运行时是好的

同一个临时实例里，`dsh-motion-ui` 注册的工具真实出现在主会话工具面：

```
render_text YES, render_ui YES, render_canvas YES, render_scene YES,
render_mechanism YES, update_ui YES, patch_ui YES, validate_ui YES,
inspect_ui YES, ui_catalog YES, preview_video YES, render_video YES, process_video YES
```

`dsh-office-tools`（同样满屏警告）的 `excel_*` / `ppt_*` / `word_*` 也在。两者都正常工作，说明这警告与本次安装无关。

### 6.4 反证检查：没有哪个插件「真的缺 peer 而别人不缺」

在临时实例里逐个装载，日志零 `Cannot find module`、零 `ERR_MODULE_NOT_FOUND`（§1.2），且 `agentPresets/list` 返回完整 6 个 preset。**未发现**任何一个插件因 peer 缺失而装载失败。

### 6.5 结论

> **peer 警告不是本次问题的原因。** 它是 pnpm 对 `peerDependencies` 的常规提示：DSH 插件的 `@deepseek-ai/*`、`cordis`、`react` 由 Host 进程提供，`node_modules` 里本来就不该有；12 个插件全都报，`discipline-whale` 自己一条都不报；同样报警的 `dsh-motion-ui` / `dsh-office-tools` 在运行时工具全部在位。

---

## 7. 补充点 2：`Packages: +1 -5` 的那 5 个是什么

### 7.1 精确复现了同一行

在 `/tmp` 建一个和线上一样的 profile 副本，先装 0.3.0 做基线，再切 0.4.0：

```console
$ # 0.3.0 基线
Packages: +28
Done in 7.3s using pnpm v10.33.0
baseline 0.3.0

$ # 切到 0.4.0
Packages: +1 -5
Progress: resolved 33, reused 2, downloaded 0, added 1, done
Done in 6.1s using pnpm v10.33.0
after 0.4.0
```

与用户看到的 `Packages: +1 -5` / `Progress: resolved 33, reused 6, downloaded 1, added 1, done` 完全同构。

### 7.2 `-5` 与 discipline-whale 无关：同版本重装也报 `-5`

```console
$ # package.json 一个字没改，再跑一次 install
Packages: -5
$ # 再跑一次
Packages: -5

$ pnpm install --reporter=ndjson | grep -o '"removed":[0-9]*\|"added":[0-9]*'
"removed":5
"added":0
```

**版本没变、依赖没变，仍然 `-5`** —— 说明它不是「0.3.0 的旧副本被换掉」。

### 7.3 那 5 个是 `@vshulcz/deja-vu` 的平台专用可选二进制，被平台判定跳过

`pnpm install --reporter=ndjson` 的逐条事件：

```json
{"name":"pnpm:skipped-optional-dependency","reason":"unsupported_platform",
 "package":{"id":"@vshulcz/deja-vu-darwin-amd64@0.22.2"}, ...}
{"name":"pnpm:skipped-optional-dependency","reason":"unsupported_platform",
 "package":{"id":"@vshulcz/deja-vu-linux-amd64@0.22.2"}, ...}
{"name":"pnpm:skipped-optional-dependency","reason":"unsupported_platform",
 "package":{"id":"@vshulcz/deja-vu-linux-arm64@0.22.2"}, ...}
{"name":"pnpm:skipped-optional-dependency","reason":"unsupported_platform",
 "package":{"id":"@vshulcz/deja-vu-windows-amd64@0.22.2"}, ...}
{"name":"pnpm:skipped-optional-dependency","reason":"unsupported_platform",
 "package":{"id":"@vshulcz/deja-vu-windows-arm64@0.22.2"}, ...}
```

线上 `node_modules/.modules.yaml` 的 `skipped` 字段**正好是这 5 个**：

```json
"skipped": [
  "@vshulcz/deja-vu-darwin-amd64@0.22.2",
  "@vshulcz/deja-vu-linux-amd64@0.22.2",
  "@vshulcz/deja-vu-linux-arm64@0.22.2",
  "@vshulcz/deja-vu-windows-amd64@0.22.2",
  "@vshulcz/deja-vu-windows-arm64@0.22.2"
]
```

本机是 `darwin/arm64`，所以只有 `@vshulcz/deja-vu-darwin-arm64` 需要、也确实装了：

```console
$ ls ~/.dsh/profiles/web/node_modules/@vshulcz
deja-vu
deja-vu-darwin-arm64        ← 本机架构的二进制在
```

### 7.4 交叉验证：0.3.0 → 0.4.0 的依赖图没有任何变化

```console
$ # lockfile packages / snapshots 两段对比
packages 33 -> 33   removed: []   added: []
snapshots 33 -> 33  removed: []   added: []
$ # node_modules 里 package.json 的真实文件树对比
full-030: 42 行 | full-040: 42 行
removed: （空）
added:   （空）
```

### 7.5 结论

> **`+1` = `discipline-whale@0.4.0`；`-5` = `@vshulcz/deja-vu` 的 5 个非本机平台可选二进制（darwin-amd64 / linux-amd64 / linux-arm64 / windows-amd64 / windows-arm64）被 pnpm 按 `os`/`cpu` 跳过并从 `node_modules` 剪掉。**
>
> 不是「别的插件的依赖被误删」：lockfile 与真实文件树在 0.3.0→0.4.0 之间**零增删**，同版本重装也同样报 `-5`。`deja` 在本机架构的二进制在位，功能不受影响。

### 7.6 线上 profile 现在指向 0.4.0

```console
$ node -p "require('/Users/huiyuan/.dsh/profiles/web/package.json').dependencies['discipline-whale']"
file:/Users/huiyuan/.dsh/plugins/packages/discipline-whale-0.4.0.tgz
$ node -p "require('/Users/huiyuan/.dsh/profiles/web/node_modules/discipline-whale/package.json').version"
0.4.0
```

> 附注（不是本次 `-5`）：与 10-20 的备份 `web.bak-20261020-011834` 对比，lockfile 里少的是 `@michengai/dsh-btw` 和 `@xbzbing/dsh-git-panel` 两个**插件**，那是 10-20 01:18 那次操作移掉的（`node_modules/@michengai`、`@xbzbing` 只剩空目录，mtime 10-20 01:18），与今天的 0.4.0 安装无关，且它们的 bundle 条目已不在 `dsh.profile.bundles` 里，属正常卸载。

---

## 8. 清理（必须做，已做）

```console
$ pgrep -fl "dsh --profile web --port 318"
44213 node .../dsh --profile web --port 3183 --no-open

$ kill 44213
$ sleep 3
$ kill -0 44213 && echo "STILL ALIVE" || echo "44213 gone"
44213 gone

$ for p in 3180 3181 3182 3183; do printf '%s: ' $p; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && echo LISTENING || echo free; done
3180: free
3181: free
3182: free
3183: free

$ pgrep -fl "dsh --profile web" | grep -v pgrep
（无输出，exit 1 —— 没有残留 dsh web）

$ rm -rf /tmp/dw-audit-home /tmp/dw-wt50 /tmp/dw-up /tmp/dw-peer /tmp/dw-selftest.aiff /tmp/dw-selftest.wav
$ ls -d /tmp/dw-audit-home /tmp/dw-wt50 /tmp/dw-up /tmp/dw-peer 2>/dev/null || echo "all removed"
all removed
```

用户实例全程只在**开始时**做了一次只读的 `lsof` 观察，之后未再触碰：

```console
$ lsof -nP -iTCP:3080 -sTCP:LISTEN | tail -1
node    27376 huiyuan   17u  IPv4 0x6c4e57f03e6bfbf2      0t0  TCP 127.0.0.1:3080 (LISTEN)
```

（PID 与开始时不同是因为用户在会话期间自己重启过一次，不是本自检造成的。）

`~/.dsh` 未被修改：所有写入只发生在 `/tmp/dw-audit-home` 与 `/tmp` 下的一次性副本里；真实 profile 的 `package.json` mtime 仍是安装时的 `Oct 21 14:54`。

---

## 9. 未验证项（本实例验不了，如实列出）

| 项 | 状态 | 原因 |
|---|---|---|
| 浏览器 UI 实际渲染（侧栏条目、语音 dock 浮层外观、点击 Call） | **未验** | 无头 HTTP 自检；只验到 boot 里有 `discipline-whale` entry、client bundle 里 `shell.overlay` 注册点在 |
| 真麦克风录音 → 浏览器采集 → 上传 | **未验** | 无浏览器、无麦克风权限；只验到服务端路由能处理真实 16k WAV |
| PiP / popup 小窗（`host.open("", "discipline-whale-voice", ...)`） | **未验** | 需要真实浏览器窗口 |
| 浏览器端语音合成（TTS fallback） | **未验** | 依赖设备语音；`status` 里 `tts.integrated:false`，本来就是 fallback |
| 浮层在浅色/深色主题下的对比度 | **未验** | 同上，需真实渲染 |
| `maxCorrections` 在单回合内连写 3 段超长的严格预算测试 | **部分未验** | 模型每回合只走 1–3 步、只触发一次；已用 4 个回合的实测 + 代码交叉印证，未构造出严格 3 连场景 |
| 插件的 HMR 热更新后行为 | **未验** | 需要 `pnpm run dev:web`，不属装后自检范围 |
| 长会话（上下文压缩后）的 guard/brevity 计数 | **未验** | 需要大量对话与真实 compaction |

---

## 10. 结论

| 面 | 结论 |
|---|---|
| 装载成功（A） | ✅ 进程活、端口响、日志零装载失败、dump 主 preset 有 brevity 行 + guard 四键、worker preset 0 命中；**工作树 link 与已安装 tarball 两种形态都验过** |
| 主会话能力面（B） | ✅ 79 工具、无 `bash`/`write`/`edit`、dispatch 七件齐；`whale-brevity` 在列表；第 11 次读被拒（`0 of 10` + `dispatch_task`）；`main.js` 被白名单拒；worker 78 工具只有 `report_to_main` + 编码工具、无 dispatch、skill 列表无 `whale-brevity` |
| 语音路由（C） | ✅ status 200（含 5 个字段、无 key）、settings 200（`hasApiKey` 布尔）、say 空 400 / `{text:"自检"}` 200 带 `sessionId`、transcribe 空 body 400 `voice/empty-audio`、不支持类型 415；**并在有 key 时完成了一次真转写**（whisper-large-v3，4.351s） |
| 客户端插件面（D） | ✅ boot 里有 `discipline-whale` entry 且 bundle 实际可取（134 KB），`shell.overlay` + id `discipline-whale-voice` 注册点在 |
| peer 警告 | ✅ **不是本次问题的原因**（12 个插件全报、本包一条不报、同警告的 motion-ui/office-tools 运行时正常） |
| `+1 -5` | ✅ `+1`=0.4.0；`-5`=`@vshulcz/deja-vu` 的 5 个异平台可选二进制，非插件依赖误删（依赖图零变化、同版本重装同样 `-5`） |
| ADHD 注入 | ⚠️ **会注入**（`plugin:discipline-whale:brevity`，next-step，353 字），但**只在本回合还有下一步时**；worker 零注入。属设计边界，未改代码 |
| 清理 | ✅ 5 个临时实例全杀、3180–3183 全释放、无残留进程、临时 DSH_HOME 已删、3080 未受影响 |
