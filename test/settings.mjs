/**
 * Voice settings tests for discipline-whale.
 *
 * What this covers, all without a browser:
 *
 *   1. the round trip — write base URL / model / language / key, read them back
 *   2. the key never appears in any HTTP answer, in any log line, or in the
 *      description the form renders
 *   3. the stored file is mode 0600
 *   4. precedence: settings → environment → unconfigured, per field
 *   5. clearing a key removes it and falls back to the environment
 *   6. validation refuses a bad base URL / key / model before writing anything
 *   7. the connection test: ok, rejected key, unreachable host, timeout — with a
 *      readable reason and no key in the reason
 *   8. `/voice/status` reports WHERE the key came from (env / settings / none)
 *   9. both settings routes register on the Host's connection fetch registry
 *
 * Run: node test/settings.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_MODEL,
  KEY_SOURCES,
  SETTINGS_FILENAME,
  SETTINGS_ERRORS,
  TTS_KEY_REF,
  VOICE_SETTINGS_ROUTE,
  VOICE_TEST_ROUTE,
  applySettings,
  describeVoice,
  readStoredSettings,
  registerVoiceSettingsRoutes,
  resolveKey,
  resolveTtsKey,
  settingsPath,
  testConnection,
  voiceSettingsHandler,
} from '../voice-settings.js'
import { DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, TTS_API_KEY_ENV } from '../mimo-tts.js'
import {
  VOICE_STATUS_ROUTE,
  registerVoiceRoutes,
  voiceHandler,
} from '../voice.js'

const home = await mkdtemp(join(tmpdir(), 'dw-settings-'))
const SECRET = 'sk-test-SECRET-do-not-echo-0123456789'

/** A settings handler bound to one temp home and one stub environment. */
const handler = (env = {}) => voiceSettingsHandler({ env, homeDir: home })

/** One POST to the settings route. */
const post = (body, env = {}) => handler(env)(new Request(`http://dsh${VOICE_SETTINGS_ROUTE}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}))

/** One GET of the settings route. */
const get = (env = {}) => handler(env)(new Request(`http://dsh${VOICE_SETTINGS_ROUTE}`))

// --- 1. round trip --------------------------------------------------------

{
  const saved = await post({
    baseUrl: 'https://example.test/v1/',
    model: 'whisper-large-v3',
    language: 'zh',
    apiKey: SECRET,
  }, {})
  assert.equal(saved.status, 200, 'the settings POST must succeed')
  const savedBody = await saved.json()
  assert.equal(savedBody.baseUrl, 'https://example.test/v1', 'the trailing slash is stripped')
  assert.equal(savedBody.model, 'whisper-large-v3')
  assert.equal(savedBody.language, 'zh')
  assert.equal(savedBody.hasApiKey, true)
  assert.equal(savedBody.keySource, KEY_SOURCES.settings, 'a key saved here reports the settings source')
  assert.equal(JSON.stringify(savedBody).includes(SECRET), false, 'the POST answer may not echo the key')

  // A fresh GET (a page reload) sees the same values, again without the key.
  const read = await get({})
  assert.equal(read.status, 200)
  const readBody = await read.json()
  assert.equal(readBody.baseUrl, 'https://example.test/v1')
  assert.equal(readBody.hasApiKey, true)
  assert.equal(readBody.keySource, KEY_SOURCES.settings)
  assert.equal(JSON.stringify(readBody).includes(SECRET), false, 'the GET answer may not echo the key')

  // The stored document holds the key (this is the store, not a response).
  const stored = await readStoredSettings(home)
  assert.equal(stored.apiKey, SECRET)
  console.log('ok 1 — settings round-trip through the route, with no key in either answer')
}

// --- 2. the file mode -----------------------------------------------------

{
  const path = settingsPath(home)
  const info = await stat(path)
  assert.equal(info.mode & 0o777, 0o600, `the settings file must be 0600, got ${(info.mode & 0o777).toString(8)}`)
  assert.equal(path.endsWith(SETTINGS_FILENAME), true)
  assert.equal(path.includes(home), true, 'the file lives under the plugin data directory, never the repo')
  console.log('ok 2 — the settings file is created with mode 0600 inside the plugin data directory')
}

// --- 3. precedence --------------------------------------------------------

{
  // Settings beat the environment.
  const both = await describeVoice({ env: { [API_KEY_ENV]: 'sk-from-env-0123456789', [BASE_URL_ENV]: 'https://env.test/v1' }, homeDir: home })
  assert.equal(both.keySource, KEY_SOURCES.settings, 'the saved key wins over the environment')
  assert.equal(both.baseUrl, 'https://example.test/v1', 'a saved base URL wins over the environment')
  assert.equal(JSON.stringify(both).includes('sk-from-env'), false)

  // Clearing both fields falls back to the environment.
  await post({ apiKey: '', baseUrl: '' }, {})
  const envOnly = await describeVoice({ env: { [API_KEY_ENV]: 'sk-from-env-0123456789', [BASE_URL_ENV]: 'https://env.test/v1' }, homeDir: home })
  assert.equal(envOnly.keySource, KEY_SOURCES.env, 'with nothing saved the environment is the source')
  assert.equal(envOnly.baseUrl, 'https://env.test/v1')
  assert.equal(envOnly.hasApiKey, true)

  // Nothing anywhere: the form is told what is missing, not left guessing.
  const none = await describeVoice({ env: {}, homeDir: home })
  assert.equal(none.hasApiKey, false)
  assert.equal(none.keySource, KEY_SOURCES.none)
  assert.equal(none.baseUrl, '', 'an unconfigured transcription endpoint stays empty rather than naming a host')
  assert.equal(none.endpointConfigured, false, 'no endpoint is reported as not configured')
  assert.equal(none.model, DEFAULT_MODEL)
  assert.equal(none.apiKeyEnv, API_KEY_ENV, 'the answer names the environment variable to set')
  // Read-aloud: a real speech channel now exists, with its own key and the
  // provider's public defaults, and the browser synthesizer remains the
  // fallback. Both halves of that are stated, neither is implied.
  assert.equal(none.tts.integrated, true, 'TTS is integrated, not a placeholder')
  assert.equal(none.tts.fallback, 'browser-speech-synthesis', 'the browser fallback is still named')
  assert.equal(none.tts.fallbackDefaultOn, false, 'the fallback is off by default')
  assert.equal(none.tts.needsOwnKey, true, 'the speech key is separate from the transcription key')
  assert.equal(none.tts.hasApiKey, false, 'no speech key configured yet')
  assert.equal(none.tts.keySource, KEY_SOURCES.none)
  assert.equal(none.tts.apiKeyEnv, TTS_API_KEY_ENV, 'the speech key names its own environment variable')
  assert.equal(none.tts.baseUrl, DEFAULT_TTS_BASE_URL, 'the speech endpoint falls back to the provider default')
  assert.equal(none.tts.model, DEFAULT_TTS_MODEL)
  assert.deepEqual(none.tts.formats, ['wav', 'mp3', 'pcm'])
  assert.ok(none.tts.formats.includes(none.tts.format), 'the default format is one the backend serves')
  console.log('ok 3 — settings → environment → default, reported per field and per source')
}

// --- 4. validation writes nothing -----------------------------------------

{
  const before = await readStoredSettings(home)
  const cases = [
    { body: { baseUrl: 'not-a-url' }, code: SETTINGS_ERRORS.baseUrl },
    { body: { baseUrl: 'ftp://example.test/v1' }, code: SETTINGS_ERRORS.baseUrl },
    { body: { baseUrl: 'https://example.test/v1?token=x' }, code: SETTINGS_ERRORS.baseUrl },
    { body: { model: 'bad model!' }, code: SETTINGS_ERRORS.model },
    { body: { language: 'zh_CN!' }, code: SETTINGS_ERRORS.language },
    { body: { apiKey: ' short ' }, code: SETTINGS_ERRORS.apiKey },
    { body: { apiKey: 'sk-has\nnewline-0123456789' }, code: SETTINGS_ERRORS.apiKey },
  ]
  for (const item of cases) {
    const response = await post(item.body, {})
    assert.equal(response.status, 400, `HTTP status for ${JSON.stringify(item.body)}`)
    const payload = await response.json()
    assert.equal(payload.error.code, item.code)
    assert.equal(JSON.stringify(payload).includes('sk-has'), false)
  }
  // A malformed body and a non-object body are refused, not thrown into the host.
  assert.equal((await post('{not json', {})).status, 400)
  assert.equal((await post('[1,2]', {})).status, 400)
  const after = await readStoredSettings(home)
  assert.deepEqual(after, before, 'a refused patch leaves the stored file untouched')
  console.log('ok 4 — bad base URLs, models, languages and keys are refused before any write')
}

// --- 5. the key never reaches a log line ----------------------------------

{
  const lines = []
  const logger = { warn: (line) => lines.push(String(line)) }
  const probing = voiceSettingsHandler({
    env: {},
    homeDir: home,
    logger,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }] }), { status: 200 }),
  })
  await probing(new Request(`http://dsh${VOICE_TEST_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: SECRET, baseUrl: 'https://example.test/v1' }),
  }))
  assert.ok(lines.length > 0, 'the probe is logged at all')
  for (const line of lines) assert.equal(line.includes(SECRET), false, `a log line leaked the key: ${line}`)
  console.log('ok 5 — the connection probe logs an outcome line that never contains the key')
}

// --- 6. the connection test ----------------------------------------------

{
  const seen = []
  const okFetch = async (url, init) => {
    seen.push({ url, auth: init?.headers?.authorization })
    return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'whisper-1' }] }), { status: 200 })
  }
  const okResult = await testConnection({ baseUrl: 'https://example.test/v1/', apiKey: SECRET }, { fetch: okFetch, env: {}, homeDir: home })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.code, 'voice/test-ok')
  assert.equal(seen[0].url, 'https://example.test/v1/models', 'the probe is one GET /models')
  assert.equal(seen[0].auth, `Bearer ${SECRET}`)
  assert.equal(JSON.stringify(okResult).includes(SECRET), false, 'the probe answer may not echo the key')
  assert.deepEqual(okResult.models, ['whisper-large-v3', 'whisper-1'])

  const rejected = await testConnection({ baseUrl: 'https://example.test/v1', apiKey: SECRET }, {
    fetch: async () => new Response(JSON.stringify({ error: 'invalid API key' }), { status: 401 }),
    env: {}, homeDir: home,
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'voice/invalid-key')
  assert.match(rejected.message, /rejected the key/)
  assert.equal(JSON.stringify(rejected).includes(SECRET), false)

  const missing = await testConnection({ baseUrl: 'https://example.test/v1' }, { env: {}, homeDir: home, fetch: okFetch })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'voice/missing-key')
  assert.match(missing.message, new RegExp(API_KEY_ENV))

  const unreachable = await testConnection({ baseUrl: 'https://dead.test/v1', apiKey: SECRET }, {
    fetch: async () => { throw new Error('getaddrinfo ENOTFOUND dead.test') },
    env: {}, homeDir: home,
  })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.code, 'voice/backend-unreachable')
  assert.match(unreachable.message, /ENOTFOUND/)

  const slow = await testConnection({ baseUrl: 'https://slow.test/v1', apiKey: SECRET }, {
    env: {}, homeDir: home, timeoutMs: 40,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  })
  assert.equal(slow.ok, false)
  assert.equal(slow.code, 'voice/backend-timeout')
  assert.match(slow.message, /no answer/)

  // A 404 names the likely cause instead of blaming the key.
  const notFound = await testConnection({ baseUrl: 'https://example.test', apiKey: SECRET }, {
    fetch: async () => new Response('not found', { status: 404 }), env: {}, homeDir: home,
  })
  assert.equal(notFound.code, 'voice/endpoint-not-found')
  assert.match(notFound.message, /404/)
  console.log('ok 6 — the probe distinguishes ok / rejected key / missing key / unreachable / timeout / bad path')
}

// --- 7. the status route reports the key SOURCE ---------------------------

{
  // The status route is what the dock reads before it opens a call: it has to
  // say where the key came from, so the settings form can show the same thing.
  await post({ apiKey: SECRET, baseUrl: 'https://example.test/v1' }, {})
  const settingsStatus = await voiceHandler({ env: {}, homeDir: home })(new Request(`http://dsh${VOICE_STATUS_ROUTE}`))
  assert.equal(settingsStatus.status, 200)
  const settingsBody = await settingsStatus.json()
  assert.equal(settingsBody.configured, true)
  assert.equal(settingsBody.keySource, KEY_SOURCES.settings, 'a saved key reports the settings source')
  assert.equal(JSON.stringify(settingsBody).includes(SECRET), false, 'status may not echo the key')

  await post({ apiKey: '' }, {})
  const envStatus = await voiceHandler({ env: { [API_KEY_ENV]: 'sk-from-env-0123456789' }, homeDir: home })(new Request(`http://dsh${VOICE_STATUS_ROUTE}`))
  const envBody = await envStatus.json()
  assert.equal(envBody.configured, true)
  assert.equal(envBody.keySource, KEY_SOURCES.env)
  assert.equal(JSON.stringify(envBody).includes('sk-from-env'), false)

  const noneStatus = await voiceHandler({ env: {}, homeDir: home })(new Request(`http://dsh${VOICE_STATUS_ROUTE}`))
  const noneBody = await noneStatus.json()
  assert.equal(noneBody.configured, false)
  assert.equal(noneBody.keySource, KEY_SOURCES.none)
  assert.equal(noneBody.apiKeyEnv, API_KEY_ENV)
  console.log('ok 7 — /voice/status reports env / settings / none without ever returning the key')
}

// --- 8. route registration ------------------------------------------------

{
  const routes = []
  const connection = { fetch: { register: async (route) => { routes.push(route); return async () => {} } } }
  await registerVoiceSettingsRoutes(connection, { env: {}, homeDir: home })
  assert.deepEqual(routes.map((route) => route.path).sort(), [VOICE_SETTINGS_ROUTE, VOICE_TEST_ROUTE].sort())
  assert.ok(routes.every((route) => route.requestBody === 'buffered'))

  // The transcription routes keep their own two paths; the settings half adds
  // its own pair. One connection registry, no second HTTP server.
  const voiceRoutes = []
  const voiceConnection = { fetch: { register: async (route) => { voiceRoutes.push(route); return async () => {} } } }
  await registerVoiceRoutes(voiceConnection, { env: {}, homeDir: home })
  assert.deepEqual(voiceRoutes.map((route) => route.path).sort(), [VOICE_STATUS_ROUTE, '/api/discipline-whale/voice/transcribe', '/api/discipline-whale/voice/speak'].sort())
  for (const route of routes) assert.equal(voiceRoutes.some((own) => own.path === route.path), false, `${route.path} registers once`)
  console.log('ok 8 — the settings and probe routes register on connection.fetch, beside the transcription routes')
}

// --- 9. the Host credential seam is preferred when present ----------------

{
  // A fake credentials seam, shaped like the real one: managed file layer
  // (`source: "file"`) above an inherited environment layer (`source: "env"`).
  const seam = {
    store: new Map(),
    env: { [API_KEY_ENV]: 'sk-from-env-0123456789' },
    async describe() {
      const stored = this.store.get('DW_STT_API_KEY')
      if (stored !== undefined) return { configured: true, source: 'file', writable: true }
      if (this.env[API_KEY_ENV] !== undefined) return { configured: true, source: 'env', writable: true }
      return { configured: false, writable: true }
    },
    async resolve() {
      const stored = this.store.get('DW_STT_API_KEY')
      if (stored !== undefined) return { value: stored, source: 'file' }
      if (this.env[API_KEY_ENV] !== undefined) return { value: this.env[API_KEY_ENV], source: 'env' }
      return undefined
    },
    async set(_ref, value) { this.store.set('DW_STT_API_KEY', value) },
    async unset() { this.store.delete('DW_STT_API_KEY') },
  }

  // Before saving: the environment layer of the seam is the source.
  const beforeSave = await describeVoice({ env: {}, credentials: seam, homeDir: home })
  assert.equal(beforeSave.hasApiKey, true)
  assert.equal(beforeSave.keySource, KEY_SOURCES.env, 'the seam environment layer reads as env')

  // Saving through this plugin goes to the seam's managed store, not the file.
  const saved = await applySettings({ apiKey: SECRET }, { env: {}, credentials: seam, homeDir: home })
  assert.equal(saved.settings.keySource, KEY_SOURCES.settings, 'the seam managed store reads as settings')
  assert.equal(seam.store.get('DW_STT_API_KEY'), SECRET)
  const fileAfterSeam = await readStoredSettings(home)
  assert.equal(fileAfterSeam.apiKey, undefined, 'no second copy of the key is kept in the plugin file')

  // Clearing goes through the seam too, and the environment layer reappears.
  await applySettings({ apiKey: '' }, { env: {}, credentials: seam, homeDir: home })
  assert.equal(seam.store.has('DW_STT_API_KEY'), false)
  const afterClear = await describeVoice({ env: {}, credentials: seam, homeDir: home })
  assert.equal(afterClear.keySource, KEY_SOURCES.env, 'clearing the saved key falls back to the environment layer')

  // A throwing seam must not disable voice: the file layer still works.
  const brokenSeam = {
    async describe() { throw new Error('store unreadable') },
    async resolve() { throw new Error('store unreadable') },
    async set() { throw new Error('store read-only') },
    async unset() { throw new Error('store read-only') },
  }
  const fellBack = await applySettings({ apiKey: SECRET }, { env: {}, credentials: brokenSeam, homeDir: home })
  assert.equal(fellBack.settings.hasApiKey, true, 'a broken seam falls back to the plugin file')
  assert.equal((await readStoredSettings(home)).apiKey, SECRET)
  await applySettings({ apiKey: '' }, { env: {}, credentials: brokenSeam, homeDir: home })
  const resolved = await resolveKey({ env: {}, homeDir: home })
  assert.equal(resolved.value, '')
  assert.equal(resolved.source, KEY_SOURCES.none)
  console.log('ok 9 — the Host credential seam is used when present; the 0600 file is the fallback')
}

// --- 10. the source of truth is one file ----------------------------------

{
  // The stored document must never be written into the repo working tree.
  const path = settingsPath(home)
  assert.equal(path.includes('/discipline-whale/'), true)
  const text = await readFile(path, 'utf8')
  assert.equal(text.includes(SECRET), false, 'the key was cleared above, so the file holds no secret')
  console.log('ok 10 — the settings document lives only in the plugin data directory')
}
// --- 11. a hand-written key file beside the settings ----------------------

{
  // `$DSH_HOME/discipline-whale/mimo.json` is the file a person writes by hand
  // (or that an operator drops in) so the speech key never has to pass through
  // a chat or a form. It is deliberately NOT the settings document: keeping it
  // separate means `applySettings` can never clobber a value someone typed
  // into a file, and clearing the form never deletes it.
  const key = 'sk-handwritten-0123456789'
  await writeFile(join(home, 'discipline-whale', 'mimo.json'), JSON.stringify({ apiKey: key, voice: 'female-shaonv', format: 'wav' }), { mode: 0o600 })

  const read = await describeVoice({ env: {}, homeDir: home })
  assert.equal(read.tts.hasApiKey, true, 'a hand-written key file is found')
  assert.equal(read.tts.keySource, KEY_SOURCES.settings, 'it reports the settings layer, which is where a file lives')
  assert.equal(JSON.stringify(read).includes(key), false, 'the description may not echo it')
  assert.equal((await resolveTtsKey({ env: {}, homeDir: home })).value, key)

  // The environment still wins over nothing, and the file still wins over the
  // environment — the same precedence as every other field.
  assert.equal((await resolveTtsKey({ env: { [TTS_API_KEY_ENV]: 'sk-from-env-0123456789' }, homeDir: home })).value, key,
    'a key written to the file beats the environment, as every stored value does')

  // A form save must not delete the hand-written key, and a clear through the
  // form must be explicit about the file it is leaving alone.
  await applySettings({ ttsVoice: 'male-qn-qingse' }, { env: {}, homeDir: home })
  assert.equal((await resolveTtsKey({ env: {}, homeDir: home })).value, key, 'saving another field does not touch the key file')

  // A malformed key file is ignored rather than breaking speech: it falls back
  // to the environment, and only then to "not configured".
  await writeFile(join(home, 'discipline-whale', 'mimo.json'), 'not json at all', { mode: 0o600 })
  assert.equal((await resolveTtsKey({ env: { [TTS_API_KEY_ENV]: 'sk-from-env-0123456789' }, homeDir: home })).value, 'sk-from-env-0123456789',
    'a corrupt key file falls back to the environment')
  assert.equal((await resolveTtsKey({ env: {}, homeDir: home })).source, KEY_SOURCES.none,
    'with no environment either, a corrupt file means not configured, not a crash')

  // A key file naming the wrong type is refused the same way.
  await writeFile(join(home, 'discipline-whale', 'mimo.json'), JSON.stringify({ apiKey: 12345 }), { mode: 0o600 })
  assert.equal((await resolveTtsKey({ env: {}, homeDir: home })).value, '', 'a non-string key is not a key')

  // An earlier save in this file left a voice in the settings document, and the
  // form wins over the file — so clear it first, then the file is what speaks.
  await post({ ttsVoice: '' }, {})
  assert.equal((await describeVoice({ env: {}, homeDir: home })).tts.voice, DEFAULT_TTS_VOICE)

  // The file configures the WHOLE speech channel, not just the key: a person
  // can drop one file on a machine and never open the UI.
  await writeFile(join(home, 'discipline-whale', 'mimo.json'), JSON.stringify({
    apiKey: key, baseUrl: 'https://file.test/v1/', voice: 'file-voice', format: 'MP3',
  }), { mode: 0o600 })
  const whole = await describeVoice({ env: {}, homeDir: home })
  assert.equal(whole.tts.baseUrl, 'https://file.test/v1', 'the file sets the endpoint, trailing slash trimmed')
  assert.equal(whole.tts.voice, 'file-voice', 'the file sets the voice')
  assert.equal(whole.tts.format, 'mp3', 'the file sets the format, normalised to lower case')

  // But the form still wins over the file for a field it holds, so a UI edit
  // is never silently ignored.
  await post({ ttsVoice: 'form-voice' }, {})
  assert.equal((await describeVoice({ env: {}, homeDir: home })).tts.voice, 'form-voice',
    'a value saved in the form beats the file')
  await post({ ttsVoice: '' }, {})

  // The nested shape is accepted too: a person should not have to guess.
  await writeFile(join(home, 'discipline-whale', 'mimo.json'), JSON.stringify({
    tts: { apiKey: key },
  }), { mode: 0o600 })
  assert.equal((await resolveTtsKey({ env: {}, homeDir: home })).value, key, 'a nested tts block is read as well')
  console.log('ok 11 — a hand-written mimo.json is honoured, survives form saves, and degrades safely when broken')
}

// --- 12. a save never breaks a channel it found working -------------------

{
  // The reported data loss: the Base URL box starts empty (the server's answer
  // is the placeholder), so a save that only typed an API key used to send
  // `baseUrl: ""` and wipe a working transcriber. Two guards are proven here:
  // the form omits an untouched field (test/dock.mjs), and the route refuses a
  // patch that would leave a working channel unconfigured.
  await post({ baseUrl: 'https://stt.example.test/v1' }, {})
  const configured = await describeVoice({ env: {}, homeDir: home })
  assert.equal(configured.endpointConfigured, true, 'precondition: the endpoint is configured')

  // 1. Only the key changes: the endpoint must survive.
  const keyOnly = await applySettings({ apiKey: 'sk-only-the-key-012345' }, { env: {}, homeDir: home })
  assert.equal(keyOnly.problems, undefined, 'a key-only save is accepted')
  assert.equal(keyOnly.settings.endpointConfigured, true, 'only the api key changed, so the endpoint survived')

  // 2. A patch that WOULD clear the endpoint while it is in use is refused and
  //    rolled back, rather than silently downgrading a working install to 503.
  const breaking = await applySettings({ baseUrl: '' }, { env: {}, homeDir: home })
  assert.ok(Array.isArray(breaking.problems), 'the route answers a problem instead of "saved"')
  assert.equal(breaking.problems[0][0], SETTINGS_ERRORS.baseUrl)
  assert.equal(breaking.rolledBack, true)
  const survived = await describeVoice({ env: {}, homeDir: home })
  assert.equal(survived.endpointConfigured, true, 'the endpoint was restored')
  assert.equal(survived.baseUrl, 'https://stt.example.test/v1', 'the stored URL is byte-identical to before')

  // 3. An endpoint that was never configured can be cleared (no false refusal),
  //    and the deliberate clear still works once nothing depends on it.
  await applySettings({ apiKey: '' }, { env: {}, homeDir: home })
  assert.equal((await describeVoice({ env: {}, homeDir: home })).hasApiKey, false,
    'clearing the key is a stated intention, not a break, so it is not rolled back')

  // 4. A full reset is a stated intention, not a break: clearing the key too
  //    lets the endpoint go.
  const reset = await applySettings({ baseUrl: '', apiKey: '' }, { env: {}, homeDir: home })
  assert.equal(reset.problems, undefined, 'clearing the key and the endpoint together is allowed')
  assert.equal((await describeVoice({ env: {}, homeDir: home })).endpointConfigured, false)

  // 5. Turning a channel ON is always allowed.
  const reEnabled = await applySettings({ baseUrl: 'https://stt.example.test/v1', apiKey: 'sk-again-0123456789' }, { env: {}, homeDir: home })
  assert.equal(reEnabled.problems, undefined)
  assert.equal(reEnabled.settings.endpointConfigured, true)
  await applySettings({ baseUrl: '', apiKey: '' }, { env: {}, homeDir: home })
  console.log('ok 12 — a save cannot silently break a working channel: it is refused and rolled back')
}

await rm(home, { recursive: true, force: true })
console.log('\nAll discipline-whale voice-settings checks passed.')
