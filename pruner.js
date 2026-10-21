/**
 * discipline-whale — clearing tool-result pruner for the compaction group.
 *
 * `dsh-compaction-basic` asks the `toolResultPruner` service to shrink tool
 * output before it pays for a summary. This row provides that service with a
 * two-zone policy, in the order Claude Code compacts:
 *
 *   recent  tool results of the last `keepRecentTurns` DSH turns (one user
 *           input with all its steps; the in-progress turn always counts) keep
 *           the Host's head / marker / tail truncation when they exceed
 *           `thresholdChars`
 *   older   every tool result of an earlier turn becomes one placeholder line
 *           naming the tool and the original size; the full text stays in the
 *           session log
 *
 * Every rewrite uses the Host pruner's durable shape: a `compaction/prune`
 * shadow-price event, then a replacement `tool/result` that changes only
 * `message.content`, replaces exactly the one surface node, and cites it in
 * `sourceEventSeqs`. A second pass over the same surface makes no replacement.
 *
 * The package installs without dependencies, so the service is written out
 * here and registered through `ctx.reflect.provide`, which is what cordis
 * `Service` does in its constructor.
 *
 * @module discipline-whale/pruner
 */

/** Service name `dsh-compaction-basic` reads through `ctx.get`. */
export const SERVICE_NAME = 'toolResultPruner'

/** Marker substituted for the removed middle of a trimmed result (the Host's exact text). */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** Defaults: keep three DSH turns of output, trim inside that window like the Host. */
export const DEFAULTS = Object.freeze({
  keepRecentTurns: 3,
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS = Object.keys(DEFAULTS)

/** Recognizes a placeholder this pruner wrote, so a cleared result is left alone. */
const CLEARED_LINE = /^\[工具输出已清理 · .+ · [\d,]+ 字符 · 原文在 session log\]$/

/** Count Unicode code points, the unit every budget here is written in. */
export function codePointLength(text) {
  return Array.from(text).length
}

/** Freeze a value and everything reachable from it. */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Detached immutable message, the same treatment as `freezeMessage` in `dsh-llm`. */
function freezeMessage(message) {
  return deepFreeze(structuredClone(message))
}

/**
 * Resolve and validate the row config.
 *
 * @param config - raw row config; missing keys take {@link DEFAULTS}.
 * @returns a frozen `{ keepRecentTurns, thresholdChars, headChars, tailChars }`.
 * @throws on an unknown key, a non-integer budget, `keepRecentTurns` below 1
 *   (the in-progress turn is always kept), or head + marker + tail larger than
 *   `thresholdChars`.
 */
export function resolveConfig(config = {}) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('ClearingToolResultPruner: config must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(`ClearingToolResultPruner: unknown key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`)
    }
  }
  const resolved = {}
  for (const key of CONFIG_KEYS) resolved[key] = config[key] ?? DEFAULTS[key]
  for (const key of CONFIG_KEYS) {
    const value = resolved[key]
    const minimum = key === 'thresholdChars' || key === 'keepRecentTurns' ? 1 : 0
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`ClearingToolResultPruner: ${key} (${value}) must be an integer >= ${minimum}`)
    }
  }
  const emitted = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars
  if (emitted > resolved.thresholdChars) {
    throw new Error(
      `ClearingToolResultPruner: headChars + marker + tailChars (${emitted}) must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  return Object.freeze(resolved)
}

/**
 * The one line a cleared tool result becomes.
 *
 * @param toolName - the tool that produced the result.
 * @param chars - original text size in code points.
 */
export function clearedPlaceholder(toolName, chars) {
  return `[工具输出已清理 · ${toolName} · ${chars.toLocaleString('en-US')} 字符 · 原文在 session log]`
}

/** Whether content is exactly one placeholder line written by this pruner. */
export function isClearedContent(blocks) {
  return blocks.length === 1 && blocks[0].type === 'text' && CLEARED_LINE.test(blocks[0].text)
}

/** Clearing / trimming `toolResultPruner` service. */
export class ClearingToolResultPruner {
  /** Services this pruner reads from its context. */
  static inject = ['tokenMeter']

  /**
   * @param ctx - context that supplies `tokenMeter`.
   * @param config - row config, resolved through {@link resolveConfig}.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.name = SERVICE_NAME
    this.config = resolveConfig(config)
  }

  /** Text size of content in code points; non-text blocks count zero. */
  measureContent(blocks) {
    let chars = 0
    for (const block of blocks) if (block.type === 'text') chars += codePointLength(block.text)
    return chars
  }

  /**
   * Host-identical head / marker / tail truncation that keeps rich-block order.
   *
   * @param blocks - tool-result content.
   * @returns trimmed content, or `null` when the text is within `thresholdChars`.
   */
  pruneContent(blocks) {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null
    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned = []
    let consumed = 0
    let markerInserted = false
    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }
      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : ''
      if (marker !== '') markerInserted = true
      const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    return pruned
  }

  /**
   * Text size of the first tool result in a replacement chain.
   *
   * A replacement cites the node it shadowed in `sourceEventSeqs`; following
   * those links reaches the result the tool actually returned, so a trimmed
   * result that later ages out is still reported at its original size.
   */
  originalChars(session, event) {
    let current = event
    const seen = new Set()
    while (Array.isArray(current.sourceEventSeqs) && current.sourceEventSeqs.length === 1) {
      const seq = current.sourceEventSeqs[0]
      if (seen.has(seq)) break
      seen.add(seq)
      const source = session.eventAt(seq)
      if (source?.type !== 'tool/result') break
      current = source
    }
    return this.measureContent(current.data.message.content)
  }

  /**
   * The DSH turn number currently open in the log, or `undefined`.
   *
   * Scans back from the log tail to the latest `turn/start` and returns its
   * `turn` unless a `turn/end` for it came after. The scan covers only the
   * events of the latest turn.
   */
  openTurn(session) {
    for (let seq = (session.seq ?? 0) - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event?.type === 'turn/end') return undefined
      if (event?.type === 'turn/start') return event.data.turn
    }
    return undefined
  }

  /**
   * The DSH turns whose tool results form the recent window.
   *
   * Turns are taken from the `turn` field of surface events in surface order;
   * the open turn is added last when it is not on the surface yet. The last
   * `keepRecentTurns` distinct turns are the window.
   */
  recentTurns(session, nodes) {
    const order = []
    for (const { event } of nodes) {
      const turn = event?.data?.turn
      if (Number.isInteger(turn) && !order.includes(turn)) order.push(turn)
    }
    const open = this.openTurn(session)
    if (open !== undefined && !order.includes(open)) order.push(open)
    return new Set(order.slice(-this.config.keepRecentTurns))
  }

  /**
   * Clear or trim every tool result on one stable current-surface snapshot.
   *
   * A turn is one DSH turn: a user input with all of its steps, identified by
   * the `turn` field of its events. Tool results of the last `keepRecentTurns`
   * turns on the surface (the in-progress turn always among them) are the
   * recent window and are trimmed only when over `thresholdChars`; every tool
   * result of an earlier turn is cleared to one placeholder line, dropping its
   * image blocks. A result is left as it is when it already is a placeholder,
   * or when the placeholder would not be smaller than its text and it has no
   * non-text blocks.
   *
   * @param session - session whose current surface is rewritten.
   * @returns `{ pruned, charsRemoved }`; each item is `{ originalSeq,
   *   replacementSeq, callId, charsBefore, charsAfter, mode }` with `mode`
   *   `'cleared'` or `'trimmed'`.
   * @throws when the session rejects a replacement; earlier replacements in the
   *   pass stay durable.
   */
  pruneSession(session) {
    const nodes = [...session.surface.nodes].map((seq) => ({ seq, event: session.eventAt(seq) }))

    const toolNames = new Map()
    for (const { event } of nodes) {
      if (event?.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') toolNames.set(block.id, block.name)
      }
    }
    const recent = this.recentTurns(session, nodes)

    const pruned = []
    let charsRemoved = 0
    for (const { seq, event } of nodes) {
      if (event?.type !== 'tool/result') continue
      const original = session.deriveEventMessage(event)
      const callId = event.data.message.source.callId
      const charsBefore = this.measureContent(original.content)

      let content
      let mode
      if (recent.has(event.data.turn)) {
        content = this.pruneContent(original.content)
        mode = 'trimmed'
      } else if (!isClearedContent(original.content)) {
        const toolName = toolNames.get(callId) ?? 'tool'
        const text = clearedPlaceholder(toolName, this.originalChars(session, event))
        const hasRich = original.content.some((block) => block.type !== 'text')
        content = hasRich || codePointLength(text) < charsBefore ? [{ type: 'text', text }] : null
        mode = 'cleared'
      }
      if (content == null) continue

      const charsAfter = this.measureContent(content)
      const message = freezeMessage({ ...original, content })
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
      })
      const replacement = session.append(
        'tool/result',
        { ...event.data, message },
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
      )
      pruned.push({ originalSeq: seq, replacementSeq: replacement.seq, callId, charsBefore, charsAfter, mode })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

/** Row name, used in logs. */
export const name = 'discipline-whale-pruner'

/** The Host services this row needs. */
export const inject = ['tokenMeter']

/**
 * Row config as a Standard Schema.
 *
 * The Loader validates a row's `config` through `Config['~standard'].validate`;
 * the validated value is the resolved config with defaults filled in.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'discipline-whale',
    validate(value) {
      try {
        return { value: { ...resolveConfig(value ?? {}) } }
      } catch (error) {
        return { issues: [{ message: error.message, path: [] }] }
      }
    },
  },
}

/**
 * Provide the `toolResultPruner` service in this row's context.
 *
 * Mounted inside the compaction group that isolates `toolResultPruner`, in
 * place of `@deepseek-ai/dsh-compaction-tool-result-pruner`; the registration
 * is released when the row unloads. Returns nothing: cordis treats an apply
 * return value as an effect.
 */
export function apply(ctx, config = {}) {
  ctx.reflect.provide(SERVICE_NAME, new ClearingToolResultPruner(ctx, config))
}
