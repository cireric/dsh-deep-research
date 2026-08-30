# Claude Code CHANGELOG — deep-research / verifier 摘录

> 来源：anthropics/claude-code CHANGELOG.md（全量原件存档已移除，本摘录保留溯源条目）。
> 说明：以下为从官方 CHANGELOG 中节选的、与 deep-research / verifier / Fetch-phase 直接相关的条目，
> 供本文档对 Claude 原生 deep-research 方法论的引证使用。非连续全文摘录，已标注原行号以便溯源。

## `/deep-research` 触发方式

- Changed `/deep-research` to start only when invoked manually; Claude no longer launches it on its own
  （CHANGELOG L642：证实 `/deep-research` 为手动斜杠命令，曾改为仅手动调用、不再自动触发）

## Fetch-phase agents（抓取阶段子代理）

- Fixed Deep research runs labeling every Fetch-phase agent "unknown" — chips now show the source hostname
  （CHANGELOG L967：证实 deep-research 存在 Fetch-phase 抓取阶段子代理，UI 上显示来源 hostname）

## verifier 状态机（unverified / refuted）

- Fixed `/deep-research` misreporting verifier failures as "all claims refuted" instead of `unverified`
  （CHANGELOG L1208：证实 verifier 存在 `unverified`/`refuted` 状态机；并印证官方曾出现「误报 all claims refuted」缺陷——
   正是本插件 verifier 有界修复环（verifierMaxRounds）设计要避免的同类失效）
- Fixed `prompt` hooks re-firing on tool calls made by an agent-hook verifier subagent
  （CHANGELOG L2625：证实 verifier 本身是一个 subagent）
