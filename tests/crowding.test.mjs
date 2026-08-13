import assert from 'node:assert/strict';
import test from 'node:test';

import { spreadAlongBand } from '../browser/v0/core/crowding.mjs';

const BAND = { min: 0, max: 100 };
const who = (slug, x, widthPct, kind = 'character') => ({ slug, x, widthPct, kind });

test('occupants that do not overlap are left exactly where the story put them', () => {
  const result = spreadAlongBand([who('a', 20, 10), who('b', 80, 10)], BAND);
  assert.deepEqual(result.x, { a: 20, b: 80 });
  assert.equal(result.overflow, 0);
});

test('one occupant is never moved, whatever the band', () => {
  assert.deepEqual(spreadAlongBand([who('a', 50, 90)], BAND).x, { a: 50 });
});

test('two characters on one spot are pushed apart, not stacked', () => {
  // both put at centre, 20 wide: they must end up exactly touching
  const result = spreadAlongBand([who('a', 50, 20), who('b', 50, 20)], BAND);
  assert.equal(result.x.b - result.x.a, 20, 'gap equals one full width — edges touch');
  assert.equal(result.overflow, 0);
});

test('the order along the band is the one the story asked for, not line order', () => {
  // the owl was asked for at 50 and the rabbit at 55, but the rabbit's put
  // line comes first. Walking in line order drew the owl at 75 — on the RIGHT
  // of the character the story put to its right.
  const result = spreadAlongBand([who('rabbit', 55, 20), who('owl', 50, 20)], BAND);
  assert.ok(result.x.owl < result.x.rabbit, `owl stayed left: ${JSON.stringify(result.x)}`);
  assert.equal(result.x.rabbit - result.x.owl, 20, 'and they end up touching');
});

test('occupants asking for the identical x fall back to line order', () => {
  // nothing in the story distinguishes them, so the only stable answer left is
  // the order the lines were written in
  const result = spreadAlongBand([who('first', 50, 20), who('second', 50, 20)], BAND);
  assert.ok(result.x.first < result.x.second);
});

test('an object is an anchor: the characters give way, never the prop', () => {
  // D13, otabek's ruling: a placed object cannot be moved out of the way, so
  // when a layer will not fit the give has to come from the characters
  const result = spreadAlongBand(
    [who('campfire', 50, 20, 'object'), who('rabbit', 55, 20)],
    BAND,
  );
  assert.equal(result.x.campfire, 50, 'the prop stayed exactly where it was put');
  assert.equal(result.x.rabbit, 70, 'moved a full width clear — edges touch at 60');
});

test('a character before an immovable prop is pushed back the other way', () => {
  const result = spreadAlongBand(
    [who('rabbit', 45, 20), who('campfire', 50, 20, 'object')],
    BAND,
  );
  assert.equal(result.x.campfire, 50);
  assert.equal(result.x.rabbit, 30, 'shoved left a full width, because the prop will not budge');
});

test('a band too narrow to hold everyone says how short it was', () => {
  // forest_fern_tunnel's back road spans 28.6% of the frame; three characters
  // needing 15% each do not fit, and the player must say so rather than
  // silently overlapping them
  const narrow = { min: 34.5, max: 63.1 };
  const result = spreadAlongBand(
    [who('a', 40, 15), who('b', 45, 15), who('c', 50, 15)],
    narrow,
  );
  assert.ok(result.overflow > 0, 'reports the shortfall');
  assert.equal(Math.round(result.overflow * 10) / 10, 16.4); // 45 needed, 28.6 available
  // everybody is still drawn — a crowded picture beats a missing character
  assert.equal(Object.keys(result.x).length, 3);
});

test('a spread that would run off the end comes back inside the band', () => {
  const result = spreadAlongBand([who('a', 90, 20), who('b', 90, 20)], BAND);
  assert.ok(result.x.a >= 0 && result.x.b <= 100, `stayed inside: ${JSON.stringify(result.x)}`);
  assert.equal(result.x.b - result.x.a, 20);
});

test('a missing or nonsense band leaves everyone untouched rather than guessing', () => {
  const occupants = [who('a', 50, 20), who('b', 50, 20)];
  assert.deepEqual(spreadAlongBand(occupants, null).x, { a: 50, b: 50 });
  assert.deepEqual(spreadAlongBand(occupants, { min: NaN, max: 1 }).x, { a: 50, b: 50 });
  assert.deepEqual(spreadAlongBand([], BAND).x, {});
});

test('a character shoved against the band edge still clears an immovable prop', () => {
  // The clamp used to shift every MOVABLE occupant by one uniform correction
  // and leave the prop behind — reopening exactly the gap the separation pass
  // had just made around it. A character was drawn standing inside the
  // campfire, silently, with most of the band empty, and `overflow` reported 0
  // because it measured total width against band room rather than residual
  // overlap.
  const out = spreadAlongBand([
    { slug: 'apple', x: 90, widthPct: 4.16, kind: 'object' },
    { slug: 'rabbit', x: 90, widthPct: 10.4, kind: 'character' },
  ], { min: 0, max: 100 });

  const apple = { min: 90 - 4.16 / 2, max: 90 + 4.16 / 2 };
  const rabbit = { min: out.x.rabbit - 10.4 / 2, max: out.x.rabbit + 10.4 / 2 };

  assert.equal(out.x.apple, 90, 'the prop is an anchor and does not move');
  assert.ok(
    rabbit.min >= apple.max - 1e-9 || rabbit.max <= apple.min + 1e-9,
    `the character overlaps the prop: ${JSON.stringify({ apple, rabbit })}`,
  );
  assert.ok(
    out.overflow > 0,
    'a band that cannot hold its occupants around its anchor must say so',
  );
});

test('a band with room around its anchor needs no overflow', () => {
  const out = spreadAlongBand([
    { slug: 'apple', x: 50, widthPct: 4, kind: 'object' },
    { slug: 'rabbit', x: 50, widthPct: 10, kind: 'character' },
  ], { min: 0, max: 100 });

  assert.equal(out.x.apple, 50);
  assert.equal(out.overflow, 0, 'there was room; nothing to report');
});
