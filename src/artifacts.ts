/**
 * dsh-deep-research v2 — 宿主侧产物持久化（实现工单 T4）。
 *
 * 设计依据（spec §产物持久化）：workflow 脚本无 fs（物理边界），"文件交接"只能由宿主侧实现。
 * run 开始即建 `<workspaceDir>/<sessionId>/<runId>/`，run 结束后把脚本返回的中间态一次性落盘：
 *   plan.json / rounds/<round>-<n>.json / blindspots.json / report.md /
 *   evidence_state.md / verification.json / review.md
 * 工具返回紧凑负载只携带 reportPath/artifactsDir 指针，全量正文不进工具返回值。
 *
 * per-session 子目录防多会话目录串扰（审核 C5）；keepRuns 保留最近 N 个 run（默认 20），
 * 超出按目录 mtime 从旧到新惰性清理。落盘失败不炸工具——降级为负载中的 warning 字段。
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

/** 脚本返回记录中单条研究项的形状（与 src/script.ts normalize* 对齐）。 */
interface EvidenceItem {
  id: string
  question: string
  round: number
  blind: boolean
  ok: boolean
  error: string
  obtainable?: boolean | null
  reason?: string
  evidence: {
    confirmed: Array<{ claim: string; source: string; confidence: string }>
    uncertain: Array<{ point: string; reason: string }>
    gaps: Array<{ aspect: string; priority: string }>
  }
}

/** verification.status 的封闭词表；宿主白名单校验之外归 'unknown'（评审 F3/F8）。 */
export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'unavailable' | 'unknown'

/** 脚本返回值中宿主关心的字段（已按 shapePayload 校验过的基础形态）。 */
export interface ScriptResultShape {
  report: string
  report_note: string
  review: string
  rounds: number
  subquestions: number
  completed: number
  failed: number
  plan: unknown
  items: EvidenceItem[]
  dropped_by_cap: Array<{ id: string; question: string }>
  blindspots: Array<{ gap: string; obtainable: boolean; reason: string }>
  evidence_state: string
  verification: {
    status: VerificationStatus
    claims: { verified: number; unverified: number; refuted: number }
    issues: string[]
    uncovered_dimensions: string[]
    overconfident: Array<{ claim: string; reason: string }>
    revision_rounds: number
  }
}

export interface ArtifactPaths {
  /** 本次 run 的产物根目录：`<workspaceDir>/<sessionId>/<runId>/`。 */
  dir: string
  reportPath: string
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unnamed'
}

/** 解析 workspaceDir：显式配置优先，否则取父会话 cwd 下的 `.research`。 */
export function resolveWorkspaceDir(configured: string | undefined, parentCwd: string | undefined): string {
  if (configured !== undefined && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(parentCwd !== undefined && parentCwd.length > 0 ? parentCwd : process.cwd(), '.research')
}

/**
 * 把一次完成的 run 的全部产物写入磁盘。
 * @returns 产物目录与报告路径；抛错由调用方决定是否降级。
 */
export async function persistArtifacts(
  workspaceDir: string,
  sessionId: string,
  runId: string,
  result: ScriptResultShape,
): Promise<ArtifactPaths> {
  const dir = path.join(workspaceDir, sanitizeSegment(sessionId), sanitizeSegment(runId))
  const roundsDir = path.join(dir, 'rounds')
  await mkdir(roundsDir, { recursive: true })

  await writeFile(path.join(dir, 'plan.json'), JSON.stringify(result.plan, null, 2), 'utf8')

  // rounds/<round>-<n>.json — 按 round 分组、组内 1-based 序号
  const byRound = new Map<number, EvidenceItem[]>()
  for (const item of result.items) {
    const list = byRound.get(item.round)
    if (list === undefined) byRound.set(item.round, [item])
    else list.push(item)
  }
  for (const [round, list] of byRound) {
    let n = 0
    for (const item of list) {
      n += 1
      await writeFile(path.join(roundsDir, `${round}-${n}.json`), JSON.stringify(item, null, 2), 'utf8')
    }
  }

  await writeFile(path.join(dir, 'blindspots.json'), JSON.stringify(result.blindspots, null, 2), 'utf8')
  await writeFile(path.join(dir, 'report.md'), result.report, 'utf8')
  await writeFile(path.join(dir, 'evidence_state.md'), result.evidence_state, 'utf8')
  await writeFile(
    path.join(dir, 'verification.json'),
    JSON.stringify(
      {
        status: result.verification.status,
        claims: result.verification.claims,
        issues: result.verification.issues,
        uncovered_dimensions: result.verification.uncovered_dimensions,
        overconfident: result.verification.overconfident,
        revision_rounds: result.verification.revision_rounds,
        report_note: result.report_note,
        dropped_by_cap: result.dropped_by_cap,
      },
      null,
      2,
    ),
    'utf8',
  )
  if (result.review.length > 0) {
    await writeFile(path.join(dir, 'review.md'), result.review, 'utf8')
  }
  return { dir, reportPath: path.join(dir, 'report.md') }
}

/**
 * keepRuns 保留策略：仅保留本会话最近 N 个 run 目录，其余删除。
 * 失败静默忽略（清理是尽力而为，不影响交付）。
 */
export async function pruneRuns(workspaceDir: string, sessionId: string, keepRuns: number): Promise<void> {
  if (!Number.isInteger(keepRuns) || keepRuns < 1) return
  try {
    const sessionDir = path.join(workspaceDir, sanitizeSegment(sessionId))
    const entries = await readdir(sessionDir)
    const runs: Array<{ name: string; mtime: number }> = []
    for (const name of entries) {
      const full = path.join(sessionDir, name)
      try {
        const info = await stat(full)
        if (!info.isDirectory()) continue
        runs.push({ name, mtime: info.mtimeMs })
      } catch {
        // 竞态删除的条目直接跳过
      }
    }
    runs.sort((a, b) => b.mtime - a.mtime)
    for (const stale of runs.slice(keepRuns)) {
      await rm(path.join(sessionDir, stale.name), { recursive: true, force: true })
    }
  } catch {
    // 会话目录尚不存在或不可清理——尽力而为策略，忽略
  }
}
