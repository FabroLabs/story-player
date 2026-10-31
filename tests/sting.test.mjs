/**
 * The sting a saved video opens and closes with: its film read from an mp4,
 * decoded in order, and placed around the story by a stepped take. The real
 * decoders and encoders are proven in a browser; here they are stand-ins.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createFastTake, planFastTake } from '../browser/v0/app/fast-export.mjs';
import { readM4a, readMp4Video } from '../browser/v0/app/m4a-reader.mjs';
import { decodeInOrder, stingMedia } from '../browser/v0/app/sting.mjs';

const tinyFilm = () => fs.readFileSync(new URL('./fixtures/tiny-film.mp4', import.meta.url));

test('a film’s picture is read as H.264 frames in the order they are shown', () => {
  const film = readMp4Video(tinyFilm());
  assert.match(film.codec, /^avc1\.64/, 'High profile, as the sting is encoded');
  assert.deepEqual([film.width, film.height], [64, 36]);
  assert.equal(film.description[0], 1, 'the avcC record, version 1');
  assert.deepEqual(film.frames.map((frame) => frame.key), [true, false, true], 'a key frame every two, as encoded');
  assert.deepEqual(film.frames.map((frame) => frame.timestamp), [0, 16667, 33333]);
  for (const frame of film.frames) assert.ok(Math.abs(frame.duration - 1e6 / 60) <= 1);
  assert.throws(() => readM4a(tinyFilm()), /no sound track/, 'a silent film has no sound to read');
});

test('the sting is looked for in the shared bucket, in the frame’s own shape', () => {
  assert.deepEqual(stingMedia('9:16').intro, {
    picture: 'fairytale-assets/brand/sting/v1/intro-9x16.mp4', sound: 'fairytale-assets/brand/sting/v1/intro.m4a',
  });
  assert.equal(stingMedia('16:9').outro.picture, 'fairytale-assets/brand/sting/v1/outro-16x9.mp4');
});

test('frames come back in order, a few packets ahead, and the last is followed by nothing', async () => {
  const fed = [];
  class VideoDecoder {
    constructor({ output }) { this.output = output; this.decodeQueueSize = 0; this.state = 'configured'; this.held = []; }
    configure() {}
    // Like a hardware decoder, it hands frames back only once it holds two.
    decode(chunk) {
      fed.push(chunk.type);
      this.held.push(chunk.timestamp);
      if (this.held.length > 2) { const timestamp = this.held.shift(); queueMicrotask(() => this.output({ timestamp, close() {} })); }
    }
    // As a real one does, a flush lets what is already on its way arrive first.
    async flush() { await Promise.resolve(); for (const timestamp of this.held.splice(0)) this.output({ timestamp, close() {} }); }
    close() { this.state = 'closed'; }
  }
  class EncodedVideoChunk { constructor(init) { Object.assign(this, init); } }
  const info = readMp4Video(tinyFilm());
  const film = decodeInOrder(info, new Uint8Array(tinyFilm()), {}, { VideoDecoder, EncodedVideoChunk });
  const seen = [];
  for (let frame = await film.next(); frame; frame = await film.next()) seen.push(frame.timestamp);
  film.close();
  assert.deepEqual(seen, [0, 16667, 33333]);
  assert.deepEqual(fed, ['key', 'delta', 'key']);
});

/** A stepped take of a silent one-second story, with stand-in encoders that remember what they were given. */
async function steppedTake(sting) {
  const story = { performance: {}, audio: [] };
  const seen = { pictures: [], timestamps: [], sound: [], warnings: [] };
  const packet = (timestamp) => ({ timestamp, type: 'key', byteLength: 1, copyTo: (out) => out.fill(1) });
  class Encoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; }
    configure() {} async flush() {} close() {}
  }
  let painted = null;
  const g = {
    VideoEncoder: class extends Encoder {
      encode(frame) {
        seen.timestamps.push(frame.timestamp);
        seen.pictures.push(painted);
        this.callbacks.output(packet(frame.timestamp), { decoderConfig: { description: new Uint8Array([1, 100, 0, 42]) } });
      }
    },
    AudioEncoder: class extends Encoder {
      encode(data) {
        seen.sound.push(...data.data.subarray(0, data.numberOfFrames));
        this.callbacks.output(packet(data.timestamp));
      }
    },
    VideoFrame: class { constructor(canvas, init) { Object.assign(this, init); } close() {} },
    AudioData: class { constructor(init) { Object.assign(this, init); } },
    OfflineAudioContext: class {},
    OffscreenCanvas: class {
      constructor(width, height) { Object.assign(this, { width, height }); }
      getContext() { return { drawImage: (source) => { painted = source.name ?? 'story'; } }; }
    },
    MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage()) }; } },
    Blob, performance: { now: () => 0 },
  };
  const plan = await planFastTake({ story, size: { width: 1280, height: 720 }, globalObject: g });
  const take = createFastTake(plan, {
    story, canvas: { width: 1280, height: 720 }, durationMs: 1000, tailMs: 0, globalObject: g,
    sting, onWarning: (warning) => seen.warnings.push(warning.message),
  });
  let origin;
  const player = {
    getState: () => ({ tMs: Math.min(1000, Math.round(take.timebase.now() - origin)), ended: take.timebase.now() - origin >= 1000 }),
    awaitExportFrame: async () => {},
  };
  try {
    const file = await take.run({ player, begin: () => { origin = take.timebase.now(); },
      control: { failed: () => null, paused: () => false, ending: () => false } });
    assert.ok(file.size > 0);
  } finally { take.close(); }
  return seen;
}

/** A film of `count` frames named `name-0…`, its sound one constant `level` for as long. */
function film(name, count, level) {
  return {
    frames: count,
    picture() {
      let next = 0;
      return {
        next: async () => (next < count ? { name: `${name}-${next++}`, displayWidth: 1920, displayHeight: 1080, close() {} } : null),
        close() {},
      };
    },
    sound: { length: count * 800, mix: async (from, count) => [new Float32Array(count).fill(level), new Float32Array(count).fill(level)] },
  };
}

test('a saved video opens on the intro and closes on the outro, picture and sound alike', async () => {
  const asked = [];
  const seen = await steppedTake(async (shape, options) => {
    asked.push({ shape, ...options });
    return { intro: film('intro', 6, 0.5), outro: film('outro', 3, -0.25) };
  });
  assert.deepEqual(asked, [{ shape: '16:9', rate: 48000, frameMs: 1000 / 60 }]);
  // A one-second story is 61 frames: its first instant and its last.
  assert.equal(seen.timestamps.length, 6 + 61 + 3, 'the intro’s frames, a second of story, the outro’s');
  for (let i = 0; i < seen.timestamps.length; i++) assert.ok(Math.abs(seen.timestamps[i] - i * 1e6 / 60) <= 0.5, 'one unbroken 60 Hz grid');
  assert.deepEqual(seen.pictures.slice(0, 6), ['intro-0', 'intro-1', 'intro-2', 'intro-3', 'intro-4', 'intro-5']);
  assert.ok(seen.pictures.slice(6, 67).every((picture) => picture === 'story'));
  assert.deepEqual(seen.pictures.slice(67), ['outro-0', 'outro-1', 'outro-2']);
  assert.equal(seen.sound.length, 70 * 800, 'the sound lasts exactly as long as the picture');
  assert.ok(seen.sound.slice(0, 4800).every((value) => value === 0.5), 'the intro’s sound first');
  assert.ok(seen.sound.slice(4800, 67 * 800).every((value) => value === 0), 'then the (silent) story, where it always was');
  assert.ok(seen.sound.slice(67 * 800).every((value) => value === -0.25), 'then the outro’s, starting with its first frame');
  assert.deepEqual(seen.warnings, []);
});

test('a sting that cannot be had is left out and said, and the story is saved as before', async () => {
  const seen = await steppedTake(async () => { throw new Error('the sting could not be fetched (404)'); });
  assert.equal(seen.timestamps.length, 61);
  assert.ok(seen.pictures.every((picture) => picture === 'story'));
  assert.deepEqual(seen.warnings, ['the video is saved without its sting: the sting could not be fetched (404)']);
});

test('without a sting a stepped take is exactly what it was', async () => {
  const seen = await steppedTake(null);
  assert.equal(seen.timestamps.length, 61);
  assert.equal(seen.sound.length, 48000);
  assert.deepEqual(seen.warnings, []);
});
