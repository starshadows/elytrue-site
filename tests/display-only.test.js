import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleApiRequest, API_ROUTE_HANDLERS } from '../server/app.js'
import { API_ROUTES } from '../server/routes/registry.js'

function request(path, method = 'GET') {
  return handleApiRequest({
    request: new Request(`https://elytrue.com/api/${path}`, { method }),
  })
}

test('display-only API exports health probes and no interactive handlers', () => {
  assert.deepEqual(Object.keys(API_ROUTE_HANDLERS), ['health'])
  assert.deepEqual(
    API_ROUTES.map((route) => `${route.methods.join(',')} ${route.match.path}`),
    ['GET ', 'GET health'],
  )
})

test('health reports display-only mode', async () => {
  const response = await request('health')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.status, 'ok')
  assert.equal(body.data.mode, 'display-only')
})

test('former account, message, upload, and admin routes return 404', async () => {
  for (const [method, path] of [
    ['POST', 'user/register'],
    ['POST', 'user/login'],
    ['GET', 'user/me'],
    ['GET', 'comments'],
    ['GET', 'comments/public'],
    ['POST', 'comments/post'],
    ['POST', 'comments/like'],
    ['POST', 'uploads/image'],
    ['GET', 'data/images/avatars/example.png'],
    ['POST', 'admin/bootstrap'],
  ]) {
    const response = await request(path, method)
    assert.equal(response.status, 404, `${method} /api/${path}`)
  }
})
