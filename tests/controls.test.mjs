/**
 * The control bar, against the REAL template.
 *
 * Built from `createPlayerTemplate` rather than a hand-made element bag on
 * purpose: half of what can break here is a class or an element name drifting
 * apart between the markup and the module that drives it, and a fake bag would
 * keep both green while the shipped player lost its transport.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createPlayerTemplate } from '../browser/template.mjs';
import { createControls } from '../browser/v0/app/controls.mjs';
import { installDom } from './_dom.mjs';

const STORY_MS = 600_000;
// `createControls`'s own default, and the length the stylesheet draws the mark
// fading over. Two copies of one number, which is why they are compared below.
const FLASH_MS = 620;

test('the bar stays out of the way until the story begins', (t) => {
  const { bar, controls, seen } = bench(t);

  assert.equal(bar.root.hidden, true);
  assert.equal(bar.toggle.disabled, true);

  controls.arm(STORY_MS);
  assert.equal(bar.toggle.disabled, false, 'the transport is still dead after the length is known');
  assert.equal(bar.root.hidden, true, 'the bar appeared under the begin ceremony');
  assert.equal(bar.total.textContent, '10:00');

  // Deaf as well as invisible: the keydown listener lives on the stage frame,
  // and the begin button is inside that frame. Space on it must press the
  // button, not start a story nobody has begun.
  bar.frame.dispatch('keydown', { key: ' ' });
  bar.toggle.dispatch('click');
  bar.scrub.dispatch('pointerdown', { clientX: 960, pointerId: 1 });
  assert.deepEqual(seen, { toggles: 0, seeks: [], skips: [] });

  controls.show();
  assert.equal(bar.root.hidden, false);
  bar.frame.dispatch('keydown', { key: ' ' });
  assert.equal(seen.toggles, 1);
});

test('the bar says where the story is, in numbers and in words', (t) => {
  const { bar, controls } = bench(t);
  controls.arm(STORY_MS);

  controls.update({ tMs: 252_000, playing: true });
  assert.equal(bar.at.textContent, '4:12');
  assert.equal(bar.fill.style.width, '42%');
  assert.equal(bar.handle.style.left, '42%');
  assert.equal(bar.remaining.textContent, '6 min left');
  assert.equal(bar.scrub.getAttribute('aria-valuenow'), '252');
  assert.equal(bar.scrub.getAttribute('aria-valuemax'), '600');
  assert.equal(bar.scrub.getAttribute('aria-valuetext'), '4:12 of 10:00');
  assert.equal(bar.toggle.getAttribute('aria-label'), 'pause');
  assert.equal(bar.toggle.classList.contains('is-playing'), true);
});

test('play, pause and replay are the same button in three states', (t) => {
  const { bar, controls } = bench(t);
  controls.arm(STORY_MS);

  controls.update({ tMs: 1_000, playing: false });
  assert.equal(bar.toggle.getAttribute('aria-label'), 'play');
  assert.equal(bar.toggle.classList.contains('is-playing'), false);

  controls.update({ tMs: 1_000, playing: true });
  assert.equal(bar.toggle.getAttribute('aria-label'), 'pause');

  controls.update({ tMs: STORY_MS, playing: false, ended: true });
  assert.equal(bar.toggle.getAttribute('aria-label'), 'replay');
  assert.equal(bar.toggle.classList.contains('is-replay'), true);
  assert.equal(bar.toggle.classList.contains('is-playing'), false);
  assert.equal(bar.at.textContent, '10:00');
  assert.equal(bar.remaining.textContent, '0 s left');
});

test('a pointer on the bar seeks to where it landed, and stops when it is let go', (t) => {
  const { bar, controls, seen, landed } = bench(t);
  controls.arm(STORY_MS);
  controls.show();

  // The fake stage measures 1920 wide from x=0, so half the bar is half the
  // story — the arithmetic under test is the fraction, not the geometry.
  bar.scrub.dispatch('pointerdown', { clientX: 960, pointerId: 1 });
  assert.deepEqual(seen.seeks, [300_000]);

  bar.scrub.dispatch('pointermove', { clientX: 480, pointerId: 1 });
  assert.deepEqual(seen.seeks, [300_000, 150_000]);
  // A drag moves the picture at every position and asks for the sound at
  // none of them: that is the difference between a scrub and a seek.
  assert.deepEqual(landed, [], 'a drag in flight asked for the sound to be placed');

  // Letting go is the one landing, at the position the pointer was let go at.
  bar.scrub.dispatch('pointerup', { clientX: 480, pointerId: 1 });
  assert.deepEqual(landed, [150_000]);
  bar.scrub.dispatch('pointermove', { clientX: 1_440, pointerId: 1 });
  assert.deepEqual(seen.seeks, [300_000, 150_000, 150_000], 'the bar kept seeking after the pointer was released');
  assert.deepEqual(landed, [150_000], 'a released pointer landed the story twice');

  // A pointer beyond either end of the bar is a fraction outside 0..1, and a
  // story has no time there.
  bar.scrub.dispatch('pointerdown', { clientX: -400, pointerId: 2 });
  bar.scrub.dispatch('pointermove', { clientX: 9_000, pointerId: 2 });
  assert.deepEqual(seen.seeks.slice(-2), [0, STORY_MS]);
  // A cancelled pointer carries no position worth reading; the story lands
  // where the last move left it rather than nowhere.
  bar.scrub.dispatch('pointercancel', { pointerId: 2 });
  assert.deepEqual(landed, [150_000, STORY_MS]);
});

test('the transport buttons and the keyboard mean the same three things', (t) => {
  const { bar, controls, seen } = bench(t);
  controls.arm(STORY_MS);
  controls.show();

  bar.toggle.dispatch('click');
  bar.back.dispatch('click');
  bar.forward.dispatch('click');
  assert.equal(seen.toggles, 1);
  assert.deepEqual(seen.skips, [-10_000, 10_000]);

  bar.frame.dispatch('keydown', { key: ' ' });
  bar.frame.dispatch('keydown', { key: 'ArrowRight' });
  bar.frame.dispatch('keydown', { key: 'ArrowLeft' });
  bar.frame.dispatch('keydown', { key: 'Home' });
  bar.frame.dispatch('keydown', { key: 'End' });
  assert.equal(seen.toggles, 2);
  assert.deepEqual(seen.skips, [-10_000, 10_000, 10_000, -10_000]);
  assert.deepEqual(seen.seeks, [0, STORY_MS]);

  // Somebody typing into the page that embeds us is not steering the story.
  bar.frame.dispatch('keydown', { key: ' ', target: { tagName: 'INPUT' } });
  assert.equal(seen.toggles, 2);

  // `k` is the second play/pause key every video player has, and the docs
  // promise it.
  bar.frame.dispatch('keydown', { key: 'k' });
  assert.equal(seen.toggles, 3);

  // Enter belongs to whatever button has focus — `cc`, the log drawer, the
  // transport itself. Swallowed here, a keyboard user cannot press any of them.
  bar.frame.dispatch('keydown', { key: 'Enter', target: { tagName: 'BUTTON' } });
  bar.frame.dispatch('keydown', { key: ' ', target: { tagName: 'BUTTON' } });
  assert.equal(seen.toggles, 3, 'a key meant for a focused button reached the transport instead');
});

test('the picture is the play switch, and the click leaves a mark saying so', async (t) => {
  const { bar, controls, seen } = bench(t, { flashMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });

  bar.stage.dispatch('click');
  assert.equal(seen.toggles, 1, 'the picture did not toggle the story');
  await tick();
  assert.equal(bar.flash.classList.contains('is-on'), true, 'the click left no mark on the picture');
  assert.equal(bar.flash.classList.contains('is-pause'), true, 'a click that pauses drew the play glyph');

  // The mark is a moment, not a state.
  await tick(30);
  assert.equal(bar.flash.classList.contains('is-on'), false, 'the mark stayed on the picture');

  // And the other way round: a click on a paused story offers play.
  controls.update({ tMs: 0, playing: false });
  bar.stage.dispatch('click');
  await tick();
  assert.equal(bar.flash.classList.contains('is-pause'), false);
});

test('the overlay follows the pointer and withdraws from a story left alone', async (t) => {
  const { bar, controls } = bench(t, { idleMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the story began with its overlay already gone');

  await tick(40);
  assert.equal(bar.frame.classList.contains('is-bare'), true, 'a running story kept its transport over the picture');

  bar.frame.dispatch('pointermove');
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the pointer did not bring the overlay back');

  // A pointer that leaves takes the overlay with it — there is nothing left to
  // reach for it with.
  bar.frame.dispatch('pointerleave');
  assert.equal(bar.frame.classList.contains('is-bare'), true);
});

test('a paused story keeps its transport under the pointer, and not once it leaves', async (t) => {
  // Standing still is not the same as being left: the one thing a viewer who
  // stopped a story is looking for is the way to start it again, so the
  // countdown does not run — but a picture nobody is pointing at is a picture.
  const { bar, controls } = bench(t, { idleMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 1_000, playing: false });

  await tick(40);
  assert.equal(
    bar.frame.classList.contains('is-bare'),
    false,
    'a paused story hid its own transport with the pointer still on it',
  );

  bar.frame.dispatch('pointerleave');
  assert.equal(
    bar.frame.classList.contains('is-bare'),
    true,
    'the transport stayed over a paused picture nobody was pointing at',
  );
});

test('a key brings the overlay back before it does anything else', (t) => {
  // A keyboard has no pointer to wake the overlay with.
  const { bar, controls, seen } = bench(t, { idleMs: 5_000 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });
  bar.frame.dispatch('pointerleave');
  assert.equal(bar.frame.classList.contains('is-bare'), true);

  bar.frame.dispatch('keydown', { key: ' ' });
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the overlay stayed hidden from a keyboard');
  assert.equal(seen.toggles, 1, 'the key that revealed the overlay was swallowed by it');
});

test('the frames a story draws do not keep restarting the countdown', async (t) => {
  // `update()` is called on every drawn frame, twenty-four a second, which is
  // why waking lives inside the mode WRITE rather than beside it: moved one
  // line out, the timer is cleared and re-set every 42 ms and the overlay never
  // withdraws from a story that is playing normally.
  const { bar, controls } = bench(t, { idleMs: 30 });
  controls.arm(STORY_MS);
  controls.show();
  const until = Date.now() + 90;
  while (Date.now() < until) {
    controls.update({ tMs: 1_000, playing: true });
    await tick(5);
  }

  assert.equal(bar.frame.classList.contains('is-bare'), true, 'the drawing itself held the overlay open');
});

test('a story that has ended keeps the way to play it again', async (t) => {
  // The end card covers the picture, so the click that would bring the overlay
  // back cannot reach the stage: an ended story that withdrew its transport
  // could not be replayed at all.
  const { bar, controls } = bench(t, { idleMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: STORY_MS, playing: false, ended: true });

  await tick(40);
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the replay transport withdrew from a finished story');
});

test('a second click gives the mark a second life', async (t) => {
  const { bar, controls } = bench(t, { flashMs: 60 });
  controls.arm(STORY_MS);
  controls.show();

  bar.stage.dispatch('click');
  await tick(30);
  assert.equal(bar.flash.classList.contains('is-on'), true);

  bar.stage.dispatch('click');
  assert.equal(bar.flash.classList.contains('is-on'), false, 'the mark was not taken off before being put back');
  await tick(40);
  // 70 ms after the FIRST click: its own timer would have stripped the second
  // mark here if it had not been cleared.
  assert.equal(bar.flash.classList.contains('is-on'), true, 'the first click’s timer wiped the second mark');
  await tick(40);
  assert.equal(bar.flash.classList.contains('is-on'), false, 'the mark outstayed its life');
});

test('a tap does not take the transport away', (t) => {
  // A device with no hover fires `pointerleave` right after every `pointerup`.
  // Obeyed, it would leave a phone showing the transport only while a finger is
  // held down.
  const { bar, controls } = bench(t);
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });

  bar.frame.dispatch('pointerdown', { pointerType: 'touch' });
  bar.stage.dispatch('click');
  bar.frame.dispatch('pointerleave', { pointerType: 'touch' });

  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the tap ended by hiding what it had just revealed');
});

test('what a keyboard is on is not taken away under it', async (t) => {
  // A control made `visibility: hidden` under a focus ring drops that focus out
  // of the player, and every key with it — the only `keydown` listener is
  // inside the frame the focus has just left.
  const { bar, controls } = bench(t, { idleMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });
  bar.frame.getRootNode = () => ({ activeElement: bar.toggle });
  // A key is what put the focus there, and a key is all this viewer has.
  bar.frame.dispatch('keydown', { key: 'ArrowRight' });

  await tick(40);
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the countdown blurred a focused control');
  bar.frame.dispatch('pointerleave');
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the pointer leaving blurred a focused control');
});

test('a button a click left focused does not hold the overlay open', async (t) => {
  // Clicking `cc` with a mouse leaves it focused without a keyboard being
  // anywhere near it. Read as "somebody is on this control", it kept the
  // transport on screen for the rest of the story, hover or no hover.
  const { bar, controls } = bench(t, { idleMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });
  let parked = 0;
  bar.frame.focus = () => { parked += 1; };
  bar.frame.getRootNode = () => ({ activeElement: bar.toggle });
  // The pointer is what put the focus there — the click itself.
  bar.frame.dispatch('pointerdown');

  await tick(40);
  assert.equal(bar.frame.classList.contains('is-bare'), true, 'a click-focused button froze the overlay');
  // And the keys go with it: the frame is where they are read.
  assert.equal(parked, 1, 'the focus was left on a control that has just been hidden');
});

test('the bar being dragged does not vanish under the pointer', async (t) => {
  const { bar, controls } = bench(t, { idleMs: 20 });
  controls.arm(STORY_MS);
  controls.show();
  controls.update({ tMs: 0, playing: true });
  bar.scrub.dispatch('pointerdown', { clientX: 960, pointerId: 1 });

  await tick(40);
  assert.equal(bar.frame.classList.contains('is-bare'), false, 'the scrub withdrew from the hand holding it');
  bar.scrub.dispatch('pointerup', { clientX: 960, pointerId: 1 });
});

test('the toggles over the picture arrive with the transport, not before it', (t) => {
  const { bar, controls } = bench(t);
  controls.arm(STORY_MS);

  assert.equal(bar.actions.hidden, true, 'the cc pill was painted over the opening ceremony');
  controls.show();
  assert.equal(bar.actions.hidden, false, 'the toggles never arrived with the story');
});

test('the stylesheet carries the two rules this behaviour leans on', () => {
  // Both are invisible in a call log and load-bearing in a browser: the mark
  // covers the whole stage, and `is-bare` has to take its controls out of the
  // tab order rather than merely fade them.
  const css = fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /\.stage-flash\s*\{[^}]*pointer-events:\s*none/,
    'the mark can swallow every click meant for the picture',
  );
  assert.match(
    css,
    /\.stage-frame\.is-bare[^{]*\{[^}]*visibility:\s*hidden/,
    'a withdrawn overlay is still focusable and still takes the tap meant for the picture',
  );
  assert.match(css, /\.stage-actions\[hidden\]\s*\{\s*display:\s*none/, 'the withdrawn actions row still paints');

  // The mark's life is one number written twice: the class is stripped by a
  // timer here and the fade is drawn by an animation there. Apart, the mark is
  // cut off mid-fade or leaves a fully drawn circle sitting on the picture.
  const animation = /animation:\s*flash-mark\s+(\d+)ms/.exec(css);
  assert.ok(animation, 'the mark has no animation to fade with');
  assert.equal(Number(animation[1]), FLASH_MS, 'the mark is stripped at a different moment than it is drawn');
});

test('the picture is not a switch until the story has begun', (t) => {
  // The ceremony is on top of the stage, so this cannot normally be reached
  // before begin — but the bar is what decides what "live" means, and a click
  // that started a story behind its own opening would be a story nobody chose.
  const { bar, controls, seen } = bench(t);
  controls.arm(STORY_MS);

  bar.stage.dispatch('click');
  assert.deepEqual(seen, { toggles: 0, seeks: [], skips: [] });
});

test('destroy leaves nothing listening', (t) => {
  const { bar, controls, seen } = bench(t);
  controls.arm(STORY_MS);
  controls.destroy();

  bar.toggle.dispatch('click');
  bar.back.dispatch('click');
  bar.scrub.dispatch('pointerdown', { clientX: 960, pointerId: 1 });
  bar.frame.dispatch('keydown', { key: ' ' });
  assert.deepEqual(seen, { toggles: 0, seeks: [], skips: [] });
});

/** Let the overlay's countdown and the mark's timers run. */
function tick(ms = 0) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function bench(t, { idleMs, flashMs } = {}) {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const elements = createPlayerTemplate(root);
  const seen = { toggles: 0, seeks: [], skips: [] };
  // `landed` is the subset the runtime is asked to SOUND at: a settled seek.
  // Not in `seen`, so the "nothing reached the callbacks" assertions above keep
  // their exact shape.
  const landed = [];
  const controls = createControls(elements.controls, {
    onToggle: () => { seen.toggles += 1; },
    onSeek: (milliseconds, { settled = true } = {}) => {
      seen.seeks.push(milliseconds);
      if (settled) landed.push(milliseconds);
    },
    onSkip: (milliseconds) => seen.skips.push(milliseconds),
    ...(idleMs === undefined ? {} : { idleMs }),
    ...(flashMs === undefined ? {} : { flashMs }),
  });
  t.after(() => controls.destroy());
  return { bar: elements.controls, controls, seen, landed };
}
