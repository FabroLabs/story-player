/**
 * The control bar, against the REAL template.
 *
 * Built from `createPlayerTemplate` rather than a hand-made element bag on
 * purpose: half of what can break here is a class or an element name drifting
 * apart between the markup and the module that drives it, and a fake bag would
 * keep both green while the shipped player lost its transport.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlayerTemplate } from '../browser/template.mjs';
import { createControls } from '../browser/v0/app/controls.mjs';
import { installDom } from './_dom.mjs';

const STORY_MS = 600_000;

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
  const { bar, controls, seen } = bench(t);
  controls.arm(STORY_MS);
  controls.show();

  // The fake stage measures 1920 wide from x=0, so half the bar is half the
  // story — the arithmetic under test is the fraction, not the geometry.
  bar.scrub.dispatch('pointerdown', { clientX: 960, pointerId: 1 });
  assert.deepEqual(seen.seeks, [300_000]);

  bar.scrub.dispatch('pointermove', { clientX: 480, pointerId: 1 });
  assert.deepEqual(seen.seeks, [300_000, 150_000]);

  bar.scrub.dispatch('pointerup', { clientX: 480, pointerId: 1 });
  bar.scrub.dispatch('pointermove', { clientX: 1_440, pointerId: 1 });
  assert.deepEqual(seen.seeks, [300_000, 150_000], 'the bar kept seeking after the pointer was released');

  // A pointer beyond either end of the bar is a fraction outside 0..1, and a
  // story has no time there.
  bar.scrub.dispatch('pointerdown', { clientX: -400, pointerId: 2 });
  bar.scrub.dispatch('pointermove', { clientX: 9_000, pointerId: 2 });
  assert.deepEqual(seen.seeks.slice(-2), [0, STORY_MS]);
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

function bench(t) {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const elements = createPlayerTemplate(root);
  const seen = { toggles: 0, seeks: [], skips: [] };
  const controls = createControls(elements.controls, {
    onToggle: () => { seen.toggles += 1; },
    onSeek: (milliseconds) => seen.seeks.push(milliseconds),
    onSkip: (milliseconds) => seen.skips.push(milliseconds),
  });
  return { bar: elements.controls, controls, seen };
}
