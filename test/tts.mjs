/**
 * Text-to-speech tests for discipline-whale.
 *
 * One provider, checked end to end without a network call:
 *
 *   1. the request shape — chat/completions with an `assistant` message and a
 *      top-level `audio` object, which is what the backend actually accepts
 *   2. base64 decoding out of `choices[0].message.audio.data`, with distinct
 *      refusals for no-audio / bad-base64 / empty bytes
 *   3. the HTTP route: binary audio out, structured refusals in, no key in any
 *      answer
 *   4. configuration: defaults, the environment override, and "not configured"
 *      as its own answer rather than a crash
 *   5. the public-code scan — no internal host, no internal key name, in source
 *      OR in tests
 *
 * Run: node test/tts.mjs
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_TTS_BASE_URL,
  DEFAULT_TTS_FORMAT,
  DEFAULT_TTS_MODEL,
  MAX_TTS_CHARS,
  SpeechError,
  TTS_API_KEY_ENV,
  TTS_ERRORS,
  TTS_BASE_URL_ENV,
  TTS_FORMATS,
  audioFromAnswer,
  formatFromAnswer,
  resolveBaseUrl,
  resolveApiKey,
  resolveFormat,
  speakHandler,
  speechRequestBody,
  synthesize,
  ttsConfigured,
  wavSecondsOf,
} from '../mimo-tts.js'

// --- fixtures -------------------------------------------------------------

/**
 * A 24 kHz mono 16-bit PCM WAV of `seconds` of silence, as bytes.
 *
 * Built here rather than captured from the backend so the test carries no
 * recorded payload: a real sample would be a fixture that goes stale the first
 * time the provider changes its encoder.
 */
function wavBytes(seconds, sampleRate = 24000) {
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

/** The chat-completions answer shape, wrapping one audio buffer as base64. */
function answerWithAudio(bytes, extra = {}) {
  return {
    choices: [{ message: { audio: { data: Buffer.from(bytes).toString('base64'), ...extra } } }],
  }
}

/** A JSON Response, the way the stub fetch answers. */
function jsonResponse(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const KEY = 'test-key-not-real-0123456789'
const post = (body) => new Request('http://dsh/api/discipline-whale/voice/speak', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// --- 1. the request shape -------------------------------------------------

{
  // The provider is chat/completions, not audio/speech: this is the whole
  // reason the module exists, so the shape is pinned exactly.
  const body = speechRequestBody({ text: '你好，自律鲸鱼。', model: DEFAULT_TTS_MODEL, voice: 'Mia', format: 'wav' })
  assert.deepEqual(body, {
    model: DEFAULT_TTS_MODEL,
    messages: [{ role: 'assistant', content: '你好，自律鲸鱼。' }],
    audio: { format: 'wav', voice: 'Mia' },
  })
  // The text MUST be an assistant message: the backend refuses anything else
  // for a TTS model with "messages must contain an assistant role for TTS
  // model", which this pins so the shape cannot drift back.
  assert.equal(speechRequestBody({ text: 'x' }).messages[0].role, 'assistant')
  assert.equal(body.messages.length, 1, 'the text is one assistant message, not a system prompt')
  assert.equal('input' in body, false, 'there is no OpenAI-style `input` field')

  // Defaults fill in for everything the caller left out.
  const bare = speechRequestBody({ text: 'hi' })
  assert.equal(bare.model, DEFAULT_TTS_MODEL)
  assert.equal(bare.audio.format, DEFAULT_TTS_FORMAT)
  // A voice is sent ONLY when one is configured. The backend rejects an unknown
  // voice with a 400 naming the parameter ("Unknown voice: <id>"), so inventing
  // a default here would break every unconfigured install. Omitting it lets the
  // provider apply its own default, which is what an empty setting means.
  assert.equal('voice' in bare.audio, false, 'no voice is invented when none is configured')

  // A configured voice is passed through verbatim, including a non-ASCII id:
  // the provider's own voice names are Chinese words.
  const named = speechRequestBody({ text: 'hi', voice: ' 冰糖 ' })
  assert.equal(named.audio.voice, '冰糖', 'a configured voice is trimmed and passed through')

  // An empty or whitespace-only voice means "the provider's default", not "".
  for (const empty of ['', '   ', undefined, null]) {
    assert.equal('voice' in speechRequestBody({ text: 'hi', voice: empty }).audio, false, `voice ${JSON.stringify(empty)} is omitted`)
  }

  // Only the three containers the backend serves are accepted; anything else
  // falls back to the default rather than being forwarded verbatim.
  assert.deepEqual([...TTS_FORMATS.keys()].sort(), ['mp3', 'pcm', 'wav'])
  assert.equal(resolveFormat('MP3'), 'mp3')
  assert.equal(resolveFormat('  wav '), 'wav')
  assert.equal(resolveFormat('flac'), DEFAULT_TTS_FORMAT, 'an unknown container falls back instead of failing the call')
  assert.equal(resolveFormat(undefined), DEFAULT_TTS_FORMAT)
  console.log('ok 1 — the speech request is chat/completions with an assistant message and top-level audio')
}

// --- 2. decoding the answer ----------------------------------------------

{
  const wav = wavBytes(1.5)
  const decoded = audioFromAnswer(answerWithAudio(wav))
  assert.equal(decoded.byteLength, wav.byteLength)
  assert.deepEqual([...decoded.subarray(0, 4)], [0x52, 0x49, 0x46, 0x46], 'the decoded bytes start with RIFF')

  // The three refusals are distinct: a caller can tell "wrong model" from
  // "truncated body" from "the answer had text but no audio".
  // "No audio" and "unusable audio" are deliberately separate: the first means
  // the model answered with nothing to play (a text-only reply, a wrong model
  // id), the second means bytes arrived that cannot be turned into a file.
  // Node's base64 decoder never throws — it silently drops invalid characters —
  // so the second case has to be detected by validating the alphabet, not by
  // catching an exception. These cases pin that.
  const refusals = [
    { body: { choices: [{ message: { content: 'hello' } }] }, code: TTS_ERRORS.noAudio },
    { body: { choices: [{ message: { audio: {} } }] }, code: TTS_ERRORS.noAudio },
    { body: { choices: [] }, code: TTS_ERRORS.noAudio },
    { body: null, code: TTS_ERRORS.noAudio },
    { body: { choices: [{ message: { audio: { data: '   ' } } }] }, code: TTS_ERRORS.noAudio },
    { body: { choices: [{ message: { audio: { data: '!!!not base64!!!' } } }] }, code: TTS_ERRORS.badAudio },
    { body: { choices: [{ message: { audio: { data: 'abcde' } } }] }, code: TTS_ERRORS.badAudio },
  ]
  for (const refusal of refusals) {
    assert.throws(() => audioFromAnswer(refusal.body), (error) => {
      assert.ok(error instanceof SpeechError, 'every refusal is a SpeechError, never a bare Error')
      assert.equal(error.code, refusal.code)
      return true
    }, `refusal ${refusal.code}`)
  }

  // A container named by the answer wins over the one requested; an unknown
  // or missing name falls back to the request.
  assert.equal(formatFromAnswer({ choices: [{ message: { audio: { format: 'mp3' } } }] }, 'wav'), 'mp3')
  assert.equal(formatFromAnswer({ choices: [{ message: { audio: {} } }] }, 'wav'), 'wav')
  assert.equal(formatFromAnswer({ choices: [{ message: { audio: { format: 'aiff' } } }] }, 'pcm'), 'pcm')

  // Duration comes from the header's byte rate, not from an assumption.
  assert.equal(wavSecondsOf(wav), 1.5)
  assert.equal(wavSecondsOf(wavBytes(2, 16000)), 2, 'a different sample rate is read from the file')
  assert.equal(wavSecondsOf(new Uint8Array([1, 2, 3])), undefined)
  assert.equal(wavSecondsOf(Buffer.from('not a wav at all, just text bytes here!')), undefined)
  console.log('ok 2 — base64 audio is decoded, and no-audio / bad-base64 / empty are distinct refusals')
}

// --- 3. the route ---------------------------------------------------------

{
  // Success: binary audio straight out, with the headers the browser needs to
  // name the file. A JSON-with-base64 answer would force the page to decode.
  const wav = wavBytes(2)
  const seen = []
  const handle = speakHandler({
    env: { [TTS_API_KEY_ENV]: KEY },
    describe: async () => ({ apiKey: '' }),
    fetch: async (url, init) => {
      seen.push({ url, init })
      return jsonResponse(200, answerWithAudio(wav, { format: 'wav' }))
    },
  })
  const response = await handle(post({ text: '朗读这句话' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/wav')
  assert.equal(response.headers.get('content-length'), String(wav.byteLength))
  assert.equal(response.headers.get('x-dw-tts-extension'), 'wav')
  assert.equal(response.headers.get('x-dw-tts-seconds'), '2')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const received = new Uint8Array(await response.arrayBuffer())
  assert.equal(received.byteLength, wav.byteLength, 'the body is the audio, byte for byte')

  // The upstream call: one POST to chat/completions, bearer auth, the shape
  // from section 1, and the key only ever in the header.
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${DEFAULT_TTS_BASE_URL}/chat/completions`)
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY}`)
  const sent = JSON.parse(seen[0].init.body)
  assert.equal(sent.messages[0].content, '朗读这句话')
  assert.equal(JSON.stringify(sent).includes(KEY), false, 'the key never rides in the body')

  // The configured voice and format override the defaults, per request.
  await handle(post({ text: 'x', voice: 'Mia', format: 'mp3' }))
  const again = JSON.parse(seen.at(-1).init.body)
  assert.equal(again.audio.voice, 'Mia')
  assert.equal(again.audio.format, 'mp3')
  console.log('ok 3 — the route answers binary audio from one chat/completions call')
}

{
  // Refusals: each one is a structured answer with its own code and a status the
  // browser can act on. The key never appears in any of them.
  const cases = [
    {
      name: 'no audio in the answer',
      fetch: async () => jsonResponse(200, { choices: [{ message: { content: 'no audio here' } }] }),
      body: { text: 'hello' },
      code: TTS_ERRORS.noAudio,
      status: 502,
    },
    {
      name: 'undecodable base64',
      fetch: async () => jsonResponse(200, { choices: [{ message: { audio: { data: '!!! not base64 !!!' } } }] }),
      body: { text: 'hello' },
      code: TTS_ERRORS.badAudio,
      status: 502,
    },
    {
      name: 'non-JSON answer',
      fetch: async () => new Response('<html>gateway</html>', { status: 200 }),
      body: { text: 'hello' },
      code: TTS_ERRORS.upstream,
      status: 502,
    },
    {
      name: 'rejected key',
      fetch: async () => jsonResponse(401, { error: { message: 'invalid API key' } }),
      body: { text: 'hello' },
      code: TTS_ERRORS.invalidKey,
      status: 502,
    },
    {
      name: 'upstream 500',
      fetch: async () => jsonResponse(500, 'boom'),
      body: { text: 'hello' },
      code: TTS_ERRORS.upstream,
      status: 502,
    },
    {
      name: 'empty text',
      fetch: async () => { throw new Error('must not be called') },
      body: { text: '   ' },
      code: TTS_ERRORS.emptyText,
      status: 400,
    },
    {
      name: 'text too long',
      fetch: async () => { throw new Error('must not be called') },
      body: { text: 'x'.repeat(MAX_TTS_CHARS + 1) },
      code: TTS_ERRORS.tooLong,
      status: 413,
    },
  ]
  for (const item of cases) {
    const handle = speakHandler({
      env: { [TTS_API_KEY_ENV]: KEY },
      describe: async () => ({ apiKey: '' }),
      fetch: item.fetch,
    })
    const response = await handle(post(item.body))
    const payload = await response.json()
    assert.equal(response.status, item.status, `${item.name}: status`)
    assert.equal(payload.error.code, item.code, `${item.name}: code`)
    assert.equal(JSON.stringify(payload).includes(KEY), false, `${item.name}: the key never reaches the answer`)
  }

  // A dead host is its own answer, and a hanging one becomes a timeout rather
  // than holding the route open.
  const unreachable = await speakHandler({
    env: { [TTS_API_KEY_ENV]: KEY },
    describe: async () => ({ apiKey: '' }),
    fetch: async () => { throw new Error('getaddrinfo ENOTFOUND example.invalid') },
  })(post({ text: 'hello' }))
  assert.equal(unreachable.status, 502)
  assert.equal((await unreachable.json()).error.code, TTS_ERRORS.unreachable)

  const hanging = speakHandler({
    env: { [TTS_API_KEY_ENV]: KEY },
    describe: async () => ({ apiKey: '' }),
    timeoutMs: 40,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  })
  const started = Date.now()
  const timedOut = await hanging(post({ text: 'hello' }))
  assert.equal(timedOut.status, 504)
  assert.equal((await timedOut.json()).error.code, TTS_ERRORS.timeout)
  assert.ok(Date.now() - started < 5_000, 'the deadline releases the route')

  // Method and body guards.
  const wrongMethod = await speakHandler({ env: {} })(new Request('http://dsh/api/discipline-whale/voice/speak'))
  assert.equal(wrongMethod.status, 405)
  const badJson = await speakHandler({ env: {} })(new Request('http://dsh/api/discipline-whale/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  }))
  assert.equal(badJson.status, 400)
  console.log('ok 4 — every speech failure is a structured answer, never a hang and never a leaked key')
}

// --- 4. configuration -----------------------------------------------------

{
  // Defaults are the provider's public endpoints, so an unconfigured install
  // describes itself correctly instead of pointing at anything private.
  assert.equal(DEFAULT_TTS_BASE_URL, 'https://api.xiaomimimo.com/v1')
  assert.equal(DEFAULT_TTS_MODEL, 'mimo-v2.5-tts')
  assert.equal(resolveBaseUrl('', {}), DEFAULT_TTS_BASE_URL)
  assert.equal(resolveBaseUrl('https://example.test/v1/', {}), 'https://example.test/v1', 'trailing slashes are trimmed')
  assert.equal(resolveBaseUrl('', { [TTS_BASE_URL_ENV]: 'https://env.test/v1' }), 'https://env.test/v1')
  assert.equal(resolveBaseUrl('https://cfg.test/v1', { [TTS_BASE_URL_ENV]: 'https://env.test/v1' }), 'https://cfg.test/v1',
    'a configured base URL wins over the environment')

  // A saved key wins over the environment; the environment fills in when
  // nothing is saved; nothing at all is a clean "not configured".
  assert.equal(resolveApiKey('sk-saved-0123456789', { [TTS_API_KEY_ENV]: 'sk-env-0123456789' }), 'sk-saved-0123456789')
  assert.equal(resolveApiKey('', { [TTS_API_KEY_ENV]: 'sk-env-0123456789' }), 'sk-env-0123456789')
  assert.equal(resolveApiKey('', {}), '')
  assert.equal(ttsConfigured({ apiKey: '', env: {} }), false)
  assert.equal(ttsConfigured({ apiKey: 'sk-0123456789' }), true)

  // Missing key is a refusal that names the variable to set — not a crash, and
  // not a request to a dead host.
  let called = 0
  await assert.rejects(
    () => synthesize('hello', { env: {}, fetch: async () => { called += 1; throw new Error('no') } }),
    (error) => {
      assert.ok(error instanceof SpeechError)
      assert.equal(error.code, TTS_ERRORS.missingKey)
      assert.equal(error.status, 503)
      assert.match(error.message, new RegExp(TTS_API_KEY_ENV))
      assert.equal(JSON.stringify(error.details).includes('sk-'), false)
      return true
    },
  )
  assert.equal(called, 0, 'an unconfigured plugin makes no network call at all')

  // `synthesize` returns one uniform shape whatever the backend did.
  const uniform = await synthesize('一句测试', {
    env: { [TTS_API_KEY_ENV]: KEY },
    fetch: async () => jsonResponse(200, answerWithAudio(wavBytes(1))),
  })
  assert.deepEqual(Object.keys(uniform).sort(), ['bytes', 'extension', 'format', 'mime', 'model', 'seconds', 'voice'])
  assert.equal(uniform.mime, 'audio/wav')
  assert.equal(uniform.extension, 'wav')
  assert.equal(uniform.seconds, 1)
  assert.ok(uniform.bytes instanceof Uint8Array)
  assert.equal(JSON.stringify(uniform, (_k, value) => (value instanceof Uint8Array ? '<bytes>' : value)).includes(KEY), false)
  console.log('ok 5 — defaults, environment override and an explicit not-configured answer')
}

// --- 5. the public-code scan ---------------------------------------------

{
  // The plugin is going public: no internal host, no internal key variable, no
  // internal venue name may survive in the shipped source OR the tests. This
  // is the assertion that keeps the cleanup from regressing, so it names the
  // exact patterns rather than a vague "no secrets" check.
  // The patterns are assembled from fragments so this scanner does not match
  // its own source: a literal here would be the one hit it always reports.
  const WORD = (...parts) => new RegExp(parts.join(''), 'i')
  const INTERNAL = [
    WORD('SOC', 'L', 'AAS'),
    WORD('SoC', 'L', 'aaS'),
    WORD('comp', '\\.', 'nus'),
    WORD('nus', '\\.', 'edu'),
    new RegExp('\\bNUS\\b'),
    new RegExp('\\b10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b'),
    new RegExp('\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b'),
    new RegExp('\\b172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b'),
    WORD('\\.', 'internal', '\\b'),
  ]

  const root = new URL('..', import.meta.url).pathname
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh-tmp') continue
      if (entry.name.endsWith('.tgz')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!/\.(m?js|json|md|ya?ml)$/.test(entry.name)) continue
      files.push(path)
    }
  }
  await walk(root)
  assert.ok(files.length > 20, `the scan found the tree (${files.length} files)`)

  const hits = []
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    for (const pattern of INTERNAL) {
      const match = text.match(pattern)
      if (match === null) continue
      const line = text.slice(0, match.index).split('\n').length
      hits.push(`${path.slice(root.length)}:${line} ${match[0]}`)
    }
  }
  assert.deepEqual(hits, [], `no internal host, key name or venue may appear in public code:\n${hits.join('\n')}`)
  console.log(`ok 6 — ${files.length} public files carry no internal host, key name or venue name`)
}

console.log('\ntts: all checks passed')
