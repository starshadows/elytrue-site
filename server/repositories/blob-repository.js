import { getJSON, listAll } from '../storage.js'

/**
 * Thin repository facade over EdgeOne Blob. Reads explicitly keep the store's
 * strong-consistency behavior; conditional creates retain `onlyIfNew`.
 */
export function createBlobRepository(store) {
    return Object.freeze({
        get: key => getJSON(store, key),
        list: (prefix, limit = 1000) => listAll(store, prefix, limit),
        create: (key, value) => store.setJSON(key, value, { onlyIfNew: true }),
        set: (key, value) => store.setJSON(key, value),
        delete: key => store.delete(key),
    })
}

