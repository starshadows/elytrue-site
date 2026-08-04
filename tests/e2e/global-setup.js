/**
 * 每次 E2E 运行前重置 mock server 的内存存储与限流计数,
 * 避免跨运行的 /__test/reset 依赖(webServer 已在本钩子前启动)。
 */
export default async function globalSetup() {
  await fetch('http://127.0.0.1:4173/__test/reset', { method: 'POST' }).catch(
    () => undefined,
  )
}
