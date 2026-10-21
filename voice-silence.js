/**
 * discipline-whale — the voice call's two browser-side rules, kept as plain
 * data logic so they can be tested without a microphone.
 *
 * `createSilenceDetector` is the end-of-utterance decision: it measures the
 * room's noise floor during a short calibration window, then declares the
 * utterance over once the signal has stayed under `floor + margin` for the
 * full silence window. It also enforces the minimum useful speech, the minimum
 * recording length and the maximum recording length.
 *
 * `createCallGuard` is the late-result rule: a transcript may only be delivered
 * while the call that produced it is still current and still pointed at the
 * same session. Hanging up or switching sessions invalidates it.
 *
 * Both are pure and synchronous: the browser half feeds them frames, it does
 * not decide anything itself.
 *
 * @module discipline-whale/voice-silence
 */

/** How long the signal must stay quiet before the utterance is over. */
export const SILENCE_MS = 10_000

/** Calibration window at the start of a call: the room's noise floor. */
export const CALIBRATION_MS = 500

/** How much louder than the measured floor speech has to be. */
export const NOISE_MARGIN = 0.02

/** Absolute floor, so a digitally silent room cannot make the threshold zero. */
export const MIN_THRESHOLD = 0.012


/** Below this much total speech the recording is not worth transcribing. */
export const MIN_SPEECH_MS = 500

/** A recording shorter than this is a stray click, not an utterance. */
export const MIN_RECORDING_MS = 1_000

/** Hard cap: a call that never goes quiet is cut here. */
export const MAX_RECORDING_MS = 60_000

/** Default parameters, in one place so the 10s rule is a single edit. */
export const DEFAULT_SILENCE_OPTIONS = Object.freeze({
  silenceMs: SILENCE_MS,
  calibrationMs: CALIBRATION_MS,
  noiseMargin: NOISE_MARGIN,
  minThreshold: MIN_THRESHOLD,
  minSpeechMs: MIN_SPEECH_MS,
  minRecordingMs: MIN_RECORDING_MS,
  maxRecordingMs: MAX_RECORDING_MS,
})

/** Root mean square of one frame of samples. */
export function rmsOf(samples) {
  if (!samples || samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/**
 * Create one end-of-utterance detector.
 *
 * Design notes:
 *  - The threshold is `max(minThreshold, floor * 2 + margin)`, where `floor` is
 *    the mean frame RMS measured during calibration. A noisy room raises both
 *    the floor and the threshold, so quiet speech above the room tone still
 *    registers; a silent room falls back to the absolute floor.
 *  - Speech is counted in whole frame durations, so `speechMs` is a lower bound
 *    on how long the user actually spoke.
 *  - The detector never stops on `minRecordingMs`; only silence, the maximum
 *    duration, or an explicit `stop()` can end an utterance.
 * @param options overrides for the named constants.
 * @returns a detector with `push`, `threshold`, `elapsedMs`, `canStop` and `stop`.
 */
export function createSilenceDetector(options = {}) {
  const config = { ...DEFAULT_SILENCE_OPTIONS, ...options }
  let elapsedMs = 0
  let calibrationFrames = 0
  let calibrationSum = 0
  let calibrated = false
  let floor = 0
  let threshold = config.minThreshold
  let silenceMs = 0
  let speechMs = 0

  function calibrate(frameMs) {
    floor = calibrationSum / Math.max(1, calibrationFrames)
    // Relative, not capped: a loud room is loud, and speech must clear it.
    // Capping the threshold would make the room tone itself read as speech.
    threshold = Math.max(config.minThreshold, floor * 2 + config.noiseMargin)
    calibrated = true
    void frameMs
  }

  function decide(reason) {
    const upload = reason === 'max-duration'
      ? speechMs >= config.minSpeechMs
      : speechMs >= config.minSpeechMs
    return {
      action: 'stop',
      reason: upload ? reason : 'no-speech',
      upload,
      speechMs,
      elapsedMs,
      threshold,
    }
  }

  return {
    /**
     * Feed one analysis frame.
     * @param samples mono float samples of this frame.
     * @param frameMs the frame's duration in milliseconds.
     * @returns a terminal decision, or undefined while the utterance continues.
     */
    push(samples, frameMs = (samples?.length ?? 0) * (1000 / 16000)) {
      const duration = Math.max(0, Number(frameMs) || 0)
      const level = rmsOf(samples)
      if (!calibrated) {
        calibrationFrames += 1
        calibrationSum += level
        elapsedMs += duration
        if (elapsedMs >= config.calibrationMs) calibrate(duration)
        // Calibration itself counts toward the recording, never toward speech:
        // a cough during calibration is room tone, not an utterance.
        return undefined
      }
      elapsedMs += duration
      const voiced = level > threshold
      if (voiced) {
        speechMs += duration
        silenceMs = 0
      } else {
        silenceMs += duration
      }
      if (elapsedMs >= config.maxRecordingMs) return decide('max-duration')
      if (silenceMs >= config.silenceMs) {
        return decide(speechMs >= config.minSpeechMs ? 'silence' : 'no-speech')
      }
      return undefined
    },

    /** The current speech threshold (absolute floor before calibration). */
    threshold() {
      return threshold
    },

    /** The measured room floor, 0 before calibration. */
    floor() {
      return floor
    },

    /** Total recorded duration. */
    elapsedMs() {
      return elapsedMs
    },

    /** Total duration classified as speech. */
    speechMs() {
      return speechMs
    },

    /** Whether an explicit stop (the user's button) is allowed yet. */
    canStop() {
      return elapsedMs >= config.minRecordingMs
    },

    /** How long the signal has been quiet right now (0 after any speech). */
    silenceMs() {
      return silenceMs
    },

    /**
     * Stop accounting: muted frames are not the room being quiet.
     *
     * A muted stretch must not count toward `silenceMs`, or a long mute would
     * make the first frame after unmuting look like the end of a ten-second
     * pause and end the utterance instantly. `elapsedMs` and `speechMs` are
     * frozen too — the recording did not grow while nothing was processed.
     */
    pause() {
      silenceMs = 0
    },

    /**
     * Resume accounting after a mute.
     *
     * The silence run restarts from zero (there is no unbroken quiet to
     * measure), while the calibration and the speech measured so far are kept:
     * the room did not change and the user is in the same utterance.
     */
    resume() {
      silenceMs = 0
    },

    /**
     * End the utterance because the user asked to.
     * @returns the same decision shape `push` returns.
     */
    stop() {
      if (!this.canStop()) {
        return { action: 'stop', reason: 'too-short', upload: false, speechMs, elapsedMs, threshold }
      }
      return decide(speechMs >= config.minSpeechMs ? 'manual' : 'no-speech')
    },

    /** Reset to a fresh utterance, keeping the parameters. */
    reset() {
      elapsedMs = 0
      calibrationFrames = 0
      calibrationSum = 0
      calibrated = false
      floor = 0
      threshold = config.minThreshold
      silenceMs = 0
      speechMs = 0
    },
  }
}

/**
 * Create the guard that decides whether one transcript may still be delivered.
 *
 * A call is `{ id, targetSessionId, endedAt }`. A transcript is accepted only
 * when its call is the current one, has not ended, and still targets the same
 * session.
 * @returns the guard.
 */
export function createCallGuard() {
  let current = null
  let target = null

  return {
    /** Point every future delivery at one session. */
    setTarget(sessionId) {
      target = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
    },

    /** The session late results must not cross into. */
    targetSessionId() {
      return target
    },

    /**
     * Begin one call; a call already running is replaced, which makes its
     * in-flight transcript stale.
     * @param id caller-chosen call identity.
     * @returns the call handle to pass to `accepts`.
     */
    begin(id) {
      current = { id, ended: false }
      return current
    },

    /** End one call; its late transcripts are dropped from then on. */
    end(id) {
      if (current !== null && current.id === id) current.ended = true
    },

    /** Whether this call is still the live one. */
    isCurrent(call) {
      return call !== null && call !== undefined && current === call && call.ended === false
    },

    /**
     * Whether a transcript produced by `call` may be sent to `sessionId`.
     * @param call the call handle `begin` returned.
     * @param sessionId the session the caller is about to prompt.
     * @returns true only for the live call, on the current target session.
     */
    accepts(call, sessionId) {
      if (!this.isCurrent(call)) return false
      if (target === null) return false
      return sessionId === target
    },

    /** Whether any call is running. */
    isCalling() {
      return current !== null && current.ended === false
    },
  }
}
