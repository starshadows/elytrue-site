import assert from 'node:assert/strict'
import { test } from 'node:test'
import viteConfig from '../../vite.config'

test('Vite development server never accepts arbitrary hosts', () => {
  assert.equal(typeof viteConfig, 'object')
  if (typeof viteConfig !== 'object') return
  assert.notEqual(viteConfig.server?.allowedHosts, true)
  assert.deepEqual(viteConfig.server?.allowedHosts, ['localhost', '127.0.0.1'])
})
