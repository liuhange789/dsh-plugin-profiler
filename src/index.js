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
 *
 * Robustness contract: this plugin never throws into the host. Every listener
 * body, every command handler and every optional-service call is contained; if
 * anything it reads is missing or hostile it drops that section and keeps the
 * rest of the session running.
 */

import {
  collectListeners,
  collectTools,
  renderReport,
} from './report.js'

export const name = 'plugin-profiler'

/**
 * Waterfall events whose remaining chain is awaited, so `async` is safe.
 *
 * `llm/stream` is deliberately absent: rc.7 dispatches it synchronously and
 * requires the handler to return the AsyncIterable itself. An async wrapper
 * would hand the caller a Promise and break every model call.
 */
const TIMED_CHAINS = [
  ['agent/pre-step', 'before each step'],
  ['agent/request', 'request assembly'],
]

/** Bounds that keep counters small even after a very long session. */
const MAX_INFLIGHT = 200
const MAX_EVENTS = 200

const clock = typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Date.now()

function newState() {
  return {
    since: Date.now(),
    /** Bumped by `/diet reset`; calls started earlier must not land in the new window. */
    generation: 0,
    chains: new Map(),
    dispatches: new Map(),
    tools: new Map(),
    inflight: new Map(),
  }
}

/** Read an optional service without ever letting a proxy getter break the load. */
function optionalService(ctx, key) {
  try {
    const value = ctx.get(key, false)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/** Run bookkeeping that must not be able to fail a host dispatch. */
function safely(work) {
  try {
    work()
  } catch {
    // A counter can never justify breaking the caller's chain.
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
    // Dynamic or renamed tools could otherwise grow this table forever.
    if (state.tools.size >= MAX_EVENTS) return
    row = { tool, calls: 0, totalMs: 0, maxMs: 0 }
    state.tools.set(tool, row)
  }
  row.calls += 1
  row.totalMs += ms
  row.maxMs = Math.max(row.maxMs, ms)
}

function describeThrown(error) {
  try {
    const text = error instanceof Error ? error.message : String(error)
    return text.length > 160 ? `${text.slice(0, 159)}…` : text
  } catch {
    return 'unknown error'
  }
}

function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`[plugin-profiler] ${message}`)
  } catch {
    // Logging is never load-bearing.
  }
}

/** Attach a registered command's disposer to this plugin's fiber, so unload unregisters it. */
function keepCommandAlive(ctx, dispose) {
  if (typeof dispose !== 'function') return
  if (typeof ctx.effect !== 'function') return
  try {
    ctx.effect(() => dispose, 'plugin-profiler command')
  } catch {
    // If the fiber is already leaving, drop the registration immediately.
    try {
      dispose()
    } catch {
      // Nothing left to release.
    }
  }
}

function registerCommand(ctx, commands, definition) {
  try {
    const dispose = commands.register(definition)
    keepCommandAlive(ctx, dispose)
    return true
  } catch (error) {
    // A duplicate name (second copy of this plugin, or a foreign /diet) must
    // cost the command, never the plugin.
    warn(ctx, `could not register /${definition.name}: ${describeThrown(error)}`)
    return false
  }
}

/** Resolve the tool payload's display name without trusting property access. */
function toolNameOf(exec) {
  try {
    return exec?.name == null ? '?' : String(exec.name)
  } catch {
    return '?'
  }
}

function callIdOf(exec) {
  try {
    return exec?.callId == null ? undefined : String(exec.callId)
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const state = newState()

  // Every non-internal dispatch, whatever its mode (emit/parallel/serial/bail/waterfall).
  ctx.on('internal/dispatch', (mode, event) => {
    safely(() => {
      if (typeof event !== 'string' || event.startsWith('internal/')) return
      const seen = state.dispatches.get(event)
      if (seen === undefined && state.dispatches.size >= MAX_EVENTS) return
      state.dispatches.set(event, (seen ?? 0) + 1)
    })
  }, { global: true })

  // Outermost listener: time everything the rest of the chain does, `next()` included.
  // Rest arguments keep this signature-agnostic across both events.
  for (const [event, note] of TIMED_CHAINS) {
    ctx.on(event, async (...args) => {
      const next = args[args.length - 1]
      // A non-waterfall dispatch (a plain emit of the same name) has no `next`;
      // pass through instead of trying to call something that is not a function.
      if (typeof next !== 'function') return next
      const generation = state.generation
      const start = clock()
      try {
        return await next()
      } finally {
        if (generation === state.generation) {
          safely(() => recordChain(state, event, note, clock() - start))
        }
      }
    }, { prepend: true, global: true })
  }

  // `llm/stream` is dispatched synchronously and its return value is iterated
  // with `for await`. Stay synchronous and hand back the iterable unchanged;
  // only the setup (adapter resolution) is timed, never chunk consumption.
  ctx.on('llm/stream', (...args) => {
    const next = args[args.length - 1]
    if (typeof next !== 'function') return next
    const generation = state.generation
    const start = clock()
    try {
      return next()
    } finally {
      if (generation === state.generation) {
        safely(() => recordChain(state, 'llm/stream', 'stream setup only, not chunk consumption', clock() - start))
      }
    }
  }, { prepend: true, global: true })

  // Pre-tool gates: time the gate chain and remember when the call started.
  ctx.on('tools/pre-execute', async (...args) => {
    const next = args[args.length - 1]
    if (typeof next !== 'function') return next
    const generation = state.generation
    const start = clock()
    safely(() => {
      const exec = args[0]
      const callId = callIdOf(exec)
      if (callId === undefined) return
      if (!state.inflight.has(callId) && state.inflight.size >= MAX_INFLIGHT) {
        // Drop the oldest call instead of losing every other in-flight one.
        const oldest = state.inflight.keys().next().value
        state.inflight.delete(oldest)
      }
      state.inflight.set(callId, { name: toolNameOf(exec), start, generation })
    })
    try {
      return await next()
    } finally {
      if (generation === state.generation) {
        safely(() => recordChain(state, 'tools/pre-execute', 'pre-tool gates', clock() - start))
      }
    }
  }, { prepend: true, global: true })

  ctx.on('tools/result', (exec) => {
    safely(() => {
      const callId = callIdOf(exec)
      if (callId === undefined) return
      const started = state.inflight.get(callId)
      if (!started) return
      state.inflight.delete(callId)
      if (started.generation !== state.generation) return
      recordTool(state, started.name, clock() - started.start)
    })
  }, { global: true })

  const commands = optionalService(ctx, 'commands')
  if (!commands || typeof commands.register !== 'function') return

  const handler = (invocation) => {
    try {
      let arg = ''
      try {
        arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
      } catch {
        arg = ''
      }
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
    } catch (error) {
      return {
        kind: 'error',
        text: `Plugin tax report failed: ${describeThrown(error)}. Counters are still collecting; try /diet again.`,
      }
    }
  }

  // `/diet` is the memorable surface; `/profiler` is kept as an alias.
  registerCommand(ctx, commands, {
    name: 'diet',
    description: 'Plugin tax: context cost, hot path, and uninstall candidates',
    handler,
  })
  registerCommand(ctx, commands, {
    name: 'profiler',
    description: 'Alias of /diet',
    handler,
  })
}

function reset(state) {
  state.generation += 1
  state.since = Date.now()
  state.chains.clear()
  state.dispatches.clear()
  state.tools.clear()
  state.inflight.clear()
}
