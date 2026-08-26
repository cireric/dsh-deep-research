# ADR-0002：v2 架构决策（Claude 工程骨架 × dsh 机制设计）

- 状态：已采纳（Accepted）
- 日期：2026-02
- 关联：ADR-0001（平台事实）、`docs/spec/deep-research-hybrid.md`、`docs/references/methodology-comparison.md`

## 背景

用户需要同一插件内同时吸收 Claude 原生 deep-research 的工程骨架与 dsh v1 的机制设计，并规避两者短板（v1：质量保障可选且不给意见、无强制验证、无盲区结构；Claude：验证误报风险、上下文膨胀）。形态决策已由用户拍板：做成 **DSH 插件（Cordis）而非 skill**；触发方式为**模型按描述自然语言触发的工具**（无 slash command）。

## 决策

### D1. 单工具入口 + 静态 SCRIPT

对外仅暴露一个 `deep_research` 工具；编排逻辑是**一个静态脚本常量**（`src/script.ts` 的 `RESEARCH_SCRIPT`），经 `ctx.workflowEngine.start({ script, meta, args, parent, signal })` 执行。
理由：静态脚本是引擎 vm 沙箱的唯一合法形态；把全部编排放进一个可被 vm 镜像 harness 原样执行的字符串，使回归测试不需要 mock 宿主（T6 的直接收益）。

### D2. 五阶段流水线 + 单一验证时序（A3）

`规划 → 研究(自适应闭环) → 综合 → 验证(+有界修复环) → 可选审查`。验证只有一条时序：**合成后统一跑 verifier；不通过则修订式重综合（只改被点名节）再验，循环 ≤ `verifierMaxRounds`(默认 2)**；耗尽→`verification.status='failed'` 诚实降级交付，绝不阻塞。verifier 自身失败→`unavailable`（同样降级）。
`synthesize=false` 时走 R4 分支：跳过综合代理，对中间证据做轻量验证、不产 report。

### D3. dsh 机制内核

- **答案空间**：规划代理产出 scope/dimensions/questions(keywords+acceptance)/coverage_gaps；
- **盲区不静默**：coverage_gaps 变成 `blind:true` 队列项，由侦察代理判定 obtainable 并落盘 blindspots.json；
- **三态证据**：confirmed{claim,source,confidence} / uncertain{point,reason} / gaps{aspect,priority}；
- **边际增益收敛**：轮末收集新增 high 缺口作 follow-up，去重后为空或达 `depth+1` 轮上限即收敛；
- **率失真综合**：综合输入为脚本内拼接的精简证据（confirmed 仅三元组、uncertain/gaps 仅要点），副本落盘 evidence_state.md（A2）；
- **模型分层**：五角色 model 覆盖经 `args.models` 透传给各 `agent({model})`。

### D4. 文件交接 = 宿主侧专属（A2）

沙箱无 fs（ADR-0001 #2），因此：脚本内所有阶段交接靠内存；落盘由宿主在 run 结束后一次性写入 `<workspaceDir>/<sessionId>/<runId>/`（T4）。工具返回紧凑负载只带 `reportPath/artifactsDir` 指针，报告正文不进工具返回值——防即时膨胀，最终交付由主代理按需 read。

### D5. 后台默认、前台可选

`backgroundMode` 默认 `'background'`：execute() 经 `startBackgroundRun()` 同步注册 jobs 任务后立即返回 `{ok,status:'background',jobId,runId}`（R2）；研究完成由 jobs controller 向归属会话投递通知（含 finalize 摘要行：状态/轮次/成败/报告路径）。取消传播双保险：`exec.signal → AbortController → 引擎 signal`，hooks.cancel 再直调 `run.cancel()`。jobs 不可用时显式报错并提示降级路径，不做静默降级。

### D6. 失败隔离矩阵

| 失败点 | 行为 |
| --- | --- |
| 单个研究子代理失败/空输出 | 该节归档 ok=false（"研究失败"），run 继续 |
| 盲区侦察失败 | 同上，盲区记为未决 |
| 规划代理失败 / 零子问题 | 抛错终止（规格明确：规划失败=硬错误，可调参重试） |
| 综合代理失败 | 脚本侧拼装"降级报告"+report_note，run 继续 |
| verifier 失败 | status='unavailable' 降级交付 |
| 修复环耗尽 | status='failed' 降级交付 |
| 引擎 error / 取消 | error：宿主抛错（前台）/ 映射 failed（后台）；取消：前台结构化 `degraded` 负载（R1/F1）/ 后台 killed |

### D7. 已知简化（与 spec 的偏差注记）

1. 规格的 `deep-research/*` 自建 recorder 简化为直接复用引擎原生 `workflow/*` 事件（ADR-0001 #10）+ job readOutput 进度流。
2. `rawNotes` 配置键保留但 v2.0 为 no-op（依赖 writable 工具世界，spec 开放项②）。

> 修订记录（评审后优化轮）：原偏差「LIMIT(depth) 未实现」已落实为 `agentBudget = min(searchBudget, LIMIT(depth))`（src/script.ts，回归 ⑦）；前台取消改为结构化 `degraded` 负载（D6 表同步）。

## 后果

- 正面：编排可整段回归测试；质量保障强制且诚实降级；上下文膨胀有三重缓解（分批切片、证据精简、指针交付）。
- 代价：脚本字符串不可 import 复用（vm 形态固有）；宿主桥接层（T4/T5）承担了 Claude 式"文件交接/后台任务"的全部工程量。

> 注（编码事故重建）：本文件曾因 PowerShell 默认编码写入事故损坏，已从会话上下文逐字重建（内容与事故前一致，路径已更新为 docs/ 新结构）。
