import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioDirector } from '../browser/v0/app/directors/audio-director.mjs';

test('starts the narration deadline before waiting for a never-resolving play promise', async (t) => {
  let fireDeadline;
  let deadlineMs;
  let paused = false;
  const originalAudio = globalThis.Audio;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  globalThis.Audio = class {
    addEventListener() {}
    play() { return new Promise(() => {}); }
    pause() { paused = true; }
  };
  globalThis.setTimeout = (callback, milliseconds) => {
    fireDeadline = callback;
    deadlineMs = milliseconds;
    return 19;
  };
  globalThis.clearTimeout = () => {};
  t.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const warnings = [];
  const playback = new AudioDirector({}, (detail) => warnings.push(detail))
    .playNarration('voice.wav', 1_000, 31);
  await Promise.resolve();

  assert.equal(typeof fireDeadline, 'function');
  assert.equal(deadlineMs, 5_000, 'narration deadline did not include the published 4 s grace');
  fireDeadline();
  assert.equal((await playback).ok, false);
  assert.equal(paused, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 31);
});

test('carries the triggering command line on immediate media warnings', () => {
  const warnings = [];
  const audio = new AudioDirector({}, (detail) => warnings.push(detail));

  audio.playSound('missing', 22);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 22);
});

test('cancels a pending sound start at its deadline and suppresses every late effect', async (t) => {
  const media = installPendingAudio(t);
  const warnings = [];
  const audio = new AudioDirector({ sfx: { pop: 'pop.wav' } }, (detail) => warnings.push(detail));

  audio.playSound('pop', { scene_index: 2, line: 18 });

  assert.equal(typeof media.fireDeadline(), 'function');
  media.fireDeadline()();
  await Promise.resolve();
  assert.equal(media.instance().playing, false);
  assert.equal(media.instance().removed, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].scene_index, 2);
  assert.equal(warnings[0].line, 18);

  media.resolvePlay();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(media.instance().playing, false);
  assert.equal(warnings.length, 1);
});

test('cancels a pending music start at its deadline so it cannot begin late', async (t) => {
  const media = installPendingAudio(t);
  const warnings = [];
  const audio = new AudioDirector({ bgm: { calm: 'calm.mp3' } }, (detail) => warnings.push(detail));

  audio.setMusic('calm', { scene_index: 1, line: 9 });

  assert.equal(typeof media.fireDeadline(), 'function');
  media.fireDeadline()();
  await Promise.resolve();
  assert.equal(media.instance().playing, false);
  assert.equal(media.instance().removed, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].scene_index, 1);
  assert.equal(warnings[0].line, 9);

  media.resolvePlay();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(media.instance().playing, false);
  assert.equal(warnings.length, 1);
});

test('music uses the published full, ducked, crossfade, and duck-ramp policy', async (t) => {
  const originalAudio = globalThis.Audio;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindow = globalThis.window;
  const animations = [];
  const timers = new Map();
  const instances = [];
  let now = 0;
  let timerId = 0;

  globalThis.performance = { now: () => now };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.requestAnimationFrame = (callback) => { animations.push(callback); return animations.length; };
  globalThis.setTimeout = (callback, milliseconds) => {
    timerId += 1;
    timers.set(timerId, { callback, milliseconds });
    return timerId;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.Audio = class {
    constructor(url) {
      this.url = url;
      this.volume = 1;
      instances.push(this);
    }

    addEventListener() {}
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.removed = true; }
  };
  t.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.window = originalWindow;
  });

  const audio = new AudioDirector({ bgm: { calm: 'calm.mp3', other: 'other.mp3' } });
  audio.setMusic('calm');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const music = instances[0];
  assert.equal(music.volume, 0);
  now = 850;
  animations.shift()(now);
  assert.equal(music.volume, 0.38);

  audio.setMusic('other');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const replacement = instances[1];
  now = 1_275;
  animations.shift()(now);
  animations.shift()(now);
  assert.equal(replacement.volume, 0.19);
  assert.equal(music.volume, 0.19);
  now = 1_700;
  animations.shift()(now);
  animations.shift()(now);
  await Promise.resolve();
  assert.equal(replacement.volume, 0.38);
  assert.equal(music.volume, 0);
  assert.equal(music.paused, true);
  assert.equal(music.removed, true);

  const narration = audio.playNarration('voice.wav', 1_000);
  now = 1_920;
  animations.shift()(now);
  assert.equal(replacement.volume, 0.14);

  const deadline = [...timers.values()].find(({ milliseconds }) => milliseconds === 5_000);
  assert.ok(deadline, 'narration grace deadline was not armed');
  deadline.callback();
  await narration;

  now = 2_140;
  animations.shift()(now);
  assert.equal(replacement.volume, 0.38);
});

function installPendingAudio(t) {
  const originalAudio = globalThis.Audio;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let deadline;
  let resolvePlay;
  let instance;

  globalThis.Audio = class {
    constructor() {
      instance = this;
      this.playing = false;
      this.removed = false;
    }

    addEventListener() {}

    play() {
      return new Promise((resolve) => {
        resolvePlay = () => {
          this.playing = true;
          resolve();
        };
      });
    }

    pause() { this.playing = false; }

    removeAttribute(name) {
      if (name === 'src') this.removed = true;
    }
  };
  globalThis.setTimeout = (callback) => { deadline = callback; return 23; };
  globalThis.clearTimeout = () => {};
  t.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  return {
    fireDeadline: () => deadline,
    instance: () => instance,
    resolvePlay: () => resolvePlay(),
  };
}
