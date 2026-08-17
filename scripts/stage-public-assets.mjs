import { copyFile, link, lstat, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

async function destinationExists(filePath) {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function stageFile(source, destination, totals) {
  if (await destinationExists(destination)) {
    throw new Error(
      `Refusing to overwrite generated build output with ${source}`,
    )
  }

  const sourceStats = await lstat(source)
  try {
    await link(source, destination)
    totals.hardlinkedBytes += sourceStats.size
    totals.hardlinkedFiles += 1
  } catch (error) {
    if (!['EXDEV', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      throw error
    }
    await copyFile(source, destination)
    totals.copiedBytes += sourceStats.size
    totals.copiedFiles += 1
  }
}

async function stageDirectory(sourceDirectory, outputDirectory, totals) {
  await mkdir(outputDirectory, { recursive: true })
  const entries = await readdir(sourceDirectory, { withFileTypes: true })
  for (const entry of entries) {
    const source = path.join(sourceDirectory, entry.name)
    const destination = path.join(outputDirectory, entry.name)
    if (entry.isDirectory()) {
      await stageDirectory(source, destination, totals)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported public asset type: ${source}`)
    }
    await stageFile(source, destination, totals)
  }
}

export async function stagePublicAssets({
  publicDirectory = path.join(repositoryRoot, 'public'),
  outputDirectory = path.join(repositoryRoot, 'dist'),
} = {}) {
  const totals = {
    copiedBytes: 0,
    copiedFiles: 0,
    hardlinkedBytes: 0,
    hardlinkedFiles: 0,
  }
  await stageDirectory(publicDirectory, outputDirectory, totals)
  return totals
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  const totals = await stagePublicAssets()
  const hardlinkedMiB = (totals.hardlinkedBytes / 1024 / 1024).toFixed(2)
  const copiedMiB = (totals.copiedBytes / 1024 / 1024).toFixed(2)
  console.log(
    `Staged public assets: ${totals.hardlinkedFiles} hard-linked file(s) (${hardlinkedMiB} MiB), ${totals.copiedFiles} copied file(s) (${copiedMiB} MiB).`,
  )
}
