import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NO_FLOOR_STAND_Y,
  STAND_FRACTION,
  SIDE_FRACTION,
  alongFloor,
  floorSpan,
  floorYAtX,
  isSide,
  resolvePoint,
  sideX,
  zoneDepthOrder,
  zoneNamed,
  zoneScale,
} from '../browser/v0/core/geometry.mjs';

// forest_clearing's real traced floor: it stops well short of both plate edges.
// Real plates are 100-vertex traces whose x-extremes sit at neither end of the
// list — forest_clearing's min is vertex 11 and its max is vertex 57 — so the
// narrow fixture puts its extremes in the middle for the same reason.
const NARROW_FLOOR = [[50, 81.1], [84.7, 90], [12.1, 95], [40, 98], [70, 98]];
const FULL_FLOOR = [[0, 90], [100, 90], [100, 100], [0, 100]];

const round1 = (value) => Math.round(value * 10) / 10;

test('spreads the story zones across the floor, not the plate', () => {
  assert.deepEqual(SIDE_FRACTION, {
    left_edge: 0.1,
    left_third: 0.3,
    center: 0.5,
    right_third: 0.7,
    right_edge: 0.9,
  });

  const span = floorSpan(NARROW_FLOOR);
  assert.deepEqual(span, { min: 12.1, max: 84.7 });

  for (const zone of Object.keys(SIDE_FRACTION)) {
    const x = sideX(zone, span);
    assert.ok(x >= span.min && x <= span.max, `${zone} lands at ${x}, off the floor`);
  }

  assert.equal(round1(sideX('left_edge', span)), 19.4);
  assert.equal(round1(sideX('center', span)), 48.4);
  assert.equal(round1(sideX('right_edge', span)), 77.4);
});

test('leaves a full-width floor on the original zone percentages', () => {
  const span = floorSpan(FULL_FLOOR);

  assert.deepEqual(
    Object.keys(SIDE_FRACTION).map((zone) => sideX(zone, span)),
    [10, 30, 50, 70, 90],
  );
});

test('falls back to the whole plate when there is no floor to spread across', () => {
  assert.equal(floorSpan(null), null);
  assert.equal(floorSpan([[0, 0], [10, 10]]), null); // fewer than 3 points is not a polygon
  assert.equal(floorSpan([[40, 10], [40, 50], [40, 90]]), null); // zero width: would stack the cast on one x
  assert.equal(floorSpan([[NaN, 10], [50, 50], [90, 90]]), null);
  assert.equal(floorSpan([1, 2, 3]), null); // scalars, not vertices — must not throw

  // y is gated as well as x. Math.min used to absorb a stray Infinity; Math.max
  // propagates it, and `?? 86` cannot catch it because Infinity is not null — the
  // actor would be positioned at `top: Infinitypx`. null and "80" are the cases
  // that survive JSON.parse, and they corrupt the arithmetic just as quietly.
  const bad = (y) => [[0, 80], [100, y], [100, 100], [0, 100]];
  for (const y of [Infinity, -Infinity, null, '80', undefined]) {
    assert.equal(floorSpan(bad(y)), null, `y=${String(y)} must not count as a floor`);
    assert.equal(floorYAtX(bad(y), 50), null, `y=${String(y)} must not yield a stand line`);
  }

  // The x argument needs the same guard as the polygon. `sideX` answers undefined
  // for any name outside the five zones, and a NaN sampleX makes every edge test
  // false, so every edge pushes a NaN crossing — `?? 86` cannot catch that either.
  const floor = [[10, 80], [90, 80], [90, 100], [10, 100]];
  assert.equal(floorYAtX(floor, NaN), null);
  assert.equal(floorYAtX(floor, undefined), null);

  // ±Infinity is only out of range, and the clamp is what out-of-range x is for.
  assert.equal(floorYAtX(floor, Infinity), 90);
  assert.equal(floorYAtX(floor, -Infinity), 90);

  // Every null above is what stage-renderer's `?? NO_FLOOR_STAND_Y` answers for.
  // The value is policy, stated in player/README.md, so it is pinned by name
  // here; the `??` wiring itself lives in the DOM layer and has no harness.
  assert.equal(NO_FLOOR_STAND_Y, 86);

  // floorYAtX gates on the same shape check, so the pair cannot disagree about
  // what counts as a polygon — one returning null while its sibling throws.
  assert.equal(floorYAtX([1, 2, 3], 50), null);
  assert.equal(floorYAtX([[40, 10], [40, 50], [40, 90]], 40), null);
  assert.equal(floorYAtX(null, 50), null);

  assert.equal(sideX('center'), 50);
  assert.equal(sideX('left_edge', null), 10);
  assert.equal(sideX('nowhere', floorSpan(NARROW_FLOOR)), undefined);
});

test('maps a fraction along the floor, and along the plate without one', () => {
  assert.equal(alongFloor(0.25, { min: 20, max: 60 }), 30);
  assert.equal(alongFloor(0.25, null), 25);
  assert.equal(alongFloor(0, { min: 20, max: 60 }), 20);
  assert.equal(alongFloor(1, { min: 20, max: 60 }), 60);
});

test('knows a zone name from a character name', () => {
  assert.equal(isSide('center'), true);
  assert.equal(isSide('right_edge'), true);
  assert.equal(isSide('ruby'), false);
  assert.equal(isSide('constructor'), false); // not a zone just because Object has one
  assert.equal(isSide(70), false);
});

// Shaped like a real traced plate: an undulating back rim and a front rim flat
// on the bottom of frame, where 97 of the catalog's 115 pairs sit. The retired
// `concaveFloor` fixture was a raised pedestal — no shipped plate has that shape
// (the lowest real front rim is 88.84) and the stand line reads as wrong on it,
// so it could not serve as proof of this rule.
const BAND_FLOOR = [[10, 70], [50, 60], [90, 80], [90, 100], [10, 100]];

test('stands mid-band, not on the back rim of the ground', () => {
  // back rim 65 / 60 / 70 at these x, front rim 100 throughout.
  assert.equal(floorYAtX(BAND_FLOOR, 30), 82.5);
  assert.equal(floorYAtX(BAND_FLOOR, 50), 80);
  assert.equal(floorYAtX(BAND_FLOOR, 70), 85);

  // Stated once against the policy by name, so the constant cannot drift from
  // the rule without this failing.
  assert.equal(STAND_FRACTION, 0.5);
  assert.equal(floorYAtX(BAND_FLOOR, 50), 60 + (STAND_FRACTION * (100 - 60)));
});

test('reads the band as the outermost crossing pair, never a pairwise walk', () => {
  // A shelf over a band, mirroring forest_tree_home_interior — the catalog's one
  // genuine multi-crossing. At x=50 the crossings are 60, 70, 76, 100.
  const shelfOverBand = [
    [10, 76], [65, 76], [65, 70], [45, 70], [45, 60],
    [75, 60], [75, 76], [90, 76], [90, 100], [10, 100],
  ];

  // Outermost pair (60, 100) -> 80, on the ground. A pairwise scheme would take
  // (60, 70) -> 65 and float the character above the shelf.
  assert.equal(floorYAtX(shelfOverBand, 50), 80);
  assert.notEqual(floorYAtX(shelfOverBand, 50), 65);

  // Away from the shelf it is an ordinary two-crossing band.
  assert.equal(floorYAtX(shelfOverBand, 20), 88);
});

test('resolves a zone onto the floor instead of clamping to its edge', () => {
  const floor = [[30, 70], [70, 70], [70, 90], [30, 90]];

  // left_edge used to resolve to x=10 — off this floor — and only the floor
  // SAMPLE was clamped back to 30, so the character stood on nothing.
  assert.deepEqual(resolvePoint('left_edge', null, floor), { x: 34, y: 80 });
  assert.deepEqual(resolvePoint('right_edge', null, floor), { x: 66, y: 80 });

  // One rule everywhere: resolvePoint is also the push origin, so framing lands
  // mid-band too rather than drifting to the back rim on its own schedule.
  assert.deepEqual(resolvePoint(50, null, BAND_FLOOR), { x: 50, y: 80 });

  // The sampling clamp is still live code — the anchorless travel exit samples
  // the floor at plate x 0 and 100, which are off this floor on both sides.
  // (Only some catalog floors are inset enough to clamp: 7 of 23 on the left
  // probe, 15 of 23 on the right, and 8 span the full plate and never clamp.)
  assert.equal(floorYAtX(floor, 0), 80);
  assert.equal(floorYAtX(floor, 100), 80);
});

test('resolves a character target through the board position', () => {
  const board = { positionOf: (slug) => slug === 'ruby' ? { x: 70 } : null };
  const floor = [[10, 80], [90, 80], [90, 90], [10, 90]];

  assert.deepEqual(resolvePoint('ruby', board, floor), { x: 70, y: 85 });
});

test('a side divides the named zone, not the frame', () => {
  // forest_fern_tunnel's back road spans 34.5..63.1 — 28.6% of the picture.
  // `left_edge` there must land inside that road, not at the frame edge.
  const back = { name: 'background_road', depth: 3, scale: 0.3,
    polygon: [[34.49, 70], [63.06, 70], [63.06, 74], [34.49, 74]] };
  const front = { name: 'foreground_road', depth: 1, scale: 1,
    polygon: [[0.34, 90], [99.73, 90], [99.73, 99], [0.34, 99]] };
  const plate = { zones: [front, back], default_zone: 'foreground_road' };

  assert.equal(zoneNamed(plate, 'background_road'), back);
  assert.equal(zoneNamed(plate, null), front, 'no name means the default zone');
  assert.equal(zoneNamed(plate, 'nowhere'), null);

  const nearX = round1(sideX('left_edge', floorSpan(front.polygon)));
  const farX = round1(sideX('left_edge', floorSpan(back.polygon)));
  assert.equal(nearX, 10.3);
  assert.equal(farX, 37.3, 'left_edge of a narrow back band is mid-picture');
});

test('an un-banded zone draws at full size and paints farthest', () => {
  // 19 of 23 plates are still un-banded: a character on one must look exactly
  // as it did before zones existed
  assert.equal(zoneScale({ scale: 0.3 }), 0.3);
  assert.equal(zoneScale({ scale: null }), 1);
  assert.equal(zoneScale(undefined), 1);
  assert.equal(zoneDepthOrder({ depth: 2 }), 2);
  assert.ok(zoneDepthOrder({ depth: null }) > zoneDepthOrder({ depth: 9 }));
});
