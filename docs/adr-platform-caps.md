# ADR-0001：平台接缝能力边界（platform caps）

- 状态：已采纳（Accepted）
- 日期：2026-02（T0 核验后定稿，T5 实现期复核）
- 关联：`docs/references/platform-seam-verification.md`（11 项假设逐条核验）、ADR-0002

## 背景

v1 上游以 `ctx.workflows` 接缝编写，在当前 DSH 上无法加载；v2 重写前必须把"我们假设平台有什么"变成"平台确实有什么"。T0 对 `deepseek-harness` 源码做了 11 项假设的逐条核验（结论：10 HOLD / 1 NEEDS-REVISION），本 ADR 记录被采纳为设计约束的平台事实。

## 决策（平台事实 → 设计约束）

### 工作流引擎（@deepseek-ai/dsh-workflow）

1. **启动请求**只有 `script / meta / args / subagentProvider? / maxTotalAgents? / parent / signal` 七个字段。`parent` 必填（所有子代理归属该活 Agent）；`signal` 中止即取消整个 run。
2. **脚本沙箱**仅暴露 `agent / parallel / pipeline / phase / log / args` 六个全局，无 fs、无网络、无 Node API。因此"文件交接"只能由宿主侧实现（见 ADR-0002 决策 D4）。
3. **`agent()` 选项**仅 `label / phase / schema / provider / model`；传 `effort/isolation/agentType` 直接抛 `UNSUPPORTED_OPTION`。模型分层只能靠 `model` 覆盖实现。
4. **schema 子集**：object 根，仅 `type/properties/required/additionalProperties/items/enum/const/oneOf`，无 pattern/format/数值边界。嵌套 object 的 `additionalProperties` 是 dsh-tools 类型层的硬约束——缺失即编译失败（T2 实测踩中）。
5. **`agent()` 失败语义**：子代理自身失败解析为 `null`（脚本侧 `.filter(Boolean)` 式处理）；基础设施故障（AGENT_START/AGENT_RESULT）与全部致命码（CANCELLED/AGENT_CAP/ITEM_CAP/…）是 fatal WorkflowError，穿透 combinator 杀死脚本。
6. **ITEM_CAP**：单次 `parallel()/pipeline()` items 数硬上限（默认 4096），超限即致命。⇒ 研究阶段必须切片（R3/B3）。
7. **取消是下一个 hook 边界**：cancel() 之后每个 hook 都抛 CANCELLED；脚本若吞掉一次也会在下一次 hook 再抛。⇒ 我们的脚本从不在 hook 外层 try/catch。
8. **返回值**必须纯 JSON（undefined 归一为 null），否则 RESULT_UNSERIALIZABLE 兜底。
9. **run 句柄**：`{ id, meta, result, cancel(), dispose() }`；`result` never rejects；`dispose()` 幂等且需最终调用。宿主判空用 `=== null`。
10. **事件面**：引擎原生发 `workflow/start|phase|log|agent-start|agent-end|end` 六个 Cordis 事件。⇒ 进度可观测直接复用原生事件（本插件不再自建 `deep-research/*` recorder，规格中的 recorder 设计被此事实简化掉）。

### 后台任务（@deepseek-ai/dsh-jobs）

11. `JobStart = { kind, label, outputLimitBytes?, owner?, run(): JobHooks }`；`run()` 在 preflight 后同步调用、恰好一次。
12. **`JobKindMap` 声明合并**扩展 kind；jobId 即 `<kind>-N` ⇒ 本插件声明 `'deep-research': 'deep-research'` 得到 `deep-research-N`。
13. `JobHooks = { cancel(reason?), done: Promise<JobOutcome>, readOutput?() }`；`done` 必须 resolve 不 reject；`readOutput` 为消费式游标（每次读增量）。
14. **NEEDS-REVISION 项**：jobs 终态只有 `completed | killed | failed`，没有 `cancelled`。⇒ 引擎 stopReason `cancelled` 映射到 jobs `killed`（R1 修订，spec 已同步）。
15. `owner` 必须是当前注册表中该 id 下的活 Agent 实例（即 `exec.agent`）；完成通知与会话围栏由 registry/controller 负责，插件不重复投递。
16. 后台可用性依赖 `@deepseek-ai/dsh-jobs-local` 实现 + controller 已挂载；preflight 拒绝时 `start()` 抛错。⇒ 宿主分支显式报错并提示 `background:false` 降级，不做静默降级。

## 后果

- 正面：全部接缝先核验后编码，实现期零"接缝惊吓"；两处规格假设（`cancelled` 终态、自建 recorder）被证伪并在编码前修正。
- 代价：核验结论绑定当前 harness 版本；升级 harness 时应重跑 `docs/references/platform-seam-verification.md` 的断言清单（其引用均带文件:行号）。
- 已知开放项（继承 spec）：workflow 子代理工具世界是否含 `web_fetch` 由组合决定——verifier 提示词按两种情况都写了降级行为（B1），无需代码分支。

> 注（编码事故重建）：本文件曾因 PowerShell 默认编码写入事故损坏，已从会话上下文逐字重建（内容与事故前一致，路径已更新为 docs/ 新结构）。
