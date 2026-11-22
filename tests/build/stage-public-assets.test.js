import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { stagePublicAssets } from '../../scripts/stage-public-assets.mjs'

test('stages public assets without duplicating file data when hard links are available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elytrue-stage-assets-'))
  const publicDirectory = path.join(root, 'public')
  const outputDirectory = path.join(root, 'dist')
  const source = path.join(publicDirectory, 'assets', 'video.ts')
  const destination = path.join(outputDirectory, 'assets', 'video.ts')

  try {
    await mkdir(path.dirname(source), { recursive: true })
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(source, 'large media placeholder')

    const totals = await stagePublicAssets({
      publicDirectory,
      outputDirectory,
    })

    assert.equal(await readFile(destination, 'utf8'), 'large media placeholder')
    assert.equal(totals.hardlinkedFiles + totals.copiedFiles, 1)
    if (totals.hardlinkedFiles === 1) {
      assert.equal((await stat(source)).ino, (await stat(destination)).ino)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses to overwrite generated output with a public asset', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'elytrue-stage-assets-'))
  const publicDirectory = path.join(root, 'public')
  const outputDirectory = path.join(root, 'dist')

  try {
    await mkdir(publicDirectory, { recursive: true })
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(path.join(publicDirectory, 'index.html'), 'public')
    await writeFile(path.join(outputDirectory, 'index.html'), 'generated')

    await assert.rejects(
      stagePublicAssets({ publicDirectory, outputDirectory }),
      /Refusing to overwrite generated build output/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
