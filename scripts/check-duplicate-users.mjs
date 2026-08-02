#!/usr/bin/env node
/**
 * check-duplicate-users.mjs —— 扫描并修复重复用户名账号
 *
 * 用法:
 *   EDGEONE_PROJECT_ID=<项目ID> EDGEONE_API_TOKEN=<API Token> \
 *     [ELYTRUE_APP_SECRET=<应用密钥>] \
 *     node scripts/check-duplicate-users.mjs [--fix]
 *
 * 行为:
 *   默认报告模式:listAll 读取全部 users/ 账号,按 shared/validation.js 的
 *     normalizeUsername 分组,输出所有重复组明细(用户名、邮箱、createdAt、
 *     当前 indexes/users/name/ 索引指向),并把 JSON 报告写入 exports/。
 *   --fix 修复模式:先打印完整修复计划(dry-run),再执行:
 *     每个重复组保留 createdAt 最早的账号原用户名,其余账号改名 原名_2、原名_3 ...
 *     (新名被占用则继续递增后缀);每条改名按
 *     「改 users/{id}.json 的 name → 删除旧用户名索引(仅当索引指向本账号)→
 *     onlyIfNew 写新索引,失败回滚用户 name」执行;随后校正保留账号的索引;
 *     最后重新校验(无重复、每个用户有且仅有一个正确指向自己的用户名索引)。
 *
 * 危险操作:
 *   --fix 会改写 users/{id}.json 的 name 字段并重建 indexes/users/name/ 索引,
 *     不可逆。强烈建议先执行 `npm run export:data` 备份全部 Blob 再运行 --fix。
 *   脚本不会修改 emailHash / emailCipher / avatarKey / 留言 / 会话等任何其他字段,
 *     也不会更新留言记录里的 sender 快照。
 *
 * 退出码:
 *   0 = 未发现重复(报告模式),或修复后校验通过
 *   1 = 发现重复但未修复,或修复后仍有问题;环境变量缺失 / 其他错误也非 0 退出
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getStore } from '@edgeone/pages-blob'
import { getJSON, isPreconditionFailure, listAll } from '../server/storage.js'
import { normalizeUsername } from '../shared/validation.js'
import { decryptEmail, sha256 } from '../server/crypto.js'

const FIX = process.argv.includes('--fix')
const DATA_STORE = 'elytrue-data'

function usernameIndexKey(name) {
    return `indexes/users/name/${sha256(normalizeUsername(name))}.json`
}

function userKey(userId) {
    return `users/${userId}.json`
}

function maskEmail(email) {
    const value = String(email)
    const at = value.indexOf('@')
    if (at <= 0) return '***'
    return `${value.slice(0, 1)}***${value.slice(at)}`
}

function displayEmail(user, secret) {
    if (secret && user.emailCipher) {
        try {
            return maskEmail(decryptEmail(secret, user.emailCipher))
        } catch {
            return `${String(user.emailHash || '').slice(0, 12)}*`
        }
    }
    const hash = String(user.emailHash || '')
    return hash ? hash.slice(0, 12) : '—'
}

function displayTime(ms) {
    return Number(ms) ? new Date(Number(ms)).toISOString() : '—'
}

function textWidth(text) {
    let width = 0
    for (const ch of Array.from(String(text))) {
        width += /[\u0000-\u00ff]/u.test(ch) ? 1 : 2
    }
    return width
}

function padCell(text, width) {
    const value = String(text ?? '')
    return value + ' '.repeat(Math.max(0, width - textWidth(value)))
}

function printTable(headers, rows) {
    const widths = headers.map((header, i) => Math.max(
        textWidth(header),
        ...rows.map(row => textWidth(row[i] ?? '')),
    ))
    const render = cells => `  ${cells.map((cell, i) => padCell(cell, widths[i])).join('  |  ')}`
    console.log(render(headers))
    console.log(`  ${widths.map(width => '-'.repeat(width)).join('  +  ')}`)
    for (const row of rows) console.log(render(row))
}

function byCreatedAt(a, b) {
    return (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id))
}

async function scanUsers(data) {
    const blobs = await listAll(data, 'users/', Infinity)
    const users = []
    for (const blob of blobs) {
        const user = await getJSON(data, blob.key)
        if (user) users.push(user)
    }
    users.sort(byCreatedAt)

    const groups = new Map()
    for (const user of users) {
        const norm = normalizeUsername(user.name)
        if (!groups.has(norm)) groups.set(norm, [])
        groups.get(norm).push(user)
    }
    const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1)

    for (const user of users) {
        const index = await getJSON(data, usernameIndexKey(user.name))
        user.indexUserId = index?.userId || null
    }

    const indexAnomalies = users
        .filter(user => user.indexUserId !== user.id)
        .map(user => ({ userId: user.id, name: user.name, indexUserId: user.indexUserId }))
    return { users, dupGroups, indexAnomalies }
}

async function buildPlan(data, dupGroups, allUsers) {
    const plan = { renames: [], indexFixups: [], issues: [] }
    const normalizedTaken = new Set(allUsers.map(user => normalizeUsername(user.name)))
    for (const [norm, list] of dupGroups) {
        const sorted = [...list].sort(byCreatedAt)
        const kept = sorted[0]
        for (const user of sorted.slice(1)) {
            if (!user.name) {
                plan.issues.push(`账号 ${user.id} 缺少 name 字段,无法自动改名`)
                continue
            }
            const base = user.name
            let suffix = 2
            let found = null
            while (!found && suffix < 10000) {
                const candidate = `${base}_${suffix}`
                const candidateNorm = normalizeUsername(candidate)
                suffix += 1
                if (normalizedTaken.has(candidateNorm)) continue
                const occupied = await getJSON(data, usernameIndexKey(candidate))
                if (occupied) continue
                found = candidate
            }
            if (!found) {
                plan.issues.push(`账号 ${user.id} 尝试 10000 个候选名仍被占用,放弃`)
                continue
            }
            normalizedTaken.add(normalizeUsername(found))
            plan.renames.push({ userId: user.id, from: user.name, to: found, suffix: suffix - 1 })
        }
        plan.indexFixups.push({ userId: kept.id, name: kept.name, group: norm, kept: true })
    }
    return plan
}

async function renameUser(data, user, candidate) {
    const key = userKey(user.id)
    const oldKey = usernameIndexKey(user.name)
    const oldIndex = await getJSON(data, oldKey)
    const ownsOld = oldIndex?.userId === user.id
    const previous = user

    await data.setJSON(key, { ...user, name: candidate, updatedAt: Date.now() })
    if (ownsOld) await data.delete(oldKey)
    try {
        await data.setJSON(usernameIndexKey(candidate), { userId: user.id }, { onlyIfNew: true })
        return { taken: false }
    } catch (error) {
        await data.setJSON(key, { ...previous, updatedAt: Date.now() })
        if (ownsOld) {
            await data.setJSON(oldKey, { userId: user.id }, { onlyIfNew: true }).catch(() => {})
        }
        if (isPreconditionFailure(error)) return { taken: true }
        throw error
    }
}

async function ensureKeptIndex(data, keptId, groupIds) {
    const user = await getJSON(data, userKey(keptId))
    if (!user) return { ok: false, message: `账号 ${keptId} 不存在` }
    const baseKey = usernameIndexKey(user.name)
    const current = await getJSON(data, baseKey)
    if (current?.userId === user.id) {
        return { ok: true, message: `账号 ${user.id}(${user.name}) 的用户名索引已正确指向自己` }
    }
    if (current && !groupIds.has(current.userId)) {
        return { ok: false, message: `${baseKey} 指向组外账号 ${current.userId},跳过校正` }
    }
    await data.delete(baseKey)
    try {
        await data.setJSON(baseKey, { userId: user.id }, { onlyIfNew: true })
        return { ok: true, message: `已重建账号 ${user.id}(${user.name}) 的用户名索引 ${baseKey}` }
    } catch (error) {
        if (isPreconditionFailure(error)) {
            return { ok: false, message: `${baseKey} 被占用,未能为账号 ${user.id} 重建索引` }
        }
        throw error
    }
}

async function validateUsers(data, users) {
    const issues = []
    const byId = new Map(users.map(user => [user.id, user]))

    const indexBlobs = await listAll(data, 'indexes/users/name/', Infinity)
    const countByUser = new Map()
    for (const blob of indexBlobs) {
        const index = await getJSON(data, blob.key)
        if (!index?.userId) {
            issues.push(`索引 ${blob.key} 内容无效`)
            continue
        }
        const target = byId.get(index.userId)
        if (!target) {
            issues.push(`索引 ${blob.key} 指向不存在的用户 ${index.userId}`)
            continue
        }
        if (blob.key !== usernameIndexKey(target.name)) {
            issues.push(`索引 ${blob.key} 与用户 ${target.id}(${target.name}) 的用户名不匹配(应为 ${usernameIndexKey(target.name)})`)
        }
        countByUser.set(index.userId, (countByUser.get(index.userId) ?? 0) + 1)
    }

    const groups = new Map()
    for (const user of users) {
        const norm = normalizeUsername(user.name)
        if (!groups.has(norm)) groups.set(norm, [])
        groups.get(norm).push(user)
    }
    for (const [norm, list] of groups) {
        if (list.length > 1) issues.push(`用户名仍重复:"${norm}" 有 ${list.length} 个账号`)
    }

    for (const user of users) {
        const count = countByUser.get(user.id) ?? 0
        if (count === 0) issues.push(`用户 ${user.id}(${user.name}) 没有任何用户名索引`)
        else if (count > 1) issues.push(`用户 ${user.id}(${user.name}) 有 ${count} 个用户名索引`)
    }
    return issues
}

async function writeReport(report) {
    const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
    const path = resolve('exports', `check-duplicate-users-${timestamp}.json`)
    await mkdir(resolve('exports'), { recursive: true })
    await writeFile(path, JSON.stringify(report, null, 2))
    console.log(`JSON 报告已写入:${path}`)
}

async function main() {
    const projectId = process.env.EDGEONE_PROJECT_ID
    const token = process.env.EDGEONE_API_TOKEN
    const secret = process.env.ELYTRUE_APP_SECRET
    if (!projectId || !token) {
        throw new Error('缺少环境变量:必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN 后才能运行(可先执行 npm run export:data 备份)')
    }

    console.error(`连接 Blob 存储 ${DATA_STORE} ...`)
    const data = getStore({ name: DATA_STORE, projectId, token, consistency: 'strong' })

    console.error('读取全部用户与用户名索引 ...')
    const { users, dupGroups, indexAnomalies } = await scanUsers(data)
    console.error(`共读取 ${users.length} 个账号`)

    const duplicateCount = dupGroups.reduce((sum, [, list]) => sum + list.length, 0)
    console.log('==== 重复用户名报告 ====')
    if (dupGroups.length === 0) {
        console.log('未发现重复用户名。')
    } else {
        console.log(`发现 ${dupGroups.length} 组重复用户名,涉及 ${duplicateCount} 个账号:`)
        for (const [norm, list] of dupGroups) {
            console.log(`\n重复组 "${norm}"(${list.length} 个账号):`)
            printTable(
                ['userId', '用户名', '邮箱', 'createdAt', '用户名索引指向'],
                list.map(user => [user.id, user.name, displayEmail(user, secret), displayTime(user.createdAt), user.indexUserId ?? '缺失']),
            )
        }
    }
    if (indexAnomalies.length > 0) {
        console.log(`\n另有 ${indexAnomalies.length} 个账号的用户名索引缺失或指向其他账号:`)
        printTable(
            ['userId', '用户名', '索引指向'],
            indexAnomalies.map(item => [item.userId, item.name, item.indexUserId ?? '缺失']),
        )
    }

    const report = {
        generatedAt: new Date().toISOString(),
        mode: FIX ? 'fix' : 'report',
        secretProvided: Boolean(secret),
        totalUsers: users.length,
        duplicateGroups: dupGroups.map(([norm, list]) => ({
            normalized: norm,
            accounts: list.map(user => ({
                userId: user.id,
                name: user.name,
                email: displayEmail(user, secret),
                createdAt: user.createdAt,
                indexUserId: user.indexUserId,
            })),
        })),
        indexAnomalies,
    }

    if (!FIX) {
        await writeReport(report)
        if (dupGroups.length > 0) {
            console.log('\n发现重复用户名,退出码 1。备份数据后运行 --fix 可自动修复。')
            process.exitCode = 1
        } else {
            console.log('\n未发现重复用户名,退出码 0。')
            process.exitCode = 0
        }
        return
    }

    console.log('\n==== 修复计划(dry-run) ====')
    const plan = await buildPlan(data, dupGroups, users)
    if (dupGroups.length === 0) {
        console.log('无需修复:未发现重复用户名。')
    } else {
        for (const [norm, list] of dupGroups) {
            const sorted = [...list].sort(byCreatedAt)
            const kept = sorted[0]
            console.log(`\n重复组 "${norm}"(${list.length} 个账号):`)
            console.log(`  保留:${kept.name} (${kept.id})`)
            const renames = plan.renames.filter(entry => list.some(user => user.id === entry.userId))
            for (const entry of renames) {
                console.log(`  改名:${entry.from} → ${entry.to} (${entry.userId})`)
            }
            console.log(`  索引校正:${kept.name} (${kept.id}) 的用户名索引`)
        }
    }
    for (const issue of plan.issues) console.log(`  ! ${issue}`)

    console.log('\n==== 执行修复 ====')
    const executed = []
    for (const entry of plan.renames) {
        const user = await getJSON(data, userKey(entry.userId))
        if (!user) {
            executed.push(`账号 ${entry.userId} 不存在,跳过`)
            continue
        }
        let suffix = entry.suffix
        let result = null
        for (let attempt = 0; attempt < 1000; attempt += 1) {
            const candidate = `${user.name}_${suffix}`
            if (await getJSON(data, usernameIndexKey(candidate))) {
                executed.push(`候选名 ${candidate} 已被占用,递增后缀重试`)
                suffix += 1
                continue
            }
            result = await renameUser(data, user, candidate)
            if (!result.taken) {
                executed.push(`已改名:${entry.from} → ${candidate} (${entry.userId})`)
                break
            }
            executed.push(`候选名 ${candidate} 冲突(onlyIfNew 412),递增后缀重试`)
            suffix += 1
        }
        if (!result || result.taken) executed.push(`账号 ${entry.userId} 改名失败(尝试 1000 次仍冲突)`)
    }

    const allGroupIds = new Set(dupGroups.flatMap(([, list]) => list.map(user => user.id)))
    for (const fixup of plan.indexFixups) {
        const result = await ensureKeptIndex(data, fixup.userId, allGroupIds)
        executed.push(result.message)
    }
    for (const event of executed) console.log(`  - ${event}`)

    console.log('\n==== 修复后校验 ====')
    const postScan = await scanUsers(data)
    const validation = await validateUsers(data, postScan.users)
    if (validation.length === 0) {
        console.log('校验通过:无重复用户名,每个用户有且仅有一个正确指向自己的用户名索引。')
    } else {
        console.log(`校验发现问题 ${validation.length} 条:`)
        for (const issue of validation) console.log(`  ! ${issue}`)
    }

    report.mode = 'fix'
    report.plan = {
        renameCount: plan.renames.length,
        renames: plan.renames,
        indexFixups: plan.indexFixups,
        issues: plan.issues,
    }
    report.executed = executed
    report.validation = { ok: validation.length === 0, issues: validation }
    report.postFix = {
        duplicateGroups: postScan.dupGroups.map(([norm, list]) => ({ normalized: norm, accounts: list.map(u => u.id) })),
        indexAnomalies: postScan.indexAnomalies,
    }
    await writeReport(report)

    if (validation.length > 0) {
        console.log('\n修复后仍有问题,退出码 1。')
        process.exitCode = 1
    } else {
        console.log('\n修复完成,退出码 0。')
        process.exitCode = 0
    }
}

main().catch((error) => {
    console.error(`检查失败:${error?.message || error}`)
    process.exitCode = 1
})
