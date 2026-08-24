import assert from 'node:assert/strict';
import test from 'node:test';

import { floorSpan, zoneNamed } from '../browser/v0/core/geometry.mjs';
import { stageWidthOf } from '../browser/v0/core/state/layout.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { STEMS, read } from './_parity.mjs';

/**
 * `stateAt` against the seven published timelines.
 *
 * The compiler is pinned to these byte for byte, so they are also the only
 * corpus in the repository where "what the story asked for" is known
 * independently of the thing being tested: every assertion below reads a value
 * off the event stream and demands the picture agree with it at the instant the
 * stream names.
 */

const STORIES = STEMS.map((stem) => ({
  stem,
  bundle: read(stem, 'bundle'),
  timeline: read(stem, 'timeline'),
}));

// Two occupants of one band may not be drawn on top of each other, but the
// timeline records the x the STORY asked for and not the one we draw. These
// four are the stories where the two differ: `beside=` nudges its subject by
// 0.01% and leaves the real spacing to the spread, and characters told to walk
// to one point are recorded on one point. Measured, so a rule change moves the
// number rather than passing quietly.
const SEPARATING = new Map([
  ['golden_camera_moves', 4],
  ['golden_heal_travel', 1],
  ['golden_push_dusk', 0],
  ['golden_together_audio', 0],
  ['ruby_and_the_gentle_dark', 24],
  ['the_owls_quiet_friend', 8],
  ['thud_in_the_forest_scene1', 0],
]);

// Walks that run to their end untouched. Only two of the seven stories walk
// anybody across a stage at all — the rest place, emote and travel — so the
// count is here to say which, and to notice if a rule ever stops one landing.
const WALKS = new Map([
  ['golden_camera_moves', 1],
  ['golden_heal_travel', 0],
  ['golden_push_dusk', 0],
  ['golden_together_audio', 0],
  ['ruby_and_the_gentle_dark', 6],
  ['the_owls_quiet_friend', 0],
  ['thud_in_the_forest_scene1', 0],
]);

// Placements onto a band with nobody else on it. That is the exact condition
// under which the spread cannot have touched the character — `spreadAlongBand`
// is not even called for a band of one — so it is the only case where the
// picture owes the published x to the digit. Five in the whole corpus: these
// stories are crowded, which is the point of them. Counted so that a change
// which quietly makes the number zero has to say so.
const EXACT_PLACEMENTS = new Map([
  ['golden_camera_moves', 1],
  ['golden_heal_travel', 0],
  ['golden_push_dusk', 3],
  ['golden_together_audio', 0],
  ['ruby_and_the_gentle_dark', 0],
  ['the_owls_quiet_friend', 1],
  ['thud_in_the_forest_scene1', 0],
]);

// Six of the seven are healthy: every clip they name is in the bundle and every
// camera op resolves. `the_owls_quiet_friend` crams three onto a foreground
// 1.5% too narrow for them, twice at one instant — two settles, two spreads,
// two sentences, exactly as the DOM stage warned. Pinned so the channel is
// known to be reachable from the corpus, and known to say nothing else.
const WARNINGS = new Map([
  ['the_owls_quiet_friend', [
    { t_ms: 65_564, scene_index: 2, line: 52, type: 'policy', policy: 'band-overcrowded', zone: 'foreground', occupants: 3, short_pct: 1.5 },
    { t_ms: 65_564, scene_index: 2, line: 53, type: 'policy', policy: 'band-overcrowded', zone: 'foreground', occupants: 3, short_pct: 1.5 },
  ]],
]);

const OVERLAP_EPSILON = 1e-9;

for (const { stem, bundle, timeline } of STORIES) {
  test(`${stem}: every placement is on screen, in its clip, at its own instant`, () => {
    let checked = 0;
    // Several ops can dress one character at one instant — a `together` moves
    // and then emotes on purpose, so the emotion is meant to win. The last one
    // the stream applied is the one the picture owes.
    const dressed = lastClipPerInstant(timeline);
    for (const event of stageEvents(timeline)) {
      if (!['place', 'clip', 'settle'].includes(event.op)) continue;
      const state = stateAt(timeline, bundle, event.t_ms);
      const actor = state.actors.find((candidate) => candidate.slug === event.slug);
      assert.ok(actor, `${event.op} ${event.slug} at ${event.t_ms} ms left nobody on stage`);
      const clip = dressed.get(`${event.t_ms}|${event.slug}`);
      if (clip && bundle.cast[event.slug]?.clips?.[clip]) {
        assert.equal(actor.clip, clip, `${event.slug} at ${event.t_ms} ms wears the wrong clip`);
      }
      // A character can be placed twice at one instant — an arrival staged by
      // the scene, then a `put` that moves them — and only the last one is
      // what the picture owes.
      if (event.op === 'place' && !superseded(timeline, event) && alone(state, actor)) {
        assert.equal(actor.x, event.x, `${event.slug} was placed off its own x at ${event.t_ms} ms`);
        checked += 1;
      }
    }
    // Counts the placements whose x was really held, not every op that ran.
    assert.equal(checked, EXACT_PLACEMENTS.get(stem), `${stem} held ${checked} placements to their published x`);
  });

  test(`${stem}: the subtitle on screen is the line the stream last put there`, () => {
    let lines = 0;
    const spoken = new Map();
    for (const event of stageEvents(timeline)) {
      if (event.op === 'subtitle') spoken.set(event.t_ms, event.text ?? '');
      if (event.op === 'end') spoken.set(event.t_ms, '');
    }
    for (const [tMs, text] of spoken) {
      assert.equal(stateAt(timeline, bundle, tMs).subtitle, text, `the wrong line was up at ${tMs} ms`);
      lines += 1;
    }
    assert.ok(lines > 0, 'a story that never says anything');
  });

  test(`${stem}: says exactly what it has to say, and nothing else`, () => {
    const expected = WARNINGS.get(stem) ?? [];
    assert.deepEqual(stateAt(timeline, bundle, timeline.duration_ms).warnings, expected);
    // A warning is an event, not a standing claim: it is stamped with the
    // instant it happened and is not there before it.
    for (const warning of expected) {
      assert.ok(
        stateAt(timeline, bundle, warning.t_ms - 1).warnings.length < expected.length,
        'a warning arrived before the moment it describes',
      );
    }
  });

  test(`${stem}: a walk lands, and stops, at the millisecond the timeline published`, () => {
    let landed = 0;
    let held = 0;
    for (const event of stageEvents(timeline)) {
      if (event.op !== 'move') continue;
      const end = event.t_ms + event.duration_ms;
      if (disturbed(timeline, event, end)) continue;
      const state = stateAt(timeline, bundle, end);
      const actor = state.actors.find((candidate) => candidate.slug === event.slug);
      assert.ok(actor, `${event.slug} is not on stage at the end of their own walk, ${end} ms`);
      assert.equal(actor.moving, false, `${event.slug} was still walking at ${end} ms`);
      landed += 1;
      // The published x is where the walk was AIMED, and the one thing allowed
      // to move it is the spread — which never runs on a band of one.
      if (!alone(state, actor)) continue;
      assert.equal(actor.x, event.x, `${event.slug} missed its mark at ${end} ms`);
      held += 1;
    }
    assert.equal(landed, WALKS.get(stem), `${stem} landed ${landed} walks`);
    // Every walk in this corpus arrives in company, so the exact arrival x is
    // never reachable here: `state-motion.test.mjs` is where that is pinned,
    // on a story built with nobody in the way. Said out loud rather than left
    // to look like coverage.
    assert.equal(held, 0, `${stem} now has an uncrowded walk — assert its x and raise this`);
  });

  // Not every story sends somebody off; that every op in the table is
  // exercised SOMEWHERE is `compile-timeline.test.mjs`'s standing assertion.
  test(`${stem}: an exit takes them off, and only at its own instant`, () => {
    for (const event of stageEvents(timeline)) {
      if (event.op !== 'exit') continue;
      // Leaving one scene and arriving in the next happen at one instant: the
      // exit is the last thing in the old scene and a `place` is among the
      // first in the new one, so at that millisecond they are back.
      if (returnsAt(timeline, event)) continue;
      const before = stateAt(timeline, bundle, event.t_ms - 1);
      const after = stateAt(timeline, bundle, event.t_ms);
      assert.ok(before.actors.some((actor) => actor.slug === event.slug), `${event.slug} left early`);
      assert.ok(!after.actors.some((actor) => actor.slug === event.slug), `${event.slug} stayed`);
    }
  });

  test(`${stem}: nobody standing in a band is drawn on top of anybody`, () => {
    let separated = 0;
    for (const tMs of instants(timeline)) {
      const state = stateAt(timeline, bundle, tMs);
      const half = new Map(state.actors.map(
        (actor) => [actor.slug, ((actor.heightPx / stageWidthOf(state.plate)) * 100) / 2],
      ));
      const recorded = recordedAt(timeline, tMs);

      for (const [band, members] of bands(state)) {
        // A walk-off is not crowded: the whole cast leaves through one anchor,
        // fading as they go, and the browser never separated them either.
        const standing = members.filter((actor) => !actor.moving && actor.opacity > 0);
        // Measured off the plate rather than read back off the state, so the
        // exemption is not the implementation grading its own homework.
        const room = floorSpan(zoneNamed(state.plate, band)?.polygon);
        const short = !room
          || standing.reduce((total, actor) => total + (2 * half.get(actor.slug)), 0) > (room.max - room.min);
        for (let index = 1; index < standing.length; index += 1) {
          for (let other = 0; other < index; other += 1) {
            const needed = half.get(standing[index].slug) + half.get(standing[other].slug);
            const asked = Math.abs(recorded.get(standing[index].slug) - recorded.get(standing[other].slug));
            if (asked >= needed) continue;
            // The story asked for two cells that overlap; the picture may not
            // have them overlap.
            assert.ok(
              Math.abs(standing[index].x - standing[other].x) - needed > -OVERLAP_EPSILON || short,
              `${standing[index].slug} and ${standing[other].slug} nest on ${band} at ${tMs} ms`,
            );
            separated += 1;
          }
        }
        if (short) continue;
        const ordered = [...standing].sort((left, right) => left.x - right.x);
        for (let index = 1; index < ordered.length; index += 1) {
          const previous = ordered[index - 1];
          const current = ordered[index];
          assert.ok(
            (current.x - half.get(current.slug)) - (previous.x + half.get(previous.slug)) > -OVERLAP_EPSILON,
            `${previous.slug} overlaps ${current.slug} on ${band} at ${tMs} ms`,
          );
        }
      }
    }
    assert.equal(separated, SEPARATING.get(stem), `${stem} separated ${separated} overlapping pairs`);
  });

  test(`${stem}: the story ends wide and quiet`, () => {
    const state = stateAt(timeline, bundle, timeline.duration_ms);
    assert.equal(state.ended, true);
    assert.equal(state.subtitle, '');
    assert.deepEqual(state.camera, { scale: 1, x: 0, y: 0 });
  });

  test(`${stem}: the picture at t is decided by the events up to t and nothing after`, () => {
    for (const tMs of sample(instants(timeline), 40)) {
      const truncated = { ...timeline, events: timeline.events.filter((event) => event.t_ms <= tMs) };
      assert.deepEqual(
        picture(stateAt(truncated, bundle, tMs)),
        picture(stateAt(timeline, bundle, tMs)),
        `the future reached back into ${tMs} ms`,
      );
    }
  });
}

/**
 * The runtime does not read the story cold — it reads it forward, through
 * `createStateCursor`, which holds the fold open instead of replaying it. That
 * is a second implementation of the same question, so it is held to the first
 * one here: same corpus, same instants, same answer, or the optimisation is a
 * different player.
 *
 * Every event boundary and both sides of it: a millisecond either way of an
 * event is where a fold that applied one event too many or too few shows up,
 * and it is exactly where a walk starts, a cut lands and a clip changes.
 */
for (const { stem, bundle, timeline } of STORIES) {
  test(`${stem}: reading forward through the cursor answers what stateAt answers`, () => {
    const cursor = createStateCursor(timeline, bundle);
    let asked = 0;
    for (const tMs of boundaries(timeline)) {
      assert.deepEqual(picture(cursor.at(tMs)), picture(stateAt(timeline, bundle, tMs)), `${tMs} ms`);
      asked += 1;
    }
    // Every instant the stream names is in there, and both sides of it.
    // `golden_heal_travel` publishes all 23 of its events on two instants, so a
    // flat count would be a different demand for each story.
    const named = new Set(timeline.events.map((event) => event.t_ms)).size;
    assert.ok(asked >= named * 2, `${stem} names ${named} instants and the cursor was asked at ${asked}`);
    // The plate is the bundle's own object on both paths; `picture` drops it
    // from the comparison above because comparing every traced polygon at every
    // instant is minutes of nothing.
    assert.equal(cursor.at(timeline.duration_ms).plate, stateAt(timeline, bundle, timeline.duration_ms).plate);
  });
}

for (const { stem, bundle, timeline } of STORIES) {
  test(`${stem}: a cursor asked one millisecond back answers what stateAt answers`, () => {
    const cursor = createStateCursor(timeline, bundle);
    // The forward pass above only ever asks for a larger t, so it never rewinds
    // at all, and the backwards tests step whole seconds — far from wherever
    // the cursor is standing. The smallest step back there is, onto the last
    // instant an event has NOT happened at from the instant it has, is the one
    // a scrub, a replay or a repaint actually lands on.
    for (const tMs of instants(timeline)) {
      if (tMs <= 0) continue;
      cursor.at(tMs);
      assert.deepEqual(
        picture(cursor.at(tMs - 1)),
        picture(stateAt(timeline, bundle, tMs - 1)),
        `${tMs - 1} ms, one back from ${tMs} ms`,
      );
    }
  });
}

test('the cursor folds each event once for the whole story, not once per frame', () => {
  // The reason it exists, and the one thing equality with `stateAt` cannot
  // show: a cursor written as `at: (t) => stateAt(timeline, bundle, t)` passes
  // every other test in this file. So the events are counted as they are read.
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'ruby_and_the_gentle_dark');
  let reads = 0;
  const counted = {
    ...timeline,
    events: new Proxy(timeline.events, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return target[key];
      },
    }),
  };

  const cursor = createStateCursor(counted, bundle);
  const frames = 240;
  for (let frame = 0; frame <= frames; frame += 1) {
    cursor.at(Math.round((frame * timeline.duration_ms) / frames));
  }

  // The pair check walks the stream once, each event is read once when it is
  // applied, and each frame reads the one event it does NOT apply — the loop's
  // own stop condition. Everything else would be a re-fold.
  const ceiling = (2 * timeline.events.length) + frames + 2;
  assert.ok(
    reads <= ceiling,
    `${frames} frames read ${reads} events; folding from zero every frame would be `
    + `about ${frames * timeline.events.length}, and reading each once is at most ${ceiling}`,
  );
  // Asking twice for one instant folds nothing at all the second time.
  const settled = reads;
  cursor.at(timeline.duration_ms);
  cursor.at(timeline.duration_ms);
  assert.ok(reads - settled <= 2, `an instant already answered cost ${reads - settled} more event reads`);
});

test('the corpus this is read forward through is in time order, which is what makes that legal', () => {
  // The cursor's answer depends on the stream being non-decreasing in `t_ms`;
  // `stateAt` is stateless and cannot notice. Nothing in the compiler asserts
  // it — `Schedule` only ever moves forward, so it is emergent — and this is
  // the line that would fail if that ever stopped being true.
  for (const { stem, timeline } of STORIES) {
    let last = -Infinity;
    for (const [index, event] of timeline.events.entries()) {
      assert.ok(
        Number.isFinite(event.t_ms) && event.t_ms >= last,
        `${stem} event ${index} is stamped ${event.t_ms} after ${last}`,
      );
      last = event.t_ms;
    }
  }
});

test('an event that throws throws again, rather than being folded past in silence', () => {
  // `stateAt` builds a world per call, so an op it cannot apply throws on every
  // call. A cursor that counted the event as applied would throw once and then
  // draw the rest of the story on a world half way through it.
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'golden_push_dusk');
  const exploding = {
    source: 'stage',
    op: 'subtitle',
    t_ms: 0,
    get text() { throw new Error('this event cannot be read'); },
  };
  const cursor = createStateCursor({ ...timeline, events: [exploding] }, bundle);
  for (const attempt of [1, 2, 3]) {
    assert.throws(() => cursor.at(0), /this event cannot be read/, `attempt ${attempt} was quiet`);
  }
});

test('a cursor asked backwards, and one asked out of order, both still answer stateAt', () => {
  // A seek is a t smaller than the last one. The world has already crossed
  // events that have not happened at the new instant, so it cannot be wound
  // back — it is rebuilt, and the proof is that the answer is unchanged.
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'ruby_and_the_gentle_dark');
  const cursor = createStateCursor(timeline, bundle);
  for (let tMs = timeline.duration_ms; tMs >= 0; tMs -= 449) {
    assert.deepEqual(picture(cursor.at(tMs)), picture(stateAt(timeline, bundle, tMs)), `${tMs} ms backwards`);
  }
  for (const tMs of [7598, 11, 4027, 0, 91_562, 1611, 0, 91_562]) {
    assert.deepEqual(picture(cursor.at(tMs)), picture(stateAt(timeline, bundle, tMs)), `${tMs} ms out of order`);
  }

  // A t that is smaller but crosses nothing — a pause redrawn a frame later, a
  // scrub inside one gap between events — is the case the fold is deliberately
  // NOT thrown away for. Taken inside the widest gap in the story, where a walk
  // and a camera move are most likely to be in flight.
  const [from, to] = widestGap(timeline);
  for (let tMs = to - 1; tMs > from; tMs -= Math.max(1, Math.round((to - from) / 8))) {
    assert.deepEqual(picture(cursor.at(tMs)), picture(stateAt(timeline, bundle, tMs)), `${tMs} ms inside a gap`);
  }
});

test('a story swapped under the cursor is re-checked against its bundle', () => {
  // The pair check runs once per story instead of once per call now, so the
  // swap is what re-arms it. `appendScene` is the only swap in the runtime, and
  // a timeline compiled from another story reaching `apply` unchecked is the
  // silent disaster `requireMatchingPair` was written for.
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'golden_push_dusk');
  const cursor = createStateCursor(timeline, bundle);
  cursor.at(0);
  cursor.setStory({ ...timeline, storylang_version: 99 }, bundle);
  assert.throws(() => cursor.at(0), /were not built from each other/);

  const moved = createStateCursor(timeline, bundle);
  moved.at(0);
  moved.setStory(timeline, {
    ...bundle,
    scenes: [{ ...bundle.scenes[0], place: 'somewhere_else' }, ...bundle.scenes.slice(1)],
  });
  assert.throws(() => moved.at(0), /compiled from a different story/);
});

test('a warning the cursor has already handed out does not grow afterwards', () => {
  // The world keeps one warning list for its whole life and `stateAt` hands out
  // a fresh one per call because it builds a fresh world. An answer that went on
  // collecting warnings from events it never saw would be a lie a runtime
  // logging them later has no way to notice.
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'the_owls_quiet_friend');
  const cursor = createStateCursor(timeline, bundle);
  const early = cursor.at(0);
  const held = [...early.warnings];
  cursor.at(timeline.duration_ms);
  assert.deepEqual(early.warnings, held, 'an answer picked up warnings after it was given');
  assert.ok(cursor.at(timeline.duration_ms).warnings.length > held.length, 'the corpus story stopped warning');
});

test('a story appended under the cursor is the story it answers from', () => {
  // What a host watching a writer really does: publish scene 0, compile it,
  // play it, then hand over a LONGER story — a different bundle object and a
  // timeline compiled from it. The prefix is built the same way the streaming
  // path builds it, because the half of this that matters is the bundle swap:
  // the world reads the bundle for every height, plate and clip it hands out.
  const { bundle, timeline } = STORIES.find((story) => story.bundle.scenes.length > 1);
  const opening = { ...bundle, scenes: bundle.scenes.slice(0, 1) };
  const prefix = compileTimeline(opening);
  const cursor = createStateCursor(prefix, opening);
  cursor.at(prefix.duration_ms);

  cursor.setStory(timeline, bundle);
  const inside = Math.round((prefix.duration_ms + timeline.duration_ms) / 2);
  for (const tMs of [prefix.duration_ms, inside, timeline.duration_ms]) {
    assert.deepEqual(picture(cursor.at(tMs)), picture(stateAt(timeline, bundle, tMs)), `${tMs} ms after the append`);
  }
  // The instant in the middle is inside the appended part, and it draws
  // somebody — otherwise this compares two empty stages and proves nothing.
  const appended = cursor.at(inside);
  assert.ok(appended.sceneIndex > 0, `${inside} ms is still inside the opening scene`);
  assert.ok(appended.plate && appended.actors.length > 0, 'the appended scene drew nobody, on no plate');
});

test('the cursor refuses what stateAt refuses, and in the same order', () => {
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'golden_push_dusk');
  assert.throws(() => createStateCursor(timeline, bundle).at(undefined), /finite number of milliseconds/);
  // The pair is checked once per story rather than once per call, and it is
  // still checked FIRST: a timeline compiled from another story is the reason
  // the picture would be wrong, and a bad t asked of it is not.
  const mismatched = { ...timeline, storylang_version: 99 };
  assert.throws(() => createStateCursor(mismatched, bundle).at(0), /were not built from each other/);
  assert.throws(() => createStateCursor(mismatched, bundle).at(Number.NaN), /were not built from each other/);
});

// A player seeks, so it arrives at an instant from anywhere — and a later one
// may memoise its way there. Neither may change the answer.
test('the same instant answers the same however you arrive at it', () => {
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'golden_push_dusk');
  const forward = [];
  for (let tMs = 0; tMs <= timeline.duration_ms; tMs += 1) {
    forward.push(picture(stateAt(timeline, bundle, tMs)));
  }
  for (let tMs = timeline.duration_ms; tMs >= 0; tMs -= 137) {
    assert.deepEqual(picture(stateAt(timeline, bundle, tMs)), forward[tMs], `${tMs} ms read differently backwards`);
  }
  for (const tMs of [7598, 11, 4027, 0, 9156, 1611]) {
    assert.deepEqual(picture(stateAt(timeline, bundle, tMs)), forward[tMs], `${tMs} ms read differently out of order`);
  }
});

test('reading a picture writes nothing into the story it was read from', () => {
  const bundle = deepFreeze(read('golden_heal_travel', 'bundle'));
  const timeline = deepFreeze(read('golden_heal_travel', 'timeline'));
  for (const tMs of instants(timeline)) assert.ok(stateAt(timeline, bundle, tMs));
});

test('a t before the first event, and one past the last, are both answerable', () => {
  const { bundle, timeline } = STORIES.find((story) => story.stem === 'golden_push_dusk');
  const opening = stateAt(timeline, bundle, -1_000);
  assert.equal(opening.sceneIndex, 0, 'a negative t is the beginning, not an empty stage');
  assert.equal(stateAt(timeline, bundle, timeline.duration_ms + 60_000).ended, true);
});

function stageEvents(timeline) {
  return timeline.events.filter((event) => event.source === 'stage');
}

// Every instant the stream names and both sides of it, in the order a story is
// watched in. A millisecond before an event is the last instant it has NOT
// happened at, which is the half a fold reading forward can get wrong.
function boundaries(timeline) {
  const stamps = new Set();
  for (const tMs of instants(timeline)) {
    if (tMs > 0) stamps.add(tMs - 1);
    stamps.add(tMs);
    stamps.add(tMs + 1);
  }
  return [...stamps].sort((left, right) => left - right);
}

// The longest stretch of story between two events — the roomiest place to ask
// for a t that is smaller than the last one without crossing anything.
function widestGap(timeline) {
  const stamps = instants(timeline);
  let widest = [0, 0];
  for (let index = 1; index < stamps.length; index += 1) {
    if (stamps[index] - stamps[index - 1] > widest[1] - widest[0]) {
      widest = [stamps[index - 1], stamps[index]];
    }
  }
  return widest;
}

// Every instant the stream names, plus the instant every walk lands on.
function instants(timeline) {
  const stamps = new Set([0, timeline.duration_ms]);
  for (const event of timeline.events) {
    stamps.add(event.t_ms);
    if (Number.isFinite(event.duration_ms)) stamps.add(event.t_ms + event.duration_ms);
  }
  return [...stamps].sort((left, right) => left - right);
}

// A walk whose subject is touched again before it lands, or that a cut ends,
// may legitimately finish somewhere other than its own x. Its OWN settle, at
// the far end, is not a disturbance — it is the walk landing.
function disturbed(timeline, move, end) {
  return timeline.events.some((event) => (
    event.source === 'stage'
    && event.t_ms > move.t_ms
    && (event.t_ms < end || (event.t_ms === end && event.op !== 'settle'))
    && (event.slug === move.slug || event.op === 'scene')
  ));
}

// Another op for the same character, later in the stream but at the same
// instant, overwrites this one before anybody could have seen it.
function superseded(timeline, event) {
  const index = timeline.events.indexOf(event);
  return timeline.events.slice(index + 1).some((later) => (
    later.t_ms === event.t_ms
    && later.source === 'stage'
    && later.slug === event.slug
    && ['place', 'move', 'depart', 'exit'].includes(later.op)
  ));
}

function returnsAt(timeline, exit) {
  return timeline.events.some((event) => (
    event.source === 'stage' && event.op === 'place'
    && event.t_ms === exit.t_ms && event.slug === exit.slug
  ));
}

function lastClipPerInstant(timeline) {
  const dressed = new Map();
  for (const event of timeline.events) {
    if (event.source !== 'stage' || !event.clip) continue;
    dressed.set(`${event.t_ms}|${event.slug}`, event.clip);
  }
  return dressed;
}

function alone(state, actor) {
  return state.actors.filter((candidate) => candidate.band === actor.band).length === 1;
}


function bands(state) {
  const grouped = new Map();
  for (const actor of state.actors) {
    grouped.set(actor.band, [...(grouped.get(actor.band) ?? []), actor]);
  }
  return grouped;
}

// Where the timeline said everybody is, which is not where they are drawn.
function recordedAt(timeline, tMs) {
  const x = new Map();
  for (const event of timeline.events) {
    if (event.t_ms > tMs) break;
    if (event.source !== 'stage') continue;
    if (event.op === 'scene') x.clear();
    if (['place', 'place_object', 'move', 'depart'].includes(event.op)) x.set(event.slug, event.x);
    if (event.op === 'exit') x.delete(event.slug);
  }
  return x;
}

// The plate carries every traced polygon of the scene and never changes within
// one; comparing it on every sample is minutes of nothing.
function picture({ plate, ...rest }) {
  return rest;
}

function sample(values, count) {
  if (values.length <= count) return values;
  const step = (values.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, index) => values[Math.round(index * step)]);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
