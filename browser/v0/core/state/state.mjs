import { frameCell, frameIndexAt } from '../clips.mjs';
import { NO_FLOOR_STAND_Y, floorYAtX, zoneDepthOrder, zoneNamed } from '../geometry.mjs';
// `core` reaching into `app` for presentation policy is the layering the phase-3
// compiler already inherited; phase 7 deletes the DOM stage and is the cheap
// moment to move the module. The policy itself is pure.
import { drawnSpriteHeightPx } from '../../app/stage/presentation-policy.mjs';
import { carriedFrom, normaliseSlate } from '../slate.mjs';
import { BandBook } from './bands.mjs';
import { WIDE_FRAMING, framingBetween, framingForOp } from './camera.mjs';
import { paintOrder, spreadBand } from './layout.mjs';
import { beginMotion, motionAt, redirectMotion } from './motion.mjs';

/**
 * The picture at t, from the timeline and the bundle, and from nothing else.
 *
 * A live player knew where everybody was because it had watched them get there.
 * This one is asked cold: give me 4,700 ms. So the answer is a fold — every
 * event up to t applied in order, then the one walk and the one camera move
 * still in flight evaluated at t. No history, no `performance.now()`, no DOM:
 * the same t always answers the same, which is what makes seeking, pausing and
 * a canvas that redraws only on change possible at all.
 *
 * What it does NOT do is decide anything the compiler already decided. Every x,
 * every clip key, every camera framing and every duration is read off the
 * timeline. The two things it must work out for itself are the two the
 * published stream deliberately leaves out — which band somebody stands in
 * (`bands.mjs`) and how a band's occupants are spread so they are not drawn on
 * top of each other (`layout.mjs`).
 *
 * `warnings` is how it stays honest. The DOM stage this replaces said out loud
 * when a clip was missing, a framing unusable or a band too narrow for its
 * cast; a pure function has nowhere to say it, so it hands the sentences back
 * with the picture, each stamped with the instant it happened. A runtime takes
 * the ones inside the slice of time it just crossed, exactly as it takes cues.
 */
export function stateAt(timeline, bundle, tMs) {
  requireMatchingPair(timeline, bundle);
  const t = storyTimeMs(tMs);
  const world = new World(bundle);
  for (const event of timeline.events ?? []) {
    if (event.t_ms > t) break;
    world.apply(event);
  }
  return world.pictureAt(t);
}

/**
 * The instant a caller asked for, as story time.
 *
 * Shared with `cursor.mjs` so the warm read and the cold one refuse and clamp
 * the same t: a runtime that swapped one for the other and quietly started
 * answering 0 for `undefined` would be the worst kind of change.
 */
export function storyTimeMs(tMs) {
  if (!Number.isFinite(tMs)) {
    // Answering 0 would look exactly like a legitimate `stateAt(…, 0)` — the
    // story back at its opening frame — which reads to a viewer as a restart.
    throw new Error(`t must be a finite number of milliseconds, got ${JSON.stringify(tMs)}`);
  }
  return Math.max(0, tMs);
}

/**
 * A timeline and the bundle it was compiled from, or neither is worth reading.
 *
 * `timeline_version` exists so a client can refuse one it does not understand
 * instead of misreading it, and this is its first reader. The scene check
 * catches the subtler pairing: a cached timeline against a rebuilt bundle with
 * one scene inserted gives every later scene the wrong plate, and since band
 * names belong to the plate they were traced on, the whole cast then draws at
 * scale 1 on the no-floor line with no depth and no crowding — a completely
 * plausible-looking picture that is wrong from top to bottom.
 */
export function requireMatchingPair(timeline, bundle) {
  if (timeline?.timeline_version !== 1) {
    throw new Error(
      `timeline_version is ${JSON.stringify(timeline?.timeline_version)}, not 1 — this player `
      + 'reads version 1 timelines, so it would misread this one rather than play it',
    );
  }
  if (timeline.storylang_version !== bundle?.storylang_version) {
    throw new Error(
      `the timeline is storylang ${JSON.stringify(timeline.storylang_version)} and the bundle is `
      + `${JSON.stringify(bundle?.storylang_version)} — these two were not built from each other`,
    );
  }
  for (const event of timeline.events ?? []) {
    if (event.source !== 'stage' || event.op !== 'scene') continue;
    const scene = bundle.scenes?.[event.scene_index];
    if (scene?.place !== event.place) {
      throw new Error(
        `scene ${event.scene_index} is ${JSON.stringify(event.place)} in the timeline and `
        + `${JSON.stringify(scene?.place ?? null)} in the bundle — this timeline was compiled from a different story`,
      );
    }
  }
}

// No board: what a story with no lesson in it shows, and what a cut and the
// ending go back to. `from` is 0 because nothing was standing.
const EMPTY_SLATE = Object.freeze({ count: 0, mode: 'count', groups: Object.freeze([]), sinceMs: 0, from: 0 });

// Two boards are the same board when they claim the same arithmetic — not when
// they merely land on the same number. Five counted and two-and-three are the
// same total and different pictures, so the second one is raised.
function sameBoard(board, shown) {
  return board.count === shown.count
    && board.mode === shown.mode
    && board.groups.length === shown.groups.length
    && board.groups.every((size, index) => size === shown.groups[index]);
}

/**
 * The fold itself: every event applied in order, and the picture read off it.
 *
 * Exported for `cursor.mjs` and for nothing else — it is the same object
 * `stateAt` builds and throws away on every call, and a caller that keeps one
 * is taking responsibility for winding it forward in event order. The public
 * surface (`tooling/v0.mjs`, the window global) publishes `stateAt` only.
 */
export class World {
  #bundle;
  #bands = new BandBook();
  #actors = new Map();
  #sceneIndex = null;
  #place = null;
  #plate = null;
  #subtitle = '';
  // The counting board, and the instant it was raised — every counter's pop,
  // every cross and every token of the equation is a function of that instant
  // and t, so the same t always draws the same board. `from` is how much of it
  // was already standing when it was raised (see `#showSlate`).
  #slate = EMPTY_SLATE;
  #ended = false;
  #warnings = [];
  #camera = { from: WIDE_FRAMING, held: WIDE_FRAMING, startMs: 0, durationMs: 0 };

  constructor(bundle) {
    this.#bundle = bundle;
  }

  apply(event) {
    if (event.source === 'step') {
      this.#bands.observeStep(event);
      return;
    }
    switch (event.op) {
      case 'scene': this.#scene(event); break;
      case 'place': this.#place_(event); break;
      case 'place_object': this.#object(event); break;
      case 'clip': this.#clip(event); break;
      case 'move': this.#move(event); break;
      case 'settle': this.#settle(event); break;
      case 'depart': this.#depart(event); break;
      case 'exit': this.#leave(event.slug); break;
      case 'remove_object': this.#removeObject(event); break;
      case 'slate': this.#showSlate(event); break;
      case 'highlight': this.#highlight(event); break;
      case 'subtitle': this.#subtitle = event.text ?? ''; break;
      case 'end': this.#end(event); break;
      case 'push_in': case 'pull_out': case 'shot': case 'pan': case 'camera_reset':
        this.#camera_(event); break;
      // An op this player has no meaning for is not a shrug: it is content the
      // picture is missing while every other client draws it.
      default: this.#warn(event, { type: 'policy', policy: 'unknown-op', op: event.op ?? null });
    }
  }

  pictureAt(tMs) {
    const actors = [...this.#actors.values()]
      .sort((left, right) => left.order - right.order)
      .map((actor) => this.#drawableAt(actor, tMs));
    return {
      tMs,
      sceneIndex: this.#sceneIndex,
      place: this.#place,
      plate: this.#plate,
      actors,
      camera: this.#framingAt(tMs),
      slate: { ...this.#slate, groups: [...this.#slate.groups] },
      subtitle: this.#subtitle,
      ended: this.#ended,
      warnings: this.#warnings,
    };
  }

  // A cut is not a background swap: the stage empties, every motion still
  // running is cancelled, the camera goes home and the subtitle clears.
  //
  // The board is the one thing a cut leaves alone. A lesson is one uninterrupted
  // surface — watched on the mounted player, a board that closed and reopened at
  // every seam was the fault, not the feature — so it goes up at the story's
  // first `slate` and is never taken down. Nothing here resets `from` either:
  // it is how the board ON SCREEN is drawn, not what the next one counts from,
  // and clearing it would take counters off a board still building through this
  // cut. A board raised after the cut asks `carriedFrom` the same question it
  // asks inside a scene: three counters that never left are not re-popped.
  #scene(event) {
    this.#sceneIndex = event.scene_index ?? null;
    const scene = this.#bundle?.scenes?.[this.#sceneIndex] ?? null;
    this.#place = event.place ?? scene?.place ?? null;
    this.#plate = scene?.plate ?? null;
    this.#actors.clear();
    this.#bands.openScene(this.#plate);
    this.#subtitle = '';
    this.#ended = false;
    this.#camera = { from: WIDE_FRAMING, held: WIDE_FRAMING, startMs: event.t_ms, durationMs: 0 };
  }

  #place_(event) {
    if (!this.#usableX(event)) return;
    const band = this.#bands.place(event.slug);
    const actor = this.#actor(event.slug, 'character');
    actor.band = band;
    actor.motion = null;
    actor.opacity = 1;
    actor.heightPx = this.#heightOf(event.slug, 'character', band);
    actor.x = event.x;
    actor.feetY = this.#floorY(event.x, band);
    this.#applyClip(actor, event.clip, event);
    this.#reorder();
    this.#relieveCrowding(band, event);
  }

  // A prop is placed once and never animated: no clip, no walk, no settle. It
  // still takes room on its band, and it is the one occupant crowding may not
  // push — the story put it there.
  #object(event) {
    if (!this.#usableX(event)) return;
    const band = this.#bands.object(event.slug, event.zone);
    const actor = this.#actor(event.slug, 'object');
    actor.band = band;
    actor.opacity = 1;
    actor.heightPx = this.#heightOf(event.slug, 'object', band);
    actor.x = event.x;
    actor.feetY = this.#floorY(event.x, band);
    this.#reorder();
    this.#relieveCrowding(band, event);
  }

  // A new clip drops the walk's settle but not the walk: the character keeps
  // going, wearing the emotion the story just asked for.
  #clip(event) {
    const actor = this.#actors.get(event.slug);
    if (actor) this.#applyClip(actor, event.clip, event);
  }

  #move(event) {
    const actor = this.#actors.get(event.slug);
    if (!actor) return;
    if (!this.#usableX(event)) return;
    const band = this.#bands.move(event.slug);
    const from = this.#geometryOf(actor, event.t_ms);
    // Paint order cannot tween, so it switches at whichever end of the walk
    // keeps the character right for longer: on departure when they are coming
    // toward the camera, on arrival when they are going away. The unavoidable
    // pop then happens where the sprite is smallest and farthest.
    actor.approaching = zoneDepthOrder(this.#zone(band)) < zoneDepthOrder(this.#zone(actor.band));
    actor.band = band;
    // The model position is the DESTINATION from the instant the walk starts —
    // that is what the DOM stage wrote, and it is what crowding reasons about
    // when somebody else is placed mid-walk. What the eye sees is the motion.
    actor.x = event.x;
    actor.feetY = this.#floorY(event.x, band);
    actor.heightPx = this.#heightOf(event.slug, actor.kind, band);
    actor.motion = beginMotion(event.t_ms, event.duration_ms, from, {
      x: actor.x, feetY: actor.feetY, heightPx: actor.heightPx,
    });
    this.#applyClip(actor, event.clip, event);
    if (actor.approaching) this.#reorder();
  }

  #settle(event) {
    const actor = this.#actors.get(event.slug);
    if (!actor) return;
    actor.motion = null;
    this.#applyClip(actor, event.clip, event);
    if (!actor.approaching) this.#reorder();
    this.#relieveCrowding(actor.band, event);
  }

  // Walking off fades them out, and the stand line is the one the op carries:
  // an exit anchor is a point on the plate, not a point on their band.
  #depart(event) {
    const actor = this.#actors.get(event.slug);
    if (!actor) return;
    if (!this.#usableX(event)) return;
    const from = this.#geometryOf(actor, event.t_ms);
    actor.x = event.x;
    actor.feetY = Number.isFinite(event.y) ? event.y : this.#floorY(event.x, null);
    actor.motion = beginMotion(event.t_ms, event.duration_ms, from, {
      x: actor.x, feetY: actor.feetY, heightPx: actor.heightPx,
    }, { fade: true });
    this.#applyClip(actor, event.clip, event);
  }

  // Unreachable from this repository's compiler, which refuses a take of a prop
  // this scene has not put down — but a timeline is read from wherever it came
  // from, and this op is the one that makes things DISAPPEAR. A slug that names
  // nobody takes nothing away and says so; one that names a character would
  // vanish them mid-scene with no walk and no fade, which is a departure the
  // story never wrote. Characters leave by `travel`.
  #removeObject(event) {
    const actor = this.#actors.get(event.slug);
    if (!actor) {
      this.#warn(event, { type: 'policy', policy: 'remove-missing', slug: event.slug ?? null });
      return;
    }
    if (actor.kind !== 'object') {
      this.#warn(event, { type: 'policy', policy: 'remove-not-a-prop', slug: event.slug ?? null });
      return;
    }
    this.#leave(event.slug);
  }

  // The two ways a figure leaves the stage between cuts are one fold: the
  // character who has finished walking off, and the prop somebody took. Both
  // stop being drawn, and the band each stood on is no longer theirs to crowd.
  #leave(slug) {
    this.#actors.delete(slug);
    this.#bands.forget(slug);
  }

  // A board whose arithmetic does not add up is refused rather than mended: it
  // is the answer a child is being shown, and a player that quietly drew what
  // it guessed was meant would disagree with the story's own numerals.
  //
  // It is refused HERE and not only at the compiler, because a timeline is read
  // from wherever it came from — and the drawer's answer to a board it cannot
  // draw is nothing at all, with nobody told. `normaliseSlate` is the same rule
  // the compiler applied, so a refusal here is never a second opinion.
  #showSlate(event) {
    const board = normaliseSlate(event);
    if (!board) {
      this.#warn(event, {
        type: 'policy',
        policy: 'slate-count-unusable',
        count: event.count ?? null,
        mode: event.mode ?? null,
        groups: event.groups ?? null,
      });
      return;
    }
    // Asking for the board already showing is not a new board. Re-stamping
    // `sinceMs` would replay the whole build on a board that has been sitting
    // there, which is what a story repeating a total between two chunks would
    // look like — the counters popping again on a number nobody changed.
    if (sameBoard(board, this.#slate)) return;
    // A plain count raised over a smaller plain count in the same scene is the
    // story counting ON: four is three and one more, and re-popping the three
    // that never left would be the board arriving twice. They are drawn settled
    // instead — though they do MOVE, because the row is centred on the count it
    // now holds, exactly as the board this one reproduces did. Anything else —
    // a new kind of arithmetic, a count that shrank — is a new board and builds
    // from nothing.
    this.#slate = { ...board, sinceMs: event.t_ms, from: carriedFrom(this.#slate, board) };
  }

  // Unreachable from this repository's compiler, which refuses a highlight of
  // somebody who is not on stage — but a timeline is read from wherever it came
  // from, and a ring around nobody is content the picture is missing.
  #highlight(event) {
    const actor = this.#actors.get(event.slug);
    if (!actor) {
      this.#warn(event, { type: 'policy', policy: 'highlight-missing', slug: event.slug ?? null });
      return;
    }
    actor.highlightMs = event.t_ms;
  }

  // The subtitle and the rings go; the board does not. A lesson is one surface
  // from its first count to the last frame, and the end card is drawn OVER it —
  // the child's final picture is the answer they reached, not the floor it was
  // counted on. Nothing in the language takes a board down: it is replaced by
  // another board or it is the picture the story finishes on.
  #end(event) {
    this.#subtitle = '';
    // One actor at a time because `end` leaves the cast standing, unlike
    // `scene`, which takes the rings with the actors it clears.
    for (const actor of this.#actors.values()) actor.highlightMs = null;
    this.#ended = true;
  }

  #camera_(event) {
    const next = framingForOp(event, this.#camera.held);
    // Refused rather than written, and said out loud: an unaimed ride used to
    // leave the camera silently wide for the rest of the scene.
    if (next.refusal) {
      this.#warn(event, next.refusal);
      return;
    }
    this.#camera = {
      // A transition interrupted mid-flight restarts from the picture, not
      // from where the interrupted one was going.
      from: this.#framingAt(event.t_ms),
      held: next.framing,
      startMs: event.t_ms,
      durationMs: next.durationMs,
    };
  }

  #actor(slug, kind) {
    const existing = this.#actors.get(slug);
    if (existing) return existing;
    const actor = {
      slug,
      kind,
      band: null,
      x: 0,
      feetY: NO_FLOOR_STAND_Y,
      heightPx: 0,
      opacity: 1,
      clip: null,
      clipStartedMs: 0,
      clipMissing: false,
      motion: null,
      highlightMs: null,
      approaching: false,
      order: this.#actors.size + 1,
    };
    this.#actors.set(slug, actor);
    return actor;
  }

  // A clip absent from the bundle keeps the one already showing — a character
  // frozen in their last pose reads as a story, a blank cell does not — and
  // names the one that was missing, which the flag alone cannot. The clock only
  // restarts when the clip really changed.
  #applyClip(actor, clipKey, event) {
    if (!clipKey) return;
    // Asking for the clip already showing clears the flag: whatever was missing
    // before, nothing is missing now. The DOM stage latched its `is-missing`
    // class here forever, which drew a permanent placeholder over a character
    // wearing exactly the clip the story asked for.
    if (actor.clip === clipKey) {
      actor.clipMissing = false;
      return;
    }
    if (!this.#clipDefinition(actor.slug, clipKey)) {
      actor.clipMissing = true;
      this.#warn(event, {
        type: 'media', asset: 'sprite-clip', slug: actor.slug, clip: clipKey, message: 'clip absent from bundle',
      });
      return;
    }
    actor.clip = clipKey;
    actor.clipStartedMs = event.t_ms;
    actor.clipMissing = false;
  }

  // An x that is not a number is not a position to draw from. The DOM stage
  // absorbed one — the browser drops `left: NaNpx` and the sprite stayed where
  // it was — but this layer feeds `spreadAlongBand`, where a single NaN moves
  // EVERY movable occupant of the band to NaN and silently deletes the band's
  // own overcrowding report. Refused at the op, so it cannot spread.
  #usableX(event) {
    if (Number.isFinite(event.x)) return true;
    this.#warn(event, {
      type: 'policy',
      policy: 'position-unusable',
      op: event.op,
      slug: event.slug ?? null,
      x: event.x ?? null,
    });
    return false;
  }

  #warn(event, detail) {
    this.#warnings.push({ t_ms: event.t_ms, scene_index: event.scene_index ?? null, line: event.line ?? null, ...detail });
  }

  #clipDefinition(slug, clipKey) {
    return this.#bundle?.cast?.[slug]?.clips?.[clipKey] ?? null;
  }

  #heightOf(slug, kind, band) {
    const definition = kind === 'object' ? this.#bundle?.objects?.[slug] : this.#bundle?.cast?.[slug];
    return drawnSpriteHeightPx(definition?.height_cm, this.#zone(band));
  }

  #zone(band) {
    return zoneNamed(this.#plate, band);
  }

  #floorY(x, band) {
    return floorYAtX(this.#zone(band)?.polygon, x) ?? NO_FLOOR_STAND_Y;
  }

  #reorder() {
    paintOrder([...this.#actors.values()], this.#plate);
  }

  #relieveCrowding(band, event) {
    const { moved, overflow, zone, occupants } = spreadBand([...this.#actors.values()], band, this.#plate);
    for (const [slug, x] of moved) {
      const actor = this.#actors.get(slug);
      const feetY = this.#floorY(x, actor.band);
      const to = { x, feetY, heightPx: actor.heightPx };
      if (actor.motion) actor.motion = redirectMotion(actor.motion, event.t_ms, to);
      actor.x = x;
      actor.feetY = feetY;
    }
    // A band too narrow for its cast is a fact about the plate, not a failure
    // to resolve: everybody is still drawn, and how short it was is said at the
    // moment it was measured rather than carried as a standing claim that
    // outlives the crowd.
    if (overflow > 0) {
      this.#warn(event, {
        type: 'policy', policy: 'band-overcrowded', zone, occupants, short_pct: Math.round(overflow * 10) / 10,
      });
    }
  }

  #geometryOf(actor, tMs) {
    if (!actor.motion) {
      return { x: actor.x, feetY: actor.feetY, heightPx: actor.heightPx, opacity: actor.opacity };
    }
    return motionAt(actor.motion, tMs);
  }

  #framingAt(tMs) {
    const { from, held, startMs, durationMs } = this.#camera;
    if (durationMs <= 0) return held;
    return framingBetween(from, held, (tMs - startMs) / durationMs);
  }

  #drawableAt(actor, tMs) {
    const geometry = this.#geometryOf(actor, tMs);
    const clip = this.#clipDefinition(actor.slug, actor.clip);
    const frame = clip
      ? frameIndexAt((tMs - actor.clipStartedMs) / 1000, clip.fps, clip.frames)
      : null;
    return {
      slug: actor.slug,
      kind: actor.kind,
      band: actor.band,
      x: geometry.x,
      feetY: geometry.feetY,
      heightPx: geometry.heightPx,
      opacity: geometry.opacity,
      clip: actor.clip,
      clipMissing: actor.clipMissing,
      frame,
      cell: clip ? frameCell(frame, clip.grid ?? [clip.frames, 1]) : null,
      moving: actor.motion !== null,
      highlightMs: actor.highlightMs,
    };
  }
}
