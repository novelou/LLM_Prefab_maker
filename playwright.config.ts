import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
});
