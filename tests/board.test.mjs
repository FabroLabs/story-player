import assert from 'node:assert/strict';
import test from 'node:test';

import { PlayerBoard } from '../browser/v0/core/board.mjs';

test('puts characters in the active scene and moves them to exact zone x coordinates', () => {
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['ruby'], 'left_third', 'right');
  board.move(['ruby'], 'right_edge');

  assert.deepEqual(board.positionOf('ruby'), { x: 90, place: 'dell', facing: 'right', zone: null });
  assert.deepEqual(board.visibleCharacters(), [{ slug: 'ruby', x: 90, place: 'dell', facing: 'right', zone: null }]);
});

test('moves to the exact named character x coordinate', () => {
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['ruby'], 'left_third', 'right');
  board.put(['owl'], 'right_third', 'left');
  board.move(['ruby'], 'owl');

  assert.deepEqual(board.positionOf('ruby'), { x: 70, place: 'dell', facing: 'right', zone: null });
});

test('updates travel place immediately and stages arrivals in subject order on destination scene entry', () => {
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['ruby', 'owl', 'bear'], 'center', 'camera');
  board.travel(['ruby', 'owl', 'bear'], 'grove', [90, 80]);

  assert.deepEqual(board.visibleCharacters(), []);
  assert.equal(board.snapshot().characters.ruby.departure.to, 'grove');

  board.beginScene('grove');
  assert.deepEqual(board.visibleCharacters().map(({ slug, x }) => [slug, x]), [
    ['ruby', 30], ['owl', 50], ['bear', 70],
  ]);
});

test('shows already-placed characters whenever their scene opens', () => {
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['ruby'], 'center', 'camera', 'grove');

  board.beginScene('grove');
  assert.deepEqual(board.visibleCharacters(), [{ slug: 'ruby', x: 50, place: 'grove', facing: 'camera', zone: null }]);
});

test('an arrival forgets the band it stood in somewhere else', () => {
  // Zone names belong to a PLATE, not to the world: `background_road` exists at
  // forest_path and nowhere near forest_pond. Carrying the name across a travel
  // resolved to no zone at all on the new plate — scale 1, the no-floor stand
  // line, no crowding — instead of the destination's default band (D6).
  const board = new PlayerBoard();
  board.beginScene('path');
  board.put(['ruby'], 'center', 'camera', 'path', undefined, 'background_road');
  assert.equal(board.positionOf('ruby').zone, 'background_road');

  board.travel(['ruby'], 'pond');
  board.beginScene('pond');

  assert.equal(
    board.positionOf('ruby').zone, null,
    'the arrival kept a band name from the place it left',
  );
});

test('spreads zones and arrivals across a floor that does not span the plate', () => {
  const board = new PlayerBoard();
  const narrow = { min: 20, max: 80 }; // a 60-wide floor inset from both edges

  board.beginScene('dell', narrow);
  board.put(['ruby', 'owl'], 'left_edge', 'right');
  assert.equal(board.positionOf('ruby').x, 26); // 20 + 0.1 * 60, not 10

  board.move(['ruby'], 'right_edge');
  assert.equal(board.positionOf('ruby').x, 74); // 20 + 0.9 * 60, not 90

  board.travel(['ruby', 'owl'], 'grove', [90, 80]);
  board.beginScene('grove', { min: 0, max: 50 });
  assert.deepEqual(board.visibleCharacters().map(({ slug, x }) => [slug, x]), [
    ['ruby', 15], ['owl', 35], // the 2-arrival preset, 0.3/0.7 of a 50-wide floor
  ]);
});

test('reads every arrival preset along the floor, whatever the group size', () => {
  // A 50-wide floor inset from x=20, so a preset that ignored the span would
  // show up as the raw percentage instead of 20 + fraction * 50.
  const narrow = { min: 20, max: 70 };
  const slots = (count) => {
    const board = new PlayerBoard();
    const cast = Array.from({ length: count }, (_, index) => `c${index}`);
    board.beginScene('dell', narrow);
    board.put(cast, 'center', 'camera');
    board.travel(cast, 'grove', [90, 80]);
    board.beginScene('grove', narrow);
    return board.visibleCharacters().map(({ x }) => Math.round(x * 100) / 100);
  };

  assert.deepEqual(slots(1), [45]);                       // 0.5
  assert.deepEqual(slots(2), [35, 55]);                   // 0.3 0.7
  assert.deepEqual(slots(3), [35, 45, 55]);               // 0.3 0.5 0.7
  assert.deepEqual(slots(4), [25, 35, 55, 65]);           // 0.1 0.3 0.7 0.9
  assert.deepEqual(slots(5), [25, 35, 45, 55, 65]);       // 0.1 0.3 0.5 0.7 0.9
  assert.deepEqual(slots(6), [25, 33, 41, 49, 57, 65]);   // evenly, 0.1 .. 0.9
});

test('places a healed put against its own place\'s floor, not the open scene\'s', () => {
  const board = new PlayerBoard();

  board.beginScene('dell', { min: 20, max: 80 });
  board.put(['ruby'], 'center', 'camera', 'grove', { min: 0, max: 80 });

  board.beginScene('grove', { min: 0, max: 80 });
  assert.equal(board.positionOf('ruby').x, 40); // grove's centre, not the dell's 50

  // A floor whose centre is NOT the plate's, so the two answers are telling apart.
  board.beginScene('dell', { min: 20, max: 60 });

  // Naming a foreign place without its floor means the whole plate — never the
  // open scene's floor, which belongs somewhere else entirely.
  board.put(['clover'], 'center', 'camera', 'grove');
  assert.equal(board.positionOf('clover').x, 50); // the plate, not the dell's 40

  // The open scene still uses its own floor when no span is passed.
  board.put(['bramble'], 'center', 'camera');
  assert.equal(board.positionOf('bramble').x, 40); // 20 + 0.5 * 40
});

test('put naming a cast member stands beside them, not at NaN', () => {
  // `where` may be a cast member — the spec says so and the manual teaches it —
  // but only `move` resolved it. `sideX('fox')` returns undefined, so the x was
  // undefined: `left: NaNpx` (which CSS drops, rendering the sprite off-frame),
  // a whole band spread to NaN by crowding, and a phone timeline whose `place`
  // op carries no `x` key at all. Silent at every layer.
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['fox'], 'right_edge', 'camera');
  board.put(['rabbit'], 'fox', 'camera');

  assert.equal(board.positionOf('rabbit').x, board.positionOf('fox').x);
  assert.equal(typeof board.positionOf('rabbit').x, 'number');
});

test('put naming a cast member who is not on stage yet falls back to centre', () => {
  // The validator permits the forward reference on purpose — the next line may
  // be the one that places them — so the engine still owes an answer.
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['rabbit'], 'fox', 'camera');

  assert.equal(board.positionOf('rabbit').x, 50);
});

test('put naming a cast member joins their band', () => {
  const board = new PlayerBoard();
  board.beginScene('dell');
  board.put(['fox'], 'center', 'camera', 'dell', undefined, 'back');
  board.put(['rabbit'], 'fox', 'camera', 'dell', undefined, 'front');

  assert.equal(
    board.positionOf('rabbit').zone, 'back',
    'standing beside somebody means standing at their distance',
  );
});
