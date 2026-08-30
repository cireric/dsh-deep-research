# Deep Research 领域模型（dsh-deep-research）

本上下文是 dsh-deep-research 插件：为 DeepSeek Harness 提供"复杂主题深度研究"编排——从答案空间定义、多轮证据收集，到综合、验证与诚实交付。本文件只定义领域词汇；机制决策见 `docs/adr/`，接口契约见 `docs/interfaces.md`。

## Language

### 研究与编排

**深度研究（deep research）**:
面向复杂主题的多源证据收集、交叉验证并综合成报告的一次性编排服务，由 `deep_research` 工具或 `/deep-research` 命令触发。
_Avoid_: 调研、文献综述（泛指任何调查行为，语义过宽）

**运行（run）**:
一次深度研究的完整执行，有唯一 runId；产物按 runId 归组存放。
_Avoid_: job、任务（后台调度实体，属实现层词汇）

**研究轮（round）**:
一次研究阶段迭代，产出该轮三态证据；是否进入下一轮由边际增益收敛判定。

**答案空间（answer space）**:
规划阶段为研究主题定义的目标范围，由四项构成——scope（一句话界定范围与边界）、dimensions（必须覆盖的信息维度）、questions（子问题）、coverage_gaps（盲区声明）。

**子问题（question）**:
最小研究单元。每条带 keywords（检索关键词）与 acceptance（验收标准——什么证据算回答了它）。

**盲区（blindspot）**:
规划阶段"不确定信息是否可得"的研究缺口。由侦察代理判定 obtainable 后落盘；盲区必须显式呈现，不得静默消失。
_Avoid_: 缺口（gaps 是三态证据中的独立概念，含义不同）

### 证据与质量

**三态证据（three-state evidence）**:
研究产物的唯一分类法——confirmed{claim, source, confidence}、uncertain{point, reason}、gaps{aspect, priority}。

**边际增益收敛（marginal-gain convergence）**:
多轮研究的停止准则：轮末收集新增高优先级缺口作 follow-up，去重后为空或达轮次上限即收敛。

**率失真综合（rate-distortion synthesis）**:
综合阶段只消费精简证据（confirmed 仅三元组、uncertain/gaps 仅要点），以可接受的信息损失换取可处理的综合输入。

**验证（verification）**:
对综合报告逐条核对声明，产出 status/claims/issues；不通过时进入有界修复环。

**有界修复环（bounded repair loop）**:
验证不通过时只重综合被点名章节再验证，循环次数有上限；耗尽后验证状态如实标记为失败。

**诚实降级（honest degradation）**:
任何环节失败都不阻塞交付、不静默吞错：交付状态如实反映（completed / failed / unavailable / degraded）。

### 交付与触发

**文件交接（file handoff）**:
交付形态：产物落盘后，返回值只携带产物路径指针，报告正文不进返回值——防止上下文膨胀。
_Avoid_: 内联交付（把整篇报告塞进返回值）

**后台运行（background run）**:
默认执行模式：启动即返回 jobId/runId，完成时向归属会话投递通知，可取消。
_Avoid_: 异步（实现机制词，非领域语义）

**模型分层（model tiering）**:
五类代理可按角色分别指定模型，按成本与质量分层。

### 代理角色

**规划代理（planner）**:
定义答案空间；失败视为硬错误。
_Avoid_: 规划器（直译腔）

**研究代理（researcher）**:
按子问题收集证据并产出三态证据；单个失败只归档该节，不终止运行。

**侦察代理（scout）**:
判定盲区是否可得（obtainable），结论纳入交付证据，不留未决盲区悬案。

**综合代理（synthesizer）**:
把精简证据综合为报告；失败时降级为占位报告并附说明。

**验证代理（verifier）**:
核对报告声明；自身失败如实标记为 unavailable。

**审查代理（reviewer）**:
可选的对抗性审查角色：复核报告结构、盲区覆盖与自信度。
