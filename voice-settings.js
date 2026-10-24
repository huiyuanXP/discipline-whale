/**
 * discipline-whale — the voice settings surface: where the transcription key and
 * endpoint, the text-to-speech key and endpoint, and the voices come from, and
 * how the browser half learns that without ever seeing a key.
 *
 * ## Two independent services
 *
 * Speech IN (transcription) and speech OUT (text to speech) are configured
 * separately, because they are separate services with separate keys:
 *
 *   | | transcription (in) | speech (out) |
 *   |---|---|---|
 *   | key | `DW_STT_API_KEY` | `MIMO_TOKEN_PLAN_KEY` |
 *   | endpoint | `DW_STT_BASE_URL` | `MIMO_TTS_BASE_URL` |
 *   | path | `/audio/transcriptions` | `/chat/completions` |
 *   | default endpoint | none | the provider's public API host |
 *
 * Transcription has no default endpoint on purpose. This plugin is published,
 * and a transcription backend is a deployment choice, not something to guess:
 * without one configured the route answers "no transcription endpoint is
 * configured" instead of reaching for a host the operator never named.
 *
 * ## Where a key can live
 *
 * Two storage backends, tried in this order:
 *
 *  1. **`ctx.credentials`** — the Host's own credential seam
 *     (`@deepseek-ai/dsh-credentials-local`). It writes
 *     `$DSH_HOME/.credentials.yaml` with mode 0600, hot-reloads external edits,
 *     and answers `describe(ref)` with `{ configured, source }` where `source`
 *     is `file` (managed store) or `env` (inherited environment). Reusing it is
 *     the point: this plugin does not invent a second secret store when the
 *     product already ships one.
 *  2. **The plugin's own data files** — `$DSH_HOME/discipline-whale/voice.json`
 *     (mode 0600, atomic replace) is the settings document the form owns: the
 *     fallback for compositions where the credentials seam is not mounted
 *     (headless / minimal profiles), carrying the non-secret fields (base URLs,
 *     models, voices) because those have no Host seam and are not secrets.
 *     `$DSH_HOME/discipline-whale/mimo.json` (mode 0600) is read-only to the
 *     plugin: it exists so a speech key can be dropped in by hand or by
 *     provisioning without passing through a chat or a form, and it is never
 *     rewritten, so a form save cannot clobber it.
 *
 * Neither file is in `package.json`'s `files` list, and both live under
 * `$DSH_HOME`, so an installed plugin never ships a local configuration.
 *
 * ## Precedence (decision, not accident)
 *
 * `settings → environment → default`.
 *
 * The settings value wins because it is the value the user typed into this
 * plugin's own form, and because it matches the Host's own credential
 * precedence: `dsh-credentials-local` deliberately ranks its managed document
 * above the inherited environment so "a credential the user explicitly saved
 * in the product must take effect consistently". The environment variables
 * remain a working zero-config path, and the status route reports which layer
 * won so the UI can say so instead of guessing.
 *
 * ## What never leaves this module
 *
 * The key values themselves. `describeVoice()` is the only shape the HTTP layer
 * returns, and it has no field a key could ride in: `hasApiKey`, `keySource`,
 * and for the needs-a-key error, the environment variable name to set.
 *
 * @module discipline-whale/voice-settings
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dataDir, storeRoot } from './store.js'
import {
  DEFAULT_TTS_FORMAT,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  TTS_API_KEY_ENV,
  TTS_BASE_URL_ENV,
  TTS_FORMATS,
  resolveBaseUrl as resolveTtsBaseUrl,
} from './mimo-tts.js'

/** Route the browser half reads and writes the non-secret voice settings on. */
export const VOICE_SETTINGS_ROUTE = '/api/discipline-whale/voice/settings'

/** Route that performs one lightweight upstream probe. */
export const VOICE_TEST_ROUTE = '/api/discipline-whale/voice/test'

/** File name inside the plugin data directory (never inside the repo). */
export const SETTINGS_FILENAME = 'voice.json'

/**
 * A hand-written speech key file, beside the settings document.
 *
 * Kept separate from `voice.json` on purpose. The settings document belongs to
 * the form: `applySettings` rewrites it wholesale, and clearing a key there
 * deletes it. This file belongs to the person who wrote it — it is read, never
 * written, and never removed, so a key dropped into a file by hand (or by an
 * operator provisioning a machine) cannot be clobbered by a form save.
 *
 * Shape: `{ "apiKey": "...", "voice": "...", "format": "wav" }`; every field is
 * optional and the file may also be nested under `tts`. A missing, unreadable
 * or malformed file is simply absent — never an error.
 */
export const KEY_FILENAME = 'mimo.json'

/** File mode for anything holding a secret. */
export const SECRET_FILE_MODE = 0o600

/** Environment variable holding the transcription key. Never echoed. */
export const API_KEY_ENV = 'DW_STT_API_KEY'

/** Environment variable holding the transcription base URL. */
export const BASE_URL_ENV = 'DW_STT_BASE_URL'

/**
 * The transcription base URL when nothing is configured.
 *
 * Empty on purpose: a published plugin has no business naming a default
 * transcription host. An unset endpoint is reported as unset, and the route
 * refuses with "not configured" rather than reaching for a guessed host.
 */
export const DEFAULT_BASE_URL = ''

/** Default transcription model id. */
export const DEFAULT_MODEL = 'whisper-large-v3'

/** The credential reference transcription is addressed by. */
export const KEY_REF = 'DW_STT_API_KEY'

/** The credential reference text to speech is addressed by. */
export const TTS_KEY_REF = TTS_API_KEY_ENV

/** Where the effective key came from, in the vocabulary the UI renders. */
export const KEY_SOURCES = Object.freeze({
  /** Written through this plugin's settings form (Host store or plugin file). */
  settings: 'settings',
  /** Inherited process environment / `.env` layer. */
  env: 'env',
  /** Nothing configured. */
  none: 'none',
})

/** Structured refusals the settings routes answer with. */
export const SETTINGS_ERRORS = Object.freeze({
  method: 'voice-settings/method-not-allowed',
  badJson: 'voice-settings/malformed-json',
  baseUrl: 'voice-settings/invalid-base-url',
  model: 'voice-settings/invalid-model',
  language: 'voice-settings/invalid-language',
  apiKey: 'voice-settings/invalid-api-key',
  ttsBaseUrl: 'voice-settings/invalid-tts-base-url',
  ttsVoice: 'voice-settings/invalid-tts-voice',
  ttsFormat: 'voice-settings/invalid-tts-format',
  ttsApiKey: 'voice-settings/invalid-tts-api-key',
  readOnly: 'voice-settings/read-only',
  unreadable: 'voice-settings/unreadable',
})

/** Fields a POST may change. Anything else in the body is ignored. */
export const EDITABLE_FIELDS = Object.freeze([
  'baseUrl', 'apiKey', 'model', 'language',
  'ttsBaseUrl', 'ttsApiKey', 'ttsVoice', 'ttsFormat',
])

/** Bound on the stored base URL, so a paste cannot grow the file without limit. */
export const MAX_BASE_URL_CHARS = 500

/** Bound on a stored key. */
export const MAX_API_KEY_CHARS = 4096

/** Bound on the upstream probe, so a dead host cannot hold the request open. */
export const TEST_TIMEOUT_MS = 15_000

/** Bound on a stored voice id. */
export const MAX_VOICE_CHARS = 120

/** The plugin's settings file path. */
export function settingsPath(homeDir = storeRoot()) {
  return join(dataDir(homeDir), SETTINGS_FILENAME)
}

/** The hand-written speech key file path. */
export function keyFilePath(homeDir = storeRoot()) {
  return join(dataDir(homeDir), KEY_FILENAME)
}

/**
 * Read the hand-written speech key file.
 *
 * Accepts both `{ apiKey, voice, format }` and `{ tts: { apiKey, ... } }`,
 * because a person writing this by hand should not have to guess the nesting.
 * Anything unreadable, unparseable, or the wrong type answers `{}`.
 */
export async function readKeyFile(homeDir = storeRoot()) {
  let value
  try {
    value = JSON.parse(await readFile(keyFilePath(homeDir), 'utf8'))
  } catch {
    return {}
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const nested = value.tts
  const source = nested !== null && typeof nested === 'object' && !Array.isArray(nested)
    ? { ...value, ...nested }
    : value
  const out = {}
  if (typeof source.apiKey === 'string' && source.apiKey.trim() !== '') out.apiKey = source.apiKey.trim()
  if (typeof source.baseUrl === 'string' && source.baseUrl.trim() !== '') out.baseUrl = source.baseUrl.trim()
  if (typeof source.voice === 'string' && source.voice.trim() !== '') out.voice = source.voice.trim()
  const format = typeof source.format === 'string' ? source.format.trim().toLowerCase() : ''
  if (TTS_FORMATS.has(format)) out.format = format
  return out
}

/** One structured refusal, in the shape the browser half reads. */
function failure(code, message, status = 400, details = {}) {
  return Response.json(
    { error: { code, message, ...details } },
    { status, headers: { 'cache-control': 'no-store' } },
  )
}

/** A JSON answer that a proxy must never cache. */
function okJson(payload, status = 200) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

/** Normalize a base URL: trimmed, trailing slashes removed. */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

/**
 * Validate one base URL.
 * @returns an error message, or undefined when the value is acceptable.
 */
export function baseUrlProblem(value) {
  if (typeof value !== 'string') return 'base URL must be a string'
  const trimmed = value.trim()
  if (trimmed === '') return undefined // empty means "use the default"
  if (trimmed.length > MAX_BASE_URL_CHARS) return `base URL may not exceed ${MAX_BASE_URL_CHARS} characters`
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'base URL must be an absolute http(s) URL, e.g. https://host/v1'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'base URL must use http or https'
  if (parsed.hostname === '') return 'base URL must name a host'
  if (parsed.search !== '' || parsed.hash !== '') return 'base URL may not carry a query or a fragment'
  return undefined
}

/** Validate one model id. */
export function modelProblem(value) {
  if (typeof value !== 'string') return 'model must be a string'
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > 120) return 'model may not exceed 120 characters'
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(trimmed)) return 'model may only contain letters, digits, dot, dash, underscore, colon and slash'
  return undefined
}

/** Validate one language hint (`zh`, `en`, `zh-CN`, or empty). */
export function languageProblem(value) {
  if (typeof value !== 'string') return 'language must be a string'
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (!/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(trimmed)) return 'language must look like "zh" or "zh-CN"'
  return undefined
}

/**
 * Validate one API key.
 *
 * An empty string is legal and means "unset": that is how the form clears a
 * stored key. A key that is merely whitespace is refused rather than silently
 * trimming to something the user did not type.
 */
export function apiKeyProblem(value) {
  if (typeof value !== 'string') return 'api key must be a string'
  if (value === '') return undefined
  if (value.trim() !== value) return 'api key may not start or end with whitespace'
  if (value.length < 8) return 'api key looks too short'
  if (value.length > MAX_API_KEY_CHARS) return `api key may not exceed ${MAX_API_KEY_CHARS} characters`
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'api key may not contain control characters or newlines'
  return undefined
}

/** Validate one speech voice id: letters, digits, dot, dash, underscore, colon. */
export function voiceProblem(value) {
  if (typeof value !== 'string') return 'voice must be a string'
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_VOICE_CHARS) return `voice may not exceed ${MAX_VOICE_CHARS} characters`
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) {
    return 'voice may only contain letters, digits, dot, dash, underscore and colon'
  }
  return undefined
}

/** Validate one speech container name: the three the backend serves. */
export function formatProblem(value) {
  if (typeof value !== 'string') return 'format must be a string'
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return undefined
  if (!TTS_FORMATS.has(trimmed)) {
    return `format must be one of ${[...TTS_FORMATS.keys()].join(', ')}`
  }
  return undefined
}

/** Read the stored settings file; a missing or unreadable file is an empty object. */
export async function readStoredSettings(homeDir = storeRoot()) {
  try {
    const value = JSON.parse(await readFile(settingsPath(homeDir), 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    return value
  } catch {
    return {}
  }
}

/**
 * Write the settings file atomically with mode 0600.
 *
 * The temp file is created with the final mode (not chmod-ed afterwards), so
 * there is no window in which the key sits on disk world-readable; `chmod` is
 * still applied after the rename because `rename` preserves the source mode and
 * an operator may have loosened the directory.
 */
export async function writeStoredSettings(next, homeDir = storeRoot()) {
  const dir = dataDir(homeDir)
  await mkdir(dir, { recursive: true })
  const target = settingsPath(homeDir)
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: SECRET_FILE_MODE })
  await rename(temp, target)
  try {
    await chmod(target, SECRET_FILE_MODE)
  } catch {
    // A platform without POSIX modes keeps the write; the mode is best effort.
  }
  return target
}

/** True when the Host's credential seam is usable on this context. */
export function hasCredentialSeam(credentials) {
  return credentials !== undefined && credentials !== null
    && typeof credentials.resolve === 'function'
    && typeof credentials.describe === 'function'
    && typeof credentials.set === 'function'
}

/**
 * Resolve the effective key without revealing it.
 *
 * Settings first, then the environment. With the Host seam present the
 * settings layer IS the seam's managed store, which already layers over the
 * environment — so the seam's own `source` is authoritative and we do not
 * second-guess it.
 *
 * @returns `{ value, source }` where source is a {@link KEY_SOURCES} member.
 */
export async function resolveKey({ env = process.env, credentials, homeDir = storeRoot() } = {}) {
  return resolveNamedKey({
    ref: KEY_REF,
    envVar: API_KEY_ENV,
    field: 'apiKey',
    env,
    credentials,
    homeDir,
  })
}

/**
 * The same resolution for one named secret.
 *
 * Both keys go through this one path on purpose: the precedence question
 * ("settings, then environment") has one answer, and two copies of it would
 * eventually disagree.
 *
 * @param input ref (credential address), envVar, field (key in the settings
 *   file), plus env / credentials / homeDir.
 */
export async function resolveNamedKey({ ref, envVar, field, env = process.env, credentials, homeDir = storeRoot(), beforeEnv }) {
  if (hasCredentialSeam(credentials)) {
    try {
      const described = await credentials.describe(ref)
      if (described?.configured === true) {
        const resolved = await credentials.resolve(ref)
        const value = typeof resolved?.value === 'string' ? resolved.value : ''
        if (value !== '') {
          // `file` is the managed store the settings form writes; every other
          // layer (`env`, `project-env`, `user-env`) is an environment source.
          return { value, source: described.source === 'file' ? KEY_SOURCES.settings : KEY_SOURCES.env }
        }
      }
    } catch {
      // A broken credential store must not disable voice: fall through to the
      // plugin file and the environment.
    }
  }
  const stored = await readStoredSettings(homeDir)
  if (typeof stored[field] === 'string' && stored[field] !== '') {
    return { value: stored[field], source: KEY_SOURCES.settings }
  }
  if (typeof beforeEnv === 'function') {
    const fromHook = await beforeEnv()
    if (fromHook !== undefined && fromHook.value !== '') return fromHook
  }
  const fromEnv = env[envVar]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { value: fromEnv.trim(), source: KEY_SOURCES.env }
  }
  return { value: '', source: KEY_SOURCES.none }
}

/** The effective text-to-speech key. Same precedence, its own credential ref. */
export async function resolveTtsKey({ env = process.env, credentials, homeDir = storeRoot() } = {}) {
  // The settings layers first (the seam, then the form's document), then the
  // hand-written key file, then the environment. The file sits above the
  // environment because it is a deliberate local choice — someone wrote it and
  // put it there — while an inherited variable may predate the file.
  const named = await resolveNamedKey({
    ref: TTS_KEY_REF,
    envVar: TTS_API_KEY_ENV,
    field: 'ttsApiKey',
    env,
    credentials,
    homeDir,
    // The file is consulted between the stored document and the environment.
    beforeEnv: async () => {
      const file = await readKeyFile(homeDir)
      return typeof file.apiKey === 'string' && file.apiKey !== ''
        ? { value: file.apiKey, source: KEY_SOURCES.settings }
        : undefined
    },
  })
  return named
}

/**
 * The effective, key-free configuration: what the routes and the settings form
 * both read.
 *
 * Precedence per field: stored settings → environment → default. A blank stored
 * field means "inherit", which is what makes clearing a field in the form fall
 * back to the environment instead of pinning an empty value.
 *
 * The `tts` block is described in full because the form renders a real control
 * for each field. It carries no key: `hasApiKey` / `keySource` say whether one
 * exists and where it came from, which is all the page is allowed to know.
 */
export async function describeVoice({ env = process.env, credentials, homeDir = storeRoot() } = {}) {
  const stored = await readStoredSettings(homeDir)
  const storedBaseUrl = normalizeBaseUrl(typeof stored.baseUrl === 'string' ? stored.baseUrl : '')
  const envBaseUrl = normalizeBaseUrl(typeof env[BASE_URL_ENV] === 'string' ? env[BASE_URL_ENV] : '')
  const baseUrl = storedBaseUrl !== '' ? storedBaseUrl : envBaseUrl !== '' ? envBaseUrl : DEFAULT_BASE_URL
  const model = typeof stored.model === 'string' && stored.model.trim() !== '' ? stored.model.trim() : DEFAULT_MODEL
  const language = typeof stored.language === 'string' ? stored.language.trim() : ''
  const key = await resolveKey({ env, credentials, homeDir })

  // The hand-written key file fills any speech field the form left blank, so a
  // person can configure the whole channel in one file without touching the UI.
  const keyFile = await readKeyFile(homeDir)
  const storedTtsBaseUrl = normalizeBaseUrl(typeof stored.ttsBaseUrl === 'string' ? stored.ttsBaseUrl : '')
  const fileTtsBaseUrl = normalizeBaseUrl(keyFile.baseUrl ?? '')
  const envTtsBaseUrl = normalizeBaseUrl(typeof env[TTS_BASE_URL_ENV] === 'string' ? env[TTS_BASE_URL_ENV] : '')
  const ttsBaseUrl = resolveTtsBaseUrl(
    storedTtsBaseUrl !== '' ? storedTtsBaseUrl : fileTtsBaseUrl !== '' ? fileTtsBaseUrl : envTtsBaseUrl,
    env,
  )
  const ttsKey = await resolveTtsKey({ env, credentials, homeDir })
  const ttsVoice = typeof stored.ttsVoice === 'string' && stored.ttsVoice.trim() !== ''
    ? stored.ttsVoice.trim()
    : keyFile.voice ?? DEFAULT_TTS_VOICE
  const storedFormat = typeof stored.ttsFormat === 'string' ? stored.ttsFormat.trim().toLowerCase() : ''
  const ttsFormat = TTS_FORMATS.has(storedFormat)
    ? storedFormat
    : TTS_FORMATS.has(keyFile.format ?? '') ? keyFile.format : DEFAULT_TTS_FORMAT

  return {
    baseUrl,
    baseUrlSource: storedBaseUrl !== '' ? KEY_SOURCES.settings : envBaseUrl !== '' ? KEY_SOURCES.env : 'default',
    model,
    language,
    hasApiKey: key.value !== '',
    keySource: key.source,
    apiKeyEnv: API_KEY_ENV,
    baseUrlEnv: BASE_URL_ENV,
    // Transcription without an endpoint is a stated refusal, not a silent
    // attempt at a host nobody named.
    endpointConfigured: baseUrl !== '',
    // Read-aloud: the browser's own speech synthesis stays as the fallback
    // (the dock's toggle, off by default) and is what plays when the speech
    // backend refuses. Everything below it configures the real channel.
    tts: {
      integrated: true,
      fallback: 'browser-speech-synthesis',
      fallbackDefaultOn: false,
      needsOwnKey: true,
      baseUrl: ttsBaseUrl,
      baseUrlSource: storedTtsBaseUrl !== '' || fileTtsBaseUrl !== ''
        ? KEY_SOURCES.settings
        : envTtsBaseUrl !== '' ? KEY_SOURCES.env : 'default',
      baseUrlEnv: TTS_BASE_URL_ENV,
      model: DEFAULT_TTS_MODEL,
      voice: ttsVoice,
      format: ttsFormat,
      formats: [...TTS_FORMATS.keys()],
      hasApiKey: ttsKey.value !== '',
      keySource: ttsKey.source,
      apiKeyEnv: TTS_API_KEY_ENV,
    },
  }
}

/**
 * Apply one patch from the settings form.
 *
 * Validation happens before any write, so a rejected field leaves the file
 * exactly as it was. The key is the only secret: with the Host seam present it
 * goes to the seam's managed store; otherwise it goes to the 0600 plugin file.
 * An empty `apiKey` clears it in both backends.
 *
 * @returns `{ settings, cleared }` — the new key-free description.
 */
export async function applySettings(patch, { env = process.env, credentials, homeDir = storeRoot() } = {}) {
  const problems = []
  if (patch.baseUrl !== undefined) {
    const problem = baseUrlProblem(patch.baseUrl)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.baseUrl, problem])
  }
  if (patch.model !== undefined) {
    const problem = modelProblem(patch.model)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.model, problem])
  }
  if (patch.language !== undefined) {
    const problem = languageProblem(patch.language)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.language, problem])
  }
  if (patch.apiKey !== undefined) {
    const problem = apiKeyProblem(patch.apiKey)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.apiKey, problem])
  }
  if (patch.ttsBaseUrl !== undefined) {
    const problem = baseUrlProblem(patch.ttsBaseUrl)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.ttsBaseUrl, problem])
  }
  if (patch.ttsVoice !== undefined) {
    const problem = voiceProblem(patch.ttsVoice)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.ttsVoice, problem])
  }
  if (patch.ttsFormat !== undefined) {
    const problem = formatProblem(patch.ttsFormat)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.ttsFormat, problem])
  }
  if (patch.ttsApiKey !== undefined) {
    const problem = apiKeyProblem(patch.ttsApiKey)
    if (problem !== undefined) problems.push([SETTINGS_ERRORS.ttsApiKey, problem])
  }
  if (problems.length > 0) return { problems }

  const stored = await readStoredSettings(homeDir)
  // The state before the write, measured the same way the form reads it: this
  // is what the rollback below restores, and what decides whether the save is
  // allowed to disable a working channel at all.
  const before = await describeVoice({ env, credentials, homeDir })
  const next = { ...stored }
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl)
  if (patch.model !== undefined) next.model = String(patch.model).trim()
  if (patch.language !== undefined) next.language = String(patch.language).trim()
  if (patch.ttsBaseUrl !== undefined) next.ttsBaseUrl = normalizeBaseUrl(patch.ttsBaseUrl)
  if (patch.ttsVoice !== undefined) next.ttsVoice = String(patch.ttsVoice).trim()
  if (patch.ttsFormat !== undefined) next.ttsFormat = String(patch.ttsFormat).trim().toLowerCase()

  // Two secrets, one routine: each may live in the Host seam or the 0600 file,
  // and clearing one never disturbs the other.
  const cleared = await storeSecret({
    field: 'apiKey',
    ref: KEY_REF,
    value: patch.apiKey,
    credentials,
    next,
  }) || await storeSecret({
    field: 'ttsApiKey',
    ref: TTS_KEY_REF,
    value: patch.ttsApiKey,
    credentials,
    next,
  })

  await writeStoredSettings(next, homeDir)
  // Read the settings back and refuse a save that leaves the channel
  // HALF-configured: no endpoint, but a key still stored and nowhere to send
  // it. That is the exact shape of the reported bug — a form that sent an
  // untouched Base URL as empty turned a working transcriber into a 503.
  //
  // A full reset is not this: a patch that clears the key too is a stated
  // intention, and so is a patch that leaves no key behind at all. Turning a
  // channel ON is always allowed; only the accidental half-state rolls back.
  const after = await describeVoice({ env, credentials, homeDir })
  const leftNoKey = patch.apiKey === '' || after.hasApiKey === false
  const halfConfigured = before.endpointConfigured === true
    && after.endpointConfigured === false
    && leftNoKey !== true
  const broke = []
  if (halfConfigured) broke.push(SETTINGS_ERRORS.baseUrl)
  if (before.tts?.hasApiKey === true && after.tts?.hasApiKey === false && patch.ttsApiKey === undefined) broke.push(SETTINGS_ERRORS.ttsApiKey)
  if (broke.length > 0) {
    // Roll back every field this call could have written, then the secrets it
    // cleared. A rollback that itself fails leaves the refusal standing: the
    // caller must never read "saved" for a save that broke the channel.
    await writeStoredSettings(stored, homeDir).catch(() => undefined)
    if (patch.apiKey !== undefined) {
      await storeSecret({ field: 'apiKey', ref: KEY_REF, value: before.hasApiKey === true ? patch.apiKey : '', credentials, next: stored }).catch(() => undefined)
    }
    if (patch.ttsApiKey !== undefined) {
      await storeSecret({ field: 'ttsApiKey', ref: TTS_KEY_REF, value: before.tts?.hasApiKey === true ? patch.ttsApiKey : '', credentials, next: stored }).catch(() => undefined)
    }
    return {
      problems: [[broke[0], 'this save would leave a working channel unconfigured, so it was rolled back']],
      rolledBack: true,
      settings: await describeVoice({ env, credentials, homeDir }),
    }
  }
  return { settings: after, cleared }
}

/**
 * Store or clear one secret, in the Host seam when it is writable, otherwise in
 * the plugin file.
 *
 * @returns true when the value was cleared.
 */
async function storeSecret({ field, ref, value, credentials, next }) {
  if (value === undefined) return false
  const key = String(value)
  let seamWrote = false
  if (hasCredentialSeam(credentials)) {
    try {
      if (key === '') {
        await credentials.unset(ref)
      } else {
        await credentials.set(ref, key)
      }
      seamWrote = true
    } catch {
      // Falling back keeps the form usable on a read-only store; the caller
      // still learns the key is stored, just not where it expected.
      seamWrote = false
    }
  }
  // The seam owns the key when it took it: never keep a second copy in the file.
  if (seamWrote || key === '') {
    delete next[field]
    return key === ''
  }
  next[field] = key.trim()
  return false
}

/**
 * One lightweight upstream probe: `GET {baseUrl}/models`.
 *
 * This is deliberately a metadata call, not an empty-audio transcription: a
 * transcription probe would bill a request and can legitimately fail on a
 * container the backend dislikes, which would report "bad key" for a working
 * key. A `/models` refusal is unambiguous about authentication.
 *
 * The key is used and then dropped. It is never logged, never returned, and
 * never included in the failure message.
 */
export async function testConnection(input = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? TEST_TIMEOUT_MS
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? '') || DEFAULT_BASE_URL
  const key = typeof input.apiKey === 'string' && input.apiKey !== ''
    ? input.apiKey
    : (await resolveKey(deps)).value
  if (key === '') {
    return {
      ok: false,
      code: 'voice/missing-key',
      baseUrl,
      message: `no API key is configured: save one in the settings form or set ${API_KEY_ENV}`,
    }
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort(new Error('probe deadline')) }, timeoutMs)
  const started = Date.now()
  let response
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: deadline.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const timedOut = deadline.signal.aborted
    return {
      ok: false,
      code: timedOut ? 'voice/backend-timeout' : 'voice/backend-unreachable',
      baseUrl,
      ms: Date.now() - started,
      message: timedOut
        ? `no answer from ${baseUrl} within ${timeoutMs} ms`
        : `could not reach ${baseUrl}: ${String(error?.message ?? error).slice(0, 200)}`,
    }
  } finally {
    clearTimeout(timer)
  }
  const body = await response.text().catch(() => '')
  if (response.ok) {
    let models = []
    try {
      const parsed = JSON.parse(body)
      models = Array.isArray(parsed?.data) ? parsed.data.map((row) => row?.id).filter((id) => typeof id === 'string') : []
    } catch {
      // A non-JSON 200 still proves reachability and authentication.
    }
    return {
      ok: true,
      code: 'voice/test-ok',
      baseUrl,
      status: response.status,
      ms: Date.now() - started,
      models: models.slice(0, 20),
      message: `reachable and authenticated (HTTP ${response.status}${models.length > 0 ? `, ${models.length} models` : ''})`,
    }
  }
  const code = response.status === 401 || response.status === 403
    ? 'voice/invalid-key'
    : response.status === 404
      ? 'voice/endpoint-not-found'
      : 'voice/upstream-error'
  return {
    ok: false,
    code,
    baseUrl,
    status: response.status,
    ms: Date.now() - started,
    message: code === 'voice/invalid-key'
      ? `the backend rejected the key (HTTP ${response.status})`
      : code === 'voice/endpoint-not-found'
        ? `${baseUrl}/models answered HTTP 404 — the base URL may be missing or have an extra path segment`
        : `${baseUrl}/models answered HTTP ${response.status}`,
  }
}

/**
 * The settings routes.
 *
 *   GET  {VOICE_SETTINGS_ROUTE}  → the key-free description
 *   POST {VOICE_SETTINGS_ROUTE}  → validate and store; answers the description
 *   POST {VOICE_TEST_ROUTE}      → one `/models` probe; answers ok/failure text
 *
 * A POST body may carry an `apiKey` used only for that request (the "test
 * before save" path). It is never stored unless the same body also goes to the
 * settings route, and it is never echoed by either.
 */
export function voiceSettingsHandler(options = {}) {
  const deps = () => ({ env: options.env ?? process.env, credentials: options.credentials, homeDir: options.homeDir ?? storeRoot() })
  return async function handleVoiceSettingsRequest(request) {
    const { pathname } = new URL(request.url)
    const isTest = pathname.endsWith('/test')
    if (!isTest && request.method === 'GET') {
      try {
        return okJson(await describeVoice(deps()))
      } catch (error) {
        return failure(SETTINGS_ERRORS.unreadable, `could not read the voice settings: ${String(error?.message ?? error).slice(0, 200)}`, 500)
      }
    }
    if (request.method !== 'POST') {
      return failure(SETTINGS_ERRORS.method, isTest ? 'the voice test route accepts POST' : 'the voice settings route accepts GET and POST', 405, { allow: isTest ? 'POST' : 'GET, POST' })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return failure(SETTINGS_ERRORS.badJson, 'the request body must be JSON', 400)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return failure(SETTINGS_ERRORS.badJson, 'the request body must be a JSON object', 400)
    }
    if (isTest) {
      const probe = {}
      if (body.baseUrl !== undefined) {
        const problem = baseUrlProblem(body.baseUrl)
        if (problem !== undefined) return failure(SETTINGS_ERRORS.baseUrl, problem, 400)
        probe.baseUrl = body.baseUrl
      }
      if (body.apiKey !== undefined) {
        const problem = apiKeyProblem(body.apiKey)
        if (problem !== undefined) return failure(SETTINGS_ERRORS.apiKey, problem, 400)
        probe.apiKey = body.apiKey
      }
      const result = await testConnection(probe, { ...deps(), fetch: options.fetch, timeoutMs: options.timeoutMs })
      options.logger?.warn?.(`discipline-whale voice: connection test ${result.ok ? 'ok' : result.code}`)
      // A key that was typed into the probe is used and dropped here.
      return okJson(result, result.ok ? 200 : 200)
    }
    const patch = {}
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) patch[field] = body[field]
    }
    if (Object.keys(patch).length === 0) {
      return okJson(await describeVoice(deps()))
    }
    let applied
    try {
      applied = await applySettings(patch, deps())
    } catch (error) {
      return failure(SETTINGS_ERRORS.unreadable, `could not write the voice settings: ${String(error?.message ?? error).slice(0, 200)}`, 500)
    }
    if (applied.problems !== undefined) {
      const [code, message] = applied.problems[0]
      return failure(code, message, 400)
    }
    return okJson(applied.settings)
  }
}

/** Register the settings routes on the Host's connection fetch registry. */
export function registerVoiceSettingsRoutes(connection, options = {}) {
  const handler = voiceSettingsHandler(options)
  return Promise.all([
    connection.fetch.register({ path: VOICE_SETTINGS_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }),
    connection.fetch.register({ path: VOICE_TEST_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: handler }),
  ])
}
