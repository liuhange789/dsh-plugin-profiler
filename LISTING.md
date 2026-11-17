# dsh-plugin-profiler — plugin center listing draft

## Entry

```yaml
url: https://github.com/liuhange789/dsh-plugin-profiler
name: DSH Plugin Tax (/diet)
category: usage
description:
  en: "Plugin load audit for your installed set. `/diet` prints one card: context tokens per request, hot-path host time outside the tool body, listener fan-out per plugin, and which three plugins to look at first, plus per-tool context pricing. Reads the running event bus and tool registry only, never patches another plugin, writes no files and makes no network calls. The card states its boundary: rc.7 exposes no per-listener timing, so the cut list is fan-out, not per-plugin milliseconds."
  zh: "DSH 插件税体检。`/diet` 输出一张卡片：每次请求的工具定义占多少 token、热路径上工具体之外的宿主耗时、每个插件在热路径上挂了多少监听器、先看哪三个插件，另附逐工具上下文成本。只读运行中的事件总线与工具注册表，不修改其他插件，不写文件，不发网络请求。卡片写明边界：rc.7 没有逐监听器耗时接口，“先拆谁”给的是监听器扇出，不是逐插件毫秒数。"
```

## Tagline candidates

- EN: **Your DSH did not get slower because of the model. It got slower because of what you installed.**
- ZH: **DSH 变慢，不一定是模型的锅——`/diet` 告诉你装的东西贵在哪。**

## Why it is not another benchmark

`dsh-benchup` and `dsh-eval` give black-box totals per task. This reads the session you are in and prices the install you have: context tax per request, hot-path wall time, per-tool cost, listener fan-out, and a cut list. The output is four lines short enough to screenshot and compare with a friend's install.

## What a user sees

```text
DSH plugin tax · 42s observed
  context   38 tools ≈ 9,120 tokens per request
  hot path  21 calls, 184.2ms outside the tool body
  listeners 9 plugins · 27 on hot events
  cut first plugin-a (6 hot listeners), plugin-b (4 hot listeners)
  fan-out is a suspicion, not a measurement: rc.7 cannot time another plugin's callback
```

The sample above is illustrative; the README uses a real run from the test suite.

## Commands

- `/diet` — card + detail sections
- `/diet reset` — clear counters, keep the live listener map
- `/profiler` — alias

## Submission checklist

- [x] `npm test` — 13/13 against rc.7 (real cordis runtime, hostile-input and unload cases included)
- [x] GitHub repo `liuhange789/dsh-plugin-profiler` — public, topics `dsh-plugin, dsh, deepseek-harness, profiler, diagnostics, plugin-tax`, `dsh.bundle` declared, `cordis.patch.yml` shipped
- [x] `npm publish` — `dsh-plugin-profiler@0.1.2`, public, latest tag
- [x] plugin-center PR — [awesome-dsh-plugin#16223](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/16223), 1 file (+6 −0)
- [ ] Submission gate — only failure is `repository is 0.0 days old (needs 1)`; it re-runs by itself, no resubmission needed
