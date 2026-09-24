import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    viewport: { width: 1440, height: 1100 },
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command:
        '../backend/.venv/bin/uvicorn tests.browser_server:app --app-dir ../backend --host 127.0.0.1 --port 8174 --ws-max-size 4096 --ws-max-queue 8',
      url: 'http://127.0.0.1:8174/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run build && npm run preview -- --port 5174',
      env: { API_PROXY_TARGET: 'http://127.0.0.1:8174' },
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: false,
    },
  ],
});
