/**
 * What the canvas is asked to draw, at an instant, in plate coordinates.
 *
 * Two kinds of test, and they answer different questions. The rules below are
 * about arithmetic nobody can see by eye — a square box hung off the feet, a
 * cell read from the RENDITION's grid rather than the bundle's — and each one
 * fails on a mutation that a browser would show as a picture that is merely
 * slightly wrong.
 *
 * The goldens are about the corpus: seven stories, five instants each, the
 * whole list written out. They exist because the DOM stage this replaces was
 * pinned by nothing at all until late in its life, and it shipped four bugs
 * that a fully green suite called fine. Regenerate with
 * `UPDATE_DRAWLIST_GOLDENS=1 node --test tests/draw-list.test.mjs`, and justify
 * the diff — a moved number here is a moved picture.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { sceneAssetPlan } from '../browser/v0/app/assets/scene-loader.mjs';
import { cameraDuration } from '../browser/v0/core/state/camera.mjs';
import { sceneSheets } from '../browser/v0/app/stage/canvas-stage.mjs';
import {
  SHADOW_OPACITY,
  SHADOW_RADIUS_X,
  SHADOW_RADIUS_Y,
  buildDrawList,
} from '../browser/v0/app/stage/draw-list.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { STEMS, read } from './_parity.mjs';

const GOLDENS = new URL('fixtures/drawlist/', import.meta.url);
// 1:1 and one device pixel per CSS pixel, so the tier a golden records is the
// ladder's honest answer for a stage at its own size rather than this machine's.
const VIEWPORT = { fitScale: 1, dpr: 1 };

function actorState({ actors = [], camera, plate } = {}) {
  return {
    tMs: 0,
    sceneIndex: 0,
    plate: plate ?? { resolution: [1920, 1080] },
    actors: actors.map((actor) => ({
      kind: 'character', opacity: 1, clipMissing: false, frame: 0, ...actor,
    })),
    camera: camera ?? { scale: 1, x: 0, y: 0 },
    subtitle: '',
    ended: false,
    warnings: [],
  };
}

const oneSheet = (url, grid) => ({ sheet: () => ({ url, grid }), prop: () => null });

test('a sprite is a square box hung off its feet, centred on its x', () => {
  const list = buildDrawList(
    actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right' }] }),
    oneSheet('sheet.webp', [1, 1]),
  );
  const sprite = list.commands.find((command) => command.op === 'sprite');
  // x and feetY are percentages of the plate: 50% of 1920 and 90% of 1080.
  assert.deepEqual(
    { dx: sprite.dx, dy: sprite.dy, dw: sprite.dw, dh: sprite.dh },
    { dx: 860, dy: 772, dw: 200, dh: 200 },
  );
  assert.deepEqual([list.width, list.height], [1920, 1080]);
});

test('the shadow lands under the feet, before the sprite, at the actor’s own fade', () => {
  const list = buildDrawList(
    actorState({ actors: [{ slug: 'ruby', x: 25, feetY: 80, heightPx: 300, clip: 'idle_right', opacity: 0.5 }] }),
    oneSheet('sheet.webp', [1, 1]),
  );
  assert.deepEqual(list.commands.map((command) => command.op), ['shadow', 'sprite']);
  const [shadow] = list.commands;
  assert.deepEqual(
    { cx: shadow.cx, cy: shadow.cy, rx: shadow.rx, ry: shadow.ry },
    { cx: 480, cy: 864, rx: 300 * SHADOW_RADIUS_X, ry: 300 * SHADOW_RADIUS_Y },
  );
  // A departing character fades their shadow with them; a shadow at full
  // strength under a half-gone character is the tell that they are two things.
  assert.equal(shadow.opacity, 0.5 * SHADOW_OPACITY);
  assert.equal(list.commands[1].opacity, 0.5);
});

test('somebody fully faded out is not drawn at all', () => {
  const list = buildDrawList(
    actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right', opacity: 0 }] }),
    oneSheet('sheet.webp', [1, 1]),
  );
  assert.deepEqual(list.commands, []);
});

test('the cell comes from the sheet actually being drawn, not from the bundle’s grid', () => {
  // The trap the rendition ladder brings with it: `grid` in the bundle
  // describes the ORIGINAL strip, and the encode re-grids an 81-frame row into
  // a 9x9. Frame 10 is cell [10, 0] of the strip and cell [1, 1] of the
  // rendition — reading the first would animate the wrong picture and error
  // nowhere, because both are valid cells of something.
  const state = actorState({
    actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly_left', frame: 10, cell: [10, 0] }],
  });
  const list = buildDrawList(state, oneSheet('owl.webp', [9, 9]));
  const sprite = list.commands.find((command) => command.op === 'sprite');
  assert.deepEqual(sprite.cell, [1, 1]);
  assert.deepEqual(sprite.cells, [9, 9]);
});

test('a clip the bundle never carried, and a sheet not planned yet, both draw the placeholder', () => {
  const missingClip = buildDrawList(
    actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'skip', clipMissing: true }] }),
    oneSheet('sheet.webp', [1, 1]),
  );
  const unplanned = buildDrawList(
    actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right' }] }),
    { sheet: () => null, prop: () => null },
  );
  for (const list of [missingClip, unplanned]) {
    const figure = list.commands.at(-1);
    assert.equal(figure.op, 'missing');
    // The placeholder occupies the character's own box, so the picture keeps
    // somebody standing in the right place at the right size.
    assert.deepEqual([figure.dx, figure.dy, figure.dw], [860, 772, 200]);
  }
});

test('a grid that is not two whole positive numbers is no grid at all', () => {
  // A zero column count divides by zero and lands every frame on cell NaN,
  // which `drawImage` throws on — one malformed sheet would take down the frame
  // rather than one sprite.
  for (const grid of [[0, 1], [9, 0], [9.5, 9], null, ['9', '9']]) {
    const list = buildDrawList(
      actorState({ actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly_left' }] }),
      oneSheet('owl.webp', grid),
    );
    assert.equal(list.commands.at(-1).op, 'missing', `grid ${JSON.stringify(grid)}`);
  }
});

test('a prop is its own picture, and a prop with nothing behind it is the placeholder', () => {
  const state = actorState({
    actors: [{ slug: 'lantern', kind: 'object', x: 50, feetY: 90, heightPx: 120, clip: null }],
  });
  const drawn = buildDrawList(state, { sheet: () => null, prop: () => ({ url: 'lantern.svg' }) });
  assert.equal(drawn.commands.at(-1).op, 'prop');
  assert.equal(drawn.commands.at(-1).url, 'lantern.svg');
  const absent = buildDrawList(state, { sheet: () => null, prop: () => null });
  assert.equal(absent.commands.at(-1).op, 'missing');
});

test('the camera is carried as the plate reads it, and an unusable one opens wide', () => {
  const aimed = buildDrawList(actorState({ camera: { scale: 1.5500001, x: -27.500049, y: -12 } }));
  assert.deepEqual(aimed.camera, { scale: 1.55, x: -27.5, y: -12 });
  for (const camera of [{ scale: Number.NaN, x: 0, y: 0 }, null, { scale: 1, x: Infinity, y: 0 }]) {
    assert.deepEqual(buildDrawList(actorState({ camera })).camera, { scale: 1, x: 0, y: 0 });
  }
});

test('paint order is the state core’s answer, carried through unchanged', () => {
  // `stateAt` hands the cast over back to front. Re-sorting here would be a
  // second opinion about who covers whom, and the two would disagree the first
  // time a walk changed bands mid-scene.
  const list = buildDrawList(
    actorState({
      actors: [
        { slug: 'far', x: 20, feetY: 70, heightPx: 100, clip: 'idle_right' },
        { slug: 'near', x: 60, feetY: 92, heightPx: 300, clip: 'idle_left' },
      ],
    }),
    oneSheet('sheet.webp', [1, 1]),
  );
  assert.deepEqual(
    list.commands.filter((command) => command.op === 'sprite').map((command) => command.slug),
    ['far', 'near'],
  );
});

test('a plate with no resolution of its own is the stage’s default', () => {
  const list = buildDrawList(actorState({ plate: { poster: 'p.jpg' } }));
  assert.deepEqual([list.width, list.height], [1920, 1080]);
});

/**
 * The instants worth writing down, read off the timeline rather than chosen by
 * hand: a hand-picked millisecond stops meaning anything the moment the corpus
 * is recompiled a hair earlier.
 *
 * One tableau per scene — a millisecond after its LAST placement, so the whole
 * cast is standing rather than half of it — the middle of the first walk, the
 * far end of the first camera move of EACH kind, the moment a prop is on the
 * stage, and the ending.
 *
 * The camera instants are where this was quietly empty. A `pan` sometimes
 * carries `duration_ms`; a `push_in` and a `pull_out` never do — their length
 * comes from `speed` through `cameraDuration`, exactly as the state core reads
 * it. Selecting on `duration_ms > 0` therefore skipped every push in the
 * corpus, and `1.55` appeared in no golden at all: the story kept FOR its push
 * pinned four instants of a camera sitting at 1x.
 */
function instantsOf(timeline) {
  const stage = timeline.events.filter((event) => event.source === 'stage');
  const first = (op) => stage.find((event) => event.op === op) ?? null;
  const chosen = new Set();
  const assembled = new Map();
  for (const event of stage) {
    if (event.op === 'scene') assembled.set(event.scene_index, event.t_ms);
    if (['place', 'place_object'].includes(event.op)) {
      assembled.set(event.scene_index, Math.max(assembled.get(event.scene_index) ?? 0, event.t_ms));
    }
    if (event.op === 'end') chosen.add(event.t_ms);
  }
  for (const tMs of assembled.values()) chosen.add(tMs + 1);
  const walk = stage.find((event) => event.op === 'move' && event.duration_ms > 0);
  if (walk) chosen.add(walk.t_ms + Math.round(walk.duration_ms / 2));
  for (const op of ['push_in', 'pull_out', 'pan']) {
    const move = first(op);
    if (!move) continue;
    const spans = Number.isFinite(move.duration_ms) ? move.duration_ms : cameraDuration(move.speed);
    chosen.add(move.t_ms + spans);
  }
  const prop = first('place_object');
  if (prop) chosen.add(prop.t_ms + 1);
  return [...chosen].sort((left, right) => left - right);
}

for (const stem of STEMS) {
  test(`${stem} draws what its golden says it draws`, () => {
    const bundle = read(stem, 'bundle');
    const timeline = read(stem, 'timeline');
    const books = new Map();
    const instants = instantsOf(timeline).map((tMs) => {
      const state = stateAt(timeline, bundle, tMs);
      const scene = state.sceneIndex ?? 0;
      if (!books.has(scene)) {
        books.set(scene, sceneSheets(sceneAssetPlan(timeline, bundle, scene, VIEWPORT), null));
      }
      return { t_ms: tMs, list: buildDrawList(state, books.get(scene)) };
    });

    const golden = new URL(`${stem}.json`, GOLDENS);
    const written = `${JSON.stringify({ instants }, null, 2)}\n`;
    if (process.env.UPDATE_DRAWLIST_GOLDENS === '1') fs.writeFileSync(golden, written);
    assert.equal(written, fs.readFileSync(golden, 'utf8'));
  });
}

test('the goldens hold a magnified camera, not just the wide one', () => {
  // The corpus is kept for its camera moves, so a corpus that only ever
  // recorded 1x would leave every framing this drawer carries unpinned — and
  // it did, until the instant selector learned that a push's length comes from
  // its speed. `golden_push_dusk` is the story named after the move.
  const magnified = new Set();
  for (const stem of STEMS) {
    const { instants } = JSON.parse(fs.readFileSync(new URL(`${stem}.json`, GOLDENS), 'utf8'));
    for (const instant of instants) {
      if (instant.list.camera.scale !== 1) magnified.add(`${stem} ${instant.list.camera.scale}`);
    }
  }
  assert.ok(
    [...magnified].some((seen) => seen.startsWith('golden_push_dusk ')),
    `no golden holds a push: ${[...magnified].join(', ') || 'every instant is 1x'}`,
  );
});

test('the goldens cover every command a healthy story draws', () => {
  // A command with no golden behind it is a picture nobody has ever looked at.
  // `missing` is deliberately not in this list: it is the fault path — a clip
  // the bundle lacks, a sheet still decoding — and a corpus that produced one
  // would be a broken corpus. It is pinned by the rules above instead.
  const seen = new Set();
  for (const stem of STEMS) {
    const { instants } = JSON.parse(fs.readFileSync(new URL(`${stem}.json`, GOLDENS), 'utf8'));
    for (const instant of instants) for (const command of instant.list.commands) seen.add(command.op);
  }
  assert.deepEqual([...seen].sort(), ['prop', 'shadow', 'sprite']);
});
