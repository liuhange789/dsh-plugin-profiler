import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { apply, name } from '../src/index.js'
import { estimateTokens } from '../src/report.js'

/**
 * Load the real cordis runtime. `CORDIS_PATH` wins (the vendored copy shipped
 * with a local Harness checkout); otherwise the published package; the old
 * local path is only a last resort so a clean clone still gets a clear error.
 */
async function loadCordis() {
  if (process.env.CORDIS_PATH) return import(pathToFileURL(process.env.CORDIS_PATH).href)
  try {
    return await import('@deepseek-ai/cordis')
  } catch {
    // Fall through to the vendored path below.
  }
  try {
    return await import(pathToFileURL('D:/新建文件夹/DeepSeek-Harness/vendor/cordis/lib/index.js').href)
  } catch {
    throw new Error('cordis is not installed: run `npm install` or set CORDIS_PATH to vendor/cordis/lib/index.js')
  }
}

const { Context } = await loadCordis()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function boot(extra = {}) {
  const ctx = new Context()
  const registered = []
  const commands = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  if (extra.commands !== false) ctx.provide('commands', extra.commands ?? commands)
  if (extra.tools) ctx.provide('tools', extra.tools)
  const fiber = ctx.plugin({ name, apply })
  await sleep(0)
  return { ctx, registered, fiber }
}

function reportFor(registered) {
  const definition = registered.find(item => item.name === 'diet')
  assert.ok(definition, '/diet was not registered')
  return definition.handler({ rawInput: '' })
}

test('silent degradation: no plugins, no tools, no counters', async () => {
  const { ctx, registered } = await boot()
  assert.equal(registered.length, 2)
  const result = reportFor(registered)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Nothing measured yet/)
  assert.ok(!result.text.includes('Hot chains'))
  ctx.registry?.stop?.()
})

test('times the remaining chain and lists both plugins as listeners', async () => {
  const { ctx, registered } = await boot()
  const slow = { name: 'plugin-a', apply(c) { c.on('agent/pre-step', async (...args) => { const next = args.pop(); await sleep(30); return next() }) } }
  const fast = { name: 'plugin-b', apply(c) { c.on('agent/pre-step', async (...args) => { const next = args.pop(); await sleep(10); return next() }) } }
  ctx.plugin(slow)
  ctx.plugin(fast)
  await sleep(0)

  const dispatch = () => ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')
  await dispatch()
  await dispatch()

  const result = reportFor(registered)
  assert.match(result.text, /agent\/pre-step/)

  const row = result.text.split('\n').find(line => line.startsWith('agent/pre-step'))
  assert.ok(row, 'missing agent/pre-step row')
  const calls = Number(row.trim().split(/\s+/)[1])
  assert.equal(calls, 2, 'expected two calls in the chain row')

  const total = Number(row.trim().split(/\s+/)[2].replace('ms', ''))
  assert.ok(total >= 70, `chain total ${total}ms should cover both listeners (≥70ms)`)

  assert.match(result.text, /plugin-a/)
  assert.match(result.text, /plugin-b/)
  ctx.registry?.stop?.()
})

test('times a tool call from pre-execute to tools/result', async () => {
  const { ctx, registered } = await boot()
  const exec = { callId: 'call-1', name: 'bash' }
  await ctx.waterfall(null, 'tools/pre-execute', exec, async () => 'allow')
  await sleep(20)
  ctx.emit(null, 'tools/result', exec, { isError: false })

  const result = reportFor(registered)
  assert.match(result.text, /Tool calls \(pre-execute → tools\/result\)/)
  const row = result.text.split('\n').find(line => line.startsWith('bash'))
  assert.ok(row, 'missing bash row')
  const calls = Number(row.trim().split(/\s+/)[1])
  assert.equal(calls, 1)
  ctx.registry?.stop?.()
})

test('prices tool definitions per tool and says the owner is unknown', async () => {
  const { ctx, registered } = await boot({
    tools: {
      schemas: () => [
        { name: 'bash', description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      ],
    },
  })
  const result = reportFor(registered)
  assert.match(result.text, /2 tools ≈ /)
  assert.match(result.text, /Owner is not exposed by rc\.7/)
  assert.ok(estimateTokens({ name: 'bash', description: 'Run a shell command', parameters: {} }) > 0)
  ctx.registry?.stop?.()
})

test('reset clears the card', async () => {
  const { ctx, registered } = await boot()
  ctx.plugin({ name: 'plugin-c', apply(c) { c.on('agent/pre-step', async (...args) => args.pop()()) } })
  await ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')

  const definition = registered.find(item => item.name === 'diet')
  assert.ok(definition)
  const reset = definition.handler({ rawInput: 'reset' })
  assert.equal(reset.kind, 'success')
  const after = definition.handler({ rawInput: '' })
  assert.match(after.text, /hot path  0 calls/)
  assert.match(after.text, /^(?!.*Hot chains)/s)
  ctx.registry?.stop?.()
})

test('loads silently when the commands service is absent', async () => {
  const { ctx } = await boot({ commands: false })
  const outcome = await ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')
  assert.equal(outcome, 'ok')
  ctx.registry?.stop?.()
})

test('keeps measuring when a command name is already taken', async () => {
  const ctx = new Context()
  const accepted = []
  ctx.provide('commands', {
    register(definition) {
      if (accepted.some(item => item.name === definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      accepted.push(definition)
      return () => {}
    },
  })
  ctx.plugin({ name, apply })
  await sleep(0)
  // A second copy (duplicate install, or a reload whose old registration survived).
  ctx.plugin({ name, apply })
  await sleep(0)

  assert.equal(accepted.length, 2, 'only the first copy should own the two commands')
  const outcome = await ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')
  assert.equal(outcome, 'ok', 'the rejected copy must not break the chain')
  ctx.registry?.stop?.()
})

test('passes through dispatches that carry no next callback', async () => {
  const { ctx } = await boot()
  assert.doesNotThrow(() => ctx.emit(null, 'agent/pre-step', { step: 1 }))
  assert.doesNotThrow(() => ctx.emit(null, 'tools/pre-execute', { name: 'bash' }))
  ctx.registry?.stop?.()
})

test('prices a schema whose parameters cannot be serialized', async () => {
  const circular = { type: 'object' }
  circular.self = circular
  const { ctx, registered } = await boot({
    tools: { schemas: () => [{ name: 'loop', description: 'circular params', parameters: circular }] },
  })
  const result = reportFor(registered)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /1 tool ≈ /)
  assert.match(result.text, /heaviest: loop/)
  ctx.registry?.stop?.()
})

test('survives a tools service that throws', async () => {
  const { ctx, registered } = await boot({
    tools: { schemas() { throw new Error('tool registry offline') } },
  })
  await ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')

  const result = reportFor(registered)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /hot path  1 call/)
  assert.ok(!result.text.includes('Context tax, per tool definition'))
  ctx.registry?.stop?.()
})

test('returns the AsyncIterable itself for llm/stream, never a Promise', async () => {
  const { ctx, registered } = await boot()
  const chunks = [{ type: 'text', text: 'hello' }, { type: 'finish', reason: { kind: 'stop' } }]
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }

  const outer = ctx.waterfall(null, 'llm/stream', { messages: [] }, () => stream)
  assert.ok(!(outer instanceof Promise), 'an async wrapper here breaks every model call in rc.7')
  assert.equal(typeof outer?.[Symbol.asyncIterator], 'function', 'the handler must return the iterable synchronously')

  const seen = []
  for await (const chunk of outer) seen.push(chunk)
  assert.deepEqual(seen, chunks, 'the stream must be passed through unchanged')

  const result = reportFor(registered)
  const row = result.text.split('\n').find(line => line.startsWith('llm/stream'))
  assert.ok(row, 'llm/stream setup should be timed')
  assert.match(result.text, /stream setup only, not chunk consumption/)
  ctx.registry?.stop?.()
})

test('reset does not backfill a chain that started before it', async () => {
  const { ctx, registered } = await boot()
  const release = Promise.withResolvers()
  const inFlight = ctx.waterfall(null, 'agent/pre-step', {}, async () => {
    await release.promise
    return 'ok'
  })

  const definition = registered.find(item => item.name === 'diet')
  assert.ok(definition)
  assert.equal(definition.handler({ rawInput: 'reset' }).kind, 'success')

  release.resolve()
  await inFlight

  const after = definition.handler({ rawInput: '' })
  assert.doesNotMatch(after.text, /agent\/pre-step/, 'the pre-reset chain must not enter the new window')
  assert.match(after.text, /Nothing measured yet/)
  ctx.registry?.stop?.()
})

test('stops counting once the plugin fiber is disposed', async () => {
  const { ctx, registered, fiber } = await boot()
  const definition = registered.find(item => item.name === 'diet')
  assert.ok(definition)

  await ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')
  assert.match(definition.handler({ rawInput: '' }).text, /hot path  1 call/)

  await fiber.dispose()

  await ctx.waterfall(null, 'agent/pre-step', {}, async () => 'ok')
  const after = definition.handler({ rawInput: '' })
  assert.equal(after.kind, 'success')
  assert.match(after.text, /hot path  1 call/, 'no listener may survive unload')
})
