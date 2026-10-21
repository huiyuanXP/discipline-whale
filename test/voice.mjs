/**
 * Voice tests for discipline-whale.
 *
 * Three layers, each testable without a browser:
 *
 *   1. the HTTP route — validation, missing key, upstream error mapping,
 *      size/duration caps, and the never-hang guarantee
 *   2. the silence detector — synthetic PCM frames prove the 10s rule, the
 *      minimum-speech filter, and the maximum-duration backstop
 *   3. the call guard — a transcript that arrives after hangup or after a
 *      session switch must be dropped
 *
 * Run: node test/voice.mjs
 */

import assert from 'node:assert/strict'

import {
  ACCEPTED_AUDIO_TYPES,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  MODEL,
  VOICE_ERRORS,
  VOICE_ROUTE,
  VOICE_STATUS_ROUTE,
  audioSecondsOf,
  baseUrl,
  classifyUpstream,
  registerVoiceRoutes,
  sayHandler,
  voiceHandler,
} from '../voice.js'
import {
  DEFAULT_SILENCE_OPTIONS,
  createCallGuard,
  createSilenceDetector,
} from '../voice-silence.js'

// --- fixtures -------------------------------------------------------------

/** One 44-byte PCM16 WAV header plus `seconds` of silence. */
function wavBytes(seconds, sampleRate = 16000) {
  const samples = Math.floor(seconds * sampleRate)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const text = (at, value) => {
    for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  return bytes
}

/** A JSON upstream answer, as the fake fetch returns it. */
function jsonResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build one handler over a stub fetch and a stub environment. */
function handlerWith(fetchImpl, env = { SOCLAAS_API_KEY: 'test-key-not-real' }) {
  return voiceHandler({ fetch: fetchImpl, env })
}

const post = (body, contentType = 'audio/wav', url = `http://dsh${VOICE_ROUTE}`) =>
  new Request(url, { method: 'POST', headers: { 'content-type': contentType }, body })

// --- 1. the route ---------------------------------------------------------

{
  // A key-free status answer proves configuration without leaking the key.
  const status = await handlerWith(undefined, {})(new Request(`http://dsh${VOICE_STATUS_ROUTE}`))
  assert.equal(status.status, 200)
  const info = await status.json()
  assert.equal(info.configured, false)
  assert.equal(info.model, MODEL)
  assert.equal(JSON.stringify(info).includes('test-key'), false)

  const configured = await handlerWith(undefined)(new Request(`http://dsh${VOICE_STATUS_ROUTE}`))
  assert.equal((await configured.json()).configured, true)
  console.log('ok 1 — the status route reports configuration without the key')
}

{
  // Missing key: structured 503, no upstream call at all.
  let called = 0
  const handle = handlerWith(() => { called += 1; return jsonResponse(200, { text: 'x' }) }, {})
  const response = await handle(post(wavBytes(1)))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, VOICE_ERRORS.missingKey)
  assert.equal(called, 0, 'a missing key must not reach the network')

  // Unsupported container and empty body are refused before forwarding.
  const wrongType = await handle(post(wavBytes(1), 'text/plain'))
  assert.equal(wrongType.status, 415)
  const wrongTypeBody = await wrongType.json()
  assert.equal(wrongTypeBody.error.code, VOICE_ERRORS.contentType)
  assert.deepEqual(wrongTypeBody.error.accepted, [...ACCEPTED_AUDIO_TYPES.keys()])

  const empty = await handlerWith(() => jsonResponse(200, { text: 'x' }))(post(new Uint8Array(0)))
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error.code, VOICE_ERRORS.empty)
  console.log('ok 2 — missing key, wrong container and empty audio are structured refusals')
}

{
  // Size cap: a declared oversized upload is refused before it is read.
  const handle = handlerWith(() => jsonResponse(200, { text: 'never' }))
  const oversized = await handle(post(new Uint8Array(MAX_AUDIO_BYTES + 1)))
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).error.code, VOICE_ERRORS.tooLarge)

  // Duration cap: the WAV header is enough to reject a 121s recording.
  const tooLong = await handle(post(wavBytes(MAX_AUDIO_SECONDS + 1)))
  assert.equal(tooLong.status, 413)

  // The duration reader only measures canonical PCM WAV; other containers are undefined.
  assert.equal(audioSecondsOf(wavBytes(2)), 2)
  assert.equal(audioSecondsOf(new Uint8Array([1, 2, 3])), undefined)
  console.log('ok 3 — byte and duration caps refuse oversized recordings')
}

{
  // Happy path: multipart to the configured base URL, model and language forwarded.
  const seen = []
  const handle = handlerWith(async (url, init) => {
    seen.push({ url, init })
    return jsonResponse(200, { text: '你好自律鲸鱼' })
  })
  const response = await handle(post(wavBytes(2), 'audio/wav', `http://dsh${VOICE_ROUTE}?language=zh`))
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()), { text: '你好自律鲸鱼', model: MODEL, audioSeconds: 2 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${baseUrl({})}/audio/transcriptions`)
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-key-not-real')
  const form = seen[0].init.body
  assert.equal(form.get('model'), MODEL)
  assert.equal(form.get('language'), 'zh')
  assert.equal(form.get('response_format'), 'json')
  assert.ok(form.get('file') instanceof Blob)
  console.log('ok 4 — one recording is forwarded once and its transcript returned')
}

{
  // Upstream failures map to distinct, explainable codes with a status.
  const cases = [
    { status: 401, body: { error: 'invalid API key' }, code: VOICE_ERRORS.invalidKey, http: 502 },
    { status: 503, body: { error: 'public model "x" is not configured' }, code: VOICE_ERRORS.noModel, http: 503 },
    { status: 500, body: 'Internal Server Error', code: VOICE_ERRORS.upstream, http: 502 },
    { status: 504, body: { error: 'gateway timeout' }, code: VOICE_ERRORS.timeout, http: 504 },
  ]
  for (const item of cases) {
    const handle = handlerWith(() => jsonResponse(item.status, item.body))
    const response = await handle(post(wavBytes(1)))
    assert.equal(response.status, item.http, `HTTP status for ${item.code}`)
    const payload = await response.json()
    assert.equal(payload.error.code, item.code)
    assert.equal(payload.error.upstreamStatus, item.status)
    assert.equal(JSON.stringify(payload).includes('test-key-not-real'), false, 'the key never reaches a response')
  }

  // A transport failure is a 502 that names the host, never the key.
  const unreachable = await handlerWith(() => { throw new Error('getaddrinfo ENOTFOUND soclaas-api.comp.nus.edu.sg') })
  const response = await unreachable(post(wavBytes(1)))
  assert.equal(response.status, 502)
  const payload = await response.json()
  assert.equal(payload.error.code, VOICE_ERRORS.unreachable)
  assert.match(payload.error.message, /ENOTFOUND/)

  // An upstream body that is JSON but carries no text is an empty transcript.
  const blank = await handlerWith(() => jsonResponse(200, { text: '   ' }))
  assert.equal((await blank(post(wavBytes(1)))).status, 422)

  // A timeout aborts rather than hanging the browser (50ms so the test is fast).
  const hanging = voiceHandler({
    env: { SOCLAAS_API_KEY: 'test-key-not-real' },
    timeoutMs: 50,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  })
  const slow = await voiceHandler({ env: {} })(post(wavBytes(1)))
  assert.equal(slow.status, 503, 'no key means no request, even when fetch would hang')
  const started = Date.now()
  const timedOut = await hanging(post(wavBytes(1)))
  assert.equal(timedOut.status, 504)
  assert.equal((await timedOut.json()).error.code, VOICE_ERRORS.timeout)
  assert.ok(Date.now() - started < 5_000)

  // classifyUpstream is the mapping the UI relies on.
  assert.equal(classifyUpstream(401, ''), VOICE_ERRORS.invalidKey)
  assert.equal(classifyUpstream(500, 'public model "m" is not configured'), VOICE_ERRORS.noModel)
  assert.equal(classifyUpstream(500, 'boom'), VOICE_ERRORS.upstream)
  console.log('ok 5 — upstream failures map to invalid-key / no-model / unreachable / timeout')
}

{
  // Route registration goes through the Host's connection fetch registry —
  // the same path home.js uses, no separate HTTP server.
  const routes = []
  const connection = { fetch: { register: async (route) => { routes.push(route); return async () => {} } } }
  await registerVoiceRoutes(connection, { env: { SOCLAAS_API_KEY: 'x' } })
  assert.deepEqual(routes.map((route) => route.path).sort(), [VOICE_ROUTE, VOICE_STATUS_ROUTE].sort())
  assert.ok(routes.every((route) => route.requestBody === 'buffered'))
  assert.deepEqual(routes[0].methods, ['GET', 'POST'])
  console.log('ok 6 — both voice routes register on connection.fetch')
}

// --- 2. the silence detector ---------------------------------------------

const RATE = 16000
const FRAME_MS = 20
const FRAME_SAMPLES = (RATE * FRAME_MS) / 1000

/** One frame of a constant-amplitude tone; `amplitude` 0 is digital silence. */
function frame(amplitude) {
  const samples = new Float32Array(FRAME_SAMPLES)
  for (let i = 0; i < samples.length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return samples
}

/** Feed an amplitude for `ms` and return the detector's terminal decision. */
function feed(detector, { amplitude, ms }) {
  const frames = Math.round(ms / FRAME_MS)
  let decision
  for (let i = 0; i < frames; i += 1) {
    decision = detector.push(frame(amplitude), FRAME_MS)
    if (decision?.action === 'stop') return { decision, elapsedMs: detector.elapsedMs() }
  }
  return { decision, elapsedMs: detector.elapsedMs() }
}

{
  // Parameters are named constants, so the 10s rule is one edit away.
  assert.equal(DEFAULT_SILENCE_OPTIONS.silenceMs, 10_000)
  assert.equal(DEFAULT_SILENCE_OPTIONS.minSpeechMs, 500)
  assert.equal(DEFAULT_SILENCE_OPTIONS.maxRecordingMs, 60_000)
  assert.equal(DEFAULT_SILENCE_OPTIONS.minRecordingMs, 1_000)
  assert.equal(DEFAULT_SILENCE_OPTIONS.calibrationMs, 500)
  console.log('ok 7 — 10s silence, 500ms minimum speech and 60s cap are named constants')
}

{
  // A silent room: 10s of quiet ends the utterance, and no speech means discard.
  const detector = createSilenceDetector()
  const { decision, elapsedMs } = feed(detector, { amplitude: 0.002, ms: 12_000 })
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'no-speech')
  assert.equal(decision.upload, false)
  assert.ok(elapsedMs >= 10_000 && elapsedMs <= 12_000, `stopped at ${elapsedMs}ms`)

  // The same run must NOT stop early: 9s of quiet is still listening.
  const patient = createSilenceDetector()
  const quiet = feed(patient, { amplitude: 0.002, ms: 9_000 })
  assert.equal(quiet.decision, undefined, 'nothing to decide before the 10s threshold')
  console.log('ok 8 — 10s of silence ends the utterance and a silent room uploads nothing')
}

{
  // Speech, then quiet: the upload happens 10s after the voice stops.
  // The first 500ms are the room-tone calibration window, as in a real call UI.
  const detector = createSilenceDetector()
  const calibration = feed(detector, { amplitude: 0.002, ms: 500 })
  assert.equal(calibration.decision, undefined)
  assert.ok(detector.threshold() >= DEFAULT_SILENCE_OPTIONS.minThreshold, 'never below the absolute floor')
  assert.ok(detector.threshold() < 0.05, 'a quiet room does not raise the threshold into speech range')
  const speech = feed(detector, { amplitude: 0.2, ms: 1_000 })
  assert.equal(speech.decision, undefined)
  const { decision, elapsedMs } = feed(detector, { amplitude: 0.002, ms: 11_000 })
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'silence')
  assert.equal(decision.upload, true)
  assert.equal(decision.speechMs, 1_000)
  assert.ok(elapsedMs >= 11_400 && elapsedMs < 12_600, `stopped at ${elapsedMs}ms`)
  console.log('ok 9 — speech then 10s of quiet stops and marks the recording for upload')
}

{
  // A noisy room: the threshold follows the measured floor, so quiet speech
  // above that floor still counts as speech.
  const detector = createSilenceDetector()
  const roomNoise = 0.06
  feed(detector, { amplitude: roomNoise, ms: 500 })
  assert.ok(detector.threshold() > roomNoise, 'the threshold sits above the measured floor')
  assert.ok(detector.threshold() < 0.3, 'the threshold is not a fixed magic number above speech')
  feed(detector, { amplitude: 0.35, ms: 800 })
  const stopped = feed(detector, { amplitude: roomNoise, ms: 11_000 })
  assert.equal(stopped.decision.reason, 'silence')
  assert.equal(stopped.decision.upload, true)
  console.log('ok 10 — the threshold adapts to the room instead of being one magic number')
}

{
  // A 300ms blip is not a useful utterance.
  const detector = createSilenceDetector()
  feed(detector, { amplitude: 0.002, ms: 500 })
  feed(detector, { amplitude: 0.2, ms: 300 })
  const { decision } = feed(detector, { amplitude: 0.002, ms: 11_000 })
  assert.equal(decision.reason, 'no-speech')
  assert.equal(decision.upload, false)
  console.log('ok 11 — an utterance shorter than the minimum speech threshold is not uploaded')
}

{
  // Maximum duration: continuous speech is cut at 60s.
  const detector = createSilenceDetector()
  feed(detector, { amplitude: 0.002, ms: 500 })
  const { decision, elapsedMs } = feed(detector, { amplitude: 0.3, ms: 65_000 })
  assert.equal(decision.reason, 'max-duration')
  assert.equal(decision.upload, true)
  assert.ok(elapsedMs >= 59_900 && elapsedMs < 60_200, `cut at ${elapsedMs}ms`)
  console.log('ok 12 — the 60s backstop cuts a recording that never goes quiet')
}

{
  // Minimum recording length: a stop request before 1s is refused, so a
  // stray click cannot produce an empty upload.
  const detector = createSilenceDetector()
  feed(detector, { amplitude: 0.002, ms: 400 })
  assert.equal(detector.canStop(), false)
  feed(detector, { amplitude: 0.002, ms: 800 })
  assert.equal(detector.canStop(), true)
  console.log('ok 12b — the 1s minimum recording length is enforced')
}

{
  // A loud room: the threshold tracks the floor proportionally, and returning
  // to the room tone (not to digital silence) is what ends the utterance.
  const detector = createSilenceDetector()
  const loud = 0.25
  feed(detector, { amplitude: loud, ms: 500 })
  assert.ok(detector.threshold() > loud, 'in a loud room the threshold sits above the room tone')
  feed(detector, { amplitude: 0.9, ms: 700 })
  const stopped = feed(detector, { amplitude: loud, ms: 11_000 })
  assert.equal(stopped.decision.reason, 'silence')
  assert.equal(stopped.decision.upload, true)
  console.log('ok 12c — a loud room raises the threshold, and room tone still counts as quiet')
}

// --- 2b. the say route ----------------------------------------------------

{
  const calls = []
  const sessionController = {
    prompt: async (request, signal) => {
      signal.throwIfAborted()
      calls.push(request)
      return { accepted: true }
    },
  }
  const handle = sayHandler({ sessionController, readState: async () => ({ mainSessionId: 'session-main' }) })
  const say = (body) => handle(new Request('http://dsh/api/discipline-whale/voice/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

  const ok = await say({ text: '  你好，鲸鱼  ' })
  assert.equal(ok.status, 200)
  const payload = await ok.json()
  assert.equal(payload.sessionId, 'session-main')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-main')
  assert.equal(calls[0].mode, 'queue')
  assert.equal(calls[0].content[0].text, '你好，鲸鱼')
  assert.match(String(calls[0].requestId), /^[0-9a-f-]{36}$/)

  // Blank text is refused and never reaches the session.
  const blank = await say({ text: '   ' })
  assert.equal(blank.status, 400)
  assert.equal((await blank.json()).error.code, VOICE_ERRORS.emptyText)
  assert.equal(calls.length, 1)

  // A client cannot address another session: the route only knows the recorded main one.
  const other = await say({ text: 'hi', sessionId: 'session-somebody-else' })
  assert.equal(other.status, 200)
  assert.equal(calls.at(-1).sessionId, 'session-main', 'the recorded main session wins over a client-supplied id')

  // No main session recorded yet: an explicit 409, not a silent drop.
  const missing = await sayHandler({ sessionController, readState: async () => ({}) })(new Request('http://dsh/x', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
  }))
  assert.equal(missing.status, 409)
  assert.equal((await missing.json()).error.code, VOICE_ERRORS.noMainSession)

  // A malformed body is a 400.
  const broken = await say('{not json')
  assert.equal(broken.status, 400)
  console.log('ok 12d — one transcript is queued into the recorded main session only')
}

// --- 3. the call guard ----------------------------------------------------

{
  const guard = createCallGuard()
  guard.setTarget('session-main')
  const first = guard.begin('call-1')
  assert.equal(guard.isCurrent(first), true)

  // Hangup invalidates the in-flight transcript.
  guard.end('call-1')
  assert.equal(guard.isCurrent(first), false)
  assert.equal(guard.accepts(first, 'session-main'), false)

  // A second call makes the first call's late transcript stale.
  const second = guard.begin('call-2')
  assert.equal(guard.accepts(second, 'session-main'), true)
  assert.equal(guard.accepts(first, 'session-main'), false)

  // Switching the target session mid-flight drops the result too.
  guard.setTarget('session-other')
  assert.equal(guard.accepts(second, 'session-main'), false)
  assert.equal(guard.accepts(second, 'session-other'), true)
  console.log('ok 13 — a late transcript cannot land after hangup or a session switch')
}

console.log('\nAll discipline-whale voice checks passed.')
