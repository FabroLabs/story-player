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
  const song = silentWav(4);
  server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/player.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(dir, 'player.js')));
    } else if (req.url === '/story.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(story));
    } else if (req.url === '/songs/abc-song.wav') {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), song.length - 1) : song.length - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${song.length}` });
        res.end();
      } else {
        if (range) res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${song.length}`,
          'Content-Length': end - start + 1 });
        else res.setHeader('Content-Length', song.length);
        res.end(song.subarray(start, end + 1));
      }
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
    } else if (req.url.endsWith('.webm')) {
      res.setHeader('Content-Type', 'video/webm');
      res.end(fs.readFileSync(new URL('./fixtures/media/plate.webm.txt', import.meta.url)));
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

for (const width of [1280, 390]) {
  test(`sung captions follow seeks and CC above the timeline at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.evaluate(async () => {
      await window.ready;
      window.player.destroy();
      const story = structuredClone(window.story);
      delete story.instructions;
      story.performance.required_capabilities.push('captions');
      story.captions = [
        { start_ms: 0, end_ms: 1000, text: 'A is for apple' },
        { start_ms: 2000, end_ms: 4000, text: 'B is for ball' },
      ];
      story.audio = [{ id: 'song', kind: 'music', media: 'songs/abc-song.wav',
        start_ms: 0, end_ms: 4000, duration_ms: 4000, volume: 1, loop: false }];
      const NativeAudio = window.Audio;
      window.songAudio = [];
      window.Audio = function (...args) {
        const audio = new NativeAudio(...args);
        window.songAudio.push(audio);
        return audio;
      };
      window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), {
        story, assetBase: location.origin,
      });
      await window.player.ready;
    });
    await page.locator('.start-button').click();
    await expect.poll(() => page.evaluate(() => window.player.getState().playing)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.songAudio[0]?.readyState ?? 0)).toBeGreaterThan(0);
    await page.evaluate(() => { window.player.pause(); window.player.seek(250); });
    await expect(page.locator('.subtitle')).toHaveText('A is for apple');
    await expect.poll(() => page.evaluate(() => window.songAudio[0].currentTime)).toBeCloseTo(0.25, 2);
    const subtitle = await page.locator('.subtitle').boundingBox();
    const scrub = await page.locator('.scrub').boundingBox();
    expect(subtitle.y + subtitle.height).toBeLessThan(scrub.y);
    await page.getByRole('button', { name: 'hide subtitles', exact: true }).click();
    await expect(page.locator('.subtitle-wrap')).toBeHidden();
    await page.evaluate(() => window.player.seek(2250));
    await page.getByRole('button', { name: 'show subtitles', exact: true }).click();
    await expect(page.locator('.subtitle')).toHaveText('B is for ball');
    await expect(page.locator('.subtitle-wrap')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.songAudio[0].currentTime)).toBeCloseTo(2.25, 2);
    expect(await page.evaluate(() => window.songAudio.map(audio => ({
      paused: audio.paused, volume: audio.volume, loop: audio.loop,
    })))).toEqual([{ paused: true, volume: 1, loop: false }]);
    await page.evaluate(() => window.player.play());
    await expect.poll(() => page.evaluate(() => window.songAudio[0].paused)).toBe(false);
    await page.evaluate(() => { window.player.pause(); window.player.seek(1000); });
    await expect(page.locator('.subtitle')).toHaveText('');
    await page.evaluate(() => window.player.seek(250));
    await expect(page.locator('.subtitle')).toHaveText('A is for apple');
    expect(errors).toEqual([]);
  });
}

function silentWav(seconds) {
  const sampleRate = 8000, dataBytes = seconds * sampleRate * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

for (const format of ['performance narration', 'native ABC']) {
  test(`${format} keeps readable captions above the phone timeline`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(base);
    await page.evaluate(async (format) => {
      await window.ready;
      window.player.destroy();
      const story = format === 'performance narration' ? window.story : {
        storylang_version: 0, title: 'ABC', cast: {},
        objects: Object.fromEntries(['a', 'apple'].map(slug => [slug,
          { svg: `fairytale-assets/${slug}.png`, height_cm: 30 }])),
        audio: { sfx: {}, bgm: {} },
        scenes: [{ place: 'forest', plate: {
          poster: 'fairytale-assets/forest.png', video: 'fairytale-assets/plate.webm',
        }, steps: [
          { kind: 'cmd', cmd: 'board', subjects: [], cards: ['a', 'apple'], focus: 1, prompt: 'A' },
          { kind: 'chunk', line: 1, text: 'A is for apple.', duration_s: 4, audio: 'songs/abc-song.wav' },
        ] }],
      };
      window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), {
        story, assetBase: location.origin,
      });
      await window.player.ready;
    }, format);
    await page.locator('.start-button').click();
    await expect.poll(() => page.evaluate(() => window.player.getState().playing)).toBe(true);
    await page.evaluate(() => { window.player.pause(); window.player.seek(250); });
    await expect(page.locator('.subtitle')).toHaveText(format === 'native ABC' ? 'A is for apple.' : 'Hi Sam');
    const subtitle = await page.locator('.subtitle').boundingBox();
    const frame = await page.locator('.stage-frame').boundingBox();
    const scrub = await page.locator('.scrub').boundingBox();
    expect(subtitle.y).toBeGreaterThanOrEqual(frame.y);
    expect(subtitle.y + subtitle.height).toBeLessThan(scrub.y);
  });
}
