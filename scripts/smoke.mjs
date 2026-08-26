/**
 * 冒烟验证：用 vm 镜像引擎（与 @deepseek-ai/dsh-workflow-worker-thread 相同的包装方式）
 * 跑通 v2 流水线 SCRIPT —— 规划 → 研究（含高优缺口跟进第 2 轮）→ 综合 → 验证修复环
 * （首次 needs_revision=true，修订后通过）→ 返回纯 JSON。
 *
 * 用法：node scripts/smoke.mjs （Node ≥22.19，类型剥离原生支持）
 */
import vm from 'node:vm'
import { RESEARCH_SCRIPT } from '../src/script.ts'

/** 与引擎一致的调用形态；返回值即脚本 return。 */
async function runScript(scriptBody, args, hooksOverrides = {}) {
  const context = vm.createContext({})
  const globals = {
    agent: hooksOverrides.agent,
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    pipeline: async () => {
      throw new Error('pipeline not used by this script')
    },
    phase: (title) => phases.push(title),
    log: (message) => logs.push(message),
    args,
  }
  const phases = []
  const logs = []
  const compiled = new vm.Script(`(async () => {\n${scriptBody}\n})()`, { filename: 'workflow:smoke' })
  Object.assign(context, globals)
  const value = await compiled.runInContext(context)
  return { value, phases, logs }
}

function makeAgentHarness() {
  const calls = []
  let verifierCalls = 0
  const agent = async (prompt, opts = {}) => {
    const label = opts.label ?? '(unlabeled)'
    calls.push(label)
    if (label === 'planner') {
      return {
        scope: '测试范围',
        dimensions: ['维度A', '维度B'],
        questions: [
          { question: '子问题1？', dimension: '维度A', keywords: ['k1'], acceptance: '有数据' },
          { question: '子问题2？', dimension: '维度B', keywords: [], acceptance: '' },
        ],
        coverage_gaps: ['某统计数据是否公开可得'],
      }
    }
    if (label.startsWith('research:')) {
      // 子问题1 首轮带一个 high 缺口 → 应触发第 2 轮跟进
      const highGap = label === 'research:q1' && !calls.includes('research:q1-f*')
      return {
        confirmed: [{ claim: '事实甲 [A]', source: 'https://example.com/a', confidence: highGap ? 'high' : 'medium' }],
        uncertain: [{ point: '不确定点', reason: '来源不可达' }],
        gaps: highGap ? [{ aspect: '缺口X的量化数据', priority: 'high' }] : [],
      }
    }
    if (label.startsWith('recon:')) {
      return { obtainable: true, findings: [{ claim: '该数据公开可得', source: 'https://example.com/data' }], reason: '' }
    }
    if (label.startsWith('synthesizer')) {
      return '# 测试报告\n\n## 摘要\n内容。' + (label.endsWith('rev1') ? '（已按 verifier 意见修订）' : '')
    }
    if (label.startsWith('verifier')) {
      verifierCalls += 1
      const first = verifierCalls === 1 && !label.startsWith('verifier-evidence')
      return {
        claims: [
          { claim: '事实甲 [A]', source: 'https://example.com/a', status: first ? 'refuted' : 'verified', reason: first ? '与官方口径矛盾' : '' },
        ],
        uncovered_dimensions: [],
        overconfident: [],
        needs_revision: first,
        blocking_issues: first ? ['修正事实甲'] : [],
      }
    }
    if (label === 'reviewer') return '审查意见：无重大问题。'
    throw new Error('unexpected agent label: ' + label)
  }
  return { agent, calls }
}

const harness = makeAgentHarness()
const { value, phases, logs } = await runScript(RESEARCH_SCRIPT, {
  topic: '冒烟测试主题',
  purpose: '支撑一次演示决策',
  depth: 2,
  synthesize: true,
  verify: true,
  review: true,
  language: 'zh',
}, { agent: harness.agent })

// ---------- 断言 ----------
const assert = (cond, message) => {
  if (!cond) {
    console.error('FAIL:', message)
    console.error('phases:', phases)
    console.error('logs:', logs)
    console.error('value:', JSON.stringify(value, null, 2))
    process.exit(1)
  }
}

assert(typeof value.report === 'string' && value.report.includes('# 测试报告'), 'report 由 synthesizer 产出')
assert(value.rounds === 2, `研究闭环应跑满 2 轮（首研+高优缺口跟进），实际 ${value.rounds}`)
assert(value.subquestions === 2, 'subquestions=2')
assert(value.completed >= 3, `completed≥3（q1/q2/盲区/跟进），实际 ${value.completed}`)
assert(value.items.some((i) => i.blind && i.ok), '盲区侦察并入队列且成功')
assert(value.items.some((i) => i.id.startsWith('q1-f')), '高优缺口生成跟进项')
assert(value.verification.revision_rounds === 1, '修复环恰好 1 轮')
assert(value.verification.status === 'passed', '修订后验证通过')
assert(value.verification.claims.refuted === 0 && value.verification.claims.verified >= 1, '终态 claims 统计正确')
assert(value.review.includes('审查意见'), 'review 文本返回')
assert(value.evidence_state.includes('[confirmed]'), 'evidence_state 为拼接副本')
assert(value.plan.source === 'planner', 'plan 归档')

console.log('SMOKE OK')
console.log('agent calls:', harness.calls.join(', '))
console.log('phases:', phases.join(' -> '))
console.log(`rounds=${value.rounds} completed=${value.completed} failed=${value.failed} verification=${value.verification.status} rev=${value.verification.revision_rounds}`)
