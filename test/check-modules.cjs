/**
 * 模块自检：把仓库里每个 ESM 模块都 import 一遍，`.cjs` 用 new Function 过一遍。
 * 用法：node test/check-modules.cjs <插件根目录> <输出文件>
 * 输出每行一个 OK / FAIL，便于在 CI 或本地 grep。
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const root = path.resolve(process.argv[2] ?? '.')
const out = process.argv[3] ? path.resolve(process.argv[3]) : ''

const files = []
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue
      walk(full)
      continue
    }
    if (!/\.(js|cjs|mjs)$/u.test(name)) continue
    if (out && full === out) continue
    files.push(full)
  }
}
walk(root)

;(async () => {
  const lines = []
  let failed = 0
  for (const file of files) {
    const relative = path.relative(root, file)
    try {
      if (file.endsWith('.cjs')) {
        // eslint-disable-next-line no-new-func
        new Function(fs.readFileSync(file, 'utf8'))
        lines.push(`OK   ${relative}`)
        continue
      }
      const module = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
      const names = Object.keys(module)
      lines.push(`OK   ${relative}${names.length > 0 ? `  exports=${names.join(',')}` : '  (no exports)'}`)
    } catch (error) {
      const message = String(error?.message ?? error)
      // 浏览器半边（client.js）在 Node 里跑不起来是正常的：退回语法检查
      if (/window is not defined|document is not defined/u.test(message)) {
        try {
          execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
          lines.push(`OK   ${relative}  (浏览器模块，仅语法检查)`)
          continue
        } catch (syntaxError) {
          failed += 1
          lines.push(`FAIL ${relative}  ${syntaxError?.message ?? syntaxError}`)
          continue
        }
      }
      failed += 1
      lines.push(`FAIL ${relative}  ${message}`)
    }
  }
  const summary = `${lines.length - failed}/${lines.length} 通过`
  lines.push(summary)
  if (out) fs.writeFileSync(out, lines.join('\n'))
  console.log(lines.join('\n'))
  if (failed > 0) process.exitCode = 1
})().catch((error) => {
  if (out) fs.writeFileSync(out, `ERR ${error.stack}`)
  console.error(error)
  process.exitCode = 1
})
