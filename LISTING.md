# dsh-plugin-profiler — plugin center listing draft

## Entry

```yaml
url: https://github.com/liuhange789/dsh-plugin-profiler
name: liuhange789/dsh-plugin-profiler
category: tools
description:
  en: '`/diet` prints a four-line bill for your plugin install: context tokens per request, hot-path host time outside the tool body, listener fan-out per plugin, and which three plugins to look at first — plus per-tool context pricing and a live listener map. Reads the running event bus and tool registry only: no patching of other plugins, no file writes, no network calls. The boundary is printed on the card: rc.7 has no per-listener timing, so the cut list is fan-out, not per-plugin milliseconds. It never throws into the host: a missing service, a taken command name, circular tool parameters or a throwing registry degrade one section, not the session.'
  zh: 'DSH 插件税体检。`/diet` 打印一张四行账单：每次请求的工具体定义占多少 token、热路径上工具体之外的宿主耗时、每个插件在热路径上挂了多少监听器、先看哪三个插件；另附逐工具上下文成本与实时监听器地图。只读运行中的事件总线与工具注册表，不修改其他插件，不写文件，不发网络请求。边界直接印在卡片上：rc.7 没有逐监听器耗时接口，“先拆谁”给的是监听器扇出，不是逐插件毫秒数。它不会把异常抛给宿主：服务缺失、命令名被占、工具参数循环引用或注册表报错，都只少一段报告，不影响会话。'
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

- [x] `npm test` — 10/10 against rc.7 (real vendored cordis runtime, hostile-input cases included)
- [x] npm package name `dsh-plugin-profiler` is unclaimed; npm identity is `liuhange`
- [ ] GitHub repo `liuhange789/dsh-plugin-profiler` (does not exist yet; no `GITHUB_TOKEN` and no `gh` CLI on this machine)
- [ ] `npm publish`
- [ ] open the plugin-center PR with the entry above
