import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConfigEnv, UserConfig } from 'vite'
import viteConfig from '../../vite.config'

function resolveConfig(command: ConfigEnv['command']): UserConfig {
  if (typeof viteConfig === 'function') {
    const result = viteConfig({
      command,
      mode: command === 'build' ? 'production' : 'development',
    })
    assert.equal(result instanceof Promise, false)
    return result as UserConfig
  }
  return viteConfig as UserConfig
}

test('Vite development server never accepts arbitrary hosts and serves public assets in dev', () => {
  const dev = resolveConfig('serve')
  const build = resolveConfig('build')

  assert.notEqual(dev.server?.allowedHosts, true)
  assert.deepEqual(dev.server?.allowedHosts, ['localhost', '127.0.0.1'])
  assert.equal(dev.publicDir, 'public')
  assert.equal(build.publicDir, false)
})
