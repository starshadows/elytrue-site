import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getStore } from '@edgeone/pages-blob'

const projectId = process.env.EDGEONE_PROJECT_ID
const token = process.env.EDGEONE_API_TOKEN
if (!projectId || !token) {
    throw new Error('Set EDGEONE_PROJECT_ID and EDGEONE_API_TOKEN for this one-time local export.')
}

const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/u, 'Z')
const output = resolve('exports', `elytrue-${timestamp}`)
await mkdir(output, { recursive: true })

for (const name of ['elytrue-data', 'elytrue-uploads']) {
    const store = getStore({ name, projectId, token, consistency: 'strong' })
    const listing = await store.list({ consistency: 'strong' })
    const manifest = []
    for (const blob of listing.blobs) {
        const value = await store.get(blob.key, { type: 'arrayBuffer', consistency: 'strong' })
        const safeName = blob.key.replaceAll('/', '__')
        await writeFile(resolve(output, `${name}__${safeName}`), Buffer.from(value))
        manifest.push({ key: blob.key, etag: blob.etag, file: `${name}__${safeName}` })
    }
    await writeFile(resolve(output, `${name}-manifest.json`), JSON.stringify(manifest, null, 2))
}

console.log(`Export complete: ${output}`)
