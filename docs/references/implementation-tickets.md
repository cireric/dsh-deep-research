# 实现工单计划（deep-research-hybrid v2）

> 来源：spec `docs/spec/deep-research-hybrid.md` 的 Further Notes + 复审修订（R1–R4、A1–A3、B1–B3）。
> 风格：每张工单自包含、声明 blocking edges，blocker-first 推进。

## 依赖前置（T0，✅ 已完成）
- **T0 平台接缝核验**：见 `docs/references/platform-seam-verification.md`。11 项假设 10 HOLD、1 小修。对实现的关键修正注记：
  - 取消态：引擎无 `cancelled` 终态，取消以 `killed` 表示；本负载 `status` 不引入 `cancelled`，统一归 `failed`/`degraded`（spec 已同步）。
  - `readOutput` 在 `JobHooks` 中为**可选**字段。
  - `owner` 是**活的 Agent 实例**（`exec.agent`）。
  - `subagentProvider` 引擎默认 `'spawn'`；否则 `start()` 抛 `AGENT_START`。
  - `WorkflowResult.value` 无值时为 `null`（宿主侧判空用 `=== null`）。
  - `web_fetch`/`web_search` 默认对 workflow 子代理可见；`ITEM_CAP` 默认 **4096**。

## 工单

### T1 脚手架（Scaffold）✅ 已实现
- **产物**：`package.json`（`@dsh-external/dsh-deep-research`，peerDeps 含 dsh-agent）、`cordis.patch.yml`、`tsconfig.json`（erasable-only）。
- **实现注记**：仓库内建 `node_modules/` 目录联接对齐 harness 依赖后 `tsc -b` 全绿。
- **blocking**：无。

### T2 工具注册 + 参数校验 ✅ 已实现
- **实现注记**：输出 schema 嵌套对象必须显式 `additionalProperties:false`（dsh-tools 类型层硬约束）。
- **验收**：✅ 编译通过；空 topic / depth>3 前置拒绝。
- **blocking**：T1。

### T3 静态 SCRIPT 流水线 ✅ 已实现
- **产物**：`src/script.ts`（String.raw 嵌入，脚本体内禁用反引号模板）。
- **实现注记**：① 切片逐批 parallel()（R3/B3）；② fatal WorkflowError 不吞、子代理失败归档 ok=false；③ R4 分支轻量验证；④ 盲区侦察 RECON_SCHEMA；⑤ 修复环 ≤ verifierMaxRounds，verifier 失败→unavailable。
- **blocking**：T2、T0。

### T4 宿主侧产物落盘 ✅ 已实现
- **产物**：`src/artifacts.ts`。
- **实现注记**：sanitize 防串扰与穿越（C5）；workspaceDir 缺省取父会话 cwd 下 `.research`；keepRuns 按 mtime 修剪；落盘失败不翻终态。
- **blocking**：T2。

### T5 后台执行（ctx.jobs）✅ 已实现
- **产物**：`src/background.ts` + 入口 JobKindMap 合并。
- **实现注记**：R1 终态映射 completed/killed/failed；取消双保险；readOutput 消费式游标（400 行环形缓冲按 runId 过滤）；finalize 失败仅告警；onRunStarted 同步回传 runId；preflight 拒绝显式报错提示降级。
- **blocking**：T2、T3、T0。

### T6 回归测试 harness ✅ 已实现
- **产物**：`tests/regression.test.mjs`（stripTypeScriptTypes + data-URL 动态导入真实 SCRIPT）；`scripts/smoke.mjs` 快速冒烟。
- **运行方式**：`npm test`；受限环境进程内等价 `node tests/regression.test.mjs`。
- **blocking**：T3、T4、T5。

### T7 补文档 ✅ 已实现
- **产物**（`docs/`）：adr-platform-caps / adr-architecture / interfaces / agent-prompts / setup / test-plan / artifacts。
- **验收**：✅ 与实际实现一致；含两处如实标注偏差（后经评审优化轮消除一处）。
- **blocking**：T3、T5。

## 推进顺序（blocker-first）
T0 ✅ → T1 ✅ → T2 ✅ → {T3 ✅, T4 ✅} → T5 ✅ → T6 ✅ → T7 ✅ → **评审后优化轮 ✅** → 研究存档清理 ✅ → 社区横评落地 A1–A5 ✅。
后续候选（非工单）：活环境加载验收与真实 LLM 端到端（见 docs/test-plan.md §5）。

## 评审后优化轮（code-review P0–P2，全部完成 ✅）

| # | 级别 | 内容 | 落点 |
| --- | --- | --- | --- |
| F1 | P0 | 前台取消 → 结构化 `{ok:false, status:'degraded', runId}`（R1 对齐）；error 维持抛错 | src/index.ts |
| F2 | P0 | 输出 schema 增补 `verification.issues[]` 并随负载返回 | src/index.ts |
| F3 | P1 | verification.status 白名单校验 | src/index.ts |
| F4 | P1 | LIMIT(depth) 落实：agentBudget=min(searchBudget, 2/3/4) | src/script.ts |
| F5 | P1 | README 命名/依赖豁免声明 | README.md |
| F6 | P2 | DEFAULTS + resolveConfig() 显式解析 | src/index.ts |
| F7 | P2 | collectEvidence 共享证据归约 | src/script.ts |
| F8 | P2 | VerificationStatus / RunStatus 类型收口 | artifacts.ts / index.ts |

**明确不做**：dropped_by_cap 改名（契约波及>收益）；删除 rawNotes（保留 spec 开放项②锚点）。

## 研究存档清理（用户确认范围 ✅）

- **删除**：`.specs/` 整目录；`.research/` 整目录——零引用大块头 claude-code(22MB)/anthropic-skills(14MB)/rohitg00-toolkit(2.4MB)、空目录 npm-claude-code、五个社区克隆、v1 原始克隆 dsh-deep-research（包内 upstream-v1 为整理版）、冗余源稿 methodology 源稿。合计 ≈54MB。
- **收编先行**：CHANGELOG 全量原件（545.9KB）→ `docs/references/anthropic/claude-code-CHANGELOG-full.md`；支持文档 → `docs/references/anthropic/use-research-on-claude.md`。
- **引用改写**：methodology 出处行与四条一手来源注记改指包内路径。
- ⚠️ **遗留审计项（当日已补课）**：五个社区仓库收集期仅扫读过 README、实现级研读从未进行——用户追问后当日经 git 通道重取并完成逐文件研读，产出 `community-comparison.md`（liangdabiao 地址失效缺席）。

### 社区横评落地：A1–A5 prompt 层改进（✅ 已实施）

| # | 改动 | 出处 |
| --- | --- | --- |
| A1 | 每次检索前强制写「检索目标」行 | dzhng researchGoal 双段式 |
| A2 | refuted 判据扩展「引用失真」 | jamoeight Citation Verifier |
| A3 | web_fetch 验活配额化 | stevenirby/jamoeight |
| A4 | 关键指令尾置「硬性要求」块（planner/recon/synthesizer/verifier） | Silence-view recency 实践 |
| A5 | 先验知识纪律（初始答案未证实不入 confirmed；综合禁引证据外事实） | stevenirby [UNVERIFIED] |

**验证**：smoke 通过；回归 20/20。文档同步 agent-prompts.md。

## 结构重组（docs 归拢）

spec/ 与 references/ 移入 docs/ 下（docs/spec/、docs/references/），根目录回到 DSH 插件惯例形态（src/tests/scripts/docs + 配置五件套）；新增 LICENSE 与 .gitignore。

## 编码事故记录（2026-02，结构重组期间）

PowerShell `Set-Content` 默认编码把 8 个含中文的 md 写坏（UTF-8 被 ANSI 误读，中文大量不可逆替换）。处置：
- 完好 14 个 md 未受影响；
- **从会话上下文逐字重建 5 个**：本工单、README、adr-platform-caps、adr-architecture、test-plan（内容与事故前一致，路径为新结构）；
- **基于会话记录完整重生成 3 个**（用户确认）：`docs/spec/deep-research-hybrid.md`、`docs/references/methodology-comparison.md`、`docs/spec/spec-rereview-report.md`——各文件头注标明「重生成版」：事故前原文段落逐字保留并标「★原文」，其余章节按会话确立的事实与现行实现忠实重建（措辞非原稿逐字）。若外部寻获原副本可覆盖恢复。
- 环境守则已写入 test-plan §4：禁止 Set-Content/Get-Content 处理含中文文件。
