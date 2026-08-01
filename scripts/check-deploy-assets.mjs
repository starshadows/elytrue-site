import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url))
const maximumBytes = 25 * 1024 * 1024
const ignoredDirectories = new Set(['node_modules', '.git', 'dist'])
const oversize = []

async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
            await walk(path)
            continue
        }
        const info = await stat(path)
        if (info.size > maximumBytes) {
            oversize.push({
                path: relative(publicRoot, path),
                bytes: info.size,
            })
        }
    }
}

await walk(publicRoot)
if (oversize.length) {
    console.error('EdgeOne Makers refuses static files over 25 MiB:')
    for (const item of oversize) {
        console.error(`- ${item.path}: ${(item.bytes / 1024 / 1024).toFixed(2)} MiB`)
    }
    process.exitCode = 1
} else {
    console.log(`Asset size check passed for ${relative(root, publicRoot) || 'public'}.`)
}
