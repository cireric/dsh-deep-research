# 产物布局与语义（artifacts）

> 实现位于 `src/artifacts.ts`；触发点在 `src/index.ts`（前台）与 `src/background.ts` finalize（后台）。这是"Claude 式文件交接"在无 fs 沙箱约束下的宿主侧落地（ADR-0002 D4）。

## 1. 目录布局

```
<workspaceDir>/                          # Config.workspaceDir，默认 <session.header.cwd>/.research
└── <sessionId>/                         # sanitize 后的会话段（防多会话串扰，审核 C5）
    └── <runId>/                         # 引擎 WorkflowRun.id，sanitize 后
        ├── plan.json                    # 答案空间/维度/子问题(含 id)/盲区 + source('planner'|'provided')
        ├── rounds/
        │   ├── 1-1.json                 # 每研究项三态证据，<round>-<round内序号>
        │   └── 2-1.json
        ├── blindspots.json              # [{ gap, obtainable, reason }] 盲区侦察结论
        ├── report.md                    # 综合最终报告（synthesize=false 时为空文件）
        ├── evidence_state.md            # 综合输入的证据精简副本（脚本内存拼接的落盘镜像，非读回输入）
        ├── verification.json            # status/claims/issues/uncovered_dimensions/overconfident/
        │                                # revision_rounds/report_note/dropped_by_cap
        └── review.md                    # 对抗性审查意见（review='' 时整个文件不存在）
```

## 2. 路径安全

sessionId 与 runId 经 `sanitizeSegment`：`[^A-Za-z0-9._-] → '_'`、截断 120 字符。保证 per-session 隔离且无法借 `..`/分隔符穿越出 workspaceDir（回归测试含反例断言）。

## 3. 指针交付（正文不进工具返回值）

工具负载只带两个指针：

- `reportPath` —— `<dir>/report.md` 绝对路径；主代理需要正文时自行 read；
- `artifactsDir` —— 本次 run 的目录。

设计动机：全量报告文本不进 execute() 返回值，避免工具结果即时膨胀；中间产物（逐项证据/验证明细/审查意见）按需从 artifactsDir 取用。

## 4. 写入时机与失败语义

- **前台**：run 结算（completed）→ shapeScriptResult 收窄 → persistArtifacts → pruneRuns → 返回负载。落盘抛错时**捕获并省略指针**（schema additionalProperties:false 不允许额外告警字段；证据仍在紧凑负载数值与 verification 中），工具不失败。
- **后台**：同样两步发生在 jobs 结算前的 finalize 阶段；失败仅在进度流写 `[warn] artifact persistence failed: …`，job 终态仍为 completed——已完成的研究不被磁盘问题翻转（R1 纪律）。
- `pruneRuns` 是尽力而为：会话目录不存在/条目竞态消失/删除失败一律静默忽略。

## 5. 保留策略 keepRuns

- 默认保留每会话最近 **20** 个 run 目录（Config.keepRuns，0/负数非法）。
- 排序依据目录 mtime（新→旧），超出部分递归删除；mtime 可被外部改动影响，属可接受的惰性清理语义。
- 清理只作用于**本会话子目录**，绝不触碰其他会话或 workspace 根下其他内容。

## 6. 各文件的消费方式建议

| 文件 | 典型用途 |
| --- | --- |
| report.md | 最终交付物；主代理 read 后转述/归档 |
| verification.json | 判断是否可信引用：status='failed'/'unavailable' 时 issues[] 是必读清单 |
| plan.json | 复盘答案空间；questions[].acceptance 可用于后续增量研究 |
| rounds/*.json | 单项三态证据深读（confirmed 带来源分级，uncertain/gaps 带原因与优先级） |
| blindspots.json | "已验证盲区"清单——明确知道哪些信息不可得 |
| evidence_state.md | 审计综合输入；比 rounds/* 更适合整体扫读 |
| review.md | review:true 时的对抗性意见，按严重度排序 |
