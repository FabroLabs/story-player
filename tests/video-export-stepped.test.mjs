/**
 * Which take a story gets: stepped where it can be, filmed where it cannot.
 *
 * The stepping itself needs a browser's encoders and is proven there
 * (`e2e/video-export.spec.mjs`); this is the choice around it, with a stand-in
 * for the stepped take: when it is tried, what it is handed, and what a
 * failure of it costs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { afterStep, createFastTake, planFastTake } from '../browser/v0/app/fast-export.mjs';
import { createVideoExport } from '../browser/v0/app/video-export-phase.mjs';
import { fakeElement } from './_dom.mjs';

const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function world({ plan = {}, run = null, wrote = false } = {}) {
  const calls = { begin: [], end: 0, played: 0, recorders: 0, closed: 0, warnings: [], progress: [] };
  const listeners = {};
  const document = {
    visibilityState: 'visible',
    addEventListener(type, handler) { listeners[type] = handler; },
    removeEventListener() {},
  };
  const state = { tMs: 0, durationMs: 4000 };
  const player = {
    beginExport: async (options) => { calls.begin.push(options); },
    endExport() { calls.end += 1; },
    getState: () => state,
    isPlaying: () => true,
    pause() {}, play() {},
  };
  const pending = {};
  const take = {
    timebase: { now: () => 0, request: () => 1, cancel() {} },
    run: (handed) => {
      pending.handed = handed;
      return run ? run(handed) : new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    },
    wrote: () => wrote,
    bytes: () => 7,
    close() { calls.closed += 1; },
  };
  const created = [];
  const globalObject = {
    document,
    AudioContext: class {
      resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      createMediaStreamDestination() { return { stream: { getAudioTracks: () => [] }, connect() {}, disconnect() {} }; }
      createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } getTracks() { return []; } },
    MediaRecorder: class {
      constructor(stream, options) { calls.recorders += 1; calls.recorderOptions = options; this.state = 'inactive'; this.handlers = {}; }
      addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
      start() { this.state = 'recording'; } pause() {} resume() {}
      stop() {
        this.state = 'inactive';
        for (const handler of this.handlers.dataavailable ?? []) handler({ data: new Blob(['filmed']) });
        for (const handler of this.handlers.stop ?? []) handler({});
      }
    },
    File, Blob,
    setTimeout: (handler) => { queueMicrotask(handler); return 1; },
    clearTimeout() {},
    performance,
    window: { addEventListener() {}, removeEventListener() {} },
  };
  const exporter = createVideoExport({
    elements: {
      status: { root: fakeElement('div'), label: fakeElement('span'), action: fakeElement('button'), dismiss: fakeElement('button') },
      item: fakeElement('button'),
      canvas: { captureStream: () => ({ getVideoTracks: () => [] }) },
    },
    support: { ok: true, mimeType: 'video/mp4' }, saving: true, hostControls: true,
    runtime: () => player, begin: () => { calls.played += 1; }, title: () => 'Rocket', story: () => ({ performance: {} }),
    onWarning: (warning) => calls.warnings.push(warning),
    stepping: {
      plan: async () => plan,
      create: (asked, options) => { created.push({ asked, options }); return take; },
    },
    globalObject,
  });
  const record = (options = {}) => exporter.record({ onProgress: (snapshot) => calls.progress.push(snapshot), ...options });
  return { exporter, calls, pending, created, take, state, document, listeners, record };
}

test('a story this browser can step is stepped, and never filmed', async () => {
  const w = world();
  const saving = w.record();
  await settle();
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].options.durationMs, 4000);
  assert.equal(w.calls.begin.length, 1);
  assert.equal(w.calls.begin[0].output, null, 'a stepped take sounds nothing');
  assert.equal(w.calls.begin[0].timebase, w.take.timebase, 'the story is handed the take’s own time');
  assert.equal(w.calls.recorders, 0);
  assert.equal(w.exporter.state().fast, true);
  w.pending.handed.begin();
  assert.equal(w.calls.played, 1);
  w.pending.resolve(new Blob(['stepped']));
  const file = await saving;
  assert.equal(file.name, 'Rocket.mp4');
  assert.equal(await file.text(), 'stepped');
  assert.deepEqual([w.exporter.state().status, w.exporter.state().fast], ['ready', true]);
  assert.equal(w.calls.end, 1);
  assert.equal(w.calls.closed, 1);
  assert.equal(w.exporter.active(), false);
});

test('a stepped take hears pause, resume and the story’s end, and a hidden tab does not stop it', async () => {
  const w = world();
  const saving = w.record();
  await settle();
  const { control } = w.pending.handed;
  assert.deepEqual([control.paused(), control.ending(), control.failed()], [false, false, null]);
  w.document.visibilityState = 'hidden';
  w.listeners.visibilitychange();
  assert.equal(control.paused(), false, 'nothing in it leans on the display');
  w.exporter.pause();
  assert.equal(control.paused(), true);
  assert.equal(w.exporter.state().status, 'paused');
  w.exporter.resume();
  assert.equal(control.paused(), false, 'and it is resumed while the tab is still hidden');
  const end = w.exporter.endOfStory();
  assert.equal(control.ending(), true);
  let ended = false;
  void end.then(() => { ended = true; });
  await settle();
  assert.equal(ended, false, 'the story’s end is held behind the take: no card, no wind-down');
  w.pending.resolve(new Blob(['x']));
  await saving;
  await settle();
  assert.equal(ended, true);
});

test('a stepped take that could not start is filmed instead, and the reason is said', async () => {
  const w = world({ run: async () => { throw new Error('story sound could not be fetched (404)'); } });
  const saving = w.record();
  await settle();
  assert.equal(w.calls.warnings.length, 1);
  assert.match(w.calls.warnings[0].message, /filmed: story sound could not be fetched/);
  assert.equal(w.calls.closed >= 1, true);
  assert.equal(w.calls.begin.length, 2, 'the story is made ready again, for the recorder this time');
  assert.equal(w.calls.begin[1].timebase, undefined);
  assert.ok(w.calls.begin[1].output, 'and heard through the take’s audio graph');
  assert.equal(w.calls.recorders, 1);
  assert.equal(w.exporter.state().fast, undefined);
  void w.exporter.endOfStory();
  const file = await saving;
  assert.equal(await file.text(), 'filmed');
});

test('once any of the file has left, a stepped take’s failure is the take’s', async () => {
  const w = world({ wrote: true, run: async () => { throw new Error('the encoder stopped'); } });
  await assert.rejects(w.record(), /the encoder stopped/);
  assert.equal(w.calls.begin.length, 1, 'half a file is never followed by a second one');
  assert.equal(w.calls.recorders, 0);
  assert.equal(w.exporter.state().status, 'failed');
});

test('default Full HD keeps its frame and bitrate when a stepped take falls back to filming', async () => {
  const w = world({ run: async () => { throw new Error('encoder unavailable'); } });
  const saving = w.record();
  await settle();
  assert.equal(w.created[0].options.bitrate, 16_000_000);
  assert.deepEqual(w.calls.begin.map(({ size }) => size), [
    { width: 1920, height: 1080 }, { width: 1920, height: 1080 },
  ]);
  assert.equal(w.calls.recorderOptions.videoBitsPerSecond, 16_000_000);
  void w.exporter.endOfStory();
  await saving;
  for (const resolution of [0, 480, 2160, '1080', null]) {
    await assert.rejects(w.record({ resolution }), /resolution must be 720 or 1080/);
  }
});

test('stopping a stepped take stops it, and a story that cannot be stepped is filmed without a word', async () => {
  const w = world();
  const saving = w.record();
  await settle();
  w.exporter.cancel();
  assert.equal(w.pending.handed.control.failed().name, 'AbortError');
  w.pending.reject(w.pending.handed.control.failed());
  await assert.rejects(saving, { name: 'AbortError' });
  assert.equal(w.calls.recorders, 0);
  assert.equal(w.calls.closed >= 1, true);

  const plain = world({ plan: null });
  const filmed = plain.record();
  await settle();
  assert.equal(plain.created.length, 0);
  assert.equal(plain.calls.recorders, 1);
  assert.deepEqual(plain.calls.warnings, []);
  void plain.exporter.endOfStory();
  await filmed;
});

test('a host may ask for the filmed take by name, and any other name is refused', async () => {
  const w = world();
  const saving = w.record({ mode: 'filmed' });
  await settle();
  assert.equal(w.created.length, 0);
  assert.equal(w.calls.recorders, 1);
  void w.exporter.endOfStory();
  await saving;
  await assert.rejects(world().record({ mode: 'quick' }), /mode must be auto or filmed/);
});

test('a step of the clock is a frame, the end, or a wait — and a story standing on a sliver is always a wait', () => {
  const step = (tMs, last, ended = false) => afterStep({ tMs, last, durationMs: 4000, ended });
  assert.equal(step(17, 0), 'frame', 'time moved a frame on');
  assert.equal(step(1000, 1000), 'wait', 'the story is holding for a picture');
  // Back from a hold a hair past the last frame: the loop must yield here, or
  // a story that holds again on that hair is stepped for ever.
  assert.equal(step(1002, 1000), 'wait');
  assert.equal(step(1008, 1000), 'wait');
  assert.equal(step(1009, 1000), 'frame');
  assert.equal(step(4000, 3990), 'frame', 'the story’s last instant is written however close it falls');
  assert.equal(step(4000, 4000, true), 'end');
  assert.equal(step(1000, 1000, true), 'end', 'a take told the story ended stops waiting');
  assert.equal(step(4000, 4000), 'wait', 'and one not yet told so does not guess');
});


test('a streamed ten-minute preview budgets picture and sound inside its host limit', async () => {
  const w = world();
  w.state.durationMs = 640_000;
  const limit = 512 * 1024 * 1024;
  const saving = w.record({ onChunk: async () => {}, maxBytes: limit });
  await settle();
  const bitrate = w.created[0].options.bitrate;
  assert.ok((bitrate + 96_000) * 641 / 8 <= limit * 0.9, 'the requested encode exceeds the host byte budget');
  assert.ok(bitrate > 5_000_000, 'a long preview was reduced more than its budget requires');
  w.pending.resolve({ size: 7 });
  await saving;
  for (const maxBytes of [0, -1, Infinity, 1.5, '512']) {
    await assert.rejects(w.record({ maxBytes }), /maxBytes/);
  }
});


test('Full HD plans use 60 fps and codec levels that can carry it', async () => {
  const asked = [];
  const supported = class {
    static async isConfigSupported(config) { asked.push(config); return { supported: true }; }
  };
  const available = class {};
  const plan = await planFastTake({
    story: { performance: {}, audio: [] }, size: { width: 1920, height: 1080 },
    globalObject: {
      VideoEncoder: supported, AudioEncoder: supported,
      VideoFrame: available, AudioData: available, MessageChannel: available,
      OfflineAudioContext: available, OffscreenCanvas: available,
    },
  });
  assert.equal(plan.video.config.codec, 'avc1.64002A');
  assert.equal(asked[0].framerate, 60);
});


for (const kind of ['music', 'ambience']) test(`performance ${kind} loops use stepped export when codecs are supported`, async () => {
  const supported = class { static async isConfigSupported() { return { supported: true }; } };
  const available = class {};
  const cue = { kind, media: 'bed.m4a', start_ms: 250, end_ms: 3500, duration_ms: 500, loop: true, volume: 0.5 };
  const plan = await planFastTake({
    story: { performance: {}, audio: [cue] }, size: { width: 1920, height: 1080 },
    globalObject: {
      VideoEncoder: supported, AudioEncoder: supported,
      VideoFrame: available, AudioData: available, MessageChannel: available,
      OfflineAudioContext: available, OffscreenCanvas: available,
    },
  });
  assert.ok(plan, 'looping performance audio must not force a realtime recording');
  assert.deepEqual(plan.cues, [cue], 'keep the authored schedule, loop length and volume');
});

// A live farm plate used to disqualify this document before codecs were asked.
function farmJourney() {
  return { storylang_version: 0, title: 'أصدقاء المزرعة', cast: {}, objects: Object.fromEntries(['animal_cow', 'farm_view_wide_cow'].map(slug => [slug, { svg: `pack/${slug}.svg`, height_cm: 35 }])), audio: { sfx: {}, bgm: {} },
    scenes: [{ place: 'farm', plate: { poster: 'pack/poster.svg', video: 'pack/farm_journey_v4.mp4', resolution: [1920, 1080] }, steps: [
      { kind: 'cmd', cmd: 'put', subjects: ['animal_cow'], objects: ['animal_cow'], position: 'center' },
      { kind: 'cmd', cmd: 'board', cards: ['animal_cow', 'farm_view_wide_cow'], prompt: 'بقرة' },
      { kind: 'cmd', cmd: 'pause', seconds: 1 },
    ] }] };
}

test('a farm journey with a live plate selects stepping and encodes a native 60 fps grid despite slow frames', async () => {
  const { compileTimeline } = await import('../browser/v0/core/timeline/compile.mjs');
  const story = farmJourney();
  const timeline = compileTimeline(story);
  const timestamps = [], durations = [];
  let wall = 0;
  const packet = (timestamp, duration) => ({ timestamp, duration, type: 'key', byteLength: 1, copyTo: out => out.fill(1) });
  class Encoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; }
    configure() {} async flush() {} close() {}
  }
  const g = {
    VideoEncoder: class extends Encoder {
      encode(frame) {
        timestamps.push(frame.timestamp); durations.push(frame.duration);
        this.callbacks.output(packet(frame.timestamp, frame.duration), { decoderConfig: { description: new Uint8Array([1, 100, 0, 42]) } });
      }
    },
    AudioEncoder: class extends Encoder { encode(data) { this.callbacks.output(packet(data.timestamp, data.numberOfFrames / 48000 * 1e6)); } },
    VideoFrame: class { constructor(canvas, init) { Object.assign(this, init); } close() {} },
    AudioData: class { constructor(init) { Object.assign(this, init); } },
    OfflineAudioContext: class {},
    OffscreenCanvas: class { constructor(width, height) { Object.assign(this, { width, height }); } getContext() { return { drawImage() {} }; } },
    MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage()) }; } },
    Blob, performance: { now: () => wall },
  };
  const plan = await planFastTake({ story, timeline, size: { width: 1920, height: 1080 }, globalObject: g });
  assert.ok(plan, 'a farm video plate must not force wall-clock MediaRecorder capture');
  const take = createFastTake(plan, { story, canvas: { width: 1920, height: 1080 }, durationMs: 1000, tailMs: 1000, globalObject: g });
  let origin;
  const player = {
    // The real story clock rounds to milliseconds. Output timing must not.
    getState: () => ({ tMs: Math.min(1000, Math.round(take.timebase.now() - origin)), ended: take.timebase.now() - origin >= 1000 }),
    awaitExportFrame: async () => { wall += 75; await Promise.resolve(); },
  };
  try {
    const file = await take.run({ player, begin: () => { origin = take.timebase.now(); },
      control: { failed: () => null, paused: () => false, ending: () => false } });
    assert.ok(file.size > 0);
    assert.equal(timestamps.length, 120, 'two seconds must contain exactly 120 frames, including the tail');
    assert.deepEqual(timestamps.slice(0, 7), [0, 16667, 33333, 50000, 66667, 83333, 100000]);
    for (let i = 0; i < timestamps.length; i++) {
      assert.ok(Math.abs(timestamps[i] - i * 1000000 / 60) <= 0.5, 'timestamps use the 60 Hz grid to microsecond precision');
      assert.ok(Math.abs(durations[i] - 1000000 / 60) <= 1);
    }
    assert.ok(wall > 4000, 'the fake CPU must take longer than the video');
  } finally { take.close(); }
});

test('the farm runtime seeks and repaints its live plate before releasing each stepped frame', async (t) => {
  const { installDom, installAudio } = await import('./_dom.mjs');
  const { createPlayerTemplate } = await import('../browser/template.mjs');
  const { createTimelinePlayer } = await import('../browser/v0/app/timeline-player.mjs');
  const { StoryClock } = await import('../browser/v0/app/clock.mjs');
  const { createBitmapCache } = await import('../browser/v0/app/assets/bitmap-cache.mjs');
  const { createSceneLoader } = await import('../browser/v0/app/assets/scene-loader.mjs');
  const { resolveStoryAssets } = await import('../browser/v0/app/urls.mjs');
  const { compileTimeline } = await import('../browser/v0/core/timeline/compile.mjs');
  const dom = installDom(), audio = installAudio();
  t.after(() => { audio.restore(); dom.restore(); });
  const elements = createPlayerTemplate(document.createElement('div'));
  const video = elements.stage.video;
  Object.assign(video, { readyState: 2, duration: 2, videoWidth: 1920, videoHeight: 1080 });
  video.seekable = { length: 1, start: () => 0, end: () => 2 };
  let currentTime = 0, paintedAt = null;
  Object.defineProperty(video, 'currentTime', { get: () => currentTime, set: value => {
    video.seeking = true;
    queueMicrotask(() => { currentTime = value; video.seeking = false; video.dispatch('seeked'); });
  } });
  const context = elements.stage.canvas.getContext('2d');
  context.fillRect = () => {};
  const draw = context.drawImage.bind(context);
  context.drawImage = (source, ...args) => { if (source === video) paintedAt = source.currentTime; return draw(source, ...args); };
  const bundle = resolveStoryAssets(farmJourney(), 'https://storage.example/');
  const timeline = compileTimeline(bundle), cache = createBitmapCache();
  const loader = createSceneLoader({ bundle, timeline, cache });
  const clock = new StoryClock();
  const player = createTimelinePlayer({ elements, bundle, timeline, cache, loader, clock });
  t.after(() => { player.destroy(); cache.destroy(); });
  await player.prepare();
  let now = 0, next = 0;
  const callbacks = new Map();
  const timebase = { now: () => now, request: cb => { callbacks.set(++next, cb); return next; }, cancel: id => callbacks.delete(id) };
  await player.beginExport({ size: { width: 1920, height: 1080 }, output: null, timebase });
  player.begin();
  await player.awaitExportFrame();
  for (const [at, seconds] of [[1000 / 60, 0.017], [2000 / 60, 0.033], [50, 0.05]]) {
    now = at;
    const due = [...callbacks.values()]; callbacks.clear();
    for (const cb of due) cb(now);
    await player.awaitExportFrame();
    assert.equal(player.getState().tMs, Math.round(at));
    assert.equal(video.currentTime, seconds, 'the video must be sought before encoding');
    assert.equal(paintedAt, seconds, 'the canvas must contain that decoded video frame');
  }
  player.endExport();
});
