import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { createMediaScheduler } from '../browser/v0/app/media-scheduler.mjs';
import { createCanvasStage } from '../browser/v0/app/stage/canvas-stage.mjs';
import { resolveStoryAssets } from '../browser/v0/app/urls.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
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

  // The gate's fetches were already in flight when destroy ran; let them settle.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(host.shadowRoot.children.length, 0, 'late preload work repainted a destroyed player');
});

test('a mounted player really got its canvas', async (t) => {
  // Both ways the stage can end up with no context are unit-tested; what this
  // asks is that the SHIPPED wiring hits neither. Drop `canvas` from the
  // template's element bag, or rename the class, and the player warns once and
  // then draws nothing for the rest of the story — over a plate that plays and
  // subtitles that keep coming, which is exactly the kind of failure somebody
  // calls "the video is fine but the animals are gone".
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: loadingStory(),
    assetBase: 'https://storage.example/',
  });
  await player.ready;

  const lines = [...findByClass(host.shadowRoot, 'event-list').children]
    .map((entry) => entry.childNodes.at(-1)?.textContent ?? '');
  assert.deepEqual(lines.filter((line) => /stage-canvas|canvas context/.test(line)), []);
  player.destroy();
});

test('a destroyed host can be remounted without sharing the old controller', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const story = loadingStory();
  const first = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
  await first.ready;
  assert.equal(host.shadowRoot.listenerCount('keydown'), 1);
  first.destroy();
  assert.equal(host.shadowRoot.listenerCount('keydown'), 0, 'the old debug hotkey survived destroy');

  const second = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
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

test('scheduler destroy releases a sound whose play never settled, and survives its refusal', async (t) => {
  const originalAudio = globalThis.Audio;
  let refusePlay;
  let media;
  globalThis.Audio = fakeAudio((instance) => {
    media = instance;
    return new Promise((_, reject) => { refusePlay = reject; });
  });
  t.after(() => { globalThis.Audio = originalAudio; });

  const warnings = [];
  const scheduler = createMediaScheduler({ ...bellStory(), onWarning: (detail) => warnings.push(detail) });
  scheduler.advance(0, 1);
  scheduler.destroy();
  assert.equal(media.paused, true);
  assert.equal(media.removed, true);

  // A browser rejects the `play()` promise of a medium that was paused before
  // it started, and that rejection arrives after teardown. It must land in the
  // scheduler's own catch — an unhandled rejection here would take the page's
  // error handler with it — and it must not add a warning to a player that is
  // already gone.
  refusePlay(new DOMException('interrupted by pause', 'AbortError'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(warnings, []);
});

test('failed opening preloads resolve ready but record a structured warning', async (t) => {
  const dom = installDom({ assets: () => ({ status: 404 }) });
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: loadingStory(),
    assetBase: 'https://storage.example/',
  });

  await player.ready;
  const entries = findByClass(host.shadowRoot, 'event-list').children;
  // One line per broken asset, and the poster is this story's only one: the
  // gate does not add a summary on top of what already named the file.
  assert.equal(entries.length, 1);
  assert.match(entries[0].childNodes.at(-1).textContent, /dell\.jpg answered 404/);
  player.destroy();
});

test('a sound that fails is released once, not again at teardown', async (t) => {
  const originalAudio = globalThis.Audio;
  let media;
  globalThis.Audio = fakeAudio((instance) => {
    media = instance;
    return new Promise(() => {});
  });
  t.after(() => { globalThis.Audio = originalAudio; });

  const warnings = [];
  const scheduler = createMediaScheduler({ ...bellStory(), onWarning: (detail) => warnings.push(detail) });
  scheduler.advance(0, 1);
  media.fire('error');
  const releasedPauses = media.pauses;
  assert.equal(releasedPauses, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /sound playback failed/);
  scheduler.destroy();
  assert.equal(media.pauses, releasedPauses, 'destroy found a failed sound retained in the owned-media set');
});

test('synchronous audio unlock failure becomes a warning and playback still starts', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  window.AudioContext = class { constructor() { throw new Error('blocked constructor'); } };
  const story = { ...loadingStory(), scenes: [{ ...loadingStory().scenes[0], steps: [] }] };
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story, assetBase: 'https://storage.example/' });
  await player.ready;
  findByClass(host.shadowRoot, 'start-button').dispatch('click');
  assert.equal(findByClass(host.shadowRoot, 'start-ceremony').classList.contains('is-gone'), true);
  assert.equal(findByClass(host.shadowRoot, 'event-list').children.length, 1);
  player.destroy();
});

test('destroy during active playback cancels clock work and plate readiness listeners', async (t) => {
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
  await player.ready;
  const video = findByClass(host.shadowRoot, 'plate-video');
  findByClass(host.shadowRoot, 'start-button').dispatch('click');
  for (let turn = 0; turn < 12 && media.length < 2; turn += 1) await Promise.resolve();
  assert.equal(media.length, 2, 'music and narration did not both start');
  // `playing`, not `canplay`: the canvas-era plate waits for the first frame to
  // be on screen, not for the browser's opinion that it could start. Corrected
  // while this test was still skipped, so whoever un-skips it in phase 8 gets a
  // red for a real reason or none at all.
  assert.equal(video.listenerCount('playing'), 1);
  // The only timer a performance arms now is the plate's readiness deadline.
  // The narration one is gone with the director that awaited each line: the
  // schedule is compiled, so a file that never starts costs the story nothing
  // and needs no clock to notice it.
  assert.ok([...timers.values()].some(({ milliseconds }) => milliseconds === 6_000));
  player.destroy();
  assert.equal(video.listenerCount('playing'), 0);
  assert.equal(video.listenerCount('error'), 0);
  assert.equal(host.shadowRoot.childNodes.length, 0);
  assert.equal(timers.size, 0, 'destroy left playback or readiness timers armed');
  for (const item of media) {
    assert.equal(item.paused, true);
    assert.equal(item.removed, true);
  }
  await Promise.resolve();
});

test('stage destroy stops observing the frame, exactly once', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  let disconnected = 0;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() { disconnected += 1; }
  };
  const stage = createCanvasStage(fakeStageElements());
  stage.destroy();
  stage.destroy();
  assert.equal(disconnected, 1, 'the resize observer outlived the stage, or was disconnected twice');
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
  await player.ready;

  findByText(host.shadowRoot, 'download').dispatch('click');
  assert.equal(timers.size, 2);
  player.destroy();
  assert.equal(timers.size, 0);
  assert.deepEqual(revoked, ['blob:story-log']);
});

test('the downloaded session is the compiled timeline with the log beside it', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let captured = null;
  URL.createObjectURL = (blob) => { captured = blob; return 'blob:story-log'; };
  URL.revokeObjectURL = () => {};
  t.after(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
  const host = document.createElement('div');
  const story = loadingStory();
  const player = createStoryPlayer(host, { story, assetBase: 'https://storage.example/', debug: true });
  await player.ready;

  findByText(host.shadowRoot, 'download').dispatch('click');
  const payload = JSON.parse(await captured.text());
  const timeline = compileTimeline(resolveStoryAssets(story, 'https://storage.example/'));

  // `jq .events` on a downloaded session and on the engine's own
  // `story.timeline.json` have to be the same question — that diff is what
  // proves both ran the same compiler.
  assert.deepEqual(payload.events, timeline.events);
  assert.equal(payload.timeline_version, timeline.timeline_version);
  assert.equal(payload.duration_ms, timeline.duration_ms);
  assert.ok(Array.isArray(payload.log), 'the log went missing from the download');
  player.destroy();
});

/** One sound effect at t=0, which is the smallest thing the scheduler plays. */
function bellStory() {
  return {
    timeline: {
      timeline_version: 1,
      storylang_version: 0,
      duration_ms: 1_000,
      events: [{
        source: 'step',
        kind: 'cmd',
        cmd: 'sound',
        t_ms: 0,
        detail: { name: 'bell' },
        line: 3,
        scene_index: 0,
      }],
    },
    bundle: {
      storylang_version: 0,
      audio: { sfx: { bell: 'https://storage.example/assets/bell.wav' }, bgm: {} },
    },
  };
}

/** An `Audio` whose `play()` settles however the test wants it to. */
function fakeAudio(onPlay = () => Promise.resolve()) {
  return class {
    constructor(url) {
      this.url = url;
      this.paused = true;
      this.removed = false;
      this.pauses = 0;
      this.volume = 1;
      this.listeners = new Map();
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    fire(type) { this.listeners.get(type)?.({ type }); }
    play() { this.paused = false; return onPlay(this); }
    pause() { this.paused = true; this.pauses += 1; }
    removeAttribute() { this.removed = true; }
  };
}

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
