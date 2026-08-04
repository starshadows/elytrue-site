const CATEGORIES = [
    'auth',
    'routing',
    'index',
    'commentBodies',
    'likes',
    'replyPreviews',
    'todayCount',
    'serialization',
]

export function createServerTiming() {
    const startedAt = performance.now()
    const durations = Object.fromEntries(CATEGORIES.map(category => [category, 0]))
    return {
        measureSync(category, operation) {
            const start = performance.now()
            try {
                return operation()
            } finally {
                if (category in durations) {
                    durations[category] = (durations[category] ?? 0) + performance.now() - start
                }
            }
        },
        async measure(category, operation) {
            const start = performance.now()
            try {
                return await operation()
            } finally {
                if (category in durations) {
                    durations[category] = (durations[category] ?? 0) + performance.now() - start
                }
            }
        },
        header() {
            const values = CATEGORIES.map(category =>
                `${category};dur=${(durations[category] ?? 0).toFixed(1)}`)
            values.push(`total;dur=${(performance.now() - startedAt).toFixed(1)}`)
            return values.join(', ')
        },
    }
}

export function attachServerTiming(response, timing) {
    response.headers.set('Server-Timing', timing.header())
    return response
}
