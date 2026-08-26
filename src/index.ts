/**
 * dsh-deep-research (v2) — Deep Research orchestrator for DeepSeek Harness.
 *
 * v2 设计：以 Claude 工程骨架（后台执行 / verifier 强制验证 / 文件交接 / 有界生命周期）为地基，
 * 以 dsh 机制设计（答案空间 / 覆盖度盲区 / 三态证据 / 边际增益收敛 / 对抗性审查 / 模型分层）为内核。
 *
 * 本文件实现 T1（脚手架）+ T2（工具注册与参数校验）+ T3/T4/T5 的宿主侧接线：
 *   - T3 流水线在 src/script.ts（静态 SCRIPT，plan→research→synthesize→verify→review）；
 *   - T4 产物落盘在 src/artifacts.ts（<workspaceDir>/<sessionId>/<runId>/ + keepRuns）；
 *   - T5 后台执行在 src/background.ts（ctx.jobs，kind 'deep-research'）。
 *
 * 服务接缝（经 references/platform-seam-verification.md 核验）：
 *   inject: ['tools', 'workflowEngine', 'jobs']
 *   ctx.workflowEngine.start({ script, meta, args, parent, signal, subagentProvider?, maxTotalAgents? })
 *   ctx.jobs.start({ kind:'deep-research', label, owner, run: () => JobHooks })
 *
 * @module dsh-deep-research (github.com/cireric/dsh-deep-research)
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { WorkflowMeta, WorkflowResult } from '@deepseek-ai/dsh-workflow'
import { RESEARCH_SCRIPT } from './script.ts'
import { persistArtifacts, pruneRuns, resolveWorkspaceDir } from './artifacts.ts'
import type { ScriptResultShape, VerificationStatus } from './artifacts.ts'
import { startBackgroundRun } from './background.ts'
import { parseQuestionList } from './questions.ts'

// v2 后台模式需要 JobKindMap 声明合并：jobId 前缀即 kind 名 → `deep-research-N`。
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'deep-research': 'deep-research' }
}

export const name = 'dsh-deep-research'

/** 激活时机：工具注册表与官方 workflow / jobs 服务可用。 */
export const inject = ['tools', 'workflowEngine', 'jobs']

/** 规格默认值集中处（resolveConfig 的唯一事实来源；AGENTS.md：defaulting 是显式步骤）。 */
const DEFAULTS = {
  maxParallel: 4,
  searchBudget: 6,
  verifierMaxRounds: 2,
  /** 引擎单次 parallel() 硬上限的文档默认值（超限为致命 ITEM_CAP；切片大小取 min）。 */
  maxItemsPerCall: 4096,
  keepRuns: 20,
  backgroundMode: 'background',
} as const

/** 工具负载的运行状态词表（R1：不引入 'cancelled'，取消以前台 'degraded'/后台 killed 表达）。 */
type RunStatus = 'completed' | 'background' | 'degraded'

/** 插件配置（全部可选，缺省继承父路由 / 规格默认值）。 */
export interface Config {
  /** 子代理 provider 覆盖（引擎默认 'spawn'）。 */
  subagentProvider?: string
  plannerModel?: string
  researcherModel?: string
  synthesizerModel?: string
  verifierModel?: string
  reviewerModel?: string
  /** 每轮并发预算，同时是研究切片大小上界之一。 */
  maxParallel?: number
  /** 封总代理数（缺省用引擎自身上限，不写入请求）。 */
  maxTotalAgents?: number
  /** 每研究子代理的 web_search/web_fetch 预算上界（实际生效值再与 LIMIT(depth) 取小）。 */
  searchBudget?: number
  /** 验证修复环上限。 */
  verifierMaxRounds?: number
  /** 切片用的单次 parallel() 上界假设（仅当引擎配置改小时需要下调）。 */
  maxItemsPerCall?: number
  /** 产物根目录（默认 `<session-cwd>/.research`）。 */
  workspaceDir?: string
  backgroundMode?: 'background' | 'foreground'
  /** 保留最近 N 个 run 目录（≥1；不提供则用默认值 20）。 */
  keepRuns?: number
  /** 预留开关：raw 抓取片段落盘增强（v2.0 未启用，见 spec 开放项② / ADR-0002 D7）。 */
  rawNotes?: boolean
}

/** resolveConfig 的返回：全部字段已定型、已校验。 */
interface ResolvedConfig {
  subagentProvider: string | undefined
  models: Partial<Record<'planner' | 'researcher' | 'synthesizer' | 'verifier' | 'reviewer', string>>
  maxTotalAgents: number | undefined
  maxParallel: number
  searchBudget: number
  verifierMaxRounds: number
  maxItemsPerCall: number
  keepRuns: number
  backgroundMode: 'background' | 'foreground'
}

function positiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`dsh-deep-research: ${label} must be a positive integer`)
  }
  return n
}

function nonNegativeInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`dsh-deep-research: ${label} must be a non-negative integer`)
  }
  return n
}

/** 显式的配置解析步骤：校验 + 默认值一次成型（评审 F6：不再散落 fallback 常量）。 */
function resolveConfig(config: Config): ResolvedConfig {
  const reviewerModel = config.reviewerModel ?? config.synthesizerModel
  const models: ResolvedConfig['models'] = {}
  if (config.plannerModel !== undefined) models.planner = config.plannerModel
  if (config.researcherModel !== undefined) models.researcher = config.researcherModel
  if (config.synthesizerModel !== undefined) models.synthesizer = config.synthesizerModel
  if (config.verifierModel !== undefined) models.verifier = config.verifierModel
  if (reviewerModel !== undefined) models.reviewer = reviewerModel
  return {
    subagentProvider: config.subagentProvider ?? undefined,
    models,
    maxTotalAgents: positiveInt(config.maxTotalAgents, 'maxTotalAgents'),
    maxParallel: positiveInt(config.maxParallel, 'maxParallel') ?? DEFAULTS.maxParallel,
    searchBudget: positiveInt(config.searchBudget, 'searchBudget') ?? DEFAULTS.searchBudget,
    verifierMaxRounds: nonNegativeInt(config.verifierMaxRounds, 'verifierMaxRounds') ?? DEFAULTS.verifierMaxRounds,
    maxItemsPerCall: positiveInt(config.maxItemsPerCall, 'maxItemsPerCall') ?? DEFAULTS.maxItemsPerCall,
    keepRuns: positiveInt(config.keepRuns, 'keepRuns') ?? DEFAULTS.keepRuns,
    backgroundMode: config.backgroundMode ?? DEFAULTS.backgroundMode,
  }
}

/** verification.status 的封闭词表（评审 F3：白名单之外才归 'unknown'）。 */
const VERIFICATION_STATUSES: readonly string[] = ['passed', 'failed', 'skipped', 'unavailable']

/**
 * 校验并把脚本返回值收窄为 ScriptResultShape（RESULT_UNSERIALIZABLE 已由引擎兜底，
 * 这里只做形状防御：字段缺失/类型漂移时给出可读错误而非让宿主侧炸出深层堆栈）。
 */
function shapeScriptResult(value: unknown): ScriptResultShape {
  if (value === null || typeof value !== 'object') {
    throw new Error('deep_research: workflow returned no result object')
  }
  const r = value as Record<string, unknown>
  if (typeof r.report !== 'string') throw new Error('deep_research: workflow returned no report field')
  const verificationRaw = (r.verification ?? {}) as Record<string, unknown>
  const claimsRaw = (verificationRaw.claims ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const rawStatus = typeof verificationRaw.status === 'string' ? verificationRaw.status : ''
  const status: VerificationStatus = VERIFICATION_STATUSES.includes(rawStatus)
    ? (rawStatus as VerificationStatus)
    : 'unknown'
  return {
    report: r.report,
    report_note: typeof r.report_note === 'string' ? r.report_note : '',
    review: typeof r.review === 'string' ? r.review : '',
    rounds: num(r.rounds),
    subquestions: num(r.subquestions),
    completed: num(r.completed),
    failed: num(r.failed),
    plan: r.plan ?? null,
    items: Array.isArray(r.items) ? (r.items as ScriptResultShape['items']) : [],
    dropped_by_cap: Array.isArray(r.dropped_by_cap)
      ? (r.dropped_by_cap as ScriptResultShape['dropped_by_cap'])
      : [],
    blindspots: Array.isArray(r.blindspots) ? (r.blindspots as ScriptResultShape['blindspots']) : [],
    evidence_state: typeof r.evidence_state === 'string' ? r.evidence_state : '',
    verification: {
      status,
      claims: {
        verified: num(claimsRaw.verified),
        unverified: num(claimsRaw.unverified),
        refuted: num(claimsRaw.refuted),
      },
      issues: Array.isArray(verificationRaw.issues) ? (verificationRaw.issues as string[]) : [],
      uncovered_dimensions: Array.isArray(verificationRaw.uncovered_dimensions)
        ? (verificationRaw.uncovered_dimensions as string[])
        : [],
      overconfident: Array.isArray(verificationRaw.overconfident)
        ? (verificationRaw.overconfident as ScriptResultShape['verification']['overconfident'])
        : [],
      revision_rounds: num(verificationRaw.revision_rounds),
    },
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const resolved = resolveConfig(config)

  const meta: WorkflowMeta = {
    name: 'deep-research',
    description: 'Adaptive deep research orchestrator (v2): plan → research → synthesize → verify → review.',
    whenToUse: 'Deep research / investigation needing multi-source evidence and a cited report.',
    phases: [
      { title: '规划', detail: 'Answer-space planning: scope, dimensions, subquestions, coverage gaps' },
      { title: '研究', detail: 'Adaptive research rounds with slicing min(maxParallel, maxItemsPerCall)' },
      { title: '综合', detail: 'Rate-distortion synthesis into a cited report' },
      { title: '验证', detail: 'Enforced verifier with bounded revision loop' },
      { title: '审查', detail: 'Optional adversarial review' },
    ],
  }

  ctx.tools.register(
    defineTool({
      name: 'deep_research',
      description:
        '深度研究编排工具（Deep Research Orchestrator，基于 DSH 官方 workflow 引擎）。' +
        '当用户要求对复杂主题做深度研究/调研（需要多源信息搜集、交叉验证、撰写调研报告）时调用。' +
        '流程：规划（答案空间/维度/盲区）→ 自适应多轮并行研究 → 综合成报告 → 强制验证（有界修复环）→ 可选对抗审查。' +
        '触发场景：深度研究、调研、多源信息综合分析、研究报告、文献/资料搜集。' +
        '若需求模糊，先向用户澄清（用途/范围）再调用；若已有具体问题清单，直接传 questions 可跳过自动拆解。' +
        '后台模式（默认）下 execute 立即返回 jobId，研究在后台运行，完成时向归属会话投递通知并落盘报告。',
      parameters: {
        topic: { type: 'string', required: true, description: '研究主题。' },
        purpose: { type: 'string', description: '可选：研究用途——要支撑什么判断/决策（定义答案空间）。' },
        questions: { type: 'string', description: '可选：已有问题清单（每行一个）。提供后跳过自动拆解。' },
        depth: { type: 'number', description: '研究精度：1=初步 2=深入(默认) 3=穷尽，决定研究轮次上限 depth+1 与单代理搜索预算上限。' },
        synthesize: { type: 'boolean', description: '是否综合成最终报告（默认 true；false 时仅对中间证据轻量验证、不产报告）。' },
        verify: { type: 'boolean', description: '是否运行强制 verifier 验证引用/声明（默认 true）。' },
        review: { type: 'boolean', description: '是否运行对抗性审查（默认 false）。' },
        background: { type: 'boolean', description: '是否后台执行（默认取插件配置 backgroundMode）。' },
        language: { type: 'string', description: '报告语言（默认 zh）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            status: { type: 'string', required: true },
            runId: { type: 'string' },
            jobId: { type: 'string' },
            reportPath: { type: 'string' },
            artifactsDir: { type: 'string' },
            rounds: { type: 'integer' },
            subquestions: { type: 'integer' },
            completed: { type: 'integer' },
            failed: { type: 'integer' },
            verification: {
              type: 'object',
              additionalProperties: false,
              properties: {
                status: { type: 'string' },
                claims: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    verified: { type: 'integer' },
                    unverified: { type: 'integer' },
                    refuted: { type: 'integer' },
                  },
                },
                // 评审 F2：failed/unavailable 时主代理必须能就地读到必修点，而不是去读落盘文件
                issues: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          required: ['ok', 'status'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.status === 'background'
                ? `deep_research 已转入后台（jobId=${value.jobId ?? '?'}${value.runId ? `，runId=${value.runId}` : ''}），完成时将收到通知`
                : value.status === 'degraded'
                  ? `deep_research 已取消，未产出结果（runId=${value.runId ?? '?'}）；如需继续请重新调用`
                  : value.ok === true
                    ? `deep_research 完成（status=${value.status}，轮次 ${value.rounds ?? 0}，子问题 ${value.subquestions ?? 0}，完成 ${value.completed ?? 0}/失败 ${value.failed ?? 0}${value.verification ? `，验证=${String(value.verification.status)}` : ''}）` +
                      (value.reportPath ? `\n报告已落盘：${value.reportPath}` : '')
                    : `deep_research 未能完成：${value.status ?? 'unknown'}`,
          },
        ],
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error('deep_research requires a calling agent (exec.agent was undefined)')
        const cfg = resolved

        // ---------- 参数校验（T2 契约保持不变） ----------
        // 平台已按 required:true 在 execute 前拦截缺失 topic；此处仍做运行时形状防御，
        // 且不用 String(args.topic)——它会把 undefined 折叠成字符串 "undefined" 骗过空串检查。
        const topic = typeof args.topic === 'string' ? args.topic.trim() : ''
        if (topic.length === 0) throw new Error('deep_research: topic must not be empty')
        const purpose = typeof args.purpose === 'string' && args.purpose.trim().length > 0 ? args.purpose.trim() : undefined
        const depth = args.depth === undefined ? 2 : positiveInt(args.depth, 'depth') ?? 2
        if (depth > 3) throw new Error('dsh-deep-research: depth must be 1, 2 or 3')
        const synthesize = args.synthesize !== false
        const verify = args.verify !== false
        const review = args.review === true
        const background =
          args.background === true ? true : args.background === false ? false : cfg.backgroundMode === 'background'
        const language = typeof args.language === 'string' && args.language.trim().length > 0 ? args.language.trim() : 'zh'
        const questions = parseQuestionList(args.questions)

        const engineArgs = {
          topic,
          ...(purpose !== undefined ? { purpose } : {}),
          ...(questions.length > 0 ? { questions } : {}),
          depth,
          synthesize,
          verify,
          review,
          language,
          searchBudget: cfg.searchBudget,
          maxParallel: cfg.maxParallel,
          verifierMaxRounds: cfg.verifierMaxRounds,
          maxItemsPerCall: cfg.maxItemsPerCall,
          ...(Object.keys(cfg.models).length > 0 ? { models: cfg.models } : {}),
        }

        const sessionId = String(parent.id)
        const parentCwd: string | undefined = parent.session.header.cwd

        // ---------- 后台路径（T5） ----------
        if (background) {
          let runId = ''
          let jobId = ''
          try {
            jobId = String(
              startBackgroundRun({
                ctx,
                jobs: ctx.jobs,
                owner: parent,
                label: `深度研究：${topic}`,
                externalSignal: exec.signal,
                onRunStarted: (id) => {
                  runId = id
                },
                finalize: async (result: WorkflowResult) => {
                  const shaped = shapeScriptResult(result.value)
                  const workspaceDir = resolveWorkspaceDir(config.workspaceDir, parentCwd)
                  const paths = await persistArtifacts(workspaceDir, sessionId, runId || 'unknown-run', shaped)
                  await pruneRuns(workspaceDir, sessionId, cfg.keepRuns)
                  return `status=${shaped.verification.status} rounds=${shaped.rounds} completed=${shaped.completed}/failed=${shaped.failed} report=${paths.reportPath}`
                },
                start: (signal) =>
                  ctx.workflowEngine.start({
                    script: RESEARCH_SCRIPT,
                    meta,
                    args: engineArgs,
                    ...(cfg.subagentProvider !== undefined ? { subagentProvider: cfg.subagentProvider } : {}),
                    ...(cfg.maxTotalAgents !== undefined ? { maxTotalAgents: cfg.maxTotalAgents } : {}),
                    parent,
                    signal,
                  }),
              }),
            )
          } catch (error) {
            // jobs-local 未加载 / controller 未挂 / preflight 拒绝：显式报错，由模型决定降级前台重试
            throw new Error(
              `dsh-deep-research: background start failed (${error instanceof Error ? error.message : String(error)})` +
                ' — retry with background:false to run in foreground, or ensure @deepseek-ai/dsh-jobs-local is loaded',
            )
          }
          const payload: { ok: boolean; status: RunStatus; jobId?: string; runId?: string } = {
            ok: true,
            status: 'background',
          }
          if (jobId.length > 0) payload.jobId = jobId
          if (runId.length > 0) payload.runId = runId
          return payload
        }

        // ---------- 前台路径 ----------
        const run = ctx.workflowEngine.start({
          script: RESEARCH_SCRIPT,
          meta,
          args: engineArgs,
          ...(cfg.subagentProvider !== undefined ? { subagentProvider: cfg.subagentProvider } : {}),
          ...(cfg.maxTotalAgents !== undefined ? { maxTotalAgents: cfg.maxTotalAgents } : {}),
          parent,
          signal: exec.signal,
        })

        let result: WorkflowResult
        try {
          result = await run.result
        } finally {
          await run.dispose()
        }

        // R1 取消态映射：引擎无独立 cancelled 负载语义——stopReason 'cancelled' 即取消（killed 语义），
        // 前台按规格降级为结构化负载而非抛错（评审 F1）；'error' 是真故障，抛错携带引擎信息供重试。
        if (result.stopReason === 'cancelled') {
          const degraded: { ok: boolean; status: RunStatus; runId: string } = {
            ok: false,
            status: 'degraded',
            runId: String(run.id),
          }
          return degraded
        }
        if (result.stopReason !== 'completed') {
          throw new Error(
            `deep_research: workflow run ${result.stopReason}${result.error !== undefined ? ` (${result.error})` : ''}`,
          )
        }

        const shaped = shapeScriptResult(result.value)

        // T4：产物落盘（尽力而为；失败则负载退化为无指针形态，不炸工具）
        let reportPath: string | undefined
        let artifactsDir: string | undefined
        try {
          const workspaceDir = resolveWorkspaceDir(config.workspaceDir, parentCwd)
          const paths = await persistArtifacts(workspaceDir, sessionId, String(run.id), shaped)
          reportPath = paths.reportPath
          artifactsDir = paths.dir
          await pruneRuns(workspaceDir, sessionId, cfg.keepRuns)
        } catch {
          // 落盘失败是有意静默：前台没有进度缓冲可写，注入 logger 会扩大服务接缝依赖。
          // 唯一信号即负载缺指针；交付证据仍在紧凑负载中，不受影响。
        }

        return {
          ok: true,
          status: 'completed' as RunStatus,
          ...(reportPath !== undefined ? { reportPath } : {}),
          ...(artifactsDir !== undefined ? { artifactsDir } : {}),
          rounds: shaped.rounds,
          subquestions: shaped.subquestions,
          completed: shaped.completed,
          failed: shaped.failed,
          verification: {
            status: shaped.verification.status,
            claims: shaped.verification.claims,
            issues: shaped.verification.issues,
          },
        }
      },
    }),
  )
}
