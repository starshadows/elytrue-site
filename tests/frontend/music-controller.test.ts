import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildMusicPlaylist,
  createMusicController,
  createPlayOrder,
  getAdjacentSongIndex,
  parsePlaybackState,
} from '../../src/features/music/music-controller'

test('construction and disposal do not require a DOM', () => {
  createMusicController().dispose()
})

describe('music playback order', () => {
  test('keeps the default song first and shuffles the remaining playlist', () => {
    const playlist = buildMusicPlaylist(
      '/music/',
      ['first song.mp3', 'default.mp3', 'last song.mp3'],
      'default.mp3',
      () => 0,
    )

    assert.deepEqual(playlist, [
      '/music/default.mp3',
      '/music/last%20song.mp3',
      '/music/first%20song.mp3',
    ])
  })

  test('creates sequential or deterministic Fisher-Yates orders', () => {
    assert.deepEqual(createPlayOrder(4, false), [0, 1, 2, 3])
    assert.deepEqual(
      createPlayOrder(4, true, () => 0),
      [1, 2, 3, 0],
    )
  })

  test('wraps next and previous navigation in playback order', () => {
    const order = [2, 0, 1]
    assert.equal(getAdjacentSongIndex(order, 1, 'next'), 2)
    assert.equal(getAdjacentSongIndex(order, 2, 'previous'), 1)
    assert.equal(getAdjacentSongIndex(order, 0, 'next'), 1)
    assert.equal(getAdjacentSongIndex([], 0, 'next'), undefined)
  })
})

describe('music playback persistence', () => {
  test('parses a resumable state and defaults missing paused state to true', () => {
    assert.deepEqual(
      parsePlaybackState(
        JSON.stringify({
          song: 'HOYO-MiX - Elysia.mp3',
          currentTime: 42.5,
          paused: false,
        }),
      ),
      {
        song: 'HOYO-MiX - Elysia.mp3',
        currentTime: 42.5,
        paused: false,
      },
    )
    assert.deepEqual(
      parsePlaybackState('{"song":"track.mp3","currentTime":0}'),
      { song: 'track.mp3', currentTime: 0, paused: true },
    )
  })

  test('rejects malformed or incomplete persisted values', () => {
    assert.equal(parsePlaybackState(null), null)
    assert.equal(parsePlaybackState('{broken'), null)
    assert.equal(parsePlaybackState('{"song":"track.mp3"}'), null)
    assert.equal(
      parsePlaybackState(
        '{"song":"track.mp3","currentTime":"12","paused":false}',
      ),
      null,
    )
    assert.equal(
      parsePlaybackState(
        '{"song":"track.mp3","currentTime":1e999,"paused":false}',
      ),
      null,
    )
  })
})
