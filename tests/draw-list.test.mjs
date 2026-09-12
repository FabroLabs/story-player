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
  slateBuildMs,
} from '../browser/v0/app/stage/draw-list.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { HIGHLIGHT, SLATE } from '../browser/v0/policy.mjs';
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

test('a frame drawn from a chunk is counted from where that chunk begins', () => {
  // Frame 7 of a clip cut into fives, on the 3x2 canvas five frames round up to:
  // the second chunk starts at frame 5, so this is its cell 2 — [2, 0]. Read
  // with the frame the CLIP is at instead, `frameCell` wraps 7 into six cells
  // and lands on [1, 0]: a real cell of the right object, the wrong picture,
  // every loop, with nothing in the log.
  //
  // Five and not four on purpose. Every length the encoder actually picks fills
  // its canvas exactly, and where the cells and the chunk length are equal the
  // subtraction cancels under the wrap — it would be untested at 4, 6, 9 or 25.
  // The rule the drawer is held to is the contract, not today's table.
  const state = actorState({
    actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly_left', frame: 7 }],
  });
  const chunked = {
    sheet: () => ({ url: 'owl-chunk-1.webp', grid: [3, 2], chunkStart: 5 }),
    prop: () => null,
  };
  const sprite = buildDrawList(state, chunked).commands.find((command) => command.op === 'sprite');

  assert.equal(sprite.url, 'owl-chunk-1.webp');
  assert.deepEqual(sprite.cell, [2, 0]);
  assert.deepEqual(sprite.cells, [3, 2]);
});

test('the frame the drawer asks about is the frame the actor stands at', () => {
  const asked = [];
  const state = actorState({
    actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly_left', frame: 37 }],
  });
  buildDrawList(state, {
    sheet: (slug, clip, frame) => {
      asked.push([slug, clip, frame]);
      return { url: 'owl.webp', grid: [9, 9] };
    },
    prop: () => null,
  });

  assert.deepEqual(asked, [['owl', 'fly_left', 37]], 'without the frame the adapter cannot pick a chunk');
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

// --- the lesson's two overlays ---------------------------------------------

const slateList = (slate, tMs = 0, plate) => buildDrawList({ ...actorState({ plate }), slate, tMs });
const only = (list, op) => list.commands.filter((command) => command.op === op);
const boardAt = (slate, tMs = 0, plate) => only(slateList(slate, tMs, plate), 'slate')[0];
const counting = (count, from = 0) => ({ count, mode: 'count', groups: [count], sinceMs: 0, from });
const joining = (left, right) => ({
  count: left + right, mode: 'add', groups: [left, right], sinceMs: 0, from: 0,
});
const taking = (left, right) => ({
  count: left - right, mode: 'subtract', groups: [left, right], sinceMs: 0, from: 0,
});
// The instant every counter has landed and nothing has been taken away yet.
const settled = (drawn, from = 0) => ((drawn - 1 - from) * SLATE.staggerMs) + SLATE.popMs;

test('a story that counts nothing draws no board at all', () => {
  const nothing = [
    undefined,
    null,
    { count: 0, sinceMs: 0 },
    { count: 1.5, sinceMs: 0 },
    // A board whose own groups do not make its count is not a board to draw:
    // the fold refused it out loud, and the drawer draws what it can stand behind.
    { count: 6, mode: 'add', groups: [2, 3], sinceMs: 0 },
    { count: 3, mode: 'multiply', groups: [1, 3], sinceMs: 0 },
  ];
  for (const slate of nothing) {
    assert.deepEqual(only(slateList(slate), 'slate'), [], JSON.stringify(slate));
  }
});

test('a board that names no mode is the plain count every older bundle means', () => {
  const board = boardAt({ count: 3, sinceMs: 0 }, settled(3));

  assert.equal(board.mode, 'count');
  assert.deepEqual(board.groups, [3]);
  assert.equal(board.counters.length, 3);
});

test('the panel is the old board own rectangle, in this plate own pixels', () => {
  // The ratios the lessons were drawn against: 4.5% in from the left, 8.5% down
  // from the top, 91% by 84.5%, cornered at 5% of the height. On a 1920x1080
  // plate that is this rectangle, and a client drawing its own panel lands it here.
  const { panel } = boardAt(counting(3), settled(3));

  assert.deepEqual(panel, {
    x: 86.4, y: 91.8, w: 1747.2, h: 912.6, r: 54, sheenH: 146.02,
  });
  assert.equal(Math.round((panel.x + panel.w) * 10) / 10, 1833.6);
  assert.equal(Math.round((panel.y + panel.h) * 10) / 10, 1004.4);
});

test('the counters stand in one row up to five, centred on the plate', () => {
  const board = boardAt(counting(5), settled(5));
  const middle = board.counters.map((counter) => counter.cx);

  assert.deepEqual(board.counters.map((counter) => counter.n), [1, 2, 3, 4, 5]);
  assert.equal(new Set(board.counters.map((counter) => counter.cy)).size, 1, 'one row');
  // Centred: the row's own middle is the plate's middle, and the counters are
  // evenly pitched by one cell.
  assert.equal((middle[0] + middle.at(-1)) / 2, 1920 / 2);
  const pitch = middle[1] - middle[0];
  for (const [index, cx] of middle.entries()) {
    assert.equal(Math.round((cx - middle[0]) * 100) / 100, Math.round(index * pitch * 100) / 100);
  }
  // Every counter the same size, and it is the fraction of the cell the old
  // board drew its apples at.
  assert.equal(new Set(board.counters.map((counter) => counter.r)).size, 1);
  assert.equal(board.counters[0].r, Math.round(pitch * SLATE.counterRadius * 100) / 100);
});

test('six and over splits into two balanced rows, each centred on its own width', () => {
  const board = boardAt(counting(7), settled(7));
  const rows = new Map();
  for (const counter of board.counters) {
    rows.set(counter.cy, [...(rows.get(counter.cy) ?? []), counter]);
  }
  const [top, bottom] = [...rows.values()];

  assert.equal(rows.size, 2);
  assert.deepEqual([top.length, bottom.length], [4, 3], 'the fuller row is the top one');
  for (const row of [top, bottom]) {
    assert.equal((row[0].cx + row.at(-1).cx) / 2, 1920 / 2, 'the row is centred');
  }
  // Two rows of counters are smaller than one row of them: the rows share the
  // height between the panel top and the equation band.
  assert.ok(board.counters[0].r < boardAt(counting(5), settled(5)).counters[0].r);
});

test('the counters arrive one at a time, and the ring marks the newest of them', () => {
  const arriving = (tMs) => boardAt(counting(3), tMs).counters.map((counter) => counter.scale);

  assert.deepEqual(arriving(0), [0, 0, 0]);
  // A counter every `staggerMs`: two of them are on their way at once — the
  // stagger is shorter than the pop, so the board flows rather than ticks — and
  // the third has not begun at all.
  const middle = arriving(SLATE.staggerMs + 50);
  assert.ok(middle[0] > 0 && middle[1] > 0);
  assert.equal(middle[2], 0);
  assert.deepEqual(arriving(settled(3)), [1, 1, 1]);
  // The ring is on the newest counter that has BEGUN, not on the newest one
  // that will exist: a ring around nothing is a ring around the next number.
  assert.deepEqual(boardAt(counting(3), 100).counters.map((c) => c.ring), [true, false, false]);
  assert.deepEqual(boardAt(counting(3), settled(3)).counters.map((c) => c.ring), [false, false, true]);
});

test('the pop starts at nothing, peaks at the published overshoot, and settles at one', () => {
  // `overshoot` is the number a phone is handed; the curve lives in the drawer.
  // Two files apart is exactly how a published number and its meaning drift.
  const popAt = (tMs) => boardAt(counting(1), tMs).counters[0].scale;
  const swept = [];
  for (let tMs = 0; tMs <= SLATE.popMs; tMs += 1) swept.push(popAt(tMs));

  assert.equal(popAt(0), 0);
  assert.equal(popAt(SLATE.popMs), 1);
  assert.equal(popAt(SLATE.popMs * 4), 1);
  assert.equal(Math.round(Math.max(...swept) * 100) / 100, SLATE.overshoot);
});

test('a counter whose instant has not arrived yet is not drawn at a negative size', () => {
  // Unreachable through the fold, which never hands out a `sinceMs` ahead of
  // its own t — but the scale is a published field, and a client that trusts it
  // would draw a counter at a large negative size.
  assert.equal(boardAt({ ...counting(1), sinceMs: 1_000 }, 0).counters[0].scale, 0);
});

test('counting on from a smaller count leaves the counters already standing alone', () => {
  // Three were there and the fourth is arriving: the three do not pop again,
  // and the fourth starts at the board's own instant rather than fourth in a
  // queue that already ran.
  const board = boardAt(counting(4, 3), 0);

  assert.deepEqual(board.counters.map((counter) => counter.scale), [1, 1, 1, 0]);
  assert.equal(boardAt(counting(4, 3), SLATE.popMs).counters.at(-1).scale, 1);
});

test('a joining board colours its counters by the group they came from', () => {
  const board = boardAt(joining(2, 3), settled(5));

  assert.deepEqual(board.counters.map((counter) => counter.group), [0, 0, 1, 1, 1]);
  assert.deepEqual(board.groups, [2, 3]);
  assert.equal(board.count, 5);
  // A plain count has nothing to tell apart, so every counter is the one group.
  assert.deepEqual(boardAt(counting(3), settled(3)).counters.map((c) => c.group), [0, 0, 0]);
});

test('a take-away draws what it started with, then crosses out what was taken', () => {
  const board = (tMs) => boardAt(taking(5, 2), tMs);
  const drawn = board(settled(5));

  assert.equal(drawn.counters.length, 5, 'a subtraction draws its starting set');
  assert.equal(drawn.count, 3);
  assert.deepEqual(drawn.counters.map((counter) => counter.cross), [0, 0, 0, 0, 0]);

  // The two taken go one at a time, each crossed as it fades.
  const taken = board(settled(5) + SLATE.takeMs);
  assert.deepEqual(taken.counters.slice(0, 3).map((counter) => counter.alpha), [1, 1, 1]);
  assert.equal(taken.counters[3].cross, 1);
  assert.equal(taken.counters[3].alpha, 0);
  assert.ok(taken.counters[4].cross < 1, 'the second one is still going');

  const gone = board(settled(5) + SLATE.takeStaggerMs + SLATE.takeMs);
  assert.deepEqual(gone.counters.slice(3).map((counter) => counter.alpha), [0, 0]);
  // And the ring falls back to the newest counter still standing.
  assert.deepEqual(gone.counters.map((counter) => counter.ring), [false, false, true, false, false]);
});

test('the badge counts what is on the board right now, and is not there at nothing', () => {
  assert.equal(boardAt(counting(3), 0).badge, null, 'the first counter is still on its way');
  assert.equal(boardAt(counting(3), settled(3)).badge.n, 3);
  assert.equal(boardAt(joining(2, 3), settled(5)).badge.n, 5);
  // A take-away's badge counts DOWN as the counters go, which is the whole
  // cardinality cue: five, then four, then three. A counter is still there
  // until it is half gone, so the badge changes as the apple does.
  assert.equal(boardAt(taking(5, 2), settled(5) + SLATE.takeMs).badge.n, 4);
  const after = settled(5) + SLATE.takeStaggerMs + SLATE.takeMs;
  assert.equal(boardAt(taking(5, 2), after).badge.n, 3);
});

test('the badge sits in the panel own top corner, at the old board own offsets', () => {
  const { panel, badge } = boardAt(counting(3), settled(3));
  const size = (SLATE.badgePct / 100) * 1080;

  assert.equal(badge.size, size);
  assert.equal(badge.cx, Math.round(((panel.x + panel.w) - (size * SLATE.badgeOffset[0])) * 100) / 100);
  assert.equal(badge.cy, Math.round((panel.y + (size * SLATE.badgeOffset[1])) * 100) / 100);
});

test('the equation waits for the counters, then writes itself one token at a time', () => {
  const tokensAt = (tMs) => boardAt(joining(2, 3), tMs).equation;

  assert.equal(tokensAt(settled(5) - 1), null, 'the answer arrived before the question');
  const written = tokensAt(settled(5) + (5 * SLATE.tokenMs));
  assert.deepEqual(written.tokens.map((token) => token.text), ['2', '+', '3', '=', '5']);
  assert.deepEqual(
    written.tokens.map((token) => token.role),
    ['term', 'operator', 'term', 'equals', 'result'],
  );
  assert.deepEqual(written.tokens.map((token) => token.alpha), [1, 1, 1, 1, 1]);

  // One token in: the first is there, the rest are still arriving in order.
  const opening = tokensAt(settled(5) + SLATE.tokenMs);
  assert.equal(opening.tokens[0].alpha, 1);
  assert.deepEqual(opening.tokens.slice(2).map((token) => token.alpha), [0, 0, 0]);
  // It stands in the band below the counters, inside the panel.
  const { panel } = boardAt(joining(2, 3), settled(5));
  assert.ok(written.y > panel.y + (panel.h / 2));
  assert.ok(written.y + written.h <= panel.y + panel.h);
});

test('a take-away writes the take-away, and a plain count writes only its numeral', () => {
  const taken = boardAt(taking(5, 2), settled(5) + (2 * SLATE.takeMs) + (5 * SLATE.tokenMs));
  assert.deepEqual(taken.equation.tokens.map((token) => token.text), ['5', '-', '2', '3']
    .toSpliced(3, 0, '='));

  // "3 = 3" would be a sentence about numbers rather than the answer to "how
  // many?" — the count is one numeral, and it is written in the answer's colour.
  const counted = boardAt(counting(3), settled(3) + SLATE.tokenMs);
  assert.deepEqual(counted.equation.tokens, [{ text: '3', role: 'result', alpha: 1 }]);
});

test('the build own progress runs from nothing to one across the whole board', () => {
  const build = slateBuildMs(joining(2, 3));

  assert.equal(boardAt(joining(2, 3), 0).progress, 0);
  assert.equal(boardAt(joining(2, 3), build / 2).progress, 0.5);
  assert.equal(boardAt(joining(2, 3), build).progress, 1);
  assert.equal(boardAt(joining(2, 3), build * 3).progress, 1, 'it settles rather than running on');
  // The last thing to happen is the last token landing, which is what the
  // player asks about when it decides whether the picture is still moving.
  assert.ok(boardAt(joining(2, 3), build - (SLATE.tokenMs / 2)).equation.tokens.at(-1).alpha < 1);
  assert.equal(slateBuildMs({ count: 0, mode: 'count', groups: [] }), 0);
  // A take-away lasts longer than the join it undoes: its counters have to be
  // taken away before its equation may be written.
  assert.ok(slateBuildMs(taking(5, 2)) > build);
});

test('every board the fold accepts is a board the drawer draws', () => {
  // The drawer applies the same shared rule as the fold and answers `null` when
  // it refuses — and it has nowhere to SAY so: a draw list carries commands,
  // not warnings. That silence is only safe while the two cannot disagree, so
  // the agreement is pinned here rather than assumed: every board a timeline
  // can put on screen is swept against the drawer.
  const boards = [];
  for (let count = 1; count <= SLATE.max; count += 1) boards.push(counting(count));
  for (let left = 1; left < SLATE.max; left += 1) {
    for (let right = 1; left + right <= SLATE.max; right += 1) boards.push(joining(left, right));
    for (let right = 1; right < left; right += 1) boards.push(taking(left, right));
  }

  for (const slate of boards) {
    const state = stateAt(timelineOf(slate), SLATE_BUNDLE, 1_000 + slateBuildMs(slate));
    assert.deepEqual(state.warnings, [], JSON.stringify(slate));
    const [board] = only(buildDrawList({ ...actorState({}), slate: state.slate, tMs: state.tMs }), 'slate');
    assert.ok(board, `the fold accepted ${JSON.stringify(slate)} and the drawer drew nothing`);
    assert.equal(board.badge.n, board.mode === 'subtract' ? board.count : board.counters.length);
  }
});

// A one-scene timeline that raises exactly this board at 1,000 ms.
const SLATE_BUNDLE = {
  storylang_version: 0,
  title: 'boards',
  cast: {},
  objects: {},
  audio: { sfx: {}, bgm: {} },
  scenes: [{ line: 1, place: 'dell', plate: { resolution: [1920, 1080], zones: [] }, steps: [] }],
};
const timelineOf = ({ count, mode, groups }) => ({
  timeline_version: 1,
  storylang_version: 0,
  title: 'boards',
  duration_ms: 60_000,
  events: [
    {
      t_ms: 0, source: 'stage', op: 'scene', scene_index: 0, line: null, place: 'dell',
    },
    {
      t_ms: 1_000, source: 'stage', op: 'slate', scene_index: 0, line: null, count, mode, groups,
    },
  ],
});

test('the board is marked hud, and it is the last thing on the list', () => {
  const list = buildDrawList({
    ...actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right' }] }),
    slate: counting(1),
  }, oneSheet('sheet.webp', [1, 1]));

  assert.equal(list.commands.at(-1).op, 'slate');
  assert.equal(list.commands.at(-1).hud, true);
  // Nothing else claims to be outside the camera.
  assert.deepEqual(list.commands.filter((command) => command.hud).map((command) => command.op), ['slate']);
});

test('the board is measured against the plate, so a smaller stage gets a smaller board', () => {
  const big = boardAt(counting(1), settled(1));
  const small = boardAt(counting(1), settled(1), { resolution: [960, 540] });

  assert.equal(small.panel.w, big.panel.w / 2);
  assert.equal(small.panel.h, big.panel.h / 2);
  assert.equal(small.counters[0].r, big.counters[0].r / 2);
  assert.equal(small.badge.size, big.badge.size / 2);
});

test('a ring is drawn around its own actor, right after them', () => {
  const list = buildDrawList({
    ...actorState({
      actors: [
        { slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right', highlightMs: 0 },
        { slug: 'clover', x: 80, feetY: 90, heightPx: 200, clip: 'idle_right' },
      ],
    }),
    tMs: 300,
  }, oneSheet('sheet.webp', [1, 1]));
  const [ring] = only(list, 'ring');
  const sprite = list.commands.find((command) => command.op === 'sprite' && command.slug === 'ruby');

  assert.equal(list.commands.indexOf(ring), list.commands.indexOf(sprite) + 1);
  assert.equal(ring.slug, 'ruby');
  assert.equal(ring.cx, sprite.dx + (sprite.dw / 2));
  assert.equal(ring.cy, sprite.dy + (sprite.dh / 2));
  assert.equal(ring.rx, Math.round((sprite.dw / 2) * (1 + (HIGHLIGHT.ringPct / 100)) * 100) / 100);
  assert.ok(ring.rx > sprite.dw / 2, 'the ring is drawn outside the sprite it names');
});

test('a ring carries how far through its own life it is, and stops when that is over', () => {
  const ringAt = (tMs) => only(buildDrawList({
    ...actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right', highlightMs: 1_000 }] }),
    tMs,
  }, oneSheet('sheet.webp', [1, 1])), 'ring');

  assert.deepEqual(ringAt(900), [], 'nothing before it fires — a seek backward');
  assert.equal(ringAt(1_000)[0].progress, 0);
  assert.equal(ringAt(1_000 + (HIGHLIGHT.durationMs / 2))[0].progress, 0.5);
  assert.deepEqual(ringAt(1_000 + HIGHLIGHT.durationMs), []);
});

test('a ring carries its subject\'s opacity, the way the shadow under them does', () => {
  const list = buildDrawList({
    ...actorState({
      actors: [{
        slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right', highlightMs: 0, opacity: 0.4,
      }],
    }),
    tMs: 300,
  }, oneSheet('sheet.webp', [1, 1]));
  const [ring] = only(list, 'ring');

  assert.equal(ring.opacity, 0.4);
});

test('an actor nobody ever named carries no ring', () => {
  const list = buildDrawList(
    actorState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle_right' }] }),
    oneSheet('sheet.webp', [1, 1]),
  );

  assert.deepEqual(only(list, 'ring'), []);
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
 * The lesson's two overlays need instants of their own for the same reason the
 * camera did: they animate on the clock, and every instant this selector chose
 * before them lands a millisecond or two after the op that started one — which
 * pins a card at the very beginning of its pop and a ring nowhere at all. So the
 * board is also sampled halfway through its pop, and the ring at the first of
 * its two peaks.
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
  // Every board the story raises, sampled halfway through its own build —
  // which is a different instant for every shape, and the only one that catches
  // a board mid-arrival rather than settled.
  for (const board of stage.filter((event) => event.op === 'slate' && event.count > 0)) {
    chosen.add(board.t_ms + Math.round(slateBuildMs(board) / 2));
  }
  const ring = first('highlight');
  if (ring) chosen.add(ring.t_ms + Math.round(HIGHLIGHT.durationMs / 4));
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
  assert.deepEqual([...seen].sort(), ['prop', 'ring', 'shadow', 'slate', 'sprite']);
});
