import { spawnSync } from 'node:child_process'

// These are transitive findings in the EdgeOne CLI toolchain. The CLI is used
// during development/CI only and is not bundled into dist or Cloud Functions.
const DEV_ONLY_CRITICAL_ALLOWLIST = new Map([
  ['fast-xml-parser', 'EdgeOne CLI XML helper'],
  ['form-data', 'EdgeOne CLI HTTP helper'],
  ['request', 'EdgeOne CLI legacy SDK helper'],
])

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmArgs = ['audit', '--include=dev', '--audit-level=critical', '--json']
const command = process.env.npm_execpath ? process.execPath : npm
const result = spawnSync(
  command,
  process.env.npm_execpath ? [process.env.npm_execpath, ...npmArgs] : npmArgs,
  {
    encoding: 'utf8',
    shell: process.platform === 'win32' && !process.env.npm_execpath,
  },
)

let report
try {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  report = JSON.parse(output.slice(start, end + 1))
} catch {
  console.error('开发依赖审计未返回可解析的 JSON')
  if (result.stderr) console.error(result.stderr.trim())
  process.exit(1)
}

const critical = Object.entries(report.vulnerabilities || {})
  .filter(([, vulnerability]) => vulnerability.severity === 'critical')
  .map(([name, vulnerability]) => ({ name, vulnerability }))
const blocked = critical.filter(
  ({ name }) => !DEV_ONLY_CRITICAL_ALLOWLIST.has(name),
)

for (const { name, vulnerability } of critical) {
  const status = DEV_ONLY_CRITICAL_ALLOWLIST.has(name)
    ? 'allowlisted'
    : 'blocking'
  console.log(`dev audit ${status}: ${name} (${vulnerability.severity})`)
}

if (blocked.length) {
  console.error('发现未列入 allowlist 的开发依赖 critical 漏洞')
  for (const { name } of blocked) console.error(`- ${name}`)
  process.exit(1)
}

console.log('开发依赖 critical 审计通过；仅允许明确列出的 EdgeOne CLI 传递依赖')
