const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

export function normalizeUsername(value) {
    return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

export function normalizeEmail(value) {
    return String(value ?? '').normalize('NFKC').trim().toLowerCase()
}

export function validateUsername(value) {
    const name = String(value ?? '').normalize('NFKC').trim()
    if (name.length < 2 || name.length > 24) {
        return '用户名长度需为 2–24 个字符'
    }
    if (/[\u0000-\u001f\u007f<>]/u.test(name)) {
        return '用户名包含不支持的字符'
    }
    return null
}

export function validateEmail(value) {
    const email = normalizeEmail(value)
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        return '邮箱格式不正确'
    }
    return null
}

export function validatePassword(value) {
    const password = String(value ?? '')
    if (password.length < 8 || password.length > 128) {
        return '密码长度需为 8–128 个字符'
    }
    return null
}

export function validateComment(value) {
    const comment = String(value ?? '').replace(/\r\n?/gu, '\n').trim()
    if (!comment) return '留言不能为空'
    if (comment.length > 2000) return '留言不能超过 2000 个字符'
    return null
}

export function sanitizePlainText(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/\u0000/gu, '')
        .trim()
}
