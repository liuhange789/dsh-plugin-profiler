/**
 * dsh-plugin-profiler — a plugin load audit for DeepSeek Harness.
 *
 * It reads what rc.7 exposes without patching another plugin:
 *  - dispatch volume per event          (`internal/dispatch`)
 *  - wall time of the remaining chain  (prepended waterfall listener)
 *  - tool wall time per tool           (`tools/pre-execute` → `tools/result`)
 *  - context cost of visible tools     (`ctx.tools.schemas()`)
 *  - listener inventory per plugin     (read-only snapshot of `ctx.events._hooks`)
 *
 * It does NOT split one chain into per-plugin milliseconds. rc.7 hands
 * listeners to `internal/listener` only to allow or refuse registration, and
 * has no post-dispatch hook, so no plugin can time another plugin's callback.
 * See README "What this cannot measure".
 */

import {
  collectListeners,
  collectTools,
  renderReport,
} from './report.js'

export const name = 'plugin-profiler'

/** Waterfall events whose remaining chain is timed around `next()`. */
const TIMED_CHAINS = [
  ['agent/pre-step', 'before each step'],
  ['agent/request', 'request assembly'],
  ['llm/stream', 'stream interception only, not consumption'],
]

const MAX_INFLIGHT = 500

function newState() {
  return {
    since: Date.now(),
    chains: new Map(),
    dispatches: new Map(),
    tools: new Map(),
    inflight: new Map(),
  }
}

function optionalService(ctx, key) {
  try {
    return ctx.get(key, false)
  } catch {
    return undefined
  }
}

function recordChain(state, event, note, ms) {
  let row = state.chains.get(event)
  if (!row) {
    row = { event, note, calls: 0, totalMs: 0, maxMs: 0 }
    state.chains.set(event, row)
  }
  row.calls += 1
  row.totalMs += ms
  row.maxMs = Math.max(row.maxMs, ms)
}

function recordTool(state, tool, ms) {
  let row = state.tools.get(tool)
  if (!row) {
    row = { tool, calls: 0, totalMs: 0, maxMs: 0 }
    state.tools.set(tool, row)
  }
  row.calls += 1
  row.totalMs += ms
  row.maxMs = Math.max(row.maxMs, ms)
}

export function apply(ctx) {
  const state = newState()

  // Every non-internal dispatch, whatever its mode (emit/parallel/serial/bail/waterfall).
  ctx.on('internal/dispatch', (mode, event) => {
    if (typeof event !== 'string' || event.startsWith('internal/')) return
    state.dispatches.set(event, (state.dispatches.get(event) ?? 0) + 1)
  }, { global: true })

  // Outermost listener: time everything the rest of the chain does, `next()` included.
  // Rest arguments keep this signature-agnostic across the three events.
  for (const [event, note] of TIMED_CHAINS) {
    ctx.on(event, async (...args) => {
      const next = args.pop()
      const start = performance.now()
      try {
        return await next()
      } finally {
        recordChain(state, event, note, performance.now() - start)
      }
    }, { prepend: true, global: true })
  }

  // Pre-tool gates: time the gate chain and remember when the call started.
  ctx.on('tools/pre-execute', async (...args) => {
    const next = args.pop()
    const exec = args[0]
    const start = performance.now()
    if (exec && exec.callId != null) {
      if (state.inflight.size >= MAX_INFLIGHT) state.inflight.clear()
      state.inflight.set(String(exec.callId), {
        name: String(exec.name ?? '?'),
        start,
      })
    }
    try {
      return await next()
    } finally {
      recordChain(state, 'tools/pre-execute', 'pre-tool gates', performance.now() - start)
    }
  }, { prepend: true, global: true })

  ctx.on('tools/result', (exec) => {
    if (!exec || exec.callId == null) return
    const started = state.inflight.get(String(exec.callId))
    if (!started) return
    state.inflight.delete(String(exec.callId))
    recordTool(state, started.name, performance.now() - started.start)
  }, { global: true })

  const commands = optionalService(ctx, 'commands')
  if (commands && typeof commands.register === 'function') {
    const handler = (invocation) => {
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
      if (arg === 'reset') {
        reset(state)
        return { kind: 'success', text: 'Plugin tax counters reset.' }
      }
      if (arg !== '') return { kind: 'error', text: 'Usage: /diet [reset]' }
      return {
        kind: 'success',
        text: renderReport(state, {
          listeners: collectListeners(ctx, name),
          schemas: collectTools(ctx),
          selfName: name,
        }, Date.now()),
      }
    }
    // `/diet` is the memorable surface; `/profiler` is kept as an alias.
    commands.register({
      name: 'diet',
      description: 'Plugin tax: context cost, hot path, and uninstall candidates',
      handler,
    })
    commands.register({
      name: 'profiler',
      description: 'Alias of /diet',
      handler,
    })
  }
}

function reset(state) {
  state.since = Date.now()
  state.chains.clear()
  state.dispatches.clear()
  state.tools.clear()
  state.inflight.clear()
}
