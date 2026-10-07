import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildCdn } from '../../scripts/build-cdn.mjs';
import { performanceFixture } from '../_performance.mjs';

// A story saved as a video in a real browser: the ⋯ menu, a whole take of a
// four-second performance, and the mp4 the save hands over. Recording runs in
// real time, so the fixture is the shortest performance the suite has.

let server;
let base;
let dir;
const NARRATION = Buffer.from(
  fs.readFileSync(new URL('./fixtures/media/narration.wav.b64', import.meta.url), 'utf8'),
  'base64',
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100" height="100" fill="#62a555"/><rect x="100" width="100" height="100" fill="#3d74bb"/></svg>';

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-export-'));
  await buildCdn({ commit: 'ffffffffffffffffffffffffffffffffffffffff', outfile: path.join(dir, 'player.js') });
  const story = performanceFixture();
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/player.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(dir, 'player.js')));
    } else if (req.url === '/story.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(story));
    } else if (req.url.endsWith('.m4a') || req.url.endsWith('.wav')) {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(NARRATION);
    } else if (/\.(png|webp|svg)$/.test(req.url)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(SVG);
    } else if (req.url.endsWith('.webm')) {
      res.statusCode = 404;
      res.end();
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><div id="player" style="width:640px"></div><script src="/player.js"></script><script>window.ready=fetch("/story.json").then(r=>r.json()).then(story=>{window.player=FabroStoryPlayer.createStoryPlayer(document.querySelector("#player"),{story,assetBase:location.origin});return player.ready;});</script>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the ⋯ menu records the whole story and saves it as an mp4 with picture and sound', async ({ page }) => {
  test.setTimeout(40_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  expect(await page.evaluate(() => window.player.canRecordVideo())).toBe(true);
  await page.getByRole('button', { name: 'begin story' }).click();
  await page.locator('#player').hover();
  await page.getByRole('button', { name: 'more options' }).click();
  await expect(page.getByRole('button', { name: 'show subtitles' })
    .or(page.getByRole('button', { name: 'hide subtitles' }))).toBeVisible();
  await page.getByRole('button', { name: 'save video' }).click();

  const status = page.locator('#player .recording-status');
  await expect(status).toContainText('saving video');
  // Seeking is locked for the length of the take.
  expect(await page.evaluate(() => {
    const root = document.querySelector('#player').shadowRoot;
    return [root.querySelector('.skip-back').disabled, root.querySelector('.scrub').getAttribute('aria-disabled')];
  })).toEqual([true, 'true']);
  await expect(status).toContainText('video ready', { timeout: 20_000 });

  const downloading = page.waitForEvent('download');
  await status.getByRole('button', { name: 'save video' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('A shared performance.mp4');
  const file = path.join(dir, 'saved.mp4');
  await download.saveAs(file);
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  // One video track and one sound track, by their handler types.
  expect(bytes.includes(Buffer.from('vide'))).toBe(true);
  expect(bytes.includes(Buffer.from('soun'))).toBe(true);
  await expect(status).toBeHidden();

  // After the take the player is the player again: seeking works.
  expect(await page.evaluate(() => {
    const root = document.querySelector('#player').shadowRoot;
    return [root.querySelector('.skip-back').disabled, root.querySelector('.scrub').getAttribute('aria-disabled')];
  })).toEqual([false, 'false']);
  const state = await page.evaluate(() => window.player.getState());
  expect(state.ended).toBe(true);
});

test('a host keeps the file itself, and a cancelled take hands over nothing', async ({ page }) => {
  test.setTimeout(40_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  // The host's own button: the press is what lets the recording's sound start.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.textContent = 'record';
    button.onclick = () => {
      window.take = window.player.recordVideo().then(
        (file) => ({ name: file.name, type: file.type, size: file.size }),
        (error) => ({ error: error.name }),
      );
    };
    document.body.append(button);
  });
  await page.getByRole('button', { name: 'record' }).click();
  await page.waitForFunction(() => window.player.getState()?.tMs > 500);
  await page.locator('#player .recording-status').getByRole('button', { name: 'cancel' }).click();
  expect(await page.evaluate(() => window.take)).toEqual({ error: 'AbortError' });
  await expect(page.locator('#player .recording-status')).toBeHidden();
  const paused = await page.evaluate(() => window.player.getState());
  expect(paused.playing).toBe(false);
  expect(paused.ended).toBe(false);

  await page.getByRole('button', { name: 'record' }).click();
  const kept = await page.evaluate(() => window.take);
  expect(kept.name).toBe('A shared performance.mp4');
  expect(kept.type).toBe('video/mp4');
  expect(kept.size).toBeGreaterThan(1000);
  // The host keeps it: nothing is offered on the picture.
  await expect(page.locator('#player .recording-status')).toBeHidden();
});

test('a lesson in an illustrated world records its storybook narration, and a plate story is refused', async ({ page }) => {
  test.setTimeout(40_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  const refusedPlate = await page.evaluate(async () => {
    window.player.destroy();
    const host = document.querySelector('#player');
    const story = lesson();
    const plain = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase: location.origin });
    await plain.ready;
    const refused = plain.canRecordVideo();
    plain.destroy();
    window.player = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase: location.origin, board: {
      layout: 'lesson-guide', guide: 'helper', world: {
        background: 'garden', board: { style: 'garden', panel: [0.1, 0.4, 0.8, 0.44] }, actor_box: [0.82, 0.94, 0.4],
        phases: [
          { id: 'outdoors', start_ms: 0, end_ms: 1000, mode: 'world', props: [] },
          { id: 'teaching', start_ms: 1000, end_ms: 4000, mode: 'lesson', props: [] },
        ],
      },
    } });
    await window.player.ready;
    const button = document.createElement('button');
    button.textContent = 'record';
    button.onclick = () => {
      window.take = window.player.recordVideo().then(async (file) => {
        // The file's own sound, decoded: a take that recorded silence fails here.
        const samples = (await new AudioContext().decodeAudioData(await file.arrayBuffer())).getChannelData(0);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        return { name: file.name, peak };
      }, (error) => ({ error: error.message }));
    };
    document.body.append(button);
    return refused;

    function lesson() {
      const svg = 'fairytale-assets/media/world.svg';
      return {
        storylang_version: 0, title: 'A garden lesson',
        cast: { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
          clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } },
        objects: Object.fromEntries(['garden', 'one', 'two'].map((slug) => [slug, { svg, height_cm: 30 }])),
        audio: { sfx: {}, bgm: {} },
        scenes: [{ place: 'garden', plate: { poster: svg, video: 'fairytale-assets/media/plate.webm' }, steps: [
          { kind: 'cmd', cmd: 'put', subjects: ['helper'] },
          { kind: 'chunk', line: 1, text: 'Look at the garden.', duration_s: 1, audio: 'jobs/e2e/audio/line.wav' },
          { kind: 'cmd', cmd: 'board', cards: ['one', 'two'], subjects: [], prompt: '' },
          { kind: 'cmd', cmd: 'pause', seconds: 2 },
        ] }],
      };
    }
  });
  expect(refusedPlate).toBe(false);
  expect(await page.evaluate(() => window.player.canRecordVideo())).toBe(true);
  await page.getByRole('button', { name: 'record' }).click();
  const kept = await page.evaluate(() => window.take);
  expect(kept.name).toBe('A garden lesson.mp4');
  // The narration fixture peaks near 0.03 of full scale.
  expect(kept.peak).toBeGreaterThan(0.01);
});
