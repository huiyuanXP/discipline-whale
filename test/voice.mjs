/**
 * Voice tests for discipline-whale.
 *
 * Three layers, each testable without a browser:
 *
 *   1. the HTTP route — validation, missing key, upstream error mapping,
 *      size/duration caps, and the never-hang guarantee
 *   2. the turn rules — the Silero VAD parameters, the loudness floor that
 *      keeps distant talk out, and the away guard that closes the microphone
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
  SEGMENT_LIMITS,
  acceptedTranscript,
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
  assert.equal(form.get('response_format'), 'verbose_json', 'segment confidence is requested so hallucinations can be dropped')
  assert.ok(form.get('file') instanceof Blob)
  console.log('ok 4 — one recording is forwarded once and its transcript returned')
}

{
  // What Whisper invents from room tone is refused before it can be sent.
  const answer = (body) => handlerWith(async () => jsonResponse(200, body))(post(wavBytes(2)))
  const segment = (text, nsp, logprob = -0.2, ratio = 1.2) => ({ text, no_speech_prob: nsp, avg_logprob: logprob, compression_ratio: ratio })

  // Measured on SoCLaaS: room tone → a subtitle credit with nsp 0.83 and a
  // confident logprob. Whisper's own AND-rule would keep it; this route does not.
  const roomTone = await answer({ text: '由 Amara.org 社群提供的字幕', segments: [segment('由 Amara.org 社群提供的字幕', 0.83, -0.27)] })
  assert.equal(roomTone.status, 422)
  const roomBody = await roomTone.json()
  assert.equal(roomBody.error.code, VOICE_ERRORS.rejectedTranscript)
  assert.deepEqual(roomBody.error.reasons, ['no-speech-prob'])

  // A confident segment that is still a known credit is dropped by the list.
  const credit = await (await answer({ text: '字幕志愿者 杨茜茜', segments: [segment('字幕志愿者 杨茜茜', 0.1)] })).json()
  assert.deepEqual(credit.error.reasons, ['known-hallucination'])
  const sign = await (await answer({ text: '谢谢观看！', segments: [segment('谢谢观看！', 0.2)] })).json()
  assert.equal(sign.error.code, VOICE_ERRORS.rejectedTranscript, 'a whole-utterance sign-off is dropped')

  // The same words inside real speech stay: only whole-utterance matches drop.
  const real = await (await answer({ text: '帮我查一下，谢谢观看的那个视频', segments: [segment('帮我查一下，谢谢观看的那个视频', 0.02)] })).json()
  assert.equal(real.text, '帮我查一下，谢谢观看的那个视频')

  // Mixed: the unsure trailing segment and the repetitive one go, the clear one stays.
  const mixed = await (await answer({
    text: '派一个任务给写作区 嗯嗯嗯嗯嗯嗯嗯嗯 谢谢',
    segments: [segment('派一个任务给写作区', 0.03), segment('嗯嗯嗯嗯嗯嗯嗯嗯', 0.1, -0.3, 3.1), segment('谢谢', 0.7, -0.9)],
  })).json()
  assert.equal(mixed.text, '派一个任务给写作区')

  // Requests that merely mention subtitles are speech to the whale, not credits.
  for (const request of ['帮我查一下这部电影有没有中文字幕', '让字幕组那个任务继续', 'add subtitles by tomorrow']) {
    const kept = await (await answer({ text: request, segments: [segment(request, 0.02)] })).json()
    assert.equal(kept.text, request, `a real request is kept: ${request}`)
  }
  // A credit line on its own is still dropped.
  for (const credit of ['中文字幕', '字幕由某某社区提供', '由 Amara.org 社群提供的字幕']) {
    const dropped = await (await answer({ text: credit, segments: [segment(credit, 0.1)] })).json()
    assert.equal(dropped.error?.code, VOICE_ERRORS.rejectedTranscript, `a bare credit line is dropped: ${credit}`)
  }

  // A backend without segments is judged on its text alone.
  assert.equal((await (await answer({ text: '你好鲸鱼' })).json()).text, '你好鲸鱼')
  assert.equal((await (await answer({ text: 'Thank you for watching.' })).json()).error.code, VOICE_ERRORS.rejectedTranscript)

  // The limits are named, not buried.
  assert.deepEqual({ ...SEGMENT_LIMITS }, { noSpeechProbMax: 0.6, avgLogprobMin: -1.0, compressionRatioMax: 2.4 })
  assert.equal(acceptedTranscript({ text: '  ' }).text, '')
  console.log('ok 4b — room-tone hallucinations, credits and unsure segments are refused; real speech passes')
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

// --- 2. the turn rules ----------------------------------------------------

const RATE = 16000

/** `seconds` of a constant-amplitude tone; amplitude 0 is digital silence. */
function tone(amplitude, seconds) {
  const samples = new Float32Array(Math.round(RATE * seconds))
  for (let i = 0; i < samples.length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return samples
}

/** Concatenate sample runs. */
function join(...parts) {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

{
  // Silero VAD through vad-web decides when a turn starts and ends. The
  // parameters are named, in one place, and close to the mature defaults:
  // Silero's 0.5 start threshold with the end threshold 0.15 lower (LiveKit),
  // a 2s pause to end the turn (between OpenAI's 500ms server VAD and the
  // 2–8s of semantic turn detection), a 500ms pad and a 500ms speech minimum.
  assert.deepEqual({ ...TURN_OPTIONS }, {
    model: 'v5',
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    redemptionMs: 2_000,
    preSpeechPadMs: 500,
    minSpeechMs: 500,
  })
  assert.ok(Object.isFrozen(TURN_OPTIONS))
  assert.ok(REDEMPTION_CHOICES_MS.includes(TURN_OPTIONS.redemptionMs), 'the default pause is one of the offered choices')
  assert.equal(MAX_SPEECH_MS, 60_000)
  console.log('ok 7 — Silero turn-taking parameters are named constants with mature defaults; 60s caps one utterance')
}

{
  // The loudness floor keeps talk across the room out. The level is the
  // 90th-percentile frame, so the pad and the trailing pause do not dilute it.
  assert.equal(speechLevelDbfs(tone(0, 1)), -Infinity, 'digital silence has no level')
  assert.ok(Math.abs(speechLevelDbfs(tone(0.1, 1)) - -23) < 0.2, 'a 0.1 sine sits near -23 dBFS')
  const near = join(tone(0.0005, 0.5), tone(0.1, 1), tone(0.0005, 2))
  assert.ok(speechLevelDbfs(near) > MIN_SPEECH_LEVEL_DBFS, 'near speech padded with silence still passes')
  const far = join(tone(0.0005, 0.5), tone(0.003, 1), tone(0.0005, 2))
  assert.ok(speechLevelDbfs(far) < MIN_SPEECH_LEVEL_DBFS, 'distant talk stays under the floor')
  assert.equal(MIN_SPEECH_LEVEL_DBFS, -45)
  console.log('ok 8 — near speech passes the loudness floor, distant talk and silence do not')
}

{
  // Away: two minutes of LISTENING without an accepted turn closes the mic.
  const guard = createAwayGuard()
  assert.equal(AWAY_IDLE_MS, 120_000)
  assert.equal(AWAY_MAX_REJECTIONS, 3)
  guard.resume(0)
  assert.equal(guard.reason(119_000), null)
  assert.equal(guard.reason(120_000), 'idle')

  // Time the whale spends replying (or a mute) is banked, not counted.
  const patient = createAwayGuard()
  patient.resume(0)
  patient.suspend(60_000)
  assert.equal(patient.reason(10 * 60_000), null, 'a ten-minute reply never reads as absence')
  patient.resume(10 * 60_000)
  assert.equal(patient.reason(10 * 60_000 + 59_000), null)
  assert.equal(patient.reason(10 * 60_000 + 60_000), 'idle', 'only the two listening minutes add up')

  // An accepted turn, or a touched control, proves presence and restarts the clock.
  const talking = createAwayGuard()
  talking.resume(0)
  talking.accepted(100_000)
  assert.equal(talking.reason(200_000), null)
  talking.present(210_000)
  assert.equal(talking.reason(320_000), null)

  // Three refusals in a row close it too; an accepted turn clears the count.
  const noisy = createAwayGuard()
  noisy.resume(0)
  noisy.rejected()
  noisy.rejected()
  assert.equal(noisy.reason(1_000), null)
  noisy.accepted(2_000)
  noisy.rejected()
  noisy.rejected()
  assert.equal(noisy.reason(3_000), null, 'refusals count only in a row')
  noisy.rejected()
  assert.equal(noisy.reason(3_000), 'rejections')
  noisy.reset()
  assert.equal(noisy.reason(1_000_000), null, 'reset forgets the stretch and the refusals')
  console.log('ok 9 — the away guard counts listening time and refusals in a row, never reply time')
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
  console.log('ok 10 — one transcript is queued into the recorded main session only')
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
  console.log('ok 11 — a late transcript cannot land after hangup or a session switch')
}

// --- 4. the detector's files, served by the plugin -------------------------

{
  const { VOICE_ASSETS, VOICE_ASSET_ROUTE, registerVoiceAssetRoutes, voiceAssetHandler } = await import('../voice-assets.js')
  // One exact route per file, on the same connection as the voice routes.
  const routes = []
  await registerVoiceAssetRoutes({ fetch: { register: async (route) => { routes.push(route); return async () => {} } } })
  assert.deepEqual(routes.map((route) => route.path).sort(), Object.keys(VOICE_ASSETS).map((name) => `${VOICE_ASSET_ROUTE}/${name}`).sort())
  assert.ok(routes.every((route) => route.methods.length === 1 && route.methods[0] === 'GET'))
  assert.deepEqual(Object.keys(VOICE_ASSETS).sort(), [
    'bundle.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort.wasm.min.js', 'silero_vad_v5.onnx', 'vad.worklet.bundle.min.js',
  ])

  const reads = []
  const handle = voiceAssetHandler({
    distDirOf: (pkg) => `/pkgs/${pkg}/dist`,
    readFile: async (path) => { reads.push(path); return new Uint8Array([0, 97, 115, 109]) },
  })
  const wasm = await handle(new Request(`http://dsh${VOICE_ASSET_ROUTE}/ort-wasm-simd-threaded.wasm`))
  assert.equal(wasm.status, 200)
  assert.equal(wasm.headers.get('content-type'), 'application/wasm', 'wasm is served with the type streaming compilation needs')
  assert.equal(reads.at(-1), '/pkgs/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')
  const worklet = await handle(new Request(`http://dsh${VOICE_ASSET_ROUTE}/vad.worklet.bundle.min.js`))
  assert.match(worklet.headers.get('content-type'), /^text\/javascript/)
  assert.equal(reads.at(-1), '/pkgs/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js')

  // Only the named files: no path reaches the disk.
  const before = reads.length
  assert.equal((await handle(new Request(`http://dsh${VOICE_ASSET_ROUTE}/..%2F..%2Fetc%2Fpasswd`))).status, 404)
  assert.equal((await handle(new Request(`http://dsh${VOICE_ASSET_ROUTE}/constructor`))).status, 404)
  assert.equal(reads.length, before, 'an unknown name never reads a file')
  assert.equal((await handle(new Request(`http://dsh${VOICE_ASSET_ROUTE}/bundle.min.js`, { method: 'POST' }))).status, 405)

  // A missing package is reported, not thrown into the Host.
  const missing = voiceAssetHandler({ distDirOf: () => '/nowhere', readFile: async () => { throw new Error('ENOENT') } })
  const answer = await missing(new Request(`http://dsh${VOICE_ASSET_ROUTE}/bundle.min.js`))
  assert.equal(answer.status, 503)
  assert.equal((await answer.json()).error.code, 'voice/vad-asset-missing')
  console.log('ok 12 — the detector files are served from the installed packages, by name only, with their types')
}

console.log('\nAll discipline-whale voice checks passed.')
