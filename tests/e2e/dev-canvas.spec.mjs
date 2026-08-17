/**
 * The asset layer against the REAL bucket, in a real browser.
 *
 * Everything else about the asset layer is unit-tested with a fake fetch, and a
 * fake fetch cannot answer the two questions this phase actually turns on: does
 * the bucket serve these objects to a browser at all (CORS is an operator's
 * doing, not the player's), and does a mounted player ask for the renditions
 * rather than the 26–85 MB originals it used to.
 *
 * Dev-only on purpose. It needs a storage origin with the forest catalog in it,
 * so it never runs in CI:
 *
 *   STORY_PLAYER_DEV_HARNESS=1 RUSTFS_URL=http://<host>:<port> npm run test:e2e
 *
 * The story is `tests/fixtures/parity/golden_push_dusk.bundle.json` — the same
 * corpus the compiler and the state core are held to, already carrying
 * bucket-qualified renditions, and its sheets are real objects in that bucket.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCdn } from '../../scripts/build-cdn.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COMMIT = 'dddddddddddddddddddddddddddddddddddddddd';
const BUCKET = (process.env.RUSTFS_URL ?? '').replace(/\/+$/, '');
const STORY = 'tests/fixtures/parity/golden_push_dusk.bundle.json';
// Served straight off disk so the page can import the ESM modules as they are
// written, without a build step in the middle.
const SERVED = ['browser/', 'tooling/', 'tests/fixtures/parity/'];

let temporary;
let application;

test.skip(
  process.env.STORY_PLAYER_DEV_HARNESS !== '1' || !BUCKET,
  'dev harness: set STORY_PLAYER_DEV_HARNESS=1 and RUSTFS_URL to run against the real bucket',
);

test.beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-dev-'));
  await buildCdn({ commit: COMMIT, outfile: path.join(temporary, 'story-player.js') });
  application = await listen(handler);
});

test.afterAll(async () => {
  await close(application?.server);
  if (temporary) fs.rmSync(temporary, { force: true, recursive: true });
});

test('the mounted player opens its first scene on renditions alone', async ({ page }) => {
  const requests = [];
  const failures = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('requestfailed', (request) => failures.push(`${request.url()} — ${request.failure()?.errorText}`));

  await page.goto(`${application.url}/mount.html`);
  await page.evaluate(() => window.__ready);
  await expect(page.locator('.start-button')).toBeEnabled();

  const fromBucket = requests.filter((url) => url.startsWith(BUCKET));
  const sheets = fromBucket.filter((url) => url.includes('/sprites/'));

  expect(failures, 'a bucket request failed — CORS on the assets bucket is what this needs').toEqual([]);
  expect(fromBucket.length, 'the gate asked the bucket for nothing at all').toBeGreaterThan(0);
  expect(fromBucket.filter((url) => url.endsWith('spritesheet.png'))).toEqual([]);
  expect(sheets.length).toBeGreaterThan(0);
  for (const url of sheets) expect(url).toMatch(/\/mobile\/sprites\/[^/]+\.webp$/);
  expect(fromBucket.some((url) => url.includes('live_backgrounds_posters/'))).toBe(true);
});

test('every scene decodes inside the cache budget', async ({ page }) => {
  await page.goto(`${application.url}/scenes.html`);
  const report = await page.evaluate(() => window.__scenes);

  expect(report.failed, 'a sheet the bucket holds did not decode').toBe(0);
  expect(report.scenes.length).toBeGreaterThan(1);
  for (const scene of report.scenes) expect(scene.tiers.every((tier) => tier !== null)).toBe(true);
  // The cache is what holds the ceiling: whatever the story's total is, what is
  // resident must stay inside the budget it was built with.
  expect(report.cacheBytes).toBeLessThanOrEqual(report.budgetBytes);
  test.info().annotations.push({
    type: 'decoded',
    description: `${report.scenes.length} scenes, ${Math.round(report.cacheBytes / 1048576)} MB resident`,
  });
});

const MOUNT_PAGE = `<!doctype html>
<meta charset="utf-8"><title>dev canvas mount</title>
<div id="host"></div>
<script src="/story-player.js"></script>
<script>
  window.__ready = fetch('/${STORY}')
    .then((response) => response.json())
    .then((story) => FabroStoryPlayer.createStoryPlayer(document.querySelector('#host'), {
      story, assetBase: '__BUCKET__', debug: true,
    }).ready);
</script>`;

const SCENES_PAGE = `<!doctype html>
<meta charset="utf-8"><title>dev canvas scenes</title>
<script type="module">
  import { compileTimeline } from '/browser/v0/core/timeline/compile.mjs';
  import { resolveStoryAssets } from '/browser/v0/app/urls.mjs';
  import { createBitmapCache } from '/browser/v0/app/assets/bitmap-cache.mjs';
  import { createSceneLoader } from '/browser/v0/app/assets/scene-loader.mjs';

  // A promise, assigned before the first await: the page is loaded long before
  // the bucket has answered, and a test that read a plain object would read
  // \`undefined\` and call it a failure.
  window.__scenes = (async () => {
    const budgetBytes = 96 * 1024 * 1024;
    const raw = await (await fetch('/${STORY}')).json();
    const bundle = resolveStoryAssets(raw, '__BUCKET__');
    const timeline = compileTimeline(bundle);
    const cache = createBitmapCache({ budgetBytes });
    const loader = createSceneLoader({ timeline, bundle, cache });
    const viewport = { fitScale: 1, dpr: window.devicePixelRatio };
    const scenes = [];
    let failed = 0;

    for (let index = 0; index < bundle.scenes.length; index += 1) {
      const result = await loader.loadScene(index, viewport, { keep: true });
      failed += result.failed;
      scenes.push({ index, total: result.total, tiers: loader.plan(index, viewport).sheets.map((s) => s.tier) });
    }
    return { scenes, failed, cacheBytes: cache.bytes, budgetBytes };
  })();
</script>`;

function handler(request, response) {
  const url = new URL(request.url, 'http://harness.test');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/mount.html') return html(response, MOUNT_PAGE);
  if (pathname === '/scenes.html') return html(response, SCENES_PAGE);
  if (pathname === '/story-player.js') {
    return send(response, 200, fs.readFileSync(path.join(temporary, 'story-player.js')), 'text/javascript; charset=utf-8');
  }
  const relative = pathname.replace(/^\/+/, '');
  if (!SERVED.some((prefix) => relative.startsWith(prefix)) || relative.includes('..')) {
    return send(response, 404, Buffer.from('not found'), 'text/plain');
  }
  const target = path.join(ROOT, relative);
  if (!fs.existsSync(target)) return send(response, 404, Buffer.from('not found'), 'text/plain');
  return send(response, 200, fs.readFileSync(target), contentType(target));
}

function html(response, page) {
  return send(response, 200, Buffer.from(page.replaceAll('__BUCKET__', `${BUCKET}/`)), 'text/html; charset=utf-8');
}

function contentType(target) {
  if (target.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (target.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function send(response, status, body, type) {
  response.statusCode = status;
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Content-Type', type);
  response.end(body);
}

function listen(requestHandler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(requestHandler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
