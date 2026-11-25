import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'workbench.e2e.mjs',
  timeout: 75_000,
  workers: 1,
  reporter: 'line',
  outputDir: '../../test-results/codex',
  use: {
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
