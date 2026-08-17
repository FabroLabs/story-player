import { spreadAlongBand } from '../crowding.mjs';
import { floorSpan, zoneDepthOrder, zoneNamed } from '../geometry.mjs';

/**
 * The arrangement the timeline does not carry.
 *
 * A published timeline records the x the STORY asked for. Two characters told
 * to walk to the same point are recorded on the same x — six of the seven
 * scenes in `ruby_and_the_gentle_dark` end that way, four of them on one x —
 * and a client that draws them there draws one sprite where there are four.
 * The spread is the renderer's job by design (the footprint comes from
 * presentation policy, which nothing upstream can compute), so it is this
 * layer's job now, at exactly the instants the DOM stage ran it: every
 * placement, and every walk that reached its end.
 *
 * Paint order is the other thing a flat event stream cannot state: farthest
 * band first, and inside one band the order people arrived.
 */

const DEFAULT_STAGE_WIDTH = 1920;

/**
 * Push the occupants of one band apart. Returns the x each one should be drawn
 * at — only for those that moved — and how much room the band was short.
 */
export function spreadBand(actors, zoneName, plate) {
  const zone = zoneNamed(plate, zoneName);
  const empty = { moved: new Map(), overflow: 0, zone: zone?.name ?? null };
  if (!zone) return empty;

  const band = actors.filter((actor) => (actor.band ?? null) === (zoneName ?? null));
  if (band.length < 2) return empty;

  const stageWidth = stageWidthOf(plate);
  const occupants = band.map((actor) => ({
    slug: actor.slug,
    x: actor.x,
    // Sprites are drawn in a square cell, so a sprite is as wide as it is tall.
    widthPct: (actor.heightPx / stageWidth) * 100,
    kind: actor.kind,
  }));

  const { x, overflow } = spreadAlongBand(occupants, floorSpan(zone.polygon));
  const moved = new Map();
  for (const actor of band) {
    const to = x[actor.slug];
    if (typeof to === 'number' && to !== actor.x) moved.set(actor.slug, to);
  }
  return { moved, overflow, zone: zone.name, occupants: occupants.length };
}

/**
 * Number every actor back to front: highest band depth first, so depth 1 lands
 * on top, and creation order breaks a tie inside one band. `actors` arrives in
 * creation order, which is the tie-break itself.
 */
export function paintOrder(actors, plate) {
  const ranked = actors.map((actor, seq) => ({
    actor,
    depth: zoneDepthOrder(zoneNamed(plate, actor.band)),
    seq,
  }));
  ranked.sort((left, right) => (right.depth - left.depth) || (left.seq - right.seq));
  ranked.forEach(({ actor }, order) => {
    actor.order = order + 1;
  });
}

export function stageWidthOf(plate) {
  const width = plate?.resolution?.[0];
  return Number.isFinite(width) && width > 0 ? width : DEFAULT_STAGE_WIDTH;
}
