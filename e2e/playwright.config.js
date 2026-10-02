// 规则工作台 E2E 验收测试配置
// 复用本机 Chrome（channel: 'chrome'），无需下载浏览器内核
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // 写操作测试串行执行，避免数据竞争
  globalSetup: './helpers/global-setup.js',
  globalTeardown: './helpers/global-teardown.js',
  use: {
    baseURL: 'http://127.0.0.1:5180',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    locale: 'zh-CN',
  },
  reporter: [
    ['list'],
    ['json', { outputFile: './output/playwright-report.json' }],
  ],
  outputDir: './output/test-results',
})
