import assert from 'node:assert/strict';
import test from 'node:test';
import { soundCuesFor, mixCue, volumeAt, updateMusicRamps } from '../browser/v0/app/export-audio.mjs';
import { DUCKED_MUSIC_VOLUME, MUSIC_VOLUME } from '../browser/v0/policy.mjs';

function lesson() {
  const event = (t_ms, kind, detail, cmd) => ({ source: 'step', t_ms, kind, detail, cmd });
  return {
    story: { audio: { bgm: { garden: 'garden.m4a', night: 'night.m4a' }, sfx: { bell: 'bell.m4a' } } },
    board: { world: {} },
    timeline: { duration_ms: 7000, events: [
      event(0, 'cmd', { name: 'garden' }, 'music'),
      event(1000, 'chunk', { audio: 'voice.m4a', duration_s: 2 }),
      event(2000, 'cmd', { name: 'bell' }, 'sound'),
      event(3500, 'cmd', { name: 'garden' }, 'music'),
      event(4000, 'cmd', { name: 'night' }, 'music'),
      event(6000, 'cmd', { name: 'off' }, 'music'),
    ] },
  };
}

test('canvas lessons keep narration, one-shot sounds, music loops, ducks and crossfades', () => {
  const cues = soundCuesFor(lesson());
  const garden = cues.find(cue => cue.media === 'garden.m4a');
  const night = cues.find(cue => cue.media === 'night.m4a');
  const voice = cues.find(cue => cue.kind === 'narration');
  assert.equal(cues.length, 4, 'the repeated music command must not restart the track');
  assert.deepEqual([voice.start_ms, voice.duration_ms], [1000, 2000]);
  assert.equal(cues.find(cue => cue.media === 'bell.m4a').start_ms, 2000);
  assert.equal(garden.loop, true);
  assert.equal(volumeAt(garden, 0), 0);
  assert.equal(volumeAt(garden, 900), MUSIC_VOLUME);
  assert.equal(volumeAt(garden, 1250), DUCKED_MUSIC_VOLUME);
  assert.equal(volumeAt(garden, 3300), MUSIC_VOLUME);
  assert.ok(Math.abs(volumeAt(garden, 4425) - MUSIC_VOLUME / 2) < 1e-6);
  assert.ok(Math.abs(volumeAt(night, 4425) - MUSIC_VOLUME / 2) < 1e-6);
  assert.equal(garden.end_ms, 4850);
  assert.equal(night.end_ms, 6850);
  assert.equal(volumeAt(night, 6850), 0);
});

test('only canvas lessons get a legacy soundtrack; performances keep their own schedule', () => {
  const input = lesson();
  assert.equal(soundCuesFor({ ...input, board: null }), null);
  assert.equal(soundCuesFor({ ...input, timeline: null }), null);
  input.timeline.events[0].detail.name = 'missing';
  assert.equal(soundCuesFor(input), null, 'an unsupported soundtrack must use the audible fallback');
  const audio = [{ kind: 'narration', media: 'voice.m4a', start_ms: 0, duration_ms: 1000 }];
  assert.equal(soundCuesFor({ story: { performance: {}, audio } }), audio);
});

test('loop mixing wraps source samples, respects cue bounds and applies linear fades', async () => {
  const samples = Float32Array.of(1, 0.5);
  const source = { length: 2, read: async (from, count) => [samples.subarray(from, from + count)] };
  const left = new Float32Array(8), right = new Float32Array(8);
  await mixCue({ start_ms: 1000, end_ms: 7000, loop: true, volume: 0,
    gain_ramps: [{ start_ms: 1000, end_ms: 5000, from: 0, to: 1 }] }, source, 0, left, right, 1);
  assert.deepEqual([...left], [0, 0, 0.125, 0.5, 0.375, 1, 0.5, 0]);
  assert.deepEqual([...right], [...left]);
  const effect = new Float32Array(8);
  await mixCue({ start_ms: 1000, end_ms: 8000 }, source, 0, effect, new Float32Array(8), 1);
  assert.deepEqual([...effect], [0, 1, 0.5, 0, 0, 0, 0, 0], 'one-shot effects must not loop');
});

test('performance gain keys remain steps and zero-length looping audio terminates', async () => {
  const cue = { start_ms: 0, end_ms: 4000, gain_keys: [[0, 0.5], [2000, 1]] };
  const samples = new Float32Array(4).fill(1);
  const source = { length: 4, read: async (from, count) => [samples.subarray(from, from + count)] };
  const left = new Float32Array(4);
  await mixCue(cue, source, 0, left, new Float32Array(4), 1);
  assert.deepEqual([...left], [0.5, 0.5, 1, 1]);
  await mixCue({ ...cue, loop: true }, { length: 0 }, 0, left, new Float32Array(4), 1);
});


test('music stays ducked through decoded narration tails and rises after short files', () => {
  const cues = soundCuesFor(lesson());
  const garden = cues.find(cue => cue.media === 'garden.m4a');
  const voice = cues.find(cue => cue.kind === 'narration');
  voice.source_end_ms = 3800;
  updateMusicRamps(cues);
  assert.equal(volumeAt(garden, 3500), DUCKED_MUSIC_VOLUME, 'the last words must stay above the music');
  voice.source_end_ms = 2000;
  updateMusicRamps(cues);
  assert.equal(volumeAt(garden, 2300), MUSIC_VOLUME, 'a short narration should release the duck');
});


test('stereo performance loops keep phase and stepped gains across mix windows', async () => {
  const channels = [Float32Array.of(1, 0.5, -1), Float32Array.of(-0.5, 1, 0.5)];
  const source = { length: 3, read: async (from, count) => channels.map(data => data.subarray(from, from + count)) };
  const cue = { start_ms: 1000, end_ms: 9000, loop: true, volume: 0.5, gain_keys: [[5000, 1]] };
  const left = [], right = [];
  for (const [from, count] of [[0, 4], [4, 3], [7, 3]]) {
    const l = new Float32Array(count), r = new Float32Array(count);
    await mixCue(cue, source, from, l, r, 1);
    left.push(...l); right.push(...r);
  }
  assert.deepEqual(left, [0, 0.5, 0.25, -0.5, 0.5, 0.5, -1, 1, 0.5, 0]);
  assert.deepEqual(right, [0, -0.25, 0.5, 0.25, -0.25, 1, 0.5, -0.5, 1, 0]);
});
