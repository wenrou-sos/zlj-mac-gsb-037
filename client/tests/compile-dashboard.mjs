import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { parse, compileTemplate, compileScript } from '@vue/compiler-sfc'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../src')

function collectVueFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectVueFiles(full))
    else if (entry.name.endsWith('.vue')) out.push(full)
  }
  return out
}

function formatErrors(title, errors) {
  return [
    title,
    ...errors.map(error => {
      if (typeof error === 'string') return error
      const location = error.loc?.start
      const suffix = location ? ` at ${location.line}:${location.column}` : ''
      return `${error.message}${suffix}`
    })
  ].join('\n')
}

// 编译所有视图 + 公共组件（历史上只校验 Dashboard，现扩展到全部 SFC）
const targets = [
  ...collectVueFiles(resolve(root, 'views')),
  ...(existsSync(resolve(root, 'components')) ? collectVueFiles(resolve(root, 'components')) : [])
]

let failed = 0
for (const file of targets) {
  const source = readFileSync(file, 'utf8')
  const parsed = parse(source, { filename: file })
  if (parsed.errors.length > 0) {
    console.error('❌', file)
    console.error(formatErrors('SFC parse failed', parsed.errors))
    failed++
    continue
  }
  const { descriptor } = parsed
  if (descriptor.scriptSetup || descriptor.script) {
    try {
      compileScript(descriptor, { id: 'sfc-compile-test' })
    } catch (e) {
      console.error('❌', file, '\n  ', e.message)
      failed++
      continue
    }
  }
  if (descriptor.template) {
    const compiled = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id: 'sfc-compile-test'
    })
    if (compiled.errors.length > 0) {
      console.error('❌', file)
      console.error(formatErrors('Template compile failed', compiled.errors))
      failed++
      continue
    }
  }
  console.log('  ✅', file.replace(root + '/', ''))
}

if (failed > 0) {
  console.error(`\n${failed} 个 SFC 编译失败`)
  process.exit(1)
}
console.log(`\n全部 ${targets.length} 个 Vue SFC 编译通过`)
