import assert from 'node:assert/strict';
import test from 'node:test';

import { StoryClock, withTimeout } from '../browser/v0/app/clock.mjs';

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

test('settles a blocking path with a fallback when its deadline fires', async () => {
  let fireDeadline;
  let timeoutCount = 0;
  const never = new Promise(() => {});
  const resultPromise = withTimeout(never, 2_000, {
    fallback: 'poster',
    onTimeout: () => { timeoutCount += 1; },
    setTimer: (callback) => { fireDeadline = callback; return 7; },
    clearTimer: () => {},
  });

  fireDeadline();

  assert.deepEqual(await resultPromise, { timedOut: true, value: 'poster' });
  assert.equal(timeoutCount, 1);
});

test('clears the deadline when a blocking path settles first', async () => {
  let clearedTimer = null;

  const result = await withTimeout(Promise.resolve('ready'), 2_000, {
    setTimer: () => 41,
    clearTimer: (timer) => { clearedTimer = timer; },
  });

  assert.deepEqual(result, { timedOut: false, value: 'ready' });
  assert.equal(clearedTimer, 41);
});
