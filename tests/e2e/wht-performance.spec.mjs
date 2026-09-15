import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildCdn } from '../../scripts/build-cdn.mjs';
import { allCapabilitiesFixture } from '../_all-performance.mjs';
import { compileTimeline } from '../../browser/v0/core/timeline/compile.mjs';
let server, base, dir;
const requests = [];
test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wht-browser-'));
  await buildCdn({
    commit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    outfile: path.join(dir, 'player.js'),
  });
  const story = allCapabilitiesFixture();
  story.instructions = compileTimeline(story);
  server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/player.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(dir, 'player.js')));
    } else if (req.url === '/story.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(story));
    } else if (req.url.endsWith('.m4a')) {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(
        Buffer.from(
          fs.readFileSync(
            new URL('./fixtures/media/narration.wav.b64', import.meta.url),
            'utf8',
          ),
          'base64',
        ),
      );
    } else if (req.url.endsWith('.png') || req.url.endsWith('.webp')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100" height="100" fill="#62a555"/><rect x="100" width="100" height="100" fill="#3d74bb"/></svg>',
      );
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<div id="player"></div><script src="/player.js"></script><script>window.ready=fetch("/story.json").then(r=>r.json()).then(story=>{window.story=story;window.player=FabroStoryPlayer.createStoryPlayer(document.querySelector("#player"),{story,assetBase:location.origin});return player.ready;});</script>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('one complete WHT JSON mounts, draws effects, plays to the end and replays', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.evaluate(() => window.ready);
  await expect(page.locator('.start-button')).toBeEnabled();
  await page.locator('.start-button').click();
  await expect(page.locator('.start-ceremony')).toHaveCSS('opacity', '0');
  await expect(page.locator('.subtitle')).toContainText('Hi Sam');
  await expect
    .poll(() =>
      page.locator('canvas').evaluateAll((canvases) =>
        canvases.some((c) => {
          const p = c
            .getContext('2d')
            .getImageData(0, 0, c.width, c.height).data;
          return p.some((v, i) => i % 4 === 3 && v > 0);
        }),
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: path.join(os.tmpdir(), 'wht-browser-frame.png'),
  });
  await expect(page.locator('.end-overlay')).toBeVisible({ timeout: 10000 });
  expect(errors).toEqual([]);
  expect(requests.filter((p) => p === '/story.json')).toHaveLength(1);
  expect(requests.some((p) => p.includes('/hero.webp'))).toBe(true);
  expect(requests.some((p) => p.includes('/line.m4a'))).toBe(true);
  await page.locator('.is-replay').click();
  await expect(page.locator('.subtitle')).toContainText('Hi Sam');
  expect(errors).toEqual([]);
});

test('host chrome uses one observable transport without empty video requests', async ({page}) => {
  const errors = [], emptyMedia = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.resourceType() === 'media' && new URL(request.url()).pathname === '/') emptyMedia.push(request.url()); });
  await page.goto(base);
  await page.evaluate(async () => {
    await window.ready;
    window.player.destroy();
    window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), {story: window.story, assetBase: location.origin, chrome: 'host'});
    await window.player.ready;
    window.observed = [];
    window.off = window.player.subscribe(state => window.observed.push(state));
  });
  await expect(page.locator('.start-ceremony')).toBeHidden();
  await expect(page.locator('.controls')).toBeHidden();
  await expect(page.locator('.plate-video')).toBeHidden();
  await page.evaluate(() => window.player.play());
  await expect.poll(() => page.evaluate(() => window.player.getState().tMs)).toBeGreaterThan(300);
  expect(await page.evaluate(() => window.player.getState().playing)).toBe(true);
  await page.evaluate(() => { window.player.pause(); window.player.seek(1500); window.player.setSubtitles(false); });
  expect(await page.evaluate(() => window.observed.at(-1).tMs)).toBe(1500);
  expect(await page.evaluate(() => window.player.getState().playing)).toBe(false);
  await expect(page.locator('.subtitle-wrap')).toBeHidden();
  await page.evaluate(() => window.player.seek(window.player.getTimeline().duration_ms));
  expect(await page.evaluate(() => window.observed.at(-1).ended)).toBe(true);
  await page.evaluate(() => window.player.toggle());
  await expect.poll(() => page.evaluate(() => window.player.getState().tMs)).toBeLessThan(1000);
  expect(await page.evaluate(() => window.player.getState().ended)).toBe(false);
  expect(emptyMedia).toEqual([]);
  expect(errors).toEqual([]);
  await page.evaluate(() => { window.off(); window.player.destroy(); });
});
