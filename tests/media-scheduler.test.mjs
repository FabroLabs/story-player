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
import { DUCKED_MUSIC_VOLUME, MUSIC_VOLUME, NARRATION_GRACE_MS } from '../browser/v0/policy.mjs';

const NARRATION_ONE = 'https://storage.example/jobs/s/audio/one.wav';
const NARRATION_TWO = 'https://storage.example/jobs/s/audio/two.wav';
const NARRATION_THREE = 'https://storage.example/jobs/s/audio/three.wav';
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
  // The second line's file is opened here rather than at its own cue — it is
  // fetched under the first line's seconds so that it can start on time.
  assert.deepEqual(urls(media), [CALM, NARRATION_ONE, NARRATION_TWO], 'the opening music and line did not both start at t=0');
  assert.equal(media[2].paused, true, 'the line opened ahead of its cue started playing early');

  scheduler.advance(1, 2_600);
  scheduler.advance(2_600, 3_001);
  assert.deepEqual(urls(media), [CALM, NARRATION_ONE, NARRATION_TWO, THUD]);
  assert.equal(media[2].paused, false, 'the second line opened a second file instead of the one held ready');

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

  const ahead = media.at(-1);
  scheduler.pause();
  assert.equal(music.paused, true);
  assert.equal(narration.paused, true);
  assert.equal(ahead.paused, true, 'the file opened ahead was never playing to be paused');

  const opened = media.length;
  scheduler.resume();
  assert.equal(music.paused, false);
  assert.equal(narration.paused, false);
  assert.equal(media.length, opened, 'resume opened new media instead of continuing the ones it paused');
  // A file opened ahead of its cue is not something a resume may start: the
  // story has not reached the line it belongs to.
  assert.equal(ahead.paused, true, 'the resume started a line the story has not reached');
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
  const opened = media.length;
  scheduler.destroy();
  for (const item of media) {
    assert.equal(item.paused, true);
    // The file opened ahead of its cue is torn down with the rest: nothing else
    // would ever reach it, and it would keep its download running.
    assert.equal(item.removed, true);
  }
  // Nothing after teardown reaches a medium again.
  scheduler.advance(1, 9_000);
  assert.equal(media.length, opened);
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
  assert.equal(media.filter((item) => item.played).every((item) => item.paused && item.removed), true);
  // The file opened ahead of its cue was never asked to play, so nothing
  // refused it and nothing let it go: it is still waiting for its own line.
  assert.deepEqual(media.filter((item) => !item.played).map((item) => item.removed), [false]);
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

test('a line that arrived late is not cut at the end the schedule guessed', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const line = media[1];
  // The file took 300 ms to arrive, so at its scheduled end 300 ms of it has
  // not been heard. That is the bug: those 300 ms were the last words.
  line.fire('playing');
  scheduler.tick(300);
  line.currentTime = 1.701;
  scheduler.tick(2_001);
  assert.equal(line.paused, false, 'the line was cut at the schedule’s end, losing its tail');

  line.currentTime = 2.001;
  scheduler.tick(2_301);
  assert.equal(line.paused, true, 'the line ran on past the end it had actually earned');
});

test('a line the story never catches up with is cut at the grace', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const line = media[1];
  // A file that stalls never plays another millisecond, so what it is "owed"
  // keeps sliding forward. Without the bound it would hold the line open — and
  // the music ducked under it — for the rest of the story.
  line.fire('playing');
  scheduler.tick(1_500);
  scheduler.tick(2_000 + NARRATION_GRACE_MS - 1);
  assert.equal(line.paused, false);
  scheduler.tick(2_000 + NARRATION_GRACE_MS);
  assert.equal(line.paused, true, 'a stalled file held its line open past the grace');
});

test('a line handed over keeps its tail, and only its tail', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(backToBack());

  scheduler.advance(0, 1);
  const [music, one, two] = media;
  one.fire('playing');
  scheduler.tick(300);
  one.currentTime = 1.7;
  scheduler.tick(2_000);

  // The next line's cue falls on the previous line's scheduled end — which is
  // 300 ms before the previous line has finished speaking.
  scheduler.advance(1, 2_001);
  assert.equal(two.paused, false, 'the next line waited for the one before it');
  assert.equal(one.paused, false, 'the tail was cut at the hand-over — the reported bug');
  assert.equal(round(music.volume), DUCKED_MUSIC_VOLUME, 'the music swelled between two lines');

  scheduler.tick(2_300);
  assert.equal(one.paused, true, 'the tail outstayed the end it had earned');
  assert.equal(two.paused, false, 'the line the story is on was stopped along with the tail');

  // The duck belongs to the pair. A tail ending while the next line is still
  // being read must not bring the music up under it — and only a tick past the
  // whole fade can tell a held duck from one that was let go.
  scheduler.tick(2_300 + 250);
  assert.equal(round(music.volume), DUCKED_MUSIC_VOLUME, 'the music came up under the line that was still being read');
});

test('a line still being read is left to finish when the story stops around it', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(backToBack());

  scheduler.advance(0, 1);
  const [music, one, two] = media;
  one.fire('playing');
  // The clock runs out on the last line, or the writer has not published the
  // next scene: everything stops except the sentence being spoken.
  scheduler.settle();
  assert.equal(one.paused, false, 'the last sentence was cut off by the story stopping around it');
  assert.equal(music.paused, true, 'the music played on under a stopped story');
  assert.equal(two.paused, true, 'a file opened ahead was started by the story stopping');

  scheduler.resume();
  assert.equal(music.paused, false, 'the music never came back');
  assert.equal(one.paused, false, 'the sentence that was finishing was restarted');
  assert.equal(two.paused, true, 'the resume started a line the story has not reached');
});

test('a line that never arrived is not left speaking, by a settle or by a hand-over', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(backToBack());

  // No `playing`: the file never arrived. There is nothing to protect, and
  // carrying it would hold the duck for a line nobody can hear.
  scheduler.advance(0, 1);
  const one = media[1];
  scheduler.settle();
  assert.equal(one.paused, true, 'a line that was never heard was left "speaking"');

  scheduler.resume();
  scheduler.advance(1, 2_001);
  assert.equal(one.removed, true, 'a line that never played became a tail');
});

test('a hand-over inside the line before it does not keep a line nobody heard', (t) => {
  const media = installAudio(t);
  // The compiler schedules chunks back to back, but the player is handed a
  // timeline, not a promise: one whose next cue falls INSIDE the line before it
  // is data it has to survive. Only there can a line be handed over while its
  // own scheduled end is still ahead.
  const overlapping = backToBack();
  overlapping.timeline.events[2].t_ms = 1_500;
  const scheduler = createMediaScheduler(overlapping);

  scheduler.advance(0, 1);
  const one = media[1];
  scheduler.advance(1, 1_501);

  assert.equal(one.removed, true, 'a line that was never heard was carried as a tail');
  assert.equal(media[2].paused, false, 'the line the story moved on to never started');
});

test('a line whose file runs past the schedule keeps the end of the file', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const line = media[1];
  // The schedule is measured from the wav; the m4a played here is 50 ms longer,
  // and that difference is the end of the last word.
  line.duration = 2.05;
  line.fire('playing');
  scheduler.tick(0);

  line.currentTime = 2;
  scheduler.tick(2_000);
  assert.equal(line.paused, false, 'the line was cut at the schedule rather than at the end of its file');

  line.currentTime = 2.05;
  scheduler.tick(2_050);
  assert.equal(line.paused, true, 'the line ran past the end of its own file');
});

test('a seek away from every line cuts the tail it leaves behind', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(backToBack());

  scheduler.advance(0, 1);
  const one = media[1];
  one.fire('playing');
  scheduler.tick(300);
  one.currentTime = 1.7;
  scheduler.advance(1, 2_001);
  assert.equal(one.paused, false, 'this proves nothing: there is no tail to leave behind');

  // Nothing is sounding out here, so nothing starts and nothing hands over —
  // the tail has to be cut by the seek itself.
  scheduler.seek(4_500);
  assert.equal(one.paused, true, 'a voice from another moment talked over the instant the seek landed on');
  assert.equal(one.removed, true);
});

test('a line at the edge of a story still being written gets its next file when the scene lands', (t) => {
  const media = installAudio(t);
  const growing = backToBack();
  const prefix = { ...growing, timeline: { ...growing.timeline, events: growing.timeline.events.slice(0, 2) } };
  const scheduler = createMediaScheduler(prefix);

  scheduler.advance(0, 1);
  assert.deepEqual(urls(media), [CALM, NARRATION_ONE], 'a prefix with nothing after it opened a file anyway');

  // The scene the story was waiting for lands, and with it the line that comes
  // after the one being read out. Without this the last line of every published
  // prefix paid its own fetch — exactly the cut, at every append boundary.
  scheduler.setStory(growing);
  assert.deepEqual(urls(media), [CALM, NARRATION_ONE, NARRATION_TWO], 'the appended line was not opened ahead');
  assert.equal(media.at(-1).played, false, 'the appended line started before the story reached it');
});

test('a seek cuts the tail as well as the line', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(backToBack());

  scheduler.advance(0, 1);
  const one = media[1];
  one.fire('playing');
  scheduler.tick(300);
  one.currentTime = 1.7;
  scheduler.advance(1, 2_001);
  assert.equal(one.paused, false, 'this proves nothing: there is no tail to cut');

  // A seek lands somewhere the tail was never sounding.
  scheduler.seek(3_500);
  assert.equal(one.paused, true, 'a tail from another moment kept playing over the seek');
  assert.equal(one.removed, true);
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

test('only one tail at a time, and a tail that ends says so', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(threeLines());

  scheduler.advance(0, 1);
  const [music, one, two] = media;
  one.fire('playing');
  scheduler.tick(300);
  one.currentTime = 1.7;

  // Line two starts while line one is still owed 300 ms, and is itself late.
  scheduler.advance(1, 2_001);
  two.fire('playing');
  scheduler.tick(2_100);

  // Line three's turn comes while BOTH of the others could still be sounding.
  // Three voices at once is never right: the older tail goes.
  scheduler.advance(2_001, 2_301);
  assert.equal(one.paused, true, 'a second tail was allowed, so two lines spoke over a third');
  assert.equal(one.removed, true, 'the older tail was left holding its file');
  assert.equal(two.paused, false, 'the tail the hand-over just made was cut');

  // A tail that reaches its own end lets go there, rather than waiting for a
  // tick to notice — and the music stays down under the line still being read.
  two.fire('ended');
  assert.equal(two.removed, true, 'a tail that ended was left holding its file');
  scheduler.tick(2_301 + 250);
  assert.equal(round(music.volume), DUCKED_MUSIC_VOLUME, 'the music came up while a line was still being read');
});

test('one file ahead, and never one the story has turned away from', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(threeLines());

  scheduler.advance(0, 1);
  const held = media[2];
  assert.equal(held.url, NARRATION_TWO, 'the file held ready was not the next line');

  // The seek lands on line three, so the file held for line two is one the
  // story will never reach — and there is no line after three to replace it.
  scheduler.seek(2_400);
  assert.equal(held.removed, true, 'a file the story turned away from was left downloading');

  scheduler.advance(2_400, 4_301);
  assert.deepEqual(
    urls(media).filter((url) => url !== CALM),
    [NARRATION_ONE, NARRATION_TWO, NARRATION_THREE],
    'a line was opened twice, or more than one line was held ahead',
  );
});

test('a file that gave up before its cue is opened again at it', async (t) => {
  const media = installAudio(t);
  const warnings = [];
  const scheduler = createMediaScheduler({ ...story(), onWarning: (detail) => warnings.push(detail) });

  scheduler.advance(0, 1);
  const held = media[2];
  assert.equal(held.url, NARRATION_TWO, 'the file held ready was not the next line');

  // A 404 that lands while the line before this one is still being read. Kept
  // for its cue, this element takes listeners for an `error` that has already
  // fired: nothing drops the line, `play()` rejects into a warning already
  // spent on it, and the line reads out as silence.
  held.fire('error');
  assert.equal(held.removed, true, 'a file that failed while held was kept for its cue');
  assert.equal(warnings.filter((warning) => warning.asset === 'narration').length, 1);

  scheduler.advance(1, 3_001);
  const opened = media.at(-1);
  assert.equal(opened.url, NARRATION_TWO, 'the dead file was adopted at the cue and the line played silent');
  assert.notEqual(opened, held);
  assert.equal(opened.played, true, 'the line was never asked to play');
});

test('a seek into a gap holds the line ahead, and past the last one holds nothing', (t) => {
  const media = installAudio(t);
  const scheduler = createMediaScheduler(story());

  scheduler.advance(0, 1);
  const held = media[2];
  assert.equal(held.url, NARRATION_TWO, 'the file held ready was not the next line');

  // Between the two lines. Nothing is being read, and the file held is for the
  // line the story is still heading towards: throwing it away here would cost
  // that line the head start the whole prefetch exists for.
  scheduler.seek(2_600);
  assert.equal(held.removed, false, 'the file for the line just ahead was thrown away');

  // Past the last line. Nothing is being read and there is nothing to read
  // next, so a file left open here downloads for nobody — and, failing, puts
  // `narration unavailable` over a scene whose narration is fine.
  scheduler.seek(5_500);
  assert.equal(held.removed, true, 'a file the story turned away from was left downloading');
  assert.equal(media.length, 3, 'a seek into silence opened a file of its own');
});

test('music that comes up under a tail comes up ducked', (t) => {
  const media = installAudio(t);
  const late = backToBack();
  late.bundle.audio.bgm.night = NIGHT;
  late.timeline.events.push({
    source: 'step', kind: 'cmd', cmd: 'music', t_ms: 2_100, detail: { name: 'night' }, line: 5, scene_index: 0,
  });
  const scheduler = createMediaScheduler(late);

  scheduler.advance(0, 1);
  const [, one, two] = media;
  one.fire('playing');
  scheduler.tick(300);
  // Barely started, so what it is still owed runs past the line after it.
  one.currentTime = 0.2;
  scheduler.tick(2_000);

  scheduler.advance(1, 2_001);
  // The second line's file turns out to be shorter than the schedule thought:
  // the story is left with no line of its own and one tail still owed, which is
  // the only window a track can start in without a `narration` to duck under.
  two.fire('ended');

  scheduler.advance(2_001, 2_101);
  const night = media.at(-1);
  assert.equal(night.url, NIGHT, 'the track did not start where the story asked for it');
  scheduler.tick(2_951);
  assert.equal(
    round(night.volume),
    DUCKED_MUSIC_VOLUME,
    'the music came up to full under the last words of a line',
  );
});

/**
 * Three lines back to back, the middle one short enough that its own tail is
 * still owed when the third begins — the only shape that can ask what happens
 * to a tail while another tail is already waiting.
 */
function threeLines() {
  const chunk = (tMs, seconds, audio, line) => ({
    source: 'step',
    kind: 'chunk',
    t_ms: tMs,
    detail: { text: 'One.', duration_s: seconds, audio },
    line,
    scene_index: 0,
  });
  return {
    timeline: {
      timeline_version: 1,
      storylang_version: 0,
      duration_ms: 4_300,
      events: [
        { source: 'step', kind: 'cmd', cmd: 'music', t_ms: 0, detail: { name: 'calm' }, line: 1, scene_index: 0 },
        chunk(0, 2, NARRATION_ONE, 2),
        chunk(2_000, 0.3, NARRATION_TWO, 3),
        chunk(2_300, 2, NARRATION_THREE, 4),
      ],
    },
    bundle: {
      storylang_version: 0,
      audio: { sfx: {}, bgm: { calm: CALM } },
    },
  };
}

/**
 * Two lines with nothing between them, the way a real story schedules them:
 * the second cue falls on the first line's own end, which is what makes the
 * hand-over — and the tail it has to protect — possible at all.
 */
function backToBack() {
  return {
    timeline: {
      timeline_version: 1,
      storylang_version: 0,
      duration_ms: 4_000,
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
        {
          source: 'step',
          kind: 'chunk',
          t_ms: 2_000,
          detail: { text: 'Two.', duration_s: 2, audio: NARRATION_TWO },
          line: 3,
          scene_index: 0,
        },
      ],
    },
    bundle: {
      storylang_version: 0,
      audio: { sfx: {}, bgm: { calm: CALM } },
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
      this.played = false;
      this.removed = false;
      this.volume = 1;
      this.currentTime = 0;
      this.loop = false;
      this.listeners = new Map();
      opened.push(this);
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    fire(type) { this.listeners.get(type)?.({ type }); }
    play() { this.played = true; this.paused = false; return onPlay(this) ?? Promise.resolve(); }
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
