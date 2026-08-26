# dsh-deep-research 与 Claude Code 原生 deep-research 方法论对比

> 调研日期：2026-07（本机网络受限，GitHub/Anthropic 官方站点不可直连；源码经 ghfast.top 镜像克隆，官方文档取自 thevibeworks/claude-code-docs 存档仓库）
> 结论先行：**两者不是同一套方法论，但属于同一个"深度研究"范式家族——高层模式（拆解→并行检索→迭代补缺→综合成文）一致；具体机制与理论依据是两套独立设计。**

> 📝 **重生成版说明（2026-02 编码事故后）**：本文为基于会话记录的**重生成版**——§1、§2.1 开头、§五结论、§六证据清单为事故前原文逐字保留（标「★原文」处）；其余章节依据 Anthropic 一手材料（`docs/references/anthropic/`）、upstream-v1 快照与本会话确立的 v2 设计忠实重建。若原稿副本日后寻获，可覆盖本版。

---

## 一、研究对象与一手来源

### 1.1 dsh-deep-research（被分析项目）

- 仓库：`https://github.com/omdsh-dev/dsh-deep-research`（整理副本见 `docs/references/upstream-v1/`；原克隆 commit `c0b329e`，本机存档已于评审后清理日退役）
- 本质：**DSH（DeepSeek Harness）的 Cordis 插件**，注册一个 `deep_research` 工具，把整个流程作为**静态 workflow 脚本**提交给 DSH 官方 workflow 引擎执行
- 全部逻辑在单个文件 `src/index.ts`（559 行）内，附 `test/regression.test.mjs` 回归测试（6 个场景：跳过规划、自适应闭环、盲区侦察、工具注册、参数校验、队列语义）

### 1.2 Claude Code 原生 deep-research（对照对象）

- Claude Code 内置 `/deep-research` 命令（随 CLI 分发，**不在** anthropics/claude-code 开源仓库中——已用完整 git 历史 737 commits 验证，仓库从未包含 deep-research 文件）
- 方法论一手来源（整理副本均在 `docs/references/anthropic/`）：
  1. Anthropic 工程博客《How we built our multi-agent research system》（原文 https://www.anthropic.com/engineering/multi-agent-research-system ）
  2. Anthropic 官方 Cookbook 的 `research_lead_agent.md` / `research_subagent.md` 提示词全文
  3. Claude Code CHANGELOG（全量件 + 关键条目节选）
  4. Claude 支持文档《Use research on Claude》

---

## 二、Claude Code 原生 deep-research 的方法论（来自官方一手资料）

### 2.1 架构：orchestrator-worker（编排者-工人）多智能体模式 ★原文开头

工程博客原文要点：

- **Lead agent（LeadResearcher）**：分析用户问题 → 制定策略 → 把研究计划持久化到 Memory（防 200K 上下文截断）→ 创建多个**并行子代理**（Subagent）
- 每个子代理独立执行 web 搜索、用 interleaved thinking 评估工具结果、把发现返回给 lead
- **CitationAgent**：lead 综合成稿后由其核对"每条声明与所引文档实际内容一致"，保证引用可溯

### 2.2 提示词解剖（Cookbook 双提示词）

**LeadResearcher 提示词要点**（`research_lead_agent.md`）：
- **查询类型判定**：先判断用户请求属于 chat / research / report 三类——只有后两者值得启动多代理流程，避免杀鸡用牛刀；
- **拆解与委派**：把问题拆成多个正交子方向，每个子代理任务包含「目标 goal + 建议深入方向 directions」双段式描述（这一措辞被社区广泛模仿，dzhng 版即其变体）；
- **并行执行**：一轮 3–5 个子代理并发；
- **停止规则**：评估已收集信息是否足以回答；不足则补派并明确缺口；足够则停，**直接引用 subagent 返回的要点不重复劳动**；
- **成稿规则**：带引用综合，声明与出处一一对应。

**Subagent 提示词要点**（`research_subagent.md`）：
- 单一聚焦职责：只负责被指派的一个研究方向，不做全局判断；
- **预算硬上限：20 次工具调用**；
- 查询策略：短宽查询起步、按命中率渐进收窄（先宽后窄）；
- 来源偏好 primary sources（官方一手 > 权威媒体 > 二手转述）；
- 并行抓取页面后细读评估，而非只看摘要；
- 只返回结论要点 + 精确出处，不搬运全文（上下文卫生）。

### 2.3 引用处理与验证

- 声明与引文的一致性由独立 CitationAgent 校验（架构层闸门，非提示词自觉）；
- CHANGELOG 证据：verifier 区分 `unverified / refuted`，且官方曾修复"verifier 误报 all claims refuted"缺陷（L1208）——**强制验证必须配边界与降级语义**，这是 v2 有界修复环的直接设计依据。

### 2.4 扩缩容与成本

- effort 伸缩：按问题复杂度调节子代理数量与轮次（简单问题少派甚至直答）；
- Memory 文件交接防上下文膨胀；
- 博客强调 evals（LLM-as-judge + rubric）驱动提示词迭代——工程成熟度来自度量闭环。

## 三、dsh-deep-research 的方法论（控制论 × 信息论）

理论→机制映射（据 upstream-v1 README 设计表）：

| 理论 | 落地机制 |
| --- | --- |
| 决策论 | 规划阶段定义**答案空间与验收标准**（scope/questions/acceptance），研究前先明确"什么样的证据算回答" |
| Ashby 必要多样性 | 维度枚举 + **coverage_gaps 盲区显式声明与定向侦察**——遗漏维度即盲区，绝不静默 |
| 信息论（EIG） | 子代理预测高熵点行动、轮末以**边际增益**判收敛（零新增 high 缺口即停） |
| 压缩理论（率失真） | 综合输入证据结构化精简，只保承重结论与直接支撑 |
| 红队思想 | 可选对抗性审查（覆盖度审计/矛盾并列/过度自信标注） |
| 三态证据纪律 | confirmed{claim,source,confidence} / uncertain{point,reason} / gaps{aspect,priority}——不确定性一等公民 |

v2 在此内核上叠加 Claude 骨架（后台执行、强制 verifier、宿主侧产物交接），并把四角色扩为五角色（新增 verifier）。

## 四、逐项对比

| 维度 | Claude Code 原生 | dsh-deep-research（v1 → v2） |
| --- | --- | --- |
| 触发形态 | `/deep-research` 斜杠命令，人工发起 | 自然语言模型触发工具（v2 明确） |
| 规划 | lead 临场拆解，无显式验收标准 | 答案空间 + dimensions + acceptance（v1→v2 增盲区侦察） |
| 质量保障 | verifier 强制但曾误报（有 bug 史） | review 可选仅给意见（v1）→ 强制 verifier+有界修复环+诚实降级（v2） |
| 收敛判据 | lead 自行评估"是否足够" | EIG 边际增益零即停 + depth+1 轮上限 + LIMIT(depth) 预算（v2） |
| 并发控制 | 平台侧并行子代理，数量随 effort 伸缩 | 切片 min(maxParallel, maxItemsPerCall) + maxTotalAgents 封顶 |
| 上下文管理 | Memory 工具持久化中间计划 | 宿主侧七类产物落盘 + 证据精简 + 指针交付 |
| 引用处理 | CitationAgent 架构级闸门 | confirmed.source + verifier 抽查（含引用失真判据 A2）；无独立 CitationAgent |
| 成本 | effort 伸缩成熟 | 模型分层五角色 + searchBudget/LIMIT(depth) |
| 失败隔离 | 生产级（重试/超时/隔离） | 单项失败归档继续；规划失败硬错误；分级降级矩阵 |
| 可审计性 | 黑盒 CLI | 全部编排为静态脚本可整段回归；产物全落盘 |
| 中文调研 | 未针对 | 提示词与语言参数原生中文优先 |

## 五、结论（怎么选）★原文

- **追求深度与成本可控、要透明可审计、跑中文调研** → dsh-deep-research 更优：规划验收、盲区验证、三态证据、模型分层都是原生实现没有的。
- **追求开箱即用、后台并行工作、需要企业内部信息源、要生产级可靠性** → Claude 原生更优：工具面、异步体验、verifier 强制验证、生态成熟度全面领先。
- 一句话：**Claude 是"更强壮的工业化实现"，dsh 是"更聪明的理论化设计"**——前者赢在工程与生态，后者赢在机制设计与可控性。

---

## 六、证据清单（可追溯）★原文

| # | 主张 | 来源 |
|---|---|---|
| 1 | Claude Code 内置 deep-research 为 orchestrator-worker 多智能体架构，lead 规划→并行子代理→迭代→CitationAgent | https://www.anthropic.com/engineering/multi-agent-research-system |
| 2 | lead 提示词：评估拆解/查询类型判定/计划/并行执行/停止与成稿规则 | https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/prompts/research_lead_agent.md |
| 3 | 子代理提示词：预算/OODA 循环/来源质量/20 调用上限 | https://github.com/anthropics/claude-cookbooks/blob/main/patterns/agents/prompts/research_subagent.md |
| 4 | `/deep-research` 手动命令、Fetch-phase agents、verifier 状态机 | https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md |
| 5 | dsh-deep-research 全部实现（规划/研究/综合/审查四阶段脚本） | https://github.com/omdsh-dev/dsh-deep-research/blob/main/src/index.ts |
| 6 | dsh-deep-research 理论→机制设计表、与 skill 体系独立声明 | https://github.com/omdsh-dev/dsh-deep-research/blob/main/README.md |
| 7 | 同族系统参考（STORM、OpenAI Deep Research、Perplexity 等） | https://github.com/Silence-view/deep-research/blob/main/skills/deep-research/references/research-methodology.md |
| 8 | 第三方对 Claude Code 内置 deep-research 的行为解剖（佐证） | https://steel.dev/blog/claude-code-deep-research-autopsy |

> 追加（v2 期）：五个社区实现的实现级横评见 `docs/references/community-comparison.md`。
