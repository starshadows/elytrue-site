import { getStore } from '@edgeone/pages-blob'

export class MemoryStore {
    constructor() {
        this.values = new Map()
    }

    async set(key, value, options = {}) {
        if (options.onlyIfNew && this.values.has(key)) {
            const error = new Error('Object already exists')
            error.name = 'PreconditionFailedError'
            throw error
        }
        if (value instanceof ArrayBuffer) {
            this.values.set(key, value.slice(0))
        } else if (ArrayBuffer.isView(value)) {
            this.values.set(key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        } else {
            this.values.set(key, value)
        }
    }

    async setJSON(key, value, options = {}) {
        return this.set(key, structuredClone(value), options)
    }

    async get(key, options = {}) {
        if (!this.values.has(key)) return null
        const value = this.values.get(key)
        if (options.type === 'json') {
            if (typeof value === 'string') return JSON.parse(value)
            return structuredClone(value)
        }
        if (options.type === 'arrayBuffer') {
            if (value instanceof ArrayBuffer) return value.slice(0)
            if (typeof value === 'string') return Buffer.from(value).buffer
        }
        if (typeof value === 'object' && !(value instanceof ArrayBuffer)) {
            return JSON.stringify(value)
        }
        return value
    }

    async delete(key) {
        this.values.delete(key)
    }

    async list(options = {}) {
        const prefix = options.prefix ?? ''
        const keys = [...this.values.keys()].filter(key => key.startsWith(prefix)).sort()
        const start = options.paginate === false ? Number(options.cursor || 0) : 0
        const limit = Number.isFinite(options.limit) ? options.limit : keys.length
        const sliced = keys.slice(start, start + limit)
        const nextOffset = start + sliced.length
        return {
            blobs: sliced.map(key => ({ key, etag: 'memory' })),
            directories: [],
            ...(options.paginate === false && nextOffset < keys.length
                ? { cursor: String(nextOffset) }
                : {}),
        }
    }
}

let edgeStores

export function createStores(injected) {
    if (injected) return injected
    if (!edgeStores) {
        edgeStores = {
            data: getStore('elytrue-data'),
            uploads: getStore('elytrue-uploads'),
        }
    }
    return edgeStores
}

export async function getJSON(store, key) {
    return store.get(key, { type: 'json', consistency: 'strong' })
}

export async function listAll(store, prefix, limit = 1000) {
    const result = await store.list({
        prefix,
        limit,
        consistency: 'strong',
    })
    return result.blobs
}

export function isPreconditionFailure(error) {
    return error?.name === 'PreconditionFailedError'
        || error?.code === 'PRECONDITION_FAILED'
        || error?.statusCode === 412
}
