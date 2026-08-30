/**
 * Regression harness for dsh-deep-research v2 (ticket T6).
 *
 * Ported from upstream-v1 `regression.test.mjs`: the production workflow worker wraps the
 * script body as `(async () => { … })()` inside a fresh vm context exposing exactly
 * agent/parallel/pipeline/phase/log/args — this harness mirrors that shape with scripted
 * child agents, so every scenario below exercises the REAL static SCRIPT.
 *
 * Covered scenarios (per references/implementation-tickets.md T6):
 *   ① provided questions → skip planning, single-round convergence
 *   ② high-priority gap → automatic round 2, marginal gain zero → converge (no round 3)
 *   ③ no questions → planner runs, coverage_gaps become blind-recon queue entries
 *   ④ over-parallel workload → sliced parallel() calls, nothing dropped
 *   ⑤ verifier repair loop: refuted→revise→re-verify→passed; bounded non-convergence→failed;
 *     verifier crash→unavailable degradation
 *   ⑥ compact payload shape + verification.status vocabulary (+ pure-JSON round-trip)
 * Plus new-seam assertions: jobs bridge lifecycle (kind/killed-mapping/cancel/readOutput),
 * JobKindMap declaration merging, and artifact persistence/pruning.
 * Review-fix batch: question-list numbering disambiguation, absent-plan degradation,
 * dot-segment traversal hardening.
 *
 * Run: node --test tests/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, readdir, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Load an erasable-only TS source module through type stripping (data-URL dynamic import). */
async function importSrc(name) {
  const full = path.join(ROOT, 'src', name)
  const src = stripTypeScriptTypes(await readFile(full, 'utf8'), { mode: 'strip' })
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

// ---------------------------------------------------------------- engine mirror

/**
 * Mirrors @deepseek-ai/dsh-workflow-worker-thread/runtime.ts: fresh contextified global,
 * hook surface identical to production, per-item null dissolution in parallel(), same wrapper.
 */
function makeEngine(agentImpl, overrides = {}) {
  const phases = []
  const logs = []
  const parallelSizes = []
  async function parallel(thunks) {
    parallelSizes.push(thunks.length)
    return Promise.all(
      thunks.map((thunk) =>
        Promise.resolve()
          .then(thunk)
          .catch(() => null),
      ),
    )
  }
  async function run(args) {
    const context = vm.createContext({})
    Object.assign(context, {
      agent: agentImpl,
      parallel: overrides.parallel ?? parallel,
      pipeline: async () => {
        throw new Error('pipeline() is not part of the v2 pipeline')
      },
      phase: (title) => phases.push(title),
      log: (message) => logs.push(message),
      args,
    })
    const compiled = new vm.Script(`(async () => {\n${RESEARCH_SCRIPT}\n})()`, {
      filename: 'workflow:deep-research',
    })
    const value = await compiled.runInContext(context)
    return { value, phases, logs }
  }
  return { run, phases, logs, parallelSizes }
}

const { RESEARCH_SCRIPT } = await importSrc('script.ts')

// ---------------------------------------------------------------- scripted agents

let agentLog = []
function resetAgentLog() {
  agentLog = []
}
const labels = () => agentLog

function baseArgs(extra = {}) {
  return {
    topic: '回归测试主题',
    purpose: '支撑一次演示决策',
    depth: 2,
    synthesize: true,
    verify: true,
    review: false,
    language: 'zh',
    searchBudget: 3,
    maxParallel: 4,
    verifierMaxRounds: 2,
    maxItemsPerCall: 4096,
    models: {},
    ...extra,
  }
}

/** Researcher reply factory: stable confirmed evidence + optional uncertainty/high-gap. */
function researcherReply({ highGap = undefined } = {}) {
  return {
    confirmed: [{ claim: '事实甲 [A]', source: 'https://a.example/x', confidence: 'high' }],
    uncertain: [{ point: '待核实点', reason: '来源不可达' }],
    gaps: highGap ? [{ aspect: highGap, priority: 'high' }] : [],
  }
}

const PLANNER_PLAN = {
  scope: '测试范围与边界',
  dimensions: ['维度A', '维度B'],
  questions: [
    { question: '子问题一？', dimension: '维度A', keywords: ['k1'], acceptance: '有官方数据' },
    { question: '子问题二？', dimension: '维度B', keywords: [], acceptance: '' },
  ],
  coverage_gaps: ['某统计数据是否公开可得'],
}

/** Standard scripted agent covering every role label the SCRIPT emits; per-test overrides keyed by predicate. */
function makeAgent(overrides = []) {
  return async (prompt, opts = {}) => {
    const label = opts.label ?? '(unlabeled)'
    agentLog.push(label)
    for (const [match, handler] of overrides) {
      if (match(label)) return handler(label, prompt, opts)
    }
    if (label === 'planner') return structuredClone(PLANNER_PLAN)
    if (label.startsWith('research:')) return researcherReply()
    if (label.startsWith('recon:')) return { obtainable: false, findings: [], reason: '无公开数据源' }
    if (label.startsWith('synthesizer')) return '# 综合报告\n\n## 摘要\n正文。'
    if (label.startsWith('verifier')) {
      return {
        claims: [{ claim: '事实甲 [A]', source: 'https://a.example/x', status: 'verified', reason: '' }],
        uncovered_dimensions: [],
        overconfident: [],
        needs_revision: false,
        blocking_issues: [],
      }
    }
    if (label === 'reviewer') return '审查意见：无重大问题。'
    throw new Error('unexpected agent label: ' + label)
  }
}

async function runWith(agent, args, overrides = {}) {
  resetAgentLog()
  const engine = makeEngine(agent, overrides)
  const out = await engine.run(baseArgs(args))
  return { ...out, engine }
}

// ---------------------------------------------------------------- pipeline scenarios

test('① provided questions skip the planner and converge in a single round', async () => {
  const { value } = await runWith(makeAgent(), {
    // the host pre-parses the questions textarea into {question} entries before injecting args
    questions: [{ question: '已有问题一' }, { question: '已有问题二' }],
    depth: 3,
  })
  assert.equal(labels().filter((l) => l === 'planner').length, 0, 'planner must be skipped')
  assert.ok(labels().includes('research:q1'), 'q1 researched directly from provided list')
  assert.ok(labels().includes('research:q2'), 'q2 researched directly from provided list')
  assert.equal(value.rounds, 1, 'no high gaps → single round')
  assert.equal(value.subquestions, 2)
  assert.equal(value.completed, 2)
  assert.equal(value.failed, 0)
  assert.equal(value.plan.source, 'provided', 'plan records the provided-list provenance')
})

test('② high-priority gap dispatches round 2; zero marginal gain converges before the cap', async () => {
  const agent = makeAgent([
    [
      (l) => l.startsWith('research:') && !l.includes('-f'),
      () => researcherReply({ highGap: '跟进缺口X的量化数据' }),
    ],
  ])
  const { value } = await runWith(agent, { depth: 3 }) // round cap 4, must stop at 2
  assert.ok(labels().includes('research:q1-f1'), 'follow-up item queued from the high gap')
  assert.equal(value.rounds, 2, 'exactly one adaptive extra round')
  assert.ok(
    !labels().some((l) => /^research:.+-f\d+-f/.test(l)),
    'round-2 evidence carries no high gap → convergence despite remaining budget',
  )
  const seen = new Set()
  for (const l of labels()) {
    const m = /^research:(.+)$/.exec(l)
    if (m) {
      assert.ok(!seen.has(m[1]), `no duplicate dispatch for ${m[1]}`)
      seen.add(m[1])
    }
  }
})

test('③ planner runs without questions; coverage_gaps become blind-recon queue entries', async () => {
  const { value } = await runWith(makeAgent(), {})
  assert.equal(labels()[0], 'planner', 'planner runs first')
  assert.ok(labels().includes('recon:b3'), 'coverage gap joins the queue as blind item b3')
  const recon = value.items.find((i) => i.blind)
  assert.ok(recon, 'blind record archived')
  assert.equal(recon.obtainable, false, 'recon verdict surfaced')
  assert.ok(value.blindspots.length === 1 && value.blindspots[0].obtainable === false, 'blindspot summary updated')
  assert.ok(
    recon.evidence.uncertain.some((u) => u.point.includes('已验证盲区')),
    'unobtainable gap lands as an explicit verified-blindspot uncertainty',
  )
})

test('④ over-parallel workload is sliced by min(maxParallel, maxItemsPerCall) and never dropped', async () => {
  const fiveQuestions = Array.from({ length: 5 }, (_, i) => ({ question: `批量问题${i + 1}` }))
  resetAgentLog()
  const sizes = []
  const engine = makeEngine(makeAgent(), {
    parallel: async (thunks) => {
      sizes.push(thunks.length)
      return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)))
    },
  })
  const { value } = await engine.run(baseArgs({ questions: fiveQuestions, maxParallel: 2 }))
  assert.deepEqual(sizes, [2, 2, 1], 'slices sized min(maxParallel=2, maxItemsPerCall)')
  assert.equal(value.completed, 5, 'all five subquestions researched (nothing silently dropped)')
  assert.equal(value.failed, 0)
  assert.equal(value.rounds, 1)
})

test('⑤a repair loop: refuted → revise-only-flagged-sections → re-verify passes', async () => {
  let verifierCalls = 0
  const agent = makeAgent([
    [
      (l) => l.startsWith('verifier'),
      () => {
        verifierCalls += 1
        const first = verifierCalls === 1
        return {
          claims: [
            {
              claim: '事实甲 [A]',
              source: 'https://a.example/x',
              status: first ? 'refuted' : 'verified',
              reason: first ? '与官方口径矛盾' : '',
            },
          ],
          uncovered_dimensions: [],
          overconfident: [],
          needs_revision: first,
          blocking_issues: first ? ['修正事实甲'] : [],
        }
      },
    ],
    [(l) => l.startsWith('synthesizer-rev'), () => '# 修订版报告\n（已按 verifier 意见修订）'],
  ])
  const { value } = await runWith(agent, {})
  assert.ok(labels().includes('synthesizer-rev1'), 'revision synthesis invoked once')
  assert.ok(labels().includes('verifier-r2'), 'verifier re-runs after revision')
  assert.equal(value.report, '# 修订版报告\n（已按 verifier 意见修订）', 'revised report replaces the original')
  assert.equal(value.verification.revision_rounds, 1)
  assert.equal(value.verification.status, 'passed')
  assert.equal(value.verification.claims.refuted, 0)
})

test('⑤b bounded loop: verifierMaxRounds=0 never revises and degrades honestly to failed', async () => {
  const agent = makeAgent([
    [
      (l) => l.startsWith('verifier'),
      () => ({
        claims: [{ claim: '事实甲 [A]', source: 's', status: 'refuted', reason: '矛盾' }],
        uncovered_dimensions: [],
        overconfident: [],
        needs_revision: true,
        blocking_issues: ['必须修正'],
      }),
    ],
  ])
  const { value } = await runWith(agent, { verifierMaxRounds: 0 })
  assert.ok(!labels().some((l) => l.startsWith('synthesizer-rev')), 'no revision beyond the bound')
  assert.equal(value.verification.status, 'failed', 'honest degradation, delivery not blocked')
  assert.equal(value.verification.revision_rounds, 0)
  assert.ok(value.report.length > 0, 'report preserved with explicit annotations')
})

test('⑤c verifier failure degrades to unavailable instead of failing the run', async () => {
  const agent = makeAgent([[(l) => l.startsWith('verifier'), () => null]])
  const { value } = await runWith(agent, {})
  assert.equal(value.verification.status, 'unavailable')
  assert.ok(value.verification.issues.some((i) => i.includes('verifier agent failed')))
  assert.ok(value.report.length > 0)
})

test('⑥ compact payload shape, verification.status vocabulary, pure-JSON round-trip', async () => {
  const { value } = await runWith(makeAgent(), { review: true })
  for (const key of [
    'report',
    'report_note',
    'review',
    'rounds',
    'subquestions',
    'completed',
    'failed',
    'plan',
    'items',
    'dropped_by_cap',
    'blindspots',
    'evidence_state',
    'verification',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(value, key), `payload carries ${key}`)
  }
  assert.equal(typeof value.rounds, 'number')
  assert.equal(typeof value.subquestions, 'number')
  assert.ok(Array.isArray(value.items))
  assert.ok(Array.isArray(value.blindspots))
  for (const item of value.items) {
    for (const key of ['id', 'question', 'round', 'blind', 'ok', 'error', 'evidence']) {
      assert.ok(Object.prototype.hasOwnProperty.call(item, key), `item ${item.id} carries ${key}`)
    }
  }
  assert.ok(['passed', 'failed', 'skipped', 'unavailable'].includes(value.verification.status))
  assert.match(value.review, /审查意见/)
  // Plain-JSON check by stable re-stringification (deepStrictEqual would compare vm-realm
  // prototypes against host-realm ones and false-fail even for perfectly plain data).
  const json = JSON.stringify(value)
  assert.equal(JSON.stringify(JSON.parse(json)), json, 'return value round-trips as plain JSON')
})

test('⑥b synthesize=false skips synthesis and verifies evidence lightly (R4 branch)', async () => {
  const { value } = await runWith(makeAgent(), { synthesize: false })
  assert.ok(!labels().some((l) => l.startsWith('synthesizer')), 'synthesizer skipped')
  assert.ok(labels().includes('verifier-evidence'), 'lightweight evidence verification runs instead')
  assert.ok(!labels().includes('verifier'), 'no post-report verifier in the synthesize=false branch')
  assert.equal(value.verification.status, 'passed')
  assert.ok(value.evidence_state.includes('[confirmed]'), 'evidence_state digest retained for persistence')
})

test('⑦ per-agent budget = min(searchBudget, LIMIT(depth))（评审 F4）', async () => {
  const seen = []
  const agent = (prompt, opts = {}) => {
    const label = opts.label ?? ''
    if (label === 'planner') return structuredClone(PLANNER_PLAN)
    if (label.startsWith('research:')) seen.push(prompt)
    return researcherReply()
  }
  // depth=1 → LIMIT=2，即使 searchBudget 默认更宽
  await runWith(agent, { depth: 1 })
  assert.match(seen[0], /工具调用总次数不超过 2 次/, 'LIMIT(1)=2 wins')
  // depth=3、searchBudget=5 → min(5,4)=4
  seen.length = 0
  await runWith(agent, { depth: 3, searchBudget: 5 })
  assert.match(seen[0], /工具调用总次数不超过 4 次/, 'min(budget, LIMIT(3)=4)')
  // searchBudget 更紧时以配置为准：depth=2、budget=2 → 2
  seen.length = 0
  await runWith(agent, { depth: 2, searchBudget: 2 })
  assert.match(seen[0], /工具调用总次数不超过 2 次/, 'tighter searchBudget wins')
})

// ---------------------------------------------------------------- T5 jobs bridge

function fakeRuntime({ result, finalizeSummary } = {}) {
  let listenerCount = 0
  const handlers = []
  const cancelCalls = []
  let disposed = 0
  let releaseResult
  const resultPromise = result
    ? Promise.resolve(result)
    : new Promise((resolve) => {
        releaseResult = resolve
      })
  return {
    owner: { id: 'sess-owner' },
    finalizeSummary,
    capturedSpec: undefined,
    startedSignal: undefined,
    release: releaseResult,
    ctx: {
      on(event, handler) {
        listenerCount += 1
        handlers.push([event, handler])
        return () => {
          listenerCount -= 1
        }
      },
      emit(event, info, payload) {
        for (const [e, h] of handlers) if (e === event) h(info, payload)
      },
    },
    run: {
      id: 'wf-run-1',
      result: resultPromise,
      cancel(reason) {
        cancelCalls.push(reason)
      },
      async dispose() {
        disposed += 1
      },
    },
    get listenerCount() {
      return listenerCount
    },
    get disposeCount() {
      return disposed
    },
    get cancelCalls() {
      return cancelCalls
    },
  }
}

async function setupBridgeTests() {
  const { startBackgroundRun } = await importSrc('background.ts')

  function startInBackground(rt, extraDeps = {}) {
    return startBackgroundRun({
      ctx: rt.ctx,
      jobs: { start: (spec) => ((rt.capturedSpec = spec), 'deep-research-7') },
      owner: rt.owner,
      label: '深度研究：测试',
      start: (signal) => {
        rt.startedSignal = signal
        return rt.run
      },
      ...(rt.finalizeSummary !== undefined ? { finalize: async () => rt.finalizeSummary } : {}),
      ...extraDeps,
    })
  }

  return { startBackgroundRun, startInBackground }
}

const bridge = await setupBridgeTests()

test('T5 registration is synchronous: kind deep-research, live owner, sync hooks factory', () => {
  const rt = fakeRuntime({ result: { stopReason: 'completed', value: {} } })
  bridge.startInBackground(rt)
  const spec = rt.capturedSpec
  assert.ok(spec, 'jobs.start invoked')
  assert.equal(spec.kind, 'deep-research', 'registry receives the merged job kind')
  assert.equal(spec.owner, rt.owner, 'owner is the live agent instance')
  assert.equal(typeof spec.run, 'function', 'run() available synchronously')
})

test('T5 done settles completed with the finalize summary; mirrors detach; disposed once', async () => {
  const rt = fakeRuntime({ result: { stopReason: 'completed', value: {} }, finalizeSummary: 'status=passed rounds=1 report=/x/report.md' })
  const jobId = bridge.startInBackground(rt)
  assert.equal(jobId, 'deep-research-7', 'registry-issued id returned')
  const hooks = rt.capturedSpec.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /status=passed rounds=1/)
  assert.equal(rt.listenerCount, 0, 'workflow/* mirrors detach after settlement')
  assert.equal(rt.disposeCount, 1)
})

test('T5 engine cancelled maps to jobs killed (R1: no cancelled terminal status)', async () => {
  const rt = fakeRuntime({ result: { stopReason: 'cancelled', error: 'workflow run cancelled: user abort' } })
  bridge.startInBackground(rt)
  const hooks = rt.capturedSpec.run()
  assert.equal((await hooks.done).status, 'killed')
})

test('T5 engine error maps to failed carrying the engine message', async () => {
  const rt = fakeRuntime({ result: { stopReason: 'error', error: 'ITEM_CAP blown' } })
  bridge.startInBackground(rt)
  const hooks = rt.capturedSpec.run()
  const outcome = await hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /ITEM_CAP/)
})

test('T5 cancel() aborts the engine signal and calls run.cancel as belt-and-braces', async () => {
  const rt = fakeRuntime()
  bridge.startInBackground(rt)
  const hooks = rt.capturedSpec.run()
  assert.equal(rt.startedSignal.aborted, false)
  hooks.cancel('user requested stop')
  assert.equal(rt.startedSignal.aborted, true)
  assert.equal(rt.cancelCalls.length, 1)
  assert.match(rt.cancelCalls[0], /user requested stop/)
  rt.release({ stopReason: 'cancelled' })
  assert.equal((await hooks.done).status, 'killed')
})

test('T5 readOutput consumes deltas scoped to this run; cursor drains to empty', async () => {
  const rt = fakeRuntime()
  bridge.startInBackground(rt)
  const hooks = rt.capturedSpec.run()
  const info = { id: 'wf-run-1' }
  rt.ctx.emit('workflow/phase', info, '规划')
  rt.ctx.emit('workflow/log', info, '第 1 轮启动')
  rt.ctx.emit('workflow/log', { id: 'OTHER-RUN' }, '别人的日志不应出现')
  const first = hooks.readOutput()
  assert.match(first, /\[phase\] 规划/)
  assert.match(first, /\[log\] 第 1 轮启动/)
  assert.doesNotMatch(first, /别人/)
  rt.ctx.emit('workflow/log', info, '第二条')
  const second = hooks.readOutput()
  assert.match(second, /第二条/)
  assert.doesNotMatch(second, /规划/, 'cursor consumed earlier lines')
  assert.equal(hooks.readOutput(), '')
  rt.release({ stopReason: 'completed', value: {} })
  await hooks.done
})

test('T5 finalize failure warns in progress but does not flip a completed run', async () => {
  const rt = fakeRuntime()
  bridge.startInBackground(rt, {
    finalize: async () => {
      throw new Error('disk exploded')
    },
  })
  const hooks = rt.capturedSpec.run()
  rt.release({ stopReason: 'completed', value: {} })
  const outcome = await hooks.done
  assert.equal(outcome.status, 'completed')
})

test('T5 pre-aborted tool signal hands the engine an already-aborted signal', async () => {
  const controller = new AbortController()
  controller.abort('gone early')
  let received
  const rt = fakeRuntime({ result: { stopReason: 'cancelled' } })
  bridge.startInBackground(rt, {
    externalSignal: controller.signal,
    start: (signal) => {
      received = signal
      rt.startedSignal = signal
      return rt.run
    },
  })
  const hooks = rt.capturedSpec.run()
  assert.equal(received.aborted, true)
  assert.equal((await hooks.done).status, 'killed')
})

test('JobKindMap declaration merging is declared in the plugin entry', async () => {
  const entry = await readFile(path.join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(entry, /interface JobKindMap \{ 'deep-research': 'deep-research' \}/)
})

// ---------------------------------------------------------------- T4 artifact persistence

test('artifacts: full layout per run; review.md conditional; keepRuns pruning; workspace resolution', async () => {
  const { persistArtifacts, pruneRuns, resolveWorkspaceDir } = await importSrc('artifacts.ts')

  const shaped = {
    report: '# 报告',
    report_note: '',
    review: '审查意见文本',
    rounds: 2,
    subquestions: 2,
    completed: 3,
    failed: 0,
    plan: { scope: 's', dimensions: [], questions: [], coverage_gaps: [], source: 'planner' },
    items: [
      itemRecord('q1', 1, false),
      itemRecord('q2', 1, false),
      itemRecord('q1-f1', 2, false),
      itemRecord('b3', 1, true),
    ],
    dropped_by_cap: [],
    blindspots: [{ gap: 'g', obtainable: false, reason: 'r' }],
    evidence_state: '[confirmed][high] x —— s',
    verification: {
      status: 'passed',
      claims: { verified: 1, unverified: 0, refuted: 0 },
      issues: [],
      uncovered_dimensions: [],
      overconfident: [],
      revision_rounds: 0,
    },
  }

  const base = await mkdtemp(path.join(tmpdir(), 'dsh-deep-research-test-'))
  try {
    const paths = await persistArtifacts(base, 'session/with:weird*chars', 'run/1', shaped)
    assert.equal(
      paths.dir,
      path.join(base, 'session_with_weird_chars', 'run_1'),
      'sessionId/runId sanitized into safe segments (C5 anti-crosstalk)',
    )
    assert.ok(existsSync(path.join(paths.dir, 'plan.json')))
    assert.ok(existsSync(path.join(paths.dir, 'blindspots.json')))
    assert.ok(existsSync(path.join(paths.dir, 'report.md')))
    assert.ok(existsSync(path.join(paths.dir, 'evidence_state.md')))
    assert.ok(existsSync(path.join(paths.dir, 'verification.json')))
    assert.ok(existsSync(path.join(paths.dir, 'review.md')), 'review persisted when non-empty')
    const roundsDir = path.join(paths.dir, 'rounds')
    assert.ok(existsSync(path.join(roundsDir, '1-1.json')))
    assert.ok(existsSync(path.join(roundsDir, '1-2.json')))
    assert.ok(existsSync(path.join(roundsDir, '2-1.json')), 'second-round items numbered within their round')

    const paths2 = await persistArtifacts(base, 'sess2', 'runA', { ...shaped, review: '' })
    assert.ok(!existsSync(path.join(paths2.dir, 'review.md')), 'empty review omits review.md')

    for (const name of ['old', 'mid', 'new']) {
      await persistArtifacts(base, 'sess-prune', name, { ...shaped, review: '' })
    }
    const oldDir = path.join(base, 'sess-prune', 'old')
    const midDir = path.join(base, 'sess-prune', 'mid')
    await utimes(oldDir, new Date(Date.now() - 100_000), new Date(Date.now() - 100_000))
    await utimes(midDir, new Date(Date.now() - 50_000), new Date(Date.now() - 50_000))
    await pruneRuns(base, 'sess-prune', 2)
    const remaining = await readdir(path.join(base, 'sess-prune'))
    assert.equal(remaining.length, 2, 'keepRuns=2 prunes the stalest run')
    assert.ok(!remaining.includes('old'))

    assert.equal(resolveWorkspaceDir('/custom/ws', '/tmp/cwd'), path.resolve('/custom/ws'))
    assert.equal(resolveWorkspaceDir(undefined, '/tmp/cwd'), path.join('/tmp/cwd', '.research'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }

  function itemRecord(id, round, blind) {
    return {
      id,
      question: '问题 ' + id,
      round,
      blind,
      ok: true,
      error: '',
      ...(blind ? { obtainable: false, reason: 'r' } : {}),
      evidence: {
        confirmed: [{ claim: 'c', source: 's', confidence: 'high' }],
        uncertain: [],
        gaps: [],
      },
    }
  }
})

// ---------------------------------------------------------------- T4 hardening regressions

/** Minimal valid ScriptResultShape for persistence-focused hardening tests. */
function makeShaped(overrides = {}) {
  return {
    report: '# 报告',
    report_note: '',
    review: '',
    rounds: 1,
    subquestions: 1,
    completed: 1,
    failed: 0,
    plan: { scope: 's', dimensions: [], questions: [], coverage_gaps: [] },
    items: [],
    dropped_by_cap: [],
    blindspots: [],
    evidence_state: '',
    verification: {
      status: 'passed',
      claims: { verified: 0, unverified: 0, refuted: 0 },
      issues: [],
      uncovered_dimensions: [],
      overconfident: [],
      revision_rounds: 0,
    },
    ...overrides,
  }
}

test('hardening: an absent plan degrades to null instead of killing all persistence', async () => {
  const { persistArtifacts } = await importSrc('artifacts.ts')
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-deep-research-test-'))
  try {
    const paths = await persistArtifacts(base, 'sess-hard', 'run-plan-null', makeShaped({ plan: undefined }))
    assert.ok(existsSync(path.join(paths.dir, 'report.md')), 'report.md still persisted')
    assert.equal(await readFile(path.join(paths.dir, 'plan.json'), 'utf8'), 'null', 'plan.json written as JSON null')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('hardening: dot-only session/run segments cannot traverse out of the workspace root', async () => {
  const { persistArtifacts } = await importSrc('artifacts.ts')
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-deep-research-test-'))
  try {
    const paths = await persistArtifacts(base, '..', '...', makeShaped())
    assert.equal(paths.dir, path.join(base, 'unnamed', 'unnamed'), "dot-only segments collapse to a placeholder")
    assert.ok(existsSync(path.join(paths.dir, 'report.md')))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- T2 question-list parsing

test('question list parsing: numbering stripped only when unambiguous (review fix)', async () => {
  const { parseQuestionList } = await importSrc('questions.ts')
  // 无歧义编号（点号+空白 / 顿号 / 右括号）→ 剥离
  assert.deepEqual(
    parseQuestionList('1. 甲\n2、乙\n3) 丙'),
    [{ question: '甲' }, { question: '乙' }, { question: '丙' }],
  )
  // 以数字开头的内容本身不得误伤（旧实现把 "3.14 是什么" 错剥成 "14 是什么"）
  assert.deepEqual(parseQuestionList('3.14 是什么'), [{ question: '3.14 是什么' }])
  assert.deepEqual(parseQuestionList('2.0版本发布了哪些变化？'), [{ question: '2.0版本发布了哪些变化？' }])
  // 紧凑点号写法（编号后无空格）：宁可少剥不可错剥
  assert.deepEqual(parseQuestionList('1.甲'), [{ question: '1.甲' }])
  // 空行/纯空白行丢弃；非字符串入参返回空数组
  assert.deepEqual(parseQuestionList('\n  \n甲\n'), [{ question: '甲' }])
  assert.deepEqual(parseQuestionList(undefined), [])
})

// ════════════════════════════════════════════════════════════════════════════
// ⑧ workflowEngine 为调用期能力：经 resolveWorkflowEngine 三链解析
// （OMDSH 上游 PR#5 方案的 Web 化升级版）。
// web/production preset 把引擎 isolate 在会话 delegation 组内，root 无实例，
// 且 entry-local realm 对 agent 根 ctx 与 host 平面均不可见——因此既不能加载期
// inject（root 挂载会永久 pending），也不能只靠 exec.agent.ctx.get()。解析链：
//   ① serviceForAgent(ctx, parent, 'workflowEngine')（官方 READ 寻址，真实运行时
//      命中 isolate 组实例；桩 ctx 无 scope/reflect 时宽松降级）；
//   ② exec.agent.ctx.get('workflowEngine')（引擎直接注册在 agent 作用域的部署）；
//   ③ ctx.get('workflowEngine')（host 平面挂载）。
// ════════════════════════════════════════════════════════════════════════════

test('⑧ inject 不含 workflowEngine；调用时经解析链取引擎；缺失报明确错误', async () => {
  // index.ts 有裸导入（@deepseek-ai/dsh-tools），data-URL 方式解析不了；
  // 直接以 Node 原生类型剥离加载真实模块（Node >= 22.18）。
  const idxUrl = new URL('../src/index.ts', import.meta.url).href
  const { apply, inject } = await import(idxUrl)
  assert.deepEqual(inject, ['tools', 'jobs', 'commands'], 'workflowEngine 不参与加载期 inject（root 无实例，注入会挂死）')
  let registered
  const hostCtx = { tools: { register: (def) => { registered = def } }, effect: () => () => {} }
  apply(hostCtx, {})
  assert.ok(registered, 'deep_research 工具已注册')
  const base = await mkdtemp(path.join(tmpdir(), 'ddr-engine-scope-'))
  try {
    const agentOf = (get) => ({ id: 'a1', session: { header: { cwd: base } }, ctx: { get } })
    const execOf = (agent) => ({ agent, signal: new AbortController().signal })
    const fakeEngineFor = (started) => ({
      start: (request) => {
        started.push(request)
        return {
          id: 'run-1',
          result: Promise.resolve({ stopReason: 'completed', value: { report: '# r' } }),
          cancel: () => {},
          dispose: async () => {},
        }
      },
    })
    // a) 全部作用域无引擎（且桩 ctx 无 reflect——serviceForAgent 须宽松降级）→ 明确错误
    await assert.rejects(
      () => registered.execute({ topic: 't', background: false }, execOf(agentOf(() => undefined))),
      /workflowEngine unavailable/,
    )
    // b) ②链：agent 作用域有引擎 → 走该会话私有引擎实例（而非宿主 ctx）
    const startedB = []
    const agentB = agentOf((name) => (name === 'workflowEngine' ? fakeEngineFor(startedB) : undefined))
    const valueB = await registered.execute({ topic: 't', background: false }, execOf(agentB))
    assert.equal(startedB.length, 1, '②链：引擎 start 恰好一次')
    assert.equal(startedB[0].parent, agentB, 'parent 为调用者 agent')
    assert.equal(valueB.ok, true)
    assert.equal(valueB.status, 'completed')
    // c) ③链：agent 作用域为空、host 平面挂载引擎 → 回退命中（serviceForAgent 对无
    //    scope 桩安全降级后继续走 ②/③）
    const startedC = []
    const hostWithEngine = {
      tools: { register: (def) => { registered = def } },
      effect: () => () => {},
      get: (name) => (name === 'workflowEngine' ? fakeEngineFor(startedC) : undefined),
    }
    apply(hostWithEngine, {})
    const valueC = await registered.execute({ topic: 't', background: false }, execOf(agentOf(() => undefined)))
    assert.equal(startedC.length, 1, '③链：host 平面引擎被采用')
    assert.equal(valueC.status, 'completed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
