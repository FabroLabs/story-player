// The five SIDES are fractions of the zone you named, not of the plate and not
// of the whole floor. Traced ground stops short of the image edges
// (forest_behind_tree's spans 11.6..85.1%) and a band stops far shorter still —
// forest_fern_tunnel's back road spans 34.5..63.1%, 28.6% of the frame — so a
// side measured off plate width lands on scenery nobody can stand on, and one
// measured off the whole floor lands outside the band the story named.
export const SIDE_FRACTION = Object.freeze({
  left_edge: 0.1,
  left_third: 0.3,
  center: 0.5,
  right_third: 0.7,
  right_edge: 0.9,
});

// The ground in a plate is a band, not a line: a back rim where it meets the
// scenery and a front rim, which is the bottom of frame on 97 of the catalog's
// 115 place x zone pairs. floorYAtX used to answer with the back rim, pinning
// every character to the far edge and leaving the whole band below them — a
// median 274 px of 1080 — unreachable. This is how far into the band they stand.
export const STAND_FRACTION = 0.5;

// Where the cast stands when a plate has no usable floor at all. 86 is the
// median stand line across the catalog's 23 floors (85.92), so a floorless plate
// puts them where a typical plate does. The old value was 82: never documented,
// so why it was chosen is not recoverable, but measured it sat at the 96th
// percentile of the 23 back rims — one sample per floor, at its center zone —
// and only the 17th of the mid-band values it would now have to sit among.
export const NO_FLOOR_STAND_Y = 86;

const WHOLE_PLATE = Object.freeze({ min: 0, max: 100 });

// null means "no usable floor" and every caller then spreads across the whole
// plate. A zero-width or non-finite span earns that answer too: the plate is a
// poor stage, but stacking the entire cast on one x is a worse one.
export function floorSpan(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;

  const xs = polygon.map((vertex) => (Array.isArray(vertex) ? vertex[0] : NaN));
  if (!xs.every(Number.isFinite)) return null;

  // y is gated too even though only x defines the span. The old stand line took
  // Math.min of the crossings, which quietly absorbed a stray Infinity; the
  // outermost pair takes Math.max, which propagates it, and the `??` fallback in
  // stage-renderer cannot catch
  // it because it is not null — the actor would get `top: Infinitypx` and vanish.
  // Number.isFinite also rejects the JSON-reachable cases, null and "80".
  const ys = polygon.map((vertex) => (Array.isArray(vertex) ? vertex[1] : NaN));
  if (!ys.every(Number.isFinite)) return null;

  const min = Math.min(...xs);
  const max = Math.max(...xs);
  return max > min ? { min, max } : null;
}

export function alongFloor(fraction, span) {
  const { min, max } = span ?? WHOLE_PLATE;
  return min + (fraction * (max - min));
}

export function isSide(name) {
  return typeof SIDE_FRACTION[name] === 'number';
}

export function sideX(side, span) {
  return isSide(side) ? alongFloor(SIDE_FRACTION[side], span) : undefined;
}

// A side is a fraction of the ZONE it was named with, not of the whole floor.
// forest_fern_tunnel's back road spans x 34.5..63.1 — 28.6% of the frame — so
// `left_edge` there is x~37, near the middle of the picture, which is where
// that road actually is. Measured off the plate it would land in the ferns.
export function zoneNamed(plate, name) {
  const zones = plate?.zones;
  if (!Array.isArray(zones) || zones.length === 0) return null;
  const wanted = name ?? plate?.default_zone;
  return zones.find((zone) => zone?.name === wanted) ?? null;
}

// The scale a character standing in this zone is drawn at. An un-banded zone
// answers 1: the plate has not been re-traced yet, and a character on it must
// look exactly as it did before zones existed. Never a guess for a MALFORMED
// scale — the compiler refuses those, so anything arriving here is authored.
export function zoneScale(zone) {
  const scale = zone?.scale;
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// Highest depth first, so depth 1 is painted last and lands on top (D4).
// Un-banded zones sort with the farthest, matching the order the bundle
// already emitted them in — one rule, stated twice, would be one too many.
export function zoneDepthOrder(zone) {
  const depth = zone?.depth;
  return Number.isInteger(depth) && depth >= 1 ? depth : Number.MAX_SAFE_INTEGER;
}

export function floorYAtX(polygon, xPct) {
  if (!floorSpan(polygon)) return null; // one shape gate for both, so they cannot disagree

  const xs = polygon.map(([x]) => x);
  const sampleX = Math.min(Math.max(xPct, Math.min(...xs)), Math.max(...xs));

  // The polygon is gated above; the argument needs the same guard. A NaN x makes
  // every edge test false, so every edge pushes a NaN crossing and the midpoint
  // is NaN — which that same `??` cannot catch either, and the actor lands at
  // `top: NaNpx`. `sideX` returns undefined for any name outside the five sides,
  // which is how one arrives here. ±Infinity is deliberately not rejected: it is
  // merely out of range, and the clamp above is what out-of-range x is for.
  if (Number.isNaN(sampleX)) return null;

  const intersections = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];

    if (x1 === x2) {
      if (sampleX === x1) intersections.push(y1, y2);
      continue;
    }

    if (sampleX < Math.min(x1, x2) || sampleX > Math.max(x1, x2)) continue;
    const ratio = (sampleX - x1) / (x2 - x1);
    intersections.push(y1 + ((y2 - y1) * ratio));
  }

  if (intersections.length === 0) return null;

  // The band is the OUTERMOST pair, never a pairwise walk of the sorted list.
  // The catalog's one genuine multi-crossing settles it: forest_tree_home_interior
  // at left_edge crosses at 67.42, 70.74, 74.21, 100 — outermost mid is 83.71, on
  // the ground; pairwise would answer 69.08, a sliver at the very back.
  //
  // The cost of outermost: across an interior void the pair spans the hole and the
  // midpoint lands in it. Swept over all 23 catalog floors that is unreachable —
  // nothing mid-air in the 0.1..0.9 range the zones and arrival slots address, nor
  // at the travel exit's floorY(0)/floorY(100); it needs a plate's extreme x, worst
  // forest_cabin_interior at x~84. A numeric-x put/move would reach it. The
  // five-zone gate in validator.py is the only reason this is safe.
  const back = Math.min(...intersections);
  const front = Math.max(...intersections);
  return back + (STAND_FRACTION * (front - back));
}

// Two polygons, because the two axes come from different places. A side word is
// measured across the plate's default band and always has been — that is the
// published rule for what `left_edge` means to a camera. But the height belongs
// to whoever is being aimed at: a character on a back road stands on the back
// road's line, several percent higher in frame and on a much shorter span. Read
// both off the default band and the camera frames a far character on the near
// band's floor, magnified — the miss that sent every push on a banded plate low.
// `bandPolygon` defaults to `floorPolygon`, so a caller with nothing to aim at
// (a side word, a bare number) reads exactly as it did before.
export function resolvePoint(target, board, floorPolygon, bandPolygon = floorPolygon) {
  const position = isSide(target)
    ? { x: sideX(target, floorSpan(floorPolygon)) }
    : typeof target === 'number'
      ? { x: target }
      : board?.positionOf?.(target);

  if (!position || typeof position.x !== 'number') return null;
  return { x: position.x, y: floorYAtX(bandPolygon, position.x) };
}
