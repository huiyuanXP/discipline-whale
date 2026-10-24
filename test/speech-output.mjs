/**
 * Read-aloud behaviour: stopping, and reading only the newest reply.
 *
 * Two rules the person asked for, both proven here without a browser:
 *
 *   1. Hanging up must actually silence the audio. The backend player is an
 *      `Audio` element; `speechSynthesis.cancel()` does not touch it. These
 *      checks drive a fake element and assert `pause()` + cleared `src` +
 *      `load()` + released blob URL, plus the aborted in-flight request.
 *   2. Read only the newest message. The queue is a single slot: a burst of
 *      three replies is read once, as the last one, and an interruption is not
 *      made up for later.
 *
 * Run: node test/speech-output.mjs
 */

import assert from 'node:assert/strict'

// --- load the browser half ------------------------------------------------

let definition
globalThis.window = {
  __ModuleLoader__: {
    load: (next) => {
      definition = next
    },
  },
}
await import('../client.js')
const React = {
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
const client = definition.factory(() => React)
delete globalThis.window

// --- fixtures -------------------------------------------------------------

/** A fake media element, recording everything a stop must do to it. */
function fakeAudio() {
  const calls = []
  const element = {
    src: 'blob:fake',
    currentTime: 7.5,
    onended: null,
    onerror: null,
    paused: false,
    play() {
      calls.push('play')
      this.paused = false
      // A real element fires `ended` when the audio runs out; this one does too,
      // unless the test holds the element open to test the stop path.
      if (this.autoEnd === true) setTimeout(() => this.onended?.(), 5)
      return Promise.resolve()
    },
    pause() {
      calls.push('pause')
      this.paused = true
    },
    load() {
      calls.push('load')
    },
    removeAttribute(name) {
      calls.push(`removeAttribute:${name}`)
      if (name === 'src') this.src = ''
    },
  }
  return { element, calls }
}

/** A 44-byte WAV header, enough for the player to accept bytes. */
function wavBytes() {
  const bytes = new Uint8Array(64)
  const view = new DataView(bytes.buffer)
  const text = (at, value) => {
    for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  return bytes
}

/** The `env` one read needs, with a fetch that resolves or hangs on demand. */
function backendEnv({ hold = false, playing = false } = {}) {
  const created = []
  const revoked = []
  const controllers = []
  const env = {
    Audio: function Audio(src) {
      const fake = fakeAudio()
      fake.element.src = src
      // The playing element is the state a stop has to interrupt: it never
      // ends on its own, so only `stop()` settles the read.
      fake.element.autoEnd = playing !== true
      created.push(fake)
      return fake.element
    },
    URL: {
      createObjectURL: () => 'blob:tts-1',
      revokeObjectURL: (url) => revoked.push(url),
    },
    Blob: class {
      constructor(parts) {
        this.parts = parts
      }
    },
    fetch: (_url, init) => {
      controllers.push(init?.signal)
      if (hold === true) {
        // Never resolves: the read stays in flight, like a slow paid request.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener?.('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
      }
      return Promise.resolve(new Response(wavBytes(), {
        status: 200,
        headers: { 'content-type': 'audio/wav', 'x-dw-tts-seconds': '1.2' },
      }))
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    AbortController,
  }
  return { env, created, revoked, controllers }
}

/** A fake speech engine, recording cancel calls. */
function fakeSynth() {
  const calls = []
  return {
    calls,
    speak: () => calls.push('speak'),
    cancel: () => calls.push('cancel'),
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
    getVoices: () => [],
  }
}

// --- 1. the element is really silenced ------------------------------------

{
  assert.equal(typeof client.speakViaBackend, 'function')
  const { env, created, revoked } = backendEnv()
  const player = client.speakViaBackend('结论：已派工。', env)
  assert.equal(player.ok, true, 'the backend player acknowledges the read')
  assert.equal(typeof player.stop, 'function', 'the caller can reach the element to silence it')

  const result = await player.done
  assert.equal(result.code, 'played', 'the fake element ends on its own')

  // Now the stop path, on a read that is still playing.
  const second = backendEnv({ playing: true })
  const playing = client.speakViaBackend('第二条。', second.env)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(second.created.length, 1, 'one element was created for the read')
  const element = second.created[0].element

  const before = Date.now()
  playing.stop('hangup')
  const elapsed = Date.now() - before
  assert.ok(elapsed < 300, `stop reaches the element well inside 300 ms (measured ${elapsed} ms)`)
  assert.equal(element.paused, true, 'the element is paused: this is the sound actually stopping')
  assert.equal(element.src, '', 'the source is cleared, so nothing can resume it')
  assert.ok(second.created[0].calls.includes('load'), 'load() released the decoded buffer')
  assert.deepEqual(second.revoked, ['blob:tts-1'], 'the blob URL is released, not leaked')
  const stopped = await playing.done
  assert.equal(stopped.code, 'hangup', 'the read settles as stopped rather than played')
  console.log('ok 1 — a stop pauses the <audio> element, clears its src, loads, and revokes the blob URL')
}

// --- 2. a hangup aborts the request in flight -----------------------------

{
  const held = backendEnv({ hold: true })
  const playing = client.speakViaBackend('这条还在路上。', held.env)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(held.created.length, 0, 'no element exists yet: the audio has not arrived')
  assert.equal(held.controllers.length, 1, 'one request is in flight')
  assert.equal(held.controllers[0].aborted, false)

  playing.stop('hangup')
  assert.equal(held.controllers[0].aborted, true, 'the in-flight request is aborted, so paid audio cannot start later')
  const result = await playing.done
  assert.ok(['hangup', 'aborted', 'unreachable'].includes(result.code), `the read settles (${result.code})`)
  console.log('ok 2 — a stop aborts the in-flight request, so a late audio body never starts playing')
}

// --- 3. the browser synthesizer stops too ---------------------------------

{
  assert.equal(typeof client.speakReply, 'function')
  const synth = fakeSynth()
  const speech = client.speakReply('朗读中。', {
    enabled: true,
    synth,
    Utterance: class {
      constructor(text) {
        this.text = text
      }
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  })
  assert.equal(typeof speech.stop, 'function', 'the synthesizer read is stoppable as well')
  speech.stop()
  assert.equal(synth.calls.filter((call) => call === 'cancel').length >= 2, true,
    'cancel is issued more than once: engines swallow the first call')
  await speech.done
  console.log('ok 3 — the synthesizer fallback is cancelled on a stop, with a repeated cancel for engines that drop the first')
}

// --- 4. one slot, newest wins --------------------------------------------

{
  assert.equal(typeof client.createLatestOnlySlot, 'function')
  const timers = []
  const slot = client.createLatestOnlySlot({
    coalesceMs: 300,
    setTimeout: (fn) => {
      const id = { fn }
      timers.push(id)
      return id
    },
    clearTimeout: (id) => {
      const index = timers.indexOf(id)
      if (index >= 0) timers.splice(index, 1)
    },
  })

  // A burst of three inside the merge window.
  slot.offer('第一条')
  slot.offer('第二条')
  const third = slot.offer('第三条')
  assert.equal(third.replaced, true, 'a newer reply replaces the waiting one instead of queueing behind it')
  assert.equal(slot.peek(), '第三条', 'the slot holds the newest text')
  assert.equal(slot.take(), null, 'nothing leaves the slot while the merge window is open')

  for (const timer of timers.splice(0)) timer.fn()
  const taken = slot.take()
  assert.equal(taken.text, '第三条', 'three replies are read once, as the newest one')
  assert.deepEqual(slot.counts(), { offered: 3, dropped: 2, spoken: 1 },
    'the queue depth was one the whole time: two texts were dropped, one was read')
  assert.equal(slot.take(), null, 'the slot is empty afterwards: no backlog exists')
  console.log('ok 4 — three replies in a burst are read once, as the newest; the queue depth is one')
}

// --- 5. an interruption is not made up for later --------------------------

{
  const timers = []
  const slot = client.createLatestOnlySlot({
    coalesceMs: 300,
    setTimeout: (fn) => {
      const id = { fn }
      timers.push(id)
      return id
    },
    clearTimeout: () => {},
  })
  slot.offer('被挂断的那条')
  slot.interrupt()
  assert.equal(slot.interrupted(), true, 'the slot remembers the interruption')
  assert.equal(slot.peek(), null, 'the dropped text is gone, not parked')
  for (const timer of timers.splice(0)) timer.fn()
  assert.equal(slot.take(), null, 'after an interruption nothing old is read: no automatic catch-up')

  // Only a genuinely new reply resumes reading.
  slot.offer('新的一条')
  assert.equal(slot.interrupted(), false, 'a new reply clears the interruption')
  for (const timer of timers.splice(0)) timer.fn()
  assert.equal(slot.take().text, '新的一条')
  console.log('ok 5 — after an interruption nothing old replays; only a new reply resumes reading')
}

console.log('\nspeech-output: all checks passed')

// --- 6. the panel offers "stop reading" only while it is reading ----------

{
  const t = (key) => client.DICTIONARIES.zh[key] ?? key
  let stopped = 0
  const actions = {
    hangUp: () => {},
    toggleMic: () => {},
    toggleMute: () => {},
    openSettings: () => {},
    detach: () => {},
    stopTalking: () => {},
    stopReading: () => { stopped += 1 },
    toggleSpeak: () => {},
  }
  const view = (status) => client.dockView({
    t,
    status,
    error: null,
    notice: null,
    heard: '',
    reply: '鲸鱼回复文本',
    busy: false,
    sending: 0,
    whaleBusy: false,
    controls: { device: true, muted: false, processing: false, muteEnabled: true },
    detached: false,
    utteranceCount: 0,
    detach: { available: false },
    speak: true,
    actions,
  })
  const walk = (node, out = []) => {
    if (node === null || node === undefined) return out
    if (typeof node === 'object') {
      if (node.props?.['data-dw-stop-voice'] !== undefined) out.push(node)
      for (const child of (node.children ?? [])) walk(child, out)
    }
    return out
  }
  const whileSpeaking = walk(view('speaking'))
  assert.equal(whileSpeaking.length, 1, 'the panel offers exactly one stop-reading action while it reads')
  // Its presence is honest: nothing is read, nothing to stop.
  assert.equal(walk(view('ready')).length, 0, 'no stop button when nothing is being read')
  const button = whileSpeaking[0]
  assert.equal(button.props['aria-label'], t('stopReading'), 'it is named for a screen reader')
  assert.equal(typeof button.props.onClick, 'function')
  button.props.onClick()
  assert.equal(stopped, 1, 'clicking it calls the one stop implementation')
  console.log('ok 6 — "stop reading" is offered exactly while a reply is being read, and it calls the real stop')
}

console.log('\nspeech-output: all checks passed (extended)')
