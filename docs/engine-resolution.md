# 引擎解析：根因、求证过程与修复（engine-resolution）

- 状态：已解决并验证（2026-08-30）
- 问题：`deep_research` 在官方 Web 装配（router-standard / standard / code preset）下**每次调用都失败**：
  `deep_research: workflowEngine unavailable in the calling agent scope`
- 关联：OMDSH 上游 issue #3 / PR #5（`exec.agent.ctx` 解析方案）、
  `docs/adr/0002-v2-architecture.md` D1 服务接缝、`docs/interfaces.md` §1、
  harness `packages/preset/agent-presets/src/mount.ts`、ADR-0001 #1

---

## 一、症状与初判（行为证据）

修复前直接调用工具，**毫秒级**抛出上述错误。错误字符串由插件自身在 `runResearch()`
内抛出——这证明：工具已注册、参数校验已过、execute 入口已通，整条链路只有
**调用期引擎解析**一环失败。同时排除了「加载期 pending」「工具不可见」「inject 错误」等
嫌疑。问题被精确收窄：不是 deep-research 坏了，是它的引擎解析路径坏了。

## 二、求证过程（按证据层级逐级升级）

| 步 | 证据类型 | 动作与结论 |
| --- | --- | --- |
| 1 | 行为 | 复现报错，锁定失败点 = 调用期引擎解析（见上） |
| 2 | 环境 | 检查 router-standard preset（mtime 2026-08-29 23:31）：delegation 组在、
  `isolate: workflowEngine: true` 在、`workflow-worker-thread`/`tool-workflow` 在；
  loader 状态确认会话作用域引擎 [active]。**引擎存在且被组内工具正常使用**——推翻
  「router-standard 不挂引擎」的旧假设，问题变成「挂了我却看不到」 |
| 3 | 机制 | 读 `mount.ts` 两句 docstring：① isolate 组服务存于 **realm-private symbol**；
  ② *entry-local realm 对 agent 根 ctx 与 host 平面均不可见*。cordis `ctx.get()` 只沿
  当前作用域→祖先链向上解析，delegation 组是 agent 作用域之下的**子 realm**——
  `exec.agent.ctx.get()` 从 parent 角度向下看，而隔离正是为了向下不可见。
  **结构性 miss，与部署无关**：纯 PR #5 形态在官方装配下必然失败 |
| 4 | API | 同文件 `serviceForAgent(ctx, agent, name)`——"READ addressing for a caller that
  already holds the agent" + "a host row that injects a service cannot use it"。
  正是「宿主侧 + 调用期 + 已持有 `exec.agent`」的插件场景；签名与调用面完全咬合 |
| 5 | 结构 | 契约核对：`tool-workflow` 的 `engine.start` 传参（`script/meta/args/parent/
  signal/subagentProvider?/maxTotalAgents?`）与 `runResearch` 完全同构；
  `WorkflowStartRequest.parent: Agent` 类型匹配；包导出与解析链实测可用 |
| 6 | 实测 | 改完→构建→注入器自动重载→真实调用：错误消失，流水线真实派生规划/研究子代理
  （会话记录：cwd=项目、4 分钟 LLM、14 步）；600s 为工具墙超时而非引擎失败 |

> 插曲：当时 grep 全 harness，`serviceForAgent` 是**零生产消费方**的导出（为 api-proxy
> 类场景预留）。严格说它是「官方提供、文档明确其用途、由本次 E2E 做了第一个真实消费者
> 验证」的 API——这也是第 6 步实测比文档证据更重的理由。

## 三、机制详解：为什么 agent 根 ctx 永远看不到引擎

官方 preset（standard / code / router-standard 同构）把引擎挂在会话 delegation 组：

```yaml
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
```

- **isolate 语义**：组内服务注册在 realm-private symbol 下，只有组内条目（及其后代）
  可见；组外一切（agent 根 ctx、host 平面）不可见。这是 cordis 的「隔离」职责。
- **standing mount**：每个 preset 在预设作用域只挂载一次（mountPreset），agent 通过
  作用域键（scopeOf / scopeParentOf）关联到它所属的 mount。
- **serviceForAgent 实现**（mount.ts:261）：standingMountFor(agent.ctx) 定位 mount →
  扫全局服务 store → 找 name 匹配且 fiber 隶属 mount 子树的实例返回。
  本质：**绕过作用域链可见性，按 fiber 隶属直接寻址**——寻址读取，不改动任何注册。

## 四、修复设计：resolveWorkflowEngine 三链

`src/index.ts` 新增共享解析函数（工具面与 `/deep-research` 命令面共用）：

1. **① serviceForAgent(ctx, parent, 'workflowEngine')**——主路径。官方 READ 寻址命中
   isolate 组实例；官方 Web 装配（router-standard/standard/code）必走此链。
2. **② exec.agent.ctx.get('workflowEngine')**——兼容路径。引擎直接注册在 agent 作用域
   的部署（omdsh PR #5 的假设形态；自建 preset 可能采用）。
3. **③ ctx.get('workflowEngine')**——退化路径。host 平面挂载（非 Web 组合）。

全部步骤宽松失败（try/catch——未声明 inject 时访问器自身会抛错、桩 ctx 无 reflect
等一律按缺失处理）；三链皆空时报明确错误，提示含 resolution order。

**顺序约定**：越接近调用者越优先（① 官方通道 > ② 会话作用域 > ③ host 平面），
与 cordis 作用域语义同向（最小惊讶）。多个拓扑同时可解析时以本顺序为准。

**已知边界**：① 只对「已 join preset standing mount 的 agent」生效——workflow 引擎
派生的子代理（未 join）三链全 miss 会得到明确报错。这是正确行为（子代理没有会话
私有引擎），但属于设计的固有边界。

## 五、候选路径否决记录（为什么 serviceForAgent 是唯一出口）

约束集（硬）：插件是宿主侧包（注入器 root entry / cordis.patch.yml 落 profile 根）；
预设文件属用户环境、公共包不能强制改；mount.ts 铁律——预设服务行必须进 isolate 组
（裸露会被 mount 拒绝），引擎「故意」对外不可见。

| 候选 | 否决理由 |
| --- | --- |
| 自研 store 扫描（复刻实现） | standingMount 登记表是模块级 Set 不导出、scope key 语义在 dsh-scope 内部——抄官方实现还拿不到注册表 |
| 遍历 ctx 子树找组内服务 | cordis 服务解析只向上；「隔离」机制的职责就是防向下访问 |
| 改装配把插件装进 delegation 组 | 要改每个目标 preset（动用户环境）；注入器 entry 在 host 层进不了组；调用期错误会变成「工具不可见」，可诊断性更差 |
| 宿主自建引擎实例 | 丢掉每会话隔离语义、双引擎并存、provider 冲突、worker 生命周期重复 |
| 插件内部复刻流水线绕过引擎 | 「静态 SCRIPT + 官方引擎」是 v2 架构前提；失去引擎的 caps/取消/事件/持久化 |
| 改预设装配（isolate→shared / 引擎上移） | mount.ts 明文拒绝 root realm 服务行；shared 标签改变多会话实例语义 |

结论：是约束集下的**唯一官方出口**，不是「我们选它」，是其他门都被机制锁死。
若未来 harness 演进出新通道（如 api-proxy Remote 面），只需改 `resolveWorkflowEngine`
一处。

## 六、验证

- 回归测试 32/32（含新增 ③ 链回退用例、注入断言修正为 ['tools','jobs','commands']）
- typecheck（tsc -b）通过；smoke 全流水线模拟通过
- E2E：真实调用跑通引擎解析，研究流水线真实执行（详见 §二步 6）

## 七、相关文件索引

| 位置 | 内容 |
| --- | --- |
| harness packages/preset/agent-presets/src/mount.ts | serviceForAgent / standingMountFor / withinFiber / leakedServices |
| harness packages/workflow/tool-workflow/src/index.ts | 组内消费方的 engine.start 调用范本（inject 含 workflowEngine） |
| harness packages/workflow/workflow/src/index.ts | workflowEngine Context 增强与事件面 |
| 本包 src/index.ts | resolveWorkflowEngine（三链）、runResearch、命令面 |
| 本包 docs/interfaces.md §1 | inject 与解析链契约 |
| 本包 docs/adr/0002-v2-architecture.md D1 | 服务接缝（调用期三链解析，已随本修复同步） |
