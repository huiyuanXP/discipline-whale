/**
 * discipline-whale — the whale's voice: one HTTP route that turns a recording
 * into text, and the prompt call that hands that text to the main session.
 *
 * The browser records one utterance (its own silence detector ends it), uploads
 * the bytes here, and this module forwards them to the configured
 * OpenAI-compatible transcription backend the operator configures. The
 * transcript is what the caller then sends into the main session — with the
 * same `sessionController.prompt` call the dispatch path already uses, so voice
 * is an input method, not a second message channel.
 *
 *   GET  /api/discipline-whale/voice/status      → whether a key is configured
 *   POST /api/discipline-whale/voice/transcribe  → { text, model, audioSeconds? }
 *   POST /api/discipline-whale/voice/say         → hands one transcript to the
 *                                                  recorded main session
 *
 * Privacy: the audio leaves this machine. The backend is a cloud service, the
 * key is read from the process environment at request time (never from a file
 * this plugin writes, never logged), and the bytes are forwarded once and then
 * dropped — nothing is written to disk.
 *
 * @module discipline-whale/voice
 */

import { randomUUID } from 'node:crypto'

import { describeVoice, resolveKey, resolveTtsKey } from './voice-settings.js'
import { speakHandler } from './mimo-tts.js'

/** Route the browser half uploads one recording to. */
export const VOICE_ROUTE = '/api/discipline-whale/voice/transcribe'

/** Route the browser half asks whether voice input can work at all. */
export const VOICE_STATUS_ROUTE = '/api/discipline-whale/voice/status'

/**
 * Route that speaks one piece of text.
 *
 * Speech OUT is independent of speech IN: it has its own key, its own endpoint
 * and its own failure codes, so a broken transcription backend never silences
 * the whale and a broken speech backend never blocks a recording.
 */
export const VOICE_SPEAK_ROUTE = '/api/discipline-whale/voice/speak'

/**
 * Route that sends one transcript into the main session.
 *
 * The browser could call `sessionController.prompt` directly, but then any page
 * script could address any session. This route is narrower by construction: it
 * reads the session id from the plugin state, so the only session it can ever
 * reach is the whale's main session.
 */
export const VOICE_SAY_ROUTE = '/api/discipline-whale/voice/say'

/** Environment variable holding the transcription key. Never echoed anywhere. */
export const API_KEY_ENV = 'DW_STT_API_KEY'

/** Environment variable holding the transcription base URL (must end in `/v1`). */
export const BASE_URL_ENV = 'DW_STT_BASE_URL'

/**
 * The transcription base URL when nothing is configured.
 *
 * Empty on purpose. A published plugin does not name a default transcription
 * host: a deployment choice is the operator's, so an unset endpoint is reported
 * as unset and the route refuses with "not configured" instead of reaching for
 * a host nobody named.
 */
export const DEFAULT_BASE_URL = ''

/** Transcription model id. */
export const MODEL = 'whisper-large-v3'

/** Hard cap on one uploaded recording; larger uploads are refused before forwarding. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Hard cap on one recording's duration; the browser stops at 60s, this is the server's backstop. */
export const MAX_AUDIO_SECONDS = 120

/** How long the upstream transcription may take before the route answers 504. */
export const UPSTREAM_TIMEOUT_MS = 90_000

/** Audio container types the route accepts, keyed by the uploaded content type. */
export const ACCEPTED_AUDIO_TYPES = new Map([
  ['audio/wav', 'recording.wav'],
  ['audio/x-wav', 'recording.wav'],
  ['audio/wave', 'recording.wav'],
  ['audio/webm', 'recording.webm'],
  ['audio/ogg', 'recording.ogg'],
  ['audio/mp4', 'recording.m4a'],
  ['audio/m4a', 'recording.m4a'],
  ['audio/mpeg', 'recording.mp3'],
])

/**
 * Structured failure codes the browser maps to localized copy. Every one of
 * them reaches the browser as an answer — the route never hangs.
 */
export const VOICE_ERRORS = {
  method: 'voice/method-not-allowed',
  contentType: 'voice/unsupported-audio-type',
  empty: 'voice/empty-audio',
  tooLarge: 'voice/audio-too-large',
  missingKey: 'voice/missing-key',
  missingEndpoint: 'voice/missing-endpoint',
  invalidKey: 'voice/invalid-key',
  noModel: 'voice/model-unavailable',
  unreachable: 'voice/backend-unreachable',
  timeout: 'voice/backend-timeout',
  upstream: 'voice/upstream-error',
  emptyTranscript: 'voice/empty-transcript',
  rejectedTranscript: 'voice/rejected-transcript',
  emptyText: 'voice/empty-text',
  noMainSession: 'voice/no-main-session',
}

/**
 * Read the API key from the process environment; empty means "not configured".
 *
 * This is the environment-only reader. The effective key — settings first,
 * then this environment — comes from `resolveKey` in `voice-settings.js`, and
 * only that seam is allowed to see the value.
 */
export function apiKey(env = process.env) {
  const value = env[API_KEY_ENV]
  return typeof value === 'string' ? value.trim() : ''
}

/** Read the backend root from the environment, trailing slashes removed. */
export function baseUrl(env = process.env) {
  const value = env[BASE_URL_ENV]
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return (trimmed === '' ? DEFAULT_BASE_URL : trimmed).replace(/\/+$/, '')
}

/** True when the environment alone carries a key, without revealing it. */
export function voiceConfigured(env = process.env) {
  return apiKey(env) !== ''
}

/** One structured refusal, in the shape the browser half reads. */
function failure(code, message, status, details = {}) {
  return Response.json(
    { error: { code, message, ...details } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

/** Normalize a content type: lowercase, parameters dropped. */
function mediaTypeOf(value) {
  return typeof value === 'string' ? (value.split(';', 1)[0] ?? '').trim().toLowerCase() : ''
}

/**
 * Map one upstream failure onto a code the UI can explain: an invalid key, a
 * model that is not served, an unreachable network, and everything else.
 */
export function classifyUpstream(status, body) {
  const text = typeof body === 'string' ? body : ''
  const lowered = text.toLowerCase()
  if (status === 401 || status === 403 || lowered.includes('invalid api key') || lowered.includes('unauthorized')) {
    return VOICE_ERRORS.invalidKey
  }
  if (lowered.includes('not configured') || lowered.includes('model_not_found')
    || lowered.includes('does not exist') || lowered.includes('no such model')) {
    return VOICE_ERRORS.noModel
  }
  if (status === 408 || status === 504) return VOICE_ERRORS.timeout
  return VOICE_ERRORS.upstream
}

/**
 * Read a JSON body without letting a malformed one throw, and keep only the
 * short diagnostic — never the whole upstream response, never the prompt.
 */
export function upstreamDetail(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (text === '') return ''
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof message === 'string') return message.slice(0, 300)
  } catch {
    // A non-JSON body (an HTML error page) is truncated below.
  }
  return text.slice(0, 300)
}

/**
 * Extract the transcript from a JSON upstream answer. Accepts the OpenAI
 * `{ text }` shape; anything else is an empty transcript, which the route
 * reports instead of forwarding an empty prompt.
 */
export function transcriptOf(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  const text = payload.text
  return typeof text === 'string' ? text.trim() : ''
}

/**
 * Whisper's per-segment confidence limits.
 *
 * `no_speech_prob` is checked on its own. Whisper's built-in skip rule needs
 * `no_speech_prob > 0.6` AND `avg_logprob < -1.0`, and that combination lets
 * the classic room-tone hallucinations through: measured on whisper-large-v3,
 * four seconds of room tone came back as 「由 Amara.org 社群提
 * 供的字幕」 with no_speech_prob 0.83 and avg_logprob -0.27, while clear near
 * speech scored no_speech_prob 0.02.
 */
export const SEGMENT_LIMITS = Object.freeze({
  noSpeechProbMax: 0.6,
  avgLogprobMin: -1.0,
  compressionRatioMax: 2.4,
})

/**
 * Text Whisper is known to produce from silence or noise (subtitle credits
 * from its training data).
 *
 * `markers` are strings that only ever come from those credits (a channel
 * name, a credits site), so an utterance containing one is dropped whole.
 * `whole` and `credits` describe lines a person could also say inside a real
 * request ("有没有中文字幕", "字幕组那个任务"), so they drop an utterance only
 * when it is nothing but that line: `whole` by exact match, `credits` by
 * pattern. Everything is compared after `normalizeForMatch`. Sources: the "Bag
 * of Hallucinations" list (arXiv:2501.11378), WhisprRT `app/config.py`,
 * TypeLate `hallucinationDetector.ts`, and the outputs measured above.
 */
export const HALLUCINATIONS = Object.freeze({
  markers: Object.freeze(['amara.org', '明镜与点点', '请不吝点赞', '优优独播剧场', 'yoyotelevision']),
  whole: Object.freeze([
    '谢谢观看', '感谢观看', '谢谢收看', '感谢收看', '谢谢大家观看', '谢谢大家', '谢谢观赏', '请订阅',
    '下期再见', '我们下期再见', '本期视频就到这里', '中文字幕', '字幕', '字幕组', '字幕提供',
    'thankyouforwatching', 'thanksforwatching', 'pleasesubscribe', 'likeandsubscribe', 'seeyounexttime',
  ]),
  credits: Object.freeze([/^字幕由.{0,20}提供$/u, /^由.{0,20}提供的字幕$/u, /^字幕志愿者.{0,8}$/u]),
})

/** Lower-case and strip whitespace and punctuation, so 「谢谢观看！」 and 「谢谢 观看」 match. */
export function normalizeForMatch(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * The transcript worth sending, or the reasons nothing is.
 *
 * With a `verbose_json` answer, segments over the confidence limits are
 * dropped first; an answer without segments is judged on its text alone.
 * What remains is then checked against the hallucination lists.
 * @param payload the parsed upstream answer.
 * @returns `{ text, reasons }`: `text` is '' when nothing should be sent, and
 *   `reasons` names every rule that dropped something.
 */
export function acceptedTranscript(payload) {
  const reasons = []
  let text = transcriptOf(payload)
  const segments = Array.isArray(payload?.segments) ? payload.segments : null
  if (segments !== null && segments.length > 0) {
    const kept = []
    for (const segment of segments) {
      const nsp = Number(segment?.no_speech_prob)
      const logprob = Number(segment?.avg_logprob)
      const ratio = Number(segment?.compression_ratio)
      if (Number.isFinite(nsp) && nsp >= SEGMENT_LIMITS.noSpeechProbMax) { reasons.push('no-speech-prob'); continue }
      if (Number.isFinite(logprob) && logprob < SEGMENT_LIMITS.avgLogprobMin) { reasons.push('low-logprob'); continue }
      if (Number.isFinite(ratio) && ratio > SEGMENT_LIMITS.compressionRatioMax) { reasons.push('repetitive'); continue }
      if (typeof segment?.text === 'string') kept.push(segment.text.trim())
    }
    text = kept.filter((part) => part !== '').join(' ').trim()
  }
  const normalized = normalizeForMatch(text)
  if (normalized !== '') {
    if (HALLUCINATIONS.markers.some((marker) => normalized.includes(normalizeForMatch(marker)))) {
      reasons.push('known-hallucination')
      text = ''
    } else if (HALLUCINATIONS.whole.some((phrase) => normalized === normalizeForMatch(phrase))
      || HALLUCINATIONS.credits.some((pattern) => pattern.test(normalized))) {
      reasons.push('known-hallucination')
      text = ''
    }
  }
  return { text: normalizeForMatch(text) === '' ? '' : text, reasons: [...new Set(reasons)] }
}

/**
 * Forward one recording upstream.
 * @param input audio bytes, filename, content type and language hint.
 * @param deps environment, fetch and the effective voice config, injected so
 *   tests can drive it. `config` is what `describeVoice()` returned: the
 *   settings-first, environment-second resolution. Without it the environment
 *   alone is read, which keeps the call sites that predate the settings form
 *   working unchanged.
 * @returns the transcript or a structured failure Response.
 */
export async function transcribeAudio(input, deps = {}) {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const config = deps.config ?? {
    hasApiKey: voiceConfigured(env),
    baseUrl: baseUrl(env),
    model: MODEL,
    language: '',
  }
  // The key itself is resolved here and dropped at the end of the request.
  // `deps.apiKey` exists for tests; production callers pass `deps.keyResolver`.
  const key = typeof deps.apiKey === 'string'
    ? deps.apiKey
    : deps.keyResolver !== undefined
      ? (await deps.keyResolver()).value
      : apiKey(env)
  const endpoint = typeof config.baseUrl === 'string' && config.baseUrl !== ''
    ? config.baseUrl
    : baseUrl(env)
  if (endpoint === '') {
    // No transcription backend is configured. This is a configuration gap, not
    // a network failure: naming the variable to set is the whole answer, and
    // no request is attempted against a host nobody named.
    return failure(
      VOICE_ERRORS.missingEndpoint,
      `voice input is not configured: set the transcription endpoint in the voice settings or ${BASE_URL_ENV} in the environment`,
      503,
      { baseUrlEnv: BASE_URL_ENV },
    )
  }
  if (key === '') {
    return failure(VOICE_ERRORS.missingKey, `voice input needs a key in the voice settings or ${API_KEY_ENV} in the environment`, 503)
  }
  const model = typeof config.model === 'string' && config.model !== '' ? config.model : MODEL
  const form = new FormData()
  form.append('file', new Blob([input.bytes], { type: input.contentType }), input.filename)
  form.append('model', model)
  const language = typeof input.language === 'string' && input.language !== '' ? input.language : config.language
  if (typeof language === 'string' && language !== '') form.append('language', language)
  // verbose_json carries per-segment confidence, which is what lets the
  // route drop what Whisper invented from room tone (see `acceptedTranscript`).
  form.append('response_format', 'verbose_json')

  // A real timer, cleared in `finally`: one recording can never hold the
  // request open past the deadline.
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error('voice deadline')) }, deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS)
  const signal = input.signal === undefined
    ? deadline.signal
    : AbortSignal.any([input.signal, deadline.signal])
  let response
  try {
    response = await fetchImpl(`${endpoint}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal,
    })
  } catch (error) {
    // Distinguish "our deadline expired" from "the browser hung up": only the
    // former is a timeout, the latter is reported as unreachable.
    if (deadline.signal.aborted) return failure(VOICE_ERRORS.timeout, 'the transcription backend did not answer in time', 504)
    // A transport failure names the host, never the key or the audio.
    return failure(VOICE_ERRORS.unreachable, `could not reach the transcription backend: ${error?.message ?? error}`, 502)
  } finally {
    clearTimeout(timer)
  }

  const body = await response.text().catch(() => '')
  if (!response.ok) {
    const code = classifyUpstream(response.status, body)
    const status = code === VOICE_ERRORS.invalidKey ? 502
      : code === VOICE_ERRORS.timeout ? 504
        : code === VOICE_ERRORS.noModel ? 503
          : 502
    return failure(code, `transcription backend answered HTTP ${response.status}`, status, {
      upstreamStatus: response.status,
      upstreamDetail: upstreamDetail(body),
    })
  }

  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    return failure(VOICE_ERRORS.upstream, 'the transcription backend answered with a non-JSON body', 502, {
      upstreamStatus: response.status,
    })
  }
  if (transcriptOf(payload) === '' && !Array.isArray(payload?.segments)) {
    return failure(VOICE_ERRORS.emptyTranscript, 'the recording held no recognizable speech', 422)
  }
  const accepted = acceptedTranscript(payload)
  if (accepted.text === '') {
    // Nothing the person said to the whale: room tone, background talk the
    // model was unsure of, or a known hallucination. Refused, never sent.
    return failure(VOICE_ERRORS.rejectedTranscript, 'the recording looked like background sound, not speech to the whale', 422, {
      reasons: accepted.reasons,
    })
  }
  const text = accepted.text
  return Response.json(
    { text, model, audioSeconds: audioSecondsOf(input.bytes) },
    { headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * Best-effort duration of a WAV/WebM recording, for the chat log and tests.
 * Only the canonical 44-byte PCM WAV header is measured; other containers
 * answer undefined rather than a guess.
 */
export function audioSecondsOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
  if (riff !== 'RIFF' || wave !== 'WAVE') return undefined
  const byteRate = view.getUint32(28, true)
  if (byteRate <= 0) return undefined
  const seconds = (bytes.byteLength - 44) / byteRate
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : undefined
}

/**
 * The voice route handler.
 *
 * @param options environment/fetch overrides (tests), an optional logger, and
 *   the effective-config reader. `describe` defaults to the settings-first
 *   resolution from `voice-settings.js`; the tests inject a bare one.
 * @returns a Fetch handler bound to this Host composition.
 */
export function voiceHandler(options = {}) {
  const env = options.env ?? process.env
  const homeDir = options.homeDir
  const describe = typeof options.describe === 'function'
    ? options.describe
    : async () => describeVoice({ env, credentials: options.credentials, homeDir })
  return async function handleVoiceRequest(request) {
    if (request.method === 'GET') {
      // Status is deliberately key-free: the browser learns whether voice can
      // work, WHERE the key came from, and which env var to set when it cannot.
      // `keySource` is one of env / settings / none — never the key.
      let config
      try {
        config = await describe()
      } catch {
        config = { hasApiKey: false, keySource: 'none', baseUrl: baseUrl(env), model: MODEL, language: '', apiKeyEnv: API_KEY_ENV }
      }
      return Response.json(
        {
          configured: config.hasApiKey === true,
          keySource: config.keySource ?? (config.hasApiKey === true ? 'env' : 'none'),
          apiKeyEnv: config.apiKeyEnv ?? API_KEY_ENV,
          baseUrl: config.baseUrl,
          model: config.model ?? MODEL,
          language: config.language ?? '',
          maxBytes: MAX_AUDIO_BYTES,
          maxSeconds: MAX_AUDIO_SECONDS,
          // Inside this route "configured" means transcription can work: a key
          // AND an endpoint. An unset endpoint is reported separately so the UI
          // can say which of the two is missing.
          endpointConfigured: (config.baseUrl ?? baseUrl(env)) !== '',
          source: 'configured transcription endpoint',
        },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    if (request.method !== 'POST') {
      return failure(VOICE_ERRORS.method, 'voice transcription accepts POST', 405, { allow: 'GET, POST' })
    }
    const contentType = mediaTypeOf(request.headers.get('content-type'))
    const filename = ACCEPTED_AUDIO_TYPES.get(contentType)
    if (filename === undefined) {
      return failure(
        VOICE_ERRORS.contentType,
        `unsupported audio type ${contentType === '' ? '(none)' : contentType}`,
        415,
        { accepted: [...ACCEPTED_AUDIO_TYPES.keys()] },
      )
    }
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      return failure(VOICE_ERRORS.tooLarge, `one recording may not exceed ${MAX_AUDIO_BYTES} bytes`, 413, {
        maxBytes: MAX_AUDIO_BYTES,
      })
    }
    let bytes
    try {
      bytes = new Uint8Array(await request.arrayBuffer())
    } catch (error) {
      return failure(VOICE_ERRORS.upstream, `could not read the upload: ${error?.message ?? error}`, 400)
    }
    if (bytes.byteLength === 0) return failure(VOICE_ERRORS.empty, 'the upload carried no audio', 400)
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      return failure(VOICE_ERRORS.tooLarge, `one recording may not exceed ${MAX_AUDIO_BYTES} bytes`, 413, {
        maxBytes: MAX_AUDIO_BYTES,
      })
    }
    const seconds = audioSecondsOf(bytes)
    if (seconds !== undefined && seconds > MAX_AUDIO_SECONDS) {
      return failure(VOICE_ERRORS.tooLarge, `one recording may not exceed ${MAX_AUDIO_SECONDS} seconds`, 413, {
        maxSeconds: MAX_AUDIO_SECONDS,
      })
    }
    const language = new URL(request.url).searchParams.get('language') ?? undefined
    try {
      // One resolution per request: a key saved through the settings form
      // reaches the very next recording, and the key is not held anywhere.
      const config = await describe()
      const resolveEffectiveKey = typeof options.keyResolver === 'function'
        ? options.keyResolver
        : async () => resolveKey({ env, credentials: options.credentials, homeDir })
      return await transcribeAudio(
        { bytes, filename, contentType, language, signal: request.signal },
        { ...options, env, config, keyResolver: resolveEffectiveKey },
      )
    } catch (error) {
      options.logger?.warn?.(`discipline-whale voice: ${error?.message ?? error}`)
      return failure(VOICE_ERRORS.upstream, 'voice transcription failed', 500)
    }
  }
}

/**
 * Send one transcript into the main session.
 *
 * This is the SAME call `send_to_session` makes at its default step-boundary
 * timing (`sessionController.prompt`, `steer` mode); voice never introduces a
 * second message channel. While the whale is working, the sentence is an
 * interjection: the in-flight tool call finishes, then the whale re-plans
 * with it inside the same turn. While the whale is idle, it wakes a new turn.
 * Either way the person never waits for a reply before speaking again. The
 * caller supplies the session id it read from the plugin state, so a
 * transcript can only ever land in the main session.
 * @param sessionController host session controller.
 * @param sessionId the recorded main session.
 * @param text the recognized utterance.
 * @param requestId caller-supplied id for this prompt.
 * @returns the controller's acknowledgement.
 */
export function promptMainSession(sessionController, sessionId, text, requestId) {
  return sessionController.prompt(
    {
      requestId,
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text }],
    },
    new AbortController().signal,
  )
}

/**
 * The route that hands one transcript to the main session.
 *
 * It answers with the session id it delivered to, so the browser half can tell
 * "sent" from "not sent" without a second read. A client-supplied `sessionId`
 * is ignored on purpose: the recorded main session is the only destination.
 * @param options sessionController, a state reader, and an optional logger.
 * @returns a Fetch handler.
 */
export function sayHandler(options) {
  const readState = options.readState
  const logger = options.logger
  return async function handleSayRequest(request) {
    if (request.method !== 'POST') {
      return failure(VOICE_ERRORS.method, 'the say route accepts POST', 405, { allow: 'POST' })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return failure(VOICE_ERRORS.emptyText, 'the request body must be JSON', 400)
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') return failure(VOICE_ERRORS.emptyText, 'there is no transcript to send', 400)
    let state
    try {
      state = await readState()
    } catch (error) {
      logger?.warn?.(`discipline-whale voice: could not read plugin state: ${error?.message ?? error}`)
      return failure(VOICE_ERRORS.noMainSession, 'the plugin state is unreadable', 503)
    }
    const sessionId = typeof state?.mainSessionId === 'string' ? state.mainSessionId : ''
    if (sessionId === '') {
      return failure(VOICE_ERRORS.noMainSession, 'no main session is recorded yet; open the whale first', 409)
    }
    try {
      await promptMainSession(options.sessionController, sessionId, text, options.requestId?.() ?? randomUUID())
    } catch (error) {
      logger?.warn?.(`discipline-whale voice: prompt failed: ${error?.message ?? error}`)
      return failure(VOICE_ERRORS.upstream, `could not reach the main session: ${error?.message ?? error}`, 502)
    }
    return Response.json({ sessionId, chars: text.length }, { headers: { 'cache-control': 'no-store' } })
  }
}

/** Register the voice routes against the Host's connection fetch registry. */
export function registerVoiceRoutes(connection, options = {}) {
  const handler = voiceHandler(options)
  const routes = [
    { path: VOICE_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler },
    { path: VOICE_STATUS_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: handler },
  ]
  // Speech out: one POST of text, audio bytes back. The key is resolved per
  // request so a value saved in the form reaches the very next reply.
  routes.push({
    path: VOICE_SPEAK_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: speakHandler({
      env: options.env,
      logger: options.logger,
      fetch: options.fetch,
      timeoutMs: options.ttsTimeoutMs,
      describe: async () => {
        const env = options.env ?? process.env
        const config = await describeVoice({ env, credentials: options.credentials, homeDir: options.homeDir })
        const key = await resolveTtsKey({ env, credentials: options.credentials, homeDir: options.homeDir })
        return {
          apiKey: key.value,
          baseUrl: config.tts?.baseUrl ?? '',
          model: config.tts?.model ?? '',
          voice: config.tts?.voice ?? '',
          format: config.tts?.format ?? '',
        }
      },
    }),
  })
  if (options.say !== undefined) {
    routes.push({
      path: VOICE_SAY_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: sayHandler({ ...options.say, logger: options.logger }),
    })
  }
  return Promise.all(routes.map((route) => connection.fetch.register(route)))
}
