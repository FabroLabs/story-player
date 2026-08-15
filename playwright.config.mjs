import os from 'node:os';
import path from 'node:path';

export default {
  expect: { timeout: 5_000 },
  fullyParallel: false,
  outputDir: path.join(os.tmpdir(), 'story-player-playwright-results'),
  reporter: 'line',
  testDir: './tests/e2e',
  timeout: 20_000,
  use: {
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
  workers: 1,
};
