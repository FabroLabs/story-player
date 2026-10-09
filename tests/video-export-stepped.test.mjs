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

import { afterStep } from '../browser/v0/app/fast-export.mjs';
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
      constructor() { calls.recorders += 1; this.state = 'inactive'; this.handlers = {}; }
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
  assert.equal(step(42, 0), 'frame', 'time moved a frame on');
  assert.equal(step(1000, 1000), 'wait', 'the story is holding for a picture');
  // Back from a hold a hair past the last frame: the loop must yield here, or
  // a story that holds again on that hair is stepped for ever.
  assert.equal(step(1002, 1000), 'wait');
  assert.equal(step(1020, 1000), 'wait');
  assert.equal(step(1021, 1000), 'frame');
  assert.equal(step(4000, 3990), 'frame', 'the story’s last instant is written however close it falls');
  assert.equal(step(4000, 4000, true), 'end');
  assert.equal(step(1000, 1000, true), 'end', 'a take told the story ended stops waiting');
  assert.equal(step(4000, 4000), 'wait', 'and one not yet told so does not guess');
});
