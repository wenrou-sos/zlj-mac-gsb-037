import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { parse, compileTemplate, compileScript } from '@vue/compiler-sfc'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(__dirname, '../src')

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...walk(p))
    else if (name.endsWith('.vue')) files.push(p)
  }
  return files
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

const files = walk(srcDir)
let failed = 0

for (const filePath of files) {
  const source = readFileSync(filePath, 'utf8')
  const id = `compile-test-${files.indexOf(filePath)}`
  try {
    const parsed = parse(source, { filename: filePath })
    if (parsed.errors.length > 0) {
      throw new Error(formatErrors(`${filePath} SFC parse failed`, parsed.errors))
    }
    const { descriptor } = parsed
    if (!descriptor.template) {
      throw new Error(`${filePath} must include a template`)
    }
    if (descriptor.scriptSetup || descriptor.script) {
      compileScript(descriptor, { id })
    }
    const compiled = compileTemplate({
      source: descriptor.template.content,
      filename: filePath,
      id
    })
    if (compiled.errors.length > 0) {
      throw new Error(formatErrors(`${filePath} template compile failed`, compiled.errors))
    }
    console.log('  ✅', filePath.split('/src/')[1])
  } catch (e) {
    failed++
    console.error('  ❌', e.message)
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个组件编译失败`)
  process.exit(1)
}
console.log(`\n全部 ${files.length} 个 Vue 组件编译通过`)
