/**
 * dsh-deep-research v2 — 静态 SCRIPT（实现工单 T3）。
 *
 * 运行环境：DSH workflow 引擎 vm 沙箱，全局仅暴露
 *   agent(prompt, opts?) / parallel(thunks) / pipeline(items, ...stages) / phase(title) / log(msg) / args
 * 无 fs、无网络、无 Node API；agent() 选项仅 label/phase/schema/provider/model。
 *
 * 落实规格条目（docs/spec/dsh-deep-research.md）：
 *   - 流水线状态机：规划 → 研究(自适应闭环) → 综合 → 验证+修复环 → 可选审查（A3 单一时序）；
 *   - R3 切片：每轮子问题按 min(maxParallel, maxItemsPerCall) 切片，逐切片 parallel()（防 ITEM_CAP 致命失败）；
 *   - R4 分支：synthesize=false 时跳过综合，改为对中间证据轻量验证、不产 report；
 *   - A2 综合输入：脚本内存拼接的结构化精简证据（confirmed 仅 {claim,source,confidence}，uncertain/gaps 仅要点）；
 *   - 健壮性：单子问题失败→该节标注失败 run 继续（parallel thunk 溶解为 null 后按位归档）；规划失败→抛错；
 *     verifier/修复环失败→降级交付（verification.status='unavailable'/'failed'），绝不整体炸掉；
 *   - 边际增益收敛：轮末收集 high-priority gaps 作为 follow-up 排入下一轮；无新增 high 缺口或达 depth+1 轮上限即收敛；
 *   - 取消安全：脚本从不在 hook 外层 try/catch 吞 CANCELLED——fatal WorkflowError 穿透 parallel 直达引擎。
 *
 * 注意：本文件被 String.raw 嵌入宿主源码，脚本体内禁用反引号模板字符串与 ${ 插值，
 * 一律使用单引号 + 字符串拼接。返回值必须为纯 JSON（引擎 RESULT_UNSERIALIZABLE 兜底）。
 */
export const RESEARCH_SCRIPT = String.raw`
const topic = typeof args.topic === 'string' ? args.topic : '' // 宿主已校验非空；兜底为空串而非 "undefined"
const purpose = typeof args.purpose === 'string' ? args.purpose : ''
const language = typeof args.language === 'string' && args.language.length > 0 ? args.language : 'zh'
const depth = typeof args.depth === 'number' && args.depth >= 1 ? Math.floor(args.depth) : 2
const maxRounds = depth + 1
const searchBudget = typeof args.searchBudget === 'number' && args.searchBudget >= 1 ? Math.floor(args.searchBudget) : 6
// 规格 §研究子代理契约 LIMIT(depth)：每代理工具调用轮上限随精度收紧（1→2、2→3、3→4）；
// 生效预算 = min(searchBudget, LIMIT(depth))（评审 F4 落实，原为文档化偏差）
function limitOfDepth(d) { return d <= 1 ? 2 : d === 2 ? 3 : 4 }
const agentBudget = Math.min(searchBudget, limitOfDepth(depth))
const maxParallelCfg = typeof args.maxParallel === 'number' && args.maxParallel >= 1 ? Math.floor(args.maxParallel) : 4
const maxItemsPerCall = typeof args.maxItemsPerCall === 'number' && args.maxItemsPerCall >= 1 ? Math.floor(args.maxItemsPerCall) : 4096
// R3：切片大小 = min(maxParallel, maxItemsPerCall)，对每个切片调用一次 parallel()
const SLICE = Math.min(maxParallelCfg, maxItemsPerCall)
const verifierMaxRounds = typeof args.verifierMaxRounds === 'number' && args.verifierMaxRounds >= 0 ? Math.floor(args.verifierMaxRounds) : 2
const models = args.models && typeof args.models === 'object' && !Array.isArray(args.models) ? args.models : {}
const doSynthesize = args.synthesize !== false
const doVerify = args.verify !== false
const doReview = args.review === true

function str(v) { return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v) }
function arr(v) { return Array.isArray(v) ? v : [] }
function modelOpt(role) {
  const m = str(models[role])
  return m.length > 0 ? { model: m } : {}
}
function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…' }
function normKey(q) { return q.replace(/\s+/g, '').slice(0, 80) }
function langLine() { return '全程用 ' + language + ' 写作与思考。' }

// ---------- schemas（仅引擎子集：type/properties/required/additionalProperties/items/enum/const） ----------
const CONFIDENCE = { type: 'string', enum: ['high', 'medium', 'low'] }
const PRIORITY = { type: 'string', enum: ['high', 'medium', 'low'] }

const PLANNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: { type: 'string' },
    dimensions: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          dimension: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
        },
        required: ['question'],
      },
    },
    coverage_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['scope', 'dimensions', 'questions'],
}

const RESEARCHER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { claim: { type: 'string' }, source: { type: 'string' }, confidence: CONFIDENCE },
        required: ['claim', 'source', 'confidence'],
      },
    },
    uncertain: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { point: { type: 'string' }, reason: { type: 'string' } },
        required: ['point'],
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { aspect: { type: 'string' }, priority: PRIORITY },
        required: ['aspect'],
      },
    },
  },
  required: ['confirmed', 'uncertain', 'gaps'],
}

const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    obtainable: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { claim: { type: 'string' }, source: { type: 'string' } },
        required: ['claim', 'source'],
      },
    },
    reason: { type: 'string' },
  },
  required: ['obtainable'],
}

const VERIFIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          source: { type: 'string' },
          status: { type: 'string', enum: ['verified', 'unverified', 'refuted'] },
          reason: { type: 'string' },
        },
        required: ['claim', 'status'],
      },
    },
    uncovered_dimensions: { type: 'array', items: { type: 'string' } },
    overconfident: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { claim: { type: 'string' }, reason: { type: 'string' } },
        required: ['claim'],
      },
    },
    needs_revision: { type: 'boolean' },
    blocking_issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['claims', 'needs_revision'],
}

// ---------- prompts ----------
function plannerPrompt() {
  const lines = [
    '你是深度研究的规划代理。为给定主题定义答案空间并产出研究计划。',
    '',
    '主题：' + topic,
    purpose.length > 0 ? '研究用途（要支撑什么判断/决策）：' + purpose : '研究用途：未提供（请从主题推断最可能的决策语境）',
    '',
    '要求：',
    '1. scope：一句话界定研究范围与边界（什么在范围内、什么明确排除）；',
    '2. dimensions：枚举 4-8 个必须覆盖的信息维度（遗漏关键维度即盲区）；',
    '3. questions：每个维度 1-3 个具体、可研究、可验收的子问题，附检索关键词 keywords 与验收标准 acceptance（什么样的证据算回答了它）；',
    '4. coverage_gaps：显式声明你无法确定"信息是否可得"的研究盲区——它们将被定向侦察验证，绝不静默丢弃。',
    '硬性要求：宁可在 coverage_gaps 里如实声明盲区，也不得虚构维度或子问题。',
    langLine(),
    '严格按 schema 返回 JSON。',
  ]
  return lines.join('\n')
}

function researcherPrompt(item) {
  const lines = [
    '你是深度研究子代理，独立负责下面一个研究项。',
    '',
    '主题：' + topic,
    '研究项：' + item.question,
  ]
  if (purpose.length > 0) lines.push('研究用途：' + purpose)
  if (item.dimension.length > 0) lines.push('所属维度：' + item.dimension)
  if (item.keywords.length > 0) lines.push('建议关键词：' + item.keywords.join('、'))
  if (item.acceptance.length > 0) lines.push('验收标准：' + item.acceptance)
  lines.push(
    '',
    '工作纪律（预算制感知-行动循环）：',
    '1. 先凭已知给出初始最佳答案；',
    '2. 预测答案中信息熵最高、最可能推翻或改变结论的点；',
    '3. 行动：用 web_search / web_fetch 搜证，先宽后窄（短宽查询起步、按命中率收敛），工具调用总次数不超过 ' + agentBudget + ' 次；每次检索前先写一行「检索目标：这次要证实/证伪什么、预期把结论推向哪」——写不出目标的检索不要发起；',
    '4. 更新三态证据后做边际增益检验：新一轮搜索若不再带来实质新信息，立即停止，不要凑数。',
    '',
    '诚实纪律：',
    '- 步骤 1 的初始答案若未被后续检索证实，不得写入 confirmed——先验知识一律视同 uncertain；',
    '- 只列实际访问过的来源；不可达来源一律归入 uncertain，绝不编造；',
    '- 来源质量分级：A=官方一手 B=权威媒体/机构 C=二手转述 D=低可信，写进 claim 末尾如 [A]；',
    '- 找不到就承认找不到，把缺口写入 gaps 并标注优先级 high/medium/low。',
    langLine(),
    '严格按 schema 返回 JSON。',
  )
  return lines.join('\n')
}

function reconPrompt(gapText) {
  const lines = [
    '你是盲区侦察代理。规划阶段声明了一个"不确定信息是否可得"的覆盖盲区，需要你定向侦察并判定其可得性。',
    '',
    '主题背景：' + topic,
    '盲区：' + gapText,
    '',
    '判定标准：',
    '- obtainable=true 仅当确实找到公开可得的相关信息，并在 findings 中给出关键发现（每条带实际访问过的来源）；',
    '- obtainable=false 表示公开渠道不可得，在 reason 说明原因（如无公开数据/需付费/内部数据等），不得编造。',
    '搜索预算不超过 ' + agentBudget + ' 次 web_search/web_fetch。只列实际访问过的来源。',
    '硬性要求：obtainable=false 时 findings 必须为空，不得编造发现。',
    langLine(),
    '严格按 schema 返回 JSON。',
  ]
  return lines.join('\n')
}

// ---------- 结果记录与证据精简（A2） ----------
function emptyEvidence() { return { confirmed: [], uncertain: [], gaps: [] } }

let curRound = 0

// 三态证据归约的唯一实现：空 claim/point/aspect 丢弃，confidence/priority 白名单外落保守档。
// researcher 与 recon 共用（评审 F7 去重）。
function collectEvidence(ev, out) {
  for (const c of arr(out.confirmed)) {
    const claim = str(c && c.claim)
    if (claim.length === 0) continue
    ev.confirmed.push({ claim: claim, source: str(c && c.source), confidence: c && (c.confidence === 'high' || c.confidence === 'medium') ? c.confidence : 'low' })
  }
  for (const u of arr(out.uncertain)) {
    const point = str(u && u.point)
    if (point.length === 0) continue
    ev.uncertain.push({ point: point, reason: str(u && u.reason) })
  }
  for (const g of arr(out.gaps)) {
    const aspect = str(g && g.aspect)
    if (aspect.length === 0) continue
    ev.gaps.push({ aspect: aspect, priority: g && (g.priority === 'medium' || g.priority === 'low') ? g.priority : 'high' })
  }
  return ev
}

function normalizeResearcher(item, roundNo, out) {
  if (!out || typeof out !== 'object') {
    return { id: item.id, question: item.question, round: roundNo, blind: false, ok: false, error: 'researcher returned no structured evidence', evidence: emptyEvidence() }
  }
  const ev = collectEvidence(emptyEvidence(), out)
  const ok = ev.confirmed.length > 0 || ev.uncertain.length > 0
  return { id: item.id, question: item.question, round: roundNo, blind: false, ok: ok, error: ok ? '' : 'no usable evidence returned', evidence: ev }
}

function normalizeRecon(item, roundNo, out) {
  if (!out || typeof out !== 'object') {
    return { id: item.id, question: item.question, round: roundNo, blind: true, ok: false, error: 'recon agent failed', obtainable: null, reason: '', evidence: emptyEvidence() }
  }
  const obtainable = out.obtainable === true
  // findings 复用统一归约：补默认 confidence=medium 后走同一 confirmed 分支
  const ev = collectEvidence(emptyEvidence(), {
    confirmed: arr(out.findings).map(function (f) { return { claim: str(f && f.claim), source: str(f && f.source), confidence: 'medium' } }),
    uncertain: [],
    gaps: [],
  })
  if (!obtainable) ev.uncertain.push({ point: '已验证盲区：公开渠道不可得', reason: str(out.reason) })
  return { id: item.id, question: item.question, round: roundNo, blind: true, ok: true, error: '', obtainable: obtainable, reason: str(out.reason), evidence: ev }
}

async function researchOne(item) {
  // 注意：此处不 try/catch——fatal WorkflowError（CANCELLED/AGENT_CAP 等）必须穿透 parallel 直达引擎；
  // 子代理自身失败由 agent() 解析为 null，经 normalize 归档为 ok=false 的失败节（失败隔离）。
  if (item.blind) {
    const out = await agent(reconPrompt(item.question), Object.assign({ label: 'recon:' + item.id, schema: RECON_SCHEMA }, modelOpt('researcher')))
    return normalizeRecon(item, curRound, out)
  }
  const out = await agent(researcherPrompt(item), Object.assign({ label: 'research:' + item.id, schema: RESEARCHER_SCHEMA }, modelOpt('researcher')))
  return normalizeResearcher(item, curRound, out)
}

// ---------- [规划] ----------
log('deep-research 开始：' + topic)

let plan
if (Array.isArray(args.questions) && args.questions.length > 0) {
  phase('规划')
  log('使用调用方提供的问题清单，跳过规划代理')
  plan = {
    scope: purpose.length > 0 ? topic + '——' + purpose : topic,
    dimensions: ['通用'],
    questions: args.questions.map(function (q, i) {
      return { id: 'q' + (i + 1), question: str(q && q.question), dimension: '通用', keywords: [], acceptance: '' }
    }).filter(function (q) { return q.question.length > 0 }),
    coverage_gaps: [],
    source: 'provided',
  }
  if (plan.questions.length === 0) throw new Error('deep_research: provided questions parsed to zero entries')
} else {
  phase('规划')
  log('规划代理启动：定义答案空间/维度/子问题/覆盖盲区')
  const rawPlan = await agent(plannerPrompt(), Object.assign({ label: 'planner', schema: PLANNER_SCHEMA }, modelOpt('planner')))
  if (!rawPlan || typeof rawPlan !== 'object') throw new Error('planner agent failed: no structured plan (spec: planning failure is a hard tool error; adjust params and retry)')
  plan = {
    scope: str(rawPlan.scope),
    dimensions: arr(rawPlan.dimensions).map(str).filter(function (d) { return d.length > 0 }),
    questions: arr(rawPlan.questions).map(function (q, i) {
      return {
        id: 'q' + (i + 1),
        question: str(q && q.question),
        dimension: str(q && q.dimension),
        keywords: arr(q && q.keywords).map(str),
        acceptance: str(q && q.acceptance),
      }
    }).filter(function (q) { return q.question.length > 0 }),
    coverage_gaps: arr(rawPlan.coverage_gaps).map(str).filter(function (g) { return g.length > 0 }),
    source: 'planner',
  }
  if (plan.questions.length === 0) throw new Error('planner produced zero researchable questions (spec: planning failure is a hard tool error)')
}
if (plan.scope.length === 0) plan.scope = topic

// 盲区声明 → 定向侦察任务并入研究队列（blind:true）
let seq = plan.questions.length
const queue = []
for (const q of plan.questions) {
  queue.push({ id: q.id, question: q.question, dimension: q.dimension, keywords: q.keywords, acceptance: q.acceptance, blind: false })
}
for (const gap of plan.coverage_gaps) {
  seq += 1
  queue.push({ id: 'b' + seq, question: gap, dimension: '盲区侦察', keywords: [], acceptance: '判定该信息是否公开可得', blind: true })
}
const subquestionCount = plan.questions.length

// ---------- [研究 R1..Rn] 自适应闭环 ----------
const itemRecords = []
const blindspots = []
const droppedByCap = []
let completed = 0
let failed = 0
let rounds = 0

const seenQuestions = new Set(queue.map(function (i) { return normKey(i.question) }))
function followUpsFrom(records) {
  const out = []
  for (const rec of records) {
    if (!rec.ok) continue
    for (const g of rec.evidence.gaps) {
      if (g.priority !== 'high') continue
      const key = normKey(g.aspect)
      if (seenQuestions.has(key)) continue
      seenQuestions.add(key)
      out.push({
        id: rec.id + '-f' + (out.length + 1),
        question: g.aspect + '（跟进：来自「' + truncate(rec.question, 40) + '」的高优缺口）',
        dimension: rec.blind ? '盲区侦察' : '',
        keywords: [],
        acceptance: '',
        blind: false,
      })
    }
  }
  return out
}

let pending = queue.slice()
while (pending.length > 0 && rounds < maxRounds) {
  rounds += 1
  curRound = rounds
  phase('研究 R' + rounds)
  log('第 ' + rounds + '/' + maxRounds + ' 轮：' + pending.length + ' 个研究项，切片大小 ' + SLICE)
  let freshHighGaps = 0
  for (let i = 0; i < pending.length; i += SLICE) {
    const slice = pending.slice(i, i + SLICE)
    const results = await parallel(slice.map(function (item) { return function () { return researchOne(item) } }))
    for (let j = 0; j < slice.length; j++) {
      const rec = results[j]
      const record = rec && typeof rec === 'object'
        ? rec
        : { id: slice[j].id, question: slice[j].question, round: rounds, blind: !!slice[j].blind, ok: false, error: 'research thunk failed (script bug or fatal-adjacent)', obtainable: null, reason: '', evidence: emptyEvidence() }
      itemRecords.push(record)
      if (record.ok) { completed += 1 } else { failed += 1 }
      if (record.blind && record.ok) blindspots.push({ gap: record.question, obtainable: record.obtainable === true, reason: record.reason })
      if (record.ok) {
        for (const g of record.evidence.gaps) if (g.priority === 'high') freshHighGaps += 1
      }
    }
  }
  if (freshHighGaps === 0) {
    log('第 ' + rounds + ' 轮无新增高优先级缺口，边际增益归零，收敛')
    pending = []
  } else {
    const follow = followUpsFrom(itemRecords.filter(function (r) { return r.round === rounds }))
    if (follow.length === 0) {
      log('高优先级缺口均已研究过（去重后为空），收敛')
      pending = []
    } else {
      log('第 ' + rounds + ' 轮产生 ' + follow.length + ' 个新跟进项，排入下一轮')
      pending = follow
    }
  }
}
if (pending.length > 0) {
  log('达到轮次上限 ' + maxRounds + '，' + pending.length + ' 个跟进项不再派发（如实记入未完成清单）')
  for (const item of pending) droppedByCap.push({ id: item.id, question: item.question })
}

// ---------- 证据精简拼接（综合输入即此副本；落盘 evidence_state.md） ----------
function evidenceLines() {
  const lines = []
  for (const rec of itemRecords) {
    lines.push('[' + rec.id + '][R' + rec.round + ']' + (rec.blind ? '[盲区侦察]' : '') + ' ' + rec.question)
    if (!rec.ok) {
      lines.push('  （研究失败：' + str(rec.error) + '）')
      continue
    }
    for (const c of rec.evidence.confirmed) lines.push('  - [confirmed][' + c.confidence + '] ' + c.claim + ' —— 来源：' + c.source)
    for (const u of rec.evidence.uncertain) lines.push('  - [uncertain] ' + u.point + (u.reason.length > 0 ? '（原因：' + u.reason + '）' : ''))
    for (const g of rec.evidence.gaps) lines.push('  - [gap][' + g.priority + '] ' + g.aspect)
  }
  if (droppedByCap.length > 0) {
    lines.push('')
    lines.push('=== 因轮次上限未派发的跟进项（未完成，如实呈现）===')
    for (const d of droppedByCap) lines.push('- ' + d.question)
  }
  return lines.join('\n')
}
const evidenceState = evidenceLines()

// ---------- [综合]（R4：synthesize=false 时跳过，不产 report） ----------
let report = ''
let reportNote = ''
if (!doSynthesize) {
  phase('跳过综合')
  log('synthesize=false：跳过综合代理，仅保留证据中间态与轻量验证')
} else {
  phase('综合')
  log('综合代理启动：率失真压缩 ' + itemRecords.length + ' 条研究记录')
  const synthLines = [
    '你是深度研究的综合代理。基于下列结构化证据撰写最终调研报告。',
    '',
    '主题：' + topic,
    '研究范围：' + plan.scope,
    '规划维度：' + plan.dimensions.join('、'),
    '',
    '=== 结构化证据（已精简）===',
    evidenceState,
    '',
    '撰写要求（率失真压缩）：',
    '- 只保留承重结论与其直接支撑，舍弃冗余细节；不确定性显式保留，不得伪装成事实；',
    '- 报告中不得出现证据附录之外的具体事实、数字或日期；确需背景知识衔接时，显式标注『（背景知识，未经本轮检索验证）』；',
    '- 已验证盲区（obtainable=false 的侦察结论）单独成节，明确写"经侦察确认不可得"；',
    '- 每条承重声明后附 [来源]；',
    '- 报告结构（Markdown）：# 标题 / ## 摘要 / ## 背景 / ## 核心发现（分节）/ ## 不确定性与矛盾并列 / ## 已验证盲区 / ## 结论 / ## 参考资料（仅列证据中出现过的来源）。',
    '硬性要求：事实性内容必须能在证据附录中找到出处；找不到出处的一律删除或标注（背景知识）。',
    langLine(),
    '直接输出 Markdown 正文，不要额外解释。',
  ]
  const rawReport = await agent(synthLines.join('\n'), Object.assign({ label: 'synthesizer' }, modelOpt('synthesizer')))
  if (typeof rawReport === 'string' && rawReport.trim().length > 0) {
    report = rawReport
  } else {
    // 失败隔离：综合失败降级为脚本拼装的最小可用报告（诚实标注），run 不整体失败
    reportNote = 'synthesizer agent failed; degraded script-side assembly'
    log(reportNote)
    report = [
      '# ' + topic + '（降级报告）',
      '',
      '> 综合代理未能产出报告，以下为脚本侧拼装的证据附录。结论请自行审读。',
      '',
      '## 证据附录',
      '',
      evidenceState,
    ].join('\n')
  }
}

// ---------- [验证+修复环]（单一时序：合成后统一跑；有界 ≤ verifierMaxRounds） ----------
const verification = {
  status: 'skipped',
  claims: { verified: 0, unverified: 0, refuted: 0 },
  issues: [],
  uncovered_dimensions: [],
  overconfident: [],
  revision_rounds: 0,
}

function applyVerifier(v) {
  verification.claims = { verified: 0, unverified: 0, refuted: 0 }
  verification.issues = []
  verification.uncovered_dimensions = []
  verification.overconfident = []
  for (const c of arr(v.claims)) {
    const status = c && c.status
    if (status === 'verified') verification.claims.verified += 1
    else if (status === 'refuted') verification.claims.refuted += 1
    else verification.claims.unverified += 1
    if (status === 'refuted' || status === 'unverified') {
      verification.issues.push('[' + status + '] ' + str(c && c.claim) + (c && c.reason ? '（' + c.reason + '）' : ''))
    }
  }
  for (const b of arr(v.blocking_issues)) verification.issues.push('[blocking] ' + str(b))
  for (const u of arr(v.overconfident)) {
    verification.overconfident.push({ claim: str(u && u.claim), reason: str(u && u.reason) })
    verification.issues.push('[overconfident] ' + str(u && u.claim))
  }
  for (const d of arr(v.uncovered_dimensions)) {
    verification.uncovered_dimensions.push(str(d))
    verification.issues.push('[dimension-uncovered] ' + str(d))
  }
}

if (doVerify) {
  if (doSynthesize) {
    phase('验证')
    log('verifier 启动：对报告逐承重声明分类（修复环上限 ' + verifierMaxRounds + '）')
    while (true) {
      const v = await agent([
        '你是强制验证代理，对调研报告逐承重声明分类。',
        '',
        '规划维度清单：' + plan.dimensions.join('、'),
        '',
        '=== 待验证报告 ===',
        report,
        '=== 结束 ===',
        '',
        '分类标准：',
        '- verified：所引来源足以支撑该声明的具体表述（不只是主题相关——页面要真的说了这件事）；只有当你能通过 web_fetch 实际抽查来源可达性与支撑性时才可给出；无法抽查时不得声称做了实证核查；',
        '- unverified：无法独立核实（包括没有 web_fetch 工具时的全部引用）——这不是失败，如实标注即可；若你带 web_fetch：至少抽取报告中最承重的 2-3 条引用做可达性核查，不可达（404/超时）的声明降为 unverified 并在 reason 注明「链接失效」；承重来源全部失效 → needs_revision=true；',
        '- refuted：两种情形均算——①所引内容与其他已确认来源或公认事实矛盾（不依赖联网即可判定）；②引用失真：抽查发现来源实际内容并不支撑该声明的具体表述（reason 注明「来源不支持」）。',
        '',
        '同时完成：',
        '- uncovered_dimensions：对照维度清单，列出报告中缺乏证据支撑的维度；',
        '- overconfident：表述强于证据的声明；',
        '- 出现任何 refuted 或高危 unverified/过度自信 → needs_revision=true 并在 blocking_issues 列出必须修订的具体点；否则 needs_revision=false。',
        '硬性要求：未经抽查的声明一律不得标 verified；reason 必须落到页面内容层面，不得空泛。',
        langLine(),
        '严格按 schema 返回 JSON。',
      ].join('\n'), Object.assign({ label: 'verifier' + (verification.revision_rounds > 0 ? '-r' + (verification.revision_rounds + 1) : ''), schema: VERIFIER_SCHEMA }, modelOpt('verifier')))
      if (!v || typeof v !== 'object') {
        // 失败隔离：verifier 失败 → 降级交付而非整体失败
        verification.status = 'unavailable'
        verification.issues.push('verifier agent failed; claims not independently checked')
        log('verifier 失败，verification.status=unavailable（降级交付）')
        break
      }
      applyVerifier(v)
      if (v.needs_revision !== true) {
        verification.status = 'passed'
        log('验证通过：verified=' + verification.claims.verified + ' unverified=' + verification.claims.unverified + ' refuted=' + verification.claims.refuted)
        break
      }
      if (verification.revision_rounds >= verifierMaxRounds) {
        // 有界修复环耗尽：诚实降级，report 保留并显式标注未验证项
        verification.status = 'failed'
        log('修复环达上限 ' + verifierMaxRounds + ' 仍未收敛，verification.status=failed（降级交付）')
        break
      }
      verification.revision_rounds += 1
      log('验证未通过，进入第 ' + verification.revision_rounds + '/' + verifierMaxRounds + ' 次修订式重综合（仅改被点名节）')
      const revised = await agent([
        '你是综合代理。上一版调研报告未通过强制验证，需要修订式重跑。',
        '',
        '主题：' + topic,
        '',
        '=== verifier 意见（仅修订这些被点名的点）===',
        verification.issues.map(function (i) { return '- ' + i }).join('\n'),
        '',
        '=== 上版报告 ===',
        report,
        '=== 结束 ===',
        '',
        '修订纪律：仅修改被点名的节与声明，保留已验证部分原样，不重写全文；无法核实的表述改为显式不确定性陈述；refuted 声明要么删除要么改写为与证据相符。输出完整修订版 Markdown 正文。',
        langLine(),
      ].join('\n'), Object.assign({ label: 'synthesizer-rev' + verification.revision_rounds }, modelOpt('synthesizer')))
      if (typeof revised === 'string' && revised.trim().length > 0) {
        report = revised
      } else {
        verification.status = 'failed'
        verification.issues.push('revision synthesis failed after verifier findings')
        log('修订式综合失败，verification.status=failed（降级交付）')
        break
      }
    }
  } else {
    // R4：synthesize=false → 对中间证据做轻量验证，不产 report
    phase('验证（证据轻量）')
    const v = await agent([
      '你是验证代理。本轮未生成综合报告（synthesize=false），改为对中间结构化证据做轻量验证。',
      '',
      '=== 结构化证据 ===',
      evidenceState,
      '=== 结束 ===',
      '',
      '对其中每条 confirmed 声明分类：verified（能抽查来源支撑）/ unverified（无法独立核实）/ refuted（与其他确认来源或公认事实矛盾）。needs_revision 在出现 refuted 或高危 unverified 时为 true。',
      langLine(),
      '严格按 schema 返回 JSON。',
    ].join('\n'), Object.assign({ label: 'verifier-evidence', schema: VERIFIER_SCHEMA }, modelOpt('verifier')))
    if (!v || typeof v !== 'object') {
      verification.status = 'unavailable'
      verification.issues.push('evidence verifier failed')
    } else {
      applyVerifier(v)
      verification.status = v.needs_revision === true ? 'failed' : 'passed'
    }
  }
}

// ---------- [审查]（可选，验证后） ----------
let review = ''
if (doReview) {
  phase('审查')
  log('对抗性审查者启动：覆盖度审计 + 矛盾并列 + 过度自信标注')
  const r = await agent([
    '你是对抗性审查者，只提意见、不改稿。',
    '',
    '规划维度：' + plan.dimensions.join('、'),
    '',
    '=== 待审查材料 ===',
    doSynthesize ? report : evidenceState,
    '=== 结束 ===',
    '',
    '三类审查，分条列出并按严重度排序：',
    '1. 覆盖度审计：对照维度清单找出缺失或浅尝辄止的维度；',
    '2. 矛盾并列：证据相互冲突但材料未并列呈现之处；',
    '3. 过度自信标注：结论强于证据之处（含低质量来源却写得笃定的地方）。',
    langLine(),
    '直接输出审查意见 Markdown。',
  ].join('\n'), Object.assign({ label: 'reviewer' }, modelOpt('reviewer')))
  review = typeof r === 'string' ? r : ''
  if (review.length === 0) log('reviewer 未产出意见（失败或空输出），review 记为空')
}

phase('收尾')
log('完成：rounds=' + rounds + ' items=' + itemRecords.length + ' completed=' + completed + ' failed=' + failed + ' verification=' + verification.status)

return {
  report: report,
  report_note: reportNote,
  review: review,
  rounds: rounds,
  subquestions: subquestionCount,
  completed: completed,
  failed: failed,
  plan: plan,
  items: itemRecords,
  dropped_by_cap: droppedByCap,
  blindspots: blindspots,
  evidence_state: evidenceState,
  verification: verification,
}
`
