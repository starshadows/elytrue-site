import { httpError } from './http.js'

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export async function sendPasswordResetEmail(env, { email, username, token }) {
    if (!env.RESEND_API_KEY) throw httpError(503, '邮件服务尚未配置')
    const siteUrl = String(env.PUBLIC_SITE_URL || 'https://elytrue.com').replace(/\/+$/u, '')
    const resetUrl = `${siteUrl}/#resetpassword=${encodeURIComponent(token)}`
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: '星花札记 <noreply@mail.elytrue.com>',
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
    if (!response.ok) {
        const details = await response.text().catch(() => '')
        console.error('Resend request failed', response.status, details.slice(0, 300))
        throw httpError(503, '邮件服务暂时不可用')
    }
}
