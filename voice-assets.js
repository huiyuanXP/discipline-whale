/**
 * discipline-whale — the page's voice-activity detector, served from this
 * plugin's own routes.
 *
 * The call's turn-taking runs Silero VAD in the page through
 * `@ricky0123/vad-web`, which needs onnxruntime-web, an AudioWorklet script and
 * the model file. The page loads nothing from a CDN, so the host serves these
 * six files straight out of the installed packages, one exact route each (the
 * connection's routes match whole paths). The set is fixed: a request names a
 * key of `VOICE_ASSETS`, never a path.
 *
 *   GET /api/discipline-whale/voice/vad/<name>
 *
 * @module discipline-whale/voice-assets
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Route prefix the page loads the detector from. */
export const VOICE_ASSET_ROUTE = '/api/discipline-whale/voice/vad'

/** Every file the page loads, by the name it asks for. */
export const VOICE_ASSETS = Object.freeze({
  'ort.wasm.min.js': { pkg: 'onnxruntime-web', file: 'ort.wasm.min.js', type: 'text/javascript; charset=utf-8' },
  'ort-wasm-simd-threaded.mjs': { pkg: 'onnxruntime-web', file: 'ort-wasm-simd-threaded.mjs', type: 'text/javascript; charset=utf-8' },
  'ort-wasm-simd-threaded.wasm': { pkg: 'onnxruntime-web', file: 'ort-wasm-simd-threaded.wasm', type: 'application/wasm' },
  'bundle.min.js': { pkg: '@ricky0123/vad-web', file: 'bundle.min.js', type: 'text/javascript; charset=utf-8' },
  'vad.worklet.bundle.min.js': { pkg: '@ricky0123/vad-web', file: 'vad.worklet.bundle.min.js', type: 'text/javascript; charset=utf-8' },
  'silero_vad_v5.onnx': { pkg: '@ricky0123/vad-web', file: 'silero_vad_v5.onnx', type: 'application/octet-stream' },
})

/**
 * The `dist` directory of one installed package. Both packages keep their
 * browser files in `dist/`, where their Node entry points also resolve.
 * @param pkg package name.
 * @param resolve module resolver, injectable for tests.
 * @returns absolute directory path.
 */
export function distDirOf(pkg, resolve = createRequire(import.meta.url).resolve) {
  return dirname(resolve(pkg))
}

/**
 * The asset route handler.
 * @param options `readFile` / `distDirOf` overrides (tests) and a logger.
 * @returns a Fetch handler.
 */
export function voiceAssetHandler(options = {}) {
  const read = options.readFile ?? readFile
  const dirOf = options.distDirOf ?? distDirOf
  return async (request) => {
    if (request.method !== 'GET') {
      return new Response(null, { status: 405, headers: { allow: 'GET' } })
    }
    const name = new URL(request.url).pathname.slice(VOICE_ASSET_ROUTE.length + 1)
    if (!Object.hasOwn(VOICE_ASSETS, name)) {
      return Response.json({ error: { code: 'voice/vad-asset-unknown', message: 'no such detector file' } }, { status: 404 })
    }
    const asset = VOICE_ASSETS[name]
    let bytes
    try {
      bytes = await read(join(dirOf(asset.pkg), asset.file))
    } catch (error) {
      options.logger?.warn?.(`discipline-whale voice: detector file ${name} unavailable: ${error?.message ?? error}`)
      return Response.json({ error: { code: 'voice/vad-asset-missing', message: `${asset.pkg} is not installed with the plugin` } }, { status: 503 })
    }
    return new Response(bytes, {
      headers: {
        'content-type': asset.type,
        // The files are versioned by the installed package; a day of caching
        // keeps the 11 MB runtime from being fetched on every call.
        'cache-control': 'public, max-age=86400',
      },
    })
  }
}

/**
 * Register one exact route per detector file.
 * @param connection the Host connection.
 * @param options handler options.
 * @returns the registrations.
 */
export function registerVoiceAssetRoutes(connection, options = {}) {
  const fetch = voiceAssetHandler(options)
  return Promise.all(Object.keys(VOICE_ASSETS).map((name) => connection.fetch.register({
    path: `${VOICE_ASSET_ROUTE}/${name}`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch,
  })))
}
