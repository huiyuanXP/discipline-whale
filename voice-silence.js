/**
 * discipline-whale — the voice call's turn rules, kept as plain data and logic
 * so they can be tested without a microphone.
 *
 * When a turn starts and ends is decided by Silero VAD through
 * `@ricky0123/vad-web` (its `MicVAD`), the detector LiveKit, Pipecat and the
 * vad-web demos all build on. `TURN_OPTIONS` is the one place its parameters
 * live; the browser half mirrors them verbatim and `test/client.mjs` proves the
 * two copies match.
 *
 * `speechLevelDbfs` and `MIN_SPEECH_LEVEL_DBFS` keep distant talk out: an
 * utterance quieter than the floor was not said into this microphone.
 *
 * `createAwayGuard` pauses listening when the person seems to have walked
 * away: no accepted turn for `AWAY_IDLE_MS` of listening, or
 * `AWAY_MAX_REJECTIONS` utterances in a row refused as background sound. It
 * counts turns, not sound, because background talk is sound too.
 *
 * `createCallGuard` is the late-result rule: a transcript may only be delivered
 * while the call that produced it is still current and still pointed at the
 * same session. Hanging up or switching sessions invalidates it.
 *
 * @module discipline-whale/voice-silence
 */

/**
 * Silero VAD turn-taking parameters for `MicVAD`.
 *
 * Speech starts above `positiveSpeechThreshold` and is considered over once
 * the probability has stayed under `negativeSpeechThreshold` for
 * `redemptionMs`. `preSpeechPadMs` of audio before the start is kept so the
 * first syllable survives, and a segment with less than `minSpeechMs` of
 * speech is a misfire, never uploaded. The thresholds are Silero's own
 * (0.5 / 0.15 lower, as LiveKit uses them); `redemptionMs` sits between
 * OpenAI's 500 ms server VAD and the 2–8 s waits of semantic turn detection.
 */
export const TURN_OPTIONS = Object.freeze({
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionMs: 2_000,
  preSpeechPadMs: 500,
  minSpeechMs: 500,
})

/** The pause lengths the settings offer for "the turn is over". */
export const REDEMPTION_CHOICES_MS = Object.freeze([1_000, 2_000, 3_000, 5_000, 8_000])

/** Hard cap on one utterance: speech that never pauses is cut and sent here. */
export const MAX_SPEECH_MS = 60_000

/**
 * The level an utterance must reach to count as said to the whale, in dBFS.
 *
 * With automatic gain control off, speech near the microphone sits around
 * -35 to -15 dBFS while a conversation across the room stays well below this.
 * It is an empirical floor, deliberately low: it drops distant talk, not a
 * quiet speaker.
 */
export const MIN_SPEECH_LEVEL_DBFS = -45

/** Listening this long without an accepted turn pauses the microphone. */
export const AWAY_IDLE_MS = 120_000

/** This many utterances in a row refused as background sound pause it too. */
export const AWAY_MAX_REJECTIONS = 3

/**
 * How loud an utterance gets, in dBFS: the 90th-percentile level of its 30 ms
 * frames, so the pre-speech pad and the trailing pause do not dilute it.
 * @param samples mono samples in [-1, 1].
 * @param sampleRate samples per second.
 * @returns the level, or -Infinity for silence.
 */
export function speechLevelDbfs(samples, sampleRate = 16_000) {
  const frame = Math.max(1, Math.round(sampleRate * 0.03))
  const levels = []
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0
    for (let i = start; i < start + frame; i += 1) sum += samples[i] * samples[i]
    levels.push(Math.sqrt(sum / frame))
  }
  if (levels.length === 0) return -Infinity
  levels.sort((a, b) => a - b)
  const loud = levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.9))]
  return loud > 0 ? 20 * Math.log10(loud) : -Infinity
}

/**
 * Create the guard that notices the person has walked away.
 *
 * Only listening time counts: `resume(now)` opens a stretch of listening and
 * `suspend(now)` banks it (the whale replying, muted, microphone off), so a
 * long reply never reads as absence. `accepted(now)` and `present(now)` clear
 * the account, `rejected()` counts one utterance refused as background sound,
 * and `reset()` forgets everything. `reason(now)` names why listening should
 * pause, or answers null.
 * @param options optional `idleMs` and `maxRejections` overrides.
 * @returns the guard.
 */
export function createAwayGuard(options = {}) {
  const idleMs = options.idleMs ?? AWAY_IDLE_MS
  const maxRejections = options.maxRejections ?? AWAY_MAX_REJECTIONS
  let since = null
  let banked = 0
  let rejections = 0
  return {
    /** Listening started or continued. */
    resume(now) {
      if (since === null) since = now
    },
    /** Listening stopped for a while; the time so far is kept. */
    suspend(now) {
      if (since !== null) banked += now - since
      since = null
    },
    /** A turn reached the whale: the person is here. */
    accepted(now) {
      banked = 0
      rejections = 0
      if (since !== null) since = now
    },
    /** The person used a control: they are here. */
    present(now) {
      banked = 0
      rejections = 0
      if (since !== null) since = now
    },
    /** One utterance was refused as background sound. */
    rejected() {
      rejections += 1
    },
    /** Forget everything: a new call, or listening paused for absence. */
    reset() {
      since = null
      banked = 0
      rejections = 0
    },
    /**
     * Why listening should pause now.
     * @param now current time in ms.
     * @returns "rejections", "idle", or null.
     */
    reason(now) {
      if (rejections >= maxRejections) return 'rejections'
      const listened = banked + (since === null ? 0 : now - since)
      if (listened >= idleMs) return 'idle'
      return null
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
