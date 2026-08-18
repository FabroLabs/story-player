/**
 * The asset layer and the canvas stage against the REAL bucket, in a real
 * browser.
 *
 * Everything else about them is unit-tested against fakes, and a fake cannot
 * answer the three questions these phases actually turn on: does the bucket
 * serve these objects to a browser at all (CORS is an operator's doing, not the
 * player's), does a mounted player ask for the renditions rather than the
 * 26–85 MB originals it used to, and does a canvas that drew a cross-origin
 * sheet stay READABLE — a tainted canvas is the failure that no unit test can
 * see and that nothing recovers from.
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

test('the canvas draws the cast over the plate, and stays readable doing it', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.goto(`${application.url}/canvas.html`);
  const opened = await page.evaluate(() => window.__canvas.then((canvas) => canvas.open()));

  // `getImageData` on a canvas that drew a cross-origin image without CORS
  // throws a SecurityError, so a number here is the proof that the bucket's
  // headers reach the drawing path and not just the fetch.
  expect(opened.painted, 'the canvas is empty at an instant with a cast on it').toBeGreaterThan(0);
  expect(opened.actors).toBeGreaterThan(0);
  expect(opened.tiers.every((tier) => tier !== null), 'a sheet was drawn from the original PNG').toBe(true);
  expect(requests.filter((url) => url.endsWith('spritesheet.png'))).toEqual([]);
  // The plate is a DOM video UNDER the canvas: two compositor layers, no
  // per-frame copy of a 1920x1080 stream through the CPU.
  expect(opened.stacking).toEqual({
    plate: '0', canvas: '2', videoInPlate: true, canvasOverPlate: true,
  });
});

test('the DOM stage is gone, and nothing on the stage filters', async ({ page }) => {
  await page.goto(`${application.url}/canvas.html`);
  const shape = await page.evaluate(() => window.__canvas.then((canvas) => canvas.shape()));

  // The sprite divs, the layer they lived in, the camera layer they were
  // transformed by and the 26-second drift animation are all one thing now.
  expect(shape.legacy).toEqual([]);
  // A filter or a backdrop-filter anywhere on the stage is a full-frame blur
  // over a playing video on every paint — the cost the canvas rewrite exists
  // to stop paying.
  expect(shape.filtered).toEqual([]);
  expect(shape.canvasCount).toBe(1);
});

test('scrubbing moves the picture, and the loop holds its cadence', async ({ page }) => {
  await page.goto(`${application.url}/canvas.html`);
  const run = await page.evaluate(() => window.__canvas.then((canvas) => canvas.scrub()));

  // Two instants of the same walk are two different pictures; if they were not,
  // the loop would be drawing the same frame forever and nobody would notice.
  expect(run.before).not.toEqual(run.after);
  expect(run.failures, 'a draw threw during the scrub').toEqual([]);
  // 24 Hz for a second, with the tolerance a shared CI machine deserves.
  expect(run.drawn).toBeGreaterThanOrEqual(16);
  expect(run.drawn).toBeLessThanOrEqual(30);
  test.info().annotations.push({ type: 'cadence', description: `${run.drawn} draws in ${run.elapsed} ms` });
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

/**
 * The stage, driven by hand: a slider over the story's own clock, and the same
 * three modules the runtime will wire together in phase 8.
 *
 * It mounts the REAL template into a real open ShadowRoot, so what it measures
 * is the shipped DOM and the shipped stylesheet — a page that built its own
 * markup would prove nothing about either. The begin ceremony is dismissed
 * because there is no runtime to press it yet.
 */
const CANVAS_PAGE = `<!doctype html>
<meta charset="utf-8"><title>dev canvas stage</title>
<style>body { margin: 0; background: #05060f; } .scrub { width: 100%; }</style>
<div id="host"></div>
<input class="scrub" type="range" min="0" value="0" step="41" aria-label="story time">
<script type="module">
  import { createPlayerTemplate } from '/browser/template.mjs';
  import { createBitmapCache } from '/browser/v0/app/assets/bitmap-cache.mjs';
  import { createSceneLoader } from '/browser/v0/app/assets/scene-loader.mjs';
  import { createCanvasStage, sceneSheets } from '/browser/v0/app/stage/canvas-stage.mjs';
  import { createVideoPlate } from '/browser/v0/app/stage/video-plate.mjs';
  import { resolveStoryAssets } from '/browser/v0/app/urls.mjs';
  import { stateAt } from '/browser/v0/core/state/state.mjs';
  import { compileTimeline } from '/browser/v0/core/timeline/compile.mjs';

  window.__canvas = (async () => {
    const raw = await (await fetch('/${STORY}')).json();
    const bundle = resolveStoryAssets(raw, '__BUCKET__');
    const timeline = compileTimeline(bundle);
    const root = document.querySelector('#host').attachShadow({ mode: 'open' });
    const elements = createPlayerTemplate(root);
    elements.ceremony.classList.add('is-gone');
    const cache = createBitmapCache();
    const loader = createSceneLoader({ timeline, bundle, cache });
    const stage = createCanvasStage(elements.stage);
    const plate = createVideoPlate(elements.stage);
    const books = new Map();
    let scene = null;
    let drawn = 0;

    const viewport = () => ({ fitScale: stage.fitScale(), dpr: window.devicePixelRatio });
    const stageOps = timeline.events.filter((event) => event.source === 'stage');

    async function show(tMs) {
      const state = stateAt(timeline, bundle, tMs);
      if (state.sceneIndex !== scene) {
        scene = state.sceneIndex;
        const port = viewport();
        await loader.loadScene(scene, port, { keep: true });
        books.set(scene, sceneSheets(loader.plan(scene, port), cache));
        plate.showScene(state.plate);
        plate.play();
      }
      stage.draw(state, books.get(scene));
      plate.aim(state.camera);
      drawn += 1;
      return state;
    }

    const slider = document.querySelector('.scrub');
    slider.max = String(timeline.duration_ms);
    slider.addEventListener('input', () => show(Number(slider.value)));

    // The opening tableau: a millisecond after the last thing scene 0 puts on
    // the stage, so the whole cast is standing.
    const placed = stageOps.filter((event) => ['place', 'place_object'].includes(event.op) && event.scene_index === 0);
    const tableau = placed.length ? Math.max(...placed.map((event) => event.t_ms)) + 1 : 1;
    const walk = stageOps.find((event) => event.op === 'move' && event.duration_ms > 0);

    function signature() {
      const canvas = elements.stage.canvas;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let sum = 0;
      for (let at = 0; at < data.length; at += 4 * 389) sum = (sum + data[at] + (data[at + 3] * 7)) % 2147483647;
      return sum;
    }

    return {
      async open() {
        const state = await show(tableau);
        const canvas = elements.stage.canvas;
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        let painted = 0;
        for (let at = 3; at < data.length; at += 4 * 97) if (data[at] > 0) painted += 1;
        const style = (node) => getComputedStyle(node);
        return {
          painted,
          actors: state.actors.length,
          tiers: loader.plan(scene, viewport()).sheets.map((sheet) => sheet.tier),
          stacking: {
            plate: style(elements.stage.plate).zIndex,
            canvas: style(canvas).zIndex,
            videoInPlate: elements.stage.plate.contains(elements.stage.video),
            canvasOverPlate: Boolean(
              elements.stage.plate.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          },
        };
      },

      async shape() {
        await show(tableau);
        const legacy = ['.sprite', '.sprite-layer', '.camera-layer', '.drift-layer']
          .filter((selector) => root.querySelector(selector));
        const filtered = [...root.querySelectorAll('.stage-frame, .stage-frame *')]
          .filter((node) => {
            const style = getComputedStyle(node);
            const backdrop = style.backdropFilter ?? style.webkitBackdropFilter;
            return (style.filter && style.filter !== 'none') || (backdrop && backdrop !== 'none');
          })
          .map((node) => node.className || node.tagName.toLowerCase());
        return { legacy, filtered, canvasCount: root.querySelectorAll('canvas').length };
      },

      async scrub() {
        const from = walk ? walk.t_ms : tableau;
        const span = walk ? walk.duration_ms : 1000;
        await show(from);
        const before = signature();
        await show(from + Math.round(span / 2));
        const after = signature();

        drawn = 0;
        const failures = [];
        const started = performance.now();
        await new Promise((resolve) => {
          const step = () => {
            const elapsed = performance.now() - started;
            if (elapsed >= 1000) return resolve();
            // Carried, not floated: a draw that throws mid-scrub would
            // otherwise show up only as a low frame count, and the run would be
            // reported as a slow loop rather than as the broken picture it is.
            show(from + elapsed).catch((error) => failures.push(String(error)));
            return setTimeout(step, 1000 / 24);
          };
          step();
        });
        return { before, after, drawn, failures, elapsed: Math.round(performance.now() - started) };
      },
    };
  })();
</script>`;

function handler(request, response) {
  const url = new URL(request.url, 'http://harness.test');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/mount.html') return html(response, MOUNT_PAGE);
  if (pathname === '/scenes.html') return html(response, SCENES_PAGE);
  if (pathname === '/canvas.html') return html(response, CANVAS_PAGE);
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
  // A stylesheet served as anything but `text/css` is dropped by the browser in
  // standards mode, and the stage would then have no size at all to letterbox
  // into — every measurement this page takes would be of a collapsed box.
  if (target.endsWith('.css')) return 'text/css; charset=utf-8';
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
