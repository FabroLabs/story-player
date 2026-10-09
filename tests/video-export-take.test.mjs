/**
 * A take, through the whole player: the settings menu's "save video", the story
 * replayed from its start into a recorder, the pill that says how far it has
 * got, and the file at the end — with the browser's recorder, audio graph and
 * canvas capture replaced so the run is scripted rather than timed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { findByClass, installDom, virtualFrames } from './_dom.mjs';

const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

function fourSeconds() {
  return {
    title: 'Sam and the kite',
    performance: { kind: 'wht', resolution: [1000, 562.5], required_capabilities: ['transform'] },
    assets: { sky: { type: 'image', media: 'pack/sky.png', width: 100, height: 100 } },
    scenes: [{ id: 'a', setting_id: 'park', start_ms: 0, end_ms: 4000, nodes: [{ id: 'n', asset: 'sky', x: 100, y: 100, width: 100 }] }],
    audio: [
      { id: 'line', kind: 'narration', media: 'pack/line.m4a', start_ms: 0, duration_ms: 1500, text: 'Up it goes', volume: 1 },
    ],
  };
}

function plateStory() {
  return {
    storylang_version: 0,
    title: 'A plate story',
    cast: {},
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{ place: 'glade', plate: { poster: 'pack/poster.png', video: 'pack/plate.mp4' }, steps: [
      { kind: 'cmd', cmd: 'pause', seconds: 1 },
    ] }],
  };
}

// One fake clock per test, however many players it mounts.
const mocked = new WeakSet();

async function mount(t, { story = fourSeconds(), options = {} } = {}) {
  if (!mocked.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mocked.add(t);
  }
  const dom = installDom();
  t.after(dom.restore);
  const browser = installRecordingBrowser(t);
  const frames = virtualFrames();
  t.after(frames.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story, assetBase: 'https://storage.example/', ...options });
  t.after(() => player.destroy());
  await player.ready.catch(() => {});
  const root = host.shadowRoot;
  return {
    player, frames, browser, root,
    item: findByClass(root, 'save-button'),
    status: findByClass(root, 'recording-status'),
    label: findByClass(root, 'recording-label'),
    action: findByClass(root, 'recording-action'),
    dismiss: findByClass(root, 'recording-dismiss'),
    canvas: findByClass(root, 'stage-canvas'),
    start: findByClass(root, 'start-button'),
  };
}

test('the menu records the story from its start, muted, and offers the finished file', async (t) => {
  const take = await mount(t);
  const { player, frames, browser, item, status, label, action, canvas } = take;
  assert.equal(item.hidden, false, 'a canvas story on a device that can record has no save row');
  take.start.dispatch('click');
  await settle();
  frames.advanceTo(2500);
  assert.equal(player.getState().tMs, 2500);

  item.dispatch('click');
  assert.equal(browser.contexts.length, 1, 'the audio graph was not built inside the press');
  assert.equal(browser.contexts[0].resumed, 1);
  await settle();
  const [recorder] = browser.recorders;
  assert.ok(recorder, 'no recorder was started');
  assert.deepEqual(recorder.stream.tracks, ['video-track@24', 'audio-track'], 'the take is not the canvas and the graph');
  assert.equal(recorder.options.mimeType, 'video/mp4;codecs=avc1.42E01F,mp4a.40.2');
  assert.equal(browser.contexts[0].speakers.gain.value, 0, 'the room hears the take');
  assert.deepEqual([canvas.width, canvas.height], [1280, 720], 'the take is not drawn at its own frame');
  assert.equal(player.getState().tMs, 0, 'the take did not start from the beginning');
  assert.equal(player.getState().playing, true);
  assert.equal(status.hidden, false);
  assert.equal(label.textContent, 'saving video · 0:00 / 0:04');
  assert.equal(item.disabled, true, 'a second take could be started over the first');
  // Every sound of the take is one the recording hears.
  assert.ok(browser.audio.length > 0);
  assert.ok(browser.contexts[0].sources.length > 0, 'the story’s sound did not go through the graph');

  // Seeking is locked; pausing pauses the recording with the story.
  player.seek(3000);
  assert.equal(player.getState().tMs, 0, 'a seek moved the take');
  frames.advanceTo(3500);
  assert.equal(label.textContent, 'saving video · 0:01 / 0:04');
  player.pause();
  assert.equal(recorder.state, 'paused');
  player.play();
  assert.equal(recorder.state, 'recording');

  frames.advanceTo(7000);
  assert.equal(player.getState().ended, true);
  assert.equal(label.textContent, 'finishing the video…');
  assert.equal(recorder.state, 'recording', 'the last word is not in the file');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(recorder.state, 'inactive');
  assert.equal(label.textContent, 'video ready');
  assert.equal(action.hidden, false);
  assert.equal(item.disabled, false);
  assert.deepEqual([canvas.width, canvas.height], [1920, 1080], 'the screen was left at the take’s frame');
  assert.equal(browser.contexts[0].closed, 1, 'the take’s audio graph outlived it');

  action.dispatch('click');
  await settle();
  const [download] = browser.downloads;
  assert.equal(download.name, 'Sam and the kite.mp4');
  assert.equal(download.type, 'video/mp4');
  assert.equal(status.hidden, true);
});

test('a take the viewer stops hands over nothing and leaves the story where it was', async (t) => {
  const { player, frames, browser, item, status, dismiss } = await mount(t);
  findByClass(status.parent, 'start-button')?.dispatch('click');
  await settle();
  item.dispatch('click');
  await settle();
  frames.advanceTo(1500);
  const recorder = browser.recorders[0];
  assert.equal(dismiss.textContent, 'cancel');
  dismiss.dispatch('click');
  await settle();
  assert.equal(recorder.state, 'inactive');
  assert.equal(status.hidden, true);
  assert.equal(player.getState().playing, false, 'a stopped take went on playing');
  assert.equal(player.getState().tMs, 0, 'saving changed the viewer’s playback position');
  // The player is the player again: seeking moves the story.
  player.seek(500);
  assert.equal(player.getState().tMs, 500);
  assert.deepEqual(browser.downloads, []);
});

test('a host keeps the finished file and legacy plate stories expose capture support', async (t) => {
  const take = await mount(t);
  const { player, frames, status } = take;
  const recording = player.recordVideo();
  await settle();
  assert.equal(player.getState().started, true, 'a story nobody had begun was not begun by its take');
  frames.advanceTo(5000);
  t.mock.timers.tick(1000);
  const file = await recording;
  assert.equal(file.name, 'Sam and the kite.mp4');
  assert.equal(status.hidden, true, 'a file the host keeps was offered on the picture too');

  const plate = await mount(t, { story: plateStory() });
  assert.equal(plate.player.canRecordVideo(), true);
  assert.equal(plate.item.hidden, false);
});

test('a host that keeps videos is handed the file on the save press, and a download that is not a function is refused', async (t) => {
  const kept = [];
  const take = await mount(t, { options: { download: (file) => kept.push(file.name) } });
  take.start.dispatch('click');
  await settle();
  take.item.dispatch('click');
  await settle();
  take.frames.advanceTo(5000);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(take.label.textContent, 'video ready');
  assert.deepEqual(kept, [], 'the file was handed over before anybody asked for it');
  take.action.dispatch('click');
  await settle();
  assert.deepEqual(kept, ['Sam and the kite.mp4']);
  assert.deepEqual(take.browser.downloads, [], 'the player downloaded a file its host keeps');

  const refused = await mount(t, { options: { download: 'yes' } });
  await assert.rejects(refused.player.ready, /download must be a function/);
});

test('host export exposes real progress and cancellation without a second save control', async (t) => {
  const take = await mount(t, { options: { videoControls: 'host' } });
  const progress = [];
  const saving = take.player.recordVideo({ onProgress: (state) => progress.push(state) });
  await settle();
  assert.equal(take.item.hidden, true);
  assert.equal(take.status.hidden, true);
  assert.equal(take.player.getState().recording, true);
  take.frames.advanceTo(1500);
  assert.equal(take.player.getVideoExportState().tMs, 1500);
  take.player.pause();
  assert.equal(take.player.getVideoExportState().status, 'paused');
  take.player.play();
  assert.equal(take.player.getVideoExportState().status, 'recording');
  take.player.cancelVideo();
  await assert.rejects(saving, { name: 'AbortError' });
  assert.equal(take.player.getState().recording, false);
  assert.equal(progress.at(-1).status, 'cancelled');
  assert.equal(take.browser.contexts[0].closed, 1);
});

test('a host may lend its own unlocked audio context, which the take uses and leaves open', async (t) => {
  const take = await mount(t, { options: { videoControls: 'host' } });
  const lent = new globalThis.AudioContext();
  take.browser.contexts.length = 0;
  const saving = take.player.recordVideo({ audioContext: lent });
  await settle();
  assert.equal(take.browser.contexts.length, 0);
  assert.equal(lent.resumed, 1);
  take.player.cancelVideo();
  await assert.rejects(saving, { name: 'AbortError' });
  assert.equal(lent.closed, 0);
  await assert.rejects(take.player.recordVideo({ audioContext: {} }), /audioContext must be an AudioContext/);
});

test('an AbortSignal cancels preparation and already-aborted requests never allocate media', async (t) => {
  const take = await mount(t);
  const signal = new AbortController();
  signal.abort();
  await assert.rejects(take.player.recordVideo({ signal: signal.signal }), { name: 'AbortError' });
  assert.equal(take.browser.contexts.length, 0);
  const fresh = new AbortController();
  const saving = take.player.recordVideo({ signal: fresh.signal });
  fresh.abort();
  await assert.rejects(saving, { name: 'AbortError' });
  assert.equal(take.browser.recorders.length, 0);
  assert.equal(take.browser.contexts[0].closed, 1);
});

test('backgrounding holds the take until an explicit resume, including its final audio tail', async (t) => {
  const take = await mount(t);
  const saving = take.player.recordVideo();
  await settle();
  take.frames.advanceTo(1000);
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.equal(take.browser.recorders[0].state, 'paused');
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  assert.equal(take.player.getState().playing, false);
  assert.equal(take.player.getVideoExportState().status, 'paused');
  take.player.play();
  take.frames.advanceTo(6000);
  assert.equal(take.player.getVideoExportState().status, 'finishing');
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(take.browser.recorders[0].state, 'paused');
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  assert.equal(take.browser.recorders[0].state, 'paused');
  take.player.play();
  t.mock.timers.tick(1000);
  assert.ok((await saving).size > 0);
});

/**
 * The browser's recording surface: canvas capture, an audio graph, streams and
 * a recorder, each one remembering what it was asked.
 */
function installRecordingBrowser(t) {
  const saved = {
    Audio: globalThis.Audio,
    AudioContext: globalThis.AudioContext,
    MediaRecorder: globalThis.MediaRecorder,
    MediaStream: globalThis.MediaStream,
    HTMLCanvasElement: globalThis.HTMLCanvasElement,
    createObjectURL: URL.createObjectURL,
  };
  const browser = { contexts: [], recorders: [], audio: [], downloads: [] };
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = make(tag);
    if (tag === 'canvas') {
      node.captureStream = (fps) => ({ getVideoTracks: () => [`video-track@${fps}`] });
      // A performance's painter composes its nodes' transforms on the context.
      const context = node.getContext.bind(node);
      node.getContext = (kind) => Object.assign(context(kind), { transform() {} });
    }
    if (tag === 'a') node.click = () => browser.downloads.push(browser.linked.get(node.href));
    return node;
  };
  browser.linked = new Map();
  URL.createObjectURL = (file) => {
    const href = `blob:${browser.linked.size}`;
    browser.linked.set(href, file);
    return href;
  };
  globalThis.HTMLCanvasElement = { prototype: { captureStream() {} } };
  globalThis.Audio = class {
    constructor(url) {
      Object.assign(this, { currentTime: 0, paused: true, volume: 1, attributes: {} });
      if (url !== undefined) this.src = url;
      browser.audio.push(this);
    }

    set src(value) { this.attributes.src = value; }
    get src() { return this.attributes.src ?? ''; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {}
    load() {}
  };
  globalThis.AudioContext = class {
    constructor() {
      Object.assign(this, { resumed: 0, closed: 0, sources: [], destination: {} });
      browser.contexts.push(this);
    }

    resume() { this.resumed += 1; return Promise.resolve(); }
    close() { this.closed += 1; return Promise.resolve(); }
    createGain() { this.speakers = { gain: { value: 1 }, connect() {}, disconnect() {} }; return this.speakers; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => ['audio-track'] }, connect() {}, disconnect() {} }; }
    createMediaElementSource(media) {
      const source = { media, connect() {}, disconnect() {} };
      this.sources.push(source);
      return source;
    }
  };
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks.map((name) => ({ name, stop() {} })); }
  };
  globalThis.MediaRecorder = class {
    static isTypeSupported(type) { return type.startsWith('video/mp4'); }

    constructor(stream, options) {
      Object.assign(this, { stream, options, state: 'inactive', listeners: {} });
      browser.recorders.push(this);
    }

    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }

    stop() {
      this.state = 'inactive';
      for (const handler of this.listeners.dataavailable ?? []) handler({ data: new Blob(['frames']) });
      for (const handler of this.listeners.stop ?? []) handler({});
    }
  };
  t.after(() => {
    globalThis.Audio = saved.Audio;
    globalThis.AudioContext = saved.AudioContext;
    globalThis.MediaRecorder = saved.MediaRecorder;
    globalThis.MediaStream = saved.MediaStream;
    globalThis.HTMLCanvasElement = saved.HTMLCanvasElement;
    URL.createObjectURL = saved.createObjectURL;
  });
  return browser;
}
