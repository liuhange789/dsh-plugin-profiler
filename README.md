# dsh-plugin-profiler

**Your DSH did not get slower because of the model. It got slower because of what you installed.**

`/diet` prints what your current plugin set costs while the session runs: how many tokens your tool definitions eat on every request, how much wall time sits outside the tool body on the hot path, how many listeners each plugin puts on that path, and which three plugins to look at first.

This is not another benchmark. `dsh-benchup` and `dsh-eval` answer "is DSH good?" with black-box totals over a task. This answers "what is my install costing me right now?" using data from the live event bus and the live tool registry, with no changes to any other plugin.

| | Answers | What it needs from you |
| --- | --- | --- |
| `dsh-benchup` | Is this model or config good overall? | a benchmark task to run |
| `dsh-eval` | Does it choose the right tool? | a task suite |
| this plugin | What is my installed plugin set costing me right now? | the session you are already in |

## What it reports

| Section | Source | Meaning |
| --- | --- | --- |
| Context tax | `ctx.tools.schemas()` | Estimated tokens for every tool definition sent on each request, plus the heaviest tools |
| Hot path | prepended `agent/pre-step`, `agent/request`, `tools/pre-execute` listeners | Wall time of the remaining chain, builtins included, provider and tool body excluded |
| Tool calls | `tools/pre-execute` → `tools/result` | Wall time per tool call, keyed by `callId` |
| Listener fan-out | live `ctx.events._hooks` snapshot | Which plugin registered how many listeners, and how many sit on hot events |
| Event volume | `internal/dispatch` | How often each event actually fires |

## Sample output

From a synthetic two-plugin run against the real rc.7 runtime (not fabricated numbers):

```text
DSH plugin tax · 0s observed
  context   4 tools ≈ 210 tokens per request
  hot path  1 call, 37.3ms of host work (provider and tool body excluded)
  listeners 2 plugins · 4 on hot events
  cut first plugin-b (3 hot listeners), plugin-a (1 hot listener)
  fan-out is a suspicion, not a measurement: rc.7 cannot time another plugin's callback

Hot chains (wall time of every listener after this one, builtins included)
event                 calls  total     avg       max
agent/pre-step        1      37.3ms    37.3ms    37.3ms
  before each step

Context tax, per tool definition
4 tools ≈ 210 tokens; heaviest: bash ≈ 68, read_file ≈ 54, apply_patch ≈ 45
  Owner is not exposed by rc.7, so this is per tool, not per plugin.

Listeners per plugin (snapshot)
plugin-b              agent/pre-step ×1, llm/stream ×1, tools/result ×1
plugin-a              agent/pre-step ×1

Event volume (top dispatches, all modes)
agent/pre-step ×1 · tools/result ×1
```

## What this cannot measure

Read this before installing. It is the reason the card says "fan-out is a suspicion":

- **No per-plugin milliseconds.** rc.7 gives `internal/listener` only a veto over registration (`vendor/cordis/src/events.ts`, `on()` returns a non-null value as the disposer instead of registering), and it has no post-dispatch event. A plugin therefore cannot wrap another plugin's callback. Any tool claiming "plugin A's pre-execute took N ms" on rc.7 is not measuring what it says.
- **No tool owner.** `tools.register()` stores the definition but not the registering fiber, so the context tax is priced per tool, not per plugin.
- **Two scopes are intentionally excluded from the tax line.** `llm/stream` is timed only up to interception, not stream consumption, and the provider call dominates it. Tool body time is measured separately under "Tool calls".

If a host seam lands later (a post-registration or post-dispatch hook, plus an owner field on tool records), this plugin can add real per-plugin attribution without changing its report format.

## Robustness

Written so it can never be the reason your host breaks:

- Every listener body is contained: a bookkeeping failure is dropped, never thrown into the chain the host is running.
- A dispatch with no `next` callback (a plain emit of a waterfall event name) passes through untouched instead of being called as a function.
- No `commands` service, or a `/diet` name already taken by another copy, costs the command only — counters keep running, `/profiler` is still attempted, and the rest of the session is unaffected.
- `tools.schemas()` throwing, circular parameter objects, or a proxy that refuses enumeration degrade that one section and leave the rest of the card intact.
- Counters are bounded (200 in-flight calls, 200 distinct events), so a very long session cannot grow them without limit.
- Tables are padded by display width, so Chinese, Japanese or emoji plugin names line up like ASCII ones.

## Usage

Add the package to your DSH plugin list like any other plugin, then:

- `/diet` — print the tax card and the detail sections
- `/diet reset` — clear counters and keep the live listener inventory
- `/profiler` — alias of `/diet`

No config keys. No network calls. No file writes. If the `commands` service is absent, counters still collect silently and nothing is shown.

## Limitations

- Chain timing includes builtins and any other listener in the remaining chain; it is the cost of the path, not one plugin.
- The listener snapshot is live: plugins loaded after `/diet` are visible on the next call, plugins already unloaded are gone.
- Token estimates use ~4 characters per token; treat them as relative weights, not billing.
- `commands.register` is called once at load; a hot-reloaded commands service is not re-bound.

## Compatibility

DeepSeek Harness `0.1.0-rc.7` (`@deepseek-ai/cordis` 4.x event bus). Node `^22.19.0 || >=24.0.0`.

## Tests

```bash
npm test
```

Ten tests run against the real vendored cordis runtime: silent degradation, chain timing with two plugins, tool call timing, tool-definition pricing, reset, missing commands service, duplicate command name, dispatch without `next`, unserializable tool parameters, and a throwing tools service.

## License

MIT
