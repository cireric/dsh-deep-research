# dsh-deep-research-hybrid

**`@dsh-external/dsh-deep-research` v2** —— DeepSeek Harness（DSH）的深度研究编排插件。

一句自然语言即可让 agent 对复杂主题发起多源调研：规划答案空间 → 自适应多轮并行检索（盲区定向侦察、边际增益收敛）→ 率失真综合成报告 → 强制验证（有界修复环）→ 可选对抗审查。全程证据三态纪律（confirmed / uncertain / gaps），报告落盘、按需取用。

基于 DSH 官方 workflow 引擎的静态脚本实现，编排逻辑可整段回归测试。

## 安装

### 前置条件

| 依赖 | 用途 | 必需性 |
| --- | --- | --- |
| DSH workflow 引擎（子代理 provider `spawn`） | 执行编排脚本与子代理 | 必需 |
| `@deepseek-ai/dsh-jobs-local` | 后台任务注册与完成通知 | 后台模式必需 |
| Node.js ^22.19 \|\| >=24 | 运行时 | 必需 |

### 步骤

1. 将本包置于 profile 可访问的位置（或发布到你的私有 registry）；
2. 在 agent profile 的 `dsh.profile.bundles` 中加入 `@dsh-external/dsh-deep-research` —— 包内 `cordis.patch.yml` 会自动向该 profile 插入插件行；
3. 确保 peer 依赖在加载方可解析（`cordis`、`@deepseek-ai/dsh-tools|dsh-workflow|dsh-jobs|dsh-agent`），通常经宿主 node_modules 或工作区链接提供。

也可用 CLI 按路径安装：`dsh plugin --profile <name> add <本包路径>`。

> ⚠️ 与上游 v1 同名工具 `deep_research`：同一 profile 请勿同时启用两者。

完整说明（含仓库内开发环境、配置示例、卸载）：见 [`docs/setup.md`](docs/setup.md)。

## 使用说明

### 触发方式

对 agent 说自然语言即可，例如：

- 「帮我深度调研一下 MCP 安全现状，要可溯源的报告」
- 「调研 RAG 评测基准，我有三个具体问题：……」（附问题清单可跳过自动拆解）
- 「快速初步了解一下 xxx，不用太深」→ agent 会传 `depth: 1`

agent 也可以显式传参精确控制：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `topic` | 必填 | 研究主题 |
| `purpose` | 无 | 要支撑什么判断/决策（塑造规划方向） |
| `questions` | 无 | 每行一个的现成问题清单 |
| `depth` | 2 | 1=初步 2=深入 3=穷尽（轮次上限 depth+1） |
| `synthesize` | true | false 时只做证据中间态+轻量验证，不写报告 |
| `verify` | true | 强制验证环 |
| `review` | false | 追加对抗性审查 |
| `background` | 取配置 | 后台执行 |
| `language` | zh | 报告语言 |

### 后台模式（默认）

调用立即返回：

```json
{ "ok": true, "status": "background", "jobId": "deep-research-7", "runId": "wf-..." }
```

研究在后台运行；完成时归属会话收到通知（含轮次/成败/验证状态与报告路径）。中途可用任务系统的取消能力终止。

### 前台模式（`background: false`）

等待完成后返回紧凑负载：

```json
{
  "ok": true, "status": "completed",
  "rounds": 2, "subquestions": 6, "completed": 7, "failed": 0,
  "verification": { "status": "passed", "claims": { "verified": 12, "unverified": 2, "refuted": 0 }, "issues": [] },
  "reportPath": "<workspace>/.research/<session>/<run>/report.md",
  "artifactsDir": "<workspace>/.research/<session>/<run>"
}
```

需要正文时按 `reportPath` 读取报告；`artifactsDir` 内含 plan / 逐项证据 / 验证明细 / 盲区清单等七类产物。验证未通过时会诚实标注（`verification.status='failed'` + `issues[]`），不会伪装成事实交付。

## 配置速览

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `plannerModel … reviewerModel` ×5 | 继承父路由 | 五角色分层（规划/综合用强模型、研究/审查可用便宜模型） |
| `maxParallel` | 4 | 每轮并发预算（兼切片上界） |
| `maxTotalAgents` | 引擎默认 | 总代理数封顶 |
| `searchBudget` | 6 | 单代理搜索预算（生效值再与 depth 上限取小） |
| `verifierMaxRounds` | 2 | 验证修复环上限 |
| `workspaceDir` | `<会话cwd>/.research` | 产物根目录 |
| `backgroundMode` | background | 默认执行模式 |
| `keepRuns` | 20 | 每会话保留最近 N 次 run 产物 |

全部键与语义：[`docs/interfaces.md`](docs/interfaces.md)；配置示例：[`docs/setup.md`](docs/setup.md)。

## 目录结构

```
src/       插件入口 + 流水线脚本 + 后台桥 + 落盘
tests/     回归测试（vm 镜像引擎，20 用例）
scripts/   冒烟 / 文档链接校验
docs/      规格·审核·ADR·接口契约·提示词·安装·测试·产物 + 研究参考
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/setup.md`](docs/setup.md) | 安装、替换 v1、开发环境、配置示例 |
| [`docs/interfaces.md`](docs/interfaces.md) | 工具参数 / 输出 schema / 配置键权威定义 |
| [`docs/test-plan.md`](docs/test-plan.md) | 测试策略与 20 用例清单 |
| [`docs/artifacts.md`](docs/artifacts.md) | 产物布局与消费方式 |
| [`docs/adr-architecture.md`](docs/adr-architecture.md) | 架构决策与失败隔离矩阵 |
| [`docs/agent-prompts.md`](docs/agent-prompts.md) | 各代理提示词的设计依据 |
| [`docs/references/community-comparison.md`](docs/references/community-comparison.md) | 五个社区实现横评与改进候选 |

## 开发

```bash
npm run build   # tsc -b 类型门禁
npm test        # 回归测试（受限环境：node tests/regression.test.mjs）
npm run smoke   # 秒级冒烟
node scripts/verify-links.cjs   # 文档引用路径校验
```
