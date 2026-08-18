import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { TIMELINE_OPS } from '../browser/v0/core/timeline/events.mjs';
// The engine's parity corpus. Each `.timeline.json` was produced by the
// machinery this compiler replaces — running the live director against a
// recording stage under a virtual clock — so equality with them is the whole
// proof that the rewrite moved no semantics. They are goldens, not examples:
// a diff here is a rule change and needs saying out loud.
import { STEMS, read, slurp } from './_parity.mjs';

// `tools/mobile/timeline.mjs`'s own `serialize`, kept identical here on
// purpose: the law is that the ENGINE writes these exact bytes from this exact
// compiler, and a deep-equal assertion cannot see key order — the one thing
// only a serializer notices.
function serialize(timeline) {
  return `${JSON.stringify(sortKeys(timeline), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

for (const stem of STEMS) {
  test(`${stem} compiles to its published timeline`, () => {
    const compiled = compileTimeline(read(stem, 'bundle'));
    // Deep equality first, because it names the event that moved; byte
    // equality second, because that is the promise the artifact actually makes.
    assert.deepEqual(compiled, read(stem, 'timeline'));
    assert.equal(serialize(compiled), slurp(stem, 'timeline'));
  });
}

test('compiling twice writes the same bytes', () => {
  const bundle = read('the_owls_quiet_friend', 'bundle');
  assert.equal(serialize(compileTimeline(bundle)), serialize(compileTimeline(bundle)));
});

// Twice-the-same-bytes is also what an idempotent normalisation IN PLACE would
// give — a default written into the caller's own bundle on the way past. The
// engine hands this function the bundle it then writes to `story.json`, and the
// browser hands it the object the host fetched: a compiler that edits either
// breaks a law two repositories away, in a file nobody was looking at.
test('compiling a story does not touch the story it was handed', () => {
  const bundle = deepFreeze(read('golden_push_dusk', 'bundle'));
  const before = JSON.stringify(bundle);

  const timeline = compileTimeline(bundle);

  assert.ok(timeline.events.length > 0, 'the frozen bundle compiled to nothing');
  assert.equal(JSON.stringify(bundle), before);
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

// A published op nothing exercises is an op no client can trust: the phone
// reads this table to know what it must draw, and a name in it that no fixture
// ever produced is a promise this repo has never once kept.
test('every published op is exercised by the corpus', () => {
  const seen = new Set();
  for (const stem of STEMS) {
    for (const event of compileTimeline(read(stem, 'bundle')).events) {
      if (event.source === 'stage') seen.add(event.op);
    }
  }
  assert.deepEqual([...seen].sort(), [...TIMELINE_OPS].sort());
});

test('the op table is frozen and carries no duplicates', () => {
  assert.ok(Object.isFrozen(TIMELINE_OPS));
  assert.equal(new Set(TIMELINE_OPS).size, TIMELINE_OPS.length);
});

test('a bundle of another storylang version is refused, not timed', () => {
  assert.throws(() => compileTimeline({ storylang_version: 1, scenes: [] }), /storylang_version/);
});

test('a step kind this player never performs is refused rather than silently dropped', () => {
  const bundle = read('golden_heal_travel', 'bundle');
  bundle.scenes[0].steps.push({ kind: 'nap', line: 99 });
  assert.throws(() => compileTimeline(bundle), /nap/);
});
