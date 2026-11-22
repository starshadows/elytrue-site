export function apiRoutePath(request) {
    const path = new URL(request.url).pathname
    return decodeURIComponent(path.replace(/^\/api\/?/u, '').replace(/\/+$/u, ''))
}

