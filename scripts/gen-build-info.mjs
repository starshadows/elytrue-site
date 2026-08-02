// 生成 server/build-info.js(被 gitignore,由构建流程在部署前生成):
//   BUILD_VERSION = 当前 git 短提交(必须与实际部署提交一致)
//   BUILD_TIME    = 实际构建时间(非提交时间)
//   COMMIT_TIME   = 提交时间(额外信息)
// 无法解析 git 提交时直接失败,避免把 dev 版本带进正式构建。
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

const version = git(['rev-parse', '--short', 'HEAD'])
const commitTime = git(['show', '-s', '--format=%cI', 'HEAD'])
if (!version || version === 'dev') {
    throw new Error('gen:build-info 无法解析 git 提交(当前目录不是 git 仓库或 HEAD 不可用),构建已中止')
}

const buildTime = new Date().toISOString()
const content = `// 由 scripts/gen-build-info.mjs 在构建时自动生成(被 gitignore),请勿手工编辑。
export const BUILD_VERSION = ${JSON.stringify(version)}
export const BUILD_TIME = ${JSON.stringify(buildTime)}
export const COMMIT_TIME = ${JSON.stringify(commitTime)}
`

await writeFile(output, content)
console.log(`build-info: version=${version} buildTime=${buildTime} commitTime=${commitTime || '(未知)'}`)
