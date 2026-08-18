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
import { soundingAt } from '../browser/v0/core/state/cues.mjs';
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

test('the line a pause stood on is heard when the story resumes', async (t) => {
  const player = await mount(t);
  const cue = firstNarrationAfter(player.timeline, 1_000);
  player.start();
  // Same shape as the test above — last frame just before the line, the click
  // just after it — and then the OTHER half: the viewer comes back. Story time
  // has not moved, so the resume's first frame crosses the sliver the pause
  // stood in and starts the line, a few tens of milliseconds after its cue.
  // Skipping that sliver on pause lost the line for good: its subtitle on
  // screen, nothing to hear, until the next cue came round.
  player.frames.advanceTo(cue - 30);
  const opened = player.audio.length;
  player.frames.setWall(cue + 10);
  player.bar.toggle.dispatch('click');
  assert.equal(player.audio.length, opened, 'the pause itself started the next line');

  // Minutes may pass on the wall; none pass in the story.
  player.frames.setWall(cue + 90_000);
  player.bar.toggle.dispatch('click');
  assert.equal(player.audio.length, opened + 1, 'the line the pause stood on was never heard');
  const line = player.audio.at(-1);
  assert.equal(line.paused, false, 'the resumed line is not playing');
  assert.equal(line.currentTime, 0, 'a line a frame late should start from the top, not inside the file');
  player.destroy();
});

test('dragging the bar moves the picture at every position and places the sound once, where the pointer lands', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(2_000);
  const opened = player.audio.length;
  const box = player.bar.scrub.getBoundingClientRect();
  const at = (fraction) => ({ clientX: box.left + (box.width * fraction), pointerId: 1 });

  // A drag from a fifth of the story to a third of it, in twelve pointer events,
  // with the loop running between them. Every one of those positions is inside
  // a narration line in this corpus, so a runtime that placed the sound per
  // move would open a dozen narration elements — a fetch and a decoder each —
  // and throw eleven of them away.
  player.bar.scrub.dispatch('pointerdown', at(0.2));
  const seen = new Set([player.bar.at.textContent]);
  for (let step = 1; step <= 11; step += 1) {
    player.bar.scrub.dispatch('pointermove', at(0.2 + (step * 0.01)));
    player.frames.advanceTo(2_000 + (step * 40));
    seen.add(player.bar.at.textContent);
  }
  assert.ok(seen.size >= 2, 'the picture did not follow the drag');
  assert.equal(player.audio.length, opened, `the drag opened ${player.audio.length - opened} narration elements before the pointer landed`);
  assert.equal(player.audio.every((media) => media.paused), true, 'a story being dragged is still talking');

  // The landing: the one line sounding there, from inside the file, playing —
  // the story is running. What `soundingAt` says, and nothing the drag passed.
  const landedMs = Math.round(player.timeline.duration_ms * 0.31);
  const { narration } = soundingAt(player.timeline, player.bundle, landedMs);
  assert.ok(narration, 'pick a landing inside a line — the corpus moved');
  player.bar.scrub.dispatch('pointerup', at(0.31));
  assert.equal(player.audio.length, opened + 1, 'letting go did not place the sound exactly once');
  const line = player.audio.at(-1);
  assert.equal(line.url, narration.media, 'the landing opened a line other than the one sounding there');
  assert.equal(line.paused, false, 'the landing placed a line but did not play it');
  assert.equal(
    line.currentTime,
    narration.offsetMs > 120 ? narration.offsetMs / 1000 : 0,
    'the landing did not start the line where the story is',
  );
  // And the loop keeps crossing time afterwards: the next cue still fires.
  player.frames.advanceTo(2_000 + (12 * 40));
  assert.ok(player.frames.pending() > 0, 'the loop stopped after the drag');
  player.destroy();
});

test('seeking a paused story places the sound without playing it', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(2_000);
  player.bar.toggle.dispatch('click');

  const box = player.bar.scrub.getBoundingClientRect();
  player.bar.scrub.dispatch('pointerdown', { clientX: box.left + (box.width * 0.3), pointerId: 1 });
  player.bar.scrub.dispatch('pointerup', { clientX: box.left + (box.width * 0.3), pointerId: 1 });
  assert.equal(player.audio.every((media) => media.paused), true, 'scrubbing a paused story talks');

  player.bar.toggle.dispatch('click');
  // Every medium the scheduler still holds, not just one of them: `some` passed
  // on the line the seek had just opened while a track the first pause held was
  // never restarted at all. (The corpus story carries no music, so the set that
  // regression really cost is pinned in `media-scheduler.test.mjs`.)
  const live = player.audio.filter((media) => !media.removed);
  assert.ok(live.length > 0, 'the seek left the story with nothing to resume');
  assert.equal(live.every((media) => !media.paused), true, 'the sound the seek placed never resumed');
  player.destroy();
});

test('a paused seek into a scene that is still decoding draws it when the sheets land', async (t) => {
  const player = await mount(t);
  // Every sheet from here on is held: the seek lands on a scene the cache has
  // nothing for, which is what a scrub into a story's last minute really is on
  // a slow link.
  const real = globalThis.fetch;
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  let holding = true;
  globalThis.fetch = async (url, init) => {
    if (holding) await held;
    return real(url, init);
  };
  t.after(() => { globalThis.fetch = real; });
  const drawn = () => player.canvas.context.calls.filter(([name]) => name === 'drawImage').length;

  player.start();
  player.frames.advanceTo(1_000);
  player.bar.toggle.dispatch('click');
  const box = player.bar.scrub.getBoundingClientRect();
  player.bar.scrub.dispatch('pointerdown', { clientX: box.left + (box.width * 0.95), pointerId: 1 });
  const placeholders = drawn();

  holding = false;
  release();
  await settle();

  // A running story would have drawn them on its next frame. A paused one has
  // no next frame: without a repaint when the decode lands, the placeholder
  // lozenges stay on screen until somebody presses play.
  assert.ok(
    drawn() > placeholders,
    'the sheets arrived and nothing drew them: the paused stage stayed on placeholders',
  );
  player.destroy();
});

test('a line whose audio fails says so on the stage, and the next line clears it', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(300);
  const line = player.audio.find((media) => media.url?.includes('/audio/'));
  assert.ok(line, 'the story under test opened no narration to fail');

  line.listeners.get('error')?.({ type: 'error' });
  assert.equal(
    player.mediaNote.textContent,
    'narration unavailable · read along',
    'a line that could not be heard said nothing a viewer without the log can see',
  );

  // The note belongs to the line it was raised for.
  const subtitle = player.subtitle.textContent;
  for (let at = 400; at <= 6_000 && player.subtitle.textContent === subtitle; at += 100) {
    player.frames.advanceTo(at);
  }
  assert.notEqual(player.subtitle.textContent, subtitle, 'the story never reached another line');
  assert.equal(player.mediaNote.textContent, '', 'the note outlived the line it was raised for');
  player.destroy();
});

test('the skip buttons move ten seconds from where the story is', async (t) => {
  // `seekTo(delta)` instead of `seekTo(now + delta)` passes every controls test
  // there is — the bar only ever reports the number it handed over — and turns
  // skip-back into "jump to the beginning" from anywhere in the story.
  const player = await mount(t);
  const duration = player.timeline.duration_ms;
  player.start();
  player.frames.advanceTo(1_000);
  player.bar.toggle.dispatch('click');

  const box = player.bar.scrub.getBoundingClientRect();
  player.bar.scrub.dispatch('pointerdown', { clientX: box.left + (box.width * 0.95), pointerId: 1 });
  const landed = Math.round(duration * 0.95);
  assert.equal(player.bar.at.textContent, clockText(landed));

  player.bar.back.dispatch('click');
  assert.equal(
    player.bar.at.textContent,
    clockText(Math.max(0, landed - 10_000)),
    'the skip landed somewhere other than ten seconds back from where the story stood',
  );
  player.destroy();
});

test('a demotion lowers the ceiling the cache holds sheets against', async (t) => {
  // Sheets too big for either budget, so the cache reports its ceiling every
  // time a scene is loaded — the only place the number is observable from
  // outside, and the only proof the demotion reached the cache at all.
  const player = await mount(t, {
    options: { debug: true, perf: true },
    machine: { deviceMemory: 16, hardwareConcurrency: 16 },
    assets: () => ({ width: 3_600, height: 3_600 }),
  });
  const ceilings = () => player.warnings()
    .map((line) => /against a (\d+) MB budget/.exec(line)?.[1])
    .filter(Boolean);
  player.start();
  assert.equal(ceilings().at(-1), '96', 'a 16 GB machine did not start on the full budget');

  slowFrames(player, 6_000);
  const logged = await player.log();
  assert.deepEqual(
    logged.filter((entry) => entry.reason === 'tier').map((entry) => `${entry.from}→${entry.to}`),
    ['high→mid'],
    'exactly one demotion should have happened by now',
  );

  // The next scene is loaded against whatever ceiling the cache is on now.
  player.frames.advanceTo(8_000);
  await settle();
  assert.equal(ceilings().at(-1), '48', 'the demotion never reached the cache');
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
  const player = await mount(t, {
    doctor: (story) => {
      const [slug] = Object.keys(story.cast);
      story.cast[slug].clips = {};
    },
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
  // The list also carries the compiler's own refusals now — written once at
  // mount by `main.mjs`, and this doctored story raises those too — so the
  // count is no longer one number. What must hold is that nothing repeats, and
  // that every runtime warning is in there.
  const logged = player.warnings();
  assert.equal(
    logged.length,
    new Set(logged).size,
    'a warning stateAt repeats on every frame reached the log more than once',
  );
  assert.ok(
    logged.length >= new Set(late).size,
    'the runtime warnings never reached the log at all',
  );
  player.destroy();
});

test('what the compiler refused reaches the log, once, before a frame is drawn', async (t) => {
  // The compiler records every refusal into the schedule — a clip the bundle
  // never carried, a character nobody could place, a camera target it could not
  // resolve — and nothing at runtime read those events back: `stateAt` hands
  // `source: step` entries to the band layout and returns. Between the live
  // director and the rewrite they went from the panel's list to nowhere, and a
  // story that quietly lost a character had a clean log.
  const player = await mount(t, {
    options: { debug: true },
    doctor: (story) => {
      const [slug] = Object.keys(story.cast);
      story.cast[slug].clips = {};
    },
  });

  const raised = player.timeline.events.filter((event) => event.kind === 'warning');
  const logged = (await player.log()).filter(
    (entry) => entry.kind === 'warning' && entry.detail?.policy === raised[0]?.detail?.policy,
  );

  assert.ok(raised.length > 1, 'the doctored story raised no repeated refusal to say once');
  assert.equal(logged.length, 1, 'a refusal raised at three instants was said three times');
  assert.equal(logged[0].t_ms, raised[0].t_ms, 'the refusal lost the instant it was raised at');
  player.destroy();
});

test('a machine that says it is weak is drawn for cheaply', async (t) => {
  const weak = await mount(t, {
    machine: { deviceMemory: 2, hardwareConcurrency: 2, devicePixelRatio: 3 },
  });
  weak.start();
  const cheap = draws(weak, 1_000);
  weak.destroy();

  const strong = await mount(t, {
    machine: { deviceMemory: 8, hardwareConcurrency: 8, devicePixelRatio: 3 },
  });
  strong.start();
  const full = draws(strong, 1_000);

  // 12 Hz against 24: the loop skips every other tick, and the work per second
  // halves with it.
  assert.ok(cheap.painted > 0 && full.painted > 0, 'neither tier drew anything at all');
  assert.ok(
    cheap.painted <= full.painted * 0.6,
    `the low tier drew ${cheap.painted} frames against the default tier's ${full.painted}`,
  );
  // The shadow under each character is the most expensive thing on the list.
  assert.equal(cheap.shadows, 0, 'the low tier still painted shadows');
  assert.ok(full.shadows > 0, 'the default tier stopped painting shadows');
  // And the canvas is backed at 1.5x rather than the ladder's 2x ceiling.
  assert.ok(cheap.backing < full.backing, `low backed the canvas at ${cheap.backing}, default at ${full.backing}`);
  strong.destroy();
});

test('perf: true measures each scene, and a demotion says so', async (t) => {
  const player = await mount(t, { options: { debug: true, perf: true } });
  player.start();

  // Frames a hundred milliseconds apart: three times the 34 ms a frame may take
  // before it is counted slow, held for long enough to fill two demotion
  // windows. This is what a machine that cannot keep up looks like.
  for (let at = 100; at <= 12_000; at += 100) player.frames.advanceTo(at);

  // Read before the download: downloading flushes the open section, and what
  // the panel shows after that is a section with no frames in it yet.
  const summary = player.perfSummary.textContent;
  const logged = await player.log();
  const perf = logged.filter((entry) => entry.kind === 'perf');
  const tiers = perf.filter((entry) => entry.reason === 'tier');
  assert.ok(perf.length > tiers.length, 'no scene section was written at all');
  assert.deepEqual(
    tiers.map((entry) => `${entry.from}→${entry.to}`),
    ['high→mid', 'mid→low'],
    'the tier did not fall twice under five seconds of slow frames each',
  );
  const measured = perf.find((entry) => entry.reason !== 'tier');
  assert.ok(measured.frames > 0, 'a section was written with no frames in it');
  assert.equal(measured.frame_ms.p95 >= 100, true, 'the p95 does not reflect the frames it was fed');
  // The panel shows the LAST thing measured, and by now that is a scene running
  // on the tier the demotions arrived at.
  assert.match(summary, /^scene \d+ · low · \d+ frames · p95 \d+/);
  assert.equal(player.perfSummary.hidden, false);
  // The download closed the section the story was in, rather than leaving the
  // scene on screen out of the log a bug report is made of.
  assert.equal(perf.at(-1).reason, 'download');

  player.destroy();
});

test('a demotion makes the picture cheaper while the story is still running', async (t) => {
  // Starting on `mid` — a 4 GB phone — because `mid` costs the picture nothing
  // and only the step below it is visible. One demotion, inside a story that is
  // still playing on the other side of it.
  const player = await mount(t, {
    options: { debug: true, perf: true },
    machine: { deviceMemory: 4, hardwareConcurrency: 8, devicePixelRatio: 3 },
  });
  player.start();
  const before = draws(player, 1_000);

  slowFrames(player, 6_000);
  const logged = await player.log();
  assert.deepEqual(
    logged.filter((entry) => entry.reason === 'tier').map((entry) => `${entry.from}→${entry.to}`),
    ['mid→low'],
    'exactly one demotion should have happened by now',
  );

  const after = draws(player, 1_000);
  assert.ok(after.painted > 0, 'the loop stopped drawing altogether');
  assert.ok(
    after.painted <= before.painted * 0.6,
    `after two demotions the loop still drew ${after.painted} against ${before.painted}`,
  );
  assert.ok(before.shadows > 0 && after.shadows === 0, 'the low tier is still painting shadows');
  assert.ok(after.backing < before.backing, `the canvas is still backed at ${after.backing} device pixels`);
  player.destroy();
});

test('the log says which machine it came from, and only when asked to measure', async (t) => {
  const player = await mount(t, {
    options: { debug: true, perf: true },
    machine: { deviceMemory: 2, hardwareConcurrency: 2, devicePixelRatio: 3 },
  });
  const logged = await player.log();
  const capability = logged.filter((entry) => entry.kind === 'capability');

  assert.equal(capability.length, 1);
  assert.deepEqual(capability[0], {
    t_ms: 0,
    kind: 'capability',
    tier: 'low',
    reasons: ['device-memory-low', 'cores-low'],
    device_memory: 2,
    cores: 2,
    dpr: 3,
    draw_hz: 12,
    dpr_cap: 1.5,
    shadows: false,
    reduced_motion: false,
  });
  player.destroy();
});

test('the tier sizes the decoded-sheet budget the cache is built with', async (t) => {
  // Sheets big enough that a scene costs more than the halved budget and less
  // than the full one: the mid tier is the budget and nothing else, so this is
  // the only place its wiring is visible.
  const huge = () => ({ width: 3_600, height: 3_600 });
  const mid = await mount(t, {
    options: { debug: true },
    machine: { deviceMemory: 4, hardwareConcurrency: 8 },
    assets: huge,
  });
  const strong = await mount(t, {
    options: { debug: true },
    machine: { deviceMemory: 16, hardwareConcurrency: 16 },
    assets: huge,
  });

  // Both machines are over their ceiling with sheets this big; what the wiring
  // decides is WHICH ceiling each of them was given.
  const ceiling = (player) => player.warnings()
    .map((line) => /against a (\d+) MB budget/.exec(line)?.[1])
    .find(Boolean);
  assert.equal(ceiling(mid), '48', 'a 4 GB machine kept the full budget');
  assert.equal(ceiling(strong), '96', 'a 16 GB machine was given the halved budget');
  mid.destroy();
  strong.destroy();
});

test('measuring costs nothing when nobody asked for it, and is released when they did', async (t) => {
  const scope = watchScope(t);
  const quiet = await mount(t, { options: { debug: true } });
  assert.deepEqual(
    { intervals: scope.intervals, observers: scope.observers },
    { intervals: 0, observers: 0 },
    'a player nobody asked to measure still armed a timer or an observer',
  );
  quiet.destroy();

  const measured = await mount(t, { options: { debug: true, perf: true } });
  assert.equal(scope.intervals, 1);
  assert.equal(scope.observers, 1);
  measured.destroy();
  assert.equal(scope.cleared, 1, 'the lag probe outlived the player');
  assert.equal(scope.disconnected, 1, 'the long-frame observer outlived the player');
});

test('what the plate dropped is measured through the plate, not around it', async (t) => {
  const player = await mount(t, { options: { debug: true, perf: true } });
  player.start();
  player.frames.advanceTo(500);
  player.video.quality = { droppedVideoFrames: 7, totalVideoFrames: 400 };

  const first = (await player.log()).filter((entry) => entry.kind === 'perf').at(-1);
  assert.equal(first.video_dropped, 7, 'the plate dropped frames nobody counted');
  assert.equal(first.video_total, 400);

  // The counters belong to the resource and only ever climb, so what a section
  // reports is what happened DURING it.
  player.video.quality = { droppedVideoFrames: 9, totalVideoFrames: 700 };
  const second = (await player.log()).filter((entry) => entry.kind === 'perf').at(-1);
  assert.equal(second.video_dropped, 2);
  assert.equal(second.video_total, 300, 'the counters are read as deltas from the last section');
  player.destroy();
});

/** Count what a `perf: true` player arms on the global scope, and what it frees. */
function watchScope(t) {
  const originals = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    PerformanceObserver: globalThis.PerformanceObserver,
  };
  const counts = { intervals: 0, cleared: 0, observers: 0, disconnected: 0 };
  globalThis.setInterval = () => { counts.intervals += 1; return 77; };
  globalThis.clearInterval = () => { counts.cleared += 1; };
  globalThis.PerformanceObserver = class {
    static supportedEntryTypes = ['long-animation-frame'];
    constructor() { counts.observers += 1; }
    observe() {}
    disconnect() { counts.disconnected += 1; }
  };
  t.after(() => Object.assign(globalThis, originals));
  return counts;
}

test('a player nobody asked to measure writes no perf section', async (t) => {
  const player = await mount(t, { options: { debug: true } });
  player.start();
  for (let at = 100; at <= 6_000; at += 100) player.frames.advanceTo(at);

  const logged = await player.log();
  assert.deepEqual(logged.filter((entry) => entry.kind === 'perf'), []);
  assert.deepEqual(logged.filter((entry) => entry.kind === 'capability'), []);
  assert.equal(player.perfSummary.hidden, true);
  player.destroy();
});

/** The panel's own download, parsed — the same path a bug report takes. */
async function download(root) {
  const original = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let captured = null;
  URL.createObjectURL = (blob) => { captured = blob; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  try {
    findByText(root, 'download')?.dispatch('click');
  } finally {
    URL.createObjectURL = original;
    URL.revokeObjectURL = originalRevoke;
  }
  const payload = JSON.parse(await captured.text());
  return payload.log ?? payload;
}

function findByText(root, text) {
  if (root.textContent === text) return root;
  for (const child of root.children ?? []) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return null;
}

/**
 * `windowMs` of frames a hundred milliseconds apart — three times what a frame
 * may take before it is counted slow. What a machine that cannot keep up looks
 * like to the recorder.
 */
function slowFrames(player, windowMs) {
  const start = player.frames.wall();
  for (let at = start + 100; at <= start + windowMs; at += 100) player.frames.advanceTo(at);
}

/** Drive `windowMs` of frames and report what the canvas actually did. */
function draws(player, windowMs) {
  const context = player.canvas.context;
  const from = context.calls.length;
  const start = player.frames.wall();
  for (let at = start + 50; at <= start + windowMs; at += 50) player.frames.advanceTo(at);
  const since = context.calls.slice(from).map(([name]) => name);
  return {
    painted: since.filter((name) => name === 'clearRect').length,
    shadows: since.filter((name) => name === 'createRadialGradient').length,
    backing: player.canvas.sizes.at(-1)?.[1] ?? 0,
  };
}

/** Let the fetches, decodes and their `.then`s reach their handlers. */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

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
async function mount(t, { doctor = () => {}, options = {}, machine = null, assets } = {}) {
  const dom = installDom(assets ? { assets } : {});
  if (machine) {
    // The probe reads the navigator and the device pixel ratio, so a test that
    // wants a weak machine says so the way a weak machine does.
    globalThis.navigator = { ...globalThis.navigator, ...machine };
    if (machine.devicePixelRatio) globalThis.devicePixelRatio = machine.devicePixelRatio;
    t.after(() => { delete globalThis.devicePixelRatio; });
  }
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
  const player = createStoryPlayer(host, { story: raw, assetBase: ASSET_BASE, ...options });
  // Torn down even when an assertion throws first: the perf recorder holds a
  // real interval, and a leaked one keeps the whole test process alive.
  t.after(() => player.destroy());
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
    warnings: () => [...findByClass(root, 'event-list').children]
      .map((item) => item.childNodes.at(-1)?.textContent ?? ''),
    perfSummary: findByClass(root, 'perf-summary'),
    mediaNote: findByClass(root, 'media-note'),
    // The log as the download carries it — the only way in from outside, and
    // the same path a bug report takes.
    log: () => download(root),
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
    wall: () => wall,
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
