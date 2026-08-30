import test from 'node:test'
import assert from 'node:assert/strict'
import { parseResearchCommand } from '../lib/types/command.js'

test('plain topic: defaults mirror the tool face', () => {
  const r = parseResearchCommand('MCP 安全现状')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.topic, 'MCP 安全现状')
  assert.equal(r.request.depth, 2)
  assert.equal(r.request.synthesize, true)
  assert.equal(r.request.verify, true)
  assert.equal(r.request.review, false)
  assert.equal(r.request.foreground, false)
  assert.equal('purpose' in r.request, false)
})

test('full flag set, order independent', () => {
  const r = parseResearchCommand('--depth 3 --no-verify --review --foreground RAG 评测 --purpose "支撑选型"')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.request.topic, 'RAG 评测')
  assert.equal(r.request.depth, 3)
  assert.equal(r.request.verify, false)
  assert.equal(r.request.synthesize, true)
  assert.equal(r.request.review, true)
  assert.equal(r.request.foreground, true)
  assert.equal(r.request.purpose, '支撑选型')
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
