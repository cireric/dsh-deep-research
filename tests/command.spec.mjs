import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResearchIntentMessage, parseResearchCommand } from '../lib/types/command.js'

test('plain topic: request carries only the topic', () => {
  const r = parseResearchCommand('MCP 安全现状')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.topic, 'MCP 安全现状')
  assert.equal('depth' in r.request, false)
  assert.equal('purpose' in r.request, false)
  assert.equal('clarify' in r.request, false)
})

test('advisory hints, order independent', () => {
  const r = parseResearchCommand('--depth 3 --purpose "支撑选型" RAG 评测')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.topic, 'RAG 评测')
  assert.equal(r.request.depth, 3)
  assert.equal(r.request.purpose, '支撑选型')
})

test('removed flags are rejected as unknown', () => {
  for (const token of ['--foreground', '--no-verify', '--no-synthesize', '--review']) {
    const r = parseResearchCommand(`主题 ${token}`)
    assert.equal(r.ok, false, token)
    if (r.ok) continue
    assert.ok(r.error.includes(token), token)
  }
})

test('empty input is rejected with usage', () => {
  const r = parseResearchCommand('   ')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /缺少主题/)
  assert.match(r.error, /用法/)
})

test('depth outside 1-3 is rejected', () => {
  for (const bad of ['--depth 4', '--depth 0']) {
    const r = parseResearchCommand(`主题 ${bad}`)
    assert.equal(r.ok, false, bad)
    if (r.ok) continue
    assert.match(r.error, /--depth/)
  }
})

test('unknown token-like flag is rejected', () => {
  const r = parseResearchCommand('主题 --bogus')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /--bogus/)
})

test('topic whitespace is collapsed', () => {
  const r = parseResearchCommand('  MCP   安全\n现状  ')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.topic, 'MCP 安全 现状')
})

test('empty --purpose string is treated as absent', () => {
  const r = parseResearchCommand('主题 --purpose ""')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal('purpose' in r.request, false)
})

test('double dash inside a word is not a flag', () => {
  const r = parseResearchCommand('C++--template 专题')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.topic, 'C++--template 专题')
})

test('escaped quote in --purpose is a documented limitation (grammar has no escaping)', () => {
  // 语法不支持转义引号：--purpose "a\"b" 在第一个内嵌引号处截断，反斜杠随捕获
  // 进入 purpose、引号后残片并入主题。本测试钉住现状；改进需引入真引号语法。
  const r = parseResearchCommand('主题 --purpose "a\\"b"')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.purpose, 'a\\')
  assert.equal(r.request.topic, '主题 b"')
})

test('--clarify parses all strategies, order independent', () => {
  for (const strategy of ['auto', 'minimal', 'never']) {
    const r = parseResearchCommand(`--clarify ${strategy} 主题`)
    assert.equal(r.ok, true, `parse failed for ${strategy}: ${r.ok ? '' : r.error}`)
    if (r.ok) assert.equal(r.request.clarify, strategy)
  }
})

test('--clarify with unknown value is rejected with usage', () => {
  const r = parseResearchCommand('主题 --clarify aggressive')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /--clarify/)
  assert.match(r.error, /用法/)
})

test('buildResearchIntentMessage: minimal is the default and carries the cost-function rule', () => {
  const msg = buildResearchIntentMessage({ topic: '对比基线研究' })
  assert.match(msg, /澄清规则（minimal）/)
  assert.match(msg, /分叉/)
  assert.match(msg, /跳过，用默认/)
  assert.match(msg, /questions/)
  assert.match(msg, /直接调用 deep_research 工具开始研究/)
})

test('buildResearchIntentMessage: never forbids clarification and routes to purpose', () => {
  const msg = buildResearchIntentMessage({ topic: '对比基线研究' }, 'never')
  assert.match(msg, /禁止向用户提出任何澄清问题/)
  assert.match(msg, /purpose/)
  assert.doesNotMatch(msg, /澄清 1–2 个关键问题/)
})

test('buildResearchIntentMessage: auto keeps the legacy wording', () => {
  const msg = buildResearchIntentMessage({ topic: '对比基线研究' }, 'auto')
  assert.match(msg, /向用户澄清 1–2 个关键问题/)
})

test('--clarify quoted value is rejected, never silently parsed', () => {
  // 语法不支持引号值：--clarify "minimal" 整体落入残留 token 检查，报未知参数
  // （而非把引号吞进策略再静默解析）。钉住现状；需要引号值时先扩展语法。
  const r = parseResearchCommand('主题 --clarify "minimal"')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /--clarify/)
  assert.match(r.error, /用法/)
})

test('buildResearchIntentMessage: never splits assumptions from an existing purpose', () => {
  const msg = buildResearchIntentMessage({ topic: '对比基线研究' }, 'never')
  assert.match(msg, /"假设："/)
  assert.match(msg, /不得覆盖用户已提供的用途/)
  assert.match(msg, /随后直接调用 deep_research 工具开始研究/)
})
