/**
 * dsh-deep-research v2 — 后台执行桥（实现工单 T5）。
 *
 * 经 `ctx.jobs.start()` 注册 `kind:'deep-research'` 的后台任务（jobId 前缀 `deep-research-N`
 * 由 JobKindMap 声明合并而来，见 src/index.ts）。契约对齐 @deepseek-ai/dsh-jobs：
 *   - JobStart.run() 同步返回 JobHooks；
 *   - owner 为活的 Agent 实例（exec.agent），会话围栏与完成通知由 registry/controller 负责；
 *   - 取消传播：exec.signal → AbortController → workflowEngine signal；hooks.cancel 双保险再调
 *     run.cancel()，以引擎 signal 为准（spec §后台执行）；
 *   - 引擎终态映射（R1）：stopReason 'completed'→completed、'cancelled'→killed、'error'→failed
 *     （jobs 无 'cancelled' 终态，取消以 killed 表达）；
 *   - readOutput 消费式游标：workflow/phase|log|agent-* 事件按 runId 过滤进环形缓冲，
 *     job_output 可见增量；结算前把紧凑摘要行压入缓冲尾部。
 * 落盘等收尾经 deps.finalize 在结算前执行：失败仅告警降级，不翻转已完成研究的终态。
 */
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowResult, WorkflowRun, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'

/** 环形缓冲上限（行）。 */
const BUFFER_MAX_LINES = 400

function truncateLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…'
}

export interface BackgroundRunDeps {
  /** 插件 ctx：用于挂 workflow/* 事件监听（进度镜像 recorder 模式）。 */
  ctx: Context
  /** 后台任务注册表（ctx.jobs）。 */
  jobs: Context['jobs']
  /** 属主活代理（exec.agent）；完成通知与会话围栏由 registry 处理。 */
  owner: Agent
  /** 一行模型可读标签。 */
  label: string
  /** 用给定 signal 启动引擎 run（在 run() 内同步调用恰好一次）。 */
  start: (signal: AbortSignal) => WorkflowRun
  /** 调用方工具信号：中止即取消研究（可选）。 */
  externalSignal?: AbortSignal
  /** 结果落定后、done 结算前的宿主侧收尾（落盘等）；返回一行摘要。失败不翻转终态。 */
  finalize?: (result: WorkflowResult) => Promise<string>
  /** 引擎 run 建立后同步回调其 runId（run() 在 jobs.start 内同步执行，注册返回时已可读）。 */
  onRunStarted?: (runId: string) => void
}

/**
 * 注册并启动一个后台 deep-research 任务，返回 registry 签发的 jobId。
 * 抛错发生在注册前（preflight 拒绝），调用方负责向模型呈现明确错误。
 */
export function startBackgroundRun(deps: BackgroundRunDeps): JobId {
  return deps.jobs.start({
    kind: 'deep-research',
    label: deps.label,
    owner: deps.owner,
    run: () => {
      const ac = new AbortController()
      const lines: string[] = []
      let cursor = 0
      const disposers: Array<() => void> = []

      const push = (line: string): void => {
        lines.push(line)
        if (lines.length > BUFFER_MAX_LINES) {
          const drop = lines.length - BUFFER_MAX_LINES
          lines.splice(0, drop)
          cursor = Math.max(0, cursor - drop)
        }
      }

      // 调用方信号先行：已中止则不再起跑；后到中止转发给引擎 signal。
      if (deps.externalSignal !== undefined) {
        if (deps.externalSignal.aborted) {
          ac.abort('deep_research tool call aborted before start')
        } else {
          const relay = () => ac.abort('deep_research tool call aborted')
          deps.externalSignal.addEventListener('abort', relay, { once: true })
          disposers.push(() => deps.externalSignal?.removeEventListener('abort', relay))
        }
      }

      const run = deps.start(ac.signal)
      if (deps.onRunStarted !== undefined) deps.onRunStarted(String(run.id))
      push(`[run] ${deps.label} (runId=${String(run.id)})`)

      // 进度镜像：只记本 run 的事件。worker 消息晚于本同步块到达，不会漏接 phase/log。
      const mine = (info: WorkflowRunInfo): boolean => String(info.id) === String(run.id)
      const onPhase = (info: WorkflowRunInfo, title: string): void => {
        if (mine(info)) push(`[phase] ${title}`)
      }
      const onLog = (info: WorkflowRunInfo, message: string): void => {
        if (mine(info)) push(`[log] ${truncateLine(message, 300)}`)
      }
      const onAgentStart = (info: WorkflowRunInfo, agent: { seq: number; label: string }): void => {
        if (mine(info)) push(`[agent-start] #${agent.seq} ${truncateLine(agent.label, 80)}`)
      }
      const onAgentEnd = (
        info: WorkflowRunInfo,
        agent: { seq: number; outcome: string },
      ): void => {
        if (mine(info)) push(`[agent-end] #${agent.seq} ${agent.outcome}`)
      }
      try {
        disposers.push(
          deps.ctx.on('workflow/phase', onPhase),
          deps.ctx.on('workflow/log', onLog),
          deps.ctx.on('workflow/agent-start', onAgentStart),
          deps.ctx.on('workflow/agent-end', onAgentEnd),
        )
      } catch (error) {
        // 事件镜像不可用时任务照跑——进度是增强，不是依赖。
        push(`[warn] progress mirror unavailable: ${truncateLine(String(error), 120)}`)
      }

      const detachListeners = (): void => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            // 监听卸载失败不影响结算
          }
        }
      }

      const done: Promise<JobOutcome> = (async (): Promise<JobOutcome> => {
        let outcome: JobOutcome
        try {
          const result = await run.result
          if (result.stopReason === 'completed') {
            let summary = ''
            if (deps.finalize !== undefined) {
              try {
                summary = await deps.finalize(result)
              } catch (error) {
                summary = ''
                push(`[warn] artifact persistence failed: ${truncateLine(String(error), 200)}`)
              }
            }
            outcome = { status: 'completed', detail: summary.length > 0 ? truncateLine(summary, 240) : 'deep-research finished' }
          } else if (result.stopReason === 'cancelled') {
            outcome = { status: 'killed', detail: 'deep-research run cancelled' }
          } else {
            outcome = {
              status: 'failed',
              detail: result.error !== undefined ? truncateLine(result.error, 240) : 'deep-research workflow error',
            }
          }
        } catch (error) {
          // run.result 契约上 never rejects；此分支仅为桥接代码自身故障兜底。
          outcome = { status: 'failed', detail: `bridge error: ${truncateLine(String(error), 200)}` }
        }
        detachListeners()
        await run.dispose().catch(() => undefined)
        return outcome
      })()

      return {
        cancel: (reason?: string): void => {
          // 双保险：signal 中止为主，run.cancel 直接兜底；两者均幂等。
          ac.abort(reason ?? 'deep-research job cancelled')
          run.cancel(reason ?? 'deep-research job cancelled')
        },
        done,
        readOutput: (): string => {
          const delta = lines.slice(cursor).join('\n')
          cursor = lines.length
          return delta.length > 0 ? delta + '\n' : ''
        },
      }
    },
  })
}
