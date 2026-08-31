# ADR-0003：命令面从「宿主直执行」反转为「模型中介意图入口」

- 状态：已采纳（Accepted）
- 日期：2026-08-30
- 关联：ADR-0002（D1 触发方式）、ADR-0001（平台事实）

## 背景

ADR-0002 追加记录（2026-08-30）把 `/deep-research` 命令定位为「宿主直执行、不进模型」，与 `deep_research` 工具共用 `runResearch` 内核。该定位暴露了三个症状：

1. 前台命令（`--foreground`）在命令处理器内联阻塞 workflow，主会话 composer 锁死数分钟；
2. 纯命令会话无 `turn/start`，宿主 session-list 投影判为 blank——标题停在「New Session」；
3. blank 会话在 sidebar 只显示当前项，一切走即从会话树中隐藏，搜索亦排除 blank。

根因是平台行为：命令生命周期是 log-only 的 `command/run`/`command/done`，永不开 turn；而宿主 list 投影只在 `turn/start` 时清除 blank（`session-controller/src/list.ts`），且 sidebar 对 blank 会话只显示当前项（`ui-workspace/src/client/tree.ts`）。插件侧无法在不改宿主的前提下清除 blank——唯一干净出口是「让命令产出一轮真 turn」。

## 决策

`/deep-research` 命令的角色由**宿主直执行**反转为**模型中介意图入口**：

- 命令处理器只做两件事：解析主题（及 `--purpose`/`--depth` 建议性提示、`--clarify` 命令级策略覆盖——`auto|minimal|never`，缺省取配置 `clarifyStrategy`、默认 `minimal`），然后经 `invocation.agent.followup()` 把研究意图作为**用户态消息**注入会话并开一轮真 turn；随后**立即返回**。
- turn 由主 agent 承接：它按软引导决定是否需要澄清（仅信息不足时用 1–2 个关键问题），否则调用 `deep_research` 工具；工具默认后台运行，完成时由 jobs controller 向归属会话投递通知。
- 命令 face 不再调用 `runResearch`；`runResearch` 成为工具面的唯一生产消费方。

同时删除：

- `--foreground`（后台 + 完成通知已是平台正道；前台阻塞等于把锁死从命令面搬到主 agent turn）；
- `--no-verify` / `--no-synthesize` / `--review`（流水线内部开关，命令面不再暴露）。

## 后果

- 正面：命令提交即开真 turn → blank 位清除、会话立即可见、composer 立即解锁；「软引导 + 澄清」与 Claude Code 原生 `/deep-research`（lead agent 明令 `do not attempt to ask the user questions`，直接开跑）在行为上对齐，仅多一层「信息不足才澄清」的兜底。
- 代价：放弃「命令 = 确定触发研究」的保证——`followup` 只保证 turn 一定会开，不保证模型一定调用 `deep_research`；flags 由强约束降级为建议性提示，不再有解析级强制。
- 反转范围：ADR-0002 的「命令直达（宿主直执行）」决定与 interfaces.md §2 命令面契约同步作废，本文作为权威记录。

> 为何单独成文而非改写 ADR-0002：这是一次难的、无上下文会令人惊讶、且确有真实取舍（确定性触发 vs 会话可见性与模型判断权）的翻转；ADR 惯例保留原决定与反转记录，读者沿指针阅读完整脉络。

## 补记：命令面前置检查（方案 A）

- 变更：`executeResearchCommand` 在 `followup` 之前探测 `workflowEngine`（与工具面共用 `resolveWorkflowEngine`，解析链一致）；引擎缺失时直接返回 `error` 结果并给出修复步骤（含「确认 preset 挂载 delegation 组 / agent 已 join / 未 join 的 agent（如子代理）回到主会话重试」），**不再注入意图、不再返回「已发起」**。
- 对本文决策的影响：本决策的核心目标（消除 blank 会话、命令提交即开真 turn）在引擎在位时不受影响；唯一例外是引擎不可用——该场景研究本无法执行，快速失败比空转一轮再失败更诚实，也符合「前置条件不满足必须明确提示用户」的要求。
- 关联约束：运行时文本（工具/命令描述、错误信息）不耦合任何外部 skill，前置条件失败不做跨技能/轻量降级替代。