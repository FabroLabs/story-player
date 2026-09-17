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
    assert.equal(audio.made[0].paused, true, 'the first line was not released at its end');
    assert.equal(audio.made[1].paused, false, 'the second line did not start');
    assert.equal(audio.made[1].plays, 1);
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
