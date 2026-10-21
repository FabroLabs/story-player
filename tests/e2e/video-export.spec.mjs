import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildCdn } from '../../scripts/build-cdn.mjs';
import { performanceFixture } from '../_performance.mjs';

// A story saved as a video in a real browser: the settings menu, a whole take of a
// four-second performance, and the mp4 the save hands over. Recording runs in
// real time, so the fixture is the shortest performance the suite has.

let server;
let base;
let dir;
const NARRATION = Buffer.from(
  fs.readFileSync(new URL('./fixtures/media/narration.wav.b64', import.meta.url), 'utf8'),
  'base64',
);
// A 500 ms stereo AAC tone: left 720 Hz at 0.3, right 1280 Hz at 0.2.
// Generated with FFmpeg aevalsrc, 48 kHz AAC-LC at 192 kbit/s.
const LOOP_TONE = Buffer.from(fs.readFileSync(new URL('./fixtures/media/loop-tone.m4a.b64', import.meta.url), 'utf8'), 'base64');
const LOOP_TONE_44100 = Buffer.from(fs.readFileSync(new URL('./fixtures/media/loop-tone-44100.m4a.b64', import.meta.url), 'utf8'), 'base64');
// A distinct 1 kHz narration tone lasts three seconds, overlapping six loops.
const LONG_NARRATION = Buffer.alloc(44 + 48000 * 3 * 2);
LONG_NARRATION.write('RIFF', 0); LONG_NARRATION.writeUInt32LE(LONG_NARRATION.length - 8, 4);
LONG_NARRATION.write('WAVEfmt ', 8); LONG_NARRATION.writeUInt32LE(16, 16);
LONG_NARRATION.writeUInt16LE(1, 20); LONG_NARRATION.writeUInt16LE(1, 22);
LONG_NARRATION.writeUInt32LE(48000, 24); LONG_NARRATION.writeUInt32LE(96000, 28);
LONG_NARRATION.writeUInt16LE(2, 32); LONG_NARRATION.writeUInt16LE(16, 34);
LONG_NARRATION.write('data', 36); LONG_NARRATION.writeUInt32LE(LONG_NARRATION.length - 44, 40);
for (let n = 0; n < 48000 * 3; n++) LONG_NARRATION.writeInt16LE(Math.round(0.08 * 32767 * Math.sin(2 * Math.PI * 1000 * n / 48000)), 44 + n * 2);
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
    } else if (req.url === '/fairytale-assets/loop-tone.m4a' || req.url === '/fairytale-assets/streamed-loop-tone.m4a' || req.url === '/fairytale-assets/streamed-loop-tone-44100.m4a') {
      res.setHeader('Content-Type', 'audio/mp4');
      // An inert trailing box selects the bounded AAC reader without needing a
      // multi-minute fixture. Existing sample offsets and audio stay identical.
      const padding = Buffer.alloc(req.url.includes('/streamed-') ? 2 * 1024 * 1024 + 8 : 8);
      padding.writeUInt32BE(padding.length, 0); padding.write('free', 4);
      res.end(Buffer.concat([req.url.includes('44100') ? LOOP_TONE_44100 : LOOP_TONE, padding]));
    } else if (req.url === '/fairytale-assets/long-narration.wav') {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(LONG_NARRATION);
    } else if (req.url.endsWith('.m4a') || req.url.endsWith('.wav')) {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(NARRATION);
    } else if (/\.(png|webp|svg)$/.test(req.url)) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(SVG);
    } else if (req.url.endsWith('.webm')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.end(fs.readFileSync(new URL('./fixtures/media/plate-export.mp4', import.meta.url)));
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

test('the settings menu records the whole story and saves it as an mp4 with picture and sound', async ({ page }, testInfo) => {
  test.setTimeout(40_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  expect(await page.evaluate(() => window.player.canRecordVideo())).toBe(true);
  // A browser that cannot encode a story itself, so that the take is filmed
  // and lasts as long as the story: long enough to look at while it runs. The
  // stepped take has its own test below.
  await page.evaluate(() => { window.VideoEncoder = undefined; });
  await page.getByRole('button', { name: 'begin story' }).click();
  await page.locator('#player').hover();
  await page.getByRole('button', { name: 'settings' }).click();
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
  const file = testInfo.outputPath('saved.mp4');
  await download.saveAs(file);
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  // One video track and one sound track, by their handler types.
  expect(bytes.includes(Buffer.from('vide'))).toBe(true);
  expect(bytes.includes(Buffer.from('soun'))).toBe(true);
  await testInfo.attach('saved-story', { path: file, contentType: 'video/mp4' });
  const decoded = await inspectFile(page, bytes);
  expect(decoded.width).toBe(1920);
  expect(decoded.height).toBe(1080);
  expect(decoded.duration).toBeGreaterThan(3.8);
  expect(decoded.duration).toBeLessThan(6);
  expect(decoded.brandPixels).toBeGreaterThan(500);
  expect(decoded.captionPixels).toBeGreaterThan(40);
  expect(decoded.audioPeak).toBeGreaterThan(0.01);
  await testInfo.attach('decoded-frame', { body: Buffer.from(decoded.frame, 'base64'), contentType: 'image/png' });
  await expect(status).toBeHidden();

  // After the take the player is the player again: seeking works.
  expect(await page.evaluate(() => {
    const root = document.querySelector('#player').shadowRoot;
    return [root.querySelector('.skip-back').disabled, root.querySelector('.scrub').getAttribute('aria-disabled')];
  })).toEqual([false, 'false']);
  const state = await page.evaluate(() => window.player.getState());
  expect(state.ended).toBe(false);
  expect(state.playing).toBe(false);
  expect(state.tMs).toBeLessThan(1000);
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
      // Filmed, so that there is a take to stop: a stepped one is over in a moment.
      window.take = window.player.recordVideo({ mode: 'filmed' }).then(
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

test('Full HD is rendered at 1920×1080 for stepped, filmed and streamed takes', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  // The host's own button: the press is what lets a filmed take's sound start.
  await page.evaluate(() => {
    const encode = async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text = '';
      for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return btoa(text);
    };
    // `streamed` is a host that keeps the file itself, a piece at a time.
    for (const mode of ['auto', 'filmed', 'streamed']) {
      const button = document.createElement('button');
      button.textContent = `record ${mode}`;
      button.onclick = () => {
        const seen = [];
        const pieces = [];
        const started = performance.now();
        const options = mode === 'streamed'
          ? { onChunk: async (piece, index) => { pieces[index] = piece; await new Promise((resolve) => { setTimeout(resolve, 1); }); } }
          : { mode };
        window.take = window.player.recordVideo({ ...options, resolution: 1080, onProgress: (state) => seen.push(state) }).then(async (file) => ({
          fast: seen.some((state) => state.fast === true), statuses: [...new Set(seen.map((state) => state.status))],
          tookMs: performance.now() - started, size: file.size, pieces: pieces.length, largest: Math.max(0, ...pieces.map((piece) => piece.size)),
          base64: await encode(mode === 'streamed' ? new Blob(pieces) : file),
        }));
      };
      document.body.append(button);
    }
  });
  const stepped = await page.evaluate(() => typeof globalThis.VideoEncoder === 'function' && typeof globalThis.AudioEncoder === 'function');
  const takes = {};
  for (const mode of ['auto', 'filmed', 'streamed']) {
    await page.getByRole('button', { name: `record ${mode}` }).click();
    const take = await page.evaluate(() => window.take);
    const bytes = Buffer.from(take.base64, 'base64');
    await testInfo.attach(`${mode}-take`, { body: bytes, contentType: 'video/mp4' });
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    const decoded = await inspectFile(page, bytes);
    expect(decoded.width).toBe(1920);
    expect(decoded.height).toBe(1080);
    // The story and the second its last word is given to finish.
    expect(decoded.duration).toBeGreaterThan(3.8);
    expect(decoded.duration).toBeLessThan(6);
    expect(decoded.brandPixels).toBeGreaterThan(500);
    expect(decoded.captionPixels).toBeGreaterThan(40);
    expect(decoded.audioPeak).toBeGreaterThan(0.01);
    expect(take.statuses).toContain('ready');
    takes[mode] = take;
    // The player is the player again between takes.
    expect((await page.evaluate(() => window.player.getState())).playing).toBe(false);
  }
  // A host that keeps the file is handed all of it, in order, in bounded pieces.
  expect(Buffer.from(takes.streamed.base64, 'base64').length).toBe(takes.streamed.size);
  expect(takes.streamed.pieces).toBeGreaterThan(0);
  expect(takes.streamed.largest).toBeLessThanOrEqual(512 * 1024);
  expect(takes.streamed.fast).toBe(stepped);
  expect(takes.filmed.fast).toBe(false);
  expect(takes.filmed.tookMs).toBeGreaterThan(3800);
  // Chromium can encode a story itself, so here the take is stepped — and a
  // stepped take does not last as long as the story does.
  expect(takes.auto.fast).toBe(stepped);
  if (stepped) expect(takes.auto.tookMs).toBeLessThan(takes.filmed.tookMs);
});

for (const {name, streamed, mixed = false, opusOnly = false} of [
  {name: 'decoded AAC', streamed: false}, {name: 'streamed AAC', streamed: true},
  {name: 'mixed audio rates', streamed: true, mixed: true},
  {name: 'mixed audio rates with Opus', streamed: true, mixed: true, opusOnly: true},
]) test(`performance loops keep picture and sound in a 60 fps export (${name})`, async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  await page.evaluate(async ({streamed, mixed, opusOnly}) => {
    if (opusOnly) {
      const supported = AudioEncoder.isConfigSupported.bind(AudioEncoder);
      AudioEncoder.isConfigSupported = config => config.codec === 'mp4a.40.2'
        ? Promise.resolve({supported: false, config}) : supported(config);
    }
    const story = await (await fetch('/story.json')).json();
    story.audio[0].media = 'fairytale-assets/long-narration.wav';
    story.audio.push({ id: 'music', kind: 'music', media: mixed ? 'fairytale-assets/streamed-loop-tone-44100.m4a' : streamed ? 'fairytale-assets/streamed-loop-tone.m4a' : 'fairytale-assets/loop-tone.m4a',
      start_ms: 250, end_ms: 3500, duration_ms: 500, loop: true, volume: 0.5, gain_keys: [[1500, 0.25]] });
    if (mixed) story.audio.push({id: 'ambience', kind: 'ambience', media: 'fairytale-assets/streamed-loop-tone.m4a',
      start_ms: 250, end_ms: 3500, duration_ms: 500, loop: true, volume: 0.25, gain_keys: [[1500, 0.125]]});
    window.player.destroy();
    window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), { story, assetBase: location.origin });
    await window.player.ready;
    const button = document.createElement('button');
    button.textContent = 'record loop';
    button.onclick = () => {
      const progress = [];
      window.take = window.player.recordVideo({ resolution: 1080, onProgress: state => progress.push(state) }).then(async file => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const context = new AudioContext();
        const audio = await context.decodeAudioData(bytes.buffer.slice(0));
        const amplitude = (channel, frequency, seconds) => {
          const pcm = audio.getChannelData(channel), rate = audio.sampleRate;
          const from = Math.round(seconds * rate), count = Math.round(0.08 * rate);
          let real = 0, imaginary = 0;
          for (let n = 0; n < count; n++) {
            const phase = 2 * Math.PI * frequency * n / rate;
            real += pcm[from + n] * Math.cos(phase); imaginary += pcm[from + n] * Math.sin(phase);
          }
          return 2 * Math.hypot(real, imaginary) / count;
        };
        const levels = [0.8, 1.3, 1.8, 2.3, 2.8, 3.3, 3.7].map(t => [amplitude(0, 720, t), amplitude(1, 1280, t)]);
        // These 80 ms windows straddle each 500 ms loop boundary.
        const joins = [0.73, 1.23, 1.73, 2.23, 2.73, 3.23].map(t => [amplitude(0, 720, t), amplitude(1, 1280, t)]);
        const narration = [0.8, 1.3, 1.8, 2.3, 2.8].map(t => amplitude(0, 1000, t));
        await context.close();
        return { base64: btoa(text), fast: progress.findLast(state => state.status === 'ready')?.fast === true, levels, joins, narration };
      });
    };
    document.body.append(button);
  }, {streamed, mixed, opusOnly});
  await page.getByRole('button', { name: 'record loop', exact: true }).click();
  const take = await page.evaluate(() => window.take);
  await testInfo.attach('loop-levels', { body: JSON.stringify({ levels: take.levels, joins: take.joins, narration: take.narration }), contentType: 'application/json' });
  expect(take.fast, 'looping music must not force realtime capture').toBe(true);
  const bytes = Buffer.from(take.base64, 'base64');
  const saved = testInfo.outputPath('looping-performance.mp4');
  fs.writeFileSync(saved, bytes);
  await testInfo.attach('looping-performance', { path: saved, contentType: 'video/mp4' });
  const decoded = await inspectFile(page, bytes);
  expect([decoded.width, decoded.height]).toEqual([1920, 1080]);
  expect(decoded.captionPixels).toBeGreaterThan(40);
  expect(decoded.colorPixels).toBeGreaterThan(1000);
  for (const level of take.narration) {
    expect(level).toBeGreaterThan(0.06);
    expect(level).toBeLessThan(0.10);
  }
  for (const [i, [left, right]] of take.joins.entries()) {
    const scale = (i < 2 ? 0.5 : 0.25) * (mixed ? 1.5 : 1);
    expect(left).toBeGreaterThan(0.3 * scale * 0.75);
    expect(left).toBeLessThan(0.3 * scale * 1.25);
    expect(right).toBeGreaterThan(0.2 * scale * 0.75);
    expect(right).toBeLessThan(0.2 * scale * 1.25);
  }
  for (const [i, [left, right]] of take.levels.entries()) {
    const scale = (i < 2 ? 0.5 : i < 6 ? 0.25 : 0) * (mixed ? 1.5 : 1);
    for (const [actual, expected] of [[left, 0.3 * scale], [right, 0.2 * scale]]) {
      if (scale === 0) expect(actual).toBeLessThan(0.005);
      else {
        expect(actual).toBeGreaterThan(expected * 0.75);
        expect(actual).toBeLessThan(expected * 1.25);
      }
    }
  }
});

test('a stepped export submits 60 distinct motion frames per second without cadence gaps', async ({ page }, testInfo) => {
  test.setTimeout(40_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  const result = await page.evaluate(async () => {
    // Observe the real encoder without replacing its work. A skipped render
    // used to submit the previous picture with a fresh output timestamp.
    const story = await (await fetch('/story.json')).json();
    story.assets.hero = { type: 'image', media: 'fairytale-assets/hero.webp', width: 200, height: 100 };
    story.scenes[0].nodes = [{ id: 'hero', asset: 'hero', x: 100, y: 250, height: 100,
      path: { start_ms: 0, end_ms: 4000, from: [100, 250], to: [800, 250], easing: 'linear' } }];
    player.destroy();
    window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), { story, assetBase: location.origin });
    await player.ready;
    const submitted = [];
    const positions = [];
    const sample = new OffscreenCanvas(960, 540).getContext('2d', { willReadFrequently: true });
    const encode = VideoEncoder.prototype.encode;
    VideoEncoder.prototype.encode = function (frame, options) {
      submitted.push(frame.timestamp);
      sample.drawImage(frame, 0, 0, 960, 540);
      const pixels = sample.getImageData(0, 120, 960, 150).data;
      let sum = 0, count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 1] > pixels[i] * 1.3 && pixels[i + 1] > pixels[i + 2] * 1.3) {
          sum += (i / 4) % 960; count++;
        }
      }
      positions.push(count ? sum / count : null);
      return encode.call(this, frame, options);
    };
    const states = [];
    try {
      const file = await player.recordVideo({ resolution: 1080, onProgress: state => states.push(state) });
      const bytes = new Uint8Array(await file.arrayBuffer());
      let data = '';
      for (let at = 0; at < bytes.length; at += 8192) data += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return { submitted, positions, fast: states.some(state => state.fast), data: btoa(data) };
    } finally { VideoEncoder.prototype.encode = encode; }
  });
  await testInfo.attach('cadence-take', { body: Buffer.from(result.data, 'base64'), contentType: 'video/mp4' });
  expect(result.fast).toBe(true);
  const storyFrames = result.submitted.filter(t => t < 4_000_000);
  expect(storyFrames.length).toBeGreaterThanOrEqual(240);
  await testInfo.attach('frame-positions', { body: JSON.stringify({ times: result.submitted, positions: result.positions }), contentType: 'application/json' });
  for (let i = 1; i < storyFrames.length; i++) {
    expect(storyFrames[i] - storyFrames[i - 1], `gap before frame ${i}`).toBeLessThanOrEqual(17_000);
    expect(result.positions[i], `moving subject missing at frame ${i}`).not.toBeNull();
    expect(result.positions[i] - result.positions[i - 1], `stale picture at frame ${i}`).toBeGreaterThan(0.25);
  }
});

test('a streamed export never delivers bytes beyond the host budget', async ({ page }) => {
  await page.goto(base);
  await page.evaluate(() => window.ready);
  const result = await page.evaluate(async () => {
    let bytes = 0;
    try {
      await player.recordVideo({ maxBytes: 64, onChunk: async piece => { bytes += piece.size; } });
      return { bytes, error: null };
    } catch (error) { return { bytes, error: error.message }; }
  });
  expect(result.bytes).toBeLessThanOrEqual(64);
  expect(result.error).toContain('size limit');
  expect((await page.evaluate(() => player.getState())).playing).toBe(false);
});

test('a lesson in an illustrated world records its storybook narration, and plate capture is available', async ({ page }) => {
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
      const states = [];
      window.take = window.player.recordVideo({ onProgress: state => states.push(state) }).then(async (file) => {
        // The file's own sound, decoded: a take that recorded silence fails here.
        const samples = (await new AudioContext().decodeAudioData(await file.arrayBuffer())).getChannelData(0);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        return { name: file.name, peak, fast: states.some(state => state.fast) };
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
  expect(refusedPlate).toBe(true);
  expect(await page.evaluate(() => window.player.canRecordVideo())).toBe(true);
  await page.getByRole('button', { name: 'record' }).click();
  const kept = await page.evaluate(() => window.take);
  expect(kept.name).toBe('A garden lesson.mp4');
  expect(kept.fast).toBe(true);
  // The narration fixture peaks near 0.03 of full scale.
  expect(kept.peak).toBeGreaterThan(0.01);
});

test('a legacy video plate, narration, captions and branding survive a streamed native-style save', async ({ page }, testInfo) => {
  test.setTimeout(40_000);
  await page.goto(base);
  await page.evaluate(() => window.ready);
  await page.evaluate(async () => {
    window.player.destroy();
    const story = {
      storylang_version: 0, title: 'A moving garden', cast: {}, objects: {}, audio: { sfx: {}, bgm: {} },
      scenes: [{ place: 'garden', plate: { poster: 'pack/poster.svg', video: 'pack/garden.webm' }, steps: [
        { kind: 'chunk', line: 1, text: 'Look at the garden.', duration_s: 3, audio: 'pack/line.wav' },
        { kind: 'cmd', cmd: 'pause', seconds: 1 },
      ] }],
    };
    window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), {
      story, assetBase: location.origin, videoControls: 'host',
    });
    await window.player.ready;
    const button = document.createElement('button');
    button.textContent = 'Save outside the player';
    button.onclick = () => {
      const chunks = [];
      window.take = window.player.recordVideo({ onChunk: async (chunk) => chunks.push(chunk) })
        .then((info) => {
          const blob = new Blob(chunks, { type: info.type });
          window.savedUrl = URL.createObjectURL(blob);
          return { ...info, bytes: blob.size };
        });
    };
    document.body.append(button);
  });
  await page.getByRole('button', { name: 'Save outside the player' }).click();
  const info = await page.evaluate(() => window.take);
  expect(info.size).toBe(info.bytes);
  expect(info.name).toBe('A moving garden.mp4');
  const encoded = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch(window.savedUrl)).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  const bytes = Buffer.from(encoded, 'base64');
  const decoded = await inspectFile(page, bytes);
  expect(decoded.brandPixels).toBeGreaterThan(500);
  expect(decoded.captionPixels).toBeGreaterThan(40);
  expect(decoded.audioPeak).toBeGreaterThan(0.01);
  expect(decoded.colorPixels).toBeGreaterThan(100_000);
  const file = testInfo.outputPath('legacy.mp4');
  fs.writeFileSync(file, bytes);
  await testInfo.attach('legacy-story', { path: file, contentType: 'video/mp4' });
  await testInfo.attach('legacy-frame', { body: Buffer.from(decoded.frame, 'base64'), contentType: 'image/png' });
  await expect(page.locator('.save-button')).toBeHidden();
});


test('the name sits under the mark on a player wide enough to read it, and the mark stands alone on a small one', async ({ page }) => {
  await page.goto(base);
  await page.evaluate(() => window.ready);
  const brand = () => page.evaluate(() => {
    const root = document.querySelector('#player').shadowRoot;
    const [mark, word] = [...root.querySelectorAll('.logical-stage .story-brand img')].map((picture) => picture.getBoundingClientRect());
    return { mark: { left: mark.left, bottom: mark.bottom, width: mark.width }, word: { left: word.left, top: word.top, width: word.width, height: word.height } };
  });
  // The page's player is 640 wide: past the 600 from which a name as wide as its mark can be read.
  const wide = await brand();
  expect(wide.mark.width).toBeCloseTo(640 * 0.07, 0);
  expect(wide.word.height).toBeGreaterThan(wide.mark.width / 6);
  expect(wide.word.left).toBeCloseTo(wide.mark.left, 1);
  expect(wide.word.top).toBeCloseTo(wide.mark.bottom, 1);
  expect(wide.word.width).toBeCloseTo(wide.mark.width, 1);
  // A phone's upright stage. The stage is fitted again a frame after its frame changes size.
  await page.evaluate(() => { document.querySelector('#player').style.width = '358px'; });
  await expect.poll(async () => (await brand()).mark.width).toBeCloseTo(358 * 0.07, 0);
  expect((await brand()).word.height).toBe(0);
});

async function inspectFile(page, bytes) {
  return page.evaluate(async (encoded) => {
    const data = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const file = new Blob([data], { type: 'video/mp4' });
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    const metadata = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    const sought = new Promise((resolve) => { video.onseeked = resolve; });
    video.currentTime = 0.5;
    await sought;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let brandPixels = 0, captionPixels = 0, colorPixels = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const p = (y * canvas.width + x) * 4;
      const [r, g, b] = image.data.slice(p, p + 3);
      if (y > 140 && y < 550 && Math.max(r, g, b) - Math.min(r, g, b) > 80) colorPixels++;
      if (x > canvas.width * 0.905 && x < canvas.width * 0.982 && y < canvas.height * 0.155 && g > 65 && g > r * 1.2) brandPixels++;
      if (y > canvas.height * 0.85 && x > canvas.width * 0.3 && x < canvas.width * 0.7 && r > 160 && g > 160 && b > 160) captionPixels++;
    }
    const context = new AudioContext();
    const samples = (await context.decodeAudioData(await file.arrayBuffer())).getChannelData(0);
    let audioPeak = 0;
    for (const sample of samples) audioPeak = Math.max(audioPeak, Math.abs(sample));
    await context.close();
    URL.revokeObjectURL(url);
    return { ...metadata, brandPixels, captionPixels, colorPixels, audioPeak, frame: canvas.toDataURL().split(',')[1] };
  }, bytes.toString('base64'));
}


for (const cancelDuringLoad of [false, true]) test(cancelDuringLoad
  ? 'cancelling a stepped lesson interrupts pending frame images'
  : 'canvas lessons paint every 60 fps frame across scene cuts', async ({ page }) => {
  if (cancelDuringLoad) await page.route('**/pack/slow.svg', () => {});
  await page.goto(base);
  await page.evaluate(() => window.ready);
  const result = await page.evaluate(async (cancelDuringLoad) => {
    player.destroy();
    const svg = 'pack/scene.svg';
    const story = {
      storylang_version: 0, title: 'Two scenes',
      cast: { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
        clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } },
      objects: { garden: { svg, height_cm: 30 } }, audio: { sfx: {}, bgm: {} },
      scenes: [0, 1].map(i => ({ place: 'garden', plate: { poster: svg, video: 'pack/plate.webm' },
        steps: [{ kind: 'cmd', cmd: 'put', subjects: [cancelDuringLoad && i ? 'helper2' : 'helper'] },
          { kind: 'chunk', line: i + 1, text: `Scene ${i}`, duration_s: 2, audio: 'pack/line.wav' }] })),
    };
    if (cancelDuringLoad) story.cast.helper2 = { ...story.cast.helper, clips: { idle: { ...story.cast.helper.clips.idle, spritesheet: 'pack/slow.svg' } } };
    const board = { layout: 'lesson-guide', guide: 'helper', world: {
      background: 'garden', board: { style: 'garden', panel: [.1, .4, .8, .44] },
      actor_box: [.82, .94, .4], phases: [{ id: 'world', start_ms: 0, end_ms: 4000, mode: 'world', props: [] }],
    } };
    window.player = FabroStoryPlayer.createStoryPlayer(document.querySelector('#player'), { story, board, assetBase: location.origin });
    await player.ready;
    const canvas = document.querySelector('#player').shadowRoot.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const clear = ctx.clearRect.bind(ctx);
    let paints = 0;
    ctx.clearRect = (...args) => { paints++; return clear(...args); };
    const encode = VideoEncoder.prototype.encode;
    const frames = [];
    VideoEncoder.prototype.encode = function(frame, options) {
      frames.push({ t: frame.timestamp, paints, scene: player.getState().sceneIndex });
      return encode.call(this, frame, options);
    };
    try {
      if (cancelDuringLoad) {
        const saving = player.recordVideo().then(() => 'success', error => error.name);
        await new Promise(resolve => {
          const timer = setInterval(() => { if (player.getState().sceneIndex === 1) { clearInterval(timer); resolve(); } }, 5);
        });
        player.cancelVideo();
        return { cancelled: await Promise.race([saving, new Promise(resolve => setTimeout(() => resolve('pending'), 500))]) };
      }
      await player.recordVideo();
      return { frames };
    }
    finally { VideoEncoder.prototype.encode = encode; player.destroy(); }
  }, cancelDuringLoad);
  if (cancelDuringLoad) { expect(result.cancelled).toBe('AbortError'); return; }
  const moving = result.frames.filter(frame => frame.t < 4_000_000);
  expect(moving.length).toBeGreaterThanOrEqual(240);
  expect(moving.find(frame => frame.t === 2_000_000).scene).toBe(1);
  for (let i = 1; i < moving.length; i++) {
    expect(moving[i].paints, `stale frame at ${moving[i].t}`).toBeGreaterThan(moving[i - 1].paints);
    expect(moving[i].t - moving[i - 1].t).toBeLessThanOrEqual(17_000);
  }
});
