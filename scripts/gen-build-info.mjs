// 生成 server/build-info.js:把当前 git 提交与构建时间注入部署产物,
// 供 /api/health 与前端调试信息使用。不注入任何环境变量或密钥。
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const output = fileURLToPath(new URL('../server/build-info.js', import.meta.url))

function git(args) {
    try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return ''
    }
}

const version = git(['rev-parse', '--short', 'HEAD']) || 'dev'
const commitTime = git(['show', '-s', '--format=%cI', 'HEAD'])
const buildTime = commitTime || new Date().toISOString()

const content = `// 由 scripts/gen-build-info.mjs 在构建时自动覆盖,请勿手工编辑。
export const BUILD_VERSION = ${JSON.stringify(version)}
export const BUILD_TIME = ${JSON.stringify(buildTime)}
`

await writeFile(output, content)
console.log(`build-info: version=${version} buildTime=${buildTime}`)
