import test from 'node:test';
import assert from 'node:assert/strict';
import {
  performanceAudioAt,
  performanceSoundsBetween,
} from '../browser/v0/core/performance/audio.mjs';
import { createMediaScheduler } from '../browser/v0/app/media-scheduler.mjs';

const story = {
  performance: { kind: 'wht' },
  audio: [
    {
      id: 'music',
      kind: 'music',
      media: 'art/music.mp3',
      start_ms: 0,
      end_ms: 10000,
      duration_ms: 3000,
      volume: 0.3,
      loop: true,
      gain_keys: [[5000, 0.2]],
    },
    {
      id: 'voice',
      kind: 'narration',
      media: 'pack/voice.m4a',
      start_ms: 1000,
      duration_ms: 1000,
      volume: 1,
    },
    {
      id: 'chime',
      kind: 'sfx',
      media: 'art/chime.wav',
      start_ms: 2000,
      duration_ms: 200,
      volume: 0.8,
    },
  ],
};
test('continuous playback window, loop offset and authored gain do not depend on speech', () => {
  assert.equal(
    performanceAudioAt(story, 1500).find((c) => c.id === 'music').volume,
    0.3,
  );
  const music = performanceAudioAt(story, 6500)[0];
  assert.equal(music.offset_ms, 500);
  assert.equal(music.volume, 0.2);
  assert.deepEqual(performanceSoundsBetween(story, 2001, 9000), []);
  assert.equal(performanceSoundsBetween(story, 1999, 2001).length, 1);
});
test('browser seek stops one-shots, restores continuous offset and replay permits cues again', async () => {
  const prior = globalThis.Audio;
  const made = [];
  globalThis.Audio = class {
    constructor() {
      this.paused = true;
      this.currentTime = 0;
      made.push(this);
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    addEventListener() {}
    removeAttribute() {}
    load() {}
  };
  try {
    const scheduler = createMediaScheduler({ bundle: story, timeline: {} });
    scheduler.resume();
    scheduler.advance(0, 2100);
    scheduler.tick(2100);
    assert.equal(made.length, 2);
    assert.equal(made[0].volume, 0.3);
    scheduler.seek(6500);
    assert.equal(made[1].paused, true);
    assert.equal(made[0].currentTime, 0.5);
    assert.equal(made[0].volume, 0.2);
    scheduler.seek(0);
    scheduler.advance(0, 2100);
    assert.equal(made.length, 3);
    scheduler.destroy();
    assert.ok(made.every((m) => m.paused));
  } finally {
    globalThis.Audio = prior;
  }
});

test('a bed or song opens for its metadata only, so a long track cannot crowd the pictures off the link', () => {
  const audio = installPendingAudio();
  try {
    const scheduler = createMediaScheduler({ bundle: story, timeline: {} });
    scheduler.resume();
    scheduler.advance(0, 2100);
    const opened = Object.fromEntries(audio.made.map((media) => [media.src, media.preload]));
    assert.equal(opened['art/music.mp3'], 'metadata', 'the bed was downloaded ahead in full');
    assert.equal(opened['art/chime.wav'], 'auto', 'a one-shot must be whole when it is due');
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

/** An Audio whose play() stays pending until the test lets it start; pause() aborts it. */
function installPendingAudio() {
  const prior = globalThis.Audio;
  const made = [];
  globalThis.Audio = class {
    constructor() {
      this.paused = true;
      this.currentTime = 0;
      this.plays = 0;
      this.pending = null;
      made.push(this);
    }
    play() {
      this.paused = false;
      this.plays += 1;
      return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
    }
    start() {
      this.pending?.resolve();
      this.pending = null;
    }
    pause() {
      this.paused = true;
      if (!this.pending) return;
      const error = new Error('The play() request was interrupted by a call to pause().');
      error.name = 'AbortError';
      this.pending.reject(error);
      this.pending = null;
    }
    addEventListener() {}
    removeAttribute() { this.src = ''; }
    load() {}
  };
  return { made, restore: () => { globalThis.Audio = prior; } };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const lines = {
  performance: { kind: 'bedtime' },
  audio: [
    { id: 'one', kind: 'narration', media: 'pack/one.m4a', start_ms: 1000, end_ms: 2000, duration_ms: 1000, volume: 1 },
    { id: 'two', kind: 'narration', media: 'pack/two.m4a', start_ms: 2000, end_ms: 3000, duration_ms: 1000, volume: 1 },
  ],
};

test('a frame inside the last millisecond before a cue boundary keeps both lines steady', async () => {
  const audio = installPendingAudio();
  const warnings = [];
  try {
    const scheduler = createMediaScheduler({ bundle: lines, timeline: {}, onWarning: (w) => warnings.push(w) });
    scheduler.resume();
    // The runtime's slice for the frame at t: advance(previous, t + 1), then tick(t).
    let next = 0;
    const frame = async (t) => {
      scheduler.advance(next, t + 1);
      next = t + 1;
      scheduler.tick(t);
      for (const media of audio.made) if (!media.paused) media.start();
      await settle();
    };
    await frame(1000);
    assert.equal(audio.made.length, 1, 'the first line opened once');
    await frame(1999.5);
    assert.equal(audio.made.length, 1, 'the boundary frame reopened a line or opened the next early');
    assert.equal(audio.made[0].paused, false, 'the first line was interrupted before its end');
    await frame(2016);
    assert.equal(audio.made.length, 2);
    assert.equal(audio.made[0].paused, false, 'a line still speaking was cut at the end of its window');
    assert.equal(audio.made[1].paused, false, 'the second line did not start');
    assert.equal(audio.made[1].plays, 1);
    await frame(3000);
    assert.equal(audio.made[0].paused, true, 'the first line outlived its window by more than the grace');
    assert.equal(audio.made[1].paused, false);
    assert.deepEqual(warnings, []);
  } finally {
    audio.restore();
  }
});

test('a play the scheduler interrupts itself is not a media failure; a refusal still is', async () => {
  const audio = installPendingAudio();
  const warnings = [];
  try {
    const scheduler = createMediaScheduler({ bundle: lines, timeline: {}, onWarning: (w) => warnings.push(w) });
    scheduler.resume();
    scheduler.advance(0, 1001);
    scheduler.tick(1000);
    assert.equal(audio.made.length, 1);
    scheduler.pause();
    await settle();
    assert.deepEqual(warnings, [], 'the pause of a line still loading was reported as a failure');
    scheduler.resume();
    scheduler.tick(1500);
    scheduler.seek(2500);
    await settle();
    assert.deepEqual(warnings, [], 'the release of a line still loading was reported as a failure');
    scheduler.resume();
    const refusal = new Error('play() failed because the user did not interact with the document first.');
    refusal.name = 'NotAllowedError';
    audio.made.at(-1).pending.reject(refusal);
    await settle();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].cue, 'two');
    assert.match(warnings[0].message, /Required story audio failed/);
    scheduler.destroy();
    await settle();
    assert.equal(warnings.length, 1, 'teardown was reported as a failure');
  } finally {
    audio.restore();
  }
});

/** An Audio that records its listeners, so a test can fire `loadedmetadata` or end it. */
function installListeningAudio() {
  const prior = globalThis.Audio;
  const made = [];
  globalThis.Audio = class {
    constructor() {
      this.paused = true;
      this.ended = false;
      this.currentTime = 0;
      this.plays = 0;
      this.listeners = {};
      made.push(this);
    }
    play() { this.paused = false; this.plays += 1; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] ?? []) fn(); }
    removeAttribute() {}
    load() {}
  };
  return { made, restore: () => { globalThis.Audio = prior; } };
}

const voiced = {
  performance: { kind: 'bedtime' },
  audio: [
    { id: 'bed', kind: 'ambience', media: 'pack/bed.m4a', start_ms: 0, end_ms: 20000, duration_ms: 20000, volume: 1 },
    { id: 'line', kind: 'narration', media: 'pack/line.m4a', start_ms: 1000, end_ms: 6000, duration_ms: 3000,
      volume: 1, metadata: { lead_in_ms: 500 } },
    { id: 'bare', kind: 'narration', media: 'pack/bare.m4a', start_ms: 7000, end_ms: 9000, duration_ms: 1500, volume: 1 },
  ],
};

test('a line noticed late starts from its first word; a seek still lands exactly', () => {
  const audio = installListeningAudio();
  try {
    const scheduler = createMediaScheduler({ bundle: voiced, timeline: {} });
    scheduler.resume();
    // the frame that first sees the line comes 800 ms after it began (a stall, a slow load)
    scheduler.tick(1800);
    const [bed, line] = audio.made;
    assert.equal(bed.currentTime, 1.8, 'the bed keeps musical time');
    assert.equal(line.currentTime, 0.5, 'only the silent lead-in may be skipped');
    line.fire('loadedmetadata');
    assert.equal(line.currentTime, 0.5, 'the position is kept when the file has loaded');
    // no lead-in declared: late lines start at their very beginning
    scheduler.tick(7400);
    assert.equal(audio.made.at(-1).currentTime, 0);
    // scrubbing into the middle of a line is a seek: exact
    scheduler.seek(2500);
    const reopened = audio.made.at(-1);
    assert.equal(reopened.currentTime, 1.5);
    reopened.fire('loadedmetadata');
    assert.equal(reopened.currentTime, 1.5);
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

test('resuming does not play a line again that has already finished', () => {
  const audio = installListeningAudio();
  try {
    const scheduler = createMediaScheduler({ bundle: voiced, timeline: {} });
    scheduler.resume();
    scheduler.tick(1000);
    const line = audio.made[1];
    line.ended = true; // spoke to its end; its window still runs for another second
    scheduler.pause();
    scheduler.resume();
    assert.equal(line.plays, 1, 'the finished line started again');
    assert.equal(audio.made[0].plays, 2, 'the bed did not resume');
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

/** A store the test lands lines in by hand. */
function manualStore(names = []) {
  const here = new Set(names);
  const waiters = [];
  return {
    started: false,
    start() { this.started = true; }, seek() {}, destroy() {},
    ready: (cue) => here.has(cue.id),
    url: (cue) => `mem:${cue.id}`,
    whenReady: (cue) => here.has(cue.id) ? Promise.resolve() : new Promise((resolve) => { waiters.push([cue.id, resolve]); }),
    whenAll: () => Promise.resolve(),
    land(id) { here.add(id); for (const [name, resolve] of waiters) if (name === id) resolve(); },
  };
}

test('the gate waits for the first two lines in memory and the opening bed playable', async () => {
  const audio = installListeningAudio();
  // every element opens with nothing buffered, as a real one does
  globalThis.Audio.prototype.readyState = 0;
  try {
    const store = manualStore();
    const scheduler = createMediaScheduler({ bundle: voiced, timeline: {}, store });
    let open = false;
    void scheduler.prepare().then(() => { open = true; });
    assert.equal(store.started, true, 'the gate did not start the download');
    const bed = audio.made[0];
    store.land('line'); store.land('bare');
    await settle();
    assert.equal(open, false, 'the gate opened before the bed could play from its start');
    bed.readyState = 4; bed.fire('canplay');
    await settle();
    assert.equal(open, true);
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

test('a line not in memory is not played from the network: the runtime is told to hold at its cue', async () => {
  const audio = installListeningAudio();
  try {
    const store = manualStore(['bed']);
    const scheduler = createMediaScheduler({ bundle: voiced, timeline: {}, store });
    scheduler.resume();
    assert.equal(scheduler.blocker(0, 900), null);
    const hold = scheduler.blocker(900, 1100);
    assert.equal(hold.atMs, 1000);
    scheduler.tick(1050);
    assert.equal(audio.made.some((m) => m.src === 'mem:line'), false, 'a line that has not landed was opened');
    let landed = false;
    void hold.until().then(() => { landed = true; });
    store.land('line');
    await settle();
    assert.equal(landed, true);
    scheduler.tick(1060);
    assert.equal(audio.made.at(-1).src, 'mem:line');
    assert.equal(audio.made.at(-1).currentTime, 0.06, 'a line noticed inside its lead-in starts where the clock is');
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

test('a line finishing past its window is cut at once by a seek', () => {
  const audio = installListeningAudio();
  try {
    const scheduler = createMediaScheduler({ bundle: voiced, timeline: {} });
    scheduler.resume();
    scheduler.tick(5500);
    const line = audio.made[1];
    scheduler.tick(6200);
    assert.equal(line.paused, false, 'a line still speaking was cut at the end of its window');
    scheduler.seek(12000);
    assert.equal(line.paused, true, 'a seek left the last line talking');
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

const later = {
  performance: { kind: 'wht' },
  audio: [
    { id: 'bed', kind: 'music', media: 'pack/bed.m4a', start_ms: 5000, end_ms: 20000, duration_ms: 15000, volume: 1 },
  ],
};
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

test('a bed that starts mid-story is opened ahead, and waited for at most a moment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = installListeningAudio();
  // an element that buffers nothing until it is played, as a phone's does
  globalThis.Audio.prototype.readyState = 0;
  try {
    const scheduler = createMediaScheduler({ bundle: later, timeline: {}, store: manualStore() });
    scheduler.resume();
    scheduler.tick(1000);
    assert.equal(audio.made.length, 0, 'opened far ahead of its start');
    scheduler.tick(2500);
    assert.equal(audio.made.length, 1, 'not opened ahead of its start');
    assert.equal(audio.made[0].paused, true, 'played before its start');
    const hold = scheduler.blocker(4900, 5001);
    assert.equal(hold?.atMs, 5000);
    let over = false;
    void hold.until().then(() => { over = true; });
    t.mock.timers.tick(1499);
    await flush();
    assert.equal(over, false);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(over, true, 'the story waited on a track past the moment it is given');
    assert.equal(scheduler.blocker(4900, 5001), null, 'the story held for the same track again');
    scheduler.tick(5000);
    assert.equal(audio.made.length, 1, 'the track opened ahead was not the one played');
    assert.equal(audio.made[0].paused, false);
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});

test('a track whose file failed is opened afresh when the story asks for it again', () => {
  const audio = installListeningAudio();
  globalThis.Audio.prototype.readyState = 0;
  try {
    const scheduler = createMediaScheduler({ bundle: later, timeline: {}, store: manualStore() });
    scheduler.resume();
    scheduler.tick(2500);
    const failed = audio.made[0];
    failed.error = { code: 4 };
    assert.ok(scheduler.blocker(4900, 5001));
    assert.equal(audio.made.length, 2, 'the failed element was waited on again');
    assert.equal(failed.paused, true);
    scheduler.destroy();
  } finally {
    audio.restore();
  }
});
