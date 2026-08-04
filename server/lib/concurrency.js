/** Map values while keeping the number of in-flight operations bounded. */
export async function mapWithConcurrency(values, mapper, concurrency = 8) {
    const items = Array.from(values)
    if (items.length === 0) return []
    const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1))
    const results = new Array(items.length)
    let nextIndex = 0

    await Promise.all(Array.from({ length: limit }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex
            nextIndex += 1
            results[index] = await mapper(items[index], index)
        }
    }))
    return results
}
