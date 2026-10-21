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
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  KEY_SOURCES,
  SETTINGS_FILENAME,
  SETTINGS_ERRORS,
  VOICE_SETTINGS_ROUTE,
  VOICE_TEST_ROUTE,
  applySettings,
  describeVoice,
  readStoredSettings,
  registerVoiceSettingsRoutes,
  resolveKey,
  settingsPath,
  testConnection,
  voiceSettingsHandler,
} from '../voice-settings.js'
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
  assert.equal(none.baseUrl, DEFAULT_BASE_URL, 'an unconfigured base URL falls back to the documented default')
  assert.equal(none.model, DEFAULT_MODEL)
  assert.equal(none.apiKeyEnv, API_KEY_ENV, 'the answer names the environment variable to set')
  // Read-aloud, stated precisely: a browser fallback exists and is off by
  // default; a real TTS is NOT integrated and would need its own key. Neither
  // "no TTS at all" nor "TTS is ready" is acceptable.
  assert.equal(none.tts.integrated, false, 'TTS is reported as not integrated rather than implied')
  assert.equal(none.tts.fallback, 'browser-speech-synthesis', 'the browser fallback is named')
  assert.equal(none.tts.fallbackDefaultOn, false, 'the fallback is off by default')
  assert.equal(none.tts.needsOwnKey, true, 'a real TTS would need its own key')
  assert.equal(none.tts.configurable, false, 'the TTS fields are placeholders, not a live form')
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
  assert.deepEqual(voiceRoutes.map((route) => route.path).sort(), [VOICE_STATUS_ROUTE, '/api/discipline-whale/voice/transcribe'].sort())
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
      const stored = this.store.get('SOCLAAS_API_KEY')
      if (stored !== undefined) return { configured: true, source: 'file', writable: true }
      if (this.env[API_KEY_ENV] !== undefined) return { configured: true, source: 'env', writable: true }
      return { configured: false, writable: true }
    },
    async resolve() {
      const stored = this.store.get('SOCLAAS_API_KEY')
      if (stored !== undefined) return { value: stored, source: 'file' }
      if (this.env[API_KEY_ENV] !== undefined) return { value: this.env[API_KEY_ENV], source: 'env' }
      return undefined
    },
    async set(_ref, value) { this.store.set('SOCLAAS_API_KEY', value) },
    async unset() { this.store.delete('SOCLAAS_API_KEY') },
  }

  // Before saving: the environment layer of the seam is the source.
  const beforeSave = await describeVoice({ env: {}, credentials: seam, homeDir: home })
  assert.equal(beforeSave.hasApiKey, true)
  assert.equal(beforeSave.keySource, KEY_SOURCES.env, 'the seam environment layer reads as env')

  // Saving through this plugin goes to the seam's managed store, not the file.
  const saved = await applySettings({ apiKey: SECRET }, { env: {}, credentials: seam, homeDir: home })
  assert.equal(saved.settings.keySource, KEY_SOURCES.settings, 'the seam managed store reads as settings')
  assert.equal(seam.store.get('SOCLAAS_API_KEY'), SECRET)
  const fileAfterSeam = await readStoredSettings(home)
  assert.equal(fileAfterSeam.apiKey, undefined, 'no second copy of the key is kept in the plugin file')

  // Clearing goes through the seam too, and the environment layer reappears.
  await applySettings({ apiKey: '' }, { env: {}, credentials: seam, homeDir: home })
  assert.equal(seam.store.has('SOCLAAS_API_KEY'), false)
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

await rm(home, { recursive: true, force: true })
console.log('\nAll discipline-whale voice-settings checks passed.')
