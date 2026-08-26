# 审核报告 — `.specs/deep-research-hybrid.md`

审核对象：`.specs/deep-research-hybrid.md`（v2 架构，Claude 工程骨架 × dsh 机制）

**审核方法**：不评价写作风格，只反向核对规格中每个**技术断言**是否与 DSH 平台实际源码能力吻合；凡引用了接缝的地方，回查对应包的 `src/` 类型/契约。已核对的源码：`packages/workflow/workflow`（index/types/runtime-types）、`workflow-worker-thread`（runtime/host/types）、`jobs`（jobs/types）、`subagent/tool-subagent`（index）、`web/tool-web`（index/search/fetch）。

**总体结论**：设计方向正确，可实施性高。但存在 **3 处硬错误**（会导致实现受阻或行为不符）、**2 处高风险歧义**（需在实现前决定）、若干**遗漏**与**文字瑕疵**。审核不通过之前，应优先修订硬错误与歧义。

---

## A. 硬错误（必须修正，否则实现受阻或不符）

### A1. `ctx.jobs.start(...)` 的 kind / 返回契约描述不准确
规格 §后台执行 写作：
> `execute() 默认把 workflow run 包进 ctx.jobs.start({ kind: 'deep-research', label, owner: parent, run })`

- **`run` 是函数不是对象**：`JobRegistry.start(spec: JobStart)` 的 `run(): JobHooks` 是一个**同步返回 hooks 的函数**，不是直接传入 workflowEngine 对象。正确用法：`run: () => { const ctl = new AbortController(); const run = ctx.workflowEngine.start({...signal: ctl.signal}); return { cancel: r => ctl.abort(r), done: settle(run), readOutput: ... } }`（对照 `tool-subagent` execute 的 `run: () => {...}` 形态）。规格写成 `{ kind, label, owner, run }` 且把 `run` 当对象字段，虽同形但易误读为"传 engine 对象"。
- **`jobId` 前缀**：规格输出 schema 示例写 `"jobId": "subagent-…"`——**错误**。本插件的 job kind 是 `deep-research`（`ctx.jobs` 的 id 用 `<kind>-N`），id 应为 `deep-research-1`。kind 可扩充：`JobKindMap` 是 merge-extensible（声明合并），插件须 `declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { 'deep-research': 'deep-research' } }`，**规格未提此声明合并步骤**——缺了它 `kind: 'deep-research'` 会类型失败。
- **`owner: parent` 语义**：`JobStart.owner` 是"当前注册在 agent id 下的 live agent"，用于会话域 fence 与 owner 销毁时取消/结算。execute() 的 `parent = exec.agent` 是否等于注册实例需确认（`tool-subagent` 同样传 `owner: parent`，可沿用，但规格应写明这一前提）。

### A2. 脚本沙箱**无法读取落盘产物**——"综合阶段读 evidence_state.md" 设计有物理障碍
规格 §产物持久化 与 §综合：
> "全量内容不进主代理上下文。workspaceDir 默认 `<session workspace>/.research`"

- **关键事实**：workflow 脚本在 vm 沙箱运行，全局只暴露 `agent/parallel/pipeline/phase/log/args`，**无 fs、无 Node API**（`tool-workflow` DESCRIPTION 明示："no filesystem, network, timers, or Node.js APIs are provided"）。因此脚本内的综合代理**无法 `read()` 落盘的 evidence_state.md**——落盘文件只有脚本外的宿主、以及**子代理**（若其工具世界含 read/glrob）能读。
- **影响**：规格 §验证明确 设想的"verifier 对中间证据/报告逐承重声明分类"里，"对**落盘的** evidence_state.md" 这一路径，在脚本内走不通（脚本拿不到文件内容，只能拿 agent() 的返回值或自己拼的字符串）。
- **修复方向**（三选一，需实现前定）：
  1. **纯脚本内存交接**（推荐，最简且可测）：综合/验证代理的输入 = 脚本内累加的 `renderFindings` 拼接字符串（即上游 v1 做法）+ args 传入的 meta。落盘仅作**宿主侧可观测产物**，不作为运行时交接通道。→ 回到 v1"综合塞全量证据进 prompt"的上下文压力问题，但可用 §A3 的分段/分批 + `maxItemsPerCall` 缓解。
  2. **子代理交接文件**：若研究子代理继承 writable 工具，让其写 fragments 到 artifactsDir，综合代理用 read 工具读——**但这依赖子代理工具世界含文件工具**（开放项②），且 pipeline 阶段无法用 `parallel` 保证读时序。复杂度高。
  3. **宿主两次 run**：execute() 先跑"研究 run"落盘，再跑"综合 run"从盘读——但脚本仍无 fs，第二次 run 的脚本同样读不了盘，还是要靠子代理。**不解决**。
- **结论**：规格声称的"文件交接解决上下文膨胀"在本架构内**只能部分成立**（落盘 = 可观测产物与主代理指针，不能替代脚本内综合输入）。必须把这一点写清，否则实现者会按"脚本能读盘"去设计而失败。

### A3. 验证·修复环的执行位置与上下文冲突（自相矛盾）
规格 §验证明确：
> "`synthesize=true` 时 verifier 在**综合后**跑（先验证中间证据 + 修订 → 再验证最终报告）"
> §流水线状态机："[验证+修复环]（verify=true 时，**合成前**）…"

- **两处冲突**：状态机写"合成前"，§验证明确写"综合后跑"。二者不是同一时序：合成前验的是"中间证据"，合成后验的是"最终报告"。而 §验证明确 又自述"先验证中间证据+修订 → 再验证最终报告"，即**需要跑两次 verifier、且第二次在综合代理产出之后**——但修复环又要求"综合代理定向修订 → 重验证"，意味着综合代理要在"验它自己刚产出的报告"之间反复。
- **物理约束**：修复环每次"综合代理修订 → 重验证"都必须**重跑综合代理 agent() 调用**（脚本内，prompt 里塞修订指令）。若综合在合成后，则第二次合成是一个新 agent()，其输入是"上一版报告 + verifier 意见"——这可行，但**每次修复都耗一次强模型综合调用**，且与本插件的"综合代理一次产出即终稿"（v1 语义）不同。规格未定义"修订"如何产生。
- **必须定清时序**（建议）：`verifier →（有缺陷）→ synthesizer_revise → verifier`…直到通过或 `verifierMaxRounds`。即在**合成后**验证，用"修订式综合"回环，而非"合成前"也验。要么明确"合成前验证据、合成后验报告、之间无修复交叠"。

---

## B. 高风险歧义（实现前必须决定）

### B1. 验证器获取引用/声明"源"的方式未定义
§验证明确："`verified` 要求来源可验证（**web_fetch 抽查可达性/支撑性**，…）"。
- **脚本沙箱无 web_fetch**——web_fetch 是**模型面工具**，只有子代理能调。verifier 本身也是脚本里的一个 `agent()`，它的"工具世界"是否含 web_fetch 取决于子代理工具继承（开放项②）。若不含，verifier 无法 web_fetch 抽查，只能"依据研究与 web_search 可得信息评估"，即退化为**无实证抽查**——与"强制 verifier 拦截幻觉引用"的核心卖点冲突。
- **必须定**：verifier 子代理是否显式要求带 web_fetch 工具（依赖开放项②验证结果）；若不能，规格应明确 verifier 的核实手段 = 重新 web_search（弱校验），并把"未抽查到的引用"标 unverified 而非 verified。

### B2. "紧凑负载不进主代理上下文"与工具返回契约的张力
§输出 schema：`reportPath` 指示报告在盘上；但**工具 execute() 返回值会被注入主代理上下文**（这是工具契约的本性），调用方拿到 `{ reportPath, ... }` 后，为交付报告通常仍需 `read` 读取并展示——"全量内容不进主代理上下文"的承诺，指的是**不把 report 文本塞进 execute() 返回值**，成立；但**报告最终还是要进对话**（在主代理把它读出来之后）。规格应澄清：本插件的承诺是"execute() 不返回大文本"（避免工具返回即时膨胀），而非"报告永不进上下文"。当前表述"全量内容不进主代理上下文"易被误解为承诺后者，导致实现者省略 report 交付路径。

### B3. `maxItemsPerCall` 分批与"跨轮续研"的重叠语义
§健壮性："大 questions 集按 `maxItemsPerCall` 分批（引擎 ITEM_CAP）"；§研究："超过并发上限的子问题跨轮续研（绝不丢弃）"。
- 二者都处理"问题太多"，但机制不同：ITEM_CAP 是**单次 `parallel()`/`pipeline()` 的 items 数上限**（脚本单次调用超限会 `ITEM_CAP` 抛错，是**致命**错误，不是降级）；"跨轮续研"是**研究循环内的 pending 队列**语义（非致命）。规格把两者并列表述，但没说清：**若 questions 数 > maxItemsPerCall，脚本必须在单轮内把任务切分多次 `parallel()` 调用**，而不是靠跨轮——否则第一轮 `parallel(all)` 直接 ITEM_CAP 致命失败。需明确"每轮 internal batching ≤ maxItemsPerCall"。

---

## C. 与平台契约的其它差异 / 遗漏

1. **`agent()` 的 `reportParagraphsN` 之类元字段不存在**——输出 schema 里 `rounds/subquestions/completed/failed` 来自脚本 return；`reportParagraphsN` 需脚本统计，可做，但规格未指明来源（minor）。
2. **取消语义澄清**：`host.cancel` 里 `cancel()` 后触发 `abortChildren(reason)` 用的是引擎内部 controller；插件把 `exec.signal` 传进 `engine.start(signal)` 即可让引擎在信号中止时 cancel 整个 run（已确认 `WorkerRun` 构造函数订阅 signal）。§取消传播 的"本地桥接 abort→run.cancel"是**冗余但无害**（与 tool-workflow 一致）。可保留，但规格应注明"以引擎 signal 为准、桥接为双保险"。
3. **`jobs-local` 是否默认在 profile 组合中**未确认——`ctx.jobs` 是抽象服务，需先加载 `@deepseek-ai/dsh-jobs-local`。规格应列 `inject: ['tools','workflowEngine','jobs']`，并注明依赖组合提供 jobs 实现（否则后台模式缺服务，须降级前台或报错）。
4. **`workspaceDir` 生命周期与清理**未定义：每 run 一个 `<runId>` 目录，run 多了膨胀；无保留策略/清理/上限。建议 spec 补"可选保留上限或按 runId 惰性清理"（首版可出范围）。
5. **多会话并发与目录冲突**：若 workspaceDir 全局共享、两个不同会话的 runId 撞车（UUID 理论可避），且 owner fence 是 jobs 的、不覆盖落盘目录权限。建议 per-session 子目录（如 `<workspaceDir>/<sessionId>/<runId>/`）防串扰；规格当前只有 `<runId>` 一层。
6. **`language` 参数**出范围但无实现语义：提示词/报告语言是脚本内 prompt 文本，脚本需按 `args.language` 分支；规格列了参数但未写脚本如何消费（minor，但会让实现者困惑）。

---

## D. 文字/一致性瑕疵（低优先）

- §Solution "四档模型分层"，实际列了 `planner/researcher/synthesizer/verifier/reviewer` **五**个角色模型（§模型分层 也五列），前后不一致。
- §输出 schema 示例 `"jobId": "subagent-…"` 与 §说明"kind: 'deep-research'"矛盾（见 A1）。
- §Problem Statement"同包名 v2"与 §Further Notes 一致，但 **工具名 `deep_research` 与上游同名**——若用户同时装了 v1+v2 会撞工具名；规格未处理（建议：本 v2 产品名对齐包名销路，或明确"替换安装"）。
- Verification 状态命名：`job status` 用 `completed/failed/killed`（jobs 词汇），而输出 `status: completed|degraded|failed` 与 `verification.status: passed|failed` **混用**，三组词易混。建议统一一个词表并注明各自域。

---

## E. 修正建议清单（按优先级）

1. **A1**：改 `ctx.jobs.start` 用法为 `run: () => JobHooks` 函数形态 + 补 `JobKindMap` 声明合并 + jobId 前缀 `deep-research-`。
2. **A2**：明确"脚本无 fs，综合/验证输入=脚本内内存拼接，落盘仅为宿主可观测产物与主代理指针"，并删掉"脚本读盘"的隐含设计；接受"综合塞全量"并用分批缓解，或用子代理写文件方案（需开放项②支持）——**二选一写死**。
3. **A3**：重写验证·修复环时序为单一时序状态机（合成后验证 → 修订式综合回环 ≤ verifierMaxRounds），消除"合成前/后"与"两次 verifier"的自我矛盾。
4. **B1**：定 verifier 核实手段（web_fetch 抽查可用性依赖开放项②；不可用则退化为 web_search 弱校验 + unverified 标注），写清降级路径。
5. **B3**：明确"每轮 internal batching ≤ maxItemsPerCall"防 ITEM_CAP 致命失败。
6. **C3/C5**：补 `inject: ['tools','workflowEngine','jobs']` + jobs 依赖说明；workspaceDir 加 per-session 子目录与保留/清理策略（可出范围）。
7. **D 组**：统一模型分层"四/五"、jobId 前缀、状态词表、工具重名处理。

---

## F. 审核结论

- **可实施性**：接缝选型正确（workflowEngine/jobs/tools 均存在且契约已核），方向成立。
- **阻断项**：A2（脚本读盘不可行）与 A3（验证·修复环时序自我矛盾）会直接导致实现走入死路；A1（jobs API 形态 / JobKindMap）会导致类型与运行错误。**此三项不修，实现者按当前规格编码必碰壁。**
- **建议**：按 E 清单修订后再交实现。修订幅度小，无需推翻架构。
