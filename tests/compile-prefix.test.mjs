import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { STEMS, platesOf, read } from './_parity.mjs';

/**
 * The promise a streaming host is sold: a story can be played while it is still
 * being written.
 *
 * That only holds if compiling the scenes published SO FAR answers exactly what
 * compiling the finished story will answer about those same scenes — otherwise
 * a character already standing on screen jumps sideways the moment the next
 * scene lands, or a subtitle the viewer read is retimed under them. So the
 * property below is the whole contract, and it is a property of the compiler,
 * not of any player: for every k, `compile(scenes 1..k)` is the finished
 * timeline's own opening, event for event.
 *
 * With one exception, which is not a divergence but a completion: a prefix ends
 * with its own `end` op, because a compiler handed three scenes has no way to
 * know a fourth is coming. Deciding whether that end is real is the runtime's
 * job — the host is the only party that knows the writer stopped.
 *
 * The `plates` hint is what makes the rest of the property true; `compile.mjs`
 * says why, and `storylang/v0/bundle.py` in the engine repository is what puts
 * the block in the manifest.
 */

/**
 * `prefix` is the whole story's opening, minus its own provisional ending.
 *
 * Compared event by event rather than array against array: a failure here is a
 * rule change, and "event 214 moved" is the first thing anyone reading the
 * failure needs to know.
 */
function assertPrefixOf(prefix, full, label) {
  assert.equal(prefix.events.at(-1)?.op, 'end', `${label}: a prefix must still end with an end op`);
  const published = prefix.events.slice(0, -1);
  assert.ok(
    published.length <= full.events.length,
    `${label}: ${published.length} events, more than the finished story's ${full.events.length}`,
  );
  for (const [index, event] of published.entries()) {
    assert.deepEqual(
      event,
      full.events[index],
      `${label}: event ${index} (${event.op ?? event.kind}) moved when the story grew`,
    );
  }
}

for (const stem of STEMS) {
  test(`${stem} publishes one scene at a time without moving what it published`, () => {
    const bundle = read(stem, 'bundle');
    const plates = platesOf(bundle);
    const full = compileTimeline(bundle, { plates });

    // Every place these seven stand in is opened by a scene, so none of them
    // ever reaches the hint — which is the point: a block that merely agrees
    // with the scenes must be undetectable. The case where the hint is the ONLY
    // answer, and the case where it disagrees, are the unit stories below.
    assert.deepEqual(full, compileTimeline(bundle), 'the hint changed a whole-story compile');

    for (let published = 1; published <= bundle.scenes.length; published += 1) {
      const prefix = { ...bundle, scenes: bundle.scenes.slice(0, published) };
      assertPrefixOf(
        compileTimeline(prefix, { plates }),
        full,
        `${stem} with ${published} of ${bundle.scenes.length} scenes`,
      );
    }
  });
}

/**
 * The one divergence the corpus cannot show, because no story in it does this.
 *
 * A healed step can put a character in a place no scene has opened yet — the
 * language allows it and the engine emits it. The plate that place is shown on
 * decides where the character stands, and until that place's own scene is
 * published the compiler has nowhere to read it from. Anybody standing BESIDE
 * them then inherits the wrong answer, on screen, in the published prefix.
 */
const character = {
  height_cm: 12,
  capability: { idle: { camera: 'idle' }, move: { left: 'move-left', right: 'move-right' } },
  clips: { idle: {}, 'move-left': {}, 'move-right': {} },
};

const floorZone = (name, polygon) => ({
  name, surface: 'floor', description: '', polygon, depth: null, scale: null,
});

// Three floors, three centres — 50, 70 and 30 — so "I could not find the pond's
// plate", "I read the one its first scene shows" and "I read its later one" are
// three different numbers rather than one arrived at three ways.
const DELL_PLATE = {
  resolution: [1920, 1080],
  default_zone: 'floor',
  zones: [floorZone('floor', [[0, 80], [100, 80], [100, 100], [0, 100]])],
};
const POND_DUSK_PLATE = {
  resolution: [1920, 1080],
  default_zone: 'bank',
  zones: [floorZone('bank', [[60, 80], [80, 80], [80, 100], [60, 100]])],
};
const POND_NIGHT_PLATE = {
  resolution: [1920, 1080],
  default_zone: 'bank',
  zones: [floorZone('bank', [[20, 80], [40, 80], [40, 100], [20, 100]])],
};

// The pond is stood in twice, at two hours, so the block holds two plates for
// it and the compiler has to choose. Scene order is dell → pond → pond and the
// hours only ever move forward, which is the engine's time law.
function healedForwardStory() {
  return {
    storylang_version: 0,
    title: 'Forward',
    cast: { ruby: character, clover: character },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [
      {
        line: 1,
        place: 'dell',
        time: 'day',
        plate: DELL_PLATE,
        steps: [
          // Healed: ruby is sent to a place scene 2 opens and scene 1 never shows.
          { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: null, facing: null, place: 'pond' },
          // On screen, and anchored to her — this is the event that moves.
          { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'ruby', beside: 'right', facing: null },
          { kind: 'chunk', line: 4, text: 'A beat.', duration_s: 1 },
        ],
      },
      {
        line: 5,
        place: 'pond',
        time: 'dusk',
        plate: POND_DUSK_PLATE,
        steps: [{ kind: 'chunk', line: 6, text: 'The pond at dusk.', duration_s: 1 }],
      },
      {
        line: 7,
        place: 'pond',
        time: 'night',
        plate: POND_NIGHT_PLATE,
        steps: [{ kind: 'chunk', line: 8, text: 'The pond at night.', duration_s: 1 }],
      },
    ],
  };
}

const placedX = (timeline, slug) => timeline.events
  .find((event) => event.op === 'place' && event.slug === slug)?.x;

test('a character put forward into an unpublished place still stands where the finished story puts them', () => {
  const story = healedForwardStory();
  const plates = platesOf(story);
  const prefix = { ...story, scenes: story.scenes.slice(0, 1) };

  const finished = placedX(compileTimeline(story), 'clover');

  // Without the hint the published prefix is simply wrong, and stays wrong for
  // as long as the writer takes to reach scene 2. Pinned so the hint cannot be
  // deleted as decoration.
  assert.notEqual(
    placedX(compileTimeline(prefix), 'clover'),
    finished,
    'the divergence this hint exists for has gone — the test no longer proves anything',
  );

  // The pond's DUSK plate, not its night one: the block holds both, and the
  // scene that will open the pond first is the earlier of the two.
  assert.equal(placedX(compileTimeline(prefix, { plates }), 'clover'), finished);

  const full = compileTimeline(story, { plates });
  for (let published = 1; published <= story.scenes.length; published += 1) {
    const cut = { ...story, scenes: story.scenes.slice(0, published) };
    assertPrefixOf(compileTimeline(cut, { plates }), full, `healed forward at ${published} scene(s)`);
  }
});

test('a plate the scenes already answer for is never taken from the hint', () => {
  const story = healedForwardStory();
  // Every entry deliberately wrong. Scene 1 opens the dell and scene 2 the
  // pond, so the scan has an answer for both places and this block must be
  // unreachable — swap the two arms of `staged ?? this.#hintedPlateFor(place)`
  // and every character in the story restages against a finished timeline that
  // seven byte-pinned goldens say cannot move.
  const lying = {
    dell: { day: POND_NIGHT_PLATE },
    pond: { dusk: DELL_PLATE, night: DELL_PLATE },
  };
  assert.deepEqual(compileTimeline(story, { plates: lying }), compileTimeline(story));
});

test('the choice of plate does not depend on the order the host serialised the block in', () => {
  const story = healedForwardStory();
  const prefix = { ...story, scenes: story.scenes.slice(0, 1) };
  const sorted = platesOf(story);
  // The same two plates, listed the other way round. A block is JSON on the
  // wire and key order is not a fact about the story; a compiler that read one
  // would answer differently for two hosts that agree on everything.
  const reversed = {
    dell: sorted.dell,
    pond: { night: sorted.pond.night, dusk: sorted.pond.dusk },
  };
  assert.deepEqual(
    compileTimeline(prefix, { plates: reversed }),
    compileTimeline(prefix, { plates: sorted }),
  );
});

test('a host with no block to offer may say so with nothing at all', () => {
  const story = healedForwardStory();
  const bare = compileTimeline(story);
  // `null` is what a host threading an optional manifest field naturally hands
  // over; a default parameter alone would throw on it.
  assert.deepEqual(compileTimeline(story, null), bare);
  assert.deepEqual(compileTimeline(story, {}), bare);
  assert.deepEqual(compileTimeline(story, { plates: undefined }), bare);
});
