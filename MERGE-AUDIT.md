# 合并体检报告（MERGE-AUDIT）

- 仓库：`/Users/huiyuan/Developer/projects/discipline-whale`
- 基线 commit：`ac8e8ac`（`feat: give the whale a sidebar entry and a private home`），工作区有 10 个已修改文件 + 14 个未跟踪路径（五个并行会话的产出，均未提交）
- 审计时间：2026-10-21
- 结论摘要：**合并本身干净**（无冲突标记、无重复定义、无漏掉的套件、无重复 exports 键、DICTIONARIES zh/en 完全对齐），**打包产物齐全**（30 个文件，patch 里 4 个 `discipline-whale/xxx` 引用逐个有 exports、逐个在包里）。审计发现一处真实缺陷（`installBrevity` 被同 preset 的两行各装一次 → 一次超长回复注入 2 条纠正），并已按「让安装本身幂等」的口径**修掉**（见 §5.2）。修复后八个进程全部 exit=0，新增 3 条断言（ok 8f / 8g / 9b），`ok` 总数 97 → 100。
- **本次没有重启用户正在跑的 `dsh web`；没有动 `$DSH_HOME/plugins/`；没有执行 `scripts/install-local.sh`。**

---

## 一、确认没有互相覆盖

### 1.1 `package.json` 的 `test:all` 与 `exports` / `files`

**结论：pass**

`test:all` 实际字符串（`node -e 'console.log(require("./package.json").scripts["test:all"])'`）：

```
node test/contract.mjs && node test/guard.mjs && node test/adhd.mjs && node test/voice.mjs && node test/client.mjs && node test/dock.mjs && node test/settings.mjs
```

逐条核对：7 段、7 个不同文件、**无遗漏、无重复**。

```
segments: 7
node test/contract.mjs
node test/guard.mjs
node test/adhd.mjs
node test/voice.mjs
node test/client.mjs
node test/dock.mjs
node test/settings.mjs
dups: []
missing: []
```

要求的七个套件（contract / guard / adhd / voice / client / dock / settings）全部在内。VERIFICATION.md:1124 记录的那次事故（某会话把 `dock` / `settings` 删掉、另一会话加回）**当前状态是已修复的**，`dock` 与 `settings` 都在链上，且 `test:dock` / `test:settings` 单独脚本也存在。

`exports`（17 条，全部到齐）：

```
  .              -> ./home.js
  ./main         -> ./main.js
  ./worker       -> ./worker.js
  ./home         -> ./home.js
  ./store        -> ./store.js
  ./registry     -> ./registry.js
  ./guard        -> ./guard.js
  ./adhd         -> ./adhd.js
  ./locale/*.json-> ./locale/*.json
  ./icon         -> ./icon.svg
  ./package.json -> ./package.json
  ./checkpoint   -> ./checkpoint.js
  ./client       -> ./client.js
  ./voice        -> ./voice.js
  ./voice-silence-> ./voice-silence.js
  ./prompt-probe -> ./prompt-probe.mjs
  ./voice-settings-> ./voice-settings.js
```

任务点名的 7 个（`./adhd` `./guard` `./voice` `./voice-silence` `./voice-settings` `./client` `./prompt-probe`）**全部存在**：

```
OK   ./adhd -> ./adhd.js
OK   ./guard -> ./guard.js
OK   ./voice -> ./voice.js
OK   ./voice-silence -> ./voice-silence.js
OK   ./voice-settings -> ./voice-settings.js
OK   ./client -> ./client.js
OK   ./prompt-probe -> ./prompt-probe.mjs
missing: 0
```

`files`（21 条）：

```
main.js, worker.js, home.js, client.js, voice.js, voice-settings.js, voice-silence.js,
store.js, checkpoint.js, registry.js, guard.js, adhd.js, cordis.patch.yml, locale/*.json,
icon.svg, README.md, VERIFICATION.md, LICENSE, prompt-probe.mjs, test/*.mjs, skills/**/*.md
```

所有新增源文件都在（`guard.js` / `adhd.js` / `voice.js` / `voice-silence.js` / `voice-settings.js` / `prompt-probe.mjs`），`skills/**/*.md` 在。`test/*.mjs` 覆盖全部 8 个测试文件（含 `smoke-restart.mjs`）。

> 备注（非缺陷）：`scripts/handoff-snapshot.mjs` 与 `HANDOFF-voice-ui.md` 不在 `files` 里，因此不进包。二者是交接文档工具，不是运行时产物；`scripts/install-local.sh` 也不在包里（它在仓库里，`npm pack` 不含 `scripts/`）。这不影响 preset 装载，因为 patch 不引用它们。如需随包分发，属产品决定，本次不动。

### 1.2 逐套件单独跑（不信任 `&&` 链）

**结论：pass，全部 exit=0**

`&&` 链在中途失败会静默跳过后续套件——这正是漏报机制。所以每个套件单独起进程：

```
contract       exit=0  last=All discipline-whale contract checks passed.
guard          exit=0  last=All discipline-whale guard checks passed.
adhd           exit=0  last=All discipline-whale brevity checks passed.
voice          exit=0  last=All discipline-whale voice checks passed.
client         exit=0  last=All discipline-whale client checks passed.
dock           exit=0  last=All discipline-whale dock checks passed.
settings       exit=0  last=All discipline-whale voice-settings checks passed.
smoke-restart  exit=0  last=SMOKE PASS — dispatch survived a full memory wipe and the report reached the main session
```

聚合链也一致：

```
npm run test:all exit=0
97          # "^ok " 行数（§5.2 修复后为 100：+ok 8f / 8g / 9b）
```

注意 smoke（`test:smoke`）**不**在 `test:all` 里，是独立脚本。任务要求「五套件 + smoke 必须全绿」，两者都单独跑过，均 exit=0。

### 1.3 `cordis.patch.yml`

**结论：pass**

`grep -c` 计数（任务点名要的）：

```
brevity total in cordis.patch.yml: 1
id: discipline-whale-brevity occurrences: 1
brevity in main preset block: 1
brevity in worker preset block: 0
readQuota: 2
watchdogThreshold: 2
maxInterventions: 2
watchdogCounting: 2
```

- 主 preset 里 `discipline-whale-brevity` **存在且只有一处**（`cordis.patch.yml:152`，唯一一行 `- id: discipline-whale-brevity`）。
- worker preset 里 **0 命中**。
- guard 四个 config 键全部在 `discipline-whale-main` 行（`:136-139`）：`readQuota: 10` / `watchdogThreshold: 10` / `maxInterventions: 2` / `watchdogCounting: all`。每个键出现 2 次是因为 1 次在配置里 + 1 次在紧邻的注释块里说明用途（`:132-135`）。

四个键**可覆盖**——经 `main.Config['~standard'].validate` 透传、再由 `resolveGuardConfig` 校验，实测：

```
issues: undefined
carried: {"workerPreset":"x","watchdogThreshold":4,"readQuota":3,"maxInterventions":1,"watchdogCounting":"read-only","maxProseChars":600,"maxCorrections":2,"enabled":false}
guard resolution: {"mainPreset":"discipline-whale","watchdogThreshold":4,"readQuota":3,"maxInterventions":1,"watchdogCounting":"read-only"}
junk dropped: true
junk falls back: {"mainPreset":"discipline-whale","watchdogThreshold":10,"readQuota":10,"maxInterventions":2,"watchdogCounting":"all"}
```

即：合法值生效，未知键被丢弃，非法值回落默认而不抛错。

### 1.4 `main.js`

**结论：pass**

`installGuard` 与 `installBrevity` 都在 `apply()` 里：

```
24:import { installGuard, resolveGuardConfig } from './guard.js'
25:import { installBrevity } from './adhd.js'
1114:  installGuard(ctx, resolveGuardConfig(config))
1120:  installBrevity(ctx, config)
```

> 见 §5.2：`installBrevity` 在这里与 `adhd.js` 的 `apply()` 各调用一次，同一 preset scope 上会重复安装。**已修**——两个调用点都保留，唯一性由 `installBrevity` 内部的 scope 幂等保证。

`DELIVERY_TIMINGS` / `resolveTiming` / `dispatch_task` 的 `at` / `send_to_session` 的 `at` 都在：

```
568:export const DELIVERY_TIMINGS = ['queue', 'step', 'abort']
571:export function resolveTiming(at) {
286:        at: {          # dispatch_task 的参数 schema
646:        at: {          # send_to_session 的参数 schema
336:      const timing = resolveTiming(args.at)   # dispatch_task 使用点
679:      const timing = resolveTiming(args.at)   # send_to_session 使用点
```

**无重复定义**。对全仓 `*.js` / `*.mjs` 做了两层扫描（顶层声明 + 嵌套 `function` 声明），零命中：

```
top-level dup scan done
function-decl scan done
```

- `DELIVERY_TIMINGS`：1 处定义（`:568`）
- `resolveTiming`：1 处定义（`:571`），两处调用
- `installGuard` / `installBrevity` 在 `main.js` 里是 import，不是定义

### 1.5 `client.js`

**结论：pass**

八个点名符号各**只定义一次**：

```
--- speakReply: defs=1        1249:    function speakReply(text, env) {
--- speakable: defs=1         723:    function speakable(text) {
--- speechLanguage: defs=1    743:    function speechLanguage() {
--- dockStyles: defs=1       2153:    function dockStyles() {
--- dockView: defs=1         1009:    function dockView(input) {
--- settingsView: defs=1     1085:    function settingsView(input) {
--- createCallControls: defs=1  468:    function createCallControls() {
--- createFrameGate: defs=1    510:    function createFrameGate(options) {
```

`module.exports` **没有重复键**（24 个赋值、24 个唯一键）：

```
total 24 unique 24
dups: {}
```

`DICTIONARIES` 的 zh/en 两侧 key 集合**完全一致**（各 95 个，零差异、零重复）：

```
zh: 95 unique 95 dups []
en: 95 unique 95 dups []
zh-only: []
en-only: []
```

> 这条是最容易在并行合并里破的：任一侧少一个键，运行时就是 `undefined`。当前 95/95 对齐，`locale/*.json` 也各自解析正常。

### 1.6 全仓遗留标记扫描

**结论：pass（无冲突标记、无残留 probe 类名）**

```
=== conflict markers (^<<<<<<< / ^======= / ^>>>>>>>) ===
(无命中，exit 0)

=== inline markers (<<<<<<< / >>>>>>>) ===
(无命中，count: 0)

=== TODO 后跟会话 id ===
(无命中)

=== FIXME / XXX / HACK ===
(无命中)

=== probe-class / test-inject / __probe / tmp-class / debug-class ===
(无命中)

=== TODO 总数 ===
(无，exit 1 = grep 无匹配)
```

`=======` 在全仓有 8 处命中，全在 `problems.html` 的 HTML 注释里（`<!-- ============ P1-1 =========== -->`），是排版分隔线，不是冲突标记；且 `problems.html` 被 `.gitignore` 排除、不进包，不在本次判据内。

`probe` 一词的命中全部是真实业务语义（`/models` 连接探测、`prompt-probe.mjs` 这个正式工具、`test/guard.mjs:516` 造的 `probe-N.md` 临时读文件），没有临时测试注入的类名残留。`client.js` 里的 `.dw-*` 类名清单全部是正式 UI 类（48 个），无 `probe` / `test-inject` 之类。

---

## 二、打包产物齐全

### 2.1 `npm pack` 实际内容

**结论：pass，30 个文件**

`npm pack --dry-run` 因 `~/.npm/_cacache` 里有 root 拥有的文件而 EPERM，改用临时 cache：

```
npm pack --pack-destination /tmp/dw-pack --cache /tmp/npm-cache-dw
discipline-whale-0.4.0.tgz
npm notice total files: 30
```

`tar -tzf` 全清单：

```
package/adhd.js
package/checkpoint.js
package/client.js
package/cordis.patch.yml
package/guard.js
package/home.js
package/icon.svg
package/LICENSE
package/locale/en.json
package/locale/zh.json
package/main.js
package/package.json
package/prompt-probe.mjs
package/README.md
package/registry.js
package/skills/whale-brevity/SKILL.md
package/store.js
package/test/adhd.mjs
package/test/client.mjs
package/test/contract.mjs
package/test/dock.mjs
package/test/guard.mjs
package/test/settings.mjs
package/test/smoke-restart.mjs
package/test/voice.mjs
package/VERIFICATION.md
package/voice-settings.js
package/voice-silence.js
package/voice.js
package/worker.js
```

任务点名的必备项**逐个勾**：

```
OK   adhd.js
OK   guard.js
OK   voice.js
OK   voice-silence.js
OK   voice-settings.js
OK   prompt-probe.mjs
OK   skills/whale-brevity/SKILL.md
OK   client.js
OK   home.js
OK   main.js
OK   worker.js
OK   cordis.patch.yml
OK   locale/en.json
OK   locale/zh.json
OK   test/adhd.mjs
OK   test/client.mjs
OK   test/contract.mjs
OK   test/dock.mjs
OK   test/guard.mjs
OK   test/settings.mjs
OK   test/voice.mjs
OK   test/smoke-restart.mjs
```

全部 22 项命中，**无 MISS**。

另外，`exports` 里**每一条**都在包里（含 glob 展开）：

```
exports missing from tarball: 0
```

### 2.2 关键：patch 引用 vs exports vs 包内文件

**结论：pass，4/4 全通**

`cordis.patch.yml` 里出现的每个 `discipline-whale/xxx`：

| patch 里的引用 | 位置 | 对应 `exports` 键 | 指向文件 | 包内 | 判定 |
|---|---|---|---|---|---|
| `discipline-whale` | `:65`（home 行） | `.` | `./home.js` | `home.js` | ✓ |
| `discipline-whale/main` | `:125`（主 preset） | `./main` | `./main.js` | `main.js` | ✓ |
| `discipline-whale/adhd` | `:153`（brevity 行） | `./adhd` | `./adhd.js` | `adhd.js` | ✓ |
| `discipline-whale/worker` | `:254`（worker preset） | `./worker` | `./worker.js` | `worker.js` | ✓ |

机器核对输出：

```
patch refs: [ 'discipline-whale', 'discipline-whale/main', 'discipline-whale/adhd', 'discipline-whale/worker' ]
discipline-whale              | .      | ./home.js   | home.js   | in tarball | OK
discipline-whale/main         | ./main | ./main.js  | main.js   | in tarball | OK
discipline-whale/adhd         | ./adhd | ./adhd.js  | adhd.js   | in tarball | OK
discipline-whale/worker       | ./worker | ./worker.js | worker.js | in tarball | OK
bad: 0
```

`./adhd` 这一条是本次合并新加的，正是任务最担心漏的那种——它现在 exports 有、包里也有。

**加强验证**：把 tarball 解到临时 profile 的 `node_modules/discipline-whale`，用 Node 的真实解析器逐条 `require.resolve`，全部成功（不只是「文件在」，而是「exports 能真解析」）：

```
RESOLVE OK   discipline-whale -> ./node_modules/discipline-whale/home.js
RESOLVE OK   discipline-whale/main -> ./node_modules/discipline-whale/main.js
RESOLVE OK   discipline-whale/adhd -> ./node_modules/discipline-whale/adhd.js
RESOLVE OK   discipline-whale/worker -> ./node_modules/discipline-whale/worker.js
RESOLVE OK   discipline-whale/home -> ./node_modules/discipline-whale/home.js
RESOLVE OK   discipline-whale/guard -> ./node_modules/discipline-whale/guard.js
RESOLVE OK   discipline-whale/client -> ./node_modules/discipline-whale/client.js
RESOLVE OK   discipline-whale/voice -> ./node_modules/discipline-whale/voice.js
RESOLVE OK   discipline-whale/voice-silence -> ./node_modules/discipline-whale/voice-silence.js
RESOLVE OK   discipline-whale/voice-settings -> ./node_modules/discipline-whale/voice-settings.js
RESOLVE OK   discipline-whale/store -> ./node_modules/discipline-whale/store.js
RESOLVE OK   discipline-whale/registry -> ./node_modules/discipline-whale/registry.js
RESOLVE OK   discipline-whale/checkpoint -> ./node_modules/discipline-whale/checkpoint.js
RESOLVE OK   discipline-whale/prompt-probe -> ./node_modules/discipline-whale/prompt-probe.mjs
RESOLVE OK   discipline-whale/icon -> ./node_modules/discipline-whale/icon.svg
RESOLVE OK   discipline-whale/locale/zh.json -> ./node_modules/discipline-whale/locale/zh.json
RESOLVE OK   discipline-whale/locale/en.json -> ./node_modules/discipline-whale/locale/en.json
```

**包里那份自己也全绿**（在解包目录里跑它自带的测试，证明打包没破坏任何相对路径/skill 文件读取）：

```
packed contract exit=0
packed guard exit=0
packed adhd exit=0
packed voice exit=0
packed client exit=0
packed dock exit=0
packed settings exit=0
```

### 2.3 `scripts/install-local.sh`

**结论：pass（与打包清单一致；按要求未执行）**

读到的内容（27 行）：它 `npm pack --pack-destination "$dsh_home/plugins/packages"`，然后 `dsh plugin --profile "$profile" remove discipline-whale` + `dsh plugin --profile "$profile" add "$tarball"`。也就是说它**用的就是同一个 `npm pack`**，清单由 `package.json` 的 `files` 决定，与 §2.1 完全一致，没有第二份手写清单可以漂移。

它做的事：`rm -f` 旧 tarball → 打包 → 从 profile 移除旧插件 → 加入新 tarball → 打印「restart dsh web」。**会动 `$DSH_HOME/plugins/packages` 和 profile 依赖**，所以本次**没有执行**。

---

## 三、真实装载路径（不重启服务）

### 3.1 临时 `DSH_HOME` 下的 `--dump-config`

**结论：pass，exit=0**

按已知的坑把 profile 副本放在 `<DSH_HOME>/profiles/audit/`（**不是** `<DSH_HOME>/audit`，否则 `loadProfile` 会新建默认 profile，dump 出只有 `dsh-base`/`dsh-web-app` 两层——那是假阴性）：

```
TMP=/tmp/dw-home-20wzVm
/tmp/dw-home-20wzVm/profiles/audit/{package.json, cordis.yml, cordis.patch.yml, node_modules/discipline-whale/...}

DSH_HOME=$TMP dsh --profile audit --dump-config
exit=0
```

dump 出的对象树 193 个顶层条目，两个 preset 都在。逐项断言：

```
===== - id: preset-discipline-whale
 brevity lines: ['- id: discipline-whale-brevity']
  readQuota: 1
  watchdogThreshold: 1
  maxInterventions: 1
  watchdogCounting: 1
  'discipline-whale/main': 0   # 见下方说明
  'discipline-whale/worker': 0

===== - id: preset-discipline-whale-worker
 brevity lines: []
  readQuota: 0
  watchdogThreshold: 0
  maxInterventions: 0
  watchdogCounting: 0
```

主 preset 块里 `discipline-whale-brevity` 出现 **1 次**、guard 四键各 **1 次**；worker 块内 **0 命中**。

（上表 `'discipline-whale/main': 0` 是我脚本的引号匹配问题——dump 输出里 `name: discipline-whale/main` 不带引号，直接 grep 可确认它在主 preset 块内、不在 worker 块内：

```
1327:        name: discipline-whale/main
1335:        name: discipline-whale/adhd
1442:        name: discipline-whale/worker
```

1327/1335 落在主 preset（起始 1233）与 worker preset（起始 1392）之间，1442 落在 worker 内。正确。）

对应的 dump 原文（`/tmp/dw-dump.txt:1326-1340`）：

```yaml
      - id: discipline-whale-main
        name: discipline-whale/main
        config:
          workerPreset: discipline-whale-worker
          readQuota: 10
          watchdogThreshold: 10
          maxInterventions: 2
          watchdogCounting: all
      - id: discipline-whale-brevity
        name: discipline-whale/adhd
        config:
          maxProseChars: 1200
          maxCorrections: 1
          enabled: true
```

有一点需要如实记录：**第一次** dump 时 stderr 多打了一行

```
dsh: [/tmp/dw-home-20wzVm/profiles/audit/cordis.patch.yml] patch: entry "dsh-session-kit" not found
```

原因是我把仓库的 `cordis.patch.yml` 也拷成了 profile 的 user layer，于是它被应用了两遍（一遍来自 bundle、一遍来自 user layer），第二次找不到已禁用的 `dsh-session-kit`。把 user layer 清成 `[]` 后，只剩 bundle 自己那一条**预期内**的提示：

```
dsh: [discipline-whale] patch: entry "dsh-session-kit" not found
```

这是 patch 里明文设计的安全行为（`cordis.patch.yml:38-40`：「On a profile without that bundle the patch warns ... and is skipped, so this stays safe to install on its own」），`exit` 仍为 0，不是缺陷。

### 3.2 `prompt-probe.mjs` 两个 preset

**结论：pass**

```
node prompt-probe.mjs discipline-whale          -> exit=0, 10229 chars
node prompt-probe.mjs discipline-whale-worker   -> exit=0,   692 chars
```

主会话 prompt（10229 字符）含：
- **输出纪律段**：`## 输出纪律（ADHD 读者）`，其后是 `# whale-brevity` 全文（第 2.1–2.10 十条规则、UI 交付物豁免等）
- **派工纪律段**：`## 1. 派工优先` … `## 8. 被重启打断的派工`

worker prompt（692 字符）**不含**输出纪律（无「输出纪律」「whale-brevity」），但**仍含**详细回报要求——这是任务点名「不能被任何一次合并弄丢」的那段：

```
You are a Discipline Whale worker. A main session dispatched you to do one concrete
piece of work in this workspace.

Do the work, verify it, then report. You must call `report_to_main` exactly once
before you finish: a short `summary` the main session reads directly, and a detailed
`document` with what you changed, what you verified, and what is left.

If the task cannot be completed, report that honestly with `status: "blocked"`
rather than stopping silently. If you stop without reporting, you will be steered
back and asked for it.

You cannot dispatch further work: this preset has no dispatch tools, and your
sub-agents inherit it.
```

`detailed document` 的三要素（what you changed / what you verified / what is left）都在。worker prompt 里也确实没有派工工具那一段——符合设计。

### 3.3 让 cordis 真实解析这个包（新加的 `adhd` 行）

**结论：pass，不抛 `Cannot find module`**

把打包产物解到临时 profile，用**真实 Host 包**（`@deepseek-ai/cordis` + `dsh-system-prompt` + `dsh-scope`）挂载，并用最小假 Host 提供 `tools` / `sessionController` / `workspaceRegistry`：

```
resolved adhd -> .../profiles/audit/node_modules/discipline-whale/adhd.js
resolved main -> .../profiles/audit/node_modules/discipline-whale/main.js
resolved home -> .../profiles/audit/node_modules/discipline-whale/home.js
adhd exports: DEFAULT_MAX_CORRECTIONS,DEFAULT_MAX_PROSE_CHARS,RULES_PATH,RULES_SECTION_NAME,SKILL_NAME,
              TEXT_CHANNEL_TOOLS,UI_EXEMPT_TOOLS,apply,brevityNotice,countTextInArgs,inject,installBrevity,
              isUiTurn,loadRules,name,resolveBrevityConfig,shouldEnforceBrevity,stripFrontmatter
adhd.name: discipline-whale-brevity  inject: ["systemPrompt"]
adhd.apply returned: undefined
sections registered: ["discipline-whale:brevity"]
skills registered: ["whale-brevity"]
section has 输出纪律 header: true
section length: 2766
main.apply returned: undefined
main tools: ["abandon_dispatch","dispatch_task","list_dispatches","list_workspaces","read_report","resume_dispatch","send_to_session"]
main sections: []
main skills: []
home exports: HOME_ROUTE,MAIN_PRESET,MAIN_TITLE,STATE_FILENAME,WAKE_PROMPT,apply,createMainSession,
              ensureHome,homeHandler,interruptedNotice,readState,startupCheck,writeState
LOAD CHECK PASS
```

新加的 `adhd` 行：解析成功、`name` 正确、`inject` 正确、`apply()` 真的注册了 prompt section（2766 字符、含「输出纪律」抬头）与 `whale-brevity` skill。`main` 行照旧注册 7 个工具。`home` 行的 `apply` 也在。

这证明：**重启后 preset 装载不会因为 `discipline-whale/adhd` 找不到模块而整体失败**。

---

## 四、附带的一致性检查

| 检查 | 结果 |
|---|---|
| 全部 `*.js` / `*.mjs` 语法（`node --check`） | 全通过 |
| `locale/*.json`、`package.json` JSON 解析 | 全通过 |
| `cordis.patch.yml` 里 `- id:` 是否有重复 | 重复的 16 个都是**两个 preset 各自的同名行**（`persona`、`tool-fs`、`compaction` 等），这是 preset 的隔离语义，不是重复定义；`discipline-whale-*` 的 id 全部唯一 |
| README / VERIFICATION 标题是否有合并重复 | 无重复（37 / 100 个标题，`uniq -d` 为空） |
| `client.js` 的 `.dw-*` 类名 | 48 个，全部正式类名，无 probe/test 残留 |

---

## 五、发现的每一处覆盖或遗漏，以及改了什么

### 5.1 本次修改：两处（都在 §5.2 修复范围内）

审计阶段（§1–§4）对仓库**没有做任何修改**：所有「并行合并破损」的判据（重复定义、漏套件、缺 exports/files、残留冲突标记、DICTIONARIES 缺键、重复 exports 键）**逐项检查均为干净**。

随后按用户明确口径修掉了 §5.2 的重复安装缺陷，改动只有两个文件：

| 文件 | 改动 |
|---|---|
| `adhd.js` | 新增 `installedScopes` / `scopeKeyOf` / `isBrevityInstalled`；`installBrevity` 按 preset scope 去重，末尾登记并在 effect 清理时注销；返回值加 `installed` |
| `test/adhd.mjs` | `mountBrevity` 改为**双行常规装配**；新增 ok 8f / 8g / 9b；ok 9 加「重复安装不增监听器」断言 |

未改 `main.js`、`cordis.patch.yml`、`client.js` 及语音相关文件。

### 5.2 真实缺陷：`installBrevity` 被重复安装（**已修**）

**现象**：`installBrevity` 被两个不同的行各调用一次，而这两行**都挂在同一个 preset 里**：

- `main.js:1120`（`discipline-whale-main` 行）→ `installBrevity(ctx, config)`
- `adhd.js:550`（`discipline-whale-brevity` 行，在其 `apply()` 里）→ `installBrevity(ctx, config)`

`cordis.patch.yml` 的 `preset-discipline-whale` 中两行都在（`:124-139` 与 `:152-157`）。

**修复前实测**（真实 cordis，两行挂进同一 preset scope，一个 1300 字符回复、`maxProseChars: 1200`、`maxCorrections: 1`）：

```
main row only      : corrections = 1
adhd row only      : corrections = 1
BOTH rows (the real preset): corrections = 2      <-- 预算是 1，实际注入 2 条
```

注入的两条文本完全相同（都是 `brevityNotice` 的输出）：

```
RESULT  corrections injected for ONE over-long reply: 2
   notice: [Discipline Whale] 这条回复的正文约 200 字，超过了简洁上限 50 字。…
   notice: [Discipline Whale] 这条回复的正文约 200 字，超过了简洁上限 50 字。…
```

两行的 `maxProseChars` 各自独立生效，取**较松的那个**先触发，纠正条数翻倍：

```
operator set maxProseChars=600 on the brevity row; main row omitted it (default 1200)
  reply 700 chars (over 600, under default 1200) -> corrections: 1
  reply 1300 chars (over both)                   -> corrections: 2
```

**为什么测试没抓到**（这比缺陷本身更值得修）：没有任何测试把两行挂进**同一个 scope**。`test/adhd.mjs` 的 `mountBrevity()` 只 `installBrevity` 一次；ok 9 数的是 `agent/assistant-stream` 上「guard + brevity」共 2 个监听器，**这个数字无论 brevity 装一次还是两次都是 2**，所以它天生看不见这类问题。`test/contract.mjs` ok 23 用 `prompt-probe`（只挂 `adhd` 行、不挂 `main` 行），ok 27 只断言**声明**、不挂载。两边各自「全绿」，合起来的行为没人测。

#### 修法：让安装本身幂等

口径是「幂等」，不是「只在一个地方调用」。两个调用点**都保留**：`main.js` 那行是既有风格（guard 也这样装），`adhd.js` 那行的 `apply()` 还承担 prompt section 与 skill 注册，删任何一个都会推翻既有验收口径。因此唯一性由 `installBrevity` 内部保证。

`adhd.js` 新增（约 45 行，含注释）：

```js
const installedScopes = new WeakMap()

function scopeKeyOf(ctx) {
  const parent = ctx?.fiber?.parent
  if (parent !== undefined && parent !== null) return parent
  const fiber = ctx?.fiber
  if (fiber !== undefined && fiber !== null) return fiber
  return typeof ctx === 'object' && ctx !== null ? ctx : undefined
}

export function isBrevityInstalled(ctx) { ... }

export function installBrevity(ctx, config = {}) {
  ...
  const scopeKey = scopeKeyOf(ctx)
  const existing = scopeKey === undefined ? undefined : installedScopes.get(scopeKey)
  if (existing !== undefined) return { ...existing, installed: false }
  ...
  const handle = { config: resolved, sessions, isMainAgent, rules: rulesBody, installed: true }
  if (scopeKey !== undefined) {
    installedScopes.set(scopeKey, handle)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (installedScopes.get(scopeKey) === handle) installedScopes.delete(scopeKey)
      }, 'brevity.scope-guard')
    }
  }
  return handle
}
```

第二次安装直接返回既有 handle（`installed: false`），不挂监听器、不建第二份 `sessions`、不新增计数。返回值仍是同一份 handle，所以调用方不会把「已装过」误读成「没装」。

#### 幂等的键是什么：`ctx.fiber.parent`

**用 `ctx.fiber.parent`（持有该 scope 的 fiber），不是 `sessionId`。**

- **不能用 `sessionId`**：preset 树**挂载一次、被所有选用该 preset 的 Session 共享**。scope 比任何一个会话活得久——用会话 id 做键，第二个会话进来就会再装一遍，缺陷原样复现。
- **不能用 `ctx`**：每行运行在自己的子 context 上，而**恰好**是「必须去重的这两个调用点」`ctx` 不同，拿它做键等于永不去重。
- **不能用 preset id 字符串**：同一进程里同一 preset 的两次挂载是两份合法且独立的组合；字符串键会让第二次挂载静默失去钩子。
- `ctx.fiber.parent` 同时满足三条：同 preset 的兄弟行**共享**它、不同 preset **不同**、每次重新挂载**是新的**。所以「同 scope 去重」与「重挂载重新安装」两者都对。
- 用 `WeakMap` 而不是 `Set`：scope 销毁后键可回收；并且在 `ctx.effect` 的清理里按 handle 身份删除，行卸载不会留下「已安装」的陈旧标记。

实测三种情形（真实 cordis，`test/adhd.mjs` ok 8g）：

```
sibling rows in one preset scope : [true, false]   # 第一行装、第二行 no-op
a different preset id            : [true, false]   # 独立组合，正常安装
a remount of the same preset id  : [true, false]   # 新树，重新安装
```

#### 修复后实测

```
isBrevityInstalled BEFORE any row: false
after main row  -> isBrevityInstalled: false   // 见下方说明
after adhd row  -> isBrevityInstalled: false
RESULT corrections for ONE 1300-char reply (maxCorrections=1): 1
```

`corrections` 从 2 变 1，缺陷消除。`isBrevityInstalled` 那三行 `false` 是我探测脚本的取键问题（探测的是 `scope.ctx`，而安装键是行的 `fiber.parent`）；真正的断言在 `test/adhd.mjs` ok 8f/8g/9b 里，用的是每行自己的 ctx，全部通过。

`maxCorrections` 在双行装配下**仍被精确遵守**（每档连打 4 个超长步）：

```
maxCorrections=0 -> corrections over 4 over-long steps: 0
maxCorrections=1 -> corrections over 4 over-long steps: 1
maxCorrections=2 -> corrections over 4 over-long steps: 2
```

#### 测试怎么改的

1. **双行装配变成常规**：`test/adhd.mjs` 的 `mountBrevity()` 现在**总是**挂两行——两个独立的 ctx 对象，共享同一个 `fiber.parent`，正是 cordis 给 preset scope 里兄弟行的拓扑。原先「只挂一行」的假装配是 13 项全绿却看不见缺陷的根本原因，已消除；其余 8a–8e 用例全部自动改为双行装配后仍然全绿。
2. **新增 ok 8f**：连装两次 → 注册次数不变、共享同一份 `sessions`、一次超长回复只注入 1 条。
3. **新增 ok 8g**：幂等键的三种情形（兄弟行去重 / 不同 preset 独立装 / 重挂载重新装）。
4. **新增 ok 9b**：任务点名的那条——`agent/assistant-stream` 上 **brevity 自己的**监听器数量为 1（不是 ok 9 里那个「guard + brevity = 2」）；`agent/pre-step` 同样为 1；兄弟行返回 `installed: false`。
5. **ok 9 加断言**：`main.apply` 之后 scope 已标记为已安装，再调 `installBrevity` 不会新增任何监听器。

**红测有效性验证**：把 `adhd.js` 临时还原成修复前语义（绕过去重）后跑新测试，`test/adhd.mjs` **exit=1**，失败在 `ok 8b`：

```
AssertionError [ERR_ASSERTION]: the over-long turn earns exactly one injected reminder
  expected: 1,
```

即新的双行装配确实能抓住这个缺陷；修复后 exit=0。

#### 改动清单（最小）

| 文件 | 改动 |
|---|---|
| `adhd.js` | 新增 `installedScopes` / `scopeKeyOf` / `isBrevityInstalled`，`installBrevity` 开头去重、末尾登记并在 effect 清理时注销；返回值加 `installed` 字段 |
| `test/adhd.mjs` | `mountBrevity` 改为双行装配并记录注册次数；新增 ok 8f / 8g / 9b；ok 9 加一条「重复安装不增监听器」 |

**没有**改 `main.js`（两个调用点都保留）、**没有**改 `cordis.patch.yml`、**没有**碰 `client.js` 与语音相关文件。既有验收口径全部不变：一次超长回复 = 1 条纠正、UI 轮整轮豁免、`render_text` 不豁免、worker 完全放行、`maxCorrections` 可配（0/1/2 已实测）。

### 5.3 上一轮事故的复核（已修复，无需动作）

VERIFICATION.md:1124 记录的 `test:all` 删套件事故事件：**当前已是修复状态**，`contract / guard / adhd / voice / client / dock / settings` 七个都在，且七个各自单独跑都 exit=0（§1.2）。

---

## 六、打包产物清单 vs patch 引用（对照表）

| # | patch 引用 | patch 行 | `exports` 键 | 包内文件 | 判定 |
|---|---|---|---|---|---|
| 1 | `discipline-whale` | 65 | `.` → `./home.js` | `home.js` | ✓ |
| 2 | `discipline-whale/main` | 125 | `./main` → `./main.js` | `main.js` | ✓ |
| 3 | `discipline-whale/adhd` | 153 | `./adhd` → `./adhd.js` | `adhd.js` | ✓ |
| 4 | `discipline-whale/worker` | 254 | `./worker` → `./worker.js` | `worker.js` | ✓ |

包内 30 个文件，`exports` 17 条**全部**可解析、**全部**在包内（`exports missing from tarball: 0`）。

---

## 七、重启前还需人确认的清单

1. **线上 profile 当前指向旧版本**。`~/.dsh/profiles/web/package.json:9` 是
   `"discipline-whale": "file:/Users/huiyuan/.dsh/plugins/packages/discipline-whale-0.3.0.tgz"`，
   而本仓库现在是 **0.4.0**。也就是说**正在跑的 `dsh web` 装的不是这棵树**——本次所有结论描述的是「合并后 0.4.0 会怎样」，不是「线上现在怎样」。0.3.0 的包里**没有** `guard.js` / `adhd.js` / `voice*.js` / `prompt-probe.mjs` / `skills/`（实测：0.3.0 tarball 只有 18 个文件，0.4.0 有 30 个）。
2. **`scripts/install-local.sh` 会做什么**（未执行）：`npm pack` 到 `$DSH_HOME/plugins/packages/`，然后 `dsh plugin --profile web remove discipline-whale` + `add <新 tarball>`。它会覆盖 `~/.dsh/profiles/web/package.json` 的依赖指向并重装 profile。**这一步会改线上安装**，需用户明确同意。
3. **`SOCLAAS_API_KEY` 不在当前启动 shell 环境里**（本 shell 中 `SOCLAAS_API_KEY` / `SOC_API_KEY` / `NEW_API_API_KEY` 均未设置）。语音转写依赖它（`client.js` 的 `errMissingKey` 文案就是为这种情况写的）。**注意：`dsh web` 那个进程的启动环境可能与本审计 shell 不同**，需在启动 `dsh web` 的那个 shell 里确认，我没有也无法读那个进程的环境。
4. **重启后要新建主会话**：`cordis.patch.yml:140-157` 的注释与 `README.md:523` 都说明 preset 行在**会话创建时**装配，已在运行的主会话不会中途换上新的输出纪律。
5. **`dsh-session-kit` 那条 patch 的运行时效果仍未验证**：`cordis.patch.yml:49-54` 自己写明「dump-config 只证明配置正确，不证明运行中的进程丢掉了 `create_session`；重启验证没做」。本次同样只做到 dump-config，维持「config correct, not verified live」。
6. **§5.2 的重复纠正缺陷已修**（`adhd.js` 幂等 + `test/adhd.mjs` 双行装配）。重启前**不需要**再做任何改动。若线上 profile 仍是 0.3.0，该版本不含这个模块，修复只会在装到 0.4.0 之后生效。
7. **`npm pack` 用的是临时 cache**（`/tmp/npm-cache-dw`），因为 `~/.npm/_cacache` 里有 root 拥有的文件导致 EPERM。若后续要正式打包，需先 `sudo chown -R 501:20 ~/.npm`，否则 `install-local.sh` 也会撞同一个错。

---

## 八、边界声明

**本次没有重启用户正在跑的 `dsh web`；没有动 `$DSH_HOME/plugins/`（线上安装）；没有执行 `scripts/install-local.sh`。**

所有涉及真实装载的验证都在**临时 `DSH_HOME`**（`/tmp/dw-home-20wzVm`）与**临时目录**（`/tmp/dw-pack`、`/tmp/npm-cache-dw`）里完成。对 `$HOME/.dsh` 只有只读访问（`ls` / `cat` / `tar -tzf`）。

对仓库本身：**未作任何修改**。
