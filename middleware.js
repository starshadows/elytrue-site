export function middleware(context) {
    const url = new URL(context.request.url)
    if (url.hostname === 'www.elytrue.com' || url.hostname === 'blog.elytrue.com') {
        url.protocol = 'https:'
        url.hostname = 'elytrue.com'
        return context.redirect(url.toString(), 301)
    }
    return context.next()
}

export const config = {
    matcher: '/:path*',
}
