/**
 * The sound of a story, sliced the way a runtime slices time.
 *
 * Every test here drives the scheduler exactly as `timeline-player.mjs` does —
 * half-open slices forward, `seek` to land — because the two questions it is
 * built around ("what STARTS here" and "what is SOUNDING here") only differ
 * once somebody pauses or scrubs, and that difference is the whole file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMediaScheduler } from '../browser/v0/app/media-scheduler.mjs';
import { DUCKED_MUSIC_VOLUME, MUSIC_VOLUME } from '../browser/v0/policy.mjs';

const NARRATION_ONE = 'https://storage.example/jobs/s/audio/one.wav';
const NARRATION_TWO = 'https://storage.example/jobs/s/audio/two.wav';
const CALM = 'https://storage.example/assets/audio/calm.mp3';
const THUD = 'https://storage.example/assets/audio/thud.wav';
const NIGHT = 'https://storage.example/assets/audio/night.mp3';

/** Let the rejected `play()` promises reach their handlers. */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

test('each cue starts once, as the clock crosses it', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  assert.deepEqual(urls(media), [CALM, NARRATION_ONE], 'the opening music and line did not both start at t=0');

  scheduler.advance(1, 2_600);
  scheduler.advance(2_600, 3_001);
  assert.deepEqual(urls(media), [CALM, NARRATION_ONE, THUD, NARRATION_TWO]);

  // Crossing the same time again must not replay it: the runtime never rewinds
  // its slice, but a resumed player asking for a slice it already handed over
  // would double every line in the story.
  scheduler.advance(3_001, 3_002);
  assert.equal(media.length, 4);
});

test('a pause stops every medium, and resume starts the same ones again', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const [music, narration] = media;
  assert.equal(music.paused, false);
  assert.equal(narration.paused, false);

  scheduler.pause();
  assert.equal(music.paused, true);
  assert.equal(narration.paused, true);

  scheduler.resume();
  assert.equal(music.paused, false);
  assert.equal(narration.paused, false);
  assert.equal(media.length, 2, 'resume opened new media instead of continuing the ones it paused');
});

test('a seek plays what is sounding there, from the right offset, and no sound effects', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  scheduler.seek(4_000);

  const opened = urls(media);
  assert.deepEqual(opened, [CALM, NARRATION_ONE, NARRATION_TWO]);
  // The thud at 2.5 s was jumped over, and a moment cannot be arrived at late.
  assert.equal(opened.includes(THUD), false);
  const two = media.at(-1);
  assert.equal(two.currentTime, 1, 'the second line did not start one second in');
  assert.equal(media[1].paused, true, 'the line the seek left behind is still playing');
  assert.equal(media[0].paused, false, 'the music that should still be sounding was stopped');
});

test('narration ducks the music and lets it back up when the line is over', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const music = media[0];
  // The duck starts at the instant the runtime handed over — the end of the
  // slice that crossed the cue — so its fade is over one millisecond later.
  scheduler.tick(221);
  assert.equal(round(music.volume), DUCKED_MUSIC_VOLUME);

  // The first line is two seconds long. Past its end the scheduler notices on
  // its own — a file that never fires `ended` must not leave the music ducked
  // for the rest of the story.
  scheduler.tick(2_001);
  scheduler.tick(2_221);
  assert.equal(round(music.volume), MUSIC_VOLUME);
});

test('fades ride story time, so a paused story never drifts louder', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const music = media[0];
  scheduler.tick(110);
  const halfway = music.volume;
  assert.ok(halfway > 0 && halfway < DUCKED_MUSIC_VOLUME, 'the duck did not ease across the fade');

  scheduler.pause();
  assert.equal(music.volume, halfway, 'the volume moved while the story was paused');
  scheduler.resume();
  scheduler.tick(221);
  assert.equal(round(music.volume), DUCKED_MUSIC_VOLUME);
});

test('a track the bundle does not carry is reported, and the story keeps its sound', (t) => {
  const media = installAudio(t);
  const warnings = [];
  const missing = story();
  missing.timeline.events.push({
    source: 'step', kind: 'cmd', cmd: 'music', t_ms: 5_000, detail: { name: 'gone' }, line: 9, scene_index: 0,
  });
  const scheduler = createMediaScheduler({ ...missing, onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  scheduler.advance(1, 5_001);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /music is absent from bundle/);
  assert.equal(warnings[0].line, 9);
  assert.equal(media[0].paused, false, 'a misspelled track name silenced the music that was playing');
});

test('destroy releases every medium it opened', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  scheduler.destroy();
  for (const item of media) {
    assert.equal(item.paused, true);
    assert.equal(item.removed, true);
  }
  // Nothing after teardown reaches a medium again.
  scheduler.advance(1, 9_000);
  assert.equal(media.length, 2);
});

test('a refusal the device made is named — once per medium, whatever it was', async (t) => {
  const media = installAudio(t, { onPlay: () => refusal('NotAllowedError') });
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  scheduler.advance(1, 2_600);
  await settle();

  assert.deepEqual(
    warnings.map((warning) => `${warning.asset}: ${warning.message}`).sort(),
    ['bgm: music would not start', 'narration: narration would not start', 'sfx: sound would not start'],
    'a device that refused the music or the sound effect did so silently',
  );
  assert.equal(media.every((item) => item.paused && item.removed), true);
});

test('the pause this file performs itself is not a failure', async (t) => {
  // Every pause, seek and teardown rejects the pending `play()` with
  // `AbortError`. Reported, a single drag of the scrub bar would fill the log
  // with failures for lines nobody failed to play.
  installAudio(t, { onPlay: () => refusal('AbortError') });
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  scheduler.seek(3_500);
  scheduler.seek(4_000);
  scheduler.pause();
  scheduler.destroy();
  await settle();

  assert.deepEqual(warnings, []);
});

test('a scrub of a paused story does not cost it its music', (t) => {
  // What the runtime does for a scrub of a PAUSED story: pause, seek, and
  // pause again to freeze what the seek moved into place. The second pause
  // finds every medium already stopped — and used to hand `resume` an empty
  // set, which left the scene's music silent for the rest of the story.
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const [music] = media;
  scheduler.pause();
  scheduler.seek(4_000);
  scheduler.pause();
  scheduler.resume();

  assert.equal(music.paused, false, 'the music never came back from a paused scrub');
  assert.equal(
    media.filter((item) => item.url === CALM).length,
    1,
    'the track was re-opened rather than resumed',
  );
});

test('the pause this file performs itself does not throw the line away', async (t) => {
  // The same `AbortError`, from the other side: it must not be reported, AND
  // the medium it names must survive it. Releasing there stripped the `src` of
  // the line a scrub had just placed, leaving `narration` pointing at a dead
  // element — silence, with the music ducked under it for the length of a line
  // nobody could hear.
  const media = installAudio(t, { onPlay: () => refusal('AbortError') });
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  scheduler.pause();
  scheduler.seek(3_500);
  scheduler.pause();
  await settle();

  const line = media.at(-1);
  assert.equal(line.url, NARRATION_TWO);
  assert.equal(line.removed, false, 'the pause released the line the seek had just placed');
  scheduler.resume();
  assert.equal(line.paused, false, 'the line could not be resumed: it had been let go');
  assert.deepEqual(warnings, []);
});

test('a sound or a track that stalls before it is heard says so', (t) => {
  // Neither rejects `play()` nor fires `error`: a medium that is fetching and
  // getting nothing fires this instead, and the start-timeout watchdog that
  // used to catch it went with the live director.
  const media = installAudio(t);
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  scheduler.advance(1, 2_600);
  media[0].fire('stalled');
  media.find((item) => item.url === THUD).fire('stalled');

  assert.deepEqual(
    warnings.map((warning) => `${warning.asset}: ${warning.message}`).sort(),
    ['bgm: music stalled before it was heard', 'sfx: sound stalled before it was heard'],
  );
});

test('a broken line is one line in the log, not two', async (t) => {
  const media = installAudio(t, { onPlay: () => refusal('NotSupportedError') });
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  // A 404 wav both fires `error` and rejects its `play()`.
  media[1].fire('error');
  await settle();

  assert.equal(warnings.filter((warning) => warning.asset === 'narration').length, 1);
});

test('a sound the bundle does not carry is named where the story asked for it', (t) => {
  installAudio(t);
  const warnings = [];
  const missing = story();
  missing.bundle.audio.sfx = {};
  const scheduler = createMediaScheduler({ ...missing, onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 2_600);
  const named = warnings.filter((warning) => warning.asset === 'sfx');
  assert.equal(named.length, 1);
  assert.match(named[0].message, /sound is absent from bundle/);
  assert.equal(named[0].line, 3);
});

test('one music track replaces another: the old one fades, stops and is let go', (t) => {
  const media = installAudio(t);
  const two = story();
  two.bundle.audio.bgm.night = NIGHT;
  two.timeline.events.push({
    source: 'step', kind: 'cmd', cmd: 'music', t_ms: 6_000, detail: { name: 'night' }, line: 8, scene_index: 0,
  });
  const scheduler = createMediaScheduler(two);

  scheduler.advance(0, 1);
  const calm = media[0];
  // Past both narration lines, so the new track is compared against the volume
  // a story with nobody talking over it plays at.
  scheduler.advance(1, 5_500);
  scheduler.tick(5_500);
  scheduler.tick(5_800);
  scheduler.advance(5_500, 6_001);
  const night = media.at(-1);
  assert.equal(night.url, NIGHT);
  assert.equal(night.loop, true);

  scheduler.tick(6_851);
  assert.equal(calm.paused, true, 'the old track is still playing under the new one');
  assert.equal(calm.removed, true, 'the old track was left decoding for the rest of the story');
  assert.equal(round(night.volume), MUSIC_VOLUME);
});

test('music(off) stops the track, and the same name twice does not restart it', (t) => {
  const media = installAudio(t);
  const again = story();
  again.timeline.events.push(
    { source: 'step', kind: 'cmd', cmd: 'music', t_ms: 4_000, detail: { name: 'calm' }, line: 8, scene_index: 0 },
    { source: 'step', kind: 'cmd', cmd: 'music', t_ms: 5_000, detail: { name: 'off' }, line: 9, scene_index: 0 },
  );
  const scheduler = createMediaScheduler(again);

  scheduler.advance(0, 1);
  scheduler.advance(1, 4_001);
  assert.equal(media.filter((item) => item.url === CALM).length, 1, 'the same track was opened twice');

  scheduler.advance(4_001, 5_001);
  scheduler.tick(5_851);
  assert.equal(media[0].paused, true);
  assert.equal(media[0].removed, true);
});

test('a seek finishes the fades it lands away from', (t) => {
  const media = installAudio(t);
  const two = story();
  two.bundle.audio.bgm.night = NIGHT;
  two.timeline.events.push({
    source: 'step', kind: 'cmd', cmd: 'music', t_ms: 20_000, detail: { name: 'night' }, line: 8, scene_index: 0,
  });
  const scheduler = createMediaScheduler(two);

  scheduler.advance(0, 1);
  const calm = media[0];
  scheduler.advance(1, 5_500);
  scheduler.tick(5_500);
  scheduler.tick(5_800);
  assert.equal(round(calm.volume), MUSIC_VOLUME);
  scheduler.advance(5_500, 20_001);
  scheduler.tick(20_100);
  assert.ok(calm.volume > 0, 'the old track was already gone, so this proves nothing');

  // Back to before the swap: the old track's fade-out now starts in the future,
  // and a fade clamped at progress 0 would snap it back to full volume and hold
  // it there — two copies of the music over one story.
  scheduler.seek(10_000);
  assert.equal(calm.paused, true, 'a fading track survived a seek past its own fade');
  assert.equal(calm.removed, true);
  assert.equal(media.filter((item) => !item.paused && item.url === CALM).length, 1, 'the music is playing twice');
});

test('a resume the device refuses is named', async (t) => {
  let allow = true;
  const media = installAudio(t, { onPlay: () => (allow ? Promise.resolve() : refusal('NotAllowedError')) });
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  scheduler.pause();
  allow = false;
  scheduler.resume();
  await settle();

  assert.equal(warnings.length, 2, 'a story that came back from a pause silent said nothing about it');
  assert.equal(warnings.every((warning) => /would not resume/.test(warning.message)), true);
  assert.equal(media.every((item) => item.paused), true);
});

/**
 * Music from the first instant, two narration lines, one sound effect between
 * them — the smallest story that can tell every question here apart.
 */
function story() {
  return {
    timeline: {
      timeline_version: 1,
      storylang_version: 0,
      duration_ms: 6_000,
      events: [
        { source: 'step', kind: 'cmd', cmd: 'music', t_ms: 0, detail: { name: 'calm' }, line: 1, scene_index: 0 },
        {
          source: 'step',
          kind: 'chunk',
          t_ms: 0,
          detail: { text: 'One.', duration_s: 2, audio: NARRATION_ONE },
          line: 2,
          scene_index: 0,
        },
        { source: 'step', kind: 'cmd', cmd: 'sound', t_ms: 2_500, detail: { name: 'thud' }, line: 3, scene_index: 0 },
        {
          source: 'step',
          kind: 'chunk',
          t_ms: 3_000,
          detail: { text: 'Two.', duration_s: 2, audio: NARRATION_TWO },
          line: 4,
          scene_index: 0,
        },
      ],
    },
    bundle: {
      storylang_version: 0,
      audio: { sfx: { thud: THUD }, bgm: { calm: CALM } },
    },
  };
}

/** Collect every `Audio` the scheduler opens, and undo the global afterwards. */
function installAudio(t, { onPlay = () => Promise.resolve() } = {}) {
  const opened = [];
  const original = globalThis.Audio;
  globalThis.Audio = class {
    constructor(url) {
      this.url = url;
      this.paused = true;
      this.removed = false;
      this.volume = 1;
      this.currentTime = 0;
      this.loop = false;
      this.listeners = new Map();
      opened.push(this);
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    fire(type) { this.listeners.get(type)?.({ type }); }
    play() { this.paused = false; return onPlay(this) ?? Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() { this.removed = true; }
  };
  t.after(() => { globalThis.Audio = original; });
  return opened;
}

function refusal(name) {
  return Promise.reject(Object.assign(new Error(`${name} refused`), { name }));
}

function urls(media) {
  return media.map((item) => item.url);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
