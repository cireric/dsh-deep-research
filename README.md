# dsh-deep-research

**`dsh-deep-research` v2** —— DeepSeek Harness（DSH）的深度研究编排插件（[github.com/cireric/dsh-deep-research](https://github.com/cireric/dsh-deep-research)）。

一句自然语言即可让 agent 对复杂主题发起多源调研：规划答案空间 → 自适应多轮并行检索（盲区定向侦察、边际增益收敛）→ 率失真综合成报告 → 强制验证（有界修复环）→ 可选对抗审查。全程证据三态纪律（confirmed / uncertain / gaps），报告落盘、按需取用。

基于 DSH 官方 workflow 引擎的静态脚本实现，编排逻辑可整段回归测试。

## 安装

### 前置条件

| 依赖 | 用途 | 必需性 |
| --- | --- | --- |
| DSH workflow 引擎（子代理 provider `spawn`） | 执行编排脚本与子代理 | 必需 |
| `@deepseek-ai/dsh-jobs-local` | 后台任务注册与完成通知 | 后台模式必需 |
| Node.js ^22.19 \|\| >=24 | 运行时 | 必需 |

### 三种安装方式

`dsh plugin` 是 profile 内 pnpm 的薄封装：安装后自动把声明了 bundle patch 的包挂入 profile 层栈；`remove` / `update` 同理转发。

**方式一 · npm registry**（本包发布后即为标准途径）

```bash
dsh plugin --profile web add dsh-deep-research
```

> 当前尚未发布到公共 npm——发布后此命令即生效（私有 registry 同理，支持 `@version`）。

**方式二 · GitHub 仓库**

```bash
dsh plugin --profile web add github:cireric/dsh-deep-research
# 亦支持 git+https 全 URL 与 @tag/@commit 固定版本
```

⚠️ git 托管插件在安装时经 **prepare 脚本构建**，pnpm ≥10 默认拦截 build script——按 pnpm 报错提示把它打印的 key 加入 profile 目录下 `pnpm-workspace.yaml` 的 `allowBuilds`，再重跑同一命令即可。

**方式三 · 本地代码（开发推荐）**

```bash
cd dsh-deep-research
npm run build        # 先构建出 lib/
dsh plugin --profile web add link:/绝对路径/dsh-deep-research
```

- `link:` 以符号链接接入：改完代码重新 build 即生效，适合本地迭代；`file:` 则为复制快照；
- 裸相对路径（如在 checkout 内 `add .`）会被自动锚定到你调用命令的目录；
- 卸载与更新：`dsh plugin --profile web remove|update <包名>`。

### 通用说明

- peer 依赖（`cordis`、`@deepseek-ai/dsh-tools|dsh-workflow|dsh-jobs|dsh-agent`）需在加载方可解析（宿主 node_modules 或工作区链接提供）。
- 安装成功的判据：插件自动出现在 profile 清单的 `dsh.profile.bundles` 列表（依据 package.json 的 `dsh.bundle.patch` 声明）。
- ⚠️ 与上游 v1 同名工具 `deep_research`：同一 profile 请勿同时启用两者。

更多细节（仓库内开发的 node_modules 联接、逐键配置示例）：[`docs/setup.md`](docs/setup.md)。

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

### 用户直达命令 `/deep-research`

插件同时注册用户面命令。命令是**意图入口**，不是直接执行器：它把主题作为一条用户态消息注入会话、开一轮真对话，由主 agent 承接——必要时先用 1–2 个关键问题澄清，否则直接调用 `deep_research` 工具。研究默认后台运行，完成时归属会话收到通知。

```
/deep-research MCP 安全现状 --depth 3 --purpose "支撑选型决策"
```

命令提交即开启一轮真 turn，会话立即可见、composer 立即可用（不再有"空会话需先发消息"的约束）。

| 片段 | 说明 |
| --- | --- |
| `<主题>` | 必填，剩余文本即主题 |
| `--depth 1-3` | 研究精度（建议性提示，默认 2） |
| `--clarify auto\|minimal\|never` | 澄清策略覆盖（建议性提示；缺省取配置 `clarifyStrategy`，默认 `minimal`） |
| `--purpose "…"` | 研究用途（建议性提示） |

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
| `keepRuns` | 20 | 每会话保留最近 N 次 run 产物（≥1，非法整数报错） |
| `clarifyStrategy` | `minimal` | 入口澄清策略：`minimal`=仅当缺失信息分叉答案空间时才问（≤1 轮 1 问、可跳过）；`auto`=v1 行为；`never`=禁止访谈，假设写入 `purpose` |

全部键与语义：[`docs/interfaces.md`](docs/interfaces.md)；配置示例：[`docs/setup.md`](docs/setup.md)。

## 目录结构

```
src/       插件入口 + 流水线脚本 + 后台桥 + 落盘
tests/     回归测试（vm 镜像引擎，23 用例）
scripts/   冒烟 / 文档链接校验
CONTEXT.md  领域词汇表（单一上下文）
src/       插件入口 + 流水线脚本 + 后台桥 + 落盘
tests/     回归测试（vm 镜像引擎，23 用例）
scripts/   冒烟 / 文档链接校验
docs/      决策(adr/)·接口契约·提示词·安装·测试·产物 + 研究参考
```

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`docs/setup.md`](docs/setup.md) | 安装、替换 v1、开发环境、配置示例 |
| [`docs/interfaces.md`](docs/interfaces.md) | 工具参数 / 输出 schema / 配置键权威定义 |
| [`docs/test-plan.md`](docs/test-plan.md) | 测试策略与 23 用例清单 |
| [`docs/artifacts.md`](docs/artifacts.md) | 产物布局与消费方式 |
| [`CONTEXT.md`](CONTEXT.md) | 领域词汇表（单一上下文） |
| [`docs/adr/`](docs/adr/) | 架构决策：ADR-0001 平台接缝 / ADR-0002 v2 架构与失败隔离矩阵 |
| [`docs/agent-prompts.md`](docs/agent-prompts.md) | 各代理提示词的设计依据 |
| [`docs/references/community-comparison.md`](docs/references/community-comparison.md) | 五个社区实现横评与改进候选 |

## 开发

```bash
npm run build   # tsc -b 类型门禁
npm test        # 回归测试（受限环境：node tests/regression.test.mjs）
npm run smoke   # 秒级冒烟
node scripts/verify-links.cjs   # 文档引用路径校验
```
