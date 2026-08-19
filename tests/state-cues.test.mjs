import assert from 'node:assert/strict';
import test from 'node:test';

import { cuesBetween, soundingAt } from '../browser/v0/core/state/cues.mjs';
import { STEMS, read } from './_parity.mjs';

/**
 * The sound, forwards and after a seek.
 *
 * Playing forward asks what starts in the slice of time just crossed; seeking
 * asks what should be sounding at the instant landed on. The corpus proves the
 * first never drops or repeats a cue however the slices fall; the hand-built
 * story below proves the second, which is the one a scrub bar depends on.
 */

const BUNDLE = {
  storylang_version: 0,
  title: 'sounds',
  cast: {},
  objects: {},
  audio: { sfx: { pop: 'bucket/pop.wav' }, bgm: { calm: 'bucket/calm.wav' } },
  scenes: [{ line: 1, place: 'path', plate: {}, steps: [] }],
};

const TIMELINE = {
  timeline_version: 1,
  storylang_version: 0,
  title: 'sounds',
  duration_ms: 10_000,
  events: [
    chunk(0, 'bucket/one.wav', 2, 'The clearing glowed gold.'),
    cmd(0, 'music', { name: 'calm' }),
    cmd(2_000, 'sound', { name: 'pop' }),
    chunk(2_000, 'bucket/two.wav', 3, 'Beyond it, the tunnel waited.'),
    chunk(5_000, null, 1.5, 'A silence with words.'),
    chunk(6_000, 'bucket/three.wav', 0.5, 'Inside a block.', 30),
    cmd(6_500, 'music', { name: 'rain' }),
    cmd(7_000, 'music', { name: 'off' }),
    cmd(8_000, 'sound', { name: 'thunder' }),
  ],
};

function chunk(tMs, audio, durationSeconds, text, togetherLine) {
  return {
    t_ms: tMs,
    source: 'step',
    kind: 'chunk',
    scene_index: 0,
    line: 4,
    detail: {
      audio,
      duration_s: durationSeconds,
      text,
      ...(togetherLine === undefined ? {} : { together_line: togetherLine }),
    },
  };
}

function cmd(tMs, name, detail) {
  return { t_ms: tMs, source: 'step', kind: 'cmd', cmd: name, scene_index: 0, line: 5, detail: { subjects: [], ...detail } };
}

test('a narration cue carries its wav, its length and its words', () => {
  const [narration, music] = cuesBetween(TIMELINE, BUNDLE, 0, 1);
  assert.equal(music.kind, 'music', 'the opening cues arrive in the order the stream carries them');
  assert.deepEqual(narration, {
    kind: 'narration',
    tMs: 0,
    media: 'bucket/one.wav',
    durationMs: 2_000,
    text: 'The clearing glowed gold.',
    sceneIndex: 0,
    line: 4,
  });
});

test('a sound and a track are named in the step, and found in the bundle', () => {
  assert.deepEqual(
    cuesBetween(TIMELINE, BUNDLE, 2_000, 2_001).map((cue) => [cue.kind, cue.name, cue.media]),
    [['sound', 'pop', 'bucket/pop.wav'], ['narration', undefined, 'bucket/two.wav']],
  );
  assert.deepEqual(
    cuesBetween(TIMELINE, BUNDLE, 0, 1).concat(cuesBetween(TIMELINE, BUNDLE, 7_000, 7_001))
      .filter((cue) => cue.kind === 'music')
      .map((cue) => [cue.name, cue.media]),
    [['calm', 'bucket/calm.wav'], ['off', null]],
  );
});

// A sound the bundle never carried is still a cue: it happened, and a player
// that drops it silently is a player that cannot say what it failed to play.
test('a sound absent from the bundle is a cue with nothing to play', () => {
  assert.deepEqual(cuesBetween(TIMELINE, BUNDLE, 8_000, 8_001).map((cue) => [cue.name, cue.media]), [['thunder', null]]);
});

test('a chunk with no wav is subtitle only, and makes no sound', () => {
  assert.deepEqual(cuesBetween(TIMELINE, BUNDLE, 5_000, 5_001), []);
});

test('landing mid-narration resumes it from the right offset', () => {
  assert.deepEqual(soundingAt(TIMELINE, BUNDLE, 3_500).narration, {
    kind: 'narration',
    tMs: 2_000,
    media: 'bucket/two.wav',
    durationMs: 3_000,
    text: 'Beyond it, the tunnel waited.',
    sceneIndex: 0,
    line: 4,
    offsetMs: 1_500,
  });
  assert.equal(soundingAt(TIMELINE, BUNDLE, 5_000).narration, null, 'a finished narration is not still playing');
  assert.equal(soundingAt(TIMELINE, BUNDLE, 1_999).narration.media, 'bucket/one.wav');
});

test('music is a state and a sound effect is a moment', () => {
  assert.equal(soundingAt(TIMELINE, BUNDLE, 1_000).music.name, 'calm');
  assert.equal(soundingAt(TIMELINE, BUNDLE, 6_999).music.name, 'calm');
  assert.equal(soundingAt(TIMELINE, BUNDLE, 7_000).music, null);
  // 2_000 is the pop; seeking onto it must not fire it.
  assert.deepEqual(Object.keys(soundingAt(TIMELINE, BUNDLE, 2_500)).sort(), ['music', 'narration']);
});

// Only `off` stops the music. A track the bundle does not carry is a failure to
// report, not an instruction to obey — the live audio director left whatever
// was playing alone, and silencing a story because one name is misspelled is
// the louder mistake.
test('a track absent from the bundle is a failure, not a silence', () => {
  const [cue] = cuesBetween(TIMELINE, BUNDLE, 6_500, 6_501);
  assert.deepEqual([cue.name, cue.media, cue.missing], ['rain', null, true]);
  assert.equal(cuesBetween(TIMELINE, BUNDLE, 7_000, 7_001)[0].missing, false, '`off` is not a missing track');
  assert.equal(soundingAt(TIMELINE, BUNDLE, 6_750).music.name, 'calm', 'a misspelt track stopped the music');
});

// A chunk inside a `together` is logged but never performed — no subtitle, no
// wait — so it is not something anybody hears either.
test('a chunk inside a together makes no sound', () => {
  assert.deepEqual(cuesBetween(TIMELINE, BUNDLE, 6_000, 6_001), []);
  assert.equal(soundingAt(TIMELINE, BUNDLE, 6_100).narration, null);
});

for (const stem of STEMS) {
  const bundle = read(stem, 'bundle');
  const timeline = read(stem, 'timeline');

  // However a player slices its playback — a steady 24 fps, a stutter, one
  // enormous catch-up frame after a hidden tab — every cue fires once.
  test(`${stem}: no slicing of the clock drops or repeats a cue`, () => {
    const whole = cuesBetween(timeline, bundle, 0, timeline.duration_ms + 1);
    assert.ok(whole.length > 0, 'a story with no sound at all');
    for (const stride of [41, 1_000, 7_919]) {
      const sliced = [];
      for (let from = 0; from <= timeline.duration_ms; from += stride) {
        sliced.push(...cuesBetween(timeline, bundle, from, Math.min(from + stride, timeline.duration_ms + 1)));
      }
      assert.deepEqual(sliced, whole, `a ${stride} ms stride disagreed`);
    }
  });

  test(`${stem}: every narration is playable, and none outlasts the story`, () => {
    for (const cue of cuesBetween(timeline, bundle, 0, timeline.duration_ms + 1)) {
      if (cue.kind !== 'narration') continue;
      assert.match(cue.media, /^[a-z0-9.-]+\/.+/, 'a narration cue with no bucket-qualified media');
      assert.ok(cue.durationMs > 0, 'a narration of no length');
      assert.ok(cue.tMs + cue.durationMs <= timeline.duration_ms, 'a narration running past the end of the story');
    }
  });

  test(`${stem}: what is sounding at t is what was last started before it`, () => {
    for (const event of timeline.events) {
      // A chunk inside a `together` is logged but never performed, so it is
      // not something `soundingAt` owes an answer for either.
      if (event.kind !== 'chunk' || typeof event.detail?.audio !== 'string') continue;
      if (event.detail.together_line !== undefined) continue;
      const middle = event.t_ms + Math.floor((event.detail.duration_s * 1000) / 2);
      const { narration } = soundingAt(timeline, bundle, middle);
      assert.equal(narration?.media, event.detail.audio, `nothing was narrating at ${middle} ms`);
      assert.equal(narration.offsetMs, middle - event.t_ms);
    }
  });
}
