import assert from 'node:assert/strict';
import test from 'node:test';

import { floorSpan, zoneNamed } from '../browser/v0/core/geometry.mjs';
import { stageWidthOf } from '../browser/v0/core/state/layout.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
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
