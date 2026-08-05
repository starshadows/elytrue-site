import { apiResponse } from '../../http.js'

// server/build-info.js 由 scripts/gen-build-info.mjs 在构建时生成(被 gitignore),
// 本地测试/开发时不存在,回退为 dev 默认值。
let buildInfoPromise = null

async function loadBuildInfo() {
    if (!buildInfoPromise) {
        buildInfoPromise = import('../../build-info.js')
            .then(module => ({
                version: module.BUILD_VERSION,
                buildTime: module.BUILD_TIME,
                commitTime: module.COMMIT_TIME,
            }))
            .catch(() => ({ version: 'dev', buildTime: null, commitTime: null }))
    }
    return buildInfoPromise
}

export async function health() {
    const build = await loadBuildInfo()
    return apiResponse({
        service: 'elytrue-edgeone',
        status: 'ok',
        version: build.version,
        buildTime: build.buildTime,
        commitTime: build.commitTime,
    })
}
