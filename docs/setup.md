# 安装与配置（setup）

## 1. 前置条件

- DSH 运行中的 harness，其组合已加载：
  - `@deepseek-ai/dsh-workflow` 的实现服务（workflowEngine + 子代理 provider，默认 `spawn`）；
  - **后台模式需要**：`@deepseek-ai/dsh-jobs-local`（jobs 实现）及其 controller。未加载时后台启动会显式报错——按错误提示改用 `background:false` 或先装 jobs-local。
- Node ^22.19 || ≥24。

## 2. 安装（作为 bundle patch 包）

1. 把本目录放到 profile 可达的位置（或发布到你的私有 registry）。
2. 在 agent profile 的 `dsh.profile.bundles` 中加入 `@dsh-external/dsh-deep-research`；包内 `cordis.patch.yml` 会自动向该 profile 插入：

   ```yaml
   - insert:
       - id: dsh-deep-research
         name: '@dsh-external/dsh-deep-research'
   ```

3. peer 依赖需在加载方可解析：`cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-workflow`、`@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-agent`（类型面）。在本仓库外安装时由宿主 node_modules/workspace 链接提供；仓库内开发见 §4。

## 3. 替换 v1

v2 与上游 v1 使用**同名工具 `deep_research`**。同一会话同时加载两者会导致工具重名冲突：启用本包前请先从 profile 移除/停用 v1 行（v1 本身在当前 DSH 上也无法加载，通常无需额外处理）。

## 4. 仓库内开发（typecheck / test）

本包通过 `node_modules/` 目录联接（junction）对齐 harness 依赖后即可离线构建与测试（Windows 无需管理员）：

```
dsh-deep-research-hybrid/node_modules/
├── cordis                       → ../../deepseek-harness/vendor/cordis
├── @types/node                  → deepseek-harness/node_modules/@types/node
└── @deepseek-ai/
    ├── dsh-agent                → packages/core/agent
    ├── dsh-jobs                 → packages/jobs/jobs
    ├── dsh-tools                → packages/core/tools
    └── dsh-workflow             → packages/workflow/workflow
```

常用命令：

```bash
npm run build     # tsc -b（含类型检查；引用 harness 预构建工程）
npm test          # node --test tests/ （19 用例）
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
