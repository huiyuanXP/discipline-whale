/**
 * Dock tests for discipline-whale: the parts of the voice dock that can be
 * proven without a microphone, a second window, or a real browser.
 *
 * What is checked:
 *
 *   1. microphone (device) and mute (drop data) are two independent controls,
 *      and mute is unavailable while the device is off
 *   2. mute pauses vad-web's detector on the same open stream and drops the
 *      segment in progress
 *   3. holding for the reply releases the microphone; listening reopens it
 *   4. the window-detach capability is detected honestly: Document PiP, plain
 *      popup, or nothing
 *   5. edge snapping is pure arithmetic: clamp into the viewport, snap to the
 *      nearest edge, keep the margin
 *   6. the settings draft never carries a stored key it did not receive
 *   7. the render offers both controls and keeps the key field write-only
 *
 * Run: node test/dock.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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

/** A React stand-in: hooks return their initial value, effects never run. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const module = { exports: definition.factory((id) => {
  assert.equal(id, 'react')
  return React
}) }
delete globalThis.window

const dock = module.exports

// --- 1. two independent controls -----------------------------------------

{
  assert.equal(typeof dock.createCallControls, 'function', 'the control state machine must be exported')
  const controls = dock.createCallControls()

  // Starting point: device off, not muted, nothing processed.
  assert.deepEqual(controls.state(), { device: false, muted: false, processing: false, muteEnabled: false })

  // Mute cannot be engaged while the device is off, and asking does not lie.
  controls.toggleMute()
  assert.equal(controls.state().muted, false, 'mute must be refused while the microphone is off')
  assert.equal(controls.state().muteEnabled, false)

  // Device on: processing starts, mute becomes available.
  controls.setDevice(true)
  assert.deepEqual(controls.state(), { device: true, muted: false, processing: true, muteEnabled: true })

  // Mute is about data, not the device: the device stays on, processing stops.
  controls.toggleMute()
  assert.deepEqual(controls.state(), { device: true, muted: true, processing: false, muteEnabled: true })

  // Unmute restores processing immediately; the device never cycled.
  controls.toggleMute()
  assert.deepEqual(controls.state(), { device: true, muted: false, processing: true, muteEnabled: true })

  // Turning the device off releases a held mute rather than stranding it.
  controls.toggleMute()
  controls.setDevice(false)
  assert.deepEqual(controls.state(), { device: false, muted: false, processing: false, muteEnabled: false })
  console.log('ok 1 — microphone (device) and mute (drop data) are independent, and mute needs the device')
}

// --- 2–3. listening through vad-web's MicVAD -------------------------------

/** A microphone stream whose tracks can be stopped, like getUserMedia's. */
function fakeStream() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended' } }
  return { track, getTracks: () => [track] }
}

/**
 * A MicVAD stand-in with the real one's start/pause/stream contract
 * (@ricky0123/vad-web 0.0.31, dist/real-time-vad.js): start() asks
 * getStream() the first time and resumeStream() afterwards, pause() calls
 * pauseStream() and then either submits the segment in progress
 * (submitUserSpeechOnPause) or drops it. `speak` / `endSpeech` play the part
 * of Silero deciding speech started and ended.
 */
function fakeMicVAD(options) {
  const vad = {
    options: { ...options },
    state: 'uninitialized',
    listening: false,
    stream: null,
    speaking: false,
    segment: null,
    destroyed: false,
    async start() {
      if (vad.state === 'uninitialized') {
        vad.stream = await options.getStream()
        vad.state = 'initialized'
        vad.listening = true
        return
      }
      if (vad.state !== 'initialized' || vad.listening) return
      vad.listening = true
      vad.stream = await options.resumeStream(vad.stream)
    },
    async pause() {
      if (!vad.listening) return
      vad.listening = false
      await options.pauseStream(vad.stream)
      const speaking = vad.speaking
      vad.speaking = false
      if (vad.options.submitUserSpeechOnPause && speaking) options.onSpeechEnd(vad.segment)
    },
    async destroy() {
      vad.state = 'destroyed'
      if (vad.listening) await vad.pause()
      vad.destroyed = true
    },
    setOptions(update) { vad.options = { ...vad.options, ...update } },
    speak(seconds) {
      if (!vad.listening) return
      vad.speaking = true
      vad.segment = new Float32Array(Math.round(16000 * seconds)).fill(0.1)
      options.onSpeechStart()
      options.onSpeechRealStart()
    },
    endSpeech() {
      if (!vad.listening || !vad.speaking) return
      vad.speaking = false
      options.onSpeechEnd(vad.segment)
    },
  }
  return vad
}

/** A promise the test resolves by hand, to hold an await open. */
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

/**
 * One listener over the fake, with its microphone requests and timers on
 * record. `gates.model` / `gates.permission` hold the detector load and the
 * permission prompt open until the test releases them.
 */
function listenerHarness(gates = {}) {
  const record = { streams: [], utterances: [], timers: [], speaking: [], vad: null, created: null }
  const taker = dock.createTurnTaker({
    createVad: async (options) => {
      if (gates.model !== undefined) await gates.model.promise
      record.created = options
      record.vad = fakeMicVAD(options)
      return record.vad
    },
    getStream: async () => {
      if (gates.permission !== undefined) await gates.permission.promise
      const stream = fakeStream()
      record.streams.push(stream)
      return stream
    },
    options: { ...dock.VOICE_CONSTANTS.turn, redemptionMs: 2000 },
    maxSpeechMs: 60000,
    onUtterance: (audio) => record.utterances.push(audio),
    onSpeaking: (active) => record.speaking.push(active),
    setTimeout: (fn, ms) => { record.timers.push({ fn, ms, cancelled: false }); return record.timers.length - 1 },
    clearTimeout: (id) => { if (record.timers[id]) record.timers[id].cancelled = true },
  })
  return { taker, record }
}

{
  // Mute = processing off, device on. The detector pauses on the SAME live
  // stream, a segment in progress is dropped, and unmuting resumes without
  // asking for the microphone again.
  const { taker, record } = listenerHarness()
  await taker.listen(false)
  assert.equal(record.created.startOnLoad, false, 'the call decides when listening starts')
  assert.equal(record.created.positiveSpeechThreshold, 0.5)
  assert.equal(record.streams.length, 1)
  record.vad.speak(1)
  await taker.mute()
  assert.equal(record.utterances.length, 0, 'a segment cut by mute is dropped, never sent')
  assert.equal(record.streams[0].track.readyState, 'live', 'mute keeps the device open')
  record.vad.speak(1)
  record.vad.endSpeech()
  assert.equal(record.utterances.length, 0, 'nothing is analysed while muted')
  await taker.unmute()
  assert.equal(record.streams.length, 1, 'unmuting reuses the open stream')
  record.vad.speak(1)
  record.vad.endSpeech()
  assert.equal(record.utterances.length, 1, 'after unmute a finished segment is handed over')

  // Muted from the start: the device opens, detection does not run.
  const quiet = listenerHarness()
  await quiet.taker.listen(true)
  assert.equal(quiet.record.streams[0].track.readyState, 'live')
  assert.equal(quiet.record.vad.listening, false)
  console.log('ok 2 — mute pauses detection on the same open stream and drops the segment in progress')
}

{
  // Holding (microphone off, page hidden): the microphone is released (the OS
  // indicator goes off) and a segment in progress is dropped; listening again
  // asks for the microphone afresh.
  const { taker, record } = listenerHarness()
  await taker.listen(false)
  record.vad.speak(1)
  await taker.hold()
  assert.equal(record.streams[0].track.readyState, 'ended', 'hold releases the device')
  assert.equal(record.utterances.length, 0, 'the cut segment is dropped')
  await taker.listen(false)
  assert.equal(record.streams.length, 2, 'listening again reopens the microphone')
  assert.equal(record.streams[1].track.readyState, 'live')

  // Muted first, then held (microphone off, page hidden): the device must
  // still be released. MicVAD's own pause() does nothing once detection is
  // already paused, so hold() cannot rely on it.
  await taker.mute()
  await taker.hold()
  assert.equal(record.streams[1].track.readyState, 'ended', 'mute then hold releases the device')
  const mutedAtStart = listenerHarness()
  await mutedAtStart.taker.listen(true)
  await mutedAtStart.taker.hold()
  assert.equal(mutedAtStart.record.streams[0].track.readyState, 'ended', 'listen(muted) then hold releases the device')

  // Hanging up while the detector is still loading: nothing may start later.
  const loading = deferred()
  const early = listenerHarness({ model: loading })
  const pending = early.taker.listen(false).catch(() => {})
  await early.taker.close()
  loading.resolve()
  await pending
  assert.ok(early.record.streams.every((stream) => stream.track.readyState === 'ended'), 'a hang-up during loading leaves no live track')
  assert.equal(early.record.vad?.listening ?? false, false, 'and no detector running')

  // Hanging up while the permission prompt is open: the stream it grants
  // afterwards is stopped at once.
  const prompt = deferred()
  const asking = listenerHarness({ permission: prompt })
  const waiting = asking.taker.listen(false).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  await asking.taker.close()
  prompt.resolve()
  await waiting
  assert.ok(asking.record.streams.length <= 1)
  assert.ok(asking.record.streams.every((stream) => stream.track.readyState === 'ended'), 'a hang-up during the permission prompt leaves no live track')
  console.log('ok 3 — holding releases the microphone (muted or not), and a hang-up mid-start leaves nothing running')
}

// --- 4. window-detach capability -----------------------------------------

{
  const pipWindow = { document: { body: {}, head: {} }, addEventListener: () => {}, close: () => {} }
  const withPip = dock.detachCapability({
    documentPictureInPicture: { requestWindow: async () => pipWindow, window: null },
    open: () => null,
  })
  assert.equal(withPip.mode, 'document-pip')
  assert.equal(withPip.alwaysOnTop, true, 'Document PiP floats above other windows')
  assert.equal(withPip.survivesMinimize, false, 'no web API survives a minimized browser')
  assert.match(withPip.label, /Pip/i)

  const popupOnly = dock.detachCapability({ open: () => ({ closed: false }) })
  assert.equal(popupOnly.mode, 'window-open', 'without Document PiP a plain popup is the fallback')

  const nothing = dock.detachCapability({})
  assert.equal(nothing.mode, 'none', 'with neither API the dock stays in the page and says so')
  assert.equal(nothing.available, false)
  assert.equal(nothing.label, 'detachNone')

  // A thrown requestWindow (no user gesture, permissions policy) degrades to
  // the next available mode instead of breaking the call.
  const afterFailure = dock.detachCapability({
    documentPictureInPicture: { requestWindow: async () => { throw new Error('no gesture') }, window: null },
    open: () => null,
  }, { pipFailed: true })
  assert.equal(afterFailure.mode, 'window-open', 'a failed PiP request falls through to the popup on the next attempt')
  console.log('ok 4 — Document PiP is preferred, a popup is the fallback, and "in-page only" is stated')
}

// --- 5. edge snapping ----------------------------------------------------

{
  const viewport = { width: 1200, height: 800 }
  // Near the right edge → snaps flush to it.
  const right = dock.snapDockPosition({ x: 1000, y: 400, width: 320, height: 120, viewport, margin: 16 })
  assert.equal(right.edge, 'right')
  assert.equal(right.x, 1200 - 320 - 16)
  assert.equal(right.y, 400, 'the free axis is left where the user put it')

  // Near the left edge → snaps left.
  const left = dock.snapDockPosition({ x: 20, y: 400, width: 320, height: 120, viewport, margin: 16 })
  assert.equal(left.edge, 'left')
  assert.equal(left.x, 16)

  // Mid-screen → no snap, position kept.
  const middle = dock.snapDockPosition({ x: 400, y: 300, width: 320, height: 120, viewport, margin: 16 })
  assert.equal(middle.edge, null)
  assert.equal(middle.x, 400)

  // Off-screen input is clamped into the viewport on both axes.
  const clamped = dock.snapDockPosition({ x: 5000, y: -400, width: 320, height: 120, viewport, margin: 16 })
  assert.ok(clamped.x <= viewport.width - 320 - 16)
  assert.ok(clamped.y >= 16)

  // A dock wider than the viewport pins to the margin instead of going negative.
  const tiny = dock.snapDockPosition({ x: 0, y: 0, width: 900, height: 120, viewport: { width: 400, height: 300 }, margin: 8 })
  assert.equal(tiny.x, 8, 'an oversized dock clamps to the left margin, never a negative coordinate')
  assert.equal(tiny.edge, 'left')
  console.log('ok 5 — snapping is pure arithmetic: clamp, snap to the nearest edge, keep the margin')
}

// --- 6. the settings draft -----------------------------------------------

{
  assert.equal(typeof dock.settingsDraftPatch, 'function')
  // Untouched key field: the request must not carry a key at all, so an empty
  // password box cannot erase a stored key by accident.
  const untouched = dock.settingsDraftPatch({ baseUrl: ' https://x.test/v1 ', model: ' whisper-large-v3 ', language: 'zh', apiKey: '', apiKeyTouched: false })
  assert.deepEqual(untouched, { baseUrl: 'https://x.test/v1', model: 'whisper-large-v3', language: 'zh' })
  assert.equal('apiKey' in untouched, false, 'an untouched key field is omitted, not sent as empty')

  // Touched and emptied: this is the explicit clear.
  const cleared = dock.settingsDraftPatch({ baseUrl: '', model: '', language: '', apiKey: '', apiKeyTouched: true })
  assert.equal(cleared.apiKey, '', 'an explicitly cleared key is sent as empty, which means unset')

  // Touched with a value: sent as typed, never trimmed into something else.
  const typed = dock.settingsDraftPatch({ baseUrl: '', model: '', language: '', apiKey: 'sk-typed-0123456789', apiKeyTouched: true })
  assert.equal(typed.apiKey, 'sk-typed-0123456789')
  console.log('ok 6 — the settings draft omits an untouched key and only sends a clear on purpose')
}

// --- 7. the render -------------------------------------------------------

{
  // The dock renders with defaults: device off, so mute is disabled and the
  // two controls are visibly separate.
  const Dock = dock.makeVoiceDock({ sessions: {} }, (key) => key)
  // The closed state is what mounts by default; open it by rendering the open
  // branch directly through the exported view builder.
  const openView = dock.dockView({
    controls: dock.createCallControls(),
    status: 'ready',
    error: null,
    heard: '',
    reply: '',
    detach: { mode: 'document-pip', label: 'detachPip', available: true },
    t: (key) => key,
    actions: { start: () => {}, hangUp: () => {}, stopTalking: () => {}, toggleMic: () => {}, toggleMute: () => {}, openSettings: () => {}, detach: () => {} },
  })
  const nodes = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node === 'object') { nodes.push(node); walk(node.children) }
  }
  walk(openView)
  const mic = nodes.find((node) => node.props?.['data-dw-control'] === 'mic')
  const mute = nodes.find((node) => node.props?.['data-dw-control'] === 'mute')
  assert.ok(mic, 'the microphone control is rendered')
  assert.ok(mute, 'the mute control is rendered beside it')
  assert.equal(mic.props['aria-pressed'], false)
  assert.equal(mute.props['aria-pressed'], false)

  // They are independent, not two views of one flag: with the device on and
  // the call muted, the microphone reads pressed and mute reads pressed; with
  // the device on and unmuted, the microphone still reads pressed while mute
  // reads unpressed. A single shared control cannot produce both.
  const viewWith = (state) => {
    const controls = dock.createCallControls()
    controls.setDevice(state.device === true)
    if (state.muted === true) controls.toggleMute()
    return dock.dockView({
      controls,
      status: 'ready',
      error: null,
      heard: '',
      reply: '',
      detach: { available: true },
      t: (key) => key,
      actions: { start: () => {}, hangUp: () => {}, stopTalking: () => {}, toggleMic: () => {}, toggleMute: () => {}, openSettings: () => {}, detach: () => {} },
    })
  }
  const readControls = (tree) => {
    const found = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node === 'string') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (typeof node === 'object') { found.push(node); visit(node.children) }
    }
    visit(tree)
    return {
      mic: found.find((node) => node.props?.['data-dw-control'] === 'mic'),
      mute: found.find((node) => node.props?.['data-dw-control'] === 'mute'),
    }
  }
  const unmuted = readControls(viewWith({ device: true, muted: false }))
  assert.deepEqual([unmuted.mic.props['aria-pressed'], unmuted.mute.props['aria-pressed']], [true, false])
  const muted = readControls(viewWith({ device: true, muted: true }))
  assert.deepEqual([muted.mic.props['aria-pressed'], muted.mute.props['aria-pressed']], [true, true])
  assert.equal(muted.mic.props.disabled, undefined, 'the microphone button is never disabled by mute')
  assert.equal(mute.props.disabled, true, 'mute is disabled while the microphone is off')
  assert.equal(mute.props.title, 'muteNeedsMic', 'the disabled mute explains why rather than just greying out')

  // "Done talking" is offered only while a segment can be recording: on while
  // listening, gone while muted (mute drops the segment) or with the mic closed.
  const hasStop = (state) => {
    const found = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node === 'string') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (typeof node === 'object') { found.push(node); visit(node.children) }
    }
    const controls = dock.createCallControls()
    controls.setDevice(state.device)
    if (state.muted === true) controls.toggleMute()
    visit(dock.dockView({
      controls, status: 'listening', error: null, heard: '', reply: '', detach: { available: false }, t: (key) => key,
      actions: { hangUp: () => {}, stopTalking: () => {}, toggleMic: () => {}, toggleMute: () => {}, openSettings: () => {}, detach: () => {} },
    }))
    return found.some((node) => node.props?.className === 'dw-chip')
  }
  assert.equal(hasStop({ device: true }), true, 'listening offers "done talking"')
  assert.equal(hasStop({ device: true, muted: true }), false, 'muting drops the segment, so there is nothing to end')
  assert.equal(hasStop({ device: false }), false, 'a closed microphone has no utterance to end')

  assert.ok(typeof Dock === 'function')
  console.log('ok 7 — the dock renders microphone and mute as two separate, independently pressed controls')
}

// --- 8. the degraded paths -------------------------------------------------

{
  // PiP unavailable → popup. Popup blocked (open returns null) → in-page, with
  // the failure reported instead of pretending the window exists. The call
  // itself is never interrupted by a detach failure.
  assert.equal(dock.detachCapability({}).mode, 'none')
  assert.equal(dock.detachCapability({ open: () => null }).mode, 'window-open')
  // A browser with Document PiP but no opener API still detaches.
  assert.equal(dock.detachCapability({ documentPictureInPicture: { requestWindow: async () => ({}) } }).mode, 'document-pip')

  // Rectangle math never returns NaN for a zero-size dock or viewport.
  const degenerate = dock.snapDockPosition({ x: 10, y: 10, width: 0, height: 0, viewport: { width: 0, height: 0 }, margin: 0 })
  assert.equal(Number.isFinite(degenerate.x), true)
  assert.equal(Number.isFinite(degenerate.y), true)
  console.log('ok 8 — every detach path degrades honestly, and snapping stays finite at zero size')
}

// --- 9. finishing, the 60s cap, and closing --------------------------------

{
  // "Done talking" hands over the segment in progress, puts the detector's
  // own setting back, and goes on listening on the same open stream: the
  // next sentence needs no new listen() and no new permission.
  const { taker, record } = listenerHarness()
  await taker.listen(false)
  record.vad.speak(2)
  assert.deepEqual(record.speaking, [true], 'a segment in progress is reported')
  assert.equal(await taker.finish(), true, 'a segment in progress is handed over')
  assert.equal(record.utterances.length, 1)
  assert.equal(record.speaking.at(-1), false, 'and reported over')
  assert.equal(record.vad.options.submitUserSpeechOnPause, false, 'pausing stops submitting again afterwards')
  assert.equal(record.streams.length, 1, 'the microphone stays open')
  assert.equal(record.streams[0].track.readyState, 'live')
  assert.equal(record.vad.listening, true, 'detection goes on')
  record.vad.speak(1)
  record.vad.endSpeech()
  assert.equal(record.utterances.length, 2, 'the next sentence is handed over without listening again')

  // With nothing said, finishing hands nothing over and says so.
  assert.equal(await taker.finish(), false)
  assert.equal(record.utterances.length, 2)
  assert.equal(record.vad.listening, true)

  // Speech that never pauses is cut and sent at 60s, and listening goes on.
  record.vad.speak(70)
  const cap = record.timers.at(-1)
  assert.equal(cap.ms, 60000)
  cap.fn()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(record.utterances.length, 3, 'the capped segment is sent')
  assert.equal(record.vad.listening, true, 'the cap does not stop the call listening')

  // Muted, finishing has nothing to cut and must not start detection again.
  await taker.mute()
  assert.equal(await taker.finish(), false)
  assert.equal(record.vad.listening, false, 'finishing never unmutes')
  await taker.unmute()

  // A hold that lands while a segment is being handed over wins.
  record.vad.speak(1)
  const finishing = taker.finish()
  await taker.hold()
  await finishing
  assert.equal(record.vad.listening, false, 'a hold during finishing leaves detection off')
  assert.ok(record.streams.every((stream) => stream.track.readyState === 'ended'), 'and the device released')
  await taker.listen(false)

  // The pause that ends a turn can change mid-call.
  taker.setRedemptionMs(5000)
  assert.equal(record.vad.options.redemptionMs, 5000)

  // Hanging up mid-sentence reports the segment over, so nothing waits on it.
  const midSentence = listenerHarness()
  await midSentence.taker.listen(false)
  midSentence.record.vad.speak(1)
  await midSentence.taker.close()
  assert.equal(midSentence.record.speaking.at(-1), false, 'close() mid-segment reports speaking over')

  // Closing destroys the detector and releases every track, even from mute.
  await taker.listen(false)
  await taker.mute()
  await taker.close()
  assert.equal(record.vad.destroyed, true)
  assert.ok(record.streams.every((stream) => stream.track.readyState === 'ended'), 'no track stays live after close')
  console.log('ok 9 — done-talking and the 60s cap hand a segment over and keep listening; close releases every track')
}

// --- 10. the settings panel's speech wording ------------------------------

{
  // Speech OUT is a real channel now, configured by its own form. Both
  // dictionaries must say four true things about it:
  //   1. the browser speech-synthesis fallback still exists and is off by default
  //   2. read-aloud prefers the configured backend
  //   3. a backend failure falls back to the browser synthesizer (automatically)
  //   4. the speech key is separate from the transcription key
  const { zh, en } = dock.DICTIONARIES
  const cases = [
    ['zh', zh, {
      backend: /语音合成|朗读/,
      fallback: /浏览器/,
      automatic: /自动|退回/,
      ownKey: /单独.*key|自己的.*key|独立.*key/,
    }],
    ['en', en, {
      backend: /speech (backend|synthesis)|read aloud/i,
      fallback: /browser/i,
      automatic: /falls back|automatically/i,
      ownKey: /its own key|separate key/i,
    }],
  ]
  for (const [lang, copy, rules] of cases) {
    const note = copy.settingsTtsNote
    assert.equal(typeof note, 'string', `${lang}.settingsTtsNote must exist`)
    assert.match(note, rules.backend, `${lang}.settingsTtsNote must name the speech backend`)
    assert.match(note, rules.fallback, `${lang}.settingsTtsNote must mention the browser fallback`)
    assert.match(note, rules.automatic, `${lang}.settingsTtsNote must say the fallback is automatic`)
    assert.match(note, rules.ownKey, `${lang}.settingsTtsNote must say the speech key is its own key`)
    // The old placeholder language must be gone: this is not a "kept for
    // later" form any more, and it must not read as unimplemented.
    assert.equal(/未接入|留作将来|占位/.test(note), false, `${lang}.settingsTtsNote may not call the form a placeholder`)
    assert.equal(/not integrated|placeholder|kept for later/i.test(note), false, `${lang}.settingsTtsNote may not call the form a placeholder`)
    // The per-field labels carry no "not integrated" suffix either.
    for (const key of ['settingsTtsModel', 'settingsTtsVoice', 'settingsTtsBaseUrl', 'settingsTtsApiKey']) {
      assert.equal(/未接入|留作将来|placeholder|not integrated/i.test(copy[key]), false, `${lang}.${key} must be a plain label`)
    }
    // The fallback is still named as a fallback on the dock, not only in settings.
    assert.match(copy.speakNote, /fallback|兜底|备用/i)
    // And every fallback reason has a line, so a downgrade is never silent.
    for (const key of ['ttsMissingKey', 'ttsInvalidKey', 'ttsUnreachable', 'ttsTimeout', 'ttsBadAudio', 'ttsTooLong', 'ttsFallbackGeneric']) {
      assert.equal(typeof copy[key], 'string', `${lang}.${key} must exist`)
      assert.ok(copy[key].length > 0, `${lang}.${key} may not be empty`)
    }
  }

  // The TTS page is a real form: every field is editable, the key is a masked
  // password box, and nothing is disabled. It lives behind a row on the
  // overview that describes the channel rather than disclaiming it.
  const ttsDraft = { ...dock.EMPTY_SETTINGS_DRAFT }
  const settingsInput = (page, navigated, info = null) => ({
    t: (key) => key,
    info,
    draft: { ...ttsDraft },
    set: () => {},
    busy: false,
    testing: false,
    saved: false,
    testResult: null,
    error: null,
    page,
    speak: false,
    ttsEnabled: true,
    workspaces: undefined,
    actions: { navigate: (target) => navigated.push(target) },
  })
  const nodesOf = (tree) => {
    const found = []
    const visit = (node) => {
      if (node === null || node === undefined) return
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (typeof node === 'object') { found.push(node); visit(node.children) }
    }
    visit(tree)
    return found
  }
  // Recursive on purpose: the title of a nav row is nested in a span.
  const textsOf = (node) => {
    const out = []
    const visit = (child) => {
      if (typeof child === 'string') { out.push(child); return }
      if (Array.isArray(child)) { child.forEach(visit); return }
      if (child !== null && typeof child === 'object') visit(child.children)
    }
    visit(node?.children)
    return out
  }
  const navigated = []
  const overview = dock.settingsView(settingsInput(undefined, navigated))
  const ttsEntry = nodesOf(overview).find((node) => node.type === 'button' && textsOf(node).includes('settingsTtsEntry'))
  assert.ok(ttsEntry, 'the overview links to the speech settings')
  ttsEntry.props.onClick()
  assert.deepEqual(navigated, ['tts'], 'the speech entry opens the tts page')
  // With no key configured the row says the browser fallback is what runs.
  assert.ok(textsOf(ttsEntry).join(' ').includes('settingsTtsFallback'), 'an unconfigured channel names the fallback')

  const view = dock.settingsView(settingsInput('tts', [], null))
  const nodes = nodesOf(view)
  const block = nodes.find((node) => node.props?.['data-dw-tts'] !== undefined)
  assert.ok(block, 'the speech form is rendered')
  assert.equal(block.props['data-dw-tts'], 'configured', 'the block reports a configured channel, not a placeholder')
  const inputs = nodes.filter((node) => node.type === 'input')
  assert.ok(inputs.length >= 4, `base URL, key, voice and model are all present (got ${inputs.length})`)
  assert.deepEqual(inputs.filter((node) => node.props?.disabled === true).map((node) => node.props.type), [],
    'nothing is disabled on a fresh form: every field is editable')
  // The one disabled state is the key box, and only while its clear switch is
  // on (typing into a box that is about to be erased would be a trap).
  const clearDraft = { ...ttsDraft, clearTtsKey: true, ttsApiKeyTouched: true }
  const clearingView = dock.settingsView({ ...settingsInput('tts', [], {
    tts: { hasApiKey: true, keySource: 'settings', apiKeyEnv: 'MIMO_TOKEN_PLAN_KEY', baseUrl: 'https://speech.example/v1', voice: '', format: 'wav', formats: ['wav'], model: 'm1', fallback: 'browser-speech-synthesis' },
  }), draft: clearDraft })
  const clearingInputs = nodesOf(clearingView).filter((node) => node.type === 'input')
  assert.deepEqual(clearingInputs.filter((node) => node.props?.disabled === true).map((node) => node.props.type), ['password'],
    'the key box is disabled only while marked for clearing')
  assert.ok(inputs.some((node) => node.props?.type === 'password'), 'the key is a masked password field')
  assert.ok(inputs.some((node) => node.props?.type === 'url'), 'the base URL is a URL field')
  const selects = nodes.filter((node) => node.type === 'select')
  assert.ok(selects.length >= 1, 'the audio format is a select, so only the served containers can be chosen')
  // The "prefer the backend" switch is present and on by default.
  const switches = nodes.filter((node) => node.props?.role === 'switch')
  assert.ok(switches.length >= 1, 'the backend preference is a switch')

  // With a key saved elsewhere, the row reports where it came from.
  const configuredRow = dock.settingsView(settingsInput('tts', [], {
    tts: { hasApiKey: true, keySource: 'env', apiKeyEnv: 'MIMO_TOKEN_PLAN_KEY', baseUrl: 'https://speech.example/v1', voice: 'v1', format: 'wav', formats: ['wav', 'mp3', 'pcm'], model: 'm1', fallback: 'browser-speech-synthesis' },
  }))
  const sourceRow = nodesOf(configuredRow).find((node) => node.props?.['data-dw-tts-source'] !== undefined)
  assert.equal(sourceRow.props['data-dw-tts-source'], 'env', 'the form says WHERE the key came from')

  // The clear-key switch is the one control that can erase a stored key. It
  // appears only for a key saved here; on marks the key for erasing, and
  // switching it back off restores "leave the key alone".
  const serviceWith = (keySource, draft, writes) => dock.settingsView({
    ...settingsInput('service', []),
    info: { keySource, hasApiKey: keySource !== 'none', apiKeyEnv: 'DW_STT_API_KEY', baseUrl: 'https://x.test/v1', model: 'whisper-large-v3', language: '' },
    draft,
    set: (patch) => writes.push(patch),
  })
  const switchOf = (tree) => nodesOf(tree).find((node) => node.props?.role === 'switch')
  const emptyDraft = settingsInput('service', []).draft
  assert.equal(switchOf(serviceWith('env', emptyDraft, [])), undefined, 'an environment key has no clear switch')
  const writes = []
  let draft = { ...emptyDraft }
  const clearSwitch = switchOf(serviceWith('settings', draft, writes))
  assert.equal(clearSwitch.props['aria-checked'], false)
  clearSwitch.props.onClick()
  draft = { ...draft, ...writes.at(-1) }
  assert.deepEqual([draft.clearKey, draft.apiKeyTouched, draft.apiKey], [true, true, ''], 'on marks the saved key for erasing')
  const marked = serviceWith('settings', draft, writes)
  assert.equal(switchOf(marked).props['aria-checked'], true)
  const keyBox = nodesOf(marked).find((node) => node.type === 'input' && node.props?.type === 'password')
  assert.equal(keyBox.props.disabled, true, 'the key box is disabled while the key is marked for erasing')
  switchOf(marked).props.onClick()
  draft = { ...draft, ...writes.at(-1) }
  assert.deepEqual([draft.clearKey, draft.apiKeyTouched], [false, false], 'off restores "leave the key alone"')
  assert.equal('apiKey' in dock.settingsDraftPatch(draft), false, 'so a save after switching back sends no key at all')
  console.log('ok 10 — the speech form is live: fallback named, key separate, every field editable')
}

// --- 11. the logic/visual seam -------------------------------------------

{
  // The exterior is replaceable: every rule lives in one stylesheet function,
  // and the logic never writes visual values inline. This is the contract the
  // visual handover depends on, so it is asserted rather than assumed.
  assert.equal(typeof dock.dockStyles, 'function', 'the stylesheet is one exported function')
  const css = dock.dockStyles()
  assert.match(css, /\.dw-dock-host/, 'the dock surface class is styled here')
  assert.match(css, /\.dw-ctl-mic/, 'the microphone control is styled here')
  assert.match(css, /\.dw-ctl-mute/, 'the mute control is styled here')
  assert.match(css, /\.dw-status-listening/, 'status appearance is driven by a state class')
  assert.match(css, /\.dw-settings/, 'the settings panel is styled here too')

  // The detached document's appearance belongs to the stylesheet, not to the
  // function that copies the styles across.
  assert.match(css, /body\.dw-detached/, 'the detached body is styled by the stylesheet')

  // Geometry is computed in logic but expressed through custom properties, so
  // the CSS decides what left/top mean and the drag code never picks a unit.
  assert.match(css, /--dw-dock-x/, 'drag position is a custom property the CSS consumes')
  assert.match(css, /--dw-dock-y/, 'drag position is a custom property the CSS consumes')

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const bodyOf = (startMarker, endMarker) => {
    const start = source.indexOf(startMarker)
    const end = source.indexOf(endMarker, start)
    assert.ok(start > 0 && end > start, `could not read ${startMarker}`)
    return source.slice(start, end)
  }
  // Strip comments first: the rule is about code, and a comment that explains
  // the rule must not be mistaken for a violation of it.
  const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const copyStyles = codeOnly(bodyOf('function copyStylesInto(', '// ---- dragging and edge snapping'))
  assert.equal(/\.style\./.test(copyStyles), false, 'copying styles must not write inline visual values')
  assert.equal(/margin|background/.test(copyStyles), false,
    'the detached body look lives in CSS, not in the copy function')

  const drag = codeOnly(bodyOf('function onDragMove(', 'function onDragEnd('))
  assert.equal(/\.style\.left|\.style\.top|\.style\.right|\.style\.bottom/.test(drag), false,
    'dragging must not hard-code box offsets; it sets geometry variables instead')
  assert.match(drag, /setProperty\(|--dw-dock-/, 'dragging publishes geometry through custom properties')
  console.log('ok 11 — the logic/visual seam holds: one stylesheet, no inline visual values, geometry via variables')
}

// --- 12. moving, stashing and resizing ------------------------------------

{
  const viewport = { width: 1200, height: 800 }
  const panel = { width: 380, height: 260 }

  // Dropped in the open: stays open, anchored to the nearer side and the bottom.
  const middle = dock.dockRelease({ left: 300, top: 300, ...panel, viewport, docked: false })
  assert.deepEqual(middle, { docked: null, anchor: 'left', x: 300, y: 800 - 300 - 260 })

  // Dropped flush against the right edge but not pushed past it: snapped, still open.
  const flush = dock.dockRelease({ left: 1200 - 380 - 30, top: 300, ...panel, viewport, docked: false })
  assert.equal(flush.docked, null, 'a panel placed near an edge stays open')
  assert.deepEqual([flush.anchor, flush.x], ['right', 16], 'and snaps to the margin')

  // Pushed 150px past the right edge: stashed there as the microphone button.
  const pushed = dock.dockRelease({ left: 1200 - 380 + 150, top: 300, ...panel, viewport, docked: false })
  assert.deepEqual([pushed.docked, pushed.anchor, pushed.x], ['right', 'right', 8])
  const pushedLeft = dock.dockRelease({ left: -200, top: 300, ...panel, viewport, docked: false })
  assert.equal(pushedLeft.docked, 'left')

  // The stashed button slides along its edge and stays stashed.
  const orb = { width: 60, height: 60 }
  const slid = dock.dockRelease({ left: 1200 - 60 - 20, top: 100, ...orb, viewport, docked: true, expanded: panel })
  assert.deepEqual([slid.docked, slid.y], ['right', 800 - 100 - 60], 'sliding along the edge keeps it stashed')

  // Dragged into the page: opens at the panel's size, kept inside the viewport.
  const opened = dock.dockRelease({ left: 600, top: 600, ...orb, viewport, docked: true, expanded: panel })
  assert.equal(opened.docked, null, 'a stashed button dragged inward opens again')
  assert.ok(opened.y >= 16, 'the reopened panel fits above the bottom margin')
  assert.ok(opened.x >= 16, 'and inside the side margin')

  // A drop a little past the top or bottom is clamped back in; pushed through
  // either, the panel is stashed on that edge, keeping its anchored side.
  const high = dock.dockRelease({ left: 300, top: -60, ...panel, viewport, docked: false })
  assert.deepEqual([high.docked, high.y], [null, 800 - 16 - 260], 'a drop just above the viewport is pulled back under the top margin')
  const throughTop = dock.dockRelease({ left: 300, top: -500, ...panel, viewport, docked: false })
  assert.deepEqual(throughTop, { docked: 'top', anchor: 'left', x: 300, y: 800 - 8 - 60 }, 'pushed through the top, it is stashed there')
  const throughBottom = dock.dockRelease({ left: 900, top: 800, ...panel, viewport, docked: false })
  assert.deepEqual(throughBottom, { docked: 'bottom', anchor: 'right', x: 16, y: 8 }, 'pushed through the bottom, it is stashed there')
  // The stashed button stays on whichever edge is nearest, and moves to another edge when dropped near it.
  assert.equal(dock.dockRelease({ left: 600, top: 30, ...orb, viewport, docked: true, expanded: panel }).docked, 'top')
  assert.equal(dock.dockRelease({ left: 600, top: 720, ...orb, viewport, docked: true, expanded: panel }).docked, 'bottom')

  // Resizing grows away from the anchored side, within the room left, above the minimums.
  const room = { left: 400, right: 20, top: 300 }
  assert.deepEqual(dock.dockResize({ width: 380, cardHeight: 200, dx: -100, dy: -80, corner: 'left', room }), { width: 480, cardHeight: 280 })
  assert.deepEqual(dock.dockResize({ width: 380, cardHeight: 200, dx: -900, dy: -900, corner: 'left', room }), { width: 780, cardHeight: 500 },
    'growth stops at the viewport margin')
  assert.deepEqual(dock.dockResize({ width: 380, cardHeight: 200, dx: 900, dy: 900, corner: 'left', room }), { width: 300, cardHeight: 120 },
    'shrinking stops at the minimums')
  assert.equal(dock.dockResize({ width: 380, cardHeight: 200, dx: 60, dy: 0, corner: 'right', room }).width, 400,
    'the right grip grows to the right, limited by the room on that side')

  // Geometry reaches the host only as custom-property numbers.
  assert.equal(dock.dockGeometryStyle(null, null), undefined)
  assert.deepEqual(dock.dockGeometryStyle({ anchor: 'right', x: 16.4, y: 144 }, { width: 420.6, cardHeight: 260 }),
    { '--dw-dock-x': '16', '--dw-dock-y': '144', '--dw-dock-w': '421', '--dw-card-h': '260' })
  console.log('ok 12 — a drop stays open, snaps, or stashes on any edge; the stashed button reopens; resizing is clamped')
}

// --- 13. the stashed dock is the microphone button --------------------------

{
  const nodesOf = (tree) => {
    const found = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node === 'string') return
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (typeof node === 'object') { found.push(node); visit(node.children) }
    }
    visit(tree)
    return found
  }
  const calls = []
  const actions = { startCall: () => calls.push('start'), toggleMic: () => calls.push('mic') }
  const controls = dock.createCallControls()
  controls.setDevice(true)
  const inCall = dock.dockedView({ t: (key) => key, open: true, side: 'right', status: 'listening', error: null, controls, actions })
  const buttons = nodesOf(inCall).filter((node) => node.type === 'button')
  assert.equal(buttons.length, 1, 'stashed, the dock shows exactly one button')
  assert.equal(buttons[0].props['data-dw-control'], 'mic', 'and it is the microphone control')
  assert.equal(buttons[0].props['aria-pressed'], true)
  assert.match(inCall.props.className, /dw-status-listening/, 'the orb keeps animating the call status')
  buttons[0].props.onClick()
  assert.deepEqual(calls, ['mic'], 'tapping it switches the microphone')

  const idle = dock.dockedView({ t: (key) => key, open: false, side: 'left', status: 'ready', error: null, controls: dock.createCallControls(), actions })
  const idleButtons = nodesOf(idle).filter((node) => node.type === 'button')
  assert.equal(idleButtons.length, 1)
  idleButtons[0].props.onClick()
  assert.deepEqual(calls, ['mic', 'start'], 'without a call, tapping it starts one')
  // The status line says what runs beside listening: a sentence on its way
  // first, then the whale working; the controls still outrank both.
  const on = { device: true, muted: false, processing: true, muteEnabled: true }
  const key = (input) => dock.dockStatusKey({ error: null, controls: on, ...input })
  assert.equal(key({ status: 'listening' }), 'statusListening')
  assert.equal(key({ status: 'listening', sending: 1, whaleBusy: true }), 'statusSending')
  assert.equal(key({ status: 'listening', whaleBusy: true }), 'statusListeningBusy')
  assert.equal(key({ status: 'ready', whaleBusy: true }), 'statusThinking')
  assert.equal(key({ status: 'listening', whaleBusy: true, controls: { ...on, muted: true, processing: false } }), 'statusMuted')
  console.log('ok 13 — stashed against an edge, the dock is the microphone button alone; the status line names what runs beside listening')
}

// --- 14. a drag never leaves the viewport ----------------------------------

{
  const viewport = { width: 1200, height: 800 }
  const panel = { width: 380, height: 260 }
  const inside = (frame, box) => {
    const left = frame.anchor === 'left' ? frame.x : viewport.width - frame.x - box.width
    const top = viewport.height - frame.y - box.height
    return left >= 0 && top >= 0 && left + box.width <= viewport.width && top + box.height <= viewport.height
  }

  // In the open, the panel follows the pointer.
  const free = dock.dockDragFrame({ left: 300, top: 300, ...panel, viewport, docked: false })
  assert.deepEqual(free, { stash: null, anchor: 'left', x: 300, y: 800 - 300 - 260 })

  // A little past any edge, it stops at the margin.
  const up = dock.dockDragFrame({ left: 300, top: -60, ...panel, viewport, docked: false })
  assert.deepEqual([up.stash, up.y], [null, 800 - 16 - 260], 'the top edge holds it')
  const down = dock.dockDragFrame({ left: 300, top: 800 - 260 + 60, ...panel, viewport, docked: false })
  assert.deepEqual([down.stash, down.y], [null, 16], 'the bottom edge holds it')
  const nudged = dock.dockDragFrame({ left: -60, top: 300, ...panel, viewport, docked: false })
  assert.deepEqual([nudged.stash, nudged.anchor, nudged.x], [null, 'left', 16], 'a side holds it until it is pushed through')
  for (const frame of [free, up, down, nudged]) assert.ok(inside(frame, panel), 'every frame of the panel is inside the viewport')

  // Pushed on through a side, it is drawn as the stashed button on that edge,
  // the same place letting go leaves it.
  const push = { left: -200, top: 300, ...panel, viewport, docked: false }
  const through = dock.dockDragFrame(push)
  assert.deepEqual(through, { stash: 'left', anchor: 'left', x: 8, y: 800 - 300 - 260 })
  const released = dock.dockRelease(push)
  assert.deepEqual([released.docked, released.x, released.y], [through.stash, through.x, through.y], 'the frame shows where the release lands')
  // Pulled back in, it is the panel again, still held by the edge.
  assert.equal(dock.dockDragFrame({ ...push, left: -80 }).stash, null)
  const farRight = dock.dockDragFrame({ left: 5000, top: -300, ...panel, viewport, docked: false })
  assert.deepEqual([farRight.stash, farRight.anchor, farRight.x], ['right', 'right', 8])
  assert.ok(farRight.y >= 16 && farRight.y + 60 <= 800, 'the button stays on screen however far the pointer goes')
  // The top and bottom work the same way.
  const farUp = dock.dockDragFrame({ left: 300, top: -2000, ...panel, viewport, docked: false })
  assert.deepEqual(farUp, { stash: 'top', anchor: 'left', x: 300, y: 800 - 8 - 60 })
  const farDown = dock.dockDragFrame({ left: 300, top: 5000, ...panel, viewport, docked: false })
  assert.deepEqual(farDown, { stash: 'bottom', anchor: 'left', x: 300, y: 8 })

  // The stashed button slides along its edge and stays on screen.
  const orb = { width: 60, height: 60 }
  const slide = dock.dockDragFrame({ left: -900, top: -900, ...orb, viewport, docked: true, expanded: panel })
  assert.deepEqual([slide.stash, slide.anchor, slide.x, slide.y], ['left', 'left', 8, 800 - 16 - 60])
  const below = dock.dockDragFrame({ left: 600, top: 2000, ...orb, viewport, docked: true, expanded: panel })
  assert.deepEqual([below.stash, below.y], ['bottom', 8], 'dragged past the bottom it rides the bottom edge')
  assert.ok(inside(below, orb))
  // Dragged inward it is still the button (it opens on release), held inside the viewport.
  const inward = dock.dockDragFrame({ left: 600, top: 400, ...orb, viewport, docked: true, expanded: panel })
  assert.equal(inward.stash, null)
  assert.ok(inside(inward, orb))
  console.log('ok 14 — a drag never leaves the viewport; pushed through any edge, the panel is drawn as the stashed button')
}

console.log('\nAll discipline-whale dock checks passed.')

// --- 14. a field the user did not edit never enters the patch --------------
//
// The reported data-loss bug: the Base URL box shows the server's value as a
// PLACEHOLDER and starts empty, so a save that only typed an API key sent
// `baseUrl: ""` and wiped a working endpoint. `dirty` is the record of what the
// person actually typed; a field absent from it must not be in the request.

{
  assert.equal(typeof dock.settingsDraftPatch, 'function')

  // 1. Only the key was typed: the endpoint must not be in the patch at all.
  const keyOnly = dock.settingsDraftPatch({
    baseUrl: '',
    model: '',
    language: '',
    apiKey: 'sk-typed-0123456789',
    apiKeyTouched: true,
    ttsBaseUrl: '',
    ttsApiKey: '',
    ttsApiKeyTouched: false,
    dirty: {},
  })
  assert.deepEqual(keyOnly, { apiKey: 'sk-typed-0123456789' }, 'a save that only typed a key carries nothing else')
  assert.equal('baseUrl' in keyOnly, false, 'an untouched Base URL is omitted, so the stored endpoint survives')

  // 2. Only the endpoint was typed: the stored key must not be disturbed.
  const urlOnly = dock.settingsDraftPatch({
    baseUrl: ' https://stt.example.test/v1 ',
    apiKey: '',
    apiKeyTouched: false,
    dirty: { baseUrl: true },
  })
  assert.deepEqual(urlOnly, { baseUrl: 'https://stt.example.test/v1' })
  assert.equal('apiKey' in urlOnly, false, 'an untouched key field never travels with a Base URL change')

  // 3. A field the user emptied on purpose IS written, as the empty string.
  const clearedOnPurpose = dock.settingsDraftPatch({
    baseUrl: '',
    apiKey: '',
    apiKeyTouched: false,
    dirty: { baseUrl: true },
  })
  assert.equal(clearedOnPurpose.baseUrl, '', 'an explicitly cleared field is sent as empty, which means unset')

  // 4. A mask is never a key, even when the box was touched.
  const masked = dock.settingsDraftPatch({ apiKey: '••••••••', apiKeyTouched: true, dirty: {} })
  assert.equal('apiKey' in masked, false, 'a masked display value is never written back as the key')
  console.log('ok 14 — a field the user did not edit never enters the patch; a mask is never a key')
}
