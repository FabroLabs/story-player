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
