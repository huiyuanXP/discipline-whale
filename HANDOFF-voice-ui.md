# 交接文档：自律鲸鱼 · 语音通话条视觉重做

> 读者：接手的 Agent（能看图、能改代码）。
> 目标：把通话条外观按 ChatGPT 语音条风格重做——扁平、年轻、灵动，不要「方块套方块」。
> **这是外观任务，不是功能任务。** 语义层不许动，见第 4、5 节。

本文件是**文件**，请直接编辑它；不要把它渲染成卡片或界面。

---

## 1. 任务范围

### 要做的

把浮层通话条（voice dock）的**外观**重做成 ChatGPT 语音条那种感觉：

- **扁平**：去掉现在的卡片边框 + 大阴影 + 多层容器。目标是「一个连续的表面」，不是「一个面板里再放几个盒子」。
- **年轻、灵动**：圆角柔和、留白舒展、状态反馈轻快。动效服务于「正在听 / 正在想」，不是装饰。
- **两个平面，不嵌套**：一张卡片（状态行、识别结果、回复、小字）+ 一条控制条 `(设置) ( 静音 | 光球=话筒 | 朗读 ) (挂断)`。卡片内部不再套边框盒子。
- 所有文本、按钮、状态的**信息**必须保留（第 4、5 节列了什么不能丢），只改呈现方式。

### 参考图

> 路径：**`docs/voice-bar-reference.png`**（仓库内，接手方按路径自行打开）

接手方**自己打开图看**。文档不转述图的细节——转述会失真，而且图会更新。
图中有一点需要说明：**中间那个按钮是「全局麦克风权限」**，即麦克风的开关（申请/释放设备），不是静音，也不是挂断。

映射到本插件：胶囊正中的光球 = **话筒**（`data-dw-control="mic"`），光球左侧图标 = **静音**（`mute`），右侧喇叭 = **朗读回复**（fallback 开关）；胶囊外左侧圆钮 = 设置，右侧红色圆钮 = 挂断。

### 当前状态

重做已在 `client.js` 落地：`dockView()`（通话条）、`settingsView()`（设置：总览 + 「服务与密钥」「真实 TTS」两个二级页）、`dockStyles()`（全部样式，读宿主 `--dsw-alias-*` 主题 token，明暗自动跟随）。剩余工作是第 9 节的真机复验。

### 不做的

- 不改 `voice.js` / `voice-silence.js`（服务端转写与静音判定，与外观无关）。
- 不改挂载点、slot 名、注册 id、`order`。
- 不改任何状态语义、阈值、半双工规则、隐私提示的存在性。
- 不引入构建步骤、npm 前端依赖、CDN 外链。

---

## 2. 代码现状

所有路径相对仓库根 `/Users/huiyuan/Developer/projects/discipline-whale`。

### 渲染函数

| 位置 | 说明 |
| --- | --- |
| `client.js` `function dockView(input)` | 打开态通话条（纯函数，只读 `input`）。**外观结构的主战场。** |
| `client.js` `function settingsView(input)` | 设置面板；`input.page` 取 `main` / `service` / `tts`。 |
| `client.js` `function dockVisualState(input)` | 把 `status` 与话筒/静音合成一个视觉状态，挂成根节点的 `.dw-status-<state>`。 |
| `client.js` `function dockStyles()` | 全部 `.dw-*` 规则。`installStyles()` 把它注入页面，`copyStylesInto()` 把它复制进独立小窗。**样式改动的唯一入口。** |
| `client.js` `function makeVoiceDock(ctx, t)` | 组件本体（状态、副作用、折叠态「开始通话」）。 |
| `client.js` `strokeIcon()` 及各 `*Glyph` | 内联 SVG 图标：`MicGlyph`、`SpeakerGlyph`、`HangupGlyph`、`GearGlyph`、`DetachGlyph`、`LockGlyph`、`ChevronGlyph`、`CloseGlyph`、`VoiceGlyph`。 |

### 挂载

```
ctx.slots.inject("shell.overlay", () =>
  ctx.slots.register(
    { name: "shell.overlay", id: "discipline-whale-voice", order: VOICE_DOCK_ORDER, locale: NS },
    VoiceDock
  )
)
```

- slot：**`shell.overlay`**（框架的全宽浮层，点击穿透，条目自行 opt-in 指针事件）。
- `id` 固定 `discipline-whale-voice`；`order` 来自常量 `VOICE_DOCK_ORDER`。
- 选 `shell.overlay` 是为了**通话中切到会话页也不消失**——不要改成 `main` 或页内组件。
- `test/client.mjs` 的 `ok 5` 会断言这个注册（name / id / order），改名会红。

### `.dw-*` 类名清单

由脚本自动生成（见文末快照），这里给出分层职责：

**外观层（可自由重做）**

| 类 | 职责 |
| --- | --- |
| `.dw-dock-host` | 浮层宿主列（`pointer-events:none`，子元素接收点击）；主题 token 的 `--dw-*` 转接层也在这里 |
| `.dw-dock` / `.dw-dock-closed` | 打开态根节点（带 `.dw-status-<state>`）/ 折叠态 |
| `.dw-call-button` / `.dw-orb-mini` / `.dw-call-settings` | 折叠态「开始通话」胶囊、其中的小光球、旁边的设置圆钮 |
| `.dw-card` | 卡片平面 |
| `.dw-dock-head` / `.dw-status` / `.dw-status-text` / `.dw-dot` | 状态行 |
| `.dw-status-*` | 视觉状态：`ready`/`calibrating`/`listening`/`transcribing`/`thinking`/`speaking`/`muted`/`deviceoff`/`error`，驱动圆点与光球 |
| `.dw-busy` / `.dw-chip` | 处理中三点 / 「说完了」小胶囊 |
| `.dw-transcript` / `.dw-heard` / `.dw-bubble` / `.dw-reply` / `.dw-reply-text` / `.dw-label` | 识别结果气泡与鲸鱼回复 |
| `.dw-error` | 错误条 |
| `.dw-foot` / `.dw-fine` / `.dw-privacy` / `.dw-tts-note` | 隐私提示与朗读 fallback 小字 |
| `.dw-bar` / `.dw-pill` / `.dw-sep` / `.dw-round` / `.dw-hangup` | 控制条：胶囊、分隔线、两侧圆钮、挂断 |
| `.dw-ctl` / `.dw-ctl-mic` / `.dw-orb` / `.dw-orb-core` / `.dw-ctl-mute` / `.dw-toggle` | 话筒光球、静音、朗读 |
| `.dw-sr` | 视觉隐藏的可读名称 |
| `.dw-settings*` / `.dw-section*` / `.dw-group` / `.dw-row*` / `.dw-switch*` / `.dw-badge` / `.dw-link` / `.dw-field*` / `.dw-input` / `.dw-primary` / `.dw-secondary` | 设置面板 |

**不属于通话条（别动）**

| 类 | 职责 |
| --- | --- |
| `.dw-page` / `.dw-retry` | 侧边栏「自律鲸鱼」页的占位与重试按钮 |

动效：`dw-pulse`（状态点）、`dw-breathe` / `dw-spin` / `dw-ripple` / `dw-talk`（光球）、`dw-bounce`（处理中三点）。`@media (prefers-reduced-motion: reduce)` 一条规则关掉通话条内全部动画与过渡——这是减少动效的无障碍约定，要保留。

### 不需要动的文件

- `voice.js`：三条 HTTP 路由（status / transcribe / say）。
- `voice-silence.js`：静音判定与迟到结果守卫。
- `home.js`：挂载语音路由。外观改动不涉及。

---

## 3. 运行与约束

- **无构建步骤**。`client.js` 是纯 JS，包在 `window.__ModuleLoader__.load({ id, factory })` 里，通过 `require("react")` 从 shell 的模块表拿 React。
- **不能 `npm install` 前端库**，**不能外链 CDN**（字体、图标、动画库都不行）。图标用内联 SVG，动效用 CSS。
- React 只能用 shell 给的那几个 hook（当前用到 `useState` / `useRef` / `useEffect`）。不要假设有别的库。
- 样式注入走 `installStyles()` 里那一个 `<style>`，用 `style.dataset.dshPlugin = "discipline-whale"` 标记，返回 `() => style.remove()` 做清理。
- **不要重启用户正在跑的 `dsh web`**，**不要动 `$DSH_HOME/plugins/`**。需要真机验证时把命令写进报告，由用户执行。
- 中文注释/中文文档；源码注释保持英文（沿用仓库现状）。

---

## 4. 绝不能改坏的语义

这些是行为契约，测试盯着。改外观时**任何一条都不许动**。

### 4.1 话筒 = 麦克风权限与设备

- 申请设备：`getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })`。
- 释放：`stream.getTracks().forEach(track => track.stop())`，并关闭 `AudioContext`。
- 权限被拒要显示明确原因（`errPermission`），不能静默变灰。

### 4.2 静音 = 丢弃帧、不进 VAD、不计入断句时长

静音状态下**帧根本不进检测器**：不是「进了检测器但被忽略」，而是 `push()` 不被调用。因此静音期间 `elapsedMs` / `silenceMs` / `speechMs` 都不增长——静音时间不会把一句有效语音「撑」到 10 秒断句，也不会误触发 60 秒上限。

> 这一条的实现在并行会话 `session-f2aa6d6b` 手里（话筒/静音拆分）。你重做外观时若它已落地，**不要改它的数据流**；若还没落地，按当前代码排版即可。

### 4.3 10 秒自动断句与阈值公式

- `VOICE_CONSTANTS.silenceMs = 10000`：连续静音满 10 秒结束这句。
- 阈值**不是魔法数**：开头 500ms 采底噪，`threshold = max(minThreshold, floor * 2 + noiseMargin)`，其中 `minThreshold = 0.012`、`noiseMargin = 0.02`。
- 最短有效语音 `minSpeechMs = 500`；不足则**不上传、不发送**，回待命。
- 最短录音 `minRecordingMs = 1000`；上限 `maxRecordingMs = 60000`。
- `client.js` 里有一份 `voice-silence.js` 的**逐字镜像**（浏览器半是 plain JS，import 不了 ESM）。`test/client.mjs` 的 `ok 1` 用 900 帧合成信号逐帧比对两份实现——**改一处必须改另一处**，否则这条会红。

### 4.4 半双工

麦克风只在状态为 `listening` 时开。鲸鱼思考时不开麦；朗读期间不开麦；回复显示完再回到待命并重开麦。

### 4.5 朗读是 opt-in fallback，默认关闭，不是「已接入 TTS」

- 默认 `false`（`useState(false)` + `useRef(false)`）。
- 文案必须保持「浏览器语音合成（fallback，非真实 TTS）」这个口径：**不能**写「已接入 TTS」，**也不能**写「未接入 TTS，不会朗读」。
- 关闭时**绝不等待任何语音事件**；开启时最多等到一个有界信号（`onend` / `onerror` / 引擎抛错 / 120s 定时器兜底）。

### 4.6 隐私提示必须存在

浮层里必须能看到：音频会上传到 NUS SoCLaaS 云端转写；本地只保留本次通话的临时录音，发送后即丢弃。**可以改样式，不能删文案**（`.dw-privacy` 那条）。

---

## 5. 状态机

状态名取自真实的 `setPhase(...)` 调用（快照里有自动核对）。

| 状态 | 含义 | 视觉上必须能区分 |
| --- | --- | --- |
| `ready` | 待命，可以说话 | 常态；与「正在听」明显不同 |
| `calibrating` | 开头 500ms 采环境底噪 | 与 `listening` 区分（「正在听环境噪音」） |
| `listening` | 正在听，静音满 10 秒自动发送 | **必须有进行感**（当前是红点脉冲） |
| `transcribing` | 音频上传、等待识别 | 处理中，非进行中 |
| `thinking` | 已送进主会话，等鲸鱼回复 | 处理中 |
| `speaking` | 正在朗读（仅朗读开启时出现） | 与 `thinking` 区分 |
| `error` | 出错，`error` 字段给出具体原因 | 必须显著，且带可读原因 |

补充规则：

- **状态文案来自字典**：`statusReady` / `statusCalibrating` / `statusListening` / `statusTranscribing` / `statusThinking` / `statusSpeaking` / `statusError`（中英各一套）。改外观不要改 key 名。
- `busy` 派生自 `transcribing` / `thinking` / `speaking`，用于显示处理中指示。
- **视觉状态**由 `dockVisualState()` 决定：`error`（带原因）> `deviceoff`（话筒关）> `muted`（静音）> `status`。它挂在 `.dw-dock` 根节点上，状态点与光球都只读它。
- 光球的状态语言：`ready` 慢呼吸；`calibrating` 中速呼吸 + 淡光晕；`listening` 快呼吸 + 旋转光晕 + 外扩波纹；`transcribing`/`thinking` 缩小 + 快速旋转光晕；`speaking` 紫色律动；`muted` 褪色；`deviceoff` 灰色并显示斜杠话筒；`error` 红色。
- **折叠态**（`!open`）只渲染 `.dw-call-button`（开始通话 + 设置），不放状态信息。
- 动效必须尊重 `prefers-reduced-motion`。

---

## 6. 必须保留的东西（最重要）

> **如果你整体重写 UI，下面四个符号必须活下来。** 它们不在渲染函数里，删掉渲染代码时很容易一起被删——那样朗读 fallback 和它的测试会一起消失。

| 符号 | 位置 | 为什么不能删 |
| --- | --- | --- |
| `speakReply(text, env)` | `client.js` 模块作用域 | 朗读 fallback 的执行体。已是**依赖注入**形式（`env` 传 `synth` / `Utterance` / `setTimeout`），所以能脱离浏览器测试。四路必 settle，**不 reject**。 |
| `speakable(text)` | `client.js` 模块作用域 | markdown → 可朗读文本（去代码块、去标记）。 |
| `speechLanguage()` | `client.js` 模块作用域 | 朗读用的 BCP-47 标签（`zh-CN` / `en-US`）。`uiLanguage()` 从它派生 `zh`/`en` 给转写用。 |
| `speakNote` | `client.js` `DICTIONARIES` 的 zh 与 en | 「浏览器语音合成（fallback，非真实 TTS）」文案。`test/client.mjs` 的 `ok 3` 会校验它含 fallback 措辞、含「非真实 TTS」、说明默认关闭，且**不得**声称「已接入 TTS」。 |

另外这些也通过 `module.exports` 暴露给测试，重写时不要丢：
`DICTIONARIES`、`VOICE_CONSTANTS`、`createSilenceDetector`、`createCallGuard`、`baselineTurnOf`、`replyTextOf`、`speakable`、`speakReply`、`speechLanguage`、`makeVoiceDock`、`createSessionWatcher`、`resolveMainSession`、`isLive`。

> 依赖注入那一步是刻意的：它让「引擎永不触发 `onend` 时，超时兜底仍能 settle」变成可执行断言（`ok 3a`），而不是靠读代码相信。

---

## 7. 当前改动状态与冲突风险

**这一节请务必在动手前读完。**

### 多个并行会话在改同一棵树

`client.js` 是热点文件，当前至少有这些并行工作：

| 会话 | 在做什么 | 影响 |
| --- | --- | --- |
| `session-f2aa6d6b` | **设置界面**（API Key / Base URL 可配置）、**通话窗独立化（PiP / 独立窗口）**、**话筒与静音拆成两个独立控件**、桌面宠物调研 | 已落地到 `client.js`（`createCallControls` / `createFrameGate` / `detachCapability` / `snapDockPosition` / 设置路由）；外观重做在其之上完成 |
| 本会话（语音能力） | 转写、静音判定、朗读 fallback、交接文档 | 已把 `speakReply`/`speakable`/`speechLanguage` 提到模块作用域 |

快照里有一个「并行会话指纹」：若检测到 `apiKey` / `baseUrl` / `pictureInPicture` / `settings` / `mute` 等关键字，说明对方已经开始落笔。**为「暂无」不代表安全，只代表还没写。**

### 动手前的强制步骤

1. **先读当前文件内容**（`read client.js`），不要读记忆里的版本，也不要信任本文档第 2 节的描述——它可能已经过时。
2. **做最小 diff**：只改你要改的那几行/那几块。
3. **禁止整文件重排**（不要重排缩进、不要重排函数顺序、不要把整个文件格式化）。
4. **禁止 `git checkout -- client.js`** 或任何整文件级回滚——那会冲掉别人的编辑。
5. 改完 `grep` 一遍对方的关键字，确认还在；并在报告里说明你改了哪几处、行号多少。

### 冲突规约

> **若发现同一处已被别人改过，基于最新内容重做你的小改动，不要回退别人的编辑。**

具体做法：重新 `read` 那一段 → 把你的意图**重新表达**在最新内容上 → 保存。如果对方的版本已经实现了你要做的事，就不要重复实现；如果对方的版本与你的意图冲突，在报告里写清楚冲突点，让对方或用户裁决，**不要单方面覆盖**。

### 合并提示

`speakReply` / `speakable` / `speechLanguage` 是**模块级函数**，与渲染结构解耦；`speakNote` 在字典里。如果对方重写了整个通话条，通常只需保证这四个符号仍在（以及字典 key 不变），朗读 fallback 就能继续工作。

---

## 8. 测试基线

改外观必须保持全部套件全绿。当前项数与运行方式见文末快照（自动生成），命令：

```bash
npm test              # contract
npm run test:guard    # guard
npm run test:voice    # voice
npm run test:client   # client
npm run test:dock     # dock：话筒/静音、窗口、拖动、设置面板视图、样式接缝
npm run test:settings # settings：语音设置路由与密钥
npm run test:adhd     # adhd：输出纪律
npm run test:smoke    # smoke
npm run test:all      # contract + guard + adhd + voice + client + dock + settings
```

### 改外观时哪些断言可能要跟着调

| 断言 | 何时需要改 | 怎么改 |
| --- | --- | --- |
| `client.mjs` **ok 5** | 改 slot 名 / `id` / `order` | **不该改**——这几项是契约，不是外观。 |
| `client.mjs` **ok 6** | 改结构导致渲染树变了 | 它用受控 hook 值渲染并遍历文本节点，断言「状态 / 识别结果 / 回复 / 挂断 / 隐私 / 朗读开关可见」，并按 `data-dw-control` 名称取话筒与静音两个按钮。**保留这些可见性断言**，只调整取文本的方式。 |
| `dock.mjs` **ok 10** | 改设置面板结构 | 用 `page: "tts"` 渲染二级页断言四个禁用占位；另断言总览里有「真实 TTS · 未接入」入口且点击导航到 `tts`。 |
| `client.mjs` **ok 3** | 改字典文案 | 必须保留 fallback 口径的四条正则与「不得声称已接入 TTS」。 |
| `client.mjs` **ok 1** | 改检测器 | **不该改**——两份实现必须逐帧一致。 |
| `client.mjs` **ok 3a** | 改回复完成路径 | 必须保留两条：关闭不 await；开启有超时兜底（行为测试，用假引擎）。 |

**不允许**为了让测试过而删掉语义断言。只允许调整「怎么取到那段文本/那个节点」。

> 注意 `ok 6` 用 `useState` 的调用顺序注入受控值（`[open, status, error, heard, reply, speak, utteranceCount, supported, controls, detach, detached]`）。新增的 `useState` 一律加在组件状态列表的**末尾**（`settingsPage` 就在最后），前 11 个的顺序保持不变。

---

## 9. 未验证项（必须真机）

以下只能在**真浏览器 + 真麦克风 + 重启 `dsh web`** 之后确认。外观重做后请重点复验前三条。

| # | 事项 | 验证步骤 |
| --- | --- | --- |
| 1 | `getUserMedia` 授权与三个 audio 约束被接受 | 点开始通话，允许麦克风，console 无 `OverconstrainedError` |
| 2 | 真实房间的 10 秒静音确实在 ~10s 结束 | 说一句后完全不出声，秒表确认 ~10s 进入「识别中」；再在开风扇的房间重复 |
| 3 | 麦克风指示灯：思考/朗读时熄灭，回待命后重亮 | 看 macOS 菜单栏橙色指示点 |
| 4 | 浮层布局在真实主题下不挡操作、不被裁切 | 会话页与插件页来回切，确认通话条一直可见可点。隔离实例（800×600）已确认：会话页底部输入框与发送按钮不被遮挡；新会话空白页居中的输入框会被**打开的**通话条压住右半部分，属已知取舍（README「已知限制」），拖开即可 |
| 5 | 窄窗（≤768px）不遮住输入框 | 隔离实例 375×812 已确认：会话页不遮挡；新会话空白页同第 4 条的取舍。真机拉窄窗口再复验一次 |
| 6 | 朗读 fallback 真的出声（默认关闭，需手动打开） | 打开开关再问一句；系统无中文声音时应失败但不卡通话 |
| 7 | 挂断 / 切会话 / 隐藏页面确实停麦 | 三种情况分别看指示灯熄灭 |
| 8 | SoCLaaS 真机延迟可接受 | 从「识别中」到「鲸鱼思考中」的耗时 |

---

## 10. 如何更新这份文档

这份文档有两种内容，更新方式不同。

### 机械更新的部分（有脚本）

文末 `<!-- SNAPSHOT:BEGIN -->` 与 `<!-- SNAPSHOT:END -->` 之间的一切，由脚本生成，**不要手改**：

- 关键文件修改时间
- 各测试套件的用例数、通过状态、耗时
- `.dw-*` 类名清单（定义 vs 使用）
- 通话状态名
- 「必须保留的符号」是否存在
- 并行会话指纹
- `git diff --stat` 与改动文件数

刷新：

```bash
node scripts/handoff-snapshot.mjs           # 就地更新
node scripts/handoff-snapshot.mjs --check    # 只检查是否过期（过期 exit 1）
node scripts/handoff-snapshot.mjs --print    # 打印，不改文件
```

把 `--check` 接进 CI 或 pre-commit，就能在快照过期时提醒。

### 需要人工判断的部分

以下**不能**自动生成，改动相关代码时由改动者手动更新：

| 小节 | 何时更新 |
| --- | --- |
| §1 任务范围 | 目标或参考图路径变化时 |
| §2 代码现状（函数职责、挂载点说明） | 渲染函数改名、挂载方式变化时 |
| §4 语义契约 | 任何行为改动**都先改这里**——这些是别人依赖的约定 |
| §5 状态机表 | 增删状态、或某状态的视觉要求变化时 |
| §6 必须保留的符号（文字说明部分） | 后备能力增减时（校验本身是自动的） |
| §7 冲突风险 | **每次有新的并行会话加入，或对方工作落地时**——这是最容易过时的一节 |
| §9 未验证项 | 某项被真机验证后，把它移出该表并注明日期 |

> 脚本故意**不**去推断语义、冲突或未验证项。一个会猜的生成器比没有生成器更糟：它会把过时的判断包装成「最新事实」。机械事实交给脚本，判断留给人。

---

## 附：常用核对命令

```bash
# 通话条相关符号是否还在
grep -n "function speakReply\|function speakable\|function speechLanguage\|speakNote" client.js

# 挂载点
grep -n "shell.overlay\|discipline-whale-voice" client.js

# 状态名
grep -o 'setPhase("[a-z]*")' client.js | sort -u

# 类名
grep -o 'className: "[^"]*"' client.js | sort -u

# 阈值常量（两份实现都要看）
grep -n "silenceMs\|minThreshold\|noiseMargin" client.js voice-silence.js
```

---

<!-- SNAPSHOT:BEGIN (generated by scripts/handoff-snapshot.mjs — do not edit by hand) -->

### 快照：仓库实际状态

> 生成于 2026-10-21T10:29:48.913Z（本机时间 2026/10/21 18:29:48）。
> 本节由 `node scripts/handoff-snapshot.mjs` 重新生成；标记区间之外的内容需人工维护。

**关键文件**

| 文件 | 修改时间 | 距今 |
| --- | --- | --- |
| `client.js` | 2026-10-21T10:20:25.176Z | 9 分钟前 |
| `voice.js` | 2026-10-20T19:08:26.227Z | 15 小时前 |
| `voice-silence.js` | 2026-10-20T19:10:00.285Z | 15 小时前 |

**测试基线**（必须是全绿；改外观后项数可能变，语义断言不应减少）

| 套件 | 命令 | 用例数 | 状态 | 耗时 |
| --- | --- | --- | --- | --- |
| contract | `npm test` | 28 | ✅ 通过 | 567 ms |
| guard | `npm run test:guard` | 10 | ✅ 通过 | 59 ms |
| voice | `npm run test:voice` | 16 | ✅ 通过 | 124 ms |
| client | `npm run test:client` | 9 | ✅ 通过 | 34 ms |
| dock | `npm run test:dock` | 11 | ✅ 通过 | 30 ms |
| settings | `npm run test:settings` | 10 | ✅ 通过 | 89 ms |
| adhd | `npm run test:adhd` | 16 | ✅ 通过 | 49 ms |
| smoke | `npm run test:smoke` | —（脚本式，无逐条用例） | ✅ 通过 | 33 ms |

合计 **100** 项用例（smoke 不计条数）。整体：**全绿**。

**通话条样式类（`.dw-*`）清单**

| 源码里定义的类 | 渲染时用到的类 |
| --- | --- |
| `.dw-page`、`.dw-retry`、`.dw-dock-host`、`.dw-drag-handle`、`.dw-dock-closed`、`.dw-sr`、`.dw-input`、`.dw-icon-button`、`.dw-dot`、`.dw-busy`、`.dw-chip`、`.dw-call-button`、`.dw-orb-mini`、`.dw-round`、`.dw-pill`、`.dw-ctl-mute`、`.dw-toggle`、`.dw-orb`、`.dw-orb-core`、`.dw-switch`、`.dw-switch-thumb`、`.dw-badge`、`.dw-primary`、`.dw-secondary`、`.dw-error`、`.dw-dock`、`.dw-call-settings`、`.dw-card`、`.dw-dock-head`、`.dw-status`、`.dw-status-text`、`.dw-status-ready`、`.dw-status-listening`、`.dw-status-calibrating`、`.dw-status-transcribing`、`.dw-status-thinking`、`.dw-status-speaking`、`.dw-status-muted`、`.dw-status-deviceoff`、`.dw-status-error`、`.dw-transcript`、`.dw-label`、`.dw-heard`、`.dw-bubble`、`.dw-reply`、`.dw-reply-text`、`.dw-foot`、`.dw-fine`、`.dw-tts-note`、`.dw-privacy`、`.dw-bar`、`.dw-ctl`、`.dw-hangup`、`.dw-sep`、`.dw-ctl-mic`、`.dw-settings`、`.dw-settings-head`、`.dw-settings-title`、`.dw-settings-body`、`.dw-section`、`.dw-section-title`、`.dw-group`、`.dw-row`、`.dw-row-plain`、`.dw-row-nav`、`.dw-row-text`、`.dw-row-title`、`.dw-row-sub`、`.dw-row-value`、`.dw-source`、`.dw-link`、`.dw-row-danger`、`.dw-field`、`.dw-field-label`、`.dw-field-hint`、`.dw-settings-actions`、`.dw-saved`、`.dw-test`、`.dw-settings-note`、`.dw-tts-block`、`.dw-detached` | `dw-retry`、`dw-page`、`dw-ctl`、`dw-ctl-mic`、`dw-orb`、`dw-orb-core`、`dw-sr`、`dw-ctl-mute`、`dw-card`、`dw-dock-head`、`dw-status`、`dw-dot`、`dw-status-text`、`dw-busy`、`dw-chip`、`dw-icon-button`、`dw-error`、`dw-transcript`、`dw-heard`、`dw-label`、`dw-bubble`、`dw-reply`、`dw-reply-text`、`dw-foot`、`dw-fine`、`dw-privacy`、`dw-tts-note`、`dw-bar`、`dw-round`、`dw-pill`、`dw-sep`、`dw-toggle`、`dw-hangup`、`dw-dock`、`dw-switch`、`dw-switch-thumb`、`dw-field`、`dw-field-label`、`dw-field-hint`、`dw-section`、`dw-section-title`、`dw-group`、`dw-row`、`dw-row-nav`、`dw-row-title`、`dw-test`、`dw-input`、`dw-row-plain`、`dw-row-danger`、`dw-row-text`、`dw-row-sub`、`dw-settings-actions`、`dw-primary`、`dw-saved`、`dw-settings-note`、`dw-tts-block`、`dw-source`、`dw-row-value`、`dw-badge`、`dw-settings`、`dw-settings-head`、`dw-settings-title`、`dw-settings-body`、`dw-dock-closed`、`dw-call-button`、`dw-orb-mini`、`dw-call-settings`、`dw-dock-host`、`dw-drag-handle` |

共定义 **81** 个、渲染使用 **69** 个。
所有被渲染的类都有样式定义。

**通话状态名**（来自真实的 `setPhase(...)` 调用）

`calibrating`、`error`、`listening`、`ready`、`speaking`、`thinking`、`transcribing`

**必须保留的符号（自动核对）**

| 符号 | 存在 | 作用 |
| --- | --- | --- |
| `speakReply` | ✅ | 朗读 fallback 的执行体 |
| `speakable` | ✅ | markdown → 可朗读文本 |
| `speechLanguage` | ✅ | 朗读语言的 BCP-47 标签 |
| `speakNote` | ✅ | 「浏览器语音合成（fallback，非真实 TTS）」文案 |

**并行会话指纹**（另一个会话正在改 `client.js`）

检测到的对方关键字：`apiKey`、`baseUrl`、`settings`、`mute`

**改动文件清单**

已修改 8 个、未跟踪 17 个。

```
README.md         |  385 +++++++-
 VERIFICATION.md   | 1273 ++++++++++++++++++++++++++-
 client.js         | 2514 ++++++++++++++++++++++++++++++++++++++++++++++++++++-
 cordis.patch.yml  |   78 +-
 home.js           |   24 +-
 main.js           |  291 ++++++-
 package.json      |   28 +-
 test/contract.mjs |  648 +++++++++++++-
 8 files changed, 5177 insertions(+), 64 deletions(-)
```

<!-- SNAPSHOT:END -->
