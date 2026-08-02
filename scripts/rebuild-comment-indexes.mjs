#!/usr/bin/env node
/**
 * rebuild-comment-indexes.mjs —— 留言编号 / 日期 / 用户索引迁移与修复
 *
 * 用法:
 *   EDGEONE_PROJECT_ID=<项目ID> EDGEONE_API_TOKEN=<API Token> \
 *     node scripts/rebuild-comment-indexes.mjs [--fix]
 *
 * 行为:
 *   默认报告模式:listAll 读取全部 comments/ 留言,统计总数、已有 number 的、
 *     缺 number 的;打印前 20 条缺 number 的留言;对比
 *     indexes/comments/number/、dates/、indexes/comments/by-user/
 *     三个前缀下现有记录数与应有数量的差距。
 *   --fix 修复模式:先打印计划,再执行——
 *     缺 number 的留言按 createdAt(无则 time*1000,再按 id)升序编号,
 *     编号从「现有最大 number + 1」开始(读 meta/comments-number-hint.json,
 *     遇 onlyIfNew 412 则 +1 重试,与 server/comments.js 的 claimCommentNumber 一致);
 *     为每条留言写编号索引、补 number 字段(不覆盖其他字段)、写 dates/ 与 by-user 索引;
 *     已有 number 的留言只补缺的 dates/ 与 by-user 索引(编号索引缺失时补建,不改 number);
 *     最后重新校验并打印结果。
 *
 * 幂等性:重复运行不会产生重复编号;已完备的数据会直接报告健康。
 *
 * 回滚方式:删除 indexes/comments/number/、dates/、indexes/comments/by-user/
 *   三个前缀下的 key 即可回滚索引迁移,comments/ 本体不会被修改(修复只补写,
 *   不改写已有字段)。建议先执行 `npm run export:data` 备份全部 Blob。
 *
 * 退出码:
 *   0 = 索引完整(报告模式),或修复后校验通过
 *   1 = 发现缺口但未修复,或修复后仍有问题;环境变量缺失 / 其他错误也非 0 退出
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getStore } from '@edgeone/pages-blob'
import { getJSON, isPreconditionFailure, listAll } from '../server/storage.js'
import { shanghaiDateString } from '../server/comments.js'

const FIX = process.argv.includes('--fix')
const DATA_STORE = 'elytrue-data'
const NUMBER_HINT_KEY = 'meta/comments-number-hint.json'

function commentKey(id) {
    return `comments/${String(id).padStart(16, '0')}.json`
}

function commentNumberKey(number) {
    return `indexes/comments/number/${Number(number)}.json`
}

function userCommentsKey(uid, id) {
    return `indexes/comments/by-user/${uid}/${String(id).padStart(16, '0')}.json`
}

function dateCommentsKey(date, id) {
    return `dates/${date}/${String(id).padStart(16, '0')}.json`
}

function commentCreatedAt(comment) {
    if (Number.isFinite(Number(comment.createdAt))) return Number(comment.createdAt)
    if (Number.isFinite(Number(comment.time))) return Number(comment.time) * 1000
    return 0
}

function byCreatedAt(a, b) {
    return commentCreatedAt(a) - commentCreatedAt(b) || a.id - b.id
}

function previewComment(comment) {
    return Array.from(String(comment.comment ?? '').replace(/\r\n?/gu, ' ')).slice(0, 30).join('')
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

async function loadComments(data) {
    const blobs = await listAll(data, 'comments/', Infinity)
    const comments = []
    for (const blob of blobs) {
        const match = /^comments\/(\d+)\.json$/u.exec(blob.key)
        if (!match) {
            console.error(`跳过无法解析的 key:${blob.key}`)
            continue
        }
        const body = await getJSON(data, blob.key)
        if (!body) continue
        const id = Number(match[1])
        if (blob.key !== commentKey(id)) {
            console.error(`警告:key 与 16 位补零格式不符:${blob.key}(内部 id ${id})`)
        }
        comments.push({ id, key: blob.key, body })
    }
    return comments
}

async function readNumberIndexStats(data) {
    const blobs = await listAll(data, 'indexes/comments/number/', Infinity)
    let maxNumber = 0
    let validCount = 0
    for (const blob of blobs) {
        const match = /^indexes\/comments\/number\/(\d+)\.json$/u.exec(blob.key)
        const number = match ? Number(match[1]) : null
        const seat = await getJSON(data, blob.key)
        if (number && seat?.commentId != null) {
            validCount += 1
            maxNumber = Math.max(maxNumber, number)
        }
    }
    return { count: blobs.length, validCount, maxNumber }
}

async function writeReport(report) {
    const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
    const path = resolve('exports', `rebuild-comment-indexes-${timestamp}.json`)
    await mkdir(resolve('exports'), { recursive: true })
    await writeFile(path, JSON.stringify(report, null, 2))
    console.log(`JSON 报告已写入:${path}`)
}

async function validateIndexes(data, comments) {
    const issues = []
    const byId = new Map(comments.map(entry => [entry.id, entry]))

    const numberBlobs = await listAll(data, 'indexes/comments/number/', Infinity)
    const seatByNumber = new Map()
    for (const blob of numberBlobs) {
        const match = /^indexes\/comments\/number\/(\d+)\.json$/u.exec(blob.key)
        const number = match ? Number(match[1]) : null
        const seat = await getJSON(data, blob.key)
        if (number == null) {
            issues.push(`编号索引 key 异常:${blob.key}`)
            continue
        }
        if (!seat?.commentId) {
            issues.push(`编号索引 ${blob.key} 内容无效`)
            continue
        }
        seatByNumber.set(number, Number(seat.commentId))
    }

    for (const entry of comments) {
        const { id, body } = entry
        if (body.number == null) {
            issues.push(`留言 ${id} 缺少 number 字段`)
            continue
        }
        const number = Number(body.number)
        if (seatByNumber.get(number) !== id) {
            issues.push(`编号 ${number} 索引缺失或指向其他留言(留言 ${id})`)
        }
    }
    for (const [number, commentId] of seatByNumber) {
        const entry = byId.get(commentId)
        if (!entry) {
            issues.push(`编号 ${number} 索引指向不存在的留言 ${commentId}`)
        } else if (Number(entry.body.number) !== number) {
            issues.push(`留言 ${commentId} 的 number(${entry.body.number}) 与编号索引不一致`)
        }
    }

    for (const entry of comments) {
        const { id, body } = entry
        const createdAt = commentCreatedAt(body)
        const dateKey = dateCommentsKey(shanghaiDateString(createdAt), id)
        const dateSeat = await getJSON(data, dateKey)
        if (!dateSeat) {
            issues.push(`留言 ${id} 缺少日期索引 ${dateKey}`)
        } else if (Number(dateSeat.commentId) !== id) {
            issues.push(`日期索引 ${dateKey} 指向错误(${dateSeat.commentId})`)
        }
        const byUserKey = userCommentsKey(body.uid, id)
        const byUserSeat = await getJSON(data, byUserKey)
        if (!byUserSeat) {
            issues.push(`留言 ${id} 缺少用户索引 ${byUserKey}`)
        } else if (Number(byUserSeat.commentId) !== id) {
            issues.push(`用户索引 ${byUserKey} 指向错误(${byUserSeat.commentId})`)
        }
    }
    return issues
}

async function main() {
    const projectId = process.env.EDGEONE_PROJECT_ID
    const token = process.env.EDGEONE_API_TOKEN
    if (!projectId || !token) {
        throw new Error('缺少环境变量:必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN 后才能运行(可先执行 npm run export:data 备份)')
    }

    console.error(`连接 Blob 存储 ${DATA_STORE} ...`)
    const data = getStore({ name: DATA_STORE, projectId, token, consistency: 'strong' })

    console.error('读取全部留言与索引 ...')
    const comments = await loadComments(data)
    const missing = comments.filter(entry => entry.body.number == null).sort(byCreatedAt)
    const withNumber = comments.filter(entry => entry.body.number != null)
    console.error(`共读取 ${comments.length} 条留言`)

    const numberStats = await readNumberIndexStats(data)
    const hint = Number((await getJSON(data, NUMBER_HINT_KEY))?.value || 0)
    const maxCommentNumber = withNumber.reduce((max, entry) => Math.max(max, Number(entry.body.number) || 0), 0)
    const maxNumber = Math.max(numberStats.maxNumber, maxCommentNumber, hint)
    const dateBlobs = await listAll(data, 'dates/', Infinity)
    const byUserBlobs = await listAll(data, 'indexes/comments/by-user/', Infinity)

    console.log('==== 留言索引报告 ====')
    console.log(`留言总数:${comments.length}`)
    console.log(`已有 number:${withNumber.length} 条,缺 number:${missing.length} 条`)
    if (missing.length > 0) {
        console.log(`\n前 ${Math.min(20, missing.length)} 条缺 number 的留言(按 createdAt 升序):`)
        printTable(
            ['id', 'createdAt', 'uid', 'comment(前 30 字)'],
            missing.slice(0, 20).map(entry => [
                entry.id,
                new Date(commentCreatedAt(entry.body)).toISOString(),
                entry.body.uid ?? '—',
                previewComment(entry.body),
            ]),
        )
    }
    console.log('\n索引前缀记录数与应有数量:')
    printTable(
        ['前缀', '现有记录数', '应有数量', '差距'],
        [
            ['indexes/comments/number/', numberStats.validCount, withNumber.length, numberStats.validCount - withNumber.length],
            ['dates/', dateBlobs.length, comments.length, dateBlobs.length - comments.length],
            ['indexes/comments/by-user/', byUserBlobs.length, comments.length, byUserBlobs.length - comments.length],
        ],
    )

    const gaps = missing.length > 0
        || numberStats.validCount !== withNumber.length
        || dateBlobs.length !== comments.length
        || byUserBlobs.length !== comments.length

    const report = {
        generatedAt: new Date().toISOString(),
        mode: FIX ? 'fix' : 'report',
        totalComments: comments.length,
        withNumber: withNumber.length,
        missingNumber: missing.length,
        missingTop: missing.slice(0, 20).map(entry => ({
            id: entry.id,
            createdAt: entry.body.createdAt,
            time: entry.body.time,
            uid: entry.body.uid,
            commentPreview: previewComment(entry.body),
        })),
        indexes: {
            number: { count: numberStats.validCount, expected: withNumber.length, gap: numberStats.validCount - withNumber.length },
            dates: { count: dateBlobs.length, expected: comments.length, gap: dateBlobs.length - comments.length },
            byUser: { count: byUserBlobs.length, expected: comments.length, gap: byUserBlobs.length - comments.length },
        },
        maxNumber,
        hint,
    }

    if (!FIX) {
        await writeReport(report)
        if (gaps) {
            console.log('\n发现索引缺口,退出码 1。备份数据后运行 --fix 可补齐。')
            process.exitCode = 1
        } else {
            console.log('\n留言索引完整,退出码 0。')
            process.exitCode = 0
        }
        return
    }

    console.log('\n==== 修复计划 ====')
    if (missing.length === 0) {
        console.log('无需分配编号:所有留言都已有 number。')
    } else {
        const start = maxNumber + 1
        console.log(`需分配编号的留言:${missing.length} 条`)
        console.log(`编号范围:${start} – ${start + missing.length - 1}(从现有最大编号 ${maxNumber} + 1 开始)`)
    }

    console.log('\n==== 执行修复 ====')
    const executed = []
    const assigned = []
    let number = maxNumber + 1
    for (const entry of missing) {
        const { id, key, body } = entry
        const createdAt = commentCreatedAt(body)
        let claimed = null
        for (let attempt = 0; attempt < 2000; attempt += 1) {
            try {
                await data.setJSON(commentNumberKey(number), { commentId: id, createdAt }, { onlyIfNew: true })
                claimed = number
                break
            } catch (error) {
                if (!isPreconditionFailure(error)) throw error
                number += 1
            }
        }
        if (claimed === null) throw new Error(`留言 ${id} 编号分配失败(尝试 2000 次仍冲突)`)
        number += 1

        body.number = claimed
        await data.setJSON(key, body)
        await data.setJSON(dateCommentsKey(shanghaiDateString(createdAt), id), { commentId: id, createdAt })
        await data.setJSON(userCommentsKey(body.uid, id), { commentId: id, createdAt })
        await data.setJSON(NUMBER_HINT_KEY, { value: claimed, updatedAt: Date.now() }).catch(() => {})
        assigned.push({ id, number: claimed })
        executed.push(`留言 ${id}:已分配编号 ${claimed},并补齐日期/用户索引`)
    }

    for (const entry of withNumber) {
        const { id, key, body } = entry
        const createdAt = commentCreatedAt(body)
        const numberKey = commentNumberKey(body.number)
        const seat = await getJSON(data, numberKey)
        if (!seat) {
            try {
                await data.setJSON(numberKey, { commentId: id, createdAt }, { onlyIfNew: true })
                executed.push(`留言 ${id}:补建缺失的编号索引 ${numberKey}`)
            } catch (error) {
                if (!isPreconditionFailure(error)) throw error
                executed.push(`警告:留言 ${id} 的编号索引 ${numberKey} 已被其他留言占用,未补建`)
            }
        }
        const dateKey = dateCommentsKey(shanghaiDateString(createdAt), id)
        if (!(await getJSON(data, dateKey))) {
            await data.setJSON(dateKey, { commentId: id, createdAt })
            executed.push(`留言 ${id}:补齐日期索引 ${dateKey}`)
        }
        const byUserKey = userCommentsKey(body.uid, id)
        if (!(await getJSON(data, byUserKey))) {
            await data.setJSON(byUserKey, { commentId: id, createdAt })
            executed.push(`留言 ${id}:补齐用户索引 ${byUserKey}`)
        }
    }
    if (executed.length === 0) {
        console.log('  无需操作:所有索引均已完备。')
    } else {
        for (const event of executed) console.log(`  - ${event}`)
    }

    console.log('\n==== 修复后校验 ====')
    const postComments = await loadComments(data)
    const validation = await validateIndexes(data, postComments)
    if (validation.length === 0) {
        console.log(`校验通过:${postComments.length} 条留言全部有 number,编号/日期/用户索引完备且一致。`)
    } else {
        console.log(`校验发现问题 ${validation.length} 条:`)
        for (const issue of validation) console.log(`  ! ${issue}`)
    }

    report.mode = 'fix'
    report.plan = {
        missingCount: missing.length,
        startNumber: maxNumber + 1,
        endNumber: maxNumber + Math.max(missing.length, 1),
    }
    report.assigned = assigned
    report.executed = executed
    report.validation = { ok: validation.length === 0, issues: validation }
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
