import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { apply, name } from '../src/index.js'
import { estimateTokens } from '../src/report.js'

// The real cordis runtime shipped with DeepSeek Harness 0.1.0-rc.7.
const CORDIS = process.env.CORDIS_PATH ?? 'D:/新建文件夹/DeepSeek-Harness/vendor/cordis/lib/index.js'
const { Context } = await import(pathToFileURL(CORDIS).href)

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
  ctx.provide('commands', commands)
  if (extra.tools) ctx.provide('tools', extra.tools)
  ctx.plugin({ name, apply })
  await sleep(0)
  return { ctx, registered }
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
