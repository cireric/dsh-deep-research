# 代理提示词清单（agent-prompts）

> 权威来源是 `src/script.ts` 内嵌的提示词构造函数；本文档逐个说明其设计意图与规格依据。所有提示词尾部统一追加"全程用 <language> 写作与思考"，并要求严格按 schema 返回（综合/审查为自由 Markdown 例外）。

## 1. planner（规划代理，PLANNER_SCHEMA）

任务：为主题定义答案空间。四项要求——
1. `scope` 一句话界定范围与边界；
2. `dimensions` 枚举 4-8 个必须覆盖的信息维度（Ashby 必要多样性：漏维度=盲区）;
3. `questions` 每维度 1-3 个可研究、可验收的子问题，附 `keywords` 与 `acceptance`（什么证据算回答了它）；
4. `coverage_gaps` 显式声明"不确定信息是否可得"的盲区。
尾部硬性要求：宁可在 coverage_gaps 里如实声明盲区，也不得虚构维度或子问题（A4 尾置技巧）。

设计依据：dsh 答案空间/验收标准 + Ashby 盲区机制（spec §规划代理契约）。purpose 缺失时提示词要求从主题推断最可能的决策语境。

## 2. researcher（研究子代理，RESEARCHER_SCHEMA）

结构：主题 → 研究项 → （维度/关键词/验收标准，按需注入）→ 两段纪律。

- **预算制感知-行动循环**：①先给初始最佳答案 →②预测信息熵最高点（EIG）→③ web_search/web_fetch 先宽后窄，工具调用 ≤ `searchBudget` 次 →④更新三态证据后做边际增益检验，零增益立即停。
- **诚实纪律**：只列实际访问过的来源；不可达来源一律 uncertain 绝不编造；来源分级 A/B/C/D 写进 claim 尾部（如 `[A]`）；找不到就写 gaps 并标优先级。

设计依据：Claude 官方 research_subagent 提示词（预算/OODA/来源质量）× dsh 三态证据/EIG 收敛。生效预算 = `min(searchBudget, LIMIT(depth))`（LIMIT：depth 1→2、2→3、3→4，规格 §研究子代理契约；评审 F4 已落实，回归用例 ⑦ 覆盖）。社区横评增补：每次检索前强制写「检索目标」行（A1，源自 dzhng researchGoal 双段式）；初始答案未经检索证实不得写入 confirmed——先验知识视同 uncertain（A5，源自 stevenirby [UNVERIFIED] 纪律）。

## 3. recon（盲区侦察，RECON_SCHEMA）

输入单条盲区文本。判定标准二选一：`obtainable=true` 仅当确实找到公开信息并在 `findings` 附实际来源；`obtainable=false` 在 `reason` 说明不可得原因，不得编造。尾部硬性要求：obtainable=false 时 findings 必须为空（A4）。同样受 agentBudget 约束。侦察结论由脚本归档进 blindspots，不可得时自动生成一条"已验证盲区：公开渠道不可得"的 uncertain 记录。

## 4. synthesizer（综合代理，自由 Markdown）

输入 = 主题/范围/维度 + **脚本内拼接的结构化证据精简副本**（confirmed 仅 {claim,source,confidence}，uncertain/gaps 仅要点；达轮上限未派发项如实列为未完成）。要求率失真压缩：只留承重结论与直接支撑、不确定性显式保留、已验证盲区单独成节、承重声明附 [来源]、固定章节骨架（摘要/背景/核心发现/不确定性与矛盾并列/已验证盲区/结论/参考资料仅列出现过的来源）。
失败降级：agent 返回空/null 时脚本拼装"降级报告"（证据附录 + 明确标注），report_note 记录原因。社区横评增补（A5）：报告中不得出现证据附录之外的具体事实/数字/日期，确需背景知识衔接时显式标注『（背景知识，未经本轮检索验证）』；尾部硬性要求——找不到出处的事实性内容一律删除或标注。

## 5. synthesizer-rev<N>（修订式重综合，自由 Markdown）

输入 = verifier 意见清单 + 上版报告。纪律：**只改被点名节与声明，保留已验证部分原样，不重写全文**；无法核实的表述改为显式不确定性陈述；refuted 声明删除或改写到与证据相符。
设计依据：Claude CHANGELOG 记载的官方 verifier"误报 all claims refuted"缺陷 ⇒ 有界修复环 + 局部修订（B1/修复环条目）。

## 6. verifier（强制验证，VERIFIER_SCHEMA）

对报告逐承重声明分类：
- `verified` —— **只有能通过 web_fetch 实际抽查来源可达性与支撑性时才可给出；无法抽查时不得声称做了实证核查**；抽查核对"页面是否真的说了这件事"，而非仅主题相关；
- `unverified` —— 无法独立核实（含没有 web_fetch 工具时的全部引用），如实标注不算失败；带 web_fetch 时有**验活配额**：至少抽取最承重的 2-3 条引用核查，404/超时 → 降 unverified（reason 注「链接失效」），承重来源全灭 → needs_revision=true（A3）；
- `refuted` —— 两种情形均算：①与其他已确认来源或公认事实矛盾；②**引用失真**——来源实际内容并不支撑该声明的具体表述，reason 注「来源不支持」（A2，源自 jamoeight Citation Verifier 的 claim-support 审计）。

附加三件事：`uncovered_dimensions` 覆盖度审计（对照规划维度）、`overconfident` 过度自信标注、`needs_revision`+`blocking_issues` 修复环开关。尾部硬性要求块：未经抽查不得标 verified、reason 必须落到页面内容层面（A4 尾置技巧，源自 Silence-view recency 实践）。
设计依据：B1 双分支降级——提示词同时覆盖带/不带 web_fetch 的子代理工具世界，无需代码分支。

## 7. verifier-evidence（轻量证据验证，VERIFIER_SCHEMA）

synthesize=false 分支专用：对 evidence_state 中每条 confirmed 声明按同标准分类；needs_revision 在出现 refuted 或高危 unverified 时为 true（此时 status='failed'，无修订回环——没有报告可修）。

## 8. reviewer（对抗性审查，自由 Markdown）

三类审查分条列出、按严重度排序：①覆盖度审计（对照维度清单找缺失/浅尝辄止）；②矛盾并列（证据冲突未呈现处）；③过度自信标注（结论强于证据，含低质来源写得笃定处）。只提意见不改稿。审查对象在 synthesize=false 时退化为证据附录。

## 复现方式

所有提示词可在回归测试中逐字断言：`tests/regression.test.mjs` 的 vm 镜像把每个 `agent(prompt, opts)` 调用原样递给脚本代理工厂，`opts.label` 即上文各节名称（`planner / research:qN[-fM] / recon:bN / synthesizer[-revN] / verifier[-rN | -evidence] / reviewer`）。

## 9. 澄清策略（clarifyStrategy）设计依据

权威实现：`src/command.ts` 的 `buildResearchIntentMessage`（三态消息模板）＋ `src/index.ts` 的 `executeResearchCommand`（消息拼装）与 `parseClarifyStrategy`（配置白名单校验）。不属于提示词层，因此不写入 `src/script.ts`——入口消息约束的是"主 agent 是否/如何澄清"，各研究子代理提示词不涉及澄清。

三种策略与成本函数依据：

- `auto`（v1 兼容）：无条件"不明确就澄清 1–2 问"——成本高、易把可推断项转嫁给用户。
- `minimal`（默认）：**只在"缺失信息分叉答案空间"时问**——存在 ≥2 个合理且会显著改变研究范围的解释（对比基线、成功标准、决策主体约束）才允许 1 轮 1 个单选（带"跳过，用默认"、选项不锚定）；语言/产出形式/场景权重/深度等可推断项一律默认；已给 questions 时禁止再澄清。依据：访谈成本（一次打断，≈可忽略）vs 假设穷举成本（每个未收敛分叉 × 每分支检索预算，可达数百万 token）——分叉时 10 秒收敛 ≪ 穷举代价，可推断项反之。
- `never`：禁止访谈，缺失的决策信息降级为 `purpose` 研究假设，由 planner（见 §1 第 5 条要求）显式标注受假设约束的维度。

设计初衷（本会话实证）：v1 `auto` 默认导致主 agent 一次访谈 4 问、其中 3 问是可推断项（产出形式、场景权重、二次追问），仅对比基线 1 问有信息增量；本轮把"澄清"从无条件默认改为成本函数裁决，并允许命令级 `--clarify` 覆盖。
