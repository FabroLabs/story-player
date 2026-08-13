// Two things standing in one band must not be drawn on top of each other.
//
// Within a band everything is at one distance and sprites are square, so the
// whole problem is 1-D: each occupant owns an x-interval as wide as it is tall,
// and overlapping intervals have to be pushed apart along the band's span.
// That is the entire reason this is the player's job and never the validator's
// (D13) — the footprint comes from `spriteHeightForCm`, which is presentation
// policy, so nothing upstream can compute it and nothing upstream should try.

// An occupant that cannot be asked to move. A placed object is scenery the
// story put somewhere on purpose; a character can be nudged, a campfire cannot.
const IMMOVABLE = 'object';

function interval(occupant) {
  const half = occupant.widthPct / 2;
  return { min: occupant.x - half, max: occupant.x + half };
}

/**
 * Spread occupants of one band so their intervals stop overlapping.
 *
 * Returns `{ x: {slug: newX}, overflow }` — `overflow` being how much room the
 * band was short, in plate percent, or 0 when everyone fits. The caller reports
 * it; this function never decides what a failure means.
 *
 * The order along the band is the order the story ASKED for — sorted by the x
 * each occupant wanted, ties broken by placement order. Walking the list in
 * line order instead reversed them whenever the leftmost character's `put`
 * came second: owl at 50 and rabbit at 55 drew as rabbit 55, owl 75, with the
 * owl on the right. Nobody who wrote those two lines meant that.
 */
export function spreadAlongBand(occupants, span) {
  const result = { x: {}, overflow: 0 };
  if (!Array.isArray(occupants) || occupants.length === 0) return result;
  for (const occupant of occupants) result.x[occupant.slug] = occupant.x;
  if (occupants.length === 1 || !span || !Number.isFinite(span.min) || !Number.isFinite(span.max)) {
    return result;
  }

  const needed = occupants.reduce((total, occupant) => total + occupant.widthPct, 0);
  const room = span.max - span.min;
  // Reported, not resolved. A band too narrow for its occupants is a fact
  // about the plate and the cast; the player still draws everybody, as evenly
  // as it can, and says how short it was.
  if (needed > room) result.overflow = needed - room;

  // Anchors first: an immovable occupant keeps its x, and the characters flow
  // around it. When a layer will not fit, the give comes from the characters —
  // an object cannot be moved out of the way, so it is not asked to be.
  const placed = occupants
    .map((occupant, seq) => ({ ...occupant, ...interval(occupant), seq }))
    .sort((a, b) => (a.x - b.x) || (a.seq - b.seq));

  separate(placed);

  // Clamp back inside the band. The shift can only be applied to the movable
  // occupants — a prop cannot be asked to move — so it reopens exactly the
  // overlaps `separate` just closed around one. Separating again afterwards is
  // what makes "an anchor keeps its x and the characters flow around it" true
  // at the edges of a band and not only in the middle of one; without it a
  // character was drawn standing inside the campfire, silently, with most of
  // the band empty.
  const overshoot = Math.max(0, placed[placed.length - 1].max - span.max);
  const undershoot = Math.max(0, span.min - placed[0].min);
  const correction = undershoot - overshoot;
  if (correction !== 0) {
    for (const occupant of placed) {
      if (occupant.kind === IMMOVABLE) continue;
      occupant.min += correction;
      occupant.max += correction;
      occupant.x += correction;
    }
    placed.sort((a, b) => (a.x - b.x) || (a.seq - b.seq));
    separate(placed);
  }

  // What survives two passes is a band that cannot hold its occupants AROUND
  // ITS ANCHORS, which `needed > room` alone never sees: the room may exist
  // and simply be on the far side of a prop. Separation only ever shifts one
  // way past an anchor, so the occupant can end up hanging over the band's
  // edge — the correct answer (put them on the prop's other side) needs a
  // packing pass this function deliberately does not do. Reported, not
  // resolved, exactly as the too-narrow case above is: never overlapping,
  // sometimes over the edge, and always said out loud.
  result.overflow = Math.max(result.overflow, residualOverlap(placed), outsideBand(placed, span));
  for (const occupant of placed) {
    if (occupant.kind === IMMOVABLE) continue;
    result.x[occupant.slug] = occupant.x;
  }
  return result;
}

// one left-to-right pass: a shove that meets an immovable occupant walks back
// leftwards through the movable ones behind it rather than piling into it
function separate(placed) {
  for (let index = 1; index < placed.length; index += 1) {
    const previous = placed[index - 1];
    const current = placed[index];
    if (current.min >= previous.max) continue;
    const shift = previous.max - current.min;
    if (current.kind === IMMOVABLE) {
      for (let back = index - 1; back >= 0; back -= 1) {
        if (placed[back].kind === IMMOVABLE) break;
        placed[back].min -= shift;
        placed[back].max -= shift;
        placed[back].x -= shift;
      }
      continue;
    }
    current.min += shift;
    current.max += shift;
    current.x += shift;
  }
}

function residualOverlap(placed) {
  let worst = 0;
  for (let index = 1; index < placed.length; index += 1) {
    worst = Math.max(worst, placed[index - 1].max - placed[index].min);
  }
  return worst;
}

function outsideBand(placed, span) {
  let worst = 0;
  for (const occupant of placed) {
    worst = Math.max(worst, span.min - occupant.min, occupant.max - span.max);
  }
  return worst;
}
