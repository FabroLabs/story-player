/**
 * `stateAt`, for somebody watching the story rather than asking about it.
 *
 * `stateAt` is asked cold — it folds every event from zero on every call — and
 * that is the right answer for a tool, a golden or a seek. A runtime is not
 * asking cold: it asks for 41 ms, then 83 ms, then 125 ms, twenty-four times a
 * second, and every one of those calls replays the whole story so far. Measured
 * in the browser on the published build (phase 12, F2): 0.045 ms per call one
 * second into a 203 s story, 1.236 ms two hundred seconds in — the same picture
 * costing twenty-seven times more for no reason but the length of the story
 * behind it. The same story in node says 0.09 ms and 1.98 ms: different engine,
 * same shape.
 *
 * So this holds the fold open. The world is wound forward through the events
 * the last answer had not reached yet, and the picture is read off it. The
 * answer is identical to `stateAt`'s because `World.apply` never reads the t
 * being asked about — only the event it is handed and the world so far — so the
 * world after "every event with t_ms <= t" is the same world whether those
 * events arrived in one pass or in two hundred. That holds while the timeline's
 * stamps are finite and non-decreasing, which is what a compiled one is (the
 * schedule only ever moves forward) and what `state-corpus.test.mjs` pins.
 *
 * Two things unwind it, and both are exact rather than cautious:
 *
 *   a t BEFORE the last event already applied — a seek back, a replay — cannot
 *   be answered by a world that has already crossed it, so the fold restarts.
 *   A t merely smaller than the last one asked (a pause redrawn a frame later,
 *   a scrub inside one gap between events) crosses nothing and costs nothing.
 *
 *   a new story — the host appended a scene, so both halves were swapped — is
 *   a different bundle behind the same actors. Nothing is carried over.
 */

import { World, requireMatchingPair, storyTimeMs } from './state.mjs';

export function createStateCursor(timeline, bundle) {
  let story = null;
  let world = null;
  // How many of the timeline's events are already folded in, and the instant
  // the last of them happened at. The second is the rewind test: it is the
  // earliest t this world can still answer for.
  let applied = 0;
  let appliedMs = -Infinity;
  let checked = false;

  setStory(timeline, bundle);

  return { at, setStory };

  /**
   * The picture at t, exactly as `stateAt(timeline, bundle, t)` draws it.
   *
   * The pair is checked once per story rather than once per call — the check
   * walks every scene event, which is the other half of what made the cold read
   * grow with the story. It still happens before the t is looked at, so a
   * mismatched pair is named ahead of a bad instant, as it always was.
   */
  function at(tMs) {
    if (!checked) {
      requireMatchingPair(story.timeline, story.bundle);
      checked = true;
    }
    const t = storyTimeMs(tMs);
    if (t < appliedMs) rewind();
    const events = story.timeline.events ?? [];
    // Read once, then decided — the same `break` on `t_ms > t` the cold read
    // does, rather than testing the event in the loop condition and fetching it
    // again in the body.
    while (applied < events.length) {
      const event = events[applied];
      if (event.t_ms > t) break;
      try {
        world.apply(event);
      } catch (error) {
        // A world half way through an event is not a world, and counting the
        // event as applied would hide the failure: every later frame would fold
        // the rest of the story onto the wreckage and draw a picture nobody
        // could explain. The fold is dropped instead, so the next call rebuilds
        // and throws at the same event — as loudly as the cold read did.
        rewind();
        throw error;
      }
      applied += 1;
      appliedMs = event.t_ms;
    }
    const picture = world.pictureAt(t);
    // The world's warning list is its own and goes on growing; `stateAt` hands
    // out a fresh one every call because it builds a fresh world. Copied so an
    // answer stays the answer it was — a caller holding one from ten frames ago
    // would otherwise watch it acquire warnings from events it never saw.
    return { ...picture, warnings: [...picture.warnings] };
  }

  /**
   * A different story under the same viewer: the host published another scene.
   *
   * The events already crossed are the same events, but the bundle is not the
   * same object and the world reads the bundle for every height, plate and clip
   * it hands out. Rebuilt rather than patched — an append happens once a scene,
   * and the first frame after it is the cheapest place in the story to pay for
   * a full fold.
   */
  function setStory(nextTimeline, nextBundle) {
    story = { timeline: nextTimeline, bundle: nextBundle };
    checked = false;
    rewind();
  }

  function rewind() {
    world = new World(story.bundle);
    applied = 0;
    appliedMs = -Infinity;
  }
}
