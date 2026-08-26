# dsh-deep-research-hybrid（v2 设计文档包）

> 本目录是 **`@dsh-external/dsh-deep-research` v2** 的设计、实现与参考资料归集，配套 DSH（DeepSeek Harness）。
> 设计目标：以 **Claude 工程骨架**（后台执行、verifier 强制验证、文件/产物交接、有界生命周期）为地基，以 **dsh 机制设计**（答案空间、覆盖度盲区验证、三态证据、边际增益收敛、对抗性审查、模型分层）为内核。

> 注：目录名即 `dsh-deep-research-hybrid`（hybrid 拼写，与脚手架包名一致）。

## 目录结构

```
dsh-deep-research-hybrid/
├── README.md                      本导航
├── package.json / tsconfig.json / cordis.patch.yml
├── src/                           v2 实现（T1–T5）
│   ├── index.ts                   插件入口：deep_research 工具注册 + 参数校验 + 前台/后台分支
│   ├── script.ts                  RESEARCH_SCRIPT：plan→research→synthesize→verify→review 静态流水线
│   ├── background.ts              ctx.jobs 后台桥（kind 'deep-research'，取消传播，进度游标）
│   └── artifacts.ts               宿主侧产物落盘 + keepRuns 修剪
├── scripts/smoke.mjs              快速冒烟（vm 镜像引擎）
├── tests/regression.test.mjs      回归测试（20 用例，T6）
├── docs/                          全部文档（T7 + 规格 + 参考）
│   ├── adr-platform-caps.md       平台事实 → 设计约束（16 条）
│   ├── adr-architecture.md        架构决策 D1–D7 + 失败隔离矩阵 + 偏差注记
│   ├── interfaces.md              工具/Config/args/返回值契约
│   ├── agent-prompts.md           8 类提示词的设计依据映射
│   ├── setup.md                   安装 / 替换 v1 / 仓库内开发 / 配置示例
│   ├── test-plan.md               测试策略与用例清单
│   ├── artifacts.md               产物布局与语义
│   ├── spec/                      规格与两轮审核
│   │   ├── deep-research-hybrid.md    规格 v2 主文档
│   │   ├── spec-review-report.md      第一轮审核（A1/A2/A3/B1/B3/C3/C5）
│   │   └── spec-rereview-report.md    第二轮复审（D1 + R1–R7）
│   └── references/                研究与参考资料
│       ├── platform-seam-verification.md  平台接缝核验（11 项假设，T0 产物）
│       ├── implementation-tickets.md      工单计划 T0–T7 + 优化轮台账
│       ├── methodology-comparison.md      与 Claude 原生 deep-research 对比分析
│       ├── community-comparison.md        五个社区实现横评 + v2.x 候选清单
│       ├── upstream-v1/                   上游 v1 参考快照（ctx.workflows 接缝已废弃）
│       └── anthropic/                     Anthropic 官方一手材料（含 CHANGELOG 全量原件）
```

## 阅读顺序（建议）

1. `docs/spec/deep-research-hybrid.md` —— 功能、用户故事、实现决策、测试、范围（**主文档**）。
2. `docs/spec/spec-review-report.md` + `spec-rereview-report.md` —— 先看已知风险与已落定的修正。
3. `docs/references/methodology-comparison.md` —— 为何这么设计（范式同源、机制互补）。
4. `docs/adr-architecture.md` + `docs/interfaces.md` —— 实现如何落地、如何对接（集成者从这里进）。
5. `src/` + `tests/` —— 当前真实实现与回归；`docs/references/upstream-v1/` —— 历史参考。
6. `docs/references/anthropic/` —— 验证/后台任务的官方依据。

## 关键约束速记（已写入规格）

- 服务接缝：`inject: ['tools', 'workflowEngine', 'jobs']`；引擎用 `ctx.workflowEngine.start(...)`，后台用 `ctx.jobs.start(...)`（需 `@deepseek-ai/dsh-jobs-local`）。
- 脚本沙箱**无 fs/网络**：落盘仅宿主侧；脚本内综合/验证输入=内存拼接。
- 验证环单一时序：合成后验证 → 修订式综合回环 ≤ `verifierMaxRounds`。
- 研究阶段单轮 internal batching ≤ `maxItemsPerCall`（防 ITEM_CAP 致命失败）。
- 五角色模型分层：planner / researcher / synthesizer / verifier / reviewer。

## 实现进度（T0–T7 + 两轮评审全部完成）

- ✅ **T0 平台接缝核验**：`docs/references/platform-seam-verification.md`（11 项假设，10 HOLD / 1 NEEDS-REVISION 已修正）。
- ✅ **T1–T5 实现**：脚手架 / 工具注册校验 / 流水线 SCRIPT / 产物落盘 / 后台 jobs——详见工单文件各节实现注记。
- ✅ **T6 回归测试**：`tests/regression.test.mjs`（20 用例全绿）；快速冒烟 `node scripts/smoke.mjs`。
- ✅ **T7 文档**：`docs/` 七份 + 规格迁移，ADR-0002 D7 如实标注偏差（现余 recorder 一处）。
- 🔁 **评审后优化轮**：双轴 code-review 的 P0–P2 全部落地——前台取消改结构化 `degraded` 负载（R1）、`verification.issues` 进输出负载、status 白名单校验、LIMIT(depth) 落实、DEFAULTS/resolveConfig 集中、证据归约去重、状态类型收口。
- 📌 **命名豁免声明**：包名 `@dsh-external/dsh-deep-research` 与裸 `cordis` peerDep 有意偏离 harness `AGENTS.md:101` 的 monorepo 约定——本包是 monorepo 之外的独立交付物（spec 自始定名），裸 `cordis` 沿上游 v1 生态惯例、经 node_modules junction 映射到 vendored `@deepseek-ai/cordis`。
- 🧹 **研究存档已收编退役**：原项目根 `.research/`（≈54MB 克隆存档）与 `.specs/`（旧快照）已清理；被引权威件先行入库 `references/anthropic/`（含 CHANGELOG **全量原件**），明细见工单文件「研究存档清理」。
- 🔍 **社区实现批判性研读已完成**：dzhng / wshuyi / jamoeight / Silence-view / stevenirby 五个开源 deep-research 实现逐文件通读，蒸馏为 `docs/references/community-comparison.md`；其中 **A1–A5 prompt 层改进已落地**（检索目标行、引用失真=refuted、验活配额、硬性要求尾置、先验知识纪律）。liangdabiao 地址失效缺席。

常用命令：`npm run build`（tsc -b 类型检查+产物）、`npm test`（回归测试；受限环境下可 `node tests/regression.test.mjs` 进程内运行）。

> ⚠️ 编码事故记录（2026-02）：结构重组期间 PowerShell 默认编码写入曾损坏本 README 与另外 7 个文档的中文内容；其中 5 个已从会话上下文逐字重建，**3 个（spec 主文档 / methodology-comparison / rereview-report）已按用户指示基于会话记录完整重生成**（各文件头注标明「重生成版」及原文保留段标记，非原稿逐字恢复）。环境守则已写入 `docs/test-plan.md` §4。
