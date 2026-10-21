/**
 * Dock tests for discipline-whale: the parts of the voice dock that can be
 * proven without a microphone, a second window, or a real browser.
 *
 * What is checked:
 *
 *   1. microphone (device) and mute (drop data) are two independent controls,
 *      and mute is unavailable while the device is off
 *   2. frames are dropped while muted — nothing reaches the detector
 *   3. a muted stretch is not counted as silence, so unmuting cannot end the
 *      utterance immediately
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

// --- 2. frames are dropped while muted ------------------------------------

{
  const seen = []
  const gate = dock.createFrameGate({ onFrame: (samples, frameMs) => seen.push(frameMs) })
  gate.setProcessing(true)
  gate.push([0.2], 20)
  assert.equal(seen.length, 1, 'an unmuted frame reaches the detector')

  gate.setProcessing(false)
  for (let i = 0; i < 10; i += 1) gate.push([0.2], 20)
  assert.equal(seen.length, 1, 'no muted frame may reach the detector')

  gate.setProcessing(true)
  gate.push([0.2], 20)
  assert.equal(seen.length, 2, 'unmuting resumes processing at the next frame')
  console.log('ok 2 — while muted every frame is discarded before the detector sees it')
}

// --- 3. a muted stretch is not silence ------------------------------------

{
  const detector = dock.createSilenceDetector()
  // Calibrate in a quiet room, then say something.
  for (let i = 0; i < 30; i += 1) detector.push(dock.testFrame(0.002), 20)
  for (let i = 0; i < 50; i += 1) detector.push(dock.testFrame(0.2), 20)
  assert.equal(detector.speechMs(), 1000, 'one second of speech is recorded')

  // Muted for well over the 10s window: frames are not pushed at all, and the
  // detector is told the stretch was not listening.
  detector.pause()
  assert.equal(detector.silenceMs(), 0, 'pausing clears the silence accounting')

  // Unmute, then speak again briefly. This must NOT stop as if 10s had passed.
  detector.resume()
  for (let i = 0; i < 20; i += 1) detector.push(dock.testFrame(0.2), 20)
  let decision
  for (let i = 0; i < 100; i += 1) decision = detector.push(dock.testFrame(0.002), 20)
  assert.equal(decision, undefined, '2s of quiet after unmute must not end the utterance')

  // A full 10s of quiet after unmute still ends it, so the rule itself is intact.
  for (let i = 0; i < 450; i += 1) decision = detector.push(dock.testFrame(0.002), 20)
  assert.equal(decision?.action, 'stop', 'a real 10s of quiet still ends it')
  assert.equal(decision.reason, 'silence')
  console.log('ok 3 — a muted stretch does not count as silence, and unmute cannot end the utterance early')
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

  // "Done talking" is offered only while an utterance can be recording: on
  // while listening (muted included), gone once the microphone is closed.
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
  assert.equal(hasStop({ device: true, muted: true }), true, 'a muted utterance can still be ended and sent')
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

// --- 9. muting mid-utterance does not corrupt the detector ----------------

{
  // The full sequence a user performs: start talking, mute, talk to someone
  // else for a while, unmute, keep talking. The utterance must not end at the
  // moment of unmuting, and the muted stretch must not count as speech either.
  const detector = dock.createSilenceDetector()
  for (let i = 0; i < 30; i += 1) detector.push(dock.testFrame(0.002), 20)
  for (let i = 0; i < 50; i += 1) detector.push(dock.testFrame(0.2), 20)
  const speechBeforeMute = detector.speechMs()
  const elapsedBeforeMute = detector.elapsedMs()

  detector.pause()
  // 30 seconds of frames that never arrive: no push() at all while muted.
  detector.resume()

  assert.equal(detector.speechMs(), speechBeforeMute, 'muted time adds no speech')
  assert.equal(detector.elapsedMs(), elapsedBeforeMute, 'muted time adds no recording length')
  assert.equal(detector.silenceMs(), 0, 'unmuting starts from zero quiet, not from the mute length')

  // Continuing to speak extends the SAME utterance.
  for (let i = 0; i < 50; i += 1) detector.push(dock.testFrame(0.2), 20)
  assert.equal(detector.speechMs(), speechBeforeMute + 1000, 'speech after unmute adds to the same utterance')
  console.log('ok 9 — a mid-utterance mute neither adds speech nor records length nor pre-ends the utterance')
}

// --- 10. the settings panel's TTS wording --------------------------------

{
  // The user's correction: keep the browser read-aloud as a fallback, and do
  // NOT describe TTS as if it does not exist — but also never claim it is
  // integrated. Both dictionaries have to say all four things:
  //   1. a browser speech-synthesis fallback exists (and is off by default)
  //   2. a real TTS is NOT integrated
  //   3. the fields are a placeholder kept for later
  //   4. a real TTS needs its own separate key
  const { zh, en } = dock.DICTIONARIES
  const cases = [
    ['zh', zh, {
      fallback: /浏览器|browser/i,
      off: /默认关闭|默认/,
      notIntegrated: /未接入/,
      placeholder: /占位|留作将来|预留/,
      ownKey: /单独.*key|自己的.*key|独立.*key/,
      integratedClaim: /已接入\s*TTS|TTS\s*已接入/,
    }],
    ['en', en, {
      fallback: /browser/i,
      off: /off by default|default off/i,
      notIntegrated: /not (yet )?integrated/i,
      placeholder: /placeholder|kept for later|reserved/i,
      ownKey: /its own (separate )?(API )?key|separate key/i,
      integratedClaim: /TTS is integrated|integrated TTS channel/i,
    }],
  ]
  for (const [lang, copy, rules] of cases) {
    const note = copy.settingsTtsNote
    assert.equal(typeof note, 'string', `${lang}.settingsTtsNote must exist`)
    assert.match(note, rules.fallback, `${lang}.settingsTtsNote must mention the browser fallback`)
    assert.match(note, rules.off, `${lang}.settingsTtsNote must say the fallback is off by default`)
    assert.match(note, rules.notIntegrated, `${lang}.settingsTtsNote must say real TTS is not integrated`)
    assert.match(note, rules.placeholder, `${lang}.settingsTtsNote must say the fields are placeholders for later`)
    assert.match(note, rules.ownKey, `${lang}.settingsTtsNote must say a real TTS needs its own key`)
    assert.equal(rules.integratedClaim.test(note), false, `${lang}.settingsTtsNote may not claim TTS is integrated`)
    // The title must not read as "TTS is missing entirely", and must not read
    // as "TTS is ready" either.
    assert.match(copy.settingsTtsTitle, rules.notIntegrated, `${lang}.settingsTtsTitle must scope the "not integrated" claim`)
    assert.match(copy.settingsTtsModel, rules.notIntegrated)
    assert.match(copy.settingsTtsVoice, rules.notIntegrated)
    // The fallback is named as a fallback on the dock too, not just in settings.
    assert.match(copy.speakNote, /fallback|兜底|备用/i)
  }

  // The TTS block keeps its fields (placeholder for later), and they stay
  // disabled: nothing here may look like a working TTS configuration form.
  // They live on the settings panel's "tts" page; the overview links to it
  // with a row that says "not integrated".
  const settingsInput = (page, navigated) => ({
    t: (key) => key,
    info: null,
    draft: { baseUrl: '', model: '', language: '', apiKey: '', apiKeyTouched: false, clearKey: false },
    set: () => {},
    busy: false,
    testing: false,
    saved: false,
    testResult: null,
    error: null,
    page,
    actions: { save: () => {}, test: () => {}, close: () => {}, navigate: (target) => navigated.push(target) },
  })
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
  const textsOf = (tree) => {
    const found = []
    const visit = (node) => {
      if (node === null || node === undefined) return
      if (typeof node === 'string') { found.push(node); return }
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (typeof node === 'object') visit(node.children)
    }
    visit(tree)
    return found
  }
  const navigated = []
  const overview = dock.settingsView(settingsInput(undefined, navigated))
  const ttsEntry = nodesOf(overview).find((node) => node.type === 'button' && textsOf(node).includes('settingsTtsEntry'))
  assert.ok(ttsEntry, 'the overview links to the TTS placeholders')
  assert.ok(textsOf(ttsEntry).includes('settingsNotIntegrated'), 'the TTS entry says it is not integrated')
  ttsEntry.props.onClick()
  assert.deepEqual(navigated, ['tts'], 'the TTS entry opens the tts page')

  const view = dock.settingsView(settingsInput('tts', []))
  const nodes = nodesOf(view)
  const block = nodes.find((node) => node.props?.['data-dw-tts'] !== undefined)
  assert.ok(block, 'the TTS block is still rendered, not removed')
  assert.equal(block.props['data-dw-tts'], 'not-integrated')
  const disabledInputs = nodes.filter((node) => node.type === 'input' && node.props?.disabled === true)
  assert.equal(disabledInputs.length, 4, 'base URL, model, voice and a SEPARATE TTS key field remain, all disabled')
  // The TTS key is its own field: a real TTS does not reuse the transcription key.
  const types = disabledInputs.map((node) => node.props.type)
  assert.ok(types.includes('password'), 'the placeholder TTS key field is a password field, not a text one')
  // Every placeholder says it is not integrated, so a filled value never looks live.
  for (const node of disabledInputs) {
    assert.equal(node.props.placeholder, 'settingsNotIntegrated', 'each TTS placeholder is labelled not-integrated')
    assert.equal(node.props.value, '', 'no TTS placeholder carries a value')
  }

  // The clear-key switch is the one control that can erase a stored key. It
  // appears only for a key saved here; on marks the key for erasing, and
  // switching it back off restores "leave the key alone".
  const serviceWith = (keySource, draft, writes) => dock.settingsView({
    ...settingsInput('service', []),
    info: { keySource, hasApiKey: keySource !== 'none', apiKeyEnv: 'SOCLAAS_API_KEY', baseUrl: 'https://x.test/v1', model: 'whisper-large-v3', language: '' },
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
  console.log('ok 10 — settings TTS copy keeps the fallback, denies integration, and marks the fields as placeholders')
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

console.log('\nAll discipline-whale dock checks passed.')
