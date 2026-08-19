import assert from 'node:assert/strict';
import test from 'node:test';

import { StoryClock } from '../browser/v0/app/clock.mjs';

test('keeps story time at zero until explicit start', () => {
  let wallTime = 1_000;
  const clock = new StoryClock({ now: () => wallTime });

  assert.equal(clock.now(), 0);
  wallTime = 1_500;
  assert.equal(clock.now(), 0);

  clock.start();
  wallTime = 1_725;
  assert.equal(clock.now(), 225);
});

test('pausing freezes story time however long the viewer is away', () => {
  let wallTime = 1_000;
  const clock = new StoryClock({ now: () => wallTime });

  clock.start();
  wallTime = 1_400;
  assert.equal(clock.now(), 400);
  clock.pause();
  wallTime = 900_000;
  assert.equal(clock.now(), 400);
  assert.equal(clock.running, false);

  clock.start();
  wallTime = 900_250;
  assert.equal(clock.now(), 650);
  assert.equal(clock.running, true);
});

test('seeking moves the story, not the wall clock, running or paused', () => {
  let wallTime = 1_000;
  const clock = new StoryClock({ now: () => wallTime });

  clock.start();
  wallTime = 2_000;
  clock.seek(4_000);
  assert.equal(clock.now(), 4_000);
  wallTime = 2_500;
  assert.equal(clock.now(), 4_500, 'a seek while running must keep running from where it landed');

  clock.pause();
  clock.seek(120);
  wallTime = 90_000;
  assert.equal(clock.now(), 120, 'a seek while paused must not start the story');
  clock.start();
  wallTime = 90_400;
  assert.equal(clock.now(), 520);
});

// `stateAt` refuses a t that is not a finite number of milliseconds, so a
// control that could hand it one would be a player that stops rather than a
// scrub that ran off its own bar.
test('a seek before the opening frame, or to nothing at all, lands at zero', () => {
  const clock = new StoryClock({ now: () => 5_000 });

  clock.start();
  clock.seek(-9_000);
  assert.equal(clock.now(), 0);
  clock.seek(Number.NaN);
  assert.equal(clock.now(), 0);
  clock.seek(undefined);
  assert.equal(clock.now(), 0);
});
