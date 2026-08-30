# 接口契约（interfaces）

> 与实现同步维护：`src/index.ts`（工具/Config）、`src/script.ts`（args/返回值）、`src/background.ts`（jobs 桥）、`src/artifacts.ts`（落盘）。本文档描述 v2.0.0 的实际行为。

## 1. 插件面

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-deep-research`（v2.0.0，private；github.com/cireric/dsh-deep-research） |
| 插件名 | `dsh-deep-research` |
| inject | `['tools', 'jobs', 'commands']`（workflowEngine 为**调用期**能力：官方 preset 把引擎 isolate 在会话 delegation 组内、root 与 agent 根 ctx 均无实例，加载期注入会使 root 挂载条目永久 pending。调用期经 `resolveWorkflowEngine` 三链解析：① `serviceForAgent(ctx, parent, 'workflowEngine')`（官方 READ 寻址 preset standing mount，命中 isolate 组实例）→ ② `exec.agent.ctx.get('workflowEngine')` → ③ host 平面 `ctx.get`；全部缺失时报明确错误） |
| bundle patch | `cordis.patch.yml`（由 package.json `dsh.bundle.patch` 声明，向 profile 插入一行） |

## 2. 工具 `deep_research`

### 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topic` | string（必填） | — | 研究主题；空串报错 |
| `purpose` | string | 无 | 研究用途（定义答案空间） |
| `questions` | string | 无 | 每行一个的已有问题清单；非空时跳过规划代理。行首列表编号仅在无歧义时剥离：点号编号须后跟空白（防误伤 "3.14 是什么"），顿号/右括号可省空白 |
| `depth` | number | 2 | 1/2/3；>3 报错；决定自适应轮数上限 depth+1 |
| `synthesize` | boolean | true | false 时跳过综合代理，仅轻量验证证据、不产报告 |
| `verify` | boolean | true | false 跳过验证环 |
| `review` | boolean | false | 对抗性审查 |
| `background` | boolean | 取 Config.backgroundMode | 后台经 ctx.jobs 执行 |
| `language` | string | 'zh' | 全程写作语言 |

### 输出负载（schema additionalProperties:false）

```
{ ok, status: 'completed' | 'background' | 'degraded',
  runId?, jobId?, reportPath?, artifactsDir?,
  rounds, subquestions, completed, failed,
  verification: { status, claims: { verified, unverified, refuted }, issues: string[] } }
```

- **前台**：status='completed'；`reportPath/artifactsDir` 在落盘成功时出现（失败则省略——schema 不允许额外告警字段，产物缺失如实反映为无指针）。引擎 stopReason='cancelled' → 结构化降级负载 `{ok:false, status:'degraded', runId}`（R1，评审 F1），不再抛错；'error' → 抛工具错误并携带引擎信息。`verification.issues[]` 随负载返回——failed/unavailable 时主代理就地可读必修点，无需先读落盘文件（评审 F2）。
- **后台**：立即返回 status='background' + jobId/runId；完成通知由 jobs controller 投递，detail 为 finalize 摘要行 `status=… rounds=… completed=…/failed=… report=<路径>`。

### Config 键

`subagentProvider? / plannerModel? / researcherModel? / synthesizerModel? / verifierModel? / reviewerModel?(缺省=synthesizerModel) / maxParallel(4) / maxTotalAgents?(不写请求则用引擎默认) / searchBudget(6；生效预算再与 LIMIT(depth)=2/3/4 取小) / verifierMaxRounds(2) / maxItemsPerCall(4096) / workspaceDir?(默认 <session.header.cwd>/.research) / backgroundMode('background') / keepRuns(≥1,默认20) / rawNotes(保留,no-op)`
非法整数一律抛错；模型键仅在显式配置时写入 `args.models`。

## 3. SCRIPT args 注入契约（宿主 → 脚本）

```
{ topic, purpose?, questions?: [{question}],        // questions 已解析为对象数组
  depth, synthesize, verify, review, language,
  searchBudget, maxParallel, verifierMaxRounds, maxItemsPerCall,
  models?: { planner?, researcher?, synthesizer?, verifier?, reviewer? } }
```

## 4. SCRIPT 返回值契约（脚本 → 宿主 shapeScriptResult 收窄）

```
{
  report: string                  // Markdown 正文（synthesize=false 时为 ''）
  report_note: string             // 综合降级原因等
  review: string                  // 审查意见（未启用/失败为 ''）
  rounds, subquestions, completed, failed: number
  plan: { scope, dimensions[], questions[{id,question,dimension,keywords[],acceptance}],
          coverage_gaps[], source: 'planner'|'provided' }
  items: [{ id, question, round, blind, ok, error,
            obtainable?|null, reason?,          // 仅盲区项
            evidence: { confirmed[{claim,source,confidence}], uncertain[{point,reason}], gaps[{aspect,priority}] } }]
  dropped_by_cap: [{ id, question }]   // 达轮次上限未派发的跟进项
  blindspots: [{ gap, obtainable, reason }]
  evidence_state: string               // 综合输入副本（落盘 evidence_state.md）
  verification: {
    status: 'passed'|'failed'|'skipped'|'unavailable'   // verify=false → skipped
    claims: { verified, unverified, refuted }
    issues[] / uncovered_dimensions[] / overconfident[{claim,reason}] / revision_rounds
  }
}
```

宿主对缺失/漂移字段的防御：数字归 0、数组归 []、字符串归 ''，verification.status 兜底 'unknown'；`plan` 缺失兜底 `null`（不再让单字段缺失放大为整批落盘失败）。

`verification.status='failed'` 的场景语义：synthesize=true 时表示修复环耗尽仍未收敛；synthesize=false（R4 轻量分支）时表示验证判定证据不可接受、该分支不提供修订。两态共用词表是既定取舍，明细一律以 `issues[]` 为准。

## 5. 后台桥（startBackgroundRun）

- `jobs.start({ kind:'deep-research', label:'深度研究：<topic>', owner: exec.agent, run })` → jobId `deep-research-N`
- JobHooks：`cancel()` 双保险中止；`done` 按引擎 stopReason 结算 completed/killed/failed；`readOutput()` 消费式游标输出环形缓冲（≤400 行，按 runId 过滤 `[run]/[phase]/[log]/[agent-start]/[agent-end]/[warn]` 行）
- preflight 拒绝（如 dsh-jobs-local 未挂 controller）→ execute() 显式抛错并提示 `background:false`

## 6. 产物目录

见 `docs/artifacts.md`。指针语义、保留策略与失败语义亦在该文档。
