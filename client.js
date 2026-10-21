// discipline-whale, browser half: the whale's own entry in the Web sidebar.
//
// The entry sits in the sidebar's panel list, directly above Context Insights.
// Selecting it opens the whale's main session in the normal conversation view.
// The main session runs in the whale's home ($DSH_HOME/discipline-whale/home),
// a private working directory that is never registered as a workspace. The
// host row records the main session and serves it on
// /api/discipline-whale/home; when the recorded session is gone, a POST there
// makes the host create, wake and record a new one.
//
// The same package also ships a voice call (the dock in `shell.overlay`): press
// Call, speak, and the recording ends itself after ten seconds of silence, is
// transcribed, and queued into the main session. The whale's reply is shown as
// text; reading it aloud is an OPT-IN FALLBACK that uses the browser/OS speech
// synthesizer and is off by default — it is not an integrated TTS channel, and
// the dock says so rather than implying otherwise. The audio goes to the NUS
// SoCLaaS cloud transcriber, which is why the dock states that in its own copy
// and in the README.
//
// Plain JS in dsh's module wrapper, so the package needs no build step: React
// comes from the shell's module table.
window.__ModuleLoader__.load({
  id: "discipline-whale",
  factory: (require) => {
    var module = { exports: {} };
    const React = require("react");
    const h = React.createElement;
    // `react-dom` is in the shell's module table. The dock only needs
    // `createPortal`, and only when it is moved into a detached window; a
    // composition without react-dom keeps the in-page dock instead of failing.
    let createPortal = null;
    try {
      const reactDom = require("react-dom");
      if (reactDom !== null && typeof reactDom.createPortal === "function") createPortal = reactDom.createPortal;
    } catch (_error) {
      createPortal = null;
    }

    const PANEL_ID = "discipline-whale";
    const NS = "discipline-whale";
    const HOME_ROUTE = "/api/discipline-whale/home";
    const VOICE_STATUS_ROUTE = "/api/discipline-whale/voice/status";
    const VOICE_ROUTE = "/api/discipline-whale/voice/transcribe";
    const VOICE_SAY_ROUTE = "/api/discipline-whale/voice/say";
    const VOICE_SETTINGS_ROUTE = "/api/discipline-whale/voice/settings";
    const VOICE_TEST_ROUTE = "/api/discipline-whale/voice/test";
    // Built-in panels: Plugins 0, Automations 10, Context Insights 20.
    const PANEL_ORDER = 15;
    // The dock is an overlay, so it keeps working while the whale's conversation
    // is on screen; a higher order puts it above the shipped overlays.
    const VOICE_DOCK_ORDER = 40;

    // Where the page loads its speech detector from: this plugin's own routes
    // (voice-assets.js), never a CDN.
    const VOICE_ASSET_ROUTE = "/api/discipline-whale/voice/vad";

    // One place for the call's turn rules, mirrored verbatim from
    // voice-silence.js; `test/client.mjs` proves the copies match.
    const VOICE_CONSTANTS = {
      // Silero VAD turn-taking for vad-web's MicVAD (TURN_OPTIONS).
      turn: {
        model: "v5",
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        redemptionMs: 2000,
        preSpeechPadMs: 500,
        minSpeechMs: 500,
      },
      // The pauses the settings offer for "the turn is over".
      redemptionChoicesMs: [1000, 2000, 3000, 5000, 8000],
      // Speech that never pauses is cut and sent here.
      maxSpeechMs: 60000,
      // Quieter than this was not said into this microphone.
      minSpeechLevelDbfs: -45,
      // Away rules: listening this long without an accepted turn, or this many
      // utterances in a row refused as background sound, closes the microphone.
      awayIdleMs: 120000,
      awayMaxRejections: 3,
      // How long to wait for the whale's turn to settle before giving up.
      replyTimeoutMs: 180000,
      // Turn polling cadence; a real turn-end event is not available here.
      pollMs: 700,
    };

    const DICTIONARIES = {
      zh: {
        panel: "自律鲸鱼",
        opening: "正在打开自律鲸鱼主会话…",
        failed: "打开主会话失败：{reason}",
        retry: "重试",
        callTitle: "语音对话",
        callStart: "开始通话",
        callHangup: "挂断",
        callStop: "说完了",
        callMinimise: "收起",
        callExpand: "展开",
        callClose: "关闭",
        statusReady: "待命 · 可以直接说话",
        statusCalibrating: "正在准备收音…",
        statusListening: "正在听 · 说完停顿一下就发送",
        statusTranscribing: "识别中…",
        statusThinking: "鲸鱼思考中…",
        statusSpeaking: "朗读中…",
        statusError: "出错",
        statusSent: "已发送，等鲸鱼回复",
        speakOn: "朗读回复：开",
        speakOff: "朗读回复：关（默认）",
        speakHint: "用浏览器语音合成朗读回复",
        speakNote: "朗读用浏览器语音合成（fallback，非真实 TTS），声音取决于设备，默认关闭。",
        heard: "识别结果",
        reply: "鲸鱼回复",
        privacy: "音频会上传到 NUS SoCLaaS 云端转写；本地只保留本次通话的临时录音，发送后即丢弃。",
        privacyShort: "音频会上传到 NUS SoCLaaS 云端转写",
        errPermission: "麦克风权限被拒绝，请在浏览器地址栏允许后重试。",
        errUnsupported: "这个浏览器不支持录音或 Web Audio。",
        errMissingKey: "服务端没有配置 SOCLAAS_API_KEY，语音识别不可用。",
        errInvalidKey: "SoCLaaS 拒绝了当前的 key（无效或过期）。",
        errNoModel: "SoCLaaS 上没有 whisper-large-v3 这个模型。",
        errUnreachable: "连不上 SoCLaaS，请检查网络。",
        errTimeout: "转写超时，请再说一次。",
        errTooLarge: "录音太大或太长，已拒绝上传。",
        errEmptyTranscript: "没有识别出内容，请再说一次。",
        errNoMainSession: "还没有主会话，请先从侧边栏打开自律鲸鱼。",
        errNoSpeech: "没听到有效语音，未发送。",
        errReplyTimeout: "等鲸鱼回复超时，可以到会话里查看。",
        errVadLoad: "语音检测组件没能加载，请确认插件安装完整后重试。",
        noticeRejected: "这段听起来是背景声，没有发送。",
        noticeTooQuiet: "声音离麦克风太远，没有发送。",
        noticeAwayIdle: "2 分钟没有发出新消息，已关闭话筒。点话筒继续。",
        noticeAwayRejected: "连续几段都像背景声，已关闭话筒。点话筒继续。",
        noticeHidden: "页面切到了后台，已关闭话筒。点话筒继续。",
        micOn: "话筒：开",
        micOff: "话筒：关",
        micHintOn: "点击关闭话筒并释放麦克风设备",
        micHintOff: "点击打开话筒（会请求麦克风权限）",
        muteOn: "静音：开",
        muteOff: "静音：关",
        muteHintOn: "点击解除静音，恢复处理音频",
        muteHintOff: "点击静音：麦克风仍在，但不处理任何音频帧",
        muteNeedsMic: "话筒关闭时不需要静音：现在没有任何音频被处理",
        statusMuted: "已静音 · 设备在跑，但不处理音频",
        statusDeviceOff: "话筒已关 · 没有音频被处理",
        detach: "独立窗口",
        detachPip: "独立窗口（画中画，置顶）",
        detachPopup: "独立窗口（弹窗）",
        detachNone: "当前浏览器不支持独立窗口，通话条留在页面内",
        detachHint: "把通话条放进一个独立的置顶小窗；切换页面或会话都不会中断通话。浏览器最小化时小窗会随之隐藏——普通网页无法画在浏览器之外。",
        detachFailed: "无法打开独立窗口（可能被浏览器拦截或缺少用户手势）。通话条仍在页面内，通话未中断。",
        detachReturn: "收回窗口",
        dockedHintCall: "点按开关话筒；拖离边缘展开",
        dockedHintIdle: "点按开始通话；拖离边缘展开",
        resizeHint: "拖动调整大小",
        settingsOpen: "语音设置",
        settingsBack: "返回",
        settingsSectionCall: "通话",
        settingsSectionAsr: "语音识别",
        settingsSectionTts: "朗读引擎",
        settingsSpeakLabel: "朗读回复",
        settingsRedemption: "说完后停顿多久发送",
        settingsRedemptionHint: "越短回应越快；越长越不会把思考时的停顿当成说完。",
        settingsSeconds: "{n} 秒",
        settingsService: "服务与密钥",
        settingsTtsEntry: "真实 TTS",
        settingsLanguageAuto: "跟随界面",
        settingsIntro: "这些设置只影响本插件的语音转写。密钥保存在服务端，浏览器只会知道「有没有配」和「从哪来」，不会拿回密钥本身。",
        settingsBaseUrl: "Base URL",
        settingsBaseUrlHint: "OpenAI 兼容的 /v1 根地址，留空则用默认值。",
        settingsApiKey: "API Key",
        settingsApiKeyHint: "留空表示保持当前的 key。",
        settingsApiKeyClear: "清除已保存的 key",
        settingsApiKeyClearHint: "保存时删除这里存的 key，之后改用环境变量里的 key。",
        settingsModel: "转写模型",
        settingsLanguage: "语言",
        settingsLanguageHint: "留空则使用界面语言（zh / en）。",
        settingsSave: "保存",
        settingsSaving: "保存中…",
        settingsSaved: "已保存",
        settingsTest: "测试连接",
        settingsTesting: "测试中…",
        settingsKeySource: "key 来源：{source}",
        settingsKeySourceSettings: "设置界面（已保存）",
        settingsKeySourceEnv: "环境变量 {env}",
        settingsKeySourceNone: "尚未配置",
        settingsKeyMissing: "还没有可用的 key：在「服务与密钥」里保存一个，或在启动 dsh web 的 shell 里设置 {env}。",
        settingsTtsTitle: "真实 TTS（未接入）",
        settingsTtsNote: "当前只有浏览器内置语音合成作为 fallback（通话条上的「朗读回复」，默认关闭）；它没有独立凭据、音色与配额，声音取决于设备。真实 TTS（如 MiniMax）尚未接入，需要单独一把 key——下面四个字段留作将来，现在不可编辑。",
        settingsTtsModel: "真实 TTS 模型（未接入，留作将来）",
        settingsTtsVoice: "真实 TTS 音色（未接入，留作将来）",
        settingsTtsBaseUrl: "真实 TTS Base URL（未接入，留作将来）",
        settingsTtsApiKey: "真实 TTS API Key（未接入，留作将来）",
        settingsTtsKeyHint: "真实 TTS 需要它自己的那把 key，与「服务与密钥」里的转写 key 不是同一个。",
        settingsNotIntegrated: "未接入",
        settingsClose: "关闭设置",
        testOk: "连接成功：{message}",
        testFailed: "连接失败：{message}",
        testInvalidKey: "key 被拒绝",
        testUnreachable: "连不上",
        testTimeout: "超时",
        testNotFound: "路径可能不对",
        settingsSavedNoKey: "已保存，但还没有配置 key。",
        settingsRestartHint: "保存后立即生效，下一次录音就会用新配置，不需要重启。",
      },
      en: {
        panel: "Discipline Whale",
        opening: "Opening the Discipline Whale main session…",
        failed: "Could not open the main session: {reason}",
        retry: "Retry",
        callTitle: "Voice call",
        callStart: "Start call",
        callHangup: "Hang up",
        callStop: "Done talking",
        callMinimise: "Collapse",
        callExpand: "Expand",
        callClose: "Close",
        statusReady: "Ready · just talk",
        statusCalibrating: "Getting the microphone ready…",
        statusListening: "Listening · pause when you're done",
        statusTranscribing: "Transcribing…",
        statusThinking: "The whale is thinking…",
        statusSpeaking: "Speaking…",
        statusError: "Error",
        statusSent: "Sent; waiting for the reply",
        speakOn: "Read replies: on",
        speakOff: "Read replies: off (default)",
        speakHint: "Read the reply with the browser's speech synthesizer",
        speakNote: "Read-aloud uses the browser's speech synthesis (fallback, not a real TTS); the voice depends on the device. Off by default.",
        heard: "Heard",
        reply: "Reply",
        privacy: "Audio is uploaded to the NUS SoCLaaS cloud transcriber. Locally only this call's temporary recording is kept, and dropped once sent.",
        privacyShort: "Audio goes to the NUS SoCLaaS cloud transcriber",
        errPermission: "Microphone permission was refused. Allow it in the address bar and retry.",
        errUnsupported: "This browser has no recording or Web Audio support.",
        errMissingKey: "The host has no SOCLAAS_API_KEY, so transcription is unavailable.",
        errInvalidKey: "SoCLaaS rejected the configured key (invalid or expired).",
        errNoModel: "SoCLaaS does not serve whisper-large-v3.",
        errUnreachable: "Could not reach SoCLaaS. Check the network.",
        errTimeout: "Transcription timed out; please say it again.",
        errTooLarge: "The recording is too large or too long, so it was not uploaded.",
        errEmptyTranscript: "Nothing recognizable was said; please retry.",
        errNoMainSession: "There is no main session yet; open the whale from the sidebar first.",
        errNoSpeech: "No usable speech was heard, so nothing was sent.",
        errReplyTimeout: "The reply took too long; open the conversation to check.",
        errVadLoad: "The speech detector failed to load; check the plugin installation and retry.",
        noticeRejected: "That sounded like background sound, so nothing was sent.",
        noticeTooQuiet: "That was too far from the microphone, so nothing was sent.",
        noticeAwayIdle: "No message for 2 minutes, so the microphone is off. Tap it to continue.",
        noticeAwayRejected: "Several clips in a row sounded like background sound, so the microphone is off. Tap it to continue.",
        noticeHidden: "The page went to the background, so the microphone is off. Tap it to continue.",
        micOn: "Microphone: on",
        micOff: "Microphone: off",
        micHintOn: "Click to close the microphone and release the device",
        micHintOff: "Click to open the microphone (asks for permission)",
        muteOn: "Muted: on",
        muteOff: "Muted: off",
        muteHintOn: "Click to unmute and resume processing audio",
        muteHintOff: "Click to mute: the microphone stays open but no audio frame is processed",
        muteNeedsMic: "Mute is unnecessary while the microphone is off: nothing is being processed",
        statusMuted: "Muted · device running, no audio processed",
        statusDeviceOff: "Microphone off · no audio processed",
        detach: "Detach",
        detachPip: "Detach window (picture-in-picture, always on top)",
        detachPopup: "Detach window (popup)",
        detachNone: "This browser has no detached window; the dock stays in the page",
        detachHint: "Move the dock into a separate always-on-top window; switching pages or sessions never interrupts the call. Minimizing the browser hides that window too — a web page cannot draw outside the browser.",
        detachFailed: "Could not open the detached window (blocked, or no user gesture). The dock stays in the page and the call continues.",
        detachReturn: "Bring it back",
        dockedHintCall: "Tap to switch the microphone; drag away from the edge to open",
        dockedHintIdle: "Tap to start a call; drag away from the edge to open",
        resizeHint: "Drag to resize",
        settingsOpen: "Voice settings",
        settingsBack: "Back",
        settingsSectionCall: "Call",
        settingsSectionAsr: "Transcription",
        settingsSectionTts: "Read-aloud engine",
        settingsSpeakLabel: "Read replies aloud",
        settingsRedemption: "Pause that ends your turn",
        settingsRedemptionHint: "Shorter answers faster; longer keeps a thinking pause from ending your turn.",
        settingsSeconds: "{n} s",
        settingsService: "Service and key",
        settingsTtsEntry: "Real TTS",
        settingsLanguageAuto: "Follow the UI",
        settingsIntro: "These settings only affect this plugin's transcription. The key is stored on the host: the browser learns whether one is configured and where it comes from, never the value.",
        settingsBaseUrl: "Base URL",
        settingsBaseUrlHint: "OpenAI-compatible /v1 root; leave empty for the default.",
        settingsApiKey: "API key",
        settingsApiKeyHint: "Leave empty to keep the current key.",
        settingsApiKeyClear: "Clear the saved key",
        settingsApiKeyClearHint: "On save, erase the key stored here and fall back to the environment variable.",
        settingsModel: "Transcription model",
        settingsLanguage: "Language",
        settingsLanguageHint: "Empty uses the UI language (zh / en).",
        settingsSave: "Save",
        settingsSaving: "Saving…",
        settingsSaved: "Saved",
        settingsTest: "Test connection",
        settingsTesting: "Testing…",
        settingsKeySource: "Key source: {source}",
        settingsKeySourceSettings: "settings (saved)",
        settingsKeySourceEnv: "environment variable {env}",
        settingsKeySourceNone: "not configured",
        settingsKeyMissing: "No usable key yet: save one under \"Service and key\", or set {env} in the shell that starts dsh web.",
        settingsTtsTitle: "Real TTS (not integrated)",
        settingsTtsNote: "Today the only read-aloud is the browser's built-in speech synthesis, as a fallback (the dock's \"Read replies\" toggle, off by default); it has no separate credentials, voices or quota, and the voice depends on the device. A real TTS (MiniMax and the like) is not integrated and needs its own separate key — the fields below are placeholders kept for later and are not editable yet.",
        settingsTtsModel: "Real TTS model (not integrated, placeholder)",
        settingsTtsVoice: "Real TTS voice (not integrated, placeholder)",
        settingsTtsBaseUrl: "Real TTS base URL (not integrated, placeholder)",
        settingsTtsApiKey: "Real TTS API key (not integrated, placeholder)",
        settingsTtsKeyHint: "A real TTS needs its own key, separate from the transcription key under \"Service and key\".",
        settingsNotIntegrated: "not integrated",
        settingsClose: "Close settings",
        testOk: "Connected: {message}",
        testFailed: "Connection failed: {message}",
        testInvalidKey: "the key was rejected",
        testUnreachable: "unreachable",
        testTimeout: "timed out",
        testNotFound: "the path may be wrong",
        settingsSavedNoKey: "Saved, but no API key is configured yet.",
        settingsRestartHint: "Changes apply immediately: the next recording uses the new settings, no restart needed.",
      },
    };

    // ---- the home and its main session ------------------------------------

    async function homeRoute(method, fetchImpl) {
      const request = typeof fetchImpl === "function" ? fetchImpl : fetch;
      const response = await request(HOME_ROUTE, { method, cache: "no-store" });
      if (!response.ok) throw new Error(`${HOME_ROUTE} answered HTTP ${response.status}`);
      return response.json();
    }

    // isLive says whether a recorded main session can still be opened: it must
    // not be archived, and once the session list has loaded it must be listed.
    function isLive(sessionId, sessionSnapshot, workspaceSnapshot) {
      if (typeof sessionId !== "string" || sessionId === "") return false;
      const archived = Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [];
      if (archived.includes(sessionId)) return false;
      const ids = Array.isArray(sessionSnapshot?.ids) ? sessionSnapshot.ids : [];
      return ids.length === 0 || sessionSnapshot.byId?.[sessionId] !== undefined;
    }

    // One open at a time: a remount or a second click joins the running one.
    let opening = null;
    function openMainSession(ctx) {
      if (opening === null) {
        opening = openOrCreate(ctx).finally(() => {
          opening = null;
        });
      }
      return opening;
    }

    async function openOrCreate(ctx) {
      const mainSessionId = await resolveMainSession({ fetch, sessions: ctx.sessions, workspaces: ctx.workspaces });
      if (mainSessionId === null) throw new Error("the host recorded no main session");
      ctx.uiWorkspace.openSession(mainSessionId);
    }

    /**
     * Resolve the main session to talk to, creating one only when the recorded
     * one cannot be used. This is the same rule the sidebar entry applies: a
     * live recorded session is reused; a missing, archived or no-longer-listed
     * one is replaced by a freshly created and woken session.
     * @returns the session id, or null when the host cannot provide one.
     */
    async function resolveMainSession(deps) {
      const sessions = deps.sessions;
      const workspaces = deps.workspaces;
      const live = (id) => isLive(id, sessions?.list?.getSnapshot(), workspaces?.list?.getSnapshot());
      let recorded;
      try {
        recorded = await homeRoute("GET", deps.fetch);
      } catch (_error) {
        return null;
      }
      if (live(recorded?.mainSessionId)) return recorded.mainSessionId;
      try {
        const created = await homeRoute("POST", deps.fetch);
        const id = created?.mainSessionId;
        return typeof id === "string" && id !== "" ? id : null;
      } catch (_error) {
        return null;
      }
    }

    // ---- the voice call: pure rules (mirrored from voice-silence.js) ------
    //
    // The shared module is ESM for the host/tests; the browser half is a plain
    // script in the shell's wrapper, so it cannot import it. These rules are
    // therefore mirrored here verbatim and `test/client.mjs` proves both copies
    // decide identically.

    /** The 90th-percentile level of an utterance's 30 ms frames, in dBFS. */
    function speechLevelDbfs(samples, sampleRate) {
      const rate = typeof sampleRate === "number" ? sampleRate : 16000;
      const frame = Math.max(1, Math.round(rate * 0.03));
      const levels = [];
      for (let start = 0; start + frame <= samples.length; start += frame) {
        let sum = 0;
        for (let i = start; i < start + frame; i += 1) sum += samples[i] * samples[i];
        levels.push(Math.sqrt(sum / frame));
      }
      if (levels.length === 0) return -Infinity;
      levels.sort((a, b) => a - b);
      const loud = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.9))];
      return loud > 0 ? 20 * Math.log10(loud) : -Infinity;
    }

    /** Notices the person has walked away; only listening time counts. */
    function createAwayGuard(options) {
      const idleMs = options?.idleMs ?? VOICE_CONSTANTS.awayIdleMs;
      const maxRejections = options?.maxRejections ?? VOICE_CONSTANTS.awayMaxRejections;
      let since = null;
      let banked = 0;
      let rejections = 0;
      return {
        resume(now) { if (since === null) since = now; },
        suspend(now) { if (since !== null) banked += now - since; since = null; },
        accepted(now) { banked = 0; rejections = 0; if (since !== null) since = now; },
        present(now) { banked = 0; rejections = 0; if (since !== null) since = now; },
        rejected() { rejections += 1; },
        reset() { since = null; banked = 0; rejections = 0; },
        reason(now) {
          if (rejections >= maxRejections) return "rejections";
          const listened = banked + (since === null ? 0 : now - since);
          if (listened >= idleMs) return "idle";
          return null;
        },
      };
    }

    // A transcript may only be delivered while its call is the live one and the
    // session it was recorded for is still the target.
    function createCallGuard() {
      let current = null;
      let target = null;
      return {
        setTarget(sessionId) { target = typeof sessionId === "string" && sessionId !== "" ? sessionId : null; },
        targetSessionId() { return target; },
        begin(id) { current = { id, ended: false }; return current; },
        end(id) { if (current !== null && current.id === id) current.ended = true; },
        isCurrent(call) { return call !== null && call !== undefined && current === call && call.ended === false; },
        accepts(call, sessionId) {
          if (!this.isCurrent(call)) return false;
          if (target === null) return false;
          return sessionId === target;
        },
        isCalling() { return current !== null && current.ended === false; },
      };
    }

    // ---- the call's two controls, as a state machine ----------------------
    //
    // The user asked for two separate things and they must never collapse into
    // one switch:
    //
    //   microphone ("话筒") = the DEVICE. On acquires the stream (the OS
    //                         indicator lights). Off stops every track and
    //                         releases the device.
    //   mute ("静音")       = PROCESSING. The stream stays live, but the speech
    //                         detector is paused: no frame is analysed, nothing
    //                         is uploaded or sent, and a segment in progress is
    //                         dropped. Unmuting resumes detection on the same
    //                         stream.
    //
    // Consequences this encodes, rather than leaving to the UI:
    //   * mute is unavailable while the device is off (there is nothing to mute)
    //   * muting never stops a track, and stopping the device never leaves a
    //     mute latched behind it
    //   * `processing` is the single flag listening consults
    function createCallControls() {
      let device = false;
      let muted = false;
      return {
        state() {
          return {
            device,
            muted,
            processing: device && !muted,
            muteEnabled: device,
          };
        },
        /** Open or close the device. Closing releases any held mute. */
        setDevice(next) {
          device = Boolean(next);
          if (!device) muted = false;
          return this.state();
        },
        /** Toggle processing without touching the device. */
        toggleMute() {
          if (!device) return this.state();
          muted = !muted;
          return this.state();
        },
        /** Explicit mute, for restoring a remembered state. */
        setMuted(next) {
          muted = device ? Boolean(next) : false;
          return this.state();
        },
      };
    }

    // ---- listening: vad-web's MicVAD under the call's rules -----------------
    //
    // When a turn starts and ends is Silero VAD's decision, made by
    // `@ricky0123/vad-web` (MicVAD): speech probabilities per frame, the start
    // and end hysteresis, the pre-speech pad, misfires under the minimum
    // speech. This wrapper only maps the call's controls onto it.

    /**
     * One call's listener.
     *
     *   listen(muted)  open the microphone and detect speech (muted: open it,
     *                  but process nothing)
     *   hold()         half-duplex while the whale works: stop detecting and
     *                  release the microphone; a segment in progress is dropped
     *   mute()         stop detecting, keep the microphone open; a segment in
     *                  progress is dropped
     *   unmute()       detect again on the same stream
     *   finish()       "done talking": end the segment now and hand it over;
     *                  answers whether there was one
     *   close()        release everything
     *
     * Each finished segment reaches `onUtterance(audio)` as 16 kHz Float32
     * samples. A segment still going after `maxSpeechMs` is finished
     * automatically. MicVAD is created lazily through `createVad(options)`, so
     * tests drive this with a fake.
     * @param deps `createVad`, `getStream`, VAD `options`, `maxSpeechMs`,
     *   `onUtterance`, and injectable `setTimeout` / `clearTimeout`.
     * @returns the listener.
     */
    function createTurnTaker(deps) {
      const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
      const cancel = deps.clearTimeout ?? ((id) => clearTimeout(id));
      let vad = null;
      let creating = null;
      let stream = null;
      // Set by close(): a detector or a stream that arrives afterwards (the
      // model still loading, the permission prompt still open) is released at
      // once instead of starting.
      let closed = false;
      let keepStream = false;
      let delivered = false;
      let capTimer = null;
      let options = { ...deps.options };

      const clearCap = () => {
        if (capTimer !== null) cancel(capTimer);
        capTimer = null;
      };
      const stopTracks = () => {
        const current = stream;
        stream = null;
        try { current?.getTracks().forEach((track) => track.stop()); } catch (_error) { /* already stopped */ }
      };
      const closedError = () => Object.assign(new Error("listening closed"), { code: "closed" });
      const acquire = async () => {
        const next = await deps.getStream();
        if (closed) {
          try { next?.getTracks().forEach((track) => track.stop()); } catch (_error) { /* already stopped */ }
          throw closedError();
        }
        stream = next;
        return stream;
      };

      async function ensure() {
        if (closed) throw closedError();
        if (vad !== null) return vad;
        if (creating === null) {
          creating = Promise.resolve(deps.createVad({
            ...options,
            startOnLoad: false,
            submitUserSpeechOnPause: false,
            getStream: acquire,
            // Half-duplex releases the device; mute keeps it open.
            pauseStream: async () => { if (!keepStream) stopTracks(); },
            resumeStream: async (current) => {
              const live = current?.getTracks().some((track) => track.readyState === "live") === true;
              return live ? current : acquire();
            },
            onSpeechRealStart: () => {
              clearCap();
              capTimer = schedule(() => { void finish(); }, deps.maxSpeechMs);
            },
            onSpeechEnd: (audio) => {
              clearCap();
              delivered = true;
              deps.onUtterance(audio);
            },
            onVADMisfire: () => { clearCap(); },
          })).then((created) => {
            if (closed) {
              Promise.resolve().then(() => created.destroy()).catch(() => { /* never started */ });
              throw closedError();
            }
            vad = created;
            return created;
          }).finally(() => { creating = null; });
        }
        return creating;
      }

      async function pause(keep, submit) {
        clearCap();
        if (vad !== null) {
          keepStream = keep;
          if (submit) vad.setOptions({ submitUserSpeechOnPause: true });
          try {
            await vad.pause();
          } finally {
            if (submit) vad.setOptions({ submitUserSpeechOnPause: false });
            keepStream = false;
          }
        }
        // MicVAD.pause() does nothing once detection is already paused (muted),
        // so releasing the device never depends on its pauseStream call.
        if (!keep) stopTracks();
      }

      async function finish() {
        delivered = false;
        await pause(false, true);
        return delivered;
      }

      return {
        async listen(muted) {
          const created = await ensure();
          await created.start();
          if (closed) {
            stopTracks();
            throw closedError();
          }
          if (muted === true) await pause(true, false);
        },
        hold() { return pause(false, false); },
        mute() { return pause(true, false); },
        async unmute() {
          if (vad !== null) await vad.start();
        },
        finish,
        /** Change how long a pause ends the turn, now and for a later start. */
        setRedemptionMs(ms) {
          options = { ...options, redemptionMs: ms };
          if (vad !== null) vad.setOptions({ redemptionMs: ms });
        },
        async close() {
          closed = true;
          clearCap();
          const current = vad;
          vad = null;
          if (current !== null) {
            try { await current.destroy(); } catch (_error) { /* already destroyed */ }
          }
          stopTracks();
        },
      };
    }

    /**
     * Load vad-web once, from the plugin's own routes: onnxruntime-web first
     * (it defines the global `ort` the vad-web bundle expects), then the bundle,
     * which defines `vad`.
     */
    let vadLibrary = null;
    function loadVadLibrary() {
      if (vadLibrary === null) {
        vadLibrary = (async () => {
          if (window.vad?.MicVAD === undefined) {
            if (window.ort === undefined) await loadScript(`${VOICE_ASSET_ROUTE}/ort.wasm.min.js`);
            await loadScript(`${VOICE_ASSET_ROUTE}/bundle.min.js`);
          }
          if (window.vad?.MicVAD === undefined) throw Object.assign(new Error("vad-web did not load"), { code: "vad-load" });
          return window.vad;
        })().catch((error) => {
          vadLibrary = null;
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "vad-load" });
        });
      }
      return vadLibrary;
    }

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const element = document.createElement("script");
        element.src = src;
        element.async = true;
        element.dataset.dshPlugin = "discipline-whale";
        element.onload = () => resolve();
        element.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(element);
      });
    }

    // ---- keeping the call outside the page ---------------------------------
    //
    // Two layers, and the honest difference between them matters:
    //
    //   Document Picture-in-Picture (Chrome/Edge 116+) puts the dock in an
    //   always-on-top OS window owned by this page. It survives panel
    //   navigation and keeps the call alive while the user works elsewhere.
    //   It is NOT a desktop pet: when the browser is minimized the window is
    //   hidden with it, and no web API can draw outside the browser.
    //
    //   window.open() keeps a real second window, which is the fallback when
    //   Document PiP is unavailable. It is not always-on-top, and popup
    //   blockers may refuse it.
    //
    // With neither, the dock stays in the page and says so. No promise is made
    // about outliving a minimized browser, because no web page can keep it.
    function detachCapability(scope, options) {
      const host = scope ?? (typeof window === "undefined" ? {} : window);
      const pip = host.documentPictureInPicture;
      // `pipFailed` records that a previous requestWindow attempt rejected —
      // without a user gesture, or blocked by Permissions Policy. The next
      // attempt then goes straight to the popup instead of failing twice.
      const pipUsable = options?.pipFailed !== true;
      const canPip = pipUsable && pip !== null && pip !== undefined && typeof pip.requestWindow === "function";
      const canPopup = typeof host.open === "function";
      if (canPip) {
        return {
          mode: "document-pip",
          available: true,
          label: "detachPip",
          // Document PiP is always-on-top and tied to this page's lifetime.
          alwaysOnTop: true,
          survivesMinimize: false,
        };
      }
      if (canPopup) {
        return {
          mode: "window-open",
          available: true,
          label: "detachPopup",
          alwaysOnTop: false,
          survivesMinimize: false,
        };
      }
      return {
        mode: "none",
        available: false,
        label: "detachNone",
        alwaysOnTop: false,
        survivesMinimize: false,
      };
    }

    /**
     * Snap a dragged dock to the nearest side, keeping the cross-axis position.
     *
     * Pure arithmetic so the feel is testable: the dock is clamped fully into
     * the viewport, then snapped when it is within `snapDistance` of an edge.
     * A dock wider than the viewport clamps to the left margin instead of
     * producing a negative coordinate.
     */
    function snapDockPosition(input) {
      const margin = input.margin ?? 16;
      const snapDistance = input.snapDistance ?? 80;
      const width = Math.max(0, input.width);
      const height = Math.max(0, input.height);
      const maxX = input.viewport.width - width - margin;
      const maxY = input.viewport.height - height - margin;
      const clamp = (value, max) => Math.min(Math.max(value, margin), Math.max(margin, max));
      const x = clamp(input.x, maxX);
      const y = clamp(input.y, maxY);
      const toLeft = x - margin;
      const toRight = Math.max(margin, maxX) - x;
      let edge = null;
      if (Math.min(toLeft, toRight) <= snapDistance) edge = toLeft <= toRight ? "left" : "right";
      const snappedX = edge === "left" ? margin : edge === "right" ? Math.max(margin, maxX) : x;
      return { x: snappedX, y, edge };
    }

    /**
     * Where a released dock settles, as the CSS anchoring the stylesheet uses.
     *
     * Two shapes, one rule each:
     *   * The open panel, pushed past a side edge by 30% of its width (at most
     *     120px), is stashed on that side as a single microphone button.
     *     Released anywhere else it stays open, clamped and edge-snapped by
     *     `snapDockPosition`.
     *   * The stashed button, released within `snapDistance` of a side, stays
     *     stashed there (it can slide along the edge). Released further in, it
     *     opens again at `expanded` size, centred on where it was dropped.
     *
     * The result is anchored to the nearer side (`anchor`, distance `x` from
     * it) and to the bottom (`y`), so a panel that grows or shrinks keeps its
     * control bar where the user left it.
     * @param input `left`/`top` of the dropped box (unclamped), its `width`/
     *   `height`, the `viewport`, whether it is `docked`, the `expanded` size,
     *   and optional `margin` / `dockMargin` / `snapDistance`.
     * @returns `{ docked, anchor, x, y }`; `docked` is "left", "right" or null.
     */
    function dockRelease(input) {
      const margin = input.margin ?? 16;
      const dockMargin = input.dockMargin ?? 8;
      const snapDistance = input.snapDistance ?? 72;
      const viewport = input.viewport;
      const width = Math.max(0, input.width);
      const height = Math.max(0, input.height);
      let docked = null;
      if (input.docked === true) {
        const toLeft = input.left;
        const toRight = viewport.width - (input.left + width);
        if (Math.min(toLeft, toRight) <= snapDistance) docked = toLeft <= toRight ? "left" : "right";
      } else {
        const push = Math.min(120, width * 0.3);
        if (-input.left > push) docked = "left";
        else if (input.left + width - viewport.width > push) docked = "right";
      }
      if (docked !== null) {
        const top = Math.min(Math.max(input.top, margin), Math.max(margin, viewport.height - height - margin));
        return { docked, anchor: docked, x: dockMargin, y: viewport.height - top - height };
      }
      // Opening from the stashed button uses the panel's own size, centred
      // under the drop point with its bottom edge where the button was.
      const box = input.docked === true && input.expanded
        ? {
          width: input.expanded.width,
          height: input.expanded.height,
          left: input.left + width / 2 - input.expanded.width / 2,
          top: input.top + height - input.expanded.height,
        }
        : { width, height, left: input.left, top: input.top };
      const placed = snapDockPosition({
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        viewport,
        margin,
        snapDistance,
      });
      const anchor = placed.x + box.width / 2 < viewport.width / 2 ? "left" : "right";
      return {
        docked: null,
        anchor,
        x: anchor === "left" ? placed.x : viewport.width - placed.x - box.width,
        y: viewport.height - placed.y - box.height,
      };
    }

    /**
     * The panel's size while a corner grip is dragged.
     *
     * The grip sits on the panel's free top corner, so dragging it outward or
     * up grows the panel away from its anchored side and bottom. `room` is the
     * space left between the panel and the viewport margin on each side; the
     * result never grows past it and never shrinks below the minimums.
     * @param input `width`, `cardHeight`, pointer delta `dx`/`dy`, `corner`
     *   ("left" or "right"), `room` `{ left, right, top }`, and optional minimums.
     * @returns `{ width, cardHeight }` in pixels.
     */
    function dockResize(input) {
      const minWidth = input.minWidth ?? 300;
      const minCardHeight = input.minCardHeight ?? 120;
      const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));
      const grow = input.corner === "right" ? input.dx : -input.dx;
      const roomX = input.corner === "right" ? input.room.right : input.room.left;
      return {
        width: clamp(input.width + grow, minWidth, input.width + Math.max(0, roomX)),
        cardHeight: clamp(input.cardHeight - input.dy, minCardHeight, input.cardHeight + Math.max(0, input.room.top)),
      };
    }

    /** How far a press must travel before it moves the dock instead of clicking. */
    const DRAG_THRESHOLD = 5;

    /**
     * The geometry custom properties for the dock host, from the saved
     * placement and size. Numbers only: the stylesheet decides what they move.
     */
    function dockGeometryStyle(placement, size) {
      const style = {};
      if (placement !== null && placement !== undefined) {
        style["--dw-dock-x"] = String(Math.round(placement.x));
        style["--dw-dock-y"] = String(Math.round(placement.y));
      }
      if (size !== null && size !== undefined) {
        style["--dw-dock-w"] = String(Math.round(size.width));
        style["--dw-card-h"] = String(Math.round(size.cardHeight));
      }
      return Object.keys(style).length === 0 ? undefined : style;
    }

    /**
     * The settings form's request body, built from the draft.
     *
     * The key field is write-only: the server never returns the value, so the
     * form cannot prefill it. That leaves one ambiguity to resolve explicitly —
     * an empty box could mean "leave it alone" or "erase it". `apiKeyTouched`
     * decides: untouched omits the field entirely (a page reload cannot wipe a
     * stored key by submitting an empty password box), touched-and-empty sends
     * `""`, which the route reads as "unset".
     */
    function settingsDraftPatch(draft) {
      const patch = {};
      if (typeof draft.baseUrl === "string") patch.baseUrl = draft.baseUrl.trim();
      if (typeof draft.model === "string") patch.model = draft.model.trim();
      if (typeof draft.language === "string") patch.language = draft.language.trim();
      if (draft.apiKeyTouched === true && typeof draft.apiKey === "string") patch.apiKey = draft.apiKey;
      return patch;
    }

    // ---- keeping the main session readable --------------------------------
    //
    // The reply is read from the session's durable event window, and a window
    // exists only while something retains that session. When the whale's
    // conversation is the visible panel, the main view retains it; during a
    // call the user may well be looking at another panel, so the call retains
    // the session itself and releases it on hangup.

    /** Client-side reference labels this plugin owns. */
    const RETAIN_SOURCE = "disciplineWhaleVoice";

    function createSessionWatcher(sessions) {
      let reference = null;
      return {
        /**
         * Retain one session for the call, replacing any previous reference.
         * @returns the retained reference, or null when retention is unavailable.
         */
        watch(sessionId) {
          this.release();
          if (sessions === undefined || sessions === null || typeof sessions.retain !== "function") return null;
          if (typeof sessionId !== "string" || sessionId === "") return null;
          try {
            reference = sessions.retain(sessionId, { source: RETAIN_SOURCE });
          } catch (_error) {
            reference = null;
          }
          return reference;
        },
        /** The live reference, if any. */
        reference() {
          return reference;
        },
        /** Release the retention; safe to call repeatedly. */
        release() {
          const current = reference;
          reference = null;
          if (current !== null && typeof current.release === "function") {
            try { current.release(); } catch (_error) { /* already released */ }
          }
        },
      };
    }

    // ---- reading the whale's reply ----------------------------------------
    //
    // The client exposes no per-turn "turn ended" callback to a plugin: the
    // session face carries `running`, and the event window
    // (`binding.eventSource`) carries the durable `turn/start`/`turn/end` and
    // `assistant/message` events. We read the event window directly, so the
    // reply text is exact rather than scraped from the DOM. `turn/end` IS a
    // real durable event; what this dock approximates is only *when to look*:
    // it polls the session snapshot for `running === false` and then reads the
    // closed turn from the window. That polling is the approximation.

    /** The highest turn already present when the call starts. */
    function baselineTurnOf(entries) {
      let highest = 0;
      for (const entry of entries || []) {
        const event = entry && entry.type === "event" ? entry.event : entry;
        if (event && event.type === "turn/start" && typeof event.data?.turn === "number") {
          highest = Math.max(highest, event.data.turn);
        }
        if (event && event.type === "turn/end" && typeof event.data?.turn === "number") {
          highest = Math.max(highest, event.data.turn);
        }
      }
      return highest;
    }

    /** Concatenated text of the assistant messages in every turn above `baseline`. */
    function replyTextOf(entries, baseline) {
      const parts = [];
      for (const entry of entries || []) {
        const event = entry && entry.type === "event" ? entry.event : entry;
        if (!event || event.type !== "assistant/message") continue;
        const turn = event.data?.turn;
        if (typeof turn !== "number" || turn <= baseline) continue;
        const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
        for (const block of content) {
          if (block && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            parts.push(block.text.trim());
          }
        }
      }
      return parts.join("");
    }

    /** Whether any assistant text exists above `baseline` (the poll's "has it started"). */
    function hasReplyAbove(entries, baseline) {
      return replyTextOf(entries, baseline) !== "";
    }

    /** Reduce markdown to something a speech synthesizer reads naturally. */
    function speakable(text) {
      return String(text || "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/^#{1,6}\s*/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_~>]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    /**
     * The BCP-47 tag for the browser's speech synthesizer.
     *
     * This is the fallback read-aloud voice, not an integrated TTS channel.
     * The same locale also decides the transcription language hint, which is
     * why `uiLanguage()` below derives the bare `zh`/`en` form from it.
     */
    function speechLanguage() {
      const lang = typeof document !== "undefined" ? document.documentElement.getAttribute("lang") : "";
      if (typeof lang === "string" && /^zh/i.test(lang)) return "zh-CN";
      if (typeof lang === "string" && /^en/i.test(lang)) return "en-US";
      return typeof navigator !== "undefined" && /^zh/i.test(navigator.language || "") ? "zh-CN" : "en-US";
    }

    /** The bare transcription language hint (`zh`/`en`) from the same locale. */
    function uiLanguage() {
      return /^zh/i.test(speechLanguage()) ? "zh" : "en";
    }

        // ---- views ------------------------------------------------------------

    function WhaleIcon(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M3 11.5c0-2.5 2-4.5 4.5-4.5h6c2 0 3.5 1 4.5 2.5L20 7.5v6l-2-2c-1 1.5-2.5 2.5-4.5 2.5h-6C5 14 3 12 3 11.5z" }),
        h("circle", { cx: 7, cy: 10, r: 0.6, fill: "currentColor" }),
        h("path", { d: "M3 18c1.2-1 2.3-1 3.5 0s2.3 1 3.5 0 2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0" })
      );
    }

    function makeWhalePage(ctx, t) {
      return function WhalePage() {
        const [error, setError] = React.useState(null);
        const [attempt, setAttempt] = React.useState(0);

        React.useEffect(() => {
          let alive = true;
          openMainSession(ctx).catch((reason) => {
            if (alive) setError(String(reason?.message ?? reason));
          });
          return () => {
            alive = false;
          };
        }, [attempt]);

        const body = error === null
          ? h("p", null, t("opening"))
          : [
              h("p", { key: "msg" }, t("failed", { reason: error })),
              h("button", { key: "retry", type: "button", className: "dw-retry", onClick: () => { setError(null); setAttempt((n) => n + 1); } }, t("retry")),
            ];
        return h("section", { className: "dw-page", "aria-label": t("panel") }, body);
      };
    }

    // ---- the voice call: microphone and lifecycle --------------------------

    /** Encode mono float samples as a 16-bit PCM WAV the host route accepts. */
    function encodeWav(samples, sampleRate) {
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      const text = (at, value) => { for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i); };
      text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE"); text(12, "fmt ");
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
      view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    /** Read the error code out of a failed JSON answer, falling back to a transport message. */
    async function failureCodeOf(response) {
      try {
        const payload = await response.json();
        return typeof payload?.error?.code === "string" ? payload.error.code : `http/${response.status}`;
      } catch (_error) {
        return `http/${response.status}`;
      }
    }

    /** Turn a route error code into one of the dictionary keys above. */
    function errorKeyOf(code) {
      if (code === "voice/missing-key") return "errMissingKey";
      if (code === "voice/invalid-key") return "errInvalidKey";
      if (code === "voice/model-unavailable") return "errNoModel";
      if (code === "voice/backend-unreachable") return "errUnreachable";
      if (code === "voice/backend-timeout") return "errTimeout";
      if (code === "voice/audio-too-large") return "errTooLarge";
      if (code === "voice/empty-transcript") return "errEmptyTranscript";
      if (code === "voice/rejected-transcript") return "noticeRejected";
      if (code === "voice/no-main-session") return "errNoMainSession";
      return "errUnreachable";
    }

    // ---- the dock's views, as plain builders ------------------------------
    //
    // These are extracted from the component so the tests can walk the tree
    // without a browser: the component owns the state and the effects, the
    // builders own what is on screen. That keeps "are the two controls really
    // separate" a question about data rather than a question about pixels.

    /** The two-glyph icon set: a microphone and a muted microphone. */
    function MicGlyph(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      const muted = props.muted === true;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
        h("path", { d: "M5 11a7 7 0 0 0 14 0" }),
        h("path", { d: "M12 18v3" }),
        muted ? h("path", { d: "M4 4l16 16" }) : null
      );
    }

    /**
     * The microphone (device) and mute (processing) buttons.
     *
     * They are two separate buttons, each with its own `aria-pressed` and its
     * own label, because they are two different facts. The microphone is the
     * orb in the middle of the bar; mute sits to its left. Mute is `disabled`
     * while the device is off and its title says why, so the unavailable state
     * is explained rather than mysterious.
     */
    function controlButtons(input) {
      const t = input.t;
      const state = input.controls;
      const action = input.actions;
      const micLabel = state.device ? t("micOn") : t("micOff");
      const muteLabel = state.muted ? t("muteOn") : t("muteOff");
      const muteTitle = !state.device ? t("muteNeedsMic") : state.muted ? t("muteHintOn") : t("muteHintOff");
      return {
        mic: h("button", {
          type: "button",
          className: `dw-ctl dw-ctl-mic dw-orb${state.device ? " is-on" : ""}`,
          "data-dw-control": "mic",
          "aria-pressed": state.device,
          title: input.micTitle ?? (state.device ? t("micHintOn") : t("micHintOff")),
          "aria-label": micLabel,
          onClick: action.toggleMic,
        }, h("span", { className: "dw-orb-core", "aria-hidden": true }, h(MicGlyph, { size: 20, muted: true })),
        h("span", { className: "dw-sr" }, micLabel)),
        mute: h("button", {
          type: "button",
          className: `dw-ctl dw-ctl-mute${state.muted ? " is-on" : ""}`,
          "data-dw-control": "mute",
          "aria-pressed": state.muted,
          disabled: !state.device,
          title: muteTitle,
          "aria-label": muteLabel,
          onClick: action.toggleMute,
        }, h(MicGlyph, { size: 20, muted: state.muted }), h("span", { className: "dw-sr" }, muteLabel)),
      };
    }

    /**
     * The one visual state of the open dock.
     *
     * The two controls outrank the phase — with the device off, or muted, no
     * audio is processed whatever the phase says — and an error outranks both.
     * The dock root carries `dw-status-<state>`, so the dot, the orb and the
     * copy all follow this single value.
     */
    function dockVisualState(input) {
      if (input.error !== null && input.status === "error") return "error";
      if (!input.controls.device) return "deviceoff";
      if (input.controls.muted) return "muted";
      return input.status;
    }

    /** The status copy key for that visual state. */
    function dockStatusKey(input) {
      const state = dockVisualState(input);
      if (state === "error") return "statusError";
      if (state === "deviceoff") return "statusDeviceOff";
      if (state === "muted") return "statusMuted";
      return `status${state.charAt(0).toUpperCase()}${state.slice(1)}`;
    }

    /**
     * The open dock.
     *
     * Two flat surfaces, nothing nested: a card that says what the call is
     * doing (status, what was heard, what came back, the small print), and the
     * bar with the controls, laid out like a phone call — one round button on
     * each side of a pill:
     *
     *   (settings)  ( mute | ORB = microphone | read-aloud )  (hang up)
     *
     * The orb is the microphone control and its animation is the call status.
     * The privacy line and the fallback-TTS note stay on the card as small
     * print: facts the user must be able to read, kept visible.
     */
    function dockView(input) {
      const t = input.t;
      // Accept either the machine or its snapshot: the component holds the
      // machine, the tests hold a plain state object, and neither should have to
      // know which shape the other passes.
      const controls = typeof input.controls?.state === "function" ? input.controls.state() : input.controls;
      const visual = dockVisualState({ ...input, controls });
      const statusKey = dockStatusKey({ ...input, controls });
      const buttons = controlButtons({ t, controls, actions: input.actions });
      // "Done talking" ends the segment in progress, so it shows only while one
      // can be recording: muting drops the segment, a closed microphone has none.
      const listening = visual === "listening" || visual === "calibrating";
      const speakLabel = input.speak === true ? t("speakOn") : t("speakOff");
      const hasTranscript = input.heard !== "" || input.reply !== "";
      const card = h("div", { className: "dw-card" },
        // Corner grips for resizing. The dock host owns the pointer handling
        // (see `onDragStart`), so these only mark where a resize begins; the
        // stylesheet shows the one on the panel's free side.
        h("span", { className: "dw-resize dw-resize-left", "data-dw-resize": "left", title: t("resizeHint"), "aria-hidden": true }),
        h("span", { className: "dw-resize dw-resize-right", "data-dw-resize": "right", title: t("resizeHint"), "aria-hidden": true }),
        h("div", { className: "dw-dock-head" },
          h("span", { className: "dw-status", "aria-live": "polite" },
            h("i", { className: "dw-dot" }),
            h("span", { className: "dw-status-text" }, t(statusKey))),
          input.busy === true ? h("span", { className: "dw-busy", "aria-hidden": true }, h("i"), h("i"), h("i")) : null,
          listening ? h("button", { type: "button", className: "dw-chip", onClick: input.actions.stopTalking }, t("callStop")) : null,
          input.detach?.available === true
            ? h("button", {
              type: "button",
              className: "dw-icon-button",
              title: input.detached === true ? t("detachReturn") : t("detachHint"),
              "aria-label": input.detached === true ? t("detachReturn") : t("detach"),
              onClick: input.actions.detach,
            }, h(DetachGlyph, { size: 16 }))
            : null),
        input.error === null ? null : h("p", { className: "dw-error", role: "alert" }, t(input.error)),
        input.notice === null || input.notice === undefined ? null : h("p", { className: "dw-notice", role: "status" }, t(input.notice)),
        hasTranscript
          ? h("div", { className: "dw-transcript" },
            input.heard === "" ? null : h("div", { className: "dw-heard" },
              h("span", { className: "dw-label" }, t("heard")),
              h("p", { className: "dw-bubble" }, input.heard)),
            input.reply === "" ? null : h("div", { className: "dw-reply" },
              h("span", { className: "dw-label" }, h(WhaleIcon, { size: 13 }), t("reply")),
              h("p", { className: "dw-reply-text" }, input.reply)))
          : null,
        h("div", { className: "dw-foot" },
          h("p", { className: "dw-fine dw-privacy" }, h(LockGlyph, { size: 11 }), h("span", null, t("privacy"))),
          h("p", { className: "dw-fine dw-tts-note" }, h(SpeakerGlyph, { size: 11 }), h("span", null, t("speakNote")))));
      const bar = h("div", { className: "dw-bar" },
        h("button", {
          type: "button",
          className: "dw-round",
          title: t("settingsOpen"),
          "aria-label": t("settingsOpen"),
          onClick: input.actions.openSettings,
        }, h(GearGlyph, { size: 20 })),
        h("div", { className: "dw-pill" },
          buttons.mute,
          h("i", { className: "dw-sep", "aria-hidden": true }),
          buttons.mic,
          h("i", { className: "dw-sep", "aria-hidden": true }),
          h("button", {
            type: "button",
            className: `dw-toggle${input.speak === true ? " is-on" : ""}`,
            "aria-pressed": input.speak === true,
            "aria-label": speakLabel,
            title: t("speakHint"),
            onClick: input.actions.toggleSpeak,
          }, h(SpeakerGlyph, { size: 20, off: input.speak !== true }), h("span", { className: "dw-sr" }, speakLabel))),
        h("button", {
          type: "button",
          className: "dw-round dw-hangup",
          title: t("callHangup"),
          "aria-label": t("callHangup"),
          onClick: input.actions.hangUp,
        }, h(HangupGlyph, { size: 22 }), h("span", { className: "dw-sr" }, t("callHangup"))));
      return h(
        "div",
        {
          className: `dw-dock dw-status-${visual}`,
          role: "dialog",
          "aria-label": t("callTitle"),
          "data-utterance": input.utteranceCount ?? 0,
          "data-detached": input.detached === true ? "true" : "false",
        },
        card,
        bar
      );
    }

    /**
     * The dock stashed against a side edge: the microphone button and nothing
     * else.
     *
     * In a call it is the same microphone control as the open bar (same
     * `data-dw-control`, same pressed state), and its orb keeps animating the
     * call status. Without a call, tapping it starts one. Either way, dragging
     * it away from the edge opens the panel again; the title says both.
     */
    function dockedView(input) {
      const t = input.t;
      if (input.open !== true) {
        return h("div", { className: "dw-dock dw-dock-docked dw-status-idle", "data-dw-side": input.side },
          h("button", {
            type: "button",
            className: "dw-ctl dw-orb dw-orb-start",
            title: `${t("callStart")} · ${t("dockedHintIdle")}`,
            "aria-label": t("callStart"),
            onClick: input.actions.startCall,
          }, h("span", { className: "dw-orb-core", "aria-hidden": true }, h(VoiceGlyph, { size: 20 }))));
      }
      const controls = typeof input.controls?.state === "function" ? input.controls.state() : input.controls;
      const visual = dockVisualState({ ...input, controls });
      const statusText = input.notice ? t(input.notice) : t(dockStatusKey({ ...input, controls }));
      const buttons = controlButtons({ t, controls, actions: input.actions, micTitle: `${statusText} · ${t("dockedHintCall")}` });
      return h("div", {
        className: `dw-dock dw-dock-docked dw-status-${visual}`,
        role: "dialog",
        "aria-label": t("callTitle"),
        "data-dw-side": input.side,
      }, buttons.mic, h("span", { className: "dw-sr", "aria-live": "polite" }, statusText));
    }

    /** A boolean setting is a switch: a button with role="switch" and a sliding thumb. */
    function switchControl(input) {
      return h("button", {
        type: "button",
        role: "switch",
        className: `dw-switch${input.checked === true ? " is-on" : ""}`,
        "aria-checked": input.checked === true,
        "aria-label": input.label,
        onClick: input.onToggle,
      }, h("span", { className: "dw-switch-thumb", "aria-hidden": true }));
    }

    /** The host part of a URL for a one-line summary, or the text itself when it does not parse. */
    function hostOf(url) {
      try {
        return new URL(url).host;
      } catch (_error) {
        return typeof url === "string" ? url : "";
      }
    }

    /**
     * The settings panel: a grouped list with two secondary pages.
     *
     * The first page answers "is it working, and how is it set" at a glance:
     * the read-aloud switch, where the key comes from with a connection test,
     * and the current service. The editable form ("service") and the
     * not-integrated TTS placeholders ("tts") sit one level down, behind rows
     * with a chevron.
     *
     * The key input is `type="password"` and is never prefilled: the server does
     * not return the value, so the form only ever knows "configured, from where".
     * A stored key is cleared through an explicit switch, which is what turns
     * "empty box" into "erase" instead of "leave alone".
     *
     * TTS fields are rendered and disabled, labelled "not integrated", so the
     * form states exactly which capability is missing.
     */
    function settingsView(input) {
      const t = input.t;
      const draft = input.draft;
      const set = input.set;
      const info = input.info;
      const actions = input.actions;
      const page = input.page === "service" || input.page === "tts" ? input.page : "main";
      const navigate = typeof actions.navigate === "function" ? actions.navigate : () => {};
      const apiKeyEnv = info?.apiKeyEnv ?? "SOCLAAS_API_KEY";
      const sourceText = info === null
        ? t("settingsKeySourceNone")
        : info.keySource === "settings"
          ? t("settingsKeySourceSettings")
          : info.keySource === "env"
            ? t("settingsKeySourceEnv", { env: apiKeyEnv })
            : t("settingsKeySourceNone");
      const keyLine = info === null
        ? "…"
        : info.hasApiKey === true ? t("settingsKeySource", { source: sourceText }) : t("settingsKeyMissing", { env: apiKeyEnv });
      const field = (key, label, hint, node) => h("label", { className: "dw-field", key }, h("span", { className: "dw-field-label" }, label), node,
        hint === null ? null : h("span", { className: "dw-field-hint" }, hint));
      const section = (key, title, rows) => h("div", { className: "dw-section", key },
        h("h3", { className: "dw-section-title" }, title),
        h("div", { className: "dw-group" }, rows));
      const navRow = (key, target, title, value) => h("button", { type: "button", className: "dw-row dw-row-nav", key, onClick: () => navigate(target) },
        h("span", { className: "dw-row-title" }, title), value, h(ChevronGlyph, { size: 16 }));
      const errorLine = input.error === null || input.error === undefined ? null : h("p", { className: "dw-error", role: "alert", key: "err" }, t(input.error));
      const testLine = input.testResult === null || input.testResult === undefined ? null : h("p", {
        key: "test",
        className: `dw-test ${input.testResult.ok === true ? "is-ok" : "is-bad"}`,
        role: "status",
        "data-dw-test": input.testResult.ok === true ? "ok" : "failed",
      }, input.testResult.ok === true
        ? t("testOk", { message: input.testResult.message })
        : t("testFailed", { message: input.testResult.message }));
      const testButton = (className) => h("button", { type: "button", className, disabled: input.testing === true, onClick: actions.test },
        input.testing === true ? t("settingsTesting") : t("settingsTest"));
      const disabledField = (key, label, type) => field(key, label, null,
        h("input", { type, className: "dw-input", value: "", placeholder: t("settingsNotIntegrated"), disabled: true, readOnly: true, autoComplete: "off" }));

      let title;
      let body;
      if (page === "service") {
        title = t("settingsService");
        body = [
          errorLine,
          field("baseUrl", t("settingsBaseUrl"), t("settingsBaseUrlHint"),
            h("input", {
              type: "url",
              inputMode: "url",
              className: "dw-input",
              value: draft.baseUrl,
              placeholder: info?.baseUrl ?? "",
              spellCheck: false,
              autoComplete: "off",
              onChange: (event) => set({ baseUrl: event.target.value }),
            })),
          field("apiKey", t("settingsApiKey"), t("settingsApiKeyHint"),
            h("input", {
              type: "password",
              className: "dw-input",
              value: draft.apiKey,
              placeholder: info?.hasApiKey === true ? "••••••••" : "",
              autoComplete: "new-password",
              spellCheck: false,
              disabled: draft.clearKey === true,
              onChange: (event) => set({ apiKey: event.target.value, apiKeyTouched: true }),
            })),
          // Clearing only means something for a key saved here; an environment
          // key is the shell's to change.
          info?.keySource === "settings"
            ? h("div", { className: "dw-row dw-row-plain dw-row-danger", key: "clear" },
              h("span", { className: "dw-row-text" },
                h("span", { className: "dw-row-title" }, t("settingsApiKeyClear")),
                h("span", { className: "dw-row-sub" }, t("settingsApiKeyClearHint"))),
              switchControl({
                checked: draft.clearKey === true,
                label: t("settingsApiKeyClear"),
                // Switching it back off restores "leave the key alone".
                onToggle: () => set(draft.clearKey === true
                  ? { clearKey: false, apiKeyTouched: false, apiKey: "" }
                  : { clearKey: true, apiKeyTouched: true, apiKey: "" }),
              }))
            : null,
          field("model", t("settingsModel"), null,
            h("input", {
              type: "text",
              className: "dw-input",
              value: draft.model,
              placeholder: info?.model ?? "",
              spellCheck: false,
              autoComplete: "off",
              onChange: (event) => set({ model: event.target.value }),
            })),
          field("language", t("settingsLanguage"), t("settingsLanguageHint"),
            h("input", {
              type: "text",
              className: "dw-input",
              value: draft.language,
              placeholder: info?.language || "zh / en",
              spellCheck: false,
              autoComplete: "off",
              onChange: (event) => set({ language: event.target.value }),
            })),
          h("div", { className: "dw-settings-actions", key: "actions" },
            h("button", { type: "button", className: "dw-primary", disabled: input.busy === true, onClick: actions.save },
              input.busy === true ? t("settingsSaving") : t("settingsSave")),
            testButton("dw-secondary"),
            input.saved === true ? h("span", { className: "dw-saved", role: "status" }, t("settingsSaved")) : null),
          testLine,
          h("p", { className: "dw-settings-note", key: "restart" }, t("settingsRestartHint")),
        ];
      } else if (page === "tts") {
        title = t("settingsTtsTitle");
        // Real TTS is not integrated. The four fields are placeholders kept for
        // a future integration (the user asked for them to stay and be labelled):
        // each one is disabled and says so, and the key field is explicit that a
        // real TTS needs its OWN key. Nothing here is wired to anything.
        body = h("div", { className: "dw-tts-block", "data-dw-tts": "not-integrated" },
          h("p", { className: "dw-tts-note" }, t("settingsTtsNote")),
          disabledField("ttsBaseUrl", t("settingsTtsBaseUrl"), "url"),
          disabledField("ttsModel", t("settingsTtsModel"), "text"),
          disabledField("ttsVoice", t("settingsTtsVoice"), "text"),
          disabledField("ttsApiKey", t("settingsTtsApiKey"), "password"),
          h("p", { className: "dw-tts-note" }, t("settingsTtsKeyHint")));
      } else {
        title = t("settingsOpen");
        const language = info === null ? "" : info.language || t("settingsLanguageAuto");
        const summary = info === null ? "" : [info.model, hostOf(info.baseUrl), language].filter((part) => part).join(" · ");
        body = [
          errorLine,
          section("call", t("settingsSectionCall"), [
            h("div", { className: "dw-row", key: "speak" },
              h("span", { className: "dw-row-text" },
                h("span", { className: "dw-row-title" }, t("settingsSpeakLabel")),
                h("span", { className: "dw-row-sub" }, t("speakNote"))),
              switchControl({ checked: input.speak === true, label: t("settingsSpeakLabel"), onToggle: actions.toggleSpeak })),
            h("label", { className: "dw-row", key: "redemption" },
              h("span", { className: "dw-row-text" },
                h("span", { className: "dw-row-title" }, t("settingsRedemption")),
                h("span", { className: "dw-row-sub" }, t("settingsRedemptionHint"))),
              h("select", {
                className: "dw-select",
                value: String(input.redemptionMs ?? VOICE_CONSTANTS.turn.redemptionMs),
                onChange: (event) => { if (typeof actions.chooseRedemptionMs === "function") actions.chooseRedemptionMs(Number(event.target.value)); },
              }, VOICE_CONSTANTS.redemptionChoicesMs.map((ms) => h("option", { key: ms, value: String(ms) }, t("settingsSeconds", { n: ms / 1000 }))))),
          ]),
          section("asr", t("settingsSectionAsr"), [
            h("div", { className: "dw-row dw-source", key: "source", "data-dw-source": info?.keySource ?? "unknown" },
              h("i", { className: "dw-dot" }),
              h("span", { className: "dw-row-text" }, keyLine),
              testButton("dw-link")),
            testLine === null ? null : h("div", { className: "dw-row", key: "test" }, testLine),
            navRow("service", "service", t("settingsService"), h("span", { className: "dw-row-value" }, summary)),
          ]),
          section("tts", t("settingsSectionTts"), [
            navRow("tts", "tts", t("settingsTtsEntry"), h("span", { className: "dw-badge" }, t("settingsNotIntegrated"))),
          ]),
          h("p", { className: "dw-settings-note", key: "intro" }, t("settingsIntro")),
        ];
      }
      return h("section", { className: "dw-settings", "aria-label": t("settingsOpen"), "data-dw-panel": "settings", "data-dw-page": page },
        h("div", { className: "dw-settings-head" },
          page === "main" ? null : h("button", {
            type: "button",
            className: "dw-icon-button",
            title: t("settingsBack"),
            "aria-label": t("settingsBack"),
            onClick: () => navigate("main"),
          }, h(ChevronGlyph, { size: 18, back: true })),
          h("h2", { className: "dw-settings-title" }, title),
          h("button", { type: "button", className: "dw-icon-button", title: t("settingsClose"), "aria-label": t("settingsClose"), onClick: actions.close },
            h(CloseGlyph, { size: 16 }))),
        h("div", { className: "dw-settings-body" }, body)
      );
    }

    /** One stroke-icon wrapper, so every glyph shares size, stroke and a11y. */
    function strokeIcon(props, strokeWidth, children) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        children
      );
    }

    /** A small "detach to its own window" glyph. */
    function DetachGlyph(props) {
      return strokeIcon(props, 1.7, [
        h("rect", { key: "r", x: 3, y: 8, width: 12, height: 10, rx: 2 }),
        h("path", { key: "a", d: "M14 4h6v6" }),
        h("path", { key: "b", d: "M20 4l-7 7" }),
      ]);
    }

    /** A small gear glyph. */
    function GearGlyph(props) {
      return strokeIcon(props, 1.6, [
        h("circle", { key: "c", cx: 12, cy: 12, r: 3 }),
        h("path", { key: "p", d: "M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" }),
      ]);
    }

    /** A speaker; `off` swaps the sound waves for a cross. */
    function SpeakerGlyph(props) {
      const parts = [h("path", { key: "body", d: "M4 9.5h3.2L12 5.5v13l-4.8-4H4z" })];
      if (props.off === true) {
        parts.push(h("path", { key: "x", d: "M16 9.5l5 5M21 9.5l-5 5" }));
      } else {
        parts.push(h("path", { key: "w1", d: "M15.5 9.2a4 4 0 0 1 0 5.6" }));
        parts.push(h("path", { key: "w2", d: "M18.4 6.6a7.6 7.6 0 0 1 0 10.8" }));
      }
      return strokeIcon(props, 1.7, parts);
    }

    /** A handset laid down: hang up. */
    function HangupGlyph(props) {
      return strokeIcon(props, 1.8, [
        h("path", { key: "p", d: "M2.8 13.6c5.1-4.6 13.3-4.6 18.4 0 .5.5.5 1.2.1 1.7l-1.6 1.8c-.4.4-1 .5-1.5.2l-2.4-1.3c-.4-.2-.6-.6-.6-1.1v-1.6c-2.5-.8-4.9-.8-7.4 0v1.6c0 .5-.2.9-.6 1.1l-2.4 1.3c-.5.3-1.1.2-1.5-.2l-1.6-1.8c-.4-.5-.4-1.2.1-1.7z" }),
      ]);
    }

    /** A padlock, for the privacy line. */
    function LockGlyph(props) {
      return strokeIcon(props, 2, [
        h("rect", { key: "r", x: 5, y: 11, width: 14, height: 9, rx: 2 }),
        h("path", { key: "p", d: "M8 11V8a4 4 0 0 1 8 0v3" }),
      ]);
    }

    /** A chevron: forward by default, back with `back`. */
    function ChevronGlyph(props) {
      return strokeIcon(props, 1.8, [h("path", { key: "p", d: props.back === true ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6" })]);
    }

    /** A close cross. */
    function CloseGlyph(props) {
      return strokeIcon(props, 1.8, [h("path", { key: "p", d: "M6 6l12 12M18 6L6 18" })]);
    }


    // ---- the voice dock ---------------------------------------------------

    /** Where the chosen turn-ending pause is kept: per browser, nothing secret. */
    const REDEMPTION_STORAGE_KEY = "discipline-whale.voice.redemptionMs";

    /** The saved turn-ending pause, or the default when none (or storage is blocked). */
    function readRedemptionMs() {
      try {
        const saved = Number(window.localStorage.getItem(REDEMPTION_STORAGE_KEY));
        if (VOICE_CONSTANTS.redemptionChoicesMs.includes(saved)) return saved;
      } catch (_error) {
        // Storage blocked: the default applies.
      }
      return VOICE_CONSTANTS.turn.redemptionMs;
    }

    function writeRedemptionMs(ms) {
      try { window.localStorage.setItem(REDEMPTION_STORAGE_KEY, String(ms)); } catch (_error) { /* kept for this page only */ }
    }

    // The call is a small state machine: idle → calibrating → listening →
    // transcribing → thinking → (speaking) → idle, until the user hangs up.
    // The speaking phase exists only while the opt-in read-aloud fallback is
    // on; with it off (the default) a finished reply goes straight back to
    // idle and the microphone reopens.
    // Half-duplex is a rule, not a suggestion: the microphone is only open
    // while the status is listening, so the whale never hears itself.

    /**
     * Read one reply through the browser's speech synthesizer.
     *
     * This is a FALLBACK, not an integrated TTS channel: it uses whatever voice
     * the OS/browser ships, has no key, no quota and no server semantics.
     *
     * Every path settles the returned promise — `onend`, `onerror`, an engine
     * refusal, or the bounded timer — so a caller may await it without risking
     * a permanently stuck call. It never rejects.
     *
     * Collaborators are injected (`env`) so the timeout backstop is testable
     * without a browser: a fake engine can accept `speak()` and never fire
     * `onend`, which is exactly the failure this guards.
     * @param text reply text, shaped by `speakable`.
     * @param env speech engine, voice lookup, timer, and whether read-aloud is on.
     * @returns after the speech attempt settles; never rejects.
     */
    function speakReply(text, env) {
      const synth = env.synth;
      const Utterance = env.Utterance;
      const schedule = env.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
      const finishResolvers = [];
      const done = new Promise((resolve) => { finishResolvers.push(resolve); });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        for (const resolve of finishResolvers) resolve();
      };
      if (env.enabled !== true || synth === undefined || Utterance === undefined) {
        finish();
        return { done, speech: null };
      }
      const spoken = speakable(text);
      if (spoken === "") {
        finish();
        return { done, speech: null };
      }
      try { synth.cancel(); } catch (_error) { /* no queue */ }
      const speech = new Utterance(spoken);
      const lang = speechLanguage();
      speech.lang = lang;
      speech.rate = 1.02;
      const voices = typeof synth.getVoices === "function" ? synth.getVoices() : [];
      const preferred = voices.find((voice) => /^zh/.test(lang) && /zh[-_]?CN/i.test(voice.lang))
        ?? voices.find((voice) => voice.lang === lang)
        ?? null;
      if (preferred !== null) speech.voice = preferred;
      // Ends on either signal; the timer below is the backstop for engines that
      // fire neither.
      speech.onend = finish;
      speech.onerror = finish;
      try {
        synth.speak(speech);
      } catch (_error) {
        // An engine refusal is not a call failure: show the text and move on.
        finish();
        return { done, speech };
      }
      // speechSynthesis can silently never fire onend. The call must not depend
      // on it: this bounded timer releases the promise on its own.
      schedule(finish, Math.min(120000, 2000 + spoken.length * 220));
      return { done, speech };
    }

    function makeVoiceDock(ctx, t) {
      return function VoiceDock() {
        const [open, setOpen] = React.useState(false);
        const [status, setStatus] = React.useState("ready");
        const [error, setError] = React.useState(null);
        const [heard, setHeard] = React.useState("");
        const [reply, setReply] = React.useState("");
        // Fallback read-aloud: OFF unless the user turns it on. It is the
        // browser's own speech synthesizer, not an integrated TTS channel.
        const [speak, setSpeak] = React.useState(false);
        const [utteranceCount, setUtteranceCount] = React.useState(0);
        const [supported, setSupported] = React.useState(true);
        // The two independent controls, mirrored into React state from the
        // machine below so the render is a pure function of a snapshot.
        const [controls, setControls] = React.useState({ device: false, muted: false, processing: false, muteEnabled: false });
        // The detached-window capability, resolved once on mount.
        const [detach, setDetach] = React.useState({ mode: "none", available: false, label: "detachNone" });
        const [detached, setDetached] = React.useState(false);
        // The settings panel: open flag, the loaded key-free description, the
        // draft, and the last test result.
        const [settingsOpen, setSettingsOpen] = React.useState(false);
        const [settingsInfo, setSettingsInfo] = React.useState(null);
        const [settingsDraft, setSettingsDraft] = React.useState({ baseUrl: "", model: "", language: "", apiKey: "", apiKeyTouched: false, clearKey: false });
        const [settingsBusy, setSettingsBusy] = React.useState(false);
        const [settingsSaved, setSettingsSaved] = React.useState(false);
        const [settingsTesting, setSettingsTesting] = React.useState(false);
        const [settingsTest, setSettingsTest] = React.useState(null);
        const [settingsError, setSettingsError] = React.useState(null);
        // Which settings page is showing: the overview, or one of its two
        // secondary pages ("service", "tts").
        const [settingsPage, setSettingsPage] = React.useState("main");
        // Where the dock sits once the user has moved it (`dockRelease`'s
        // result, including a stashed side) and its size once resized. Kept in
        // state so a remount — the detached window coming back — keeps both.
        const [placement, setPlacement] = React.useState(null);
        const [size, setSize] = React.useState(null);
        // A neutral line on the card: why nothing was sent, or why listening
        // paused. Errors keep their own red line.
        const [notice, setNotice] = React.useState(null);
        // How long a pause ends the turn; the person's choice, kept per browser.
        const [redemptionMs, setRedemptionMsState] = React.useState(readRedemptionMs);

        const takerRef = React.useRef(null);
        const awayRef = React.useRef(null);
        if (awayRef.current === null) awayRef.current = createAwayGuard();
        // True while the detector is running for the call: device on, not
        // muted, not held for the whale's reply. Segments arriving otherwise
        // are not the call's to send.
        const listeningRef = React.useRef(false);
        const redemptionRef = React.useRef(redemptionMs);
        const detachedRef = React.useRef(false);
        const guardRef = React.useRef(null);
        const callRef = React.useRef(null);
        const sessionRef = React.useRef(null);
        const baselineRef = React.useRef(0);
        const disposedRef = React.useRef(false);
        const speakRef = React.useRef(false);
        const watcherRef = React.useRef(null);
        const statusRef = React.useRef("ready");
        const controlsRef = React.useRef(null);
        if (controlsRef.current === null) controlsRef.current = createCallControls();
        const pipRef = React.useRef(null);
        const pipFailedRef = React.useRef(false);
        const dragRef = React.useRef(null);
        const suppressClickRef = React.useRef(false);
        const expandedRef = React.useRef(null);
        const dockElRef = React.useRef(null);

        // The visibility handler reads this outside React's render.
        detachedRef.current = detached;

        function setPhase(next) {
          statusRef.current = next;
          setStatus(next);
        }

        React.useEffect(() => {
          const devices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
          const hasAudio = typeof AudioContext !== "undefined"
            || typeof window !== "undefined" && typeof window.webkitAudioContext !== "undefined";
          setSupported(Boolean(devices && typeof devices.getUserMedia === "function" && hasAudio && typeof WebAssembly === "object"));
          // The detached-window capability is fixed for the page's lifetime, so
          // it is resolved once rather than on every render.
          setDetach(detachCapability(window === undefined ? {} : window, { pipFailed: pipFailedRef.current }));
          const onVisibility = () => {
            // A hidden page keeps the call alive, but it must not keep the
            // microphone hot: a background tab nobody is looking at is not a
            // conversation. A detached window is still on screen, so a call
            // living there keeps listening.
            if (typeof document === "undefined" || document.visibilityState !== "hidden" || detachedRef.current) return;
            if (controlsRef.current.state().device) void closeMicrophone("noticeHidden");
          };
          if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
          // The away rule's clock: listening for AWAY_IDLE_MS without an
          // accepted turn closes the microphone.
          const awayTimer = setInterval(() => {
            if (listeningRef.current && awayRef.current.reason(Date.now()) === "idle") void closeMicrophone("noticeAwayIdle");
          }, 5000);
          return () => {
            clearInterval(awayTimer);
            // Unmounting the plugin must never leave a track live.
            disposedRef.current = true;
            if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
            const drag = dragRef.current;
            dragRef.current = null;
            if (drag !== null && drag.listening !== undefined) {
              drag.listening.doc.removeEventListener("pointermove", drag.listening.move);
              drag.listening.doc.removeEventListener("pointerup", drag.listening.end);
              drag.listening.doc.removeEventListener("pointercancel", drag.listening.end);
            }
            listeningRef.current = false;
            void closeTaker();
            const guard = guardRef.current;
            const call = callRef.current;
            if (guard !== null && call !== null) guard.end(call.id);
            callRef.current = null;
            watcherRef.current?.release();
            watcherRef.current = null;
            closeDetached();
            if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
          };
        }, []);

        function clearResult() {
          setError(null);
          setHeard("");
          setReply("");
        }

        // ---- the two controls, and what each one does -----------------------

        /** Publish the machine's snapshot so the render is a pure function of it. */
        function publishControls() {
          setControls(controlsRef.current.state());
        }

        /** The call's listener, created on first use. */
        function turnTaker() {
          if (takerRef.current === null) {
            takerRef.current = createTurnTaker({
              createVad: async (options) => (await loadVadLibrary()).MicVAD.new(options),
              // Automatic gain control would lift a conversation across the
              // room to speaking level; echo cancellation and noise
              // suppression stay on.
              getStream: () => navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
                video: false,
              }),
              options: {
                ...VOICE_CONSTANTS.turn,
                redemptionMs: redemptionRef.current,
                baseAssetPath: `${VOICE_ASSET_ROUTE}/`,
                onnxWASMBasePath: `${VOICE_ASSET_ROUTE}/`,
                // The page is not cross-origin isolated, so onnxruntime runs
                // on one thread.
                ortConfig: (ort) => {
                  ort.env.wasm.numThreads = 1;
                  ort.env.logLevel = "error";
                },
              },
              maxSpeechMs: VOICE_CONSTANTS.maxSpeechMs,
              onUtterance: (audio) => { void utteranceDone(audio); },
            });
          }
          return takerRef.current;
        }

        /** Release the listener entirely: detector, model and microphone. */
        async function closeTaker() {
          const taker = takerRef.current;
          takerRef.current = null;
          if (taker !== null) await taker.close();
        }

        /**
         * Close the microphone and say why: the microphone button going off, a
         * hidden page, or the person having walked away. The OS indicator goes
         * off because the device is released, not because data is ignored.
         * @param noticeKey the line to show, or null for the button itself.
         */
        async function closeMicrophone(noticeKey) {
          listeningRef.current = false;
          awayRef.current.reset();
          await takerRef.current?.hold();
          controlsRef.current.setDevice(false);
          publishControls();
          if (disposedRef.current) return;
          setNotice(noticeKey);
          if (statusRef.current === "listening" || statusRef.current === "calibrating") setPhase("ready");
        }

        /**
         * The microphone button.
         *
         * Off → release the device and clear any mute (there is nothing left to
         * mute). On → reopen it for the current call; permission failure is
         * reported with its own message and leaves the device off.
         */
        async function toggleMic() {
          const machine = controlsRef.current;
          awayRef.current.present(Date.now());
          if (machine.state().device) {
            await closeMicrophone(null);
            return;
          }
          if (!supported) {
            setError("errUnsupported");
            setPhase("error");
            return;
          }
          machine.setDevice(true);
          publishControls();
          setError(null);
          setNotice(null);
          await listen();
        }

        /**
         * The mute button: stop processing audio without touching the device.
         *
         * The detector pauses on the same live stream, so no frame is analysed
         * and a segment in progress is dropped; unmuting resumes detection
         * without asking for the microphone again.
         */
        function toggleMute() {
          const machine = controlsRef.current;
          if (!machine.state().device) return;
          machine.toggleMute();
          publishControls();
          const now = Date.now();
          awayRef.current.present(now);
          if (machine.state().muted) {
            listeningRef.current = false;
            awayRef.current.suspend(now);
            void takerRef.current?.mute();
            return;
          }
          if (statusRef.current !== "listening") return;
          void takerRef.current?.unmute().then(() => {
            if (!controlsRef.current.state().processing) return;
            listeningRef.current = true;
            awayRef.current.resume(Date.now());
          });
        }

        /** The pause that ends a turn, chosen in the settings. */
        function chooseRedemptionMs(ms) {
          redemptionRef.current = ms;
          setRedemptionMsState(ms);
          writeRedemptionMs(ms);
          takerRef.current?.setRedemptionMs(ms);
        }

        // ---- taking the dock out of the page --------------------------------

        /** The document the render should target: the detached one, or this one. */
        function renderDocument() {
          const pip = pipRef.current;
          if (pip !== null && pip.document !== undefined) return pip.document;
          return typeof document === "undefined" ? null : document;
        }

        /**
         * Move the dock into a Document Picture-in-Picture window, or a popup.
         *
         * This is a genuine change of host window: the call keeps running
         * because the React tree lives in this page and only its output moves.
         * The limits are stated rather than papered over:
         *   * Document PiP is Chrome/Edge 116+; it floats above other windows
         *     and dies with the page.
         *   * A popup is not always-on-top and may be blocked.
         *   * Neither survives minimizing the browser: a web page cannot draw
         *     outside its own windows. Desktop-pet persistence needs a native
         *     shell (Electron/Tauri), which this plugin does not ship.
         */
        async function detachDock() {
          const host = typeof window === "undefined" ? {} : window;
          if (detached) {
            closeDetached();
            return;
          }
          const pip = host.documentPictureInPicture;
          if (pipFailedRef.current !== true && pip !== null && pip !== undefined && typeof pip.requestWindow === "function") {
            try {
              const win = await pip.requestWindow({ width: 400, height: 340, disallowReturnToOpener: false });
              pipRef.current = win;
              win.addEventListener("pagehide", () => {
                pipRef.current = null;
                if (!disposedRef.current) setDetached(false);
              }, { once: true });
              copyStylesInto(win.document);
              setDetached(true);
              return;
            } catch (_error) {
              // No transient activation, or a Permissions-Policy refusal: fall
              // through to the popup on this and every later attempt.
              pipFailedRef.current = true;
              setError("detachFailed");
            }
          }
          if (typeof host.open === "function") {
            const win = host.open("", "discipline-whale-voice", "popup=yes,width=400,height=360");
            if (win !== null && win !== undefined) {
              pipRef.current = win;
              win.addEventListener("pagehide", () => {
                pipRef.current = null;
                if (!disposedRef.current) setDetached(false);
              }, { once: true });
              copyStylesInto(win.document);
              setDetached(true);
              setDetach(detachCapability(host, { pipFailed: pipFailedRef.current }));
              return;
            }
          }
          setError("detachFailed");
          setDetach(detachCapability(host, { pipFailed: true }));
        }

        /** Bring the dock back into the page. */
        function closeDetached() {
          const win = pipRef.current;
          pipRef.current = null;
          if (win !== null && win !== undefined) {
            try { win.close(); } catch (_error) { /* already gone */ }
          }
          if (!disposedRef.current) setDetached(false);
        }

        /** Re-create this plugin's styles inside the detached document. */
        function copyStylesInto(target) {
          if (target === undefined || target === null || target.head === null || target.head === undefined) return;
          if (target.querySelector?.('style[data-dsh-plugin="discipline-whale"]') !== null) return;
          const style = target.createElement("style");
          style.dataset.dshPlugin = "discipline-whale";
          style.textContent = dockStyles();
          target.head.appendChild(style);
          // The detached page gets one class and nothing else: what that class
          // looks like (margin, background, the dock filling the window) is the
          // stylesheet's business, so a replacement skin changes it there.
          if (target.body === undefined || target.body === null) return;
          target.body.classList.add("dw-detached");
          // The host's light/dark switch is an attribute on its own <body>; the
          // detached page mirrors it so the stylesheet picks the same palette.
          const dark = typeof document !== "undefined" && document.body?.hasAttribute?.("data-ds-dark-theme") === true;
          if (dark) target.body.setAttribute("data-ds-dark-theme", "");
        }

        // ---- dragging and edge snapping -------------------------------------

        /**
         * Pointer-event moving, stashing and resizing on the whole dock, no
         * library.
         *
         * Any part of the dock moves it: a press that travels further than
         * DRAG_THRESHOLD px is a drag, a press that does not is the click it
         * always was, and the click that ends a drag is swallowed
         * (`swallowDragClick`). Form fields keep their own pointer behaviour. A
         * press on a corner grip (`data-dw-resize`) resizes instead of moving.
         * Where a drag settles is `dockRelease`'s decision; how a resize clamps
         * is `dockResize`'s.
         *
         * Why no dependency: this file is plain JS in the shell's module wrapper
         * with no build step and no external URLs allowed, so a React drag
         * library (react-rnd pulls react-draggable pulls clsx + prop-types)
         * would have to be vendored by hand. Pointer Events plus `setPointerCapture`
         * cover move, resize, touch and pen in a few dozen lines.
         */
        function onDragStart(event) {
          suppressClickRef.current = false;
          if (event.button !== undefined && event.button !== 0) return;
          if (detached) return;
          const node = dockElRef.current;
          if (node === null || node === undefined) return;
          const target = event.target;
          if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
          const rect = node.getBoundingClientRect();
          const grip = target?.closest?.("[data-dw-resize]") ?? null;
          const card = node.querySelector?.(".dw-card") ?? null;
          const cardRect = card === null ? null : card.getBoundingClientRect();
          const viewportWidth = window.innerWidth;
          dragRef.current = {
            pointerId: event.pointerId,
            mode: grip !== null && cardRect !== null ? "resize" : "pending",
            corner: grip === null ? null : grip.getAttribute("data-dw-resize"),
            startX: event.clientX,
            startY: event.clientY,
            originX: rect.left,
            originY: rect.top,
            width: rect.width,
            height: rect.height,
            cardHeight: cardRect === null ? 0 : cardRect.height,
            room: { left: rect.left - 16, right: viewportWidth - rect.right - 16, top: rect.top - 16 },
          };
          // Follow the pointer at the document level from the first moment, so a
          // fast drag that leaves the dock before the threshold is still seen.
          // Capture waits for the threshold: capturing on press would retarget
          // the click away from the button that was pressed.
          const doc = node.ownerDocument ?? document;
          dragRef.current.listening = { doc, move: onDragMove, end: onDragEnd };
          doc.addEventListener("pointermove", onDragMove);
          doc.addEventListener("pointerup", onDragEnd);
          doc.addEventListener("pointercancel", onDragEnd);
          if (grip !== null) {
            capturePointer(event.pointerId);
            event.preventDefault();
          }
        }

        function onDragMove(event) {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          const node = dockElRef.current;
          if (node === null || node === undefined) return;
          const dx = event.clientX - drag.startX;
          const dy = event.clientY - drag.startY;
          if (drag.mode === "resize") {
            const next = dockResize({ width: drag.width, cardHeight: drag.cardHeight, dx, dy, corner: drag.corner, room: drag.room });
            drag.size = next;
            // Size travels as two numbers too; the stylesheet decides which
            // boxes they size.
            node.setAttribute("data-dw-sized", "true");
            node.style.setProperty("--dw-dock-w", String(Math.round(next.width)));
            node.style.setProperty("--dw-card-h", String(Math.round(next.cardHeight)));
            return;
          }
          if (drag.mode === "pending") {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            drag.mode = "move";
            capturePointer(event.pointerId);
            node.setAttribute("data-dw-dragging", "true");
            try { node.ownerDocument?.getSelection?.()?.removeAllRanges(); } catch (_error) { /* nothing selected */ }
          }
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const left = drag.originX + dx;
          const top = drag.originY + dy;
          // Follow the pointer in the same terms the stylesheet anchors by: the
          // nearer side and the bottom. The drag code never names a CSS box
          // property, so a replacement skin can lay the dock out differently.
          const anchor = left + drag.width / 2 < viewport.width / 2 ? "left" : "right";
          node.setAttribute("data-dw-anchor", anchor);
          node.style.setProperty("--dw-dock-x", String(Math.round(anchor === "left" ? left : viewport.width - left - drag.width)));
          node.style.setProperty("--dw-dock-y", String(Math.round(viewport.height - top - drag.height)));
          // Show where letting go would land: stashed on an edge, or open again.
          const settle = dockRelease({ left, top, width: drag.width, height: drag.height, viewport, docked: isStashed(), expanded: expandedSize() });
          const change = isStashed() ? (settle.docked === null ? "open" : null) : (settle.docked === null ? null : "dock");
          if (change === null) node.removeAttribute("data-dw-preview");
          else node.setAttribute("data-dw-preview", change);
        }

        function onDragEnd(event) {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          const listening = drag.listening;
          listening.doc.removeEventListener("pointermove", listening.move);
          listening.doc.removeEventListener("pointerup", listening.end);
          listening.doc.removeEventListener("pointercancel", listening.end);
          releasePointer(event.pointerId);
          const node = dockElRef.current;
          if (node !== null && node !== undefined) {
            node.removeAttribute("data-dw-dragging");
            node.removeAttribute("data-dw-preview");
          }
          if (drag.mode === "resize") {
            if (drag.size !== undefined) setSize(drag.size);
            return;
          }
          // A press that never moved far enough was a click; let it through.
          if (drag.mode !== "move") return;
          suppressClickRef.current = true;
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const settle = dockRelease({
            left: drag.originX + (event.clientX - drag.startX),
            top: drag.originY + (event.clientY - drag.startY),
            width: drag.width,
            height: drag.height,
            viewport,
            docked: isStashed(),
            expanded: expandedSize(),
          });
          // Remember the panel's size for its current shape (call panel or
          // closed pills), so reopening from the stashed button lands where that
          // shape actually fits.
          if (!isStashed()) expandedRef.current = { open, width: drag.width, height: drag.height };
          if (node !== null && node !== undefined) {
            // Write the settled geometry now as well: React only re-applies
            // props that changed, and the drag already moved the DOM.
            node.setAttribute("data-dw-anchor", settle.anchor);
            node.style.setProperty("--dw-dock-x", String(Math.round(settle.x)));
            node.style.setProperty("--dw-dock-y", String(Math.round(settle.y)));
          }
          setPlacement(settle);
        }

        /** The click that ends a drag lands on whatever was under the pointer; drop it. */
        function swallowDragClick(event) {
          if (!suppressClickRef.current) return;
          suppressClickRef.current = false;
          event.stopPropagation();
          event.preventDefault();
        }

        /**
         * The size the stashed button opens into: the last measured size of the
         * same shape, or the shape's usual size before it was ever measured.
         */
        function expandedSize() {
          const last = expandedRef.current;
          if (last !== null && last.open === open) return { width: last.width, height: last.height };
          return open ? { width: size?.width ?? 380, height: 240 } : { width: 190, height: 48 };
        }

        function isStashed() {
          return placement !== null && placement.docked !== null && !detached;
        }

        function capturePointer(pointerId) {
          try { dockElRef.current?.setPointerCapture(pointerId); } catch (_error) { /* older browsers */ }
        }

        function releasePointer(pointerId) {
          try { dockElRef.current?.releasePointerCapture(pointerId); } catch (_error) { /* already released */ }
        }

        /**
         * Show the call's conversation in the main view.
         *
         * The dock shows the latest exchange; the main view shows the whole
         * conversation. Both read the same main session, so opening it there
         * when a call starts and whenever an utterance is sent keeps what was
         * said and what came back visible in both places at once.
         */
        function showInMainView(sessionId) {
          try {
            if (typeof ctx.uiWorkspace?.openSession === "function") ctx.uiWorkspace.openSession(sessionId);
          } catch (_error) {
            // The main view keeps whatever it shows; the dock still has the text.
          }
        }

        // ---- the settings panel ---------------------------------------------

        /** Load the key-free description into the panel. */
        async function loadSettings() {
          setSettingsError(null);
          try {
            const response = await fetch(VOICE_SETTINGS_ROUTE, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const info = await response.json();
            setSettingsInfo(info);
            // The draft starts from what the server holds; the key is never part
            // of it, so an empty password box means "unchanged" until touched.
            setSettingsDraft({
              baseUrl: "",
              model: "",
              language: "",
              apiKey: "",
              apiKeyTouched: false,
              clearKey: false,
            });
            return info;
          } catch (_error) {
            setSettingsError("errUnreachable");
            return null;
          }
        }

        function openSettingsPanel() {
          setSettingsOpen(true);
          setSettingsPage("main");
          setSettingsSaved(false);
          setSettingsTest(null);
          void loadSettings();
        }

        /** Save the draft. An untouched key field is omitted, never sent empty. */
        async function saveSettings() {
          setSettingsBusy(true);
          setSettingsSaved(false);
          setSettingsError(null);
          const draft = {
            ...settingsDraft,
            apiKeyTouched: settingsDraft.apiKeyTouched === true || settingsDraft.clearKey === true,
            apiKey: settingsDraft.clearKey === true ? "" : settingsDraft.apiKey,
          };
          const patch = settingsDraftPatch(draft);
          try {
            const response = await fetch(VOICE_SETTINGS_ROUTE, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(patch),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              const code = payload?.error?.code;
              setSettingsError(errorKeyOf(String(code)));
              setSettingsBusy(false);
              return;
            }
            setSettingsInfo(payload);
            setSettingsDraft({ baseUrl: "", model: "", language: "", apiKey: "", apiKeyTouched: false, clearKey: false });
            setSettingsSaved(true);
          } catch (_error) {
            setSettingsError("errUnreachable");
          }
          setSettingsBusy(false);
        }

        /** One `/models` probe with the draft's values, never with the stored key echoed back. */
        async function testSettings() {
          setSettingsTesting(true);
          setSettingsTest(null);
          setSettingsError(null);
          const body = {};
          if (settingsDraft.baseUrl.trim() !== "") body.baseUrl = settingsDraft.baseUrl.trim();
          if (settingsDraft.apiKeyTouched === true && settingsDraft.apiKey !== "") body.apiKey = settingsDraft.apiKey;
          try {
            const response = await fetch(VOICE_TEST_ROUTE, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              setSettingsTest({ ok: false, message: String(payload?.error?.message ?? `HTTP ${response.status}`) });
            } else {
              setSettingsTest({ ok: payload.ok === true, message: String(payload.message ?? ""), code: payload.code });
            }
          } catch (_error) {
            setSettingsTest({ ok: false, message: t("errUnreachable") });
          }
          setSettingsTesting(false);
        }

        /** The session's lifecycle row (running flag), if the list knows it. */
        function sessionRow(sessionId) {
          return ctx.sessions?.list?.getSnapshot()?.byId?.[sessionId];
        }

        /** The durable event window of one session, or null when it is not retained. */
        function eventEntriesOf(sessionId) {
          const binding = ctx.sessions?.binding ? ctx.sessions.binding(sessionId) : undefined;
          const source = binding?.eventSource;
          if (source === undefined) return null;
          return source.getSnapshot()?.entries ?? [];
        }

        function callIsLive(call) {
          return guardRef.current !== null && guardRef.current.isCurrent(call);
        }

        function sleep(ms) {
          return new Promise((resolve) => window.setTimeout(resolve, ms));
        }

        /** Poll until the whale's turn settles, then read its reply from the window. */
        async function waitForReply(sessionId, call, baseline) {
          const deadline = Date.now() + VOICE_CONSTANTS.replyTimeoutMs;
          let started = false;
          while (Date.now() < deadline) {
            if (!callIsLive(call)) return null;
            const entries = eventEntriesOf(sessionId);
            if (sessionRow(sessionId)?.running === true) started = true;
            if (entries !== null && hasReplyAbove(entries, baseline)) started = true;
            if (started && sessionRow(sessionId)?.running !== true) {
              const text = entries === null ? "" : replyTextOf(entries, baseline);
              if (text !== "") return { text, partial: false };
            }
            await sleep(VOICE_CONSTANTS.pollMs);
          }
          const entries = eventEntriesOf(sessionId);
          const late = entries === null ? "" : replyTextOf(entries, baseline);
          return late === "" ? null : { text: late, partial: true };
        }


        /** Listen for the next utterance, unless the call is over or the whale is still working. */
        async function listen() {
          const call = callRef.current;
          if (call === null || !callIsLive(call) || disposedRef.current) return;
          if (!supported) {
            setError("errUnsupported");
            setPhase("error");
            return;
          }
          // Half-duplex: never listen while the whale is working.
          listeningRef.current = false;
          if (sessionRow(sessionRef.current)?.running === true) {
            await takerRef.current?.hold();
            setPhase("thinking");
            const until = Date.now() + VOICE_CONSTANTS.replyTimeoutMs;
            while (Date.now() < until && sessionRow(sessionRef.current)?.running === true) {
              if (!callIsLive(call)) return;
              await sleep(VOICE_CONSTANTS.pollMs);
            }
            if (!callIsLive(call)) return;
          }
          // The device must be on for a call to listen at all: the microphone
          // button is the device, and reopening it is its job, not listen()'s.
          if (!controlsRef.current.state().device) {
            setPhase("ready");
            return;
          }
          setUtteranceCount((n) => n + 1);
          setError(null);
          // The first listen loads the detector; later ones resume it.
          setPhase("calibrating");
          const muted = controlsRef.current.state().muted;
          try {
            await turnTaker().listen(muted);
          } catch (reason) {
            if (!callIsLive(call) || disposedRef.current) return;
            await closeTaker();
            // The DEVICE never opened (or the detector never loaded): reflect
            // that on the microphone control instead of leaving it showing "on".
            controlsRef.current.setDevice(false);
            publishControls();
            awayRef.current.reset();
            const denied = reason?.name === "NotAllowedError" || reason?.name === "SecurityError";
            setError(denied ? "errPermission" : reason?.code === "vad-load" ? "errVadLoad" : "errUnsupported");
            setPhase("error");
            return;
          }
          if (!callIsLive(call) || disposedRef.current) return;
          // The controls may have changed while the detector was starting.
          const now = controlsRef.current.state();
          if (!now.device) {
            await takerRef.current?.hold();
            setPhase("ready");
            return;
          }
          setPhase("listening");
          if (!now.processing) {
            if (!muted) await takerRef.current?.mute();
            return;
          }
          if (muted) await takerRef.current?.unmute();
          listeningRef.current = true;
          awayRef.current.resume(Date.now());
        }

        /**
         * One segment came back from the detector: check it was said into this
         * microphone, then send it. Half-duplex starts here: the microphone is
         * released until the whale's turn is over.
         */
        async function utteranceDone(audio) {
          const call = callRef.current;
          if (!listeningRef.current || call === null || !callIsLive(call) || disposedRef.current) return;
          listeningRef.current = false;
          awayRef.current.suspend(Date.now());
          await takerRef.current?.hold();
          if (speechLevelDbfs(audio, 16000) < VOICE_CONSTANTS.minSpeechLevelDbfs) {
            await refuseUtterance("noticeTooQuiet");
            return;
          }
          await submit(new Blob([encodeWav(audio, 16000)], { type: "audio/wav" }));
        }

        /**
         * A segment that was not said to the whale: count it, say so on the
         * card, and listen again, or close the microphone once refusals pile up.
         */
        async function refuseUtterance(noticeKey) {
          const call = callRef.current;
          awayRef.current.rejected();
          if (!callIsLive(call) || disposedRef.current) return;
          if (awayRef.current.reason(Date.now()) === "rejections") {
            await closeMicrophone("noticeAwayRejected");
            return;
          }
          setNotice(noticeKey);
          setPhase("ready");
          if (controlsRef.current.state().device) void listen();
        }

        /** One round trip: transcribe, hand over, wait for the reply, show it, maybe read it. */
        async function submit(blob) {
          const call = callRef.current;
          if (!callIsLive(call)) return;
          setPhase("transcribing");
          const language = uiLanguage();
          let response;
          try {
            response = await fetch(`${VOICE_ROUTE}?language=${language}`, {
              method: "POST",
              headers: { "content-type": "audio/wav" },
              body: blob,
            });
          } catch (_error) {
            if (!callIsLive(call) || disposedRef.current) return;
            setError("errUnreachable");
            setPhase("error");
            return;
          }
          if (!response.ok) {
            const code = await failureCodeOf(response);
            if (!callIsLive(call) || disposedRef.current) return;
            // Background sound and empty recognitions are not failures: the
            // segment simply was not for the whale.
            if (code === "voice/rejected-transcript" || code === "voice/empty-transcript") {
              await refuseUtterance("noticeRejected");
              return;
            }
            setError(errorKeyOf(code));
            setPhase("error");
            return;
          }
          const payload = await response.json();
          const text = typeof payload.text === "string" ? payload.text : "";
          // The late-result rule: hang up, or a newer utterance, drops this one.
          if (text === "" || !callIsLive(call) || disposedRef.current) return;
          const sessionId = sessionRef.current;
          if (sessionId === null || !guardRef.current.accepts(call, sessionId)) return;
          awayRef.current.accepted(Date.now());
          setNotice(null);
          setHeard(text);
          setPhase("thinking");
          showInMainView(sessionId);
          // The baseline is read HERE, not at call start: the whale must be
          // idle before we send, so "the turn above the current highest turn"
          // is unambiguously this utterance's reply.
          const before = eventEntriesOf(sessionId);
          baselineRef.current = before === null ? 0 : baselineTurnOf(before);
          let sent;
          try {
            sent = await fetch(VOICE_SAY_ROUTE, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text }),
            });
          } catch (_error) {
            if (!callIsLive(call) || disposedRef.current) return;
            setError("errUnreachable");
            setPhase("error");
            return;
          }
          if (!sent.ok) {
            const code = await failureCodeOf(sent);
            if (!callIsLive(call) || disposedRef.current) return;
            setError(errorKeyOf(code));
            setPhase("error");
            return;
          }
          const answer = await waitForReply(sessionId, call, baselineRef.current);
          if (answer === null) {
            if (!callIsLive(call) || disposedRef.current) return;
            setError("errReplyTimeout");
            setPhase("error");
            return;
          }
          if (!callIsLive(call) || disposedRef.current) return;
          setReply(answer.text);
          // Read-aloud is OFF by default. When it is off there is no speech
          // event to wait for, so the call returns to ready immediately — this
          // is the branch that used to stall on an `onend` that never fires.
          if (!speakRef.current) {
            setPhase("ready");
            if (controlsRef.current.state().device) void listen();
            return;
          }
          // Read-aloud is ON: stay in "speaking" so the microphone stays shut
          // (half-duplex), but never depend on `onend` alone — `speakReply`
          // also settles on error, on an engine refusal, and on a bounded
          // timer, so the call cannot wedge here.
          setPhase("speaking");
          const speech = speakReply(answer.text, {
            enabled: speakRef.current,
            synth: typeof speechSynthesis === "undefined" ? undefined : speechSynthesis,
            Utterance: typeof SpeechSynthesisUtterance === "undefined" ? undefined : SpeechSynthesisUtterance,
          });
          await speech.done;
          if (!callIsLive(call) || disposedRef.current) return;
          setPhase("ready");
          if (controlsRef.current.state().device) void listen();
        }

        /** "Done talking": end the segment now; with nothing said, say so and keep listening. */
        async function stopTalking() {
          awayRef.current.present(Date.now());
          const taker = takerRef.current;
          if (taker === null || !listeningRef.current) return;
          const delivered = await taker.finish();
          if (delivered || !callIsLive(callRef.current) || disposedRef.current) return;
          listeningRef.current = false;
          setNotice("errNoSpeech");
          setPhase("ready");
          if (controlsRef.current.state().device) void listen();
        }

        /** Start (or restart) the call. */
        async function startCall() {
          clearResult();
          setNotice(null);
          // Starting a call leaves the settings panel: the dock is the surface
          // the call belongs to, and a form in front of it would hide the mic.
          setSettingsOpen(false);
          const sessionId = await resolveMainSession({ fetch, sessions: ctx.sessions, workspaces: ctx.workspaces });
          if (sessionId === null) {
            setError("errNoMainSession");
            setPhase("error");
            return;
          }
          const previous = guardRef.current;
          if (previous !== null) previous.end("restart");
          sessionRef.current = sessionId;
          showInMainView(sessionId);
          // Retain the session so its event window exists even while the user
          // is on another panel; released on hangup and on unmount.
          if (watcherRef.current === null) watcherRef.current = createSessionWatcher(ctx.sessions);
          watcherRef.current.watch(sessionId);
          const guard = createCallGuard();
          guardRef.current = guard;
          guard.setTarget(sessionId);
          const call = guard.begin(`call-${Date.now()}`);
          callRef.current = call;
          awayRef.current.reset();
          setOpen(true);
          // Starting a call opens the device through the microphone control, so
          // "call in progress" and "microphone on" can never disagree. A refused
          // permission is handled inside listen() and leaves the control off.
          if (!controlsRef.current.state().device) {
            controlsRef.current.setDevice(true);
            publishControls();
          }
          await listen();
        }

        /** Hang up: close the mic, invalidate late results, stop the voice. */
        async function hangUp() {
          const guard = guardRef.current;
          const call = callRef.current;
          if (guard !== null && call !== null) guard.end(call.id);
          callRef.current = null;
          listeningRef.current = false;
          awayRef.current.reset();
          await closeTaker();
          watcherRef.current?.release();
          // Hanging up closes the DEVICE (the OS indicator must go off) and
          // resets both controls for the next call.
          controlsRef.current.setDevice(false);
          publishControls();
          closeDetached();
          if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
          if (!disposedRef.current) {
            setOpen(false);
            setNotice(null);
            setPhase("ready");
          }
        }

        /** The read-aloud fallback switch, shared by the dock bar and the settings page. */
        function toggleSpeak() {
          const next = !speakRef.current;
          setSpeak(next);
          speakRef.current = next;
          if (!next && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
        }

        const busy = status === "transcribing" || status === "thinking" || status === "speaking";

        // The dock may be rendered into a detached document (Document PiP or a
        // popup). React renders the same tree; only the host container changes.
        const container = renderDocument();
        const stashed = isStashed();
        const View = stashed
          ? dockedView({
            t,
            open,
            side: placement.docked,
            status,
            error,
            notice,
            controls,
            actions: {
              startCall: () => { void startCall(); },
              toggleMic: () => { void toggleMic(); },
            },
          })
          : settingsOpen
          ? settingsView({
            t,
            info: settingsInfo,
            draft: settingsDraft,
            set: (patch) => {
              // An edit after a save makes "Saved" stale; it reappears on the next save.
              setSettingsSaved(false);
              setSettingsDraft((current) => ({ ...current, ...patch }));
            },
            busy: settingsBusy,
            testing: settingsTesting,
            saved: settingsSaved,
            testResult: settingsTest,
            error: settingsError,
            page: settingsPage,
            speak,
            redemptionMs,
            actions: {
              save: () => { void saveSettings(); },
              test: () => { void testSettings(); },
              close: () => setSettingsOpen(false),
              navigate: setSettingsPage,
              toggleSpeak,
              chooseRedemptionMs,
            },
          })
          : !open
            ? h(
              "div",
              { className: "dw-dock dw-dock-closed" },
              h("button", {
                type: "button",
                className: "dw-call-button",
                title: t("callStart"),
                "aria-label": t("callStart"),
                onClick: () => { void startCall(); },
              }, h("span", { className: "dw-orb-mini", "aria-hidden": true }, h(VoiceGlyph, { size: 16 })), h("span", null, t("callStart"))),
              h("button", {
                type: "button",
                className: "dw-call-button dw-call-settings",
                title: t("settingsOpen"),
                "aria-label": t("settingsOpen"),
                onClick: openSettingsPanel,
              }, h(GearGlyph, { size: 18 }))
            )
            : dockView({
              t,
              status,
              error,
              notice,
              heard,
              reply,
              busy,
              controls,
              detached,
              utteranceCount,
              detach,
              speak,
              actions: {
                hangUp: () => { void hangUp(); },
                toggleMic: () => { void toggleMic(); },
                toggleMute,
                openSettings: openSettingsPanel,
                detach: () => { void detachDock(); },
                stopTalking: () => { void stopTalking(); },
                toggleSpeak,
              },
            });

        const surface = h("div", {
          className: "dw-dock-host",
          ref: dockElRef,
          "data-dw-anchor": placement === null ? undefined : placement.anchor,
          "data-dw-docked": stashed ? placement.docked : undefined,
          "data-dw-sized": size === null ? undefined : "true",
          style: dockGeometryStyle(placement, size),
          onPointerDown: onDragStart,
          onClickCapture: swallowDragClick,
        }, View);

        if (container !== undefined && container !== null && container !== document) {
          // Detached: portal the same React tree into the other document's body.
          // The state, refs and effects stay in this page — only the output
          // moves — which is what keeps the call running while the user works
          // elsewhere. If react-dom is unavailable the dock stays in-page and
          // the detach control reports the fallback instead of breaking.
          if (typeof createPortal === "function") {
            return createPortal(surface, container.body);
          }
        }
        return surface;
      };
    }

    function VoiceGlyph(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
        h("path", { d: "M5 11a7 7 0 0 0 14 0" }),
        h("path", { d: "M12 18v3" })
      );
    }

    /**
     * Every style the dock and the settings panel use, as one string.
     *
     * It is a function (not an inline literal) so the detached window can get
     * the same rules: `copyStylesInto` re-creates this exact stylesheet inside
     * the Document PiP / popup document, which otherwise renders unstyled.
     *
     * Colours come from the host's `--dsw-alias-*` theme tokens through a small
     * `--dw-*` layer on the dock host, so the dock follows the app's light/dark
     * switch. The detached document has no host stylesheet; it defines the few
     * tokens used here itself, light by default and dark when its body mirrors
     * the host's `data-ds-dark-theme`.
     */
    function dockStyles() {
      const orb = "radial-gradient(70% 55% at 50% 80%,rgba(255,255,255,.95) 0%,rgba(255,255,255,0) 72%),linear-gradient(180deg,#5b7cfa 0%,#93acff 45%,#e3eaff 100%)";
      const orbError = "radial-gradient(70% 55% at 50% 80%,rgba(255,255,255,.9) 0%,rgba(255,255,255,0) 72%),linear-gradient(180deg,#ef4444 0%,#f99a9a 45%,#ffe4e4 100%)";
      const lightTokens = "--dsw-alias-label-primary:rgb(15,17,21);--dsw-alias-label-secondary:rgb(97,102,107);--dsw-alias-label-tertiary:rgb(129,133,140);"
        + "--dsw-alias-bg-base:rgb(255,255,255);--dsw-alias-bg-layer-2:rgb(255,255,255);--dsw-alias-border-l2:rgba(0,0,0,.1);"
        + "--dsw-alias-interactive-bg-hover:rgba(38,49,72,.06);--dsw-alias-interactive-bg-active:rgba(38,49,72,.1)";
      const darkTokens = "--dsw-alias-label-primary:rgb(249,250,251);--dsw-alias-label-secondary:rgb(207,211,214);--dsw-alias-label-tertiary:rgb(173,178,184);"
        + "--dsw-alias-bg-base:rgb(21,21,23);--dsw-alias-bg-layer-2:rgb(44,44,46);--dsw-alias-border-l2:rgba(255,255,255,.12);"
        + "--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);--dsw-alias-interactive-bg-active:rgba(255,255,255,.14);"
        + "--dsw-alias-state-error-primary:rgb(242,90,90);--dsw-alias-state-business-primary:rgb(122,170,255)";
      return [
        // ---- the sidebar page: a quiet placeholder while the session opens ----
        ".dw-page{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary,#61666b)}",
        ".dw-retry{height:32px;padding:0 16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer}",
        ".dw-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}",

        // ---- theme layer ----
        ".dw-dock-host{--dw-fg:var(--dsw-alias-label-primary,#0f1115);--dw-fg-2:var(--dsw-alias-label-secondary,#61666b);--dw-fg-3:var(--dsw-alias-label-tertiary,#81858c);",
        "--dw-surface:var(--dsw-alias-bg-layer-2,#fff);--dw-line:var(--dsw-alias-border-l2,rgba(0,0,0,.1));",
        "--dw-fill:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));--dw-fill-2:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));",
        "--dw-accent:var(--dsw-alias-state-business-primary,#4176e6);--dw-danger:var(--dsw-alias-state-error-primary,#ec1313);",
        "--dw-ok:var(--dsw-alias-state-success-primary,#22c55e);--dw-warn:var(--dsw-alias-state-warn-primary,#f59e0b);",
        "--dw-shadow:0 1px 2px rgba(15,17,21,.05),0 8px 28px rgba(15,17,21,.10);",
        // The conversation composer is pinned to the bottom of the main view;
        // the dock floats above it so the send button stays reachable.
        "--dw-dock-bottom:144px}",

        // ---- geometry ----
        // The host is a transparent column anchored bottom-right; only its
        // children take the pointer, so the empty part of the column never
        // blocks the app underneath. Once moved, the logic publishes a side
        // (data-dw-anchor) and two numbers: --dw-dock-x, the distance from that
        // side, and --dw-dock-y, the distance from the bottom. Anchoring to the
        // bottom keeps the control bar still while the card above it grows.
        // Resizing publishes --dw-dock-w and --dw-card-h the same way.
        ".dw-dock-host{position:fixed;right:20px;bottom:var(--dw-dock-bottom);left:auto;top:auto;z-index:40;width:380px;max-width:calc(100vw - 32px);",
        "display:flex;flex-direction:column;align-items:stretch;gap:6px;pointer-events:none;color:var(--dw-fg);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased;",
        "touch-action:none;user-select:none;-webkit-user-select:none}",
        ".dw-dock-host>*{pointer-events:auto}",
        ".dw-dock-host[data-dw-anchor]{top:auto;bottom:calc(var(--dw-dock-y, 144) * 1px)}",
        ".dw-dock-host[data-dw-anchor='left']{left:calc(var(--dw-dock-x, 20) * 1px);right:auto}",
        ".dw-dock-host[data-dw-anchor='right']{right:calc(var(--dw-dock-x, 20) * 1px);left:auto}",
        ".dw-dock-host[data-dw-sized='true']{width:calc(var(--dw-dock-w, 380) * 1px);max-width:calc(100vw - 16px)}",
        ".dw-dock-host[data-dw-sized='true'] .dw-card{height:calc(var(--dw-card-h, 200) * 1px);max-height:none}",
        // The closed pills and the stashed button take only their own width,
        // so they sit against whichever side the host is anchored to.
        ".dw-dock-host:has(>.dw-dock-closed),.dw-dock-host[data-dw-docked]{width:auto}",
        ".dw-card,.dw-dock-closed,.dw-settings-head{cursor:grab}",
        ".dw-dock-host[data-dw-dragging='true'],.dw-dock-host[data-dw-dragging='true'] *{cursor:grabbing!important}",
        ".dw-transcript,.dw-settings-body{touch-action:pan-y}",
        ".dw-input{user-select:text;-webkit-user-select:text}",
        // While dragging: a panel about to be stashed fades and shrinks; a
        // stashed button about to open grows.
        ".dw-dock-host>*{transition:opacity .15s,transform .15s}",
        ".dw-dock-host[data-dw-preview='dock']>*{opacity:.55;transform:scale(.94)}",
        ".dw-dock-host[data-dw-preview='open']>*{transform:scale(1.12)}",

        // ---- shared bits ----
        ".dw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}",
        ".dw-dock-host button{font:inherit;-webkit-tap-highlight-color:transparent}",
        ".dw-dock-host button:focus-visible,.dw-input:focus-visible{outline:2px solid var(--dw-accent);outline-offset:2px}",
        ".dw-icon-button{flex:none;width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;border:0;background:transparent;color:var(--dw-fg-2);cursor:pointer;transition:background .15s,color .15s}",
        ".dw-icon-button:hover{background:var(--dw-fill);color:var(--dw-fg)}",
        // The host draws every corner as a superellipse; circles and pills opt
        // back into round corners, exactly as the host's own pills do.
        ".dw-dot,.dw-busy i,.dw-chip,.dw-icon-button,.dw-call-button,.dw-orb-mini,.dw-round,.dw-pill,.dw-ctl-mute,.dw-toggle,.dw-orb,.dw-orb-core,.dw-orb:after,",
        ".dw-switch,.dw-switch-thumb,.dw-badge,.dw-primary,.dw-secondary,.dw-retry{corner-shape:round}",
        ".dw-error{margin:0;padding:8px 12px;border-radius:12px;font-size:12.5px;line-height:1.5;color:var(--dw-danger);background:color-mix(in srgb,var(--dw-danger) 10%,transparent)}",
        ".dw-notice{flex:none;margin:0;padding:8px 12px;border-radius:12px;font-size:12.5px;line-height:1.5;color:var(--dw-fg-2);background:var(--dw-fill)}",

        // ---- the closed dock: start a call, or open settings ----
        ".dw-dock.dw-dock-closed{flex-direction:row;align-items:center;gap:8px}",
        ".dw-call-button{display:inline-flex;align-items:center;gap:10px;height:48px;padding:0 18px 0 6px;border-radius:999px;cursor:pointer;",
        "border:1px solid var(--dw-line);background:var(--dw-surface);color:var(--dw-fg);box-shadow:var(--dw-shadow);font-size:13.5px;font-weight:600;transition:transform .15s,background .15s}",
        ".dw-call-button:hover{background:color-mix(in srgb,var(--dw-surface),var(--dw-fg) 5%)}",
        ".dw-call-button:active{transform:scale(.97)}",
        ".dw-call-settings{width:48px;padding:0;justify-content:center;color:var(--dw-fg-2)}",
        `.dw-orb-mini{width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(160deg,#4f6ef7 0%,#7f9bff 60%,#b9c9ff 100%);box-shadow:inset 0 1px 3px rgba(255,255,255,.5)}`,
        ".dw-call-button:hover .dw-orb-mini{animation:dw-breathe 1.6s ease-in-out infinite}",

        // ---- the open dock: a card and a bar ----
        ".dw-dock{display:flex;flex-direction:column;gap:10px}",
        ".dw-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px 12px;border-radius:22px;max-height:min(52vh,440px);overflow:hidden;",
        "background:var(--dw-surface);border:1px solid var(--dw-line);box-shadow:var(--dw-shadow)}",
        // Resize grips sit in the card's top corners; only the one on the free
        // side shows, because the panel grows away from its anchored side.
        ".dw-card{position:relative;box-sizing:border-box}",
        ".dw-resize{position:absolute;top:0;z-index:1;width:16px;height:16px;opacity:0;transition:opacity .15s}",
        ".dw-resize:before{content:'';position:absolute;top:5px;width:7px;height:7px;border-top:2px solid var(--dw-fg-3)}",
        ".dw-resize-left{left:0;cursor:nwse-resize}",
        ".dw-resize-left:before{left:5px;border-left:2px solid var(--dw-fg-3);border-top-left-radius:4px}",
        ".dw-resize-right{right:0;cursor:nesw-resize}",
        ".dw-resize-right:before{right:5px;border-right:2px solid var(--dw-fg-3);border-top-right-radius:4px}",
        ".dw-card:hover .dw-resize{opacity:1}",
        ".dw-dock-host:not([data-dw-anchor='left']) .dw-resize-right,.dw-dock-host[data-dw-anchor='left'] .dw-resize-left{display:none}",
        ".dw-dock-head{flex:none;display:flex;align-items:center;gap:8px;min-height:28px}",
        ".dw-status{display:inline-flex;align-items:center;gap:8px;flex:1;min-width:0;font-weight:600}",
        ".dw-status-text{min-width:0}",
        ".dw-dot{width:8px;height:8px;border-radius:50%;background:var(--dw-fg-3);display:inline-block;flex:none}",
        ".dw-status-ready .dw-dot{background:var(--dw-ok)}",
        ".dw-status-listening .dw-dot,.dw-status-calibrating .dw-dot{background:var(--dw-danger);animation:dw-pulse 1.2s ease-in-out infinite}",
        ".dw-status-transcribing .dw-dot,.dw-status-thinking .dw-dot{background:var(--dw-warn)}",
        ".dw-status-speaking .dw-dot{background:var(--dw-accent)}",
        ".dw-status-muted .dw-dot{background:var(--dw-warn)}",
        ".dw-status-deviceoff .dw-dot{background:var(--dw-fg-3)}",
        ".dw-status-error .dw-dot{background:var(--dw-danger)}",
        ".dw-busy{display:inline-flex;align-items:center;gap:3px;flex:none}",
        ".dw-busy i{width:4px;height:4px;border-radius:50%;background:var(--dw-fg-3);animation:dw-bounce 1s ease-in-out infinite}",
        ".dw-busy i:nth-child(2){animation-delay:.15s}",
        ".dw-busy i:nth-child(3){animation-delay:.3s}",
        ".dw-chip{flex:none;height:26px;padding:0 12px;border-radius:999px;border:0;background:var(--dw-fg);color:var(--dw-surface);font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}",
        ".dw-chip:hover{opacity:.85}",
        ".dw-transcript{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;overscroll-behavior:contain}",
        ".dw-label{display:inline-flex;align-items:center;gap:4px;margin-bottom:4px;font-size:11px;color:var(--dw-fg-3)}",
        ".dw-heard{display:flex;flex-direction:column;align-items:flex-end}",
        ".dw-bubble{margin:0;max-width:85%;padding:8px 12px;border-radius:18px 18px 6px 18px;background:var(--dw-fill-2);word-break:break-word;white-space:pre-wrap}",
        ".dw-reply{display:flex;flex-direction:column;align-items:flex-start}",
        ".dw-reply-text{margin:0;word-break:break-word;white-space:pre-wrap}",
        ".dw-foot{flex:none;display:flex;flex-direction:column;gap:2px}",
        ".dw-fine,.dw-tts-note{margin:0;font-size:11px;line-height:1.45;color:var(--dw-fg-3)}",
        ".dw-fine{display:flex;align-items:flex-start;gap:5px}",
        ".dw-fine svg{flex:none;margin-top:2px}",
        // The cloud-upload notice reads one step stronger than the TTS note.
        ".dw-privacy{color:var(--dw-fg-2)}",

        // The bar: (settings) ( mute | orb | read-aloud ) (hang up).
        ".dw-bar{display:flex;align-items:center;justify-content:center;gap:10px}",
        ".dw-round{flex:none;width:52px;height:52px;padding:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;",
        "border:1px solid var(--dw-line);background:var(--dw-surface);color:var(--dw-fg);box-shadow:var(--dw-shadow);transition:transform .15s,background .15s}",
        ".dw-round:hover{background:color-mix(in srgb,var(--dw-surface),var(--dw-fg) 6%)}",
        ".dw-round:active,.dw-ctl:active:not(:disabled),.dw-toggle:active{transform:scale(.94)}",
        ".dw-round.dw-hangup{border-color:transparent;background:var(--dw-danger);color:#fff}",
        ".dw-round.dw-hangup:hover{background:color-mix(in srgb,var(--dw-danger),#000 12%)}",
        ".dw-pill{display:flex;align-items:center;gap:2px;height:52px;padding:0 4px;box-sizing:border-box;border-radius:999px;border:1px solid var(--dw-line);background:var(--dw-surface);box-shadow:var(--dw-shadow)}",
        ".dw-sep{flex:none;width:1px;height:22px;background:var(--dw-line)}",
        // Mute and read-aloud: quiet round icons; each pressed state has its own
        // colour (mute warns, read-aloud is the accent), never a shared look.
        ".dw-ctl-mute,.dw-toggle{flex:none;width:44px;height:44px;padding:0;border-radius:50%;border:0;display:inline-flex;align-items:center;justify-content:center;",
        "background:transparent;color:var(--dw-fg);cursor:pointer;transition:background .15s,color .15s,transform .15s}",
        ".dw-ctl-mute:hover:not(:disabled),.dw-toggle:hover{background:var(--dw-fill)}",
        ".dw-ctl-mute:disabled{color:var(--dw-fg-3);opacity:.45;cursor:not-allowed}",
        ".dw-ctl-mute.is-on,.dw-ctl-mute.is-on:hover:not(:disabled){color:var(--dw-warn);background:color-mix(in srgb,var(--dw-warn) 15%,transparent)}",
        ".dw-toggle.is-on,.dw-toggle.is-on:hover{color:var(--dw-accent);background:color-mix(in srgb,var(--dw-accent) 13%,transparent)}",
        // The orb is the microphone (device) control; its motion is the status.
        ".dw-ctl-mic.dw-orb{position:relative;flex:none;width:52px;height:52px;margin:0 6px;padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer;isolation:isolate;transition:transform .15s}",
        `.dw-orb-core{position:absolute;inset:4px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#fff;background:${orb};`,
        "box-shadow:inset 0 2px 6px rgba(255,255,255,.6),inset 0 -4px 10px rgba(60,80,220,.22),0 0 0 1px rgba(91,124,250,.14);transition:filter .3s,transform .3s}",
        ".dw-orb-core:before{content:'';position:absolute;inset:-35%;background:conic-gradient(from 0deg,rgba(255,255,255,0),rgba(255,255,255,.6) 18%,rgba(150,180,255,0) 40%,rgba(255,255,255,.45) 70%,rgba(255,255,255,0));filter:blur(5px);opacity:0;transition:opacity .3s}",
        ".dw-orb-core svg{position:relative;opacity:0;transition:opacity .2s}",
        ".dw-orb:after{content:'';position:absolute;inset:4px;border-radius:50%;pointer-events:none}",
        ".dw-status-ready .dw-orb-core{animation:dw-breathe 4s ease-in-out infinite}",
        ".dw-status-calibrating .dw-orb-core{animation:dw-breathe 1.6s ease-in-out infinite}",
        ".dw-status-calibrating .dw-orb-core:before{opacity:.55;animation:dw-spin 3s linear infinite}",
        ".dw-status-listening .dw-orb-core{animation:dw-breathe 1.4s ease-in-out infinite}",
        ".dw-status-listening .dw-orb-core:before{opacity:1;animation:dw-spin 2.4s linear infinite}",
        ".dw-status-listening .dw-orb:after{animation:dw-ripple 1.6s ease-out infinite}",
        ".dw-status-transcribing .dw-orb-core,.dw-status-thinking .dw-orb-core{transform:scale(.88)}",
        ".dw-status-transcribing .dw-orb-core:before,.dw-status-thinking .dw-orb-core:before{opacity:1;animation:dw-spin .9s linear infinite}",
        ".dw-status-speaking .dw-orb-core{filter:hue-rotate(40deg) saturate(1.2);animation:dw-talk .45s ease-in-out infinite alternate}",
        ".dw-status-muted .dw-orb-core{filter:saturate(.2) brightness(.96)}",
        ".dw-status-deviceoff .dw-orb-core{filter:grayscale(1) brightness(.72)}",
        ".dw-status-deviceoff .dw-orb-core svg{opacity:1}",
        `.dw-status-error .dw-orb-core{background:${orbError}}`,
        // Stashed against an edge: the microphone button alone, on its own disc.
        ".dw-dock-docked{display:flex}",
        ".dw-dock-docked .dw-orb{position:relative;flex:none;width:60px;height:60px;margin:0;padding:0;border-radius:50%;cursor:pointer;isolation:isolate;",
        "background:var(--dw-surface);border:1px solid var(--dw-line);box-shadow:var(--dw-shadow)}",
        ".dw-dock-docked .dw-orb-core,.dw-dock-docked .dw-orb:after{inset:6px}",
        ".dw-orb-start .dw-orb-core svg{opacity:1}",
        ".dw-status-idle .dw-orb-core{animation:dw-breathe 4s ease-in-out infinite}",
        "@keyframes dw-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
        "@keyframes dw-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}",
        "@keyframes dw-spin{to{transform:rotate(360deg)}}",
        "@keyframes dw-ripple{0%{box-shadow:0 0 0 0 rgba(91,124,250,.45)}100%{box-shadow:0 0 0 12px rgba(91,124,250,0)}}",
        "@keyframes dw-talk{from{transform:scale(.95)}to{transform:scale(1.07)}}",
        "@keyframes dw-bounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-3px);opacity:1}}",
        "@media (prefers-reduced-motion:reduce){.dw-dock-host *,.dw-dock-host *:before,.dw-dock-host *:after{animation:none!important;transition:none!important}}",

        // ---- the settings panel ----
        ".dw-settings{display:flex;flex-direction:column;max-height:min(600px,calc(100vh - var(--dw-dock-bottom) - 40px));border-radius:22px;overflow:hidden;",
        "background:var(--dw-surface);border:1px solid var(--dw-line);box-shadow:var(--dw-shadow)}",
        ".dw-settings-head{flex:none;display:flex;align-items:center;gap:6px;min-height:48px;padding:8px 12px 4px 18px;box-sizing:border-box}",
        ".dw-settings:not([data-dw-page='main']) .dw-settings-head{padding-left:10px}",
        ".dw-settings-title{margin:0;flex:1;min-width:0;font-size:15px;font-weight:600}",
        ".dw-settings-body{display:flex;flex-direction:column;gap:16px;padding:6px 16px 18px;overflow:auto;overscroll-behavior:contain}",
        ".dw-section{display:flex;flex-direction:column;gap:6px}",
        ".dw-section-title{margin:0 4px;font-size:12px;font-weight:600;color:var(--dw-fg-3)}",
        ".dw-group{display:flex;flex-direction:column;border-radius:14px;background:var(--dw-fill);overflow:hidden}",
        ".dw-row{display:flex;align-items:center;gap:12px;width:100%;min-height:46px;padding:10px 14px;box-sizing:border-box;border:0;background:transparent;color:inherit;text-align:left}",
        ".dw-group>.dw-row+.dw-row{box-shadow:inset 0 1px 0 var(--dw-line)}",
        ".dw-row-plain{padding:4px 2px}",
        ".dw-row-nav{cursor:pointer;transition:background .15s}",
        ".dw-row-nav:hover{background:var(--dw-fill)}",
        ".dw-row-nav svg{flex:none;color:var(--dw-fg-3)}",
        ".dw-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
        ".dw-row-title{flex:1;min-width:0;font-weight:500}",
        ".dw-row-text .dw-row-title{flex:none}",
        ".dw-row-sub{font-size:11.5px;line-height:1.45;color:var(--dw-fg-3)}",
        ".dw-row-value{min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dw-fg-3)}",
        ".dw-badge{flex:none;padding:2px 8px;border-radius:999px;font-size:11px;background:var(--dw-fill-2);color:var(--dw-fg-2)}",
        ".dw-source .dw-row-text{font-size:12.5px}",
        ".dw-source .dw-dot{background:var(--dw-ok)}",
        ".dw-source[data-dw-source='none'] .dw-dot{background:var(--dw-warn)}",
        ".dw-source[data-dw-source='unknown'] .dw-dot{background:var(--dw-fg-3)}",
        ".dw-link{flex:none;padding:4px 2px;border:0;background:transparent;color:var(--dw-accent);font-weight:600;cursor:pointer}",
        ".dw-link:disabled{opacity:.5;cursor:default}",
        ".dw-switch{position:relative;flex:none;width:44px;height:26px;padding:0;border:0;border-radius:999px;background:color-mix(in srgb,var(--dw-fg) 18%,transparent);cursor:pointer;transition:background .2s}",
        ".dw-switch-thumb{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}",
        ".dw-switch.is-on{background:var(--dw-accent)}",
        ".dw-switch.is-on .dw-switch-thumb{transform:translateX(18px)}",
        ".dw-row-danger .dw-switch.is-on{background:var(--dw-danger)}",
        ".dw-field{display:flex;flex-direction:column;gap:6px}",
        ".dw-field-label{font-size:12px;font-weight:600;color:var(--dw-fg-2)}",
        ".dw-field-hint{font-size:11px;line-height:1.45;color:var(--dw-fg-3)}",
        ".dw-input{width:100%;height:36px;box-sizing:border-box;padding:0 12px;border-radius:10px;font:inherit;font-size:13px;",
        "border:1px solid transparent;background:var(--dw-fill);color:var(--dw-fg);transition:border-color .15s,background .15s}",
        ".dw-input::placeholder{color:var(--dw-fg-3)}",
        ".dw-select{flex:none;height:32px;padding:0 10px;border-radius:10px;border:1px solid var(--dw-line);background:var(--dw-surface);color:var(--dw-fg);font:inherit;font-size:12.5px;cursor:pointer}",
        ".dw-select:focus-visible{outline:2px solid var(--dw-accent);outline-offset:2px}",
        ".dw-input:hover:not(:disabled){background:var(--dw-fill-2)}",
        ".dw-input:focus{outline:none;border-color:var(--dw-accent);background:var(--dw-surface)}",
        ".dw-input:disabled{opacity:.55;cursor:not-allowed}",
        ".dw-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".dw-primary,.dw-secondary{height:36px;padding:0 18px;border-radius:999px;font-weight:600;cursor:pointer;transition:opacity .15s,background .15s}",
        ".dw-primary{border:0;background:var(--dw-fg);color:var(--dw-surface)}",
        ".dw-primary:hover:not(:disabled){opacity:.86}",
        ".dw-secondary{border:1px solid var(--dw-line);background:transparent;color:var(--dw-fg)}",
        ".dw-secondary:hover:not(:disabled){background:var(--dw-fill)}",
        ".dw-primary:disabled,.dw-secondary:disabled{opacity:.5;cursor:default}",
        ".dw-saved{font-size:12px;color:var(--dw-ok)}",
        ".dw-test{margin:0;font-size:12px;line-height:1.5}",
        ".dw-test.is-ok{color:var(--dw-ok)}",
        ".dw-test.is-bad{color:var(--dw-danger)}",
        ".dw-settings-note{margin:0 4px;font-size:11.5px;line-height:1.5;color:var(--dw-fg-3)}",
        ".dw-tts-block{display:flex;flex-direction:column;gap:14px}",
        ".dw-settings .dw-tts-note{font-size:12px;line-height:1.55;color:var(--dw-fg-2)}",

        // ---- the detached window: the dock becomes the page ----
        `body.dw-detached{${lightTokens};margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);`,
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}",
        `body.dw-detached[data-ds-dark-theme]{${darkTokens}}`,
        "body.dw-detached .dw-dock-host{position:static;width:auto;max-width:none;height:100vh;box-sizing:border-box;padding:12px}",
        "body.dw-detached .dw-resize{display:none}",
        "body.dw-detached .dw-dock-host[data-dw-sized]{width:auto;max-width:none}",
        "body.dw-detached .dw-dock-host[data-dw-sized] .dw-card{height:auto}",
        "body.dw-detached .dw-dock,body.dw-detached .dw-settings{flex:1;min-height:0;max-height:none}",
        "body.dw-detached .dw-card{flex:1;min-height:0;max-height:none;box-shadow:none}",
        "body.dw-detached .dw-round,body.dw-detached .dw-pill,body.dw-detached .dw-settings{box-shadow:none}",

        // ---- narrow windows ----
        "@media (max-width:768px){.dw-dock-host{right:8px;width:calc(100vw - 16px);max-width:none}.dw-card{max-height:42vh}.dw-settings{max-height:calc(100vh - var(--dw-dock-bottom) - 24px)}}",
      ].join("\n");
    }

    function installStyles() {
      const style = document.createElement("style");
      style.dataset.dshPlugin = "discipline-whale";
      style.textContent = dockStyles();
      document.head.appendChild(style);
      return () => style.remove();
    }

    // ---- activation -------------------------------------------------------

    function apply(ctx) {
      ctx.effect(installStyles, "discipline-whale: styles");
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "discipline-whale: dictionaries");
      const t = ctx.locale.bind(NS);
      const WhalePage = makeWhalePage(ctx, t);
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, WhalePage)
      );
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => t("panel") }, WhaleIcon)
      );
      // The voice dock floats over every panel, so a call survives navigation
      // to the conversation and back — the point of a phone-like mode.
      const VoiceDock = makeVoiceDock(ctx, t);
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "discipline-whale-voice", order: VOICE_DOCK_ORDER, locale: NS },
          VoiceDock
        )
      );
    }

    module.exports.inject = ["slots", "locale", "layout", "uiWorkspace", "workspaces", "sessions"];
    module.exports.apply = apply;
    // For the tests; the host reads only inject and apply.
    module.exports.isLive = isLive;
    module.exports.DICTIONARIES = DICTIONARIES;
    module.exports.VOICE_CONSTANTS = VOICE_CONSTANTS;
    module.exports.createTurnTaker = createTurnTaker;
    module.exports.createAwayGuard = createAwayGuard;
    module.exports.speechLevelDbfs = speechLevelDbfs;
    module.exports.createCallGuard = createCallGuard;
    module.exports.createCallControls = createCallControls;
    module.exports.detachCapability = detachCapability;
    module.exports.snapDockPosition = snapDockPosition;
    module.exports.dockRelease = dockRelease;
    module.exports.dockResize = dockResize;
    module.exports.dockGeometryStyle = dockGeometryStyle;
    module.exports.dockedView = dockedView;
    module.exports.settingsDraftPatch = settingsDraftPatch;
    module.exports.dockView = dockView;
    module.exports.dockStyles = dockStyles;
    module.exports.settingsView = settingsView;
    module.exports.baselineTurnOf = baselineTurnOf;
    module.exports.replyTextOf = replyTextOf;
    module.exports.speakable = speakable;
    module.exports.speakReply = speakReply;
    module.exports.speechLanguage = speechLanguage;
    module.exports.makeVoiceDock = makeVoiceDock;
    module.exports.createSessionWatcher = createSessionWatcher;
    module.exports.resolveMainSession = resolveMainSession;
    return module.exports;
  },
});
