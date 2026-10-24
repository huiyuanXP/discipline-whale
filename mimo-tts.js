/**
 * discipline-whale — text to speech, one provider.
 *
 * ## Why this is not `/v1/audio/speech`
 *
 * The MiMo speech endpoint reuses the chat-completions shape: the text to speak
 * goes in as an `assistant` message, the audio parameters sit in a top-level
 * `audio` object, and the audio comes back base64-encoded inside the JSON
 * answer at `choices[0].message.audio.data`. There is no `audio/speech` path.
 *
 *     POST {baseUrl}/chat/completions
 *     {
 *       "model": "mimo-v2.5-tts",
 *       "messages": [{ "role": "assistant", "content": "要朗读的文本" }],
 *       "audio": { "format": "wav", "voice": "..." }
 *     }
 *     → { "choices": [{ "message": { "audio": { "data": "<base64>" } } }] }
 *
 * `synthesize()` hides that shape behind one call that answers bytes, a mime
 * type and a file extension — the same answer any other speech backend would
 * give, so the caller never branches on the provider.
 *
 * ## What never leaves this module
 *
 * The key. It is read once per request, used as a bearer token, and dropped.
 * It is never logged, never returned, and never put into an error message; the
 * refusals below name the environment variable to set instead.
 *
 * ## Configuration
 *
 * `apiKey` + `baseUrl`, with `voice` / `format` / `model` optional. Every value
 * has a working default except the key, which has none: an unconfigured plugin
 * says "not configured" rather than guessing a credential. The defaults are
 * the provider's public endpoints, so nothing here is specific to one machine.
 *
 * @module discipline-whale/mimo-tts
 */

/** Environment variable holding the speech key. Never echoed. */
export const TTS_API_KEY_ENV = 'MIMO_TOKEN_PLAN_KEY'

/** Environment variable overriding the speech base URL. */
export const TTS_BASE_URL_ENV = 'MIMO_TTS_BASE_URL'

/** Public default endpoint root (the provider's documented API host). */
export const DEFAULT_TTS_BASE_URL = 'https://api.xiaomimimo.com/v1'

/** Default speech model id. */
export const DEFAULT_TTS_MODEL = 'mimo-v2.5-tts'

/** Default audio container. WAV is the one every player opens without a codec. */
export const DEFAULT_TTS_FORMAT = 'wav'

/**
 * The default voice id: none.
 *
 * Deliberately empty. The backend rejects an unrecognised voice with a 400
 * naming the parameter, and its own voice ids are its own business (some are
 * Chinese words, some are names). Inventing a default here would break every
 * install that never chose a voice, so an unset voice is simply omitted and the
 * provider applies its default.
 */
export const DEFAULT_TTS_VOICE = ''

/** Containers the backend serves, keyed to the extension a file gets. */
export const TTS_FORMATS = new Map([
  ['wav', 'wav'],
  ['mp3', 'mp3'],
  ['pcm', 'pcm'],
])

/** Mime type per container. */
export const TTS_MIME = new Map([
  ['wav', 'audio/wav'],
  ['mp3', 'audio/mpeg'],
  ['pcm', 'audio/L16'],
])

/** Sample rate and channel count the backend produces, for the WAV header check. */
export const TTS_SAMPLE_RATE = 24000

/** Hard cap on one request's text, so a paste cannot become a runaway bill. */
export const MAX_TTS_CHARS = 4000

/** How long one synthesis may take before the route gives up. */
export const TTS_TIMEOUT_MS = 60_000

/**
 * The base64 alphabet, with optional padding.
 *
 * Used to validate the audio field before decoding: the platform decoder is
 * lenient and would turn a non-base64 body into plausible garbage, so both the
 * alphabet and the 4-character grouping are checked here.
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** Structured failure codes; the browser maps each one to its own copy. */
export const TTS_ERRORS = Object.freeze({
  emptyText: 'tts/empty-text',
  tooLong: 'tts/text-too-long',
  missingKey: 'tts/missing-key',
  invalidKey: 'tts/invalid-key',
  unreachable: 'tts/backend-unreachable',
  timeout: 'tts/backend-timeout',
  upstream: 'tts/upstream-error',
  noAudio: 'tts/no-audio-in-answer',
  badAudio: 'tts/undecodable-audio',
  badFormat: 'tts/unsupported-format',
})

/**
 * One speech failure.
 *
 * A distinct class (not a bare Error) so the route can tell a refusal it should
 * render as a structured answer from an unexpected crash it should not.
 */
export class SpeechError extends Error {
  constructor(code, message, status = 502, details = {}) {
    super(message)
    this.name = 'SpeechError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** Normalize a base URL: trimmed, trailing slashes removed. */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

/** The effective base URL: the configured one, else the public default. */
export function resolveBaseUrl(configured, env = process.env) {
  const fromConfig = normalizeBaseUrl(configured)
  if (fromConfig !== '') return fromConfig
  const fromEnv = normalizeBaseUrl(env[TTS_BASE_URL_ENV])
  if (fromEnv !== '') return fromEnv
  return DEFAULT_TTS_BASE_URL
}

/** The key, from the given config or the environment. Empty means unconfigured. */
export function resolveApiKey(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = env[TTS_API_KEY_ENV]
  return typeof fromEnv === 'string' ? fromEnv.trim() : ''
}

/** A container name the backend accepts, or the default. */
export function resolveFormat(configured) {
  if (typeof configured !== 'string') return DEFAULT_TTS_FORMAT
  const lowered = configured.trim().toLowerCase()
  return TTS_FORMATS.has(lowered) ? lowered : DEFAULT_TTS_FORMAT
}

/** True when speech can work at all, without revealing why not. */
export function ttsConfigured({ apiKey, env = process.env } = {}) {
  return resolveApiKey(apiKey, env) !== ''
}

/**
 * The request body for one synthesis.
 *
 * Exported so a test can assert the shape without a network call: this is the
 * whole provider-specific surface of the module.
 */
export function speechRequestBody({ text, model, voice, format }) {
  return {
    model: typeof model === 'string' && model.trim() !== '' ? model.trim() : DEFAULT_TTS_MODEL,
    messages: [{ role: 'assistant', content: text }],
    audio: {
      format: resolveFormat(format),
      // Only a configured voice is sent; an empty one is omitted so the
      // provider's default applies. See DEFAULT_TTS_VOICE.
      ...(typeof voice === 'string' && voice.trim() !== '' ? { voice: voice.trim() } : {}),
    },
  }
}

/**
 * Decode the base64 audio out of one chat-completions answer.
 *
 * Three distinct refusals, because they mean different things to a user: the
 * answer carried no audio at all (wrong model, or a text-only reply), the audio
 * was not valid base64 (a truncated or re-encoded body), or it decoded to zero
 * bytes.
 *
 * The alphabet is validated explicitly rather than left to the decoder: Node's
 * `Buffer.from(value, 'base64')` never throws — it silently drops characters it
 * does not recognise — so a body that is not base64 at all would otherwise
 * "decode" into plausible garbage and reach the player as a corrupt file.
 * @returns the audio bytes.
 */
export function audioFromAnswer(payload) {
  const raw = payload?.choices?.[0]?.message?.audio?.data
  if (typeof raw !== 'string') {
    throw new SpeechError(TTS_ERRORS.noAudio, 'the speech backend answered without audio data', 502)
  }
  const data = raw.trim()
  if (data === '') {
    throw new SpeechError(TTS_ERRORS.noAudio, 'the speech backend answered with empty audio data', 502)
  }
  if (!BASE64.test(data)) {
    throw new SpeechError(TTS_ERRORS.badAudio, 'the speech backend answered with audio that is not base64', 502)
  }
  const bytes = new Uint8Array(Buffer.from(data, 'base64'))
  if (bytes.byteLength === 0) {
    throw new SpeechError(TTS_ERRORS.badAudio, 'the speech backend answered with audio that decoded to nothing', 502)
  }
  return bytes
}

/** The format named by the answer, falling back to the one requested. */
export function formatFromAnswer(payload, requested) {
  const named = payload?.choices?.[0]?.message?.audio?.format
  if (typeof named === 'string' && TTS_FORMATS.has(named.trim().toLowerCase())) {
    return named.trim().toLowerCase()
  }
  return resolveFormat(requested)
}

/**
 * Duration of a 16-bit PCM WAV buffer, in seconds.
 *
 * The backend produces 24 kHz mono 16-bit, but the header is read rather than
 * assumed: the byte rate comes from the file. A buffer that is not a canonical
 * PCM WAV answers undefined instead of a guess.
 */
export function wavSecondsOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at, length) => String.fromCharCode(...bytes.subarray(at, at + length))
  if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE') return undefined
  const byteRate = view.getUint32(28, true)
  if (!Number.isFinite(byteRate) || byteRate <= 0) return undefined
  const seconds = (bytes.byteLength - 44) / byteRate
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : undefined
}

/**
 * One upstream failure, mapped to a code the UI can explain.
 *
 * Auth first (a rejected key is the common case and the most actionable), then
 * the deadline, then everything else.
 */
export function classifyFailure(status, body) {
  const lowered = typeof body === 'string' ? body.toLowerCase() : ''
  if (status === 401 || status === 403 || lowered.includes('invalid api key') || lowered.includes('unauthorized')) {
    return TTS_ERRORS.invalidKey
  }
  if (status === 408 || status === 504) return TTS_ERRORS.timeout
  return TTS_ERRORS.upstream
}

/** The short diagnostic from an upstream body — never the whole answer, never the key. */
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
 * Synthesize one piece of text.
 *
 * @param text what to speak.
 * @param options apiKey, baseUrl, model, voice, format, env, fetch, timeoutMs.
 * @returns `{ bytes, mime, extension, format, model, voice, seconds }`.
 * @throws SpeechError with a {@link TTS_ERRORS} code; never a bare network error.
 */
export async function synthesize(text, options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetch ?? globalThis.fetch
  const spoken = typeof text === 'string' ? text.trim() : ''
  if (spoken === '') throw new SpeechError(TTS_ERRORS.emptyText, 'there is no text to speak', 400)
  if (spoken.length > MAX_TTS_CHARS) {
    throw new SpeechError(TTS_ERRORS.tooLong, `one request may not exceed ${MAX_TTS_CHARS} characters`, 413, { maxChars: MAX_TTS_CHARS })
  }
  const key = resolveApiKey(options.apiKey, env)
  if (key === '') {
    throw new SpeechError(
      TTS_ERRORS.missingKey,
      `text to speech is not configured: save a key in the speech settings or set ${TTS_API_KEY_ENV}`,
      503,
    )
  }
  const baseUrl = resolveBaseUrl(options.baseUrl, env)
  const format = resolveFormat(options.format)
  const body = speechRequestBody({
    text: spoken,
    model: options.model,
    voice: options.voice,
    format,
  })

  // A real timer, cleared in `finally`: one request can never hold the route
  // open past the deadline.
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error('speech deadline')) }, options.timeoutMs ?? TTS_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    })
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new SpeechError(TTS_ERRORS.timeout, 'the speech backend did not answer in time', 504)
    }
    // A transport failure names the host, never the key and never the text.
    throw new SpeechError(TTS_ERRORS.unreachable, `could not reach the speech backend: ${error?.message ?? error}`, 502)
  } finally {
    clearTimeout(timer)
  }

  const answer = await response.text().catch(() => '')
  if (!response.ok) {
    const code = classifyFailure(response.status, answer)
    throw new SpeechError(code, `speech backend answered HTTP ${response.status}`, code === TTS_ERRORS.timeout ? 504 : 502, {
      upstreamStatus: response.status,
      upstreamDetail: upstreamDetail(answer),
    })
  }

  let payload
  try {
    payload = JSON.parse(answer)
  } catch {
    throw new SpeechError(TTS_ERRORS.upstream, 'the speech backend answered with a non-JSON body', 502, {
      upstreamStatus: response.status,
    })
  }
  const bytes = audioFromAnswer(payload)
  const actualFormat = formatFromAnswer(payload, format)
  return {
    bytes,
    mime: TTS_MIME.get(actualFormat) ?? 'application/octet-stream',
    extension: TTS_FORMATS.get(actualFormat) ?? 'bin',
    format: actualFormat,
    model: body.model,
    voice: body.audio.voice ?? '',
    seconds: wavSecondsOf(bytes),
  }
}

/**
 * The speech route: POST text, receive audio.
 *
 *   POST /api/discipline-whale/voice/speak   { text, voice?, format? }
 *   → 200 audio bytes (content-type from the provider, x-dw-tts-* headers)
 *   → 4xx/5xx { error: { code, message } }
 *
 * Audio is returned as binary, not base64 in JSON: the browser turns a Blob
 * into an object URL, which is both cheaper and the only shape `<audio>` and
 * `new Audio()` accept without a decode step in script.
 *
 * `describe` supplies the effective configuration (settings merged over the
 * environment) and must never return the key to the browser; it is used here
 * for the key only.
 */
export function speakHandler(options = {}) {
  const env = options.env ?? process.env
  const describe = typeof options.describe === 'function'
    ? options.describe
    : async () => ({ apiKey: '', baseUrl: '', voice: '', format: '' })
  return async function handleSpeakRequest(request) {
    if (request.method !== 'POST') {
      return Response.json(
        { error: { code: 'tts/method-not-allowed', message: 'the speech route accepts POST' } },
        { status: 405, headers: { 'cache-control': 'no-store', allow: 'POST' } },
      )
    }
    let body
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { error: { code: TTS_ERRORS.emptyText, message: 'the request body must be JSON' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    let config
    try {
      config = await describe()
    } catch {
      config = { apiKey: '', baseUrl: '', voice: '', format: '' }
    }
    try {
      const speech = await synthesize(body?.text, {
        apiKey: config?.apiKey,
        baseUrl: config?.baseUrl,
        model: config?.model,
        voice: typeof body?.voice === 'string' && body.voice !== '' ? body.voice : config?.voice,
        format: typeof body?.format === 'string' && body.format !== '' ? body.format : config?.format,
        env,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      })
      return new Response(speech.bytes, {
        status: 200,
        headers: {
          'content-type': speech.mime,
          'content-length': String(speech.bytes.byteLength),
          'cache-control': 'no-store',
          // The browser reads these to name the file and to report the length;
          // the defaults are enough when a proxy strips them.
          'x-dw-tts-format': speech.format,
          'x-dw-tts-extension': speech.extension,
          'x-dw-tts-model': speech.model,
          'x-dw-tts-voice': speech.voice,
          ...(speech.seconds === undefined ? {} : { 'x-dw-tts-seconds': String(speech.seconds) }),
        },
      })
    } catch (error) {
      if (error instanceof SpeechError) {
        return Response.json(
          { error: { code: error.code, message: error.message, ...error.details } },
          { status: error.status, headers: { 'cache-control': 'no-store' } },
        )
      }
      options.logger?.warn?.(`discipline-whale speech: ${error?.message ?? error}`)
      return Response.json(
        { error: { code: TTS_ERRORS.upstream, message: 'text to speech failed' } },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      )
    }
  }
}
