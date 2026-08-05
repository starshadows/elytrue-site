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

function hasRateLimitBinding(environment) {
    const binding = environment?.ELYTRUE_RATE_LIMIT_KV
    return Boolean(binding?.get && binding?.put)
}

export async function health(context = {}) {
    const build = await loadBuildInfo()
    const rateLimit = hasRateLimitBinding(context.env || process.env) ? 'ok' : 'degraded'
    return apiResponse({
        service: 'elytrue-edgeone',
        status: rateLimit === 'ok' ? 'ok' : 'degraded',
        checks: { rateLimitKv: rateLimit },
        version: build.version,
        buildTime: build.buildTime,
        commitTime: build.commitTime,
    })
}
