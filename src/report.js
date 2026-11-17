/**
 * Pure formatting and snapshot collection for dsh-plugin-profiler.
 *
 * Everything here is read-only. The listener inventory walks the public
 * `ctx.events._hooks` records (each record carries the registering context),
 * and the tool context cost comes from `ctx.tools.schemas()`.
 */

const TOP_ROWS = 8
const NAME_WIDTH = 22
const CHARS_PER_TOKEN = 4

/** Events that every turn or every tool call must run through. */
const HOT_EVENTS = new Set([
  'agent/pre-step',
  'agent/request',
  'llm/stream',
  'tools/pre-execute',
  'tools/execute',
  'tools/post-execute',
  'tools/result',
])

/** Coerce anything to text without trusting a hostile `toString`. */
function safeText(value) {
  if (value == null) return ''
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** Estimate prompt tokens for one tool schema (~4 characters per token). */
export function estimateTokens(schema) {
  try {
    const text = JSON.stringify({
      name: schema?.name,
      description: schema?.description,
      parameters: schema?.parameters,
    })
    if (typeof text === 'string') return Math.ceil(text.length / CHARS_PER_TOKEN)
  } catch {
    // Circular, BigInt or otherwise unserializable parameters: price what we can read.
  }
  const fallback = `${safeText(schema?.name)}${safeText(schema?.description)}`
  return Math.ceil(fallback.length / CHARS_PER_TOKEN)
}

/** List one `_hooks` table as `[event, hooks]` pairs, tolerating a Map or a hostile object. */
function hookEntries(hooks) {
  try {
    if (hooks instanceof Map) return [...hooks.entries()]
    if (hooks && typeof hooks === 'object') return Object.entries(hooks)
  } catch {
    // A proxy that refuses enumeration simply yields no inventory.
  }
  return []
}

/** Group registered listeners by owning plugin, skipping internal events. */
export function collectListeners(ctx, selfName) {
  const byPlugin = new Map()
  let hooks
  try {
    hooks = ctx?.events?._hooks
  } catch {
    return byPlugin
  }
  for (const [event, list] of hookEntries(hooks)) {
    if (typeof event !== 'string' || event.startsWith('internal/')) continue
    if (!Array.isArray(list)) continue
    for (const hook of list) {
      let owner
      try {
        owner = hook?.ctx?.fiber?.name
      } catch {
        continue
      }
      if (typeof owner !== 'string' || owner.length === 0 || owner === selfName) continue
      let events = byPlugin.get(owner)
      if (!events) {
        events = new Map()
        byPlugin.set(owner, events)
      }
      events.set(event, (events.get(event) ?? 0) + 1)
    }
  }
  return byPlugin
}

/** Visible tool schemas, or an empty list when the tools service is absent. */
export function collectTools(ctx) {
  try {
    const tools = ctx.get('tools', false)
    if (!tools || typeof tools.schemas !== 'function') return []
    const schemas = tools.schemas()
    return Array.isArray(schemas) ? schemas : []
  } catch {
    return []
  }
}

/** Human-readable duration with a unit that never drops significant digits. */
export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1) return `${ms.toFixed(2)}ms`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** Double-width code points (CJK, Hangul, fullwidth forms, emoji) so tables stay aligned. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F000}-\u{1FAFF}]/u

function charWidth(ch) {
  return WIDE.test(ch) ? 2 : 1
}

function displayWidth(text) {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

function pad(text, width) {
  const value = safeText(text)
  const current = displayWidth(value)
  return current >= width ? value : value + ' '.repeat(width - current)
}

function clip(text, width) {
  const value = safeText(text)
  if (displayWidth(value) <= width) return value
  let out = ''
  let used = 0
  for (const ch of value) {
    const step = charWidth(ch)
    if (used + step > width - 1) break
    out += ch
    used += step
  }
  return `${out}…`
}

function elapsed(since, now) {
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Listener fan-out on hot events, per plugin. Higher fan-out = likelier cost. */
export function hotFanout(listeners) {
  const rows = []
  for (const [plugin, events] of listeners) {
    let hot = 0
    for (const [event, count] of events) {
      if (HOT_EVENTS.has(event)) hot += count
    }
    if (hot > 0) rows.push({ plugin, hot })
  }
  rows.sort((a, b) => b.hot - a.hot || a.plugin.localeCompare(b.plugin))
  return rows
}

/**
 * Render the audit.
 * @param state - counters maintained by the plugin.
 * @param snapshot - `{ listeners, schemas, selfName }` gathered at call time.
 * @param now - current epoch milliseconds.
 */
export function renderReport(state, snapshot, now) {
  const listeners = snapshot.listeners
  const schemas = snapshot.schemas
  const chains = [...state.chains.values()]
  const tools = [...state.tools.values()]
  const volume = [...state.dispatches.entries()]

  const measured = chains.length > 0 || tools.length > 0 || schemas.length > 0 || listeners.size > 0
  if (!measured) {
    return 'Nothing measured yet — run a turn, then call /diet again.'
  }

  const lines = []
  const fanout = hotFanout(listeners)
  const hotListeners = fanout.reduce((sum, row) => sum + row.hot, 0)
  const contextTokens = schemas.reduce((sum, schema) => sum + estimateTokens(schema), 0)
  const hotChains = chains.filter(row => HOST_EVENTS_FOR_TAX.has(row.event))
  const hotCalls = hotChains.reduce((sum, row) => sum + row.calls, 0)
  const hotMs = hotChains.reduce((sum, row) => sum + row.totalMs, 0)

  // The shareable card: three numbers and a cut list, short enough to paste.
  lines.push(`DSH plugin tax · ${elapsed(state.since, now)} observed`)
  lines.push(`  context   ${schemas.length} tool${schemas.length === 1 ? '' : 's'} ≈ ${contextTokens.toLocaleString('en-US')} tokens per request`)
  lines.push(`  hot path  ${hotCalls} call${hotCalls === 1 ? '' : 's'}, ${formatMs(hotMs)} of host work (provider and tool body excluded)`)
  lines.push(`  listeners ${listeners.size} plugin${listeners.size === 1 ? '' : 's'} · ${hotListeners} on hot events`)
  if (fanout.length > 0) {
    const cuts = fanout.slice(0, 3).map(row => `${row.plugin} (${row.hot} hot listener${row.hot === 1 ? '' : 's'})`)
    lines.push(`  cut first ${cuts.join(', ')}`)
    lines.push('  fan-out is a suspicion, not a measurement: rc.7 cannot time another plugin\'s callback')
  }

  if (chains.length > 0) {
    lines.push('')
    lines.push('Hot chains (wall time of every listener after this one, builtins included)')
    lines.push(`${pad('event', NAME_WIDTH)}${pad('calls', 7)}${pad('total', 10)}${pad('avg', 10)}max`)
    chains.sort((a, b) => b.totalMs - a.totalMs)
    for (const row of chains.slice(0, TOP_ROWS)) {
      const avg = row.calls > 0 ? row.totalMs / row.calls : 0
      lines.push(`${pad(clip(row.event, NAME_WIDTH - 2), NAME_WIDTH)}${pad(String(row.calls), 7)}${pad(formatMs(row.totalMs), 10)}${pad(formatMs(avg), 10)}${formatMs(row.maxMs)}`)
      if (row.note) lines.push(`  ${row.note}`)
    }
    if (state.inflight.size > 0) {
      lines.push(`  (${state.inflight.size} tool call${state.inflight.size === 1 ? '' : 's'} still in flight, not counted yet)`)
    }
  }

  if (tools.length > 0) {
    lines.push('')
    lines.push('Tool calls (pre-execute → tools/result)')
    lines.push(`${pad('tool', NAME_WIDTH)}${pad('calls', 7)}${pad('total', 10)}max`)
    tools.sort((a, b) => b.totalMs - a.totalMs)
    for (const row of tools.slice(0, TOP_ROWS)) {
      lines.push(`${pad(clip(row.tool, NAME_WIDTH - 2), NAME_WIDTH)}${pad(String(row.calls), 7)}${pad(formatMs(row.totalMs), 10)}${formatMs(row.maxMs)}`)
    }
  }

  if (schemas.length > 0) {
    const priced = schemas.map(schema => ({ name: safeText(schema?.name) || '?', tokens: estimateTokens(schema) }))
    priced.sort((a, b) => b.tokens - a.tokens)
    const total = priced.reduce((sum, row) => sum + row.tokens, 0)
    lines.push('')
    lines.push('Context tax, per tool definition')
    lines.push(`${schemas.length} tool${schemas.length === 1 ? '' : 's'} ≈ ${total.toLocaleString('en-US')} tokens; heaviest: ${priced.slice(0, 3).map(row => `${row.name} ≈ ${row.tokens}`).join(', ')}`)
    lines.push('  Owner is not exposed by rc.7, so this is per tool, not per plugin.')
  }

  if (listeners.size > 0) {
    lines.push('')
    lines.push('Listeners per plugin (snapshot)')
    const rows = [...listeners.entries()].map(([plugin, events]) => ({
      plugin,
      total: [...events.values()].reduce((sum, count) => sum + count, 0),
      text: [...events.entries()].sort((a, b) => b[1] - a[1]).map(([event, count]) => `${event} ×${count}`).join(', '),
    }))
    rows.sort((a, b) => b.total - a.total)
    for (const row of rows.slice(0, TOP_ROWS)) {
      lines.push(`${pad(clip(row.plugin, NAME_WIDTH - 2), NAME_WIDTH)}${clip(row.text, 96)}`)
    }
    if (rows.length > TOP_ROWS) lines.push(`  … ${rows.length - TOP_ROWS} more plugin(s)`)
  }

  if (volume.length > 0) {
    lines.push('')
    lines.push('Event volume (top dispatches, all modes)')
    volume.sort((a, b) => b[1] - a[1])
    lines.push(volume.slice(0, 5).map(([event, count]) => `${event} ×${count}`).join(' · '))
  }

  return lines.join('\n')
}

/** Chains that do not include provider or tool-body time, used for the tax line. */
const HOST_EVENTS_FOR_TAX = new Set([
  'agent/pre-step',
  'agent/request',
  'tools/pre-execute',
])
