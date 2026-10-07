/**
 * Saving a story as a video, at the seams a browser gives it: what the device
 * can record, the audio graph every sound passes through, the recorder, and
 * where the file goes. The take itself is driven in a real browser by
 * `tests/e2e/video-export.spec.mjs`; these hold the decisions that one run on
 * one browser cannot show.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MP4_TYPES, createAudioTap, createRecording, fileNameFor, recordingSupport, saveVideoFile, savingSupported,
} from '../browser/v0/app/video-export.mjs';
import { performanceFixture } from './_performance.mjs';
import { fakeElement } from './_dom.mjs';

const WORLD = { layout: 'lesson-guide', guide: 'helper', world: { background: 'garden' } };
const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

test('a story drawn on the canvas can be recorded, as the best mp4 the browser makes', () => {
  const performance = performanceFixture();
  assert.deepEqual(recordingSupport({ story: performance, globalObject: platform() }), {
    ok: true, mimeType: 'video/mp4;codecs=avc1.42E01F,mp4a.40.2', reason: null,
  });
  // A lesson whose illustrated world covers the stage is canvas too.
  assert.equal(recordingSupport({ story: { storylang_version: 0 }, board: WORLD, globalObject: platform() }).ok, true);
  // A Chromium without the licensed codecs makes VP9 with Opus, and that is still an mp4.
  const open = recordingSupport({ story: performance, globalObject: platform({ types: ['video/mp4;codecs=vp9,opus'] }) });
  assert.equal(open.mimeType, 'video/mp4;codecs=vp9,opus');
});

test('a story the recording cannot see, or a browser that cannot make an mp4, is refused by name', () => {
  const performance = performanceFixture();
  const refused = (options) => recordingSupport({ story: performance, ...options }).reason;
  assert.match(refused({ story: { storylang_version: 0 }, globalObject: platform() }), /background is a video/);
  assert.match(refused({ stream: { scenes: 3 }, globalObject: platform() }), /still being written/);
  assert.match(refused({ globalObject: platform({ recorder: false }) }), /cannot record video/);
  assert.match(refused({ globalObject: platform({ capture: false }) }), /cannot record its canvas/);
  assert.match(refused({ globalObject: platform({ audio: false }) }), /story’s sound/);
  assert.match(refused({ globalObject: platform({ types: ['video/webm;codecs=vp9,opus'] }) }), /cannot record an mp4/);
});

test('an Android app’s webview keeps a video only through the host', () => {
  assert.equal(savingSupported({ globalObject: { navigator: { userAgent: ANDROID_WEBVIEW } } }), false);
  assert.equal(savingSupported({ download: () => {}, globalObject: { navigator: { userAgent: ANDROID_WEBVIEW } } }), true);
  assert.equal(savingSupported({ globalObject: { navigator: { userAgent: ANDROID_CHROME } } }), true);
  assert.equal(savingSupported({ globalObject: { navigator: { userAgent: IPHONE } } }), true);
});

test('every sound is fetched with CORS and heard by both the room and the recording', (t) => {
  const audio = fakeAudio(t);
  const context = fakeContext();
  const tap = createAudioTap(context);

  const line = tap.audio('https://storage.example/jobs/e2e/audio/line.m4a');
  assert.deepEqual(line.writes, [['crossOrigin', 'anonymous'], ['src', 'https://storage.example/jobs/e2e/audio/line.m4a']],
    'the source was set before CORS, so the graph would hear silence');
  const [node] = context.sources;
  assert.equal(node.media, line);
  assert.deepEqual(node.connected, [context.speakers, context.capture]);
  assert.deepEqual(context.speakers.connected, [context.destination]);
  assert.equal(tap.stream, context.capture.stream);

  // A performance sets the source itself, after the element is made.
  const bed = tap.audio();
  assert.deepEqual(bed.writes, [['crossOrigin', 'anonymous']]);

  tap.mute(true);
  assert.equal(context.speakers.gain.value, 0);
  tap.mute(false);
  assert.equal(context.speakers.gain.value, 1);

  // A voice the story let go of leaves the graph when the next one arrives.
  line.removeAttribute('src');
  bed.src = 'blob:bed';
  tap.audio('https://storage.example/next.m4a');
  assert.equal(node.disconnects, 1);
  assert.equal(context.sources[1].disconnects, 0, 'a bed still playing was taken out of the recording');

  tap.close();
  assert.deepEqual(context.sources.map((source) => source.disconnects), [1, 1, 1]);
  assert.equal(audio.made.length, 3);
});

test('a take follows the story, hands over the whole recording, and fails once', async (t) => {
  const recorders = fakeRecorders(t);
  const stream = fakeStream();
  const failures = [];
  const recording = createRecording(stream, {
    mimeType: 'video/mp4', onError: (error) => failures.push(error.message), globalObject: globalThis,
  });
  const [recorder] = recorders.made;
  assert.equal(recorder.stream, stream);
  assert.deepEqual(recorder.options, { mimeType: 'video/mp4', videoBitsPerSecond: 1_600_000, audioBitsPerSecond: 96_000 });
  assert.equal(recorder.slice, 1000, 'the recording is held as one buffer until the end');

  recording.resume();
  recording.pause();
  recording.pause();
  recording.resume();
  assert.deepEqual(recorder.calls, ['pause', 'resume'], 'the recorder was asked for what it was already doing');
  recorder.emit('dataavailable', { data: new Blob(['one ']) });
  recorder.emit('dataavailable', { data: new Blob([]) });
  const blob = await recording.finish();
  assert.equal(blob.type, 'video/mp4');
  assert.equal(await blob.text(), 'one tail');
  assert.equal(stream.tracks.every((track) => track.stopped), true, 'the canvas and the graph are still being captured');

  const broken = createRecording(fakeStream(), {
    mimeType: 'video/mp4', onError: (error) => failures.push(error.message), globalObject: globalThis,
  });
  recorders.made[1].emit('error', { error: new Error('encoder gone') });
  recorders.made[1].emit('error', { error: new Error('again') });
  await assert.rejects(broken.finish(), /encoder gone/);
  assert.deepEqual(failures, ['encoder gone']);

  const empty = createRecording(fakeStream(), { mimeType: 'video/mp4', globalObject: globalThis });
  recorders.made[2].silent = true;
  await assert.rejects(empty.finish(), /came back empty/);
});

test('a discarded take keeps nothing and stops capturing', () => {
  const recorders = fakeRecorders();
  const stream = fakeStream();
  const recording = createRecording(stream, { mimeType: 'video/mp4', globalObject: globalThis });
  recording.discard();
  assert.equal(recorders.made[0].state, 'inactive');
  assert.equal(stream.tracks.every((track) => track.stopped), true);
  recorders.restore();
});

test('the file is named after the story, as a name any device will take', () => {
  assert.equal(fileNameFor('Ruby and the Gentle Dark'), 'Ruby and the Gentle Dark.mp4');
  assert.equal(fileNameFor('Sam’s day: a/b\\c?'), 'Sam’s day a b c.mp4');
  assert.equal(fileNameFor('  '), 'story.mp4');
  assert.equal(fileNameFor(undefined), 'story.mp4');
  assert.equal(fileNameFor('x'.repeat(200)).length, 84);
});

test('the file goes to the host when it keeps videos, else to the share sheet or a download', async () => {
  const file = new File(['video'], 'Moon.mp4', { type: 'video/mp4' });
  const container = fakeContainer();

  const kept = [];
  await saveVideoFile(file, { download: (handed) => kept.push(handed), container, globalObject: device(IPHONE, true) });
  assert.deepEqual(kept, [file]);

  // An iPhone: the share sheet is the way into its photos.
  const iphone = device(IPHONE, true);
  await saveVideoFile(file, { container, globalObject: iphone });
  assert.deepEqual(iphone.shared, [{ files: [file], title: 'Moon' }]);
  assert.equal(container.links.length, 0);

  // Android keeps a download where its gallery finds it, and a desktop has a folder.
  for (const userAgent of [ANDROID_CHROME, 'Mozilla/5.0 (X11; Linux x86_64)']) {
    const coarse = userAgent === ANDROID_CHROME;
    const browser = device(userAgent, coarse);
    const links = container.links.length;
    await saveVideoFile(file, { container, globalObject: browser });
    assert.deepEqual(browser.shared, []);
    const link = container.links[links];
    assert.equal(link.href, 'blob:video');
    assert.equal(link.download, 'Moon.mp4');
    assert.equal(link.clicked, 1);
    assert.equal(link.removed, true);
    assert.deepEqual(browser.revoked, []);
    browser.timers[0][0]();
    assert.deepEqual(browser.revoked, ['blob:video'], 'the link to the file was never let go of');
  }
});

test('a share sheet the viewer closed is said, not swallowed', async () => {
  const file = new File(['video'], 'Moon.mp4', { type: 'video/mp4' });
  const iphone = device(IPHONE, true);
  iphone.navigator.share = async () => { throw new DOMException('closed', 'AbortError'); };
  await assert.rejects(saveVideoFile(file, { container: fakeContainer(), globalObject: iphone }), { name: 'AbortError' });
});

function platform({ types = MP4_TYPES, recorder = true, capture = true, audio = true } = {}) {
  return {
    MediaRecorder: recorder ? class { static isTypeSupported(type) { return types.includes(type); } } : undefined,
    MediaStream: class {},
    HTMLCanvasElement: { prototype: capture ? { captureStream() {} } : {} },
    AudioContext: audio ? class { createMediaStreamDestination() {} createMediaElementSource() {} } : undefined,
  };
}

function fakeContext() {
  const node = (extra = {}) => ({
    connected: [],
    disconnects: 0,
    connect(target) { this.connected.push(target); },
    disconnect() { this.disconnects += 1; },
    ...extra,
  });
  const context = {
    destination: { name: 'destination' },
    sources: [],
    createGain() {
      context.speakers = node({ gain: { value: 1 } });
      return context.speakers;
    },
    createMediaStreamDestination() {
      context.capture = node({ stream: { getAudioTracks: () => ['audio-track'] } });
      return context.capture;
    },
    createMediaElementSource(media) {
      const source = node({ media });
      context.sources.push(source);
      return source;
    },
  };
  return context;
}

function fakeAudio(t) {
  const original = globalThis.Audio;
  const made = [];
  globalThis.Audio = class {
    constructor() {
      this.writes = [];
      this.attributes = {};
      made.push(this);
    }

    set crossOrigin(value) { this.writes.push(['crossOrigin', value]); }

    set src(value) {
      this.writes.push(['src', value]);
      this.attributes.src = value;
    }

    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
  };
  t.after(() => { globalThis.Audio = original; });
  return { made };
}

function fakeRecorders(t) {
  const original = globalThis.MediaRecorder;
  const made = [];
  globalThis.MediaRecorder = class {
    constructor(stream, options) {
      Object.assign(this, { stream, options, state: 'inactive', calls: [], listeners: {}, silent: false });
      made.push(this);
    }

    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    emit(type, event = {}) { for (const handler of this.listeners[type] ?? []) handler(event); }

    start(slice) {
      this.slice = slice;
      this.state = 'recording';
    }

    pause() {
      this.calls.push('pause');
      this.state = 'paused';
    }

    resume() {
      this.calls.push('resume');
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      if (!this.silent) this.emit('dataavailable', { data: new Blob(['tail']) });
      this.emit('stop');
    }
  };
  const restore = () => { globalThis.MediaRecorder = original; };
  t?.after(restore);
  return { made, restore };
}

function fakeStream() {
  const tracks = [{ stopped: false }, { stopped: false }].map((track) => Object.assign(track, {
    stop() { track.stopped = true; },
  }));
  return { tracks, getTracks: () => tracks };
}

function fakeContainer() {
  const container = fakeElement();
  container.links = [];
  container.ownerDocument = {
    createElement: (tag) => {
      const link = fakeElement(tag);
      link.clicked = 0;
      link.click = () => { link.clicked += 1; };
      container.links.push(link);
      return link;
    },
  };
  return container;
}

function device(userAgent, coarse) {
  const browser = {
    shared: [],
    revoked: [],
    timers: [],
    navigator: {
      userAgent,
      canShare: ({ files }) => files.length === 1,
      share: async (data) => { browser.shared.push(data); },
    },
    matchMedia: (query) => ({ matches: query === '(pointer: coarse)' && coarse }),
    URL: { createObjectURL: () => 'blob:video', revokeObjectURL: (url) => browser.revoked.push(url) },
    setTimeout: (callback, ms) => browser.timers.push([callback, ms]),
  };
  return browser;
}
