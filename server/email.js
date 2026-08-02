function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export function getFromAddress(env) {
    const name = String(env.RESEND_FROM_NAME || '星花札记').trim() || '星花札记'
    const email = String(env.RESEND_FROM_EMAIL || 'noreply@mail.elytrue.com').trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        throw new Error(`RESEND_FROM_EMAIL 配置无效: ${email}`)
    }
    return `${name} <${email}>`
}

/**
 * 发送密码重置邮件。不抛异常,始终返回结构化结果,由调用方记录日志:
 *   { ok, emailId?, status?, error? }
 * 便于单元测试 mock provider,也避免吞掉错误细节。
 */
export async function sendPasswordResetEmail(env, { email, username, token }) {
    if (!env.RESEND_API_KEY) {
        return { ok: false, error: 'RESEND_API_KEY 未配置' }
    }
    let from
    try {
        from = getFromAddress(env)
    } catch (error) {
        return { ok: false, error: error.message }
    }

    const siteUrl = String(env.PUBLIC_SITE_URL || 'https://elytrue.com').replace(/\/+$/u, '')
    const resetUrl = `${siteUrl}/#resetpassword=${encodeURIComponent(token)}`
    let response
    try {
        response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to: [email],
                subject: '重置星花札记账号密码',
                html: `
                    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.7;color:#3b2737">
                        <h2>重置密码</h2>
                        <p>${escapeHtml(username)}，你好。</p>
                        <p>请在 30 分钟内点击下面的链接设置新密码：</p>
                        <p><a href="${escapeHtml(resetUrl)}">设置新密码</a></p>
                        <p style="color:#76626f">如果不是你发起的请求，可以忽略这封邮件。</p>
                    </div>
                `,
            }),
        })
    } catch (error) {
        return { ok: false, error: String(error?.message || error).slice(0, 300) }
    }

    if (!response.ok) {
        const details = await response.text().catch(() => '')
        return { ok: false, status: response.status, error: details.slice(0, 300) }
    }
    const emailId = await response.json()
        .then(body => body && typeof body === 'object' && 'id' in body ? String(body.id) : '')
        .catch(() => '')
    return { ok: true, emailId }
}
