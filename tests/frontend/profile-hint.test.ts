import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  clearProfileHint,
  profileHint,
  readProfileHint,
  saveProfileHint,
} from '../../src/features/auth/profile-hint'

class MemoryStorage {
  values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

afterEach(() => clearProfileHint(null))

describe('cached profile hint', () => {
  test('stores only non-sensitive display fields', () => {
    const storage = new MemoryStorage()
    const fullProfile = {
      id: 'user-1',
      name: '爱莉希雅',
      avatar: 'avatar-1',
      email: 'hidden@example.com',
      role: 'admin' as const,
      csrfToken: 'must-not-persist',
      recoveryKey: 'must-not-persist',
      token: 'must-not-persist',
    }
    saveProfileHint(fullProfile, storage)

    const raw = [...storage.values.values()][0]
    assert.ok(raw)
    const saved = JSON.parse(raw)
    assert.deepEqual(Object.keys(saved).sort(), [
      'avatar',
      'name',
      'savedAt',
      'userId',
      'version',
    ])
    assert.equal(saved.name, '爱莉希雅')
    assert.equal(profileHint.value?.userId, 'user-1')
  })

  test('removes corrupt and incompatible cache entries', () => {
    const storage = new MemoryStorage()
    storage.setItem('elytrue.profileHint', '{broken')
    assert.equal(readProfileHint(storage), null)
    assert.equal(storage.values.size, 0)

    storage.setItem(
      'elytrue.profileHint',
      JSON.stringify({
        version: 2,
        userId: 'u',
        name: 'n',
        avatar: '',
        savedAt: 1,
      }),
    )
    assert.equal(readProfileHint(storage), null)
    assert.equal(storage.values.size, 0)
  })

  test('clears the visual hint without depending on storage availability', () => {
    const storage = new MemoryStorage()
    saveProfileHint({ id: 'user-2', name: '芽衣', avatar: '' }, storage)
    clearProfileHint(storage)
    assert.equal(profileHint.value, null)
    assert.equal(storage.values.size, 0)
  })
})
