/**
 * discipline-whale — the texts the plugin pushes into the main session.
 *
 * Reports, escalations, the startup check, the wake turn and the rotation seed
 * all reach the main session as `user/message` entries, most of them through
 * `sessionController.prompt` with `source.kind === 'user'`. The Session log
 * cannot tell them from what the user typed, so their opening words are the
 * one durable handle. Each prefix is defined here once: the code that builds a
 * push and the code that recognizes one read the same constant, so the two can
 * never drift apart.
 *
 * @module discipline-whale/pushes
 */

/** The opening words of every text the plugin pushes into the main session. */
export const PUSH_PREFIXES = Object.freeze({
  report: '[Discipline Whale] Worker report — ',
  failed: '[Discipline Whale] Worker failed to report — ',
  startup: '【启动检查】',
  wake: '【唤醒】',
  rotation: '【续接】',
})

/**
 * Concatenated text blocks of a message.
 *
 * Takes a message (`{ content }`) or a `user/message` event's `data`, whose
 * content is an array of blocks or, from some callers, a plain string.
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** True when the text opens with one of the plugin's push prefixes. */
export function isWhalePushText(text) {
  if (typeof text !== 'string') return false
  return Object.values(PUSH_PREFIXES).some((prefix) => text.startsWith(prefix))
}

/**
 * True for a message the human typed: `source.kind === 'user'` and not a push.
 *
 * Works on an inbox message and on a `user/message` event's `data` alike.
 */
export function isHumanMessage(message) {
  return message?.source?.kind === 'user' && !isWhalePushText(messageText(message))
}
