import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, describe, test } from 'node:test'
import { ASSET_ROOT, OFFICIAL_MUSIC } from '../../src/config/assets'
import {
  MusicMetadataReadError,
  readMusicMetadata,
  resetMusicMetadataCacheForTest,
} from '../../src/features/music/music-metadata'

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'elytrue-id3-'))
after(() => rm(temporaryDirectory, { recursive: true, force: true }))

function syncSafe(value: number): Buffer {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ])
}

function frame(id: string, value: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(id, 'ascii'),
    syncSafe(value.length),
    Buffer.from([0, 0]),
    value,
  ])
}

function utf8(value: string): Buffer {
  return Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')])
}

function id3v24Artwork(format = 'image/png', image?: Buffer): Buffer {
  const artwork =
    image ?? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const frames = Buffer.concat([
    frame('TIT2', utf8('UTF-8 测试曲目')),
    frame('TPE1', utf8('测试歌手')),
    frame('TALB', utf8('测试专辑')),
    frame(
      'APIC',
      Buffer.concat([
        Buffer.from([3]),
        Buffer.from(`${format}\0`, 'ascii'),
        Buffer.from([3, 0]),
        artwork,
      ]),
    ),
  ])
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([4, 0, 0]),
    syncSafe(frames.length),
    frames,
    Buffer.alloc(256),
  ])
}

function uint24(value: number): Buffer {
  return Buffer.from([
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

function id3v22Frame(id: string, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, 'ascii'), uint24(value.length), value])
}

function id3v22Artwork(format: 'JPG' | 'PNG', image: Buffer): Buffer {
  const frames = Buffer.concat([
    id3v22Frame('TT2', utf8('ID3v2.2 artwork')),
    id3v22Frame(
      'PIC',
      Buffer.concat([
        Buffer.from([3]),
        Buffer.from(format, 'ascii'),
        Buffer.from([3, 0]),
        image,
      ]),
    ),
  ])
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([2, 0, 0]),
    syncSafe(frames.length),
    frames,
    Buffer.alloc(64),
  ])
}

function emptyId3v24(): Buffer {
  return Buffer.concat([
    Buffer.from('ID3', 'ascii'),
    Buffer.from([4, 0, 0]),
    syncSafe(0),
    Buffer.alloc(64),
  ])
}

describe('MP3 metadata', () => {
  test('parses UTF-16 ID3v2.3 tags and JPEG APIC from all repository tracks', async () => {
    for (const name of OFFICIAL_MUSIC) {
      const path = resolve('public', ASSET_ROOT.slice(1), 'bgm', name)
      const metadata = await readMusicMetadata(path)
      assert.ok(metadata?.title, name)
      assert.ok(metadata.artist, name)
      assert.ok(metadata.album, name)
      assert.equal(metadata.artwork?.type, 'image/jpeg', name)
      assert.ok((metadata.artwork?.data.length ?? 0) > 10_000, name)
    }
  })

  test('parses ID3v2.4 UTF-8 text and PNG APIC', async () => {
    const path = join(temporaryDirectory, 'v24.png.mp3')
    await writeFile(path, id3v24Artwork())
    const metadata = await readMusicMetadata(path)
    assert.equal(metadata?.title, 'UTF-8 测试曲目')
    assert.equal(metadata?.artist, '测试歌手')
    assert.equal(metadata?.album, '测试专辑')
    assert.equal(metadata?.artwork?.type, 'image/png')
    assert.equal(metadata?.artwork?.data[0], 0x89)
  })

  test('normalizes JPEG/PNG MIME and bare artwork formats with exact bytes', async () => {
    const cases = [
      { name: 'mime-jpg', format: 'image/jpg', type: 'image/jpeg' },
      { name: 'mime-jpeg-upper', format: 'IMAGE/JPEG', type: 'image/jpeg' },
      { name: 'mime-png', format: 'image/png', type: 'image/png' },
      { name: 'bare-png', format: 'PNG', type: 'image/png' },
    ] as const

    for (const [index, item] of cases.entries()) {
      resetMusicMetadataCacheForTest()
      const image = Buffer.from([0xa0 + index, 1, 2, 3, 0xf0 + index])
      const path = join(temporaryDirectory, `${item.name}.mp3`)
      await writeFile(path, id3v24Artwork(item.format, image))
      const metadata = await readMusicMetadata(path)
      assert.equal(metadata?.artwork?.type, item.type, item.name)
      assert.deepEqual(
        Buffer.from(metadata?.artwork?.data ?? []),
        image,
        item.name,
      )
    }

    for (const format of ['JPG', 'PNG'] as const) {
      resetMusicMetadataCacheForTest()
      const image = Buffer.from([0x10, 0x20, 0x30, format === 'JPG' ? 1 : 2])
      const path = join(temporaryDirectory, `v22-${format}.mp3`)
      await writeFile(path, id3v22Artwork(format, image))
      const metadata = await readMusicMetadata(path)
      assert.equal(
        metadata?.artwork?.type,
        format === 'JPG' ? 'image/jpeg' : 'image/png',
      )
      assert.deepEqual(Buffer.from(metadata?.artwork?.data ?? []), image)
    }
  })

  test('deduplicates in-flight reads and caches non-empty success', async () => {
    resetMusicMetadataCacheForTest()
    const actual = resolve(
      'public',
      ASSET_ROOT.slice(1),
      'bgm',
      OFFICIAL_MUSIC[0],
    )
    const firstRequest = readMusicMetadata(actual)
    assert.equal(firstRequest, readMusicMetadata(actual))
    const firstResult = await firstRequest
    assert.equal(await readMusicMetadata(actual), firstResult)
  })

  test('does not retain reader failures or empty metadata results', async () => {
    resetMusicMetadataCacheForTest()
    const broken = join(temporaryDirectory, 'broken.mp3')
    await writeFile(broken, Buffer.alloc(512, 0xff))
    const firstFailure = readMusicMetadata(broken)
    await assert.rejects(firstFailure, MusicMetadataReadError)
    const secondFailure = readMusicMetadata(broken)
    assert.notEqual(secondFailure, firstFailure)
    await assert.rejects(secondFailure, MusicMetadataReadError)

    const empty = join(temporaryDirectory, 'empty-tags.mp3')
    await writeFile(empty, emptyId3v24())
    const firstEmpty = readMusicMetadata(empty)
    assert.equal(await firstEmpty, null)
    const secondEmpty = readMusicMetadata(empty)
    assert.notEqual(secondEmpty, firstEmpty)
    assert.equal(await secondEmpty, null)
  })
})
