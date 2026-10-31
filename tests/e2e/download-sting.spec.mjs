import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildCdn } from '../../scripts/build-cdn.mjs';
import { performanceFixture } from '../_performance.mjs';

// A saved video in a real browser opens on the sting's intro and closes on its
// outro, decoded and encoded by the browser itself. The films here are a red
// half second with a 440 Hz tone and a blue quarter second with an 880 Hz one.

let server;
let base;
let dir;
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/media/${name}`, import.meta.url));
const NARRATION = Buffer.from(fs.readFileSync(new URL('./fixtures/media/narration.wav.b64', import.meta.url), 'utf8'), 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#62a555"/></svg>';
const STING = '/fairytale-assets/brand/sting/v1/';

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-sting-'));
  await buildCdn({ commit: 'ffffffffffffffffffffffffffffffffffffffff', outfile: path.join(dir, 'player.js') });
  const story = performanceFixture();
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sting = req.url.startsWith(STING) ? req.url.slice(STING.length) : null;
    if (req.url === '/player.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(fs.readFileSync(path.join(dir, 'player.js')));
    } else if (req.url === '/story.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(story));
    } else if (sting) {
      // Both shapes get the same films: the frame is fitted to the take either way.
      const [part, kind] = [sting.startsWith('intro') ? 'intro' : 'outro', sting.endsWith('.m4a') ? 'm4a' : 'mp4'];
      res.setHeader('Content-Type', kind === 'm4a' ? 'audio/mp4' : 'video/mp4');
      res.end(fixture(`sting-${part}.${kind}`));
    } else if (req.url.endsWith('.m4a') || req.url.endsWith('.wav')) {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(NARRATION);
    } else if (/\.(png|webp|svg)$/.test(req.url)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(SVG);
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

for (const format of ['16:9', '9:16']) test(`a ${format} download opens on the sting's intro and closes on its outro`, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  const stepped = await page.evaluate(() => typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoDecoder === 'function');
  test.skip(!stepped, 'this browser cannot step a take, and a filmed take has no sting');
  const result = await page.evaluate(async (format) => {
    const file = await window.player.recordVideo({ resolution: 720, format });
    const url = URL.createObjectURL(file);
    const video = Object.assign(document.createElement('video'), { muted: true, src: url });
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    const canvas = Object.assign(document.createElement('canvas'), { width: video.videoWidth, height: video.videoHeight });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    /** The picture's average colour at `seconds`. */
    const colourAt = async (seconds) => {
      const sought = new Promise((resolve) => { video.onseeked = resolve; });
      video.currentTime = seconds;
      await sought;
      context.drawImage(video, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const sum = [0, 0, 0];
      for (let at = 0; at < data.length; at += 4) for (let c = 0; c < 3; c += 1) sum[c] += data[at + c];
      return sum.map((value) => Math.round(value / (data.length / 4)));
    };
    const samples = (await new AudioContext().decodeAudioData(await file.arrayBuffer())).getChannelData(0);
    /** How many times the sound crosses zero in a second, from `from` to `to` seconds. */
    const pitch = (from, to) => {
      let crossings = 0;
      for (let n = Math.round(from * 48000) + 1; n < to * 48000; n += 1) if ((samples[n - 1] < 0) !== (samples[n] < 0)) crossings += 1;
      return crossings / 2 / (to - from);
    };
    const result = {
      width: video.videoWidth, height: video.videoHeight, duration: video.duration,
      first: await colourAt(0.2), middle: await colourAt(2), last: await colourAt(video.duration - 0.1),
      introPitch: pitch(0.05, 0.45),
    };
    URL.revokeObjectURL(url);
    return result;
  }, format);
  await testInfo.attach(`${format.replace(':', 'x')}-result`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect([result.width, result.height]).toEqual(format === '9:16' ? [720, 1280] : [1280, 720]);
  // The story and the second its last word is given, plus half a second before and a quarter after.
  expect(result.duration).toBeGreaterThan(3.8 + 0.75);
  expect(result.duration).toBeLessThan(6 + 0.75);
  const [r, g, b] = result.first;
  expect(r).toBeGreaterThan(150);
  expect(Math.max(g, b)).toBeLessThan(80);
  const [r2, g2, b2] = result.last;
  expect(b2).toBeGreaterThan(150);
  expect(Math.max(r2, g2)).toBeLessThan(100);
  expect(result.middle).not.toEqual(result.first);
  expect(Math.abs(result.introPitch - 440)).toBeLessThan(25);
});
