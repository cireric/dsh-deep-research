# 测试计划（test-plan）

## 1. 策略

三层，自内向外：

1. **vm 镜像引擎回归（主）**：`tests/regression.test.mjs` 以与 `@deepseek-ai/dsh-workflow-worker-thread` 相同的方式包装 SCRIPT——`(async () => { … })()` + 新建 contextified 全局，只暴露 `agent/parallel/pipeline/phase/log/args`，parallel 逐 thunk 溶解为 null。子代理用脚本化工厂假体按 `label` 分发。**被测对象是真实静态 SCRIPT 常量**（经 stripTypeScriptTypes 动态导入），不是复刻品。
2. **宿主桥单测**：jobs 桥（fake registry/engine/ctx）与落盘模块（临时目录真实 fs）直接实例化验证。
3. **快速冒烟**：`scripts/smoke.mjs` 单场景端到端（规划→两轮研究→综合→修复环→审查），用于改脚本后的秒级反馈。

未覆盖（诚实声明）：真实 LLM/真实 web 工具的端到端质量、长上下文综合的实测体积（原规格开放项③④）、`dsh plugin add` 的加载验收、宿主 `execute()` 前台降级分支与 schema 扩展（评审 F1/F2/F3 —— vm 镜像只覆盖 SCRIPT 与 jobs 桥层，宿主路径靠 tsc 门禁 + 活环境首跑）——见 §5。（2026-08-30 已做首次活环境 E2E：调用期引擎解析（serviceForAgent 三链）修复后真实调用跑通流水线直至工具墙超时。）

## 2. 用例清单（全绿；`tests/regression.test.mjs` + `tests/command.spec.mjs` 合计，以 `npm test` 实测数为准）

### 流水线场景（T6 规格 + 评审后优化 ⑦）

| # | 用例 | 断言要点 |
| --- | --- | --- |
| ① | 给 questions 跳规划 | planner 零调用；q1/q2 直研；rounds=1；plan.source='provided' |
| ② | high-gap 自适应第 2 轮 | q1-f1 派发；rounds=2 < 上限 4；零增益不再派发；无重复派发 |
| ③ | 无 questions 规划+盲区 | planner 先行；recon:b3 入队；obtainable=false 落 blindspots；"已验证盲区"uncertain 记录 |
| ④ | 超并发切片不丢弃 | parallel 切片恰为 [2,2,1]（maxParallel=2）；completed=5；failed=0 |
| ⑤a | 修复环通过 | refuted→synthesizer-rev1→verifier-r2；report 替换为修订版；status='passed'；revision_rounds=1 |
| ⑤b | 有界不收敛 | verifierMaxRounds=0：零修订即 'failed'；报告保留 |
| ⑤c | verifier 崩溃降级 | agent 返回 null → status='unavailable' + issues 注记；run 不失败 |
| ⑥ | 紧凑负载形状 | 13 个契约键齐全；items 键齐全；verification.status 词表；纯 JSON 往返幂等 |
| ⑥b | synthesize=false（R4） | synthesizer 零调用；verifier-evidence 代替 post-report verifier；evidence_state 保留 |
| ⑦ | 单代理预算 min(searchBudget, LIMIT(depth)) | depth=1→"不超过 2 次"；depth=3+budget5→4；depth=2+budget2→2 |

### T5 后台桥

kind/owner/同步 hooks；completed 结算含 finalize 摘要、监听卸载、dispose 恰一次；cancelled→killed（R1）；error→failed 带引擎信息；cancel() 双保险（signal.aborted + run.cancel）；readOutput 游标（增量消费、跨 run 过滤、排空为空）；finalize 抛错不翻终态；预中止信号直达引擎。

### T4 落盘

sanitize 后路径 = `<base>/<安全 sessionId>/<安全 runId>`；七类文件按布局生成；rounds/N-M.json 按 round 内序号；空 review 不产 review.md；keepRuns=2 修剪最旧；workspaceDir 解析（显式优先 / 默认拼 `.research`）。

### 评审修复回归（review-fix batch）

| 用例 | 断言要点 |
| --- | --- |
| plan 缺失降级 | `persistArtifacts(plan: undefined)` 不抛错：report.md 照常落盘、plan.json 写为 JSON null（单字段缺失不再放大为整批落盘失败） |
| 全点段穿越加固 | sessionId/runId 为 `..`/`...` 时归占位符 `unnamed`，产物目录不越出 workspace 根 |
| 问题编号无歧义剥离 | 点号+空白/顿号/右括号剥离；"3.14 是什么"、"2.0版本…"、紧凑 "1.甲" 均原样保留（旧实现误剥小数前缀） |

### 接缝静态断言

入口文件声明 `interface JobKindMap { 'deep-research': 'deep-research' }`。

## 3. 运行方式

```bash
npm test                        # node --test tests/
node tests/regression.test.mjs  # 进程内等价（受限沙箱无 spawn 权限时）
npm run smoke
npm run build                   # bash scripts/build.sh（链接 harness 依赖 + tsc -b 类型门禁 + lib/index.js 垫片；先于此计划任何改动）
```

## 4. 变更守则

- 改 `src/script.ts`：先跑 smoke 再跑全套；新增分支必须补对应 label 的假体与断言（保持 23+N 全绿）。
- 改宿主桥/落盘：相应 fake 或 tmpdir 用例同步扩展。
- 升级 harness：重跑 `docs/references/platform-seam-verification.md` 断言清单（ADR-0001 的平台事实可能漂移，尤其 jobs 终态词表与 schema 子集）。
- ⚠️ 环境守则：本机 PowerShell 默认编码非 UTF-8——**禁止用 Set-Content/Get-Content 处理含中文文件**，一律使用会话 write/edit 工具或显式 `[System.Text.Encoding]::UTF8`（2026-02 编码事故教训，见工单「编码事故记录」）。

## 5. 待活环境验收（后续）

- `dsh plugin add` 加载后工具注册、inject 服务齐备（`['tools', 'jobs', 'commands']`；workflowEngine 为调用期能力，不参与加载期 inject）；
- ✅ 已验收（2026-08-30 活环境首跑）：调用期引擎解析（serviceForAgent 三链）真实命中会话 delegation 组引擎，流水线真实执行；
- 真实后台链路：jobId 通知到达会话、detail 摘要可读；
- 子代理默认工具世界是否含 `web_fetch`（决定 verifier 走强/弱核实分支，行为两侧均已实现并有提示词约束）。
