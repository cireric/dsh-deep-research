# 社区 deep-research 实现横评（批判性吸收笔记）

> 研读方式：五个开源实现的浅克隆逐文件通读（研读日即本笔记写作日），按统一七维清单分析；
> 各仓完整分析经多代理并行产出，本文为交叉蒸馏。对照基准 = 本包 v2 设计
> （docs/spec/dsh-deep-research.md + docs/adr-architecture.md）。
> 缺席说明：liangdabiao/Deep-Research 多个地址变体均克隆失败（疑改名/删除），未参与本次横评。

## 一、样本概览

| 仓库 | 形态 | 规模 | 相对官方/Cookbook 的真实增量 | 总评 |
| --- | --- | --- | --- | --- |
| **dzhng/deep-research** | TS 应用（Firecrawl+LLM API） | src 8 文件 ~500 LoC | researchGoal 双段式查询生成、depth×breadth 递归树、learnings 反馈环 | **中**：prompt 层三处可抄；缺验证闸门与不确定性建模 |
| **wshuyi/deep-research** | Claude Code Skill（纯 prompt 包） | SKILL.md 329 行 + 模板 | L1–L4 来源分层时效窗、"产者≠审查者"、事实卡片三级确定性、边界守恒检查 | **中**：高质量 prompt 工程，缺算法骨架 |
| **jamoeight/deep-research-claude-code** | Claude Command/Skill（纯 prompt） | SKILL.md 423 行 | 独立 Citation Verifier（论断-来源一致性抽查）、成本分层模型分配 | **中**：官方架构的 prompt 复述，两处细节值得移植 |
| **Silence-view/deep-research** | Skill + 参考方法论综述 + 校验脚本 | SKILL.md ~750 行 | Citogenesis 检测、来源多样性强制、Contrarian 反证代理、6 级置信 | **中**：三个机制 v2 未覆盖；但含大量未验证"统计"注水 |
| **stevenirby/deep-research-skill** | 薄 Skill（纯 prompt） | SKILL.md 238 行 | claim 级 Evidence Ledger、URL 验活、对抗性检索、[UNVERIFIED] 防先验污染 | **中**：证据账本是 v2 三态证据的成熟原型 |

**横向结论**：无一在编排架构上超越 v2——全部缺失规划验收/盲区定向侦察/EIG 边际增益收敛/确定性切片中的至少三项；价值集中在 **prompt 措辞技巧与证据纪律的字段设计**。

## 二、逐仓要点（file:line 溯源见各仓源码）

### dzhng/deep-research
- 可抄：researchGoal「先谈目标再谈深入方向」双段措辞（deep-research.ts:69）；followUpQuestions 作下轮 query 种子（:253）；失败孤立返回空结果不污染全局（:275-285）。
- 应避免：learnings 扁平累积无置信度→噪声撑爆上下文靠 trimPrompt 硬截断（:65）；depth×breadth 递归无预算上限成本不可控；report 与 research 解耦无幻觉闸门；visitedUrls 无去重审计。

### wshuyi/deep-research
- 可抄：边界守恒审计（SKILL.md:207，每轮末审"证据能否溯回子问题"）；事实卡片三级确定性防偷换（:273）；L1–L4 来源分层+时效窗口（:52,:77）。
- 应避免：全程顺序无预算；独立校验仍同一模型非真对抗；"铁律"仅靠自律无运行时强制。

### jamoeight/deep-research-claude-code
- 可抄：Citation Verifier 的"来源是否真支撑论断"语义抽查作 refuted 判据之一（SKILL.md:336-347）；opus/sonnet/haiku 成本分层映射到 agent({model})（:30-39）；报告的 Contradictions & Uncertainties / Knowledge Gaps 固定章节（:281-306）。
- 应避免：effort 强制 Exhaustive 浪费用量；模型策略写死；重叠分解全靠运气。

### Silence-view/deep-research
- 可抄（v2 未覆盖的三处）：**Citogenesis/循环引用检测**（research-methodology.md:239-246，单一原始源多跳转发的共识幻觉）；**来源多样性强制**（SKILL.md:720-724，单域占比>50% 触发反向搜索）；**Contrarian 反证代理**（:334-353）。另有零成本措辞技巧：关键指令置于 prompt 末尾、反角色提示（:175,643-654）。
- 应避免：无出处的"90.2%/17x"式数据注水进入提示词；信任 LLM 自评分做可信度主判据；Claude Code 外部状态耦合。

### stevenirby/deep-research-skill
- 可抄：claim 为单位的 Evidence Ledger + provenance/entailment 双检；URL 存活校验；[UNVERIFIED] 标签阻断先验冒充证据。
- 应避免：3 轮硬上限无收敛判据；串行无并行；Integrity Gate 全靠模型自律。

## 三、v2.x 候选改进清单（跨仓蒸馏，按性价比排序）

### A. Prompt 层（零结构改动，随下次文案修订即可带入）

| # | 候选 | 出处 | 落点 |
| --- | --- | --- | --- |
| A1 | researchGoal 双段式："每个子问题的检索目标 + 检索后的深入方向"写入 researcher 提示词 | dzhng ts:69 | script.ts researcherPrompt |
| A2 | 引文一致性审计并入 verifier：refuted 判据增加"所引页面实际不支撑该声明"（不止矛盾，还有"不支持"） | jamoeight :336-347 | script.ts verifierPrompt |
| A3 | URL 存活性抽查显式化：verifier 有 web_fetch 时对 confirmed 来源抽样验活，不可达→unverified | stevenirby / jamoeight | script.ts verifierPrompt（B1 分支内已有雏形，措辞显式化） |
| A4 | 措辞技巧：关键指令置 prompt 末尾；用任务式而非角色式开头 | Silence-view | 全部提示词微调 |
| A5 | [UNVERIFIED]-式标签纪律：综合提示词要求"证据精简副本之外的既有知识一律标注（背景知识）" | stevenirby | script.ts synthPrompt |

### B. 脚本结构层（需改 RESEARCH_SCRIPT + 回归）

| # | 候选 | 出处 | 说明 |
| --- | --- | --- | --- |
| B1 | 平滑续研：轮末除 high-gaps 外，收集子代理建议的 follow-up 问题入队（normKey 去重沿用） | dzhng :253 | followUpsFrom 扩展 |
| B2 | 边界守恒审计：每轮末一次轻量 agent()，对照 scope 输出"疑似漂移项"，只告警不入队 | wshuyi :207 | 每轮 +1 agent，注意 maxTotalAgents |
| B3 | Contrarian 抽查：验证阶段前对 report 做一次专职反证 agent，产出喂给 verifier 当输入 | Silence-view :334 | review=true 时顺带执行 |
| B4 | 来源多样性软约束：researcher 提示词加"若已有来源集中于单一域名，下一查询换域" | Silence-view :720 | prompt 层软约束即可 |
| C1（暂缓） | 六级置信呈现 | Silence-view :360 | v2 三态+verifier reason 字段已够；报告层需要时再映射 |
| C2（暂缓） | Citogenesis 溯源图 | Silence-view | 需要 evidence 间引用图，静态脚本可做但收益/复杂比待定；先以 A2 的"不支持=refuted"覆盖主要场景 |

### 明确不采纳

| 项 | 理由 |
| --- | --- |
| depth×breadth 递归树（dzhng） | 与切片模型冲突；无预算封顶的成本失控已被其自身实践证明 |
| learnings 扁平累积（dzhng） | 无置信度的字符串累积正是 v2 三态证据要解决的问题 |
| Co-STORM 多视角对话 / D-S 置信合成（Silence-view） | 机制重、依赖多次聚合调用，超出 v2.x 性价比区间 |
| 可视化图表阶段（jamoeight） | 文本报告之外的能力，与工具定位无关 |

## 四、方法论备注

- 本次研读回答了工单「遗留审计项」的追问：社区仓库的价值集中在**证据纪律字段设计与 prompt 措辞**，不在编排架构——这与清理前的预判一致，但现在有了逐仓 file:line 证据。
- liangdabiao/Deep-Research 未参与（地址变体全部失败，疑改名/删除）；如获得新址可按同一七维清单补录。
