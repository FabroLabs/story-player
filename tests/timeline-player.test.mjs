/**
 * The runtime, driven frame by frame under a clock the test owns.
 *
 * `requestAnimationFrame` and `performance.now` are both replaced, so a
 * "scripted run" here is exact: the loop fires at the instants this file names
 * and at no others. That is what makes the first test worth anything — the
 * picture on the canvas is compared against `stateAt` at those same instants,
 * so a runtime that drifted, double-counted its slice or drew a stale frame has
 * nowhere to hide.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { createBitmapCache } from '../browser/v0/app/assets/bitmap-cache.mjs';
import { createSceneLoader } from '../browser/v0/app/assets/scene-loader.mjs';
import { sceneSheets } from '../browser/v0/app/stage/canvas-stage.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { resolveStoryAssets } from '../browser/v0/app/urls.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { read } from './_parity.mjs';
import { installDom } from './_dom.mjs';

const STEM = 'golden_push_dusk';
const ASSET_BASE = 'https://storage.example/';
// Half a pixel of stage at 1920 wide. The loop redraws only when the picture
// changed, and "changed" is measured on rounded coordinates — so a frame it
// legitimately skipped can sit up to a fifth of a pixel from the exact answer.
const TOLERANCE_PX = 1.5;

test('a scripted run draws the picture stateAt describes, at every instant sampled', async (t) => {
  const player = await mount(t);
  const { bundle, timeline } = player;
  const reference = await referenceSheets(bundle, timeline);

  player.start();
  const sampled = samples(timeline);
  assert.ok(sampled.length >= 4, 'the corpus story gave too few instants to prove anything');

  for (const at of sampled) {
    player.frames.advanceTo(at);
    const state = stateAt(timeline, bundle, at);
    assert.equal(player.subtitle.textContent, state.subtitle, `the subtitle at ${at} ms is not the one stateAt says`);
    const expected = buildDrawList(state, reference).commands
      .filter((command) => command.op === 'sprite' && reference.drawable(command.url))
      .map((command) => command.dx);
    const drawn = spriteXs(player.canvas.context);
    assert.equal(drawn.length, expected.length, `the canvas drew ${drawn.length} sprites at ${at} ms, not ${expected.length}`);
    for (const [index, x] of expected.entries()) {
      assert.ok(
        Math.abs(drawn[index] - x) <= TOLERANCE_PX,
        `sprite ${index} is at ${drawn[index]} and stateAt puts it at ${x} (${at} ms)`,
      );
    }
  }
  player.destroy();
});

test('pausing freezes the picture and the sound together', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(2_000);

  const picture = spriteXs(player.canvas.context);
  const spoken = player.subtitle.textContent;
  const at = player.bar.at.textContent;
  player.bar.toggle.dispatch('click');

  assert.equal(player.video.paused, true, 'the plate kept playing under a paused story');
  assert.equal(player.audio.every((media) => media.paused), true, 'a narration kept playing under a paused story');
  assert.equal(player.frames.pending(), 0, 'a paused story is still asking for frames');

  player.frames.advanceTo(40_000);
  assert.deepEqual(spriteXs(player.canvas.context), picture, 'the picture moved while the story was paused');
  assert.equal(player.subtitle.textContent, spoken);
  assert.equal(player.bar.at.textContent, at, 'story time ran on while the story was paused');

  player.bar.toggle.dispatch('click');
  assert.equal(player.bar.at.textContent, at, 'resuming jumped the story forward by the time it stood still');
  assert.equal(player.video.paused, false);
  player.destroy();
});

test('a hidden tab stops the clock, and coming back continues from the same instant', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(3_000);
  const at = player.bar.at.textContent;

  player.hide();
  assert.equal(player.video.paused, true);
  assert.equal(player.frames.pending(), 0, 'a hidden story is still asking for frames');
  player.frames.advanceTo(120_000);
  assert.equal(player.bar.at.textContent, at, 'the story ran on in a hidden tab');

  player.show();
  assert.equal(player.video.paused, false, 'coming back did not continue the story');
  assert.equal(player.bar.at.textContent, at);
  assert.ok(player.frames.pending() > 0, 'coming back did not restart the loop');
  player.destroy();
});

test('the end idles: the plate stops, the loop stops, and the transport offers a replay', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(player.timeline.duration_ms);

  assert.equal(player.end.hidden, false, 'the story ended without saying so');
  assert.equal(player.video.paused, true, 'the plate video is still playing after the end');
  assert.equal(player.frames.pending(), 0, 'an ended story is still asking for frames');
  assert.equal(player.audio.every((media) => media.paused), true, 'sound outlived the story');
  assert.equal(player.bar.toggle.getAttribute('aria-label'), 'replay');

  // Replay is the same button, and it takes the story back to its opening.
  player.bar.toggle.dispatch('click');
  assert.equal(player.end.hidden, true);
  assert.equal(player.bar.at.textContent, '0:00');
  assert.ok(player.frames.pending() > 0, 'replay did not restart the loop');
  player.destroy();
});

test('destroy stops the loop and releases the plate, whatever the story was doing', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(1_500);

  player.destroy();
  assert.equal(player.frames.pending(), 0, 'a destroyed player is still asking for frames');
  assert.equal(player.video.paused, true);
  assert.equal(player.audio.every((media) => media.paused && media.removed), true);
});

test('a backward seek keeps the picture coming', async (t) => {
  const player = await mount(t);
  // Both instants comfortably inside the story: past the end it would have
  // idled, and an idle story is meant to stop rendering.
  const from = Math.round(player.timeline.duration_ms * 0.6);
  const back = Math.round(player.timeline.duration_ms * 0.2);
  player.start();
  player.frames.advanceTo(from);
  const before = player.subtitle.textContent;

  const box = player.bar.scrub.getBoundingClientRect();
  player.bar.scrub.dispatch('pointerdown', { clientX: box.left + (box.width * 0.2), pointerId: 1 });
  assert.equal(player.bar.at.textContent, clockText(back));
  // The throttle is measured on the frame's clock, not the story's. Measured on
  // story time, these ten seconds of frames would all be refused — a frozen
  // picture over a running plate until the story climbed back to 20 s.
  const drawnAfterSeek = new Set();
  for (let at = from + 100; at <= from + 1_000; at += 100) {
    player.frames.advanceTo(at);
    drawnAfterSeek.add(player.bar.at.textContent);
  }
  assert.deepEqual(
    [...drawnAfterSeek],
    [clockText(back), clockText(back + 1_000)],
    'the loop stopped rendering after a backward seek',
  );
  assert.notEqual(player.subtitle.textContent, before === '' ? 'never equal' : before);
  player.destroy();
});

test('pausing between two frames does not start the line it is standing on', async (t) => {
  const player = await mount(t);
  const cue = firstNarrationAfter(player.timeline, 1_000);
  player.start();
  // The last frame lands just before a line, and the click lands just after it:
  // the ordinary case, because a click never coincides with a frame.
  player.frames.advanceTo(cue - 30);
  const opened = player.audio.length;
  player.frames.setWall(cue + 10);
  player.bar.toggle.dispatch('click');

  assert.equal(player.audio.length, opened, 'the pause itself started the next line');
  assert.equal(player.audio.every((media) => media.paused), true, 'a line is sounding over a paused picture');
  player.frames.advanceTo(cue + 5_000);
  assert.equal(player.audio.every((media) => media.paused), true, 'a paused story started talking on its own');
  player.destroy();
});

test('seeking a paused story places the sound without playing it', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(2_000);
  player.bar.toggle.dispatch('click');

  const box = player.bar.scrub.getBoundingClientRect();
  player.bar.scrub.dispatch('pointerdown', { clientX: box.left + (box.width * 0.3), pointerId: 1 });
  assert.equal(player.audio.every((media) => media.paused), true, 'scrubbing a paused story talks');

  player.bar.toggle.dispatch('click');
  assert.equal(player.audio.some((media) => !media.paused), true, 'the sound the seek placed never resumed');
  player.destroy();
});

test('the transport is deaf until the story begins', async (t) => {
  const player = await mount(t);

  player.frame.dispatch('keydown', { key: ' ', target: player.startButton });
  player.frame.dispatch('keydown', { key: 'End', target: player.startButton });
  player.frames.advanceTo(4_000);

  assert.equal(player.bar.at.textContent, '0:00', 'the keyboard started a story that was never begun');
  assert.equal(player.video.paused, true);
  assert.equal(player.end.hidden, true, 'End showed the end of a story that never started');
  assert.equal(player.ceremony.classList.contains('is-gone'), false);
  assert.equal(player.frames.pending(), 0);
  player.destroy();
});

test('space belongs to whichever control has focus', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(1_000);

  // A keydown bubbles from the focused button in a real browser; swallowing it
  // here would leave a keyboard user unable to press `cc` or `log` at all.
  player.frame.dispatch('keydown', { key: ' ', target: { tagName: 'BUTTON' } });
  assert.equal(player.bar.toggle.getAttribute('aria-label'), 'pause', 'space on a focused button toggled playback');

  player.frame.dispatch('keydown', { key: ' ', target: player.frame });
  assert.equal(player.bar.toggle.getAttribute('aria-label'), 'play');
  player.destroy();
});

test('a cut swaps the plate and says which scene the story is in', async (t) => {
  const player = await mount(t);
  const cut = player.timeline.events.find(
    (event) => event.source === 'stage' && event.op === 'scene' && event.scene_index === 1,
  );
  assert.ok(cut, 'the corpus story has no second scene to cut to');
  player.start();
  player.frames.advanceTo(cut.t_ms - 100);
  const first = { src: player.video.src, badge: player.badge.textContent };

  player.frames.advanceTo(cut.t_ms + 100);
  assert.equal(player.badge.textContent, `scene 2 of ${player.bundle.scenes.length}`);
  assert.notEqual(player.video.src, first.src, 'the plate stayed on the last scene');
  assert.equal(player.video.src, player.bundle.scenes[1].plate.video);
  player.destroy();
});

test('a warning stateAt repeats every frame is logged once', async (t) => {
  // `stateAt` hands back every warning raised up to t, so the same sentence
  // arrives on every frame for the rest of the story. Unpinned, a regression
  // floods the panel twenty-four times a second.
  const player = await mount(t, (story) => {
    const [slug] = Object.keys(story.cast);
    story.cast[slug].clips = {};
  });
  player.start();
  for (let at = 200; at <= 12_000; at += 200) player.frames.advanceTo(at);

  // What the log should hold is one line per DISTINCT warning raised up to
  // here — not one per frame that repeated it.
  const at = (tMs) => stateAt(player.timeline, player.bundle, tMs).warnings.map((w) => JSON.stringify(w));
  const early = at(4_000);
  const late = at(12_000);
  assert.ok(early.length > 0, 'the doctored story raised no warning at all');
  assert.equal(
    early.every((warning) => late.includes(warning)),
    true,
    'the state core stopped carrying old warnings forward, so this proves nothing',
  );
  assert.equal(
    player.entries(),
    new Set(late).size,
    'a warning stateAt repeats on every frame reached the log more than once',
  );
  player.destroy();
});

/** The transport's own clock text, so a test never hand-writes `0:10`. */
function clockText(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The first narration cue at or after `fromMs`, as the runtime would cross it. */
function firstNarrationAfter(timeline, fromMs) {
  const cue = timeline.events.find(
    (event) => event.source === 'step' && event.kind === 'chunk'
      && event.t_ms >= fromMs && typeof event.detail?.audio === 'string',
  );
  assert.ok(cue, 'the corpus story has no narration to pause on');
  return cue.t_ms;
}

/**
 * A mounted player with the wall clock, the frame loop and `Audio` in the
 * test's hands. `story` is the parity corpus, so what plays is a real compile
 * of a real bundle rather than a fixture written to suit the runtime.
 */
async function mount(t, doctor = () => {}) {
  const dom = installDom();
  const frames = virtualFrames();
  const audio = installAudio();
  t.after(() => {
    audio.restore();
    frames.restore();
    dom.restore();
  });

  const raw = read(STEM, 'bundle');
  doctor(raw);
  const bundle = resolveStoryAssets(structuredClone(raw), ASSET_BASE);
  const timeline = compileTimeline(bundle);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story: raw, assetBase: ASSET_BASE });
  await player.ready;

  const root = host.shadowRoot;
  const document_ = globalThis.document;
  return {
    bundle,
    timeline,
    frames,
    audio: audio.opened,
    canvas: findByClass(root, 'stage-canvas'),
    subtitle: findByClass(root, 'subtitle'),
    video: findByClass(root, 'plate-video'),
    end: findByClass(root, 'end-overlay'),
    bar: {
      at: findByClass(root, 'time-at'),
      toggle: findByClass(root, 'play-button'),
      back: findByClass(root, 'skip-back'),
      scrub: findByClass(root, 'scrub'),
      root: findByClass(root, 'controls'),
    },
    frame: findByClass(root, 'stage-frame'),
    badge: findByClass(root, 'story-scene'),
    ceremony: findByClass(root, 'start-ceremony'),
    startButton: findByClass(root, 'start-button'),
    entries: () => findByClass(root, 'event-list').children.length,
    start: () => findByClass(root, 'start-button').dispatch('click'),
    hide() {
      document_.visibilityState = 'hidden';
      document_.dispatch('visibilitychange');
    },
    show() {
      document_.visibilityState = 'visible';
      document_.dispatch('visibilitychange');
    },
    destroy: () => player.destroy(),
  };
}

/** The same sheets the runtime planned, decoded into a cache of our own. */
async function referenceSheets(bundle, timeline) {
  const cache = createBitmapCache();
  const viewport = { fitScale: 1, dpr: 1 };
  const loader = createSceneLoader({ timeline, bundle, cache });
  await loader.loadScene(0, viewport, { keep: true });
  return sceneSheets(loader.plan(0, viewport), cache);
}

/**
 * Instants inside the opening scene: every op, and the middle of every op that
 * takes time. Only the opening, because that is the scene the begin gate has
 * decoded — a later one would be compared against sheets that may still be
 * loading, and the test would be about the queue rather than the loop.
 */
function samples(timeline) {
  const events = timeline.events.filter((event) => event.source === 'stage' && event.scene_index === 0);
  const next = timeline.events.find(
    (event) => event.source === 'stage' && event.op === 'scene' && event.scene_index === 1,
  );
  const limit = next ? next.t_ms - 1 : timeline.duration_ms;
  const instants = new Set();
  for (const event of events) {
    instants.add(event.t_ms + 1);
    if (Number.isFinite(event.duration_ms) && event.duration_ms > 0) {
      instants.add(event.t_ms + Math.round(event.duration_ms / 2));
    }
  }
  const picked = [];
  // At least one frame interval apart, so every sample is an instant the loop
  // really renders at rather than one it throttles past.
  for (const at of [...instants].sort((left, right) => left - right)) {
    if (at > 0 && at < limit && (!picked.length || at - picked.at(-1) >= 60)) picked.push(at);
  }
  return picked.slice(0, 8);
}

/** Where each sprite of the LAST painted frame was drawn, in plate pixels. */
function spriteXs(context) {
  const names = context.calls.map(([name]) => name);
  const from = names.lastIndexOf('clearRect');
  return context.calls
    .slice(from < 0 ? 0 : from)
    .filter((call) => call[0] === 'drawImage' && call.length === 11)
    .map((call) => call[6]);
}

function virtualFrames() {
  const queue = new Map();
  const originalNow = performance.now;
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let wall = 0;
  let nextId = 1;
  performance.now = () => wall;
  globalThis.requestAnimationFrame = (callback) => {
    const id = nextId;
    nextId += 1;
    queue.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => queue.delete(id);
  return {
    advanceTo(milliseconds) {
      wall = milliseconds;
      const pending = [...queue.values()];
      queue.clear();
      for (const callback of pending) callback(wall);
    },
    // Wall time WITHOUT a frame, which is what every click really is: a viewer
    // presses pause between two frames, and the runtime is then asked about an
    // instant it has never rendered.
    setWall(milliseconds) {
      wall = milliseconds;
    },
    pending: () => queue.size,
    restore() {
      performance.now = originalNow;
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

function installAudio() {
  const opened = [];
  const original = globalThis.Audio;
  globalThis.Audio = class {
    constructor(url) {
      this.url = url;
      this.paused = true;
      this.removed = false;
      this.volume = 1;
      this.currentTime = 0;
      this.listeners = new Map();
      opened.push(this);
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.removed = true; }
  };
  return { opened, restore: () => { globalThis.Audio = original; } };
}

function findByClass(root, name) {
  if (root.className?.split(/\s+/).includes(name)) return root;
  for (const child of root.children ?? []) {
    const found = findByClass(child, name);
    if (found) return found;
  }
  return null;
}
