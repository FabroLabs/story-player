import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import test from 'node:test';

/**
 * The one script nothing else runs.
 *
 * `dump-state.mjs` is the instrument for holding a canvas stage against the
 * pure core — same story, same millisecond, same numbers — so it breaks
 * precisely when somebody reaches for it. Nothing imports it and `npm test`
 * globs only `tests/*.test.mjs`, so this is what keeps it executable.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/dump-state.mjs', import.meta.url));
const BUNDLE = fileURLToPath(new URL('fixtures/parity/golden_push_dusk.bundle.json', import.meta.url));

function dump(...args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('it prints the picture at an instant, without the plate it is drawn on', () => {
  const picture = JSON.parse(dump(BUNDLE, '2500'));
  assert.equal(picture.story, 'Golden: push and dusk');
  assert.equal(picture.tMs, 2500);
  assert.equal(picture.place, 'forest_clearing');
  assert.deepEqual(picture.actors.map((actor) => actor.slug), ['robin']);
  assert.ok(picture.camera.scale > 1, 'the push was under way at 2.5 s');
  assert.ok(!('plate' in picture), 'every traced polygon of the scene came along');
});

test('seconds and milliseconds are two spellings of one instant', () => {
  assert.equal(dump(BUNDLE, '4.7s'), dump(BUNDLE, '4700'));
});

test('it refuses what it cannot read rather than printing an empty picture', () => {
  for (const args of [[], [BUNDLE], [BUNDLE, 'soon'], [BUNDLE, '']]) {
    assert.throws(() => dump(...args), (error) => error.status === 2, `${JSON.stringify(args)} was accepted`);
  }
});
