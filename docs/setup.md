# 安装与配置（setup）

## 1. 前置条件

- DSH 运行中的 harness，其组合已加载：
  - `@deepseek-ai/dsh-workflow` 的实现服务（workflowEngine + 子代理 provider，默认 `spawn`）；Web 组合中引擎被 preset isolate 在会话 delegation 组内（standard/code/router-standard），插件在**调用期**经 `resolveWorkflowEngine` 三链解析（① 官方 `serviceForAgent` READ 寻址 → ② agent 作用域 → ③ host 平面；详见 `docs/engine-resolution.md`）；未挂引擎的 preset 下调用会得到明确报错；
  - **后台模式需要**：`@deepseek-ai/dsh-jobs-local`（jobs 实现）及其 controller。未加载时后台启动会显式报错——按错误提示改用 `background:false` 或先装 jobs-local。
- Node ^22.19 || ≥24。

## 2. 安装（作为 bundle patch 包）

三种来源任选其一（`dsh plugin` 是 profile 内 pnpm 的薄封装，安装后自动依据 package.json 的 `dsh.bundle.patch` 声明把本包挂入 profile bundles 层；完整说明见 README「安装」）：

```bash
dsh plugin --profile web add dsh-deep-research                # 方式一：npm registry（本包发布后）
dsh plugin --profile web add github:cireric/dsh-deep-research # 方式二：GitHub（pnpm ≥10 需按提示放行 prepare 构建）
dsh plugin --profile web add link:/abs/path/to/dsh-deep-research # 方式三：本地（先在本包 npm run build 出 lib/）
```

等价于手动向 profile 插入如下行：

```yaml
- insert:
    - id: dsh-deep-research
      name: 'dsh-deep-research'
```

peer 依赖需在加载方可解析：`cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-workflow`、`@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-agent-presets`（调用期 READ 寻址引擎）、`@deepseek-ai/dsh-commands`（/deep-research 命令面）。在本仓库外安装时由宿主 node_modules/workspace 链接提供；仓库内开发见 §4。

卸载与更新：`dsh plugin --profile web remove|update dsh-deep-research`（同样转发 pnpm 并自动维护 bundles 列表）。

## 3. 替换 v1

v2 与上游 v1 使用**同名工具 `deep_research`**。同一会话同时加载两者会导致工具重名冲突：启用本包前请先从 profile 移除/停用 v1 行（v1 本身在当前 DSH 上也无法加载，通常无需额外处理）。

## 4. 仓库内开发（typecheck / test）

本包通过 `node_modules/` 目录联接（junction）对齐 harness 依赖后即可离线构建与测试（Windows 无需管理员）：

```
dsh-deep-research/node_modules/
├── cordis                       → ../../deepseek-harness/vendor/cordis
├── @types/node                  → deepseek-harness/node_modules/@types/node
└── @deepseek-ai/
    ├── dsh-agent                → packages/core/agent
    ├── dsh-agent-presets        → packages/preset/agent-presets
    ├── dsh-commands             → packages/interaction/commands
    ├── dsh-jobs                 → packages/jobs/jobs
    ├── dsh-tools                → packages/core/tools
    └── dsh-workflow             → packages/workflow/workflow
```

常用命令：

```bash
npm run build     # bash scripts/build.sh（链接 harness 依赖 → tsc -b 类型检查 → lib/index.js 垫片）
npm test          # node --test "tests/**/*.mjs"（回归 + 命令面解析器全套；glob 必须引号包裹）
npm run smoke     # scripts/smoke.mjs 快速冒烟
```

受限环境（禁 spawn 子进程）下用进程内等价：`node tests/regression.test.mjs`。

## 5. 配置示例

默认（后台模式、继承父模型路由）——零配置即用：

```yaml
# profile 中无需任何键
```

定制（分层模型 + 收紧预算 + 前台模式）：

```jsonc
{
  "plannerModel": "strong-route/model-a",
  "researcherModel": "cheap-route/model-b",
  "synthesizerModel": "strong-route/model-a",
  "verifierModel": "strong-route/model-a",
  "reviewerModel": "cheap-route/model-b",
  "maxParallel": 3,
  "maxTotalAgents": 40,
  "searchBudget": 5,
  "verifierMaxRounds": 1,
  "backgroundMode": "foreground",
  "workspaceDir": "D:/research-out",
  "keepRuns": 10
}
```

调用侧覆盖（工具参数）：`depth` 控制轮数上限、`background:false` 单次转前台、`synthesize:false` 只要证据中间态不要报告、`questions` 提供现成问题清单跳过规划。

## 6. 卸载 / 停用

从 profile bundles 移除该行即可；进行中的后台任务由 jobs registry 的 owner/service 清理语义兜底（agent 销毁取消并等待任务收敛）。产物目录不会被删除，按 `keepRuns` 策略或手动清理。
