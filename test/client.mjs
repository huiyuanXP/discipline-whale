/**
 * Browser-half tests for the voice dock.
 *
 * `client.js` is plain JS in the shell's module wrapper, so this harness gives
 * it the two globals it expects (`window.__ModuleLoader__` and `require`) and
 * then drives the exported logic directly. The microphone, MediaRecorder and
 * speechSynthesis themselves cannot run here; what is checked is everything
 * that must not drift:
 *
 *   1. the mirrored silence detector produces byte-identical decisions to the
 *      shared module the server tests exercise
 *   2. both dictionaries carry every voice key (no missing-copy regression)
 *   3. the dock registers into `shell.overlay`, so it survives navigation to
 *      the conversation
 *   4. the reply reader selects assistant text by turn and ignores the
 *      baseline turn that predates the call
 *
 * Run: node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  createCallGuard,
  createSilenceDetector,
} from '../voice-silence.js'

// --- load the browser half ------------------------------------------------

let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (next) => {
      definition = next
    },
  },
}

await import('../client.js')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
// The factory returns `module.exports` itself, the contract the shell's loader
// consumes; wrap it back into a `module` object so the assertions below read
// the same way the plugin's own code does.
const module = { exports: definition.factory((id) => {
  assert.equal(id, 'react')
  return React
}) }
delete globalThis.window

// --- 1. the mirrored detector --------------------------------------------

{
  const frames = []
  let seed = 12345
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < 900; i += 1) {
    // Three regimes: room tone, speech, room tone again, every 300 frames.
    const phase = Math.floor(i / 300)
    const amplitude = phase === 0 ? 0.004 + random() * 0.002
      : phase === 1 ? 0.25 + random() * 0.05
        : 0.004 + random() * 0.002
    frames.push({ amplitude, samples: 320 })
  }

  const shared = createSilenceDetector()
  const mirrored = module.exports.createSilenceDetector()
  for (const [index, frame] of frames.entries()) {
    const samplesOf = (amplitude) => {
      const samples = new Float32Array(frame.samples)
      for (let i = 0; i < samples.length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000)
      return samples
    }
    const left = shared.push(samplesOf(frame.amplitude), 20)
    const right = mirrored.push(samplesOf(frame.amplitude), 20)
    assert.deepEqual(right, left, `frame ${index} must decide identically`)
  }
  assert.equal(shared.elapsedMs(), mirrored.elapsedMs())
  console.log('ok 1 — the browser detector mirrors the shared algorithm frame for frame')
}

{
  // Named constants are exported so a future change to 10s is one edit.
  assert.equal(module.exports.VOICE_CONSTANTS.silenceMs, 10_000)
  assert.equal(module.exports.VOICE_CONSTANTS.minSpeechMs, 500)
  assert.equal(module.exports.VOICE_CONSTANTS.maxRecordingMs, 60_000)
  assert.equal(module.exports.VOICE_CONSTANTS.minRecordingMs, 1_000)
  assert.equal(module.exports.VOICE_CONSTANTS.calibrationMs, 500)

  const guard = module.exports.createCallGuard()
  guard.setTarget('s1')
  const call = guard.begin('c1')
  assert.equal(guard.accepts(call, 's1'), true)
  guard.end('c1')
  assert.equal(guard.accepts(call, 's1'), false)
  console.log('ok 2 — the constants and the call guard ship with the browser half')
}

// --- 2. dictionaries ------------------------------------------------------

{
  const { zh, en } = module.exports.DICTIONARIES
  const voiceKeys = [
    'callStart', 'callHangup', 'statusReady', 'statusListening', 'statusTranscribing',
    'statusThinking', 'statusSpeaking', 'statusError', 'privacy',
    'speakOn', 'speakOff', 'speakHint', 'speakNote',
    'errPermission', 'errMissingKey', 'errInvalidKey', 'errNoModel', 'errUnreachable',
    'errTimeout', 'errTooLarge', 'errEmptyTranscript', 'errNoMainSession', 'errUnsupported',
  ]
  for (const key of voiceKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must exist`)
    assert.equal(typeof en[key], 'string', `en.${key} must exist`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} may not be empty`)
  }
  assert.match(zh.privacy, /SoCLaaS/)
  assert.match(en.privacy, /SoCLaaS/)

  // Read-aloud ships as a browser-synthesizer FALLBACK, and both languages must
  // describe it as exactly that: a fallback, not an integrated TTS channel.
  for (const [lang, copy] of [['zh', zh], ['en', en]]) {
    assert.match(copy.speakNote, /fallback|兜底|备用/i, `${lang}.speakNote must call it a fallback`)
    assert.match(copy.speakNote, /浏览器|browser/i, `${lang}.speakNote must name the browser synthesizer`)
    assert.match(copy.speakNote, /非真实\s*TTS|not a real TTS/i, `${lang}.speakNote must say it is not a real TTS`)
    assert.match(copy.speakNote, /默认关闭|off by default/i, `${lang}.speakNote must state the off default`)
    // It must NOT claim to be an integrated TTS.
    assert.equal(/已接入\s*TTS|TTS is integrated|integrated TTS channel/i.test(copy.speakNote), false,
      `${lang}.speakNote may not claim TTS is integrated`)
  }
  console.log('ok 3 — both dictionaries carry every voice key; read-aloud is described as a browser fallback')
}

// --- 3. the reply reader --------------------------------------------------

{
  const now = Date.now()
  const entries = [
    { type: 'event', event: { type: 'turn/start', seq: 1, time: now - 5_000, data: { turn: 1 } } },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 2,
        time: now - 4_900,
        data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '旧的回复' }] } },
      },
    },
    { type: 'event', event: { type: 'turn/end', seq: 3, time: now - 4_800, data: { turn: 1, reason: { kind: 'completed' } } } },
    { type: 'event', event: { type: 'turn/start', seq: 4, time: now, data: { turn: 2 } } },
    {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 5,
        time: now + 100,
        data: {
          turn: 2,
          step: 1,
          message: {
            id: 'm2',
            role: 'assistant',
            content: [
              { type: 'text', text: '第一段回复。' },
              { type: 'tool-call', id: 'c', name: 'list_dispatches', arguments: '{}' },
              { type: 'text', text: '第二段回复。' },
            ],
          },
        },
      },
    },
    { type: 'event', event: { type: 'turn/end', seq: 6, time: now + 200, data: { turn: 2, reason: { kind: 'completed' } } } },
  ]
  // At call start the window holds only the older turn, so turn 1 is the
  // baseline; the reply is whatever appears above it afterwards.
  const before = entries.slice(0, 3)
  const baseline = module.exports.baselineTurnOf(before)
  assert.equal(baseline, 1, 'the turn already on screen is the baseline')
  assert.equal(module.exports.replyTextOf(before, baseline), '', 'the old turn is never spoken')
  const text = module.exports.replyTextOf(entries, baseline)
  assert.equal(text, '第一段回复。第二段回复。', 'only the new turn is spoken, text blocks only')

  // The fallback read-aloud path keeps its markdown→speech shaper.
  const spoken = module.exports.speakable('## 结论\n\n- `dispatch_task` 已派工\n\n```js\nconst x = 1\n```\n完成。')
  assert.equal(/[`#*]/.test(spoken), false, 'markdown markers are stripped for speech')
  assert.equal(spoken.includes('const x = 1'), false, 'code blocks are not read aloud')
  assert.match(spoken, /结论/)
  assert.match(spoken, /完成/)
  // The speech tag stays BCP-47 for the synthesizer, while the transcription
  // hint stays the bare two-letter form.
  assert.match(module.exports.speechLanguage(), /^(zh-CN|en-US)$/)
  // The raw reply still carries its markdown: the dock shows it verbatim.
  const raw = '## 结论\n\n- `dispatch_task` 已派工'
  assert.equal(module.exports.replyTextOf([
    { type: 'event', event: { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: raw }] } } } },
  ], 2), raw)

  // No new turn means nothing to say.
  assert.equal(module.exports.replyTextOf(before, baseline), '')
  // A turn that closed with no assistant text yields nothing to read.
  assert.equal(module.exports.replyTextOf([{ type: 'event', event: { type: 'turn/start', seq: 9, data: { turn: 9 } } }], baseline), '')
  console.log('ok 4 — the reply reader takes only the new turn; the fallback speech shaper is restored')
}

// --- 3a. half-duplex: off must not wait, on must not hang ----------------

{
  // Two separate failure modes live here, and both must stay covered:
  //
  //   OFF (the default) — there is no speech event at all, so the reply path
  //   must not await one. Awaiting would park every call in "speaking" and
  //   never reopen the microphone.
  //
  //   ON — awaiting is correct, but the engine may never fire `onend`. The
  //   bounded timer must settle the promise anyway, or an opted-in call hangs.
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

  // --- DEFAULT OFF -------------------------------------------------------
  assert.match(source, /const \[speak, setSpeak\] = React\.useState\(false\)/,
    'read-aloud state must default to false')
  assert.match(source, /const speakRef = React\.useRef\(false\)/,
    'the ref read by the async reply path must default to false')

  // --- ASSERTION 1: OFF returns to ready without touching speech ---------
  const offStart = source.indexOf('if (!speakRef.current) {')
  const offEnd = source.indexOf('setPhase("speaking");', offStart)
  assert.ok(offStart > 0 && offEnd > offStart, 'the off-default branch exists before the speaking phase')
  const offBranch = source.slice(offStart, offEnd)
  assert.match(offBranch, /setPhase\("ready"\)/, 'off returns to ready')
  assert.match(offBranch, /void listen\(\)/, 'off reopens the microphone')
  const offCode = offBranch.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')
  assert.equal(/await/.test(offCode), false, 'the off branch must not await anything')
  assert.equal(/onend|speakReply|speechSynthesis|SpeechSynthesisUtterance/.test(offCode), false,
    'the off branch must not touch speech APIs at all')

  // --- ASSERTION 2: ON awaits, but the wait is bounded -------------------
  // Behavioural, not textual: drive the real speakReply with a fake engine
  // that accepts speak() and NEVER fires onend. Only the timeout can settle it.
  assert.equal(typeof module.exports.speakReply, 'function', 'speakReply is reachable for testing')
  const fakeSynth = {
    cancel() {},
    getVoices: () => [],
    speak() { /* deliberately never calls onend / onerror */ },
  }
  class FakeUtterance {
    constructor(text) { this.text = text; this.onend = null; this.onerror = null }
  }
  const timers = []
  const result = module.exports.speakReply('结论：已派工。', {
    enabled: true,
    synth: fakeSynth,
    Utterance: FakeUtterance,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  })
  assert.ok(result.done instanceof Promise, 'speakReply exposes a settle promise')
  assert.ok(result.speech instanceof FakeUtterance, 'the reply reached the engine')
  assert.match(result.speech.lang, /^(zh-CN|en-US)$/, 'the utterance carries a BCP-47 language tag')
  assert.equal(timers.length, 1, 'exactly one backstop timer is armed')
  assert.ok(timers[0].ms > 0 && timers[0].ms <= 120000, `the backstop is bounded (${timers[0].ms}ms)`)

  let settled = false
  result.done.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'an un-fired engine does NOT settle the promise by itself')
  timers[0].fn()
  await result.done
  assert.equal(settled, true, 'the bounded timer settles a call whose engine never fires onend')

  // A normal end settles it too, without waiting for the timer.
  const second = module.exports.speakReply('ok', {
    enabled: true, synth: fakeSynth, Utterance: FakeUtterance, setTimeout: () => 0,
  })
  second.speech.onend()
  await second.done

  // An engine that throws on speak() still settles.
  const third = module.exports.speakReply('ok', {
    enabled: true,
    synth: { cancel() {}, getVoices: () => [], speak() { throw new Error('no voice') } },
    Utterance: FakeUtterance,
    setTimeout: () => 0,
  })
  await third.done

  // Disabled never touches the engine.
  let spoke = 0
  const off = module.exports.speakReply('ok', {
    enabled: false,
    synth: { cancel() {}, getVoices: () => [], speak() { spoke += 1 } },
    Utterance: FakeUtterance,
    setTimeout: () => 0,
  })
  await off.done
  assert.equal(spoke, 0, 'disabled read-aloud never reaches the engine')
  assert.equal(off.speech, null)

  // --- the reply is always rendered, whatever speech does ----------------
  const replyIndex = source.indexOf('setReply(answer.text);')
  assert.ok(replyIndex > 0, 'the reply is still rendered')
  assert.match(source.slice(replyIndex, replyIndex + 900), /setPhase\("ready"\)/,
    'every reply path returns to ready')
  console.log('ok 3a — off returns to ready without awaiting; on is bounded by a timeout backstop')
}

// --- 3b. the session watcher ---------------------------------------------

{
  // Reading the reply requires the session's event window, which only exists
  // while somebody retains the session. If the user is looking at another
  // panel, nothing else does — so a call retains the main session itself and
  // releases it on hangup. Without this the reply would time out whenever the
  // whale's conversation is not the visible panel.
  assert.equal(typeof module.exports.createSessionWatcher, "function", "the watcher is exported")
  const retained = []
  const released = []
  const sessions = {
    retain(id, options) {
      retained.push({ id, source: options.source })
      return { sessionId: id, binding: { eventSource: { getSnapshot: () => ({ entries: [] }) } }, release: () => released.push(id) }
    },
    binding: () => undefined,
  }
  const watcher = module.exports.createSessionWatcher(sessions)
  const reference = watcher.watch("session-main")
  assert.equal(retained.length, 1)
  assert.equal(retained[0].id, "session-main")
  assert.equal(typeof retained[0].source, "string", "retain needs a declared source key")
  assert.ok(reference !== null)
  // A second watch replaces the first: one call, one reference.
  watcher.watch("session-main")
  assert.equal(released.length, 1, "re-watching releases the previous reference")
  watcher.release()
  assert.equal(released.length, 2)
  // Releasing twice is safe, and an unknown target must not throw.
  watcher.release()
  assert.equal(released.length, 2)
  assert.equal(module.exports.createSessionWatcher(undefined).watch("x"), null)
  console.log("ok 3b — a live call retains the main session and releases it on hangup")
}

// --- 3c. resolving the main session --------------------------------------

{
  // Pressing Call in a fresh profile must work: when no main session is
  // recorded, the dock creates one through the home route (the same POST the
  // sidebar entry uses) instead of failing with "no main session".
  assert.equal(typeof module.exports.resolveMainSession, "function")
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method })
    if (url === "/api/discipline-whale/home" && init?.method === "POST") {
      return { ok: true, json: async () => ({ mainSessionId: "session-new" }) }
    }
    return { ok: true, json: async () => ({ mainSessionId: null }) }
  }
  const sessions = {
    list: { getSnapshot: () => ({ ids: ["session-new"], byId: { "session-new": { id: "session-new" } } }) },
  }
  const id = await module.exports.resolveMainSession({ fetch: fetchImpl, sessions, workspaces: { list: { getSnapshot: () => ({}) } } })
  assert.equal(id, "session-new")
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"], "a missing session is created once")

  // A live recorded session is used as-is: no second creation.
  const calls2 = []
  const fetch2 = async (url, init) => {
    calls2.push(init?.method ?? "GET")
    return { ok: true, json: async () => ({ mainSessionId: "session-live" }) }
  }
  const liveSessions = {
    list: { getSnapshot: () => ({ ids: ["session-live"], byId: { "session-live": { id: "session-live" } } }) },
  }
  const id2 = await module.exports.resolveMainSession({ fetch: fetch2, sessions: liveSessions, workspaces: { list: { getSnapshot: () => ({}) } } })
  assert.equal(id2, "session-live")
  assert.deepEqual(calls2, ["GET"])

  // An archived session is not live: a new one is created.
  const calls3 = []
  const fetch3 = async (url, init) => {
    calls3.push(init?.method ?? "GET")
    if (init?.method === "POST") return { ok: true, json: async () => ({ mainSessionId: "session-fresh" }) }
    return { ok: true, json: async () => ({ mainSessionId: "session-archived" }) }
  }
  const id3 = await module.exports.resolveMainSession({
    fetch: fetch3,
    sessions,
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ["session-archived"] }) } },
  })
  assert.equal(id3, "session-fresh")
  assert.deepEqual(calls3, ["GET", "POST"])

  // A failing host answers null rather than throwing into the click handler.
  const broken = await module.exports.resolveMainSession({
    fetch: async () => ({ ok: false, status: 500 }),
    sessions,
    workspaces: { list: { getSnapshot: () => ({}) } },
  })
  assert.equal(broken, null)
  console.log("ok 3c — a call creates the main session when none is recorded, and never uses a dead one")
}

// --- 4. slot registration -------------------------------------------------

{
  const registered = []
  const injected = []
  // A minimal document stub: apply() installs one <style> element.
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, remove: () => {}, textContent: "" }),
    documentElement: { getAttribute: () => "zh-CN" },
  }
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, fn) => { injected.push(name); return fn() },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
    sessions: {},
    workspaces: { list: { getSnapshot: () => ({}) } },
    uiWorkspace: {},
    layout: {},
  }
  module.exports.apply(ctx)
  delete globalThis.document
  assert.deepEqual(injected.sort(), ['main', 'shell.overlay', 'sidebar.panellist'])
  const overlay = registered.find((entry) => entry.options.name === 'shell.overlay')
  assert.ok(overlay, 'the voice dock lives in shell.overlay so it survives navigation')
  assert.equal(overlay.options.id, 'discipline-whale-voice')
  assert.ok(overlay.options.order > 0)
  console.log('ok 5 — the dock registers into shell.overlay beside the whale page')
}

// --- 5. the dock's visible contract --------------------------------------

{
  // Render the open dock with forced hook values and walk the tree: the call
  // must show its status, what it heard, the reply, the hang-up control, and
  // the cloud-transcription notice. Copy that is invisible is not privacy.
  // Hook order: open, status, error, heard, reply, speak, utteranceCount,
  // supported, controls, detach, detached, then the settings panel's states.
  const forced = [
    true, "listening", null, "你好鲸鱼", "鲸鱼回复内容", false, 1, true,
    { device: true, muted: false, processing: true, muteEnabled: true },
    { mode: "document-pip", available: false, label: "detachNone" },
    false,
  ]
  let hook = 0
  const forcedReact = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useState: (initial) => [hook < forced.length ? forced[hook++] : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
  }
  globalThis.document = { createElement: () => ({ dataset: {}, remove: () => {}, textContent: "", style: {} }) }
  const dockDefinition = definition
  const dockModule = dockDefinition.factory(() => forcedReact)
  const Dock = dockModule.makeVoiceDock({ sessions: {} }, (key) => key)
  const tree = Dock()
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === "string") { texts.push(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node === "object") walk(node.children)
  }
  walk(tree)
  const joined = texts.join(" | ")
  assert.match(joined, /statusListening/, "the live status is visible")
  assert.match(joined, /你好鲸鱼/, "what was heard is visible")
  assert.match(joined, /鲸鱼回复内容/, "the reply is visible")
  assert.match(joined, /callHangup/, "hang-up is always available")
  assert.match(joined, /privacy/, "the cloud-transcription notice is rendered")
  // The read-aloud control is present but OFF (forced state `false` above), and
  // the fallback caveat is rendered next to it rather than implied.
  assert.match(joined, /speakOff/, "the read-aloud toggle renders its off state by default")
  assert.equal(/speakOn/.test(joined), false, "the dock must not render the on state while off")
  assert.match(joined, /speakNote/, "the browser-fallback caveat is visible")
  assert.equal(tree.props.role, undefined, "the outer host is not the dialog")
  const dialog = []
  const findDialog = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(findDialog); return }
    if (typeof node === "object") { dialog.push(node); findDialog(node.children) }
  }
  findDialog(tree)
  const dialogNode = dialog.find((node) => node.props?.role === "dialog")
  assert.ok(dialogNode, "the dock itself carries role=dialog")
  // The two controls are separate buttons with separate pressed states.
  const buttons = dialog.filter((node) => node.props?.["data-dw-control"] !== undefined)
  assert.deepEqual(buttons.map((node) => node.props["data-dw-control"]).sort(), ["mic", "mute"])
  const control = (name) => buttons.find((node) => node.props["data-dw-control"] === name)
  assert.deepEqual([control("mic").props["aria-pressed"], control("mute").props["aria-pressed"]], [true, false])
  assert.equal(Boolean(control("mute").props.disabled), false, "mute is available while the device is on")
  delete globalThis.document
  console.log("ok 6 — the open dock shows status, transcript, reply, hang-up, privacy, the read-aloud fallback and two separate controls")
}

// The shared guard is the same contract the browser mirrors.
{
  const guard = createCallGuard()
  guard.setTarget('s')
  const call = guard.begin('c')
  assert.equal(guard.accepts(call, 's'), true)
  assert.equal(guard.accepts(call, 'other'), false)
}

console.log('\nAll discipline-whale client checks passed.')
