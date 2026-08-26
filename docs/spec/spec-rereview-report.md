# 复审报告 — `docs/spec/deep-research-hybrid.md`（v2 设计文档包，第二轮）

> 📝 **重生成版说明（2026-02 编码事故后）**：本文为基于会话记录的**重生成版**——「审查材料」「D1」「R1–R7 处置表」「结论」「T0 续段」为原文完整保留或由工单台账精确复原（标「★原文」处）；「审查方法」与「发现清单」的问题陈述系按处置结果反向复原，措辞非原稿逐字。若原稿副本日后寻获，可覆盖本版。

## 一、审查方法

对照三路事实逐条核验 spec 声明：① `deepseek-harness` 源码（平台接缝假设）；② 包内全部文件的存在性、路径正确性与编码合法性（逐字校对 + UTF-8 校验）；③ 上游 v1 与 Anthropic 材料交叉验证设计出处。

## 二、审查材料 ★原文

- `references/upstream-v1/index.ts`、`regression.test.mjs`、`README.md`
- `references/anthropic/research_lead_agent.md`、`research_subagent.md`
- `references/anthropic/claude-code-changelog.md`（**读取失败**——见 D1）
- `references/methodology-comparison.md`

## 三、发现清单

| 编号 | 级别 | 问题陈述（按处置结果复原） |
| --- | --- | --- |
| D1 | 高 | `references/anthropic/claude-code-changelog.md` 不是合法 UTF-8，且内容被截断——read 直接失败，引证链断裂。首次修复尝试又因编码参数误用将文件覆盖为 0 字节（无 git、无备份），被迫从权威存档二次重建。 |
| R1 | 中 | spec 未定义"取消态"语义：引擎/jobs 均无 `cancelled` 负载词，spec 却未说明 killed 如何映射到本插件负载。 |
| R2 | 中 | 后台/前台两种模式的返回语义未区分：后台应即时返 `{ok, jobId, runId}`，输出 schema 为最终结算语义。 |
| R3 | 中 | 切片大小写成嵌套双 `min`，存在冗余内层计算；健壮性段表述需同步。 |
| R4 | 低 | 验证·修复环标题未覆盖 `synthesize=false` 分支，时序描述有歧义空间。 |
| R5 | 低 | methodology-comparison 角色行仍写"四角色"，与 v2 五角色不一致。 |
| R6 | 低 | README 标题/结构块存在「hybird」拼写误述，目录名应为 `dsh-deep-research-hybrid`。 |
| R7 | 低 | spec L5 本地址指向已废弃的项目根 `.specs/`；L264 引用 `.research/` 下源稿路径而非包内 `references/` 真实位置。 |

## 四、处置表 ★原文

| 项 | 文件 | 处理 |
|---|---|---|
| **D1** | `references/anthropic/claude-code-changelog.md` | 已修复。原文件为 GBK 残片（非法 UTF-8，read 直接失败）。已从权威存档 `.research/claude-code-docs/content/CHANGELOG.md` 重建为干净 UTF-8 摘录，含 deep-research / Fetch-phase / verifier 四条带原行号（L642/L967/L1208/L2625）的溯源条目；其中 L1208 补齐了「verifier 误报 all claims refuted」的官方证据，正好支撑 spec B1 注记与 verifier 有界修复环设计。 |
| **R1** | `spec/deep-research-hybrid.md` L108-109 | 新增「取消态 `killed` 映射」条目 + 状态词三域一览表。 |
| **R2** | `spec/deep-research-hybrid.md` L111-112 | 新增「模式差异」条目，明确输出 schema 为最终 job 输出、后台模式 execute() 仅即时返 `{ok, jobId, runId}`。 |
| **R3** | `spec/deep-research-hybrid.md` L171、L226 | 切片大小改为 `min(maxParallel, maxItemsPerCall)`，删除内层多余 `min`；健壮性段同步改写。 |
| **R4** | `spec/deep-research-hybrid.md` L179 | 验证·修复环标题补 `synthesize=false` 分支说明。 |
| **R5** | `references/methodology-comparison.md` §4.2 | 角色行注明「基于 v1；v2 新增 verifier 成五角色，见 spec」。 |
| **R6** | `README.md` L6 + 结构块 | 删去「目录名 hybird」误述，目录名统一为 `dsh-deep-research-hybrid`。 |
| **R7** | `spec/deep-research-hybrid.md` L5、L264 | 路径改为 `spec/deep-research-hybrid.md` 与 `references/methodology-comparison.md`（包内真实相对路径）。 |

> 注（历史记录）：methodology-comparison.md 中对 `.research/claude-code-docs/content/...` 的引用当时**保留不动**——该存档在本机真实存在，属一手来源溯源。
> 更新（评审后清理日）：该判断已过期——`.research/` 全量存档当日退役，CHANGELOG 全量件与支持文档收编入包内 `docs/references/anthropic/`，相关引用改指包内路径。

## 五、结论 ★原文

**结论**：D1 与 R1–R7 已全部落实。原硬错误与歧义均已正确承接，本包现在可交付实现，无需再做架构级修改。

---

**T0 平台接缝核验（续）★原文**：后台研究子代理已完成，产出 `references/platform-seam-verification.md`——11 项平台假设 10 项 HOLD、1 项 NEEDS-REVISION（jobs 无 `cancelled` 终态），实现细节修正注记已同步进工单 T0 节与 spec R1。

---

> 追加（评审后优化轮 + 结构重组期）：F1–F8 优化、A1–A5 社区横评落地、spec/references 移入 docs/ 的路径改写均见 `docs/references/implementation-tickets.md` 台账。⚠️ 结构重组期间发生第二次编码事故（PowerShell 默认编码损坏 8 个含中文文档），本报告即其重建产物之一——完整事故记录见同文件「编码事故记录」节。
