# DSH Deep Research 插件 v2（Claude 工程骨架 × dsh 机制设计）

状态：已实现（本文档为 v2 架构规格）

> 本地址：`docs/spec/deep-research-hybrid.md`（本包 `docs/spec/` 目录下）

> 📝 **重生成版说明（2026-02 编码事故后）**：本文为基于完整会话记录的**重生成版**——凡标注「★原文」的段落为事故前原稿逐字保留；其余章节依据会话中确立的设计决策、现行实现与两轮审核台账忠实重建，措辞可能与原稿有出入但事实一致。若原稿副本日后寻获，可覆盖本版。

---

## 一、背景与动机

上游 `dsh-deep-research` v1 证明了"控制论 × 信息论"方法论可以落成可用的深度研究工具，但复审其实现后确认存在七条结构性短板：

1. **接缝失效**：使用 `ctx.workflows` 接缝，在当前 DSH 上无法加载（★原文见 Further Notes 兼容性定位）；
2. **质量保障可选且仅给意见**（`review: true` 输出审查文本，不强制修正），没有 Claude 式 verifier 的"声明必须可验证"强制约束（`verified / unverified / refuted` 状态机）；★原文
3. **无显式盲区/覆盖度机制**：覆盖度靠 lead 临场判断，没有"解析前先声明盲区、研究后验证盲区"的结构；★原文
4. **无后台执行**：同步阻塞等待，长任务不可交托；
5. **无预算上限**：单代理搜索次数与总代理数均无硬约束，成本不可控；
6. **一次性 parallel**：全部子问题一次投递，存在引擎 ITEM_CAP 致命失败风险；
7. **来源无去重、综合输入无精简**：上下文膨胀不可控。

对照 Claude Code 原生 deep-research：其工程骨架（orchestrator-worker、后台任务、verifier 状态机、Memory 文件交接、effort 伸缩）全面领先，但闭源不可定制、中文调研与机制透明度不足，且存在 verifier 误报缺陷（CHANGELOG L1208）。

**结论**：以 Claude 的**工程骨架**为地基，以 dsh 的**机制设计**为内核，在同一插件内吸收两者优点并规避两者短板。

## 二、目标与非目标

**目标**：
- G1 单工具 `deep_research` 自然语言触发（模型按描述调用，无 slash command）；
- G2 五阶段流水线 + 强制验证 + 有界修复环；
- G3 后台默认执行，完成通知 + 进度可观测；
- G4 产物宿主侧落盘 + 指针交付（正文不进工具返回值）；
- G5 全链失败隔离与诚实降级（绝不把未验证材料伪装成事实）;
- G6 编排逻辑为静态脚本，可被 vm 镜像 harness 整段回归。

**非目标**：不做可视化图表输出；`rawNotes` 原始片段增强缓行（开放项②）；不做多引擎抽象（绑定官方 workflow 引擎）。

## 三、用户故事

> 1. 作为 DSH 用户，我希望用一句自然语言让 agent 对复杂主题发起深度调研，无需了解编排细节。
> 2. 作为研究者，我希望看到规划的**答案空间**——范围边界、信息维度、每个子问题的关键词与验收标准——而非黑盒搜索。
> 3. 作为研究者，我希望多个子问题**并行检索**，且并发与总量受引擎上限约束、不会失控。
> 4. 作为研究者，我希望浅问题一轮收敛、深问题自动派发跟进，**轮次与预算有界**、零边际增益即停。
> 5. 作为研究者，我希望证据分**三态**呈现且每条承重声明带来源与置信度。
> 6. 作为研究者，我希望规划阶段**枚举信息维度并显式声明覆盖盲区**，盲区被定向侦察验证（信息可得→补研；不可得→写入"已验证盲区"），以便不把"不知道"藏起来。★原文
> 7. 作为研究者，我希望每个子问题研究返回**三态证据**（confirmed 带来源与置信度 / uncertain 带原因 / gaps 带优先级），以便证据纪律硬约束、不确定性不被掩盖。★原文
> 8. 作为 DSH 用户，我希望长任务**转入后台**，完成时收到通知，报告落盘、按需读取。

## 四、需求

### 4.1 工具入参

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topic` | string | 必填 | 研究主题；空串报错 |
| `purpose` | string | 无 | 研究用途——要支撑什么判断/决策（定义答案空间） |
| `questions` | string | 无 | 每行一个的已有问题清单；提供后跳过自动拆解 |
| `depth` | number | 2 | 1/2/3；决定研究轮次上限 `depth+1` 与每子代理搜索轮上限 LIMIT(depth)=2/3/4 |
| `synthesize` | boolean | true | false 时仅对中间证据轻量验证、不产报告 |
| `verify` | boolean | true | 强制 verifier 验证引用/声明 |
| `review` | boolean | false | 对抗性审查 |
| `background` | boolean | 取 backgroundMode | 后台经 ctx.jobs 执行 |
| `language` | string | zh | 报告语言 |

### 4.2 输出负载 schema（紧凑，最终 job 结算语义）

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "ok": { "type": "boolean", "required": true },
    "status": { "type": "string", "required": true },
    "runId": { "type": "string" },
    "jobId": { "type": "string" },
    "reportPath": { "type": "string" },
    "artifactsDir": { "type": "string" },
    "rounds": { "type": "integer" },
    "subquestions": { "type": "integer" },
    "completed": { "type": "integer" },
    "failed": { "type": "integer" },
    "verification": {
      "type": "object",
      "properties": {
        "status": { "type": "string" },
        "claims": {
          "type": "object",
          "properties": {
            "verified": { "type": "integer" },
            "unverified": { "type": "integer" },
            "refuted": { "type": "integer" }
          }
        },
        "issues": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  "required": ["ok", "status"]
}
```

status 词表：`completed | background | degraded`（不引入 `cancelled`，取消语义由 degraded/killed 表达——R1）。全量字段定义以 `docs/interfaces.md` 为权威。

## 五、方案设计

### 5.1 总纲（★原文）

> - **完整流水线**：规划代理（答案空间/维度/验收标准/覆盖盲区）→ 多轮并行研究（三态证据 + 边际增益收敛 + 队列不丢弃）→ 强制 verifier（引用/声明验证 + 有界修复环）→ 综合代理（率失真报告 + 不确定性保留）→ 可选对抗性审查。

### 5.2 服务接缝

`inject: ['tools', 'workflowEngine', 'jobs']`；编排经 `ctx.workflowEngine.start({ script, meta, args, parent, signal })`，后台经 `ctx.jobs.start(...)`。

### 5.3 取消态映射（R1 条目）

引擎 stopReason 映射：`completed → completed`；`cancelled → 前台 'degraded' 结构化降级负载 / 后台 jobs killed`；`error → 抛错(前台) / failed(后台)`。负载 status 词表不引入 `cancelled`。

### 5.4 模式差异（R2 条目）

后台模式下 execute() 仅即时返 `{ok, status:'background', jobId, runId}`；输出 schema 为最终 job 结算语义。

### 5.5 后台执行（jobs 桥，★原文 L126-139）

```js
ctx.jobs.start({
  kind: 'deep-research',        // JobKindMap 声明合并 → jobId 前缀 deep-research-N
  label,
  owner: exec.agent,
  outputLimitBytes?: number,
  run(): JobHooks
})
```

- `done` 在 run 结算后 resolve；`readOutput` 返回自 run 开始累计的进度文本（`workflow/phase|log` 事件喂入环形缓冲），job_output 可见。
- 宿主 `execute()` 在 `done` 落定后把落盘产物路径等写入 `output`（或靠 recorder 事件呈现）。
- 前台模式（`background: false` 或配置 backgroundMode='foreground'）：execute() 直接 `await ctx.workflowEngine.start(...).result` 再返回紧凑负载（小任务、脚本式调用，无 jobId）。
- 完成通知：jobs 会话完成监听向归属会话投递（含 runId/报告路径/验证状态摘要）；进度呈现复用引擎原生 `workflow/*` 事件（ADR-0001 #10 简化）。
- 取消传播：`exec.signal` → 宿主 `AbortController`，转交 `workflowEngine.start({ signal })`；引擎在信号中止时 cancel 整个 run 并中止全部子代理（共享 abort + 宽限强杀）。宿主桥接（`ac.abort`/`run.cancel`）为双保险，以引擎 signal 为准。

### 5.6 产物持久化（Claude 文件交接的宿主侧实现，★原文 L140-159）

> **核心决策（解决审核 A2）**：workflow 脚本**无 fs**，因此"文件交接"在本架构内**只能由宿主侧实现**。脚本内各阶段交接靠内存拼接；落盘两类用途：(a) 主代理交付指针；(b) 可观测/审计/复用产物。

```
<workspaceDir>/<sessionId>/<runId>/
  plan.json            # 答案空间/维度/子问题/盲区（含验收标准）
  rounds/<round>-<n>.json   # 每子问题三态证据（结构化）
  blindspots.json      # coverage_gaps 侦察结果（可得/不可得）
  report.md            # 综合最终报告
  evidence_state.md    # 原始证据附录（脚本内拼接中间态的副本落盘）
  verification.json    # 每引用/声明 状态 + 覆盖度审计 + 过度自信项
  review.md            # 可选对抗性审查意见
```

- 工具返回紧凑负载 + 指针；**全量报告文本不进 execute() 返回值**。
- **上下文膨胀的诚实处理**：缓解 = 研究阶段分批 + 综合输入结构化精简（confirmed 仅 claim+source+confidence，uncertain/gaps 仅要点）；仍超长允许分批产出章节（首版允许，非必做）。
- `workspaceDir` 默认 `<session-workspace>/.research`；per-session 子目录防串扰（C5）；`keepRuns` 默认 20 按 mtime 惰性清理。
- 可选增强 `rawNotes` 默认关（开放项②），不进入脚本运行时交接。

### 5.7 流水线状态机（★原文 L161-188）

> **验证环时序（解决审核 A3）**：单一时序——**先综合、后验证、再可选修订式回环**。

```
[规划] planner(PLANNER_SCHEMA)
   ├─ 无 questions：定义 scope + dimensions + questions[{question,dimension,keywords,acceptance}] + coverage_gaps
   └─ coverage_gaps → 盲区侦察任务并入研究队列（blind:true）

[研究 R1..Rn]  当 pending>0 且 round < depth+1
   ├─ 单轮 internal batching：切片大小 = min(maxParallel, maxItemsPerCall)，逐切片 parallel()
   ├─ 每子代理：初始最佳答案 → 预测高熵点(EIG) → 行动(web_search/web_fetch,先宽后窄,≤预算) → 更新三态证据 → 边际增益验证 → 零增益即停
   ├─ 轮末：high-priority gaps → follow-up 排入下一轮；超并发的子问题跨轮续研（绝不静默丢弃）
   └─ 收敛：无新 high 缺口 或 达轮次上限

[综合] synthesizer：率失真压缩 → report（摘要/背景/核心发现/不确定性/已验证盲区/结论/参考资料）
[验证+修复环]（verify=true；合成后统一跑；synthesize=false 改轻量验证、不产 report）
   verifier 对 report 逐承重声明分类 verified|unverified|refuted
   ├─ 通过 → verification.status='passed' → 结束
   ├─ 有 refuted/高危 unverified → 修订式重综合（仅改被点名节）→ 再 verifier，循环 ≤ verifierMaxRounds（默认 2）
   └─ 仍不收敛 → status='failed'，report 保留并显式标注 → 诚实降级交付
[审查]（review=true）reviewer：覆盖度审计 + 矛盾并列 + 过度自信标注
[返回] 宿主落盘全部产物 → 紧凑负载（含 verification.status）
```

### 5.8 验证明确（★原文 L190-200）

- verify 默认 true；单一时序；synthesize=false 时轻量验证、不产 report。
- 每承重声明产出 `{ claim, source, status, reason? }`。
- **B1 降级**：verifier 带 web_fetch 时抽查可达性/支撑性才给 verified；不带则退化为既有结果评估、不得声称实证抽查、无法核实标 unverified；refuted = 矛盾（不依赖联网）。
- 有界修复环 ≤ verifierMaxRounds（防官方"all claims refuted"误报缺陷）；每轮只修订被点名节。
- 终端降级：failed 也交付，未验证项显式标注，绝不伪装。
- 覆盖度审计并入 verifier/reviewer（Ashby 必要多样性落地）。

### 5.9 研究子代理契约（★原文 L202-206）

- `RESEARCHER_SCHEMA`：`{ confirmed:[{claim,source,confidence}], uncertain:[{point,reason}], gaps:[{aspect,priority}] }`（additionalProperties:false，仅引擎 schema 子集）。
- 提示词纪律：searchBudget（生效值再与 LIMIT(depth)=2/3/4 取小）+"先宽后窄"+ OODA 循环 + 来源分级 A/B/C/D +"只列实际访问过的来源；不可达→uncertain 而非编造"。
- 每子代理轮上限 `LIMIT(depth)`：depth=1→2、2→3、3→4。（评审优化轮 F4 落实。）

### 5.10 规划代理契约（★原文 L208-211）

- `PLANNER_SCHEMA`：`{ scope, dimensions[], questions[{question,dimension,keywords,acceptance}], coverage_gaps[] }`。
- 盲区声明 → 定向侦察，绝不静态接受/静默丢弃。

### 5.11 模型分层与配置（★原文 L213-221）

五角色 `plannerModel / researcherModel / synthesizerModel / verifierModel / reviewerModel` 缺省继承父路由；配置键 `maxParallel`(4)、`maxTotalAgents`(引擎默认)、`searchBudget`(6)、`verifierMaxRounds`(2)、`workspaceDir`(`<session-workspace>/.research`)、`backgroundMode`('background')、`keepRuns`(20)、`rawNotes`(false)。`args.models` 透传，`agent()` 仅支持 `label/phase/schema/provider/model`。

### 5.12 健壮性（★原文 L223-229）

失败隔离矩阵见 `docs/adr-architecture.md` D6；切片 B3；取消传播；纯 JSON 结果物化（RESULT_UNSERIALIZABLE 兜底）；事件可观测（原生 workflow/* + readOutput）。

---

## 六、测试策略

核心：vm 镜像引擎 harness（mock `agent/parallel/phase/log`）跑真实 SCRIPT，六场景——① 给 questions 跳规划单轮收敛；② high-gap 自动第 2 轮至边际增益为零；③ 无 questions 先规划、盲区侦察并入队列；④ 超 maxParallel 切片跨批不丢弃；⑤ 验证修复环（refuted→修订→通过 / 不收敛→degraded）；⑥ 紧凑负载形状与验证状态。现行 20 用例明细见 `docs/test-plan.md`。

## 七、范围与非目标

见 §二非目标；另：企业内部信息源接入依赖宿主工具世界，不在本插件范围内。

---

## Further Notes（★原文 L263-274）

- **兼容性定位**：本规格是 `@dsh-external/dsh-deep-research` 的 v2 架构（同包名，工具名 `deep_research` 兼容）。上游 v1 的 `ctx.workflows` 接缝在当前 DSH 上无法加载，v2 统一走 `ctx.workflowEngine`。
- **设计出处**：Claude 工程骨架（orchestrator-worker、后台任务、verifier `unverified/refuted` 状态机、文件交接防上下文膨胀、effort 伸缩）→ Anthropic 工程博客《How we built our multi-agent research system》与 Claude Code CHANGELOG、官方 Cookbook 研究代理提示词；dsh 机制（答案空间/验收标准、Ashby 维度与 coverage_gaps 盲区侦察、三态证据、EIG 边际增益收敛、率失真综合、对抗性审查、模型分层）→ 上游 `src/index.ts` 与 README。逐项对比见 `docs/references/methodology-comparison.md`（本包内）。
- **已落定的审核结论（对应 spec-review-report.md 的 A1/A2/A3/B1/B3/C3/C5）**：
  - A1：`ctx.jobs.start` 用 `run: () => JobHooks` 函数形态 + `JobKindMap` 声明合并（jobId 前缀 `deep-research-N`）+ `owner: exec.agent`；`inject` 含 `jobs`。
  - A2：脚本无 fs，交接仅宿主侧实现；脚本内综合/验证输入=内存拼接，落盘=可观测产物+指针。
  - A3：验证·修复环为单一时序（合成后验证 → 修订式综合回环 ≤ verifierMaxRounds）。
  - B1：verifier 核实手段依赖子代理是否带 web_fetch；不带则退化为 web_search 弱校验 + `unverified` 标注。
  - B3：研究阶段单轮 internal batching ≤ `maxItemsPerCall`（防 ITEM_CAP 致命失败）。
  - C3/C5：`inject` 补 `jobs`；产物目录加 `<sessionId>/` 子目录防串扰 + `keepRuns` 保留策略。
- **开放项**：② workflow 子代理默认工具世界是否含 `web_fetch`、及能否向其加 writable 工具启用 `rawNotes`（决定 B1 分支、rawNotes 是否可开）。其余开放项已在规格内给出确定行为。
