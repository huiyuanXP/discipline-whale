#!/usr/bin/env node
/**
 * One real end-to-end speech check: text → speech backend → audio file.
 *
 * This is the only script in the repo that talks to a live speech service, and
 * it runs only when a key is present. It is not part of `npm test`: the unit
 * suite drives the same code through a stub fetch, and a paid request has no
 * place in a test run.
 *
 * The key is read from `MIMO_TOKEN_PLAN_KEY` and never printed. The output is
 * a summary — byte count, duration, the endpoint and the voice — plus the file
 * it wrote, so the audio can be played and checked by ear.
 *
 *   MIMO_TOKEN_PLAN_KEY=... node scripts/tts-e2e.mjs
 *   MIMO_TOKEN_PLAN_KEY=... node scripts/tts-e2e.mjs --text "别的句子" --format mp3
 *
 * Exit codes: 0 spoken, 2 no key configured (nothing was attempted), 1 failed.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_TTS_BASE_URL,
  DEFAULT_TTS_MODEL,
  TTS_API_KEY_ENV,
  TTS_BASE_URL_ENV,
  synthesize,
} from '../mimo-tts.js'
import { describeVoice, resolveTtsKey } from '../voice-settings.js'

/** Read one `--flag value` pair, or undefined. */
function argOf(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index + 1 >= process.argv.length) return undefined
  return process.argv[index + 1]
}

// The key and the endpoint come from the SAME resolution the plugin uses, so
// this script proves the real configuration path rather than a parallel one:
// the hand-written key file, then the environment. Nothing is printed.
const config = await describeVoice({ env: process.env })
const resolved = await resolveTtsKey({ env: process.env })
if (resolved.value === '') {
  console.log(`skip: no speech key found (${TTS_API_KEY_ENV}, or apiKey in the speech key file), so no request was made`)
  process.exit(2)
}
if (config.tts?.hasApiKey !== true) {
  console.error('internal mismatch: the description says no key but the resolver found one')
  process.exit(1)
}

const key = resolved.value
const baseUrl = config.tts?.baseUrl || process.env[TTS_BASE_URL_ENV] || DEFAULT_TTS_BASE_URL
const text = argOf('text') ?? '你好，我是自律鲸鱼。这是语音合成的一次端到端检查。'
const format = argOf('format') ?? config.tts?.format ?? 'wav'
const voice = argOf('voice') ?? config.tts?.voice

const started = Date.now()
try {
  const speech = await synthesize(text, { apiKey: key, baseUrl, format, voice })
  const elapsed = Date.now() - started
  const out = join('/tmp', `discipline-whale-tts.${speech.extension}`)
  writeFileSync(out, speech.bytes)
  const summary = {
    keySource: resolved.source,
    endpoint: `${baseUrl}/chat/completions`,
    model: speech.model,
    voice: speech.voice,
    format: speech.format,
    mime: speech.mime,
    bytes: speech.bytes.byteLength,
    seconds: speech.seconds ?? null,
    textChars: text.length,
    requestMs: elapsed,
    file: out,
  }
  console.log(JSON.stringify(summary, null, 2))
  // A last guard: nothing in the summary may contain the key.
  if (JSON.stringify(summary).includes(key)) {
    console.error('refusing to continue: the summary would have contained the key')
    process.exit(1)
  }
} catch (error) {
  // The message names the failure, never the key: `synthesize` guarantees that.
  console.error(`failed: ${error?.code ?? 'unknown'} ${error?.message ?? error}`)
  if (JSON.stringify(error?.details ?? {}).includes(key)) {
    console.error('refusing to print details that contain the key')
  } else if (error?.details !== undefined && Object.keys(error.details).length > 0) {
    console.error(`details: ${JSON.stringify(error.details)}`)
  }
  process.exit(1)
}
