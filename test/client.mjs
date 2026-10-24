/**
 * Browser-half tests for the voice dock.
 *
 * `client.js` is plain JS in the shell's module wrapper, so this harness gives
 * it the two globals it expects (`window.__ModuleLoader__` and `require`) and
 * then drives the exported logic directly. The microphone, the Silero model and
 * speechSynthesis themselves cannot run here; what is checked is everything
 * that must not drift:
 *
 *   1. the mirrored turn rules (Silero parameters, loudness floor, away
 *      guard) decide identically to the shared module the server tests use
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
  AWAY_IDLE_MS,
  AWAY_MAX_REJECTIONS,
  MAX_SPEECH_MS,
  MIN_SPEECH_LEVEL_DBFS,
  REDEMPTION_CHOICES_MS,
  TURN_OPTIONS,
  createAwayGuard,
  createCallGuard,
  speechLevelDbfs,
} from '../voice-silence.js'
import { REWRITE_NOTICE_SUMMARY } from '../adhd.js'

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

// --- 1. the mirrored turn rules -------------------------------------------

{
  // The browser half cannot import the shared ESM module, so it carries a
  // verbatim copy of the turn rules. A drift here would silently change when
  // a turn ends or when the microphone closes, so the copies are compared.
  const mirrored = module.exports.VOICE_CONSTANTS
  assert.deepEqual(mirrored.turn, { ...TURN_OPTIONS }, 'Silero parameters match the shared module')
  assert.deepEqual(mirrored.redemptionChoicesMs, [...REDEMPTION_CHOICES_MS])
  assert.equal(mirrored.maxSpeechMs, MAX_SPEECH_MS)
  assert.equal(mirrored.minSpeechLevelDbfs, MIN_SPEECH_LEVEL_DBFS)
  assert.equal(mirrored.awayIdleMs, AWAY_IDLE_MS)
  assert.equal(mirrored.awayMaxRejections, AWAY_MAX_REJECTIONS)

  // The loudness level agrees sample for sample on a mixed signal.
  let seed = 12345
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (const amplitude of [0, 0.0005, 0.003, 0.02, 0.2]) {
    const samples = new Float32Array(16000 * 3)
    for (let i = 0; i < samples.length; i += 1) samples[i] = (random() * 2 - 1) * amplitude * (i > 8000 && i < 24000 ? 1 : 0.1)
    assert.equal(module.exports.speechLevelDbfs(samples, 16000), speechLevelDbfs(samples, 16000), `level at amplitude ${amplitude}`)
  }

  // The away guard decides identically on one scripted afternoon.
  const shared = createAwayGuard()
  const copy = module.exports.createAwayGuard()
  const script = [
    ['resume', 0], ['reason', 60_000], ['suspend', 90_000], ['reason', 600_000], ['resume', 600_000],
    ['rejected'], ['rejected'], ['reason', 610_000], ['accepted', 620_000], ['rejected'], ['rejected'], ['rejected'],
    ['reason', 621_000], ['reset'], ['resume', 700_000], ['present', 750_000], ['reason', 869_000], ['reason', 870_000],
  ]
  for (const [step, at] of script) {
    const left = shared[step](at)
    const right = copy[step](at)
    assert.equal(right, left, `${step}(${at ?? ''}) must decide identically`)
  }
  console.log('ok 1 — the browser half mirrors the shared turn rules: parameters, loudness floor and away guard')
}

{
  const guard = module.exports.createCallGuard()
  guard.setTarget('s1')
  const call = guard.begin('c1')
  assert.equal(guard.accepts(call, 's1'), true)
  guard.end('c1')
  assert.equal(guard.accepts(call, 's1'), false)
  // The detector is served by the plugin itself, never a CDN.
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const VOICE_ASSET_ROUTE = "\/api\/discipline-whale\/voice\/vad"/)
  assert.equal(/https?:\/\/(cdn|unpkg|jsdelivr)/i.test(source), false, 'no CDN URL in the browser half')
  console.log('ok 2 — the call guard ships with the browser half, and the detector loads from the plugin route')
}

// --- 2. dictionaries ------------------------------------------------------

{
  const { zh, en } = module.exports.DICTIONARIES
  const voiceKeys = [
    'callStart', 'callHangup', 'statusReady', 'statusListening', 'statusSending',
    'statusListeningBusy', 'statusThinking', 'statusSpeaking', 'statusError', 'privacy',
    'speakOn', 'speakOff', 'speakHint', 'speakNote',
    'errPermission', 'errMissingKey', 'errInvalidKey', 'errNoModel', 'errUnreachable',
    'errTimeout', 'errTooLarge', 'errEmptyTranscript', 'errNoMainSession', 'errUnsupported',
  ]
  for (const key of voiceKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key} must exist`)
    assert.equal(typeof en[key], 'string', `en.${key} must exist`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} may not be empty`)
  }
  // The privacy line names the KIND of destination ("the host's configured
  // transcription service"), never a specific venue: the plugin is published
  // and an installation's backend is its own business.
  for (const [lang, copy] of [['zh', zh], ['en', en]]) {
    assert.match(copy.privacy, /转写服务|transcription service/, `${lang}.privacy must say where the audio goes`)
    assert.match(copy.privacy, /丢弃|dropped/i, `${lang}.privacy must say the recording is dropped`)
  }

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

// --- 3. the reply follower ------------------------------------------------

{
  const now = Date.now()
  const event = (seq, type, data) => ({ type: 'event', event: { type, seq, time: now + seq, data } })
  const said = (seq, turn, ...texts) => event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: texts.map((text) => (typeof text === 'string' ? { type: 'text', text } : text)) },
  })
  const older = [
    event(1, 'turn/start', { turn: 1 }),
    said(2, 1, '旧的回复'),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  // The reader takes text blocks after a mark, by event seq, never tool calls.
  assert.equal(module.exports.eventMarkOf(older), 3)
  assert.equal(module.exports.replyTextAfter(older, 3), '', 'nothing after the mark is nothing to say')
  assert.equal(module.exports.replyTextAfter([
    ...older,
    event(4, 'turn/start', { turn: 2 }),
    said(5, 2, '第一段回复。', { type: 'tool-call', id: 'c', name: 'list_dispatches', arguments: '{}' }, '第二段回复。'),
  ], 3), '第一段回复。第二段回复。', 'text blocks only, tool calls skipped')
  const raw = '## 结论\n\n- `dispatch_task` 已派工'
  assert.equal(module.exports.replyTextAfter([said(9, 3, raw)], 8), raw, 'the dock shows the reply verbatim')

  const follower = (graceMs = 10_000) => module.exports.createReplyFollower({ graceMs })
  let t = 0

  // Idle whale: the call starts, an utterance wakes a turn, the reply comes
  // once that turn has closed — and the turn on screen before the call never does.
  const idle = follower()
  let window = [...older]
  assert.deepEqual(idle.observe({ running: false, entries: window, now: t }), { busy: false, reply: null })
  idle.sent(t += 100, window)
  assert.deepEqual(idle.observe({ running: false, entries: window, now: t += 700 }), { busy: true, reply: null },
    'a sent utterance counts as work before its turn shows up')
  window = [...window, event(4, 'turn/start', { turn: 2 }), said(5, 2, '好的，我去派工。')]
  assert.deepEqual(idle.observe({ running: true, entries: window, now: t += 700 }), { busy: true, reply: null })
  assert.deepEqual(idle.observe({ running: false, entries: window, now: t += 700 }), { busy: false, reply: null },
    'a turn whose turn/end has not arrived is not over yet')
  window = [...window, event(6, 'turn/end', { turn: 2 })]
  assert.deepEqual(idle.observe({ running: false, entries: window, now: t += 700 }), { busy: false, reply: '好的，我去派工。' })
  assert.deepEqual(idle.observe({ running: false, entries: window, now: t += 700 }), { busy: false, reply: null },
    'a reply is handed over once')

  // Working whale: the utterance is an interjection into the running turn,
  // and what the whale says after it inside that turn is the reply.
  const busy = follower()
  window = [...older, event(4, 'turn/start', { turn: 2 }), said(5, 2, '我先读一下文件。')]
  assert.deepEqual(busy.observe({ running: true, entries: window, now: t += 700 }), { busy: true, reply: null })
  busy.sent(t += 100, window)
  window = [...window, event(6, 'user/message', { turn: 2 }), said(7, 2, '收到插话，改成先看测试。'), event(8, 'turn/end', { turn: 2 })]
  assert.deepEqual(busy.observe({ running: false, entries: window, now: t += 700 }), { busy: false, reply: '收到插话，改成先看测试。' },
    'the reply is the text written after the call began watching, inside the same turn')

  // Two turns in a row (a sentence that arrived just as a turn closed wakes
  // the next one): each closed turn gives its own reply.
  window = [...window, event(9, 'turn/start', { turn: 3 }), said(10, 3, '第二轮。')]
  assert.deepEqual(busy.observe({ running: true, entries: window, now: t += 700 }), { busy: true, reply: null })
  window = [...window, event(11, 'turn/end', { turn: 3 })]
  assert.deepEqual(busy.observe({ running: false, entries: window, now: t += 700 }), { busy: false, reply: '第二轮。' })

  // A turn with no text says nothing, and a sent utterance whose turn never
  // shows up stops counting as work after the grace period.
  const quiet = follower(1_000)
  window = [...older]
  quiet.observe({ running: false, entries: window, now: t })
  quiet.sent(t, window)
  assert.equal(quiet.observe({ running: false, entries: window, now: t + 500 }).busy, true)
  assert.deepEqual(quiet.observe({ running: false, entries: window, now: t + 1_500 }), { busy: false, reply: null })

  // No event window yet: the session row alone says whether the whale works.
  const blind = follower()
  assert.deepEqual(blind.observe({ running: true, entries: null, now: t }), { busy: true, reply: null })

  // The fallback read-aloud path keeps its markdown→speech shaper.
  const spoken = module.exports.speakable('## 结论\n\n- `dispatch_task` 已派工\n\n```js\nconst x = 1\n```\n完成。')
  assert.equal(/[`#*]/.test(spoken), false, 'markdown markers are stripped for speech')
  assert.equal(spoken.includes('const x = 1'), false, 'code blocks are not read aloud')
  assert.match(spoken, /结论/)
  assert.match(spoken, /完成/)
  // The speech tag stays BCP-47 for the synthesizer, while the transcription
  // hint stays the bare two-letter form.
  assert.match(module.exports.speechLanguage(), /^(zh-CN|en-US)$/)
  console.log('ok 4 — the reply follower shows each closed turn once, interjections included; the speech shaper stays')
}

// --- 4b. a turn-end rewrite replaces its draft in the reply -------------

{
  // The copy in client.js must name the same notice adhd.js steers.
  assert.equal(module.exports.REWRITE_NOTICE.summary, REWRITE_NOTICE_SUMMARY, 'the rewrite summary matches adhd.js')
  assert.equal(module.exports.REWRITE_NOTICE.kind, 'plugin:discipline-whale:brevity')

  const say = (seq, turn, step, text) => ({
    type: 'event',
    event: { type: 'assistant/message', seq, data: { turn, step, message: { content: [{ type: 'text', text }] } } },
  })
  const notice = (seq, summary) => ({
    type: 'event',
    event: {
      type: 'user/message',
      seq,
      data: { role: 'user', content: [{ type: 'text', text: '[Discipline Whale] …' }], source: { kind: 'plugin:discipline-whale:brevity', form: 'notice', summary } },
    },
  })
  const start = (seq, turn) => ({ type: 'event', event: { type: 'turn/start', seq, data: { turn } } })

  // One turn: a long draft, the rewrite notice, the short answer.
  const rewritten = [start(1, 2), say(2, 2, 1, '长稿'.repeat(50)), notice(3, REWRITE_NOTICE_SUMMARY), say(4, 2, 2, '短答案。')]
  assert.equal(module.exports.replyTextAfter(rewritten, 0), '短答案。', 'only the rewrite is shown and read aloud')

  // Two new turns, the second rewritten: the first turn's reply is kept.
  const twoTurns = [start(1, 2), say(2, 2, 1, '第一轮。'), start(3, 3), say(4, 3, 1, '长稿'), notice(5, REWRITE_NOTICE_SUMMARY), say(6, 3, 2, '重写。')]
  assert.equal(module.exports.replyTextAfter(twoTurns, 0), '第一轮。重写。', 'a rewrite drops only its own turn’s draft')

  // The mid-turn reminder is not a rewrite: the multi-step reply stays whole.
  const reminded = [start(1, 2), say(2, 2, 1, '前半。'), notice(3, 'revision: over-long prose'), say(4, 2, 2, '后半。')]
  assert.equal(module.exports.replyTextAfter(reminded, 0), '前半。后半。', 'a mid-turn reminder keeps every step')

  // The follower hands over the rewrite once the turn closes.
  const follower = module.exports.createReplyFollower({ graceMs: 10_000 })
  follower.observe({ running: false, entries: [], now: 0 })
  const closed = [...rewritten, { type: 'event', event: { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } } }]
  assert.equal(follower.observe({ running: false, entries: closed, now: 1 }).reply, '短答案。', 'the follower shows the rewrite')

  console.log('ok 4b — a turn-end rewrite replaces its draft in the dock reply; a mid-turn reminder does not')
}

// --- 3a. never waiting: sending does not wait, reading aloud cannot hang -

{
  // Three things must stay true, each with its own failure mode:
  //
  //   SENDING never waits for the whale — after a sentence is handed over the
  //   microphone keeps listening, so the next sentence can follow at once.
  //
  //   OFF (the default) — there is no speech event at all, so the reply path
  //   must not touch the speech engine or pause the microphone.
  //
  //   ON — the reply is read with detection paused, but the engine may never
  //   fire `onend`. The bounded timer must settle the promise anyway.
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const codeOf = (from, to) => {
    const begin = source.indexOf(from)
    const end = source.indexOf(to, begin + from.length)
    assert.ok(begin > 0 && end > begin, `${from} exists`)
    return source.slice(begin, end).split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')).join('\n')
  }

  // --- DEFAULT OFF -------------------------------------------------------
  assert.match(source, /const \[speak, setSpeak\] = React\.useState\(false\)/,
    'read-aloud state must default to false')
  assert.match(source, /const speakRef = React\.useRef\(false\)/,
    'the ref read by the async reply path must default to false')

  // --- ASSERTION 1: a finished sentence never pauses listening -----------
  const done = codeOf('async function utteranceDone(', 'async function refuseUtterance(')
  assert.equal(/hold\(\)|mute\(\)/.test(done), false, 'a finished sentence leaves the microphone listening')
  assert.match(done, /enqueue\(/, 'it is queued for sending, not awaited')
  const submit = codeOf('async function submit(', 'async function followReplies(')
  assert.equal(/readAloud|speakReply|sleep\(|running/.test(submit), false, 'sending never waits for the whale or its reply')
  assert.equal(/listen\(\)/.test(submit), false, 'sending has no microphone to reopen: it never closed it')
  const listen = codeOf('async function listen(', 'async function utteranceDone(')
  assert.equal(/running/.test(listen), false, 'listening never waits for the whale to finish')

  // --- ASSERTION 2: OFF shows the reply without touching speech ----------
  const follow = codeOf('async function followReplies(', 'async function readAloud(')
  const shown = follow.indexOf('setReply(seen.reply)')
  const gated = follow.indexOf('if (speakRef.current) offerReply(')
  assert.ok(shown > 0 && gated > shown, 'the reply is shown first, and offered to the reader only when the switch is on')
  assert.equal(/speakReply|speechSynthesis|SpeechSynthesisUtterance|hold\(\)|mute\(\)/.test(follow), false,
    'following replies never touches speech or the microphone itself')
  // The reader is not awaited here: waiting on a 20-second read is what let
  // replies pile up and be read as a backlog afterwards.
  assert.equal(/await readAloud|await offerReply/.test(follow), false,
    'the follower never waits for a read: a reply that arrives meanwhile replaces it instead of queueing')
  const reading = codeOf('async function readAloud(', 'async function stopTalking(')
  assert.match(reading, /userSpeakingRef\.current/, 'reading aloud waits while the person is mid-sentence')
  assert.match(reading, /mute\(\)[\s\S]*speakReply[\s\S]*void listen\(\)/, 'detection pauses for the reading and resumes after it')

  // --- ASSERTION 3: ON awaits, but the wait is bounded -------------------
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

  console.log('ok 3a — sending never waits for the whale; off never touches speech; on is bounded by a timeout backstop')
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
  // The turn-tail seat is gone on purpose: a turn's workspace tags now sit on
  // the user row that caused the dispatch (see test/report-origin-client.mjs),
  // so no assistant-reply footer registers a slot. `sidebar.session.row.leading`
  // is gone for the same kind of reason: that seat is the session's status dot,
  // so the workspace color moved to the folder row and the whale logo to the row
  // paint (see test/client-memory.mjs, checks 11/12/14).
  assert.deepEqual(injected.sort(), ['conversation.session.header.actions', 'main', 'shell.overlay', 'sidebar.panellist'])
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

// --- 7. reading a reply aloud: the backend first, the browser as fallback ---

{
  // `speakViaBackend` is the browser side of the speech route. What matters is
  // that every failure answers `ok: false` with a code instead of throwing, so
  // the caller can fall back and say so — a silent downgrade is the bug this
  // guards against.

  // 1. The happy path: one POST of the text alone, then playback.
  const seen = []
  let played = null
  // A player that ends: `done` must settle on the element's own `onended`,
  // not only on the bounded timer.
  const fakeAudio = class {
    constructor(url) { played = { url }; fakeAudio.instance = this }
    play() {
      played.playing = true
      // Fired asynchronously, the way a real element fires it.
      queueMicrotask(() => { if (typeof this.onended === "function") this.onended() })
      return Promise.resolve()
    }
  }
  const urls = { created: [], createObjectURL: (blob) => { urls.created.push(blob); return "blob:fake" }, revokeObjectURL: () => {} }
  const backend = module.exports.speakViaBackend("你好，**鲸鱼**", {
    fetch: async (url, init) => {
      seen.push({ url, init })
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/wav", "x-dw-tts-seconds": "1.5" },
      })
    },
    Audio: fakeAudio,
    URL: urls,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type } },
    setTimeout: () => 0,
  })
  assert.equal(backend.ok, true)
  const played1 = await backend.done
  assert.equal(played1.ok, true, "a served audio body reports success")
  assert.equal(played1.seconds, 1.5, "the declared duration comes back for the call's own bookkeeping")
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, "/api/discipline-whale/voice/speak", "the page talks to the plugin route, never a provider URL")
  // Only the text is sent: the key stays on the server.
  assert.deepEqual(JSON.parse(seen[0].init.body), { text: "你好，鲸鱼" })
  assert.equal(Object.keys(JSON.parse(seen[0].init.body)).includes("apiKey"), false)
  assert.equal(played.playing, true, "the audio element is asked to play")

  // 2. Server refusals map to a code, never a throw.
  const refusals = [
    { status: 503, body: { error: { code: "tts/missing-key" } }, code: "tts/missing-key" },
    { status: 502, body: { error: { code: "tts/no-audio-in-answer" } }, code: "tts/no-audio-in-answer" },
    { status: 504, body: { error: { code: "tts/backend-timeout" } }, code: "tts/backend-timeout" },
    { status: 500, body: "not json", code: "http-500" },
  ]
  for (const item of refusals) {
    const result = await module.exports.speakViaBackend("hi", {
      fetch: async () => new Response(typeof item.body === "string" ? item.body : JSON.stringify(item.body), { status: item.status }),
      Audio: fakeAudio,
      URL: urls,
      Blob: class {},
      setTimeout: () => 0,
    }).done
    assert.equal(result.ok, false, `a ${item.status} refusal is a failure, not a success`)
    assert.equal(result.code, item.code)
  }

  // 3. Transport failure, empty audio and no player are all failures.
  const unreachable = await module.exports.speakViaBackend("hi", {
    fetch: async () => { throw new Error("net down") },
    Audio: fakeAudio, URL: urls, Blob: class {}, setTimeout: () => 0,
  }).done
  assert.equal(unreachable.code, "unreachable")
  const empty = await module.exports.speakViaBackend("hi", {
    fetch: async () => new Response(new Uint8Array(0), { status: 200 }), Audio: fakeAudio, URL: urls, Blob: class {}, setTimeout: () => 0,
  }).done
  assert.equal(empty.code, "empty")
  const unsupported = await module.exports.speakViaBackend("hi", { fetch: async () => new Response(""), setTimeout: () => 0 })
  assert.equal(unsupported.ok, false, "a host without Audio falls back instead of throwing")

  // 4. The fallback reason becomes one short dock line, and an unknown code
  //    still says something true rather than showing a raw server code.
  const notice = module.exports.ttsFallbackNotice
  assert.equal(notice("tts/missing-key"), "ttsMissingKey")
  assert.equal(notice("tts/invalid-key"), "ttsInvalidKey")
  assert.equal(notice("tts/backend-timeout"), "ttsTimeout")
  assert.equal(notice("tts/no-audio-in-answer"), "ttsBadAudio")
  assert.equal(notice("tts/undecodable-audio"), "ttsBadAudio")
  assert.equal(notice("tts/backend-unreachable"), "ttsUnreachable")
  assert.equal(notice("tts/text-too-long"), "ttsTooLong")
  assert.equal(notice("something unexpected"), "ttsFallbackGeneric")
  assert.equal(notice(undefined), "ttsFallbackGeneric")
  // Every mapped line exists in both dictionaries, so no raw key reaches the UI.
  const { zh, en } = module.exports.DICTIONARIES
  for (const key of [notice("tts/missing-key"), notice("tts/bad"), notice(undefined)]) {
    assert.equal(typeof zh[key], "string", `zh.${key} must exist`)
    assert.equal(typeof en[key], "string", `en.${key} must exist`)
  }
  console.log("ok 7 — read-aloud prefers the backend, and every failure falls back with a named reason")
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
