import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignoredDirectories = new Set([
  '.git',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])

async function findMarkdown(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await findMarkdown(path)))
    else if (/\.md$/iu.test(entry.name)) {
      files.push(relative(root, path).split(sep).join('/'))
    }
  }
  return files
}

const markdown = (await findMarkdown(root)).sort()
const unexpected = markdown.filter((path) => path !== 'README.md')
if (unexpected.length > 0 || !markdown.includes('README.md')) {
  console.error(
    'Markdown policy failed. The repository may only contain README.md.',
  )
  for (const path of unexpected) console.error(`- ${path}`)
  process.exitCode = 1
} else {
  console.log('Markdown policy passed: README.md is the only Markdown file.')
}
