function normalizeUrl(url?: string): string | undefined {
    if (url) {
        return url.endsWith('/') ? url : (url + '/')
    }
}

export const baseUrl = normalizeUrl(window.baseUrl) || ''
export const bgBaseUrl = normalizeUrl(window.bgBaseUrl) || (baseUrl + 'bg/')
