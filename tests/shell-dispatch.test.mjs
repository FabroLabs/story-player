import assert from 'node:assert/strict';
import test from 'node:test';

import { PERFORMERS, performerFor } from '../browser/performers.mjs';

test('every implemented Storylang version is registered as a player factory', () => {
  assert.deepEqual([...PERFORMERS.keys()], [0]);
  for (const [version, factory] of PERFORMERS) {
    assert.equal(typeof factory, 'function', `performer ${version} is not a factory`);
  }
});

test('v0 dispatches to its registered factory without guessing', () => {
  assert.equal(performerFor({ storylang_version: 0 }), PERFORMERS.get(0));
});

test('unknown, string, and missing versions are refused by name', () => {
  for (const [version, message] of [
    [99, 'bundle version 99 unknown to this player (knows: 0)'],
    ['0', 'bundle version "0" unknown to this player (knows: 0)'],
    [undefined, 'bundle version undefined unknown to this player (knows: 0)'],
  ]) {
    assert.throws(() => performerFor({ storylang_version: version }), { message });
  }
});
