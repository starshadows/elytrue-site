import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: 'tests/e2e',
    timeout: 30 * 1000,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:4173',
        headless: true,
        locale: 'zh-CN',
        viewport: { width: 1280, height: 800 },
        actionTimeout: 15 * 1000,
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npm run mock:server',
        port: 4173,
        reuseExistingServer: true,
        timeout: 60 * 1000,
    },
})
