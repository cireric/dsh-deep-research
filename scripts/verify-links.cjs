// 文档引用路径有效性校验：扫描所有 md 中反引号包裹的 docs/ src/ tests/ scripts/ 路径并验证存在性。
// 用法：node scripts/verify-links.cjs   （在包根目录运行）
const fs = require('fs')
const path = require('path')

const pkg = process.cwd()
function walk(d, o) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'lib'].includes(e.name)) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, o)
    else if (p.endsWith('.md')) o.push(p)
  }
}
const mds = []
walk(pkg, mds)

const tick = String.fromCharCode(96)
const re = new RegExp(tick + '((?:docs|src|tests|scripts)/[^' + tick + '\\s]+)' + tick, 'g')
const refs = new Map()
for (const f of mds) {
  const t = fs.readFileSync(f, 'utf8')
  let m
  while ((m = re.exec(t))) {
    const p = m[1].replace(/\.\.\//g, '')
    if (!refs.has(p)) refs.set(p, new Set())
    refs.get(p).add(path.relative(pkg, f).split(path.sep).join('/'))
  }
}

let missing = 0
for (const [p, where] of [...refs].sort()) {
  const ok = fs.existsSync(path.join(pkg, p))
  if (!ok) missing++
  console.log((ok ? 'OK  ' : 'MISS') + ' ' + p.padEnd(54) + ' ← ' + [...where].slice(0, 3).join(', ') + (where.size > 3 ? ` 等${where.size}处` : ''))
}
console.log(missing === 0 ? `\n全部 ${refs.size} 个被引路径有效` : `\n缺失 ${missing}/${refs.size} 个路径`)
process.exitCode = missing === 0 ? 0 : 1
