import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { AudioDirector } from '../browser/v0/app/directors/audio-director.mjs';
import { StageRenderer } from '../browser/v0/app/stage/stage-renderer.mjs';
import { fakeStageElements, installDom } from './_dom.mjs';

function loadingStory() {
  return {
    storylang_version: 0,
    title: 'Waiting',
    cast: {},
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      place: 'dell',
      plate: {
        poster: 'fairytale-assets/plates/dell.jpg',
        video: 'fairytale-assets/plates/dell.mp4',
      },
      steps: [],
    }],
  };
}

test('destroy before ready aborts preload, settles ready, and removes the surface', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: loadingStory(),
    assetBase: 'https://storage.example/',
  });

  player.destroy();
  player.destroy();
  await assert.rejects(player.ready, (error) => error?.name === 'AbortError');
  assert.equal(host.shadowRoot.children.length, 0);

  dom.lastImage()?.dispatch('load');
  await Promise.resolve();
  assert.equal(host.shadowRoot.children.length, 0, 'late preload work repainted a destroyed player');
});

test('a destroyed host can be remounted without sharing the old controller', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const story = loadingStory();
  const first = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
  dom.lastImage().dispatch('load');
  await first.ready;
  assert.equal(host.shadowRoot.listenerCount('keydown'), 1);
  first.destroy();
  assert.equal(host.shadowRoot.listenerCount('keydown'), 0, 'the old debug hotkey survived destroy');

  const second = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
  dom.lastImage().dispatch('load');
  await second.ready;
  assert.ok(host.shadowRoot.children.length > 0);
  second.destroy();
});

test('invalid media rejects ready and leaves a concise in-player error', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: {
      ...loadingStory(),
      scenes: [{
        place: 'dell',
        plate: { poster: 'old.jpg', video: 'old.mp4' },
        steps: [],
      }],
    },
    assetBase: 'https://storage.example/',
  });

  await assert.rejects(player.ready, /media path/);
  const status = findByClass(host.shadowRoot, 'load-status');
  assert.match(status.textContent, /media path/);
  assert.equal(status.classList.contains('is-error'), true);
  player.destroy();
});

test('audio destroy cancels a pending media start so late play cannot restart it', async (t) => {
  const originalAudio = globalThis.Audio;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let resolvePlay;
  let media;
  globalThis.setTimeout = () => 71;
  globalThis.clearTimeout = () => {};
  globalThis.Audio = class {
    constructor() {
      media = this;
      this.playing = false;
      this.removed = false;
    }
    addEventListener() {}
    play() {
      return new Promise((resolve) => {
        resolvePlay = () => { this.playing = true; resolve(); };
      });
    }
    pause() { this.playing = false; }
    removeAttribute() { this.removed = true; }
  };
  t.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const audio = new AudioDirector({ sfx: { bell: 'https://storage.example/assets/bell.wav' } });
  audio.playSound('bell');
  audio.destroy();
  resolvePlay();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(media.playing, false);
  assert.equal(media.removed, true);
});

test('failed opening preloads resolve ready but record a structured warning', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: loadingStory(),
    assetBase: 'https://storage.example/',
  });

  dom.lastImage().dispatch('error');
  await player.ready;
  const entries = findByClass(host.shadowRoot, 'event-list').children;
  assert.equal(entries.length, 1);
  assert.match(entries[0].childNodes.at(-1).textContent, /opening preload failed/);
  player.destroy();
});

test('failed sound start is released before whole-player teardown', async (t) => {
  const originalAudio = globalThis.Audio;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let fireDeadline;
  let pauses = 0;
  globalThis.setTimeout = (callback) => { fireDeadline = callback; return 81; };
  globalThis.clearTimeout = () => {};
  globalThis.Audio = class {
    addEventListener() {}
    play() { return new Promise(() => {}); }
    pause() { pauses += 1; }
    removeAttribute() {}
  };
  t.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const audio = new AudioDirector({ sfx: { bell: 'https://storage.example/assets/bell.wav' } });
  audio.playSound('bell');
  fireDeadline();
  await Promise.resolve();
  await Promise.resolve();
  const releasedPauses = pauses;
  audio.destroy();
  assert.equal(pauses, releasedPauses, 'destroy found failed sound retained in the owned-media set');
});

// PHASE-8: pressing start no longer performs anything — the live director is
// gone and the runtime that plays a compiled timeline is the next piece of
// work. Un-skip with it; what these two pin (an unlock failure is survivable,
// destroy releases every timer and listener mid-playback) is unchanged policy.
test.skip('synchronous audio unlock failure becomes a warning and playback still starts', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  window.AudioContext = class { constructor() { throw new Error('blocked constructor'); } };
  const story = { ...loadingStory(), scenes: [{ ...loadingStory().scenes[0], steps: [] }] };
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
  dom.lastImage().dispatch('load');
  await player.ready;
  findByClass(host.shadowRoot, 'start-button').dispatch('click');
  assert.equal(findByClass(host.shadowRoot, 'start-ceremony').classList.contains('is-gone'), true);
  assert.equal(findByClass(host.shadowRoot, 'event-list').children.length, 1);
  player.destroy();
});

test.skip('destroy during active playback cancels clock work and plate readiness listeners', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const originalAudio = globalThis.Audio;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const media = [];
  const timers = new Map();
  let timerId = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    timerId += 1;
    timers.set(timerId, { callback, milliseconds });
    return timerId;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.Audio = class {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      media.push(this);
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    play() { this.playing = true; return Promise.resolve(); }
    pause() { this.playing = false; this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.removed = true; }
  };
  t.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  const story = {
    ...loadingStory(),
    audio: { sfx: {}, bgm: { calm: 'fairytale-assets/audio/calm.mp3' } },
    scenes: [{
      ...loadingStory().scenes[0],
      steps: [
        { kind: 'cmd', cmd: 'music', name: 'calm', line: 2 },
        {
          kind: 'chunk', text: 'A long line.', duration_s: 60,
          audio: 'jobs/story-7/audio/line.wav', line: 3,
        },
      ],
    }],
  };
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
  dom.lastImage().dispatch('load');
  await player.ready;
  const video = findByClass(host.shadowRoot, 'plate-video');
  findByClass(host.shadowRoot, 'start-button').dispatch('click');
  for (let turn = 0; turn < 12 && media.length < 2; turn += 1) await Promise.resolve();
  assert.equal(media.length, 2, 'music and narration did not both start');
  assert.equal(video.listenerCount('canplay'), 1);
  assert.ok([...timers.values()].some(({ milliseconds }) => milliseconds === 64_000));
  player.destroy();
  assert.equal(video.listenerCount('canplay'), 0);
  assert.equal(video.listenerCount('error'), 0);
  assert.equal(host.shadowRoot.childNodes.length, 0);
  assert.equal(timers.size, 0, 'destroy left playback or readiness timers armed');
  for (const item of media) {
    assert.equal(item.paused, true);
    assert.equal(item.removed, true);
  }
  await Promise.resolve();
});

test('stage destroy cancels animation and observation exactly once', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  let disconnected = 0;
  let cancelled = null;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() { disconnected += 1; }
  };
  globalThis.requestAnimationFrame = () => 42;
  globalThis.cancelAnimationFrame = (id) => { cancelled = id; };
  const stage = new StageRenderer(fakeStageElements());
  stage.startAnimation();
  stage.destroy();
  stage.destroy();
  assert.equal(cancelled, 42);
  assert.equal(disconnected, 1);
});

test('destroy clears debug download timers and revokes its object URL', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const timers = new Set();
  const revoked = [];
  let timerId = 0;
  globalThis.setTimeout = () => { timerId += 1; timers.add(timerId); return timerId; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  URL.createObjectURL = () => 'blob:story-log';
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: loadingStory(),
    assetBase: 'https://storage.example/',
  });
  dom.lastImage().dispatch('load');
  await player.ready;

  findByText(host.shadowRoot, 'download').dispatch('click');
  assert.equal(timers.size, 2);
  player.destroy();
  assert.equal(timers.size, 0);
  assert.deepEqual(revoked, ['blob:story-log']);
});

test('stage destroy cancels a pending sprite deadline and detaches its image source', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set();
  let timerId = 0;
  globalThis.setTimeout = () => { timerId += 1; timers.add(timerId); return timerId; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  const stage = new StageRenderer(fakeStageElements());
  stage.placeCharacter('fox', {
    display_name: 'Fox', height_cm: 80,
    clips: { idle: { spritesheet: 'https://storage.example/assets/fox.png', frames: 1 } },
  }, 50, 'idle');
  const image = dom.lastImage();
  assert.equal(timers.size, 1);
  assert.match(image.src, /fox\.png/);

  stage.destroy();
  assert.equal(timers.size, 0);
  assert.equal(image.src, '');
});

function findByClass(root, name) {
  if (root.className?.split(/\s+/).includes(name)) return root;
  for (const child of root.children ?? []) {
    const found = findByClass(child, name);
    if (found) return found;
  }
  return null;
}

function findByText(root, text) {
  if (root.textContent === text) return root;
  for (const child of root.children ?? []) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return null;
}
