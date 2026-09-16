import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanvasStage } from '../browser/v0/app/stage/canvas-stage.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { sceneHasFarmBoard } from '../browser/v0/core/farm-board.mjs';
import { fakeElement, fakeStageElements } from './_dom.mjs';

const state = { plate: { resolution: [1920, 1080] }, tMs: 600, actors: [
  { slug: 'farm_horse', kind: 'object', x: 53, feetY: 84, heightPx: 350, opacity: 1 },
], slate: { mode: 'cards', cards: ['farm_cow', 'farm_board_lift'], prompt: 'Cow', sinceMs: 0, standing: true } };
const sheets = { prop: (slug) => ({ url: 'assets/'+slug+'.svg' }), sheet: () => null, drawable: () => ({ width: 512, height: 512 }) };

test('only valid explicit Farm commands identify a Farm scene', () => {
  assert.equal(sceneHasFarmBoard({ steps: [{ cmd: 'board', cards: ['farm_cow', 'farm_board_lift'] }] }), true);
  for (const scene of [null, { steps: [{ cmd: 'board', cards: ['a', 'b'] }] },
    { steps: [{ cmd: 'board', cards: ['farm_board_lift'] }] },
    { steps: [{ cmd: 'say', text: 'farm_board_lift', cards: ['farm_cow', 'farm_board_lift'] }] }]) {
    assert.equal(sceneHasFarmBoard(scene), false);
  }
});

test('Farm uses the whole standard viewport without appending a caption strip', () => {
  const elements = fakeStageElements(), host = fakeElement();
  elements.frame.getRootNode = () => ({ host });
  let viewport = { width: 340, height: 191.25 };
  elements.frame.getBoundingClientRect = () => viewport;
  const stage = createCanvasStage(elements, { dprCap: 1 });
  try {
    stage.setFarmOverlay(true);
    for (const width of [340, 390, 738, 1920]) {
      viewport = { width, height: width * 9 / 16 };
      const frame = stage.draw(state, sheets);
      assert.deepEqual(frame, buildDrawList(state, sheets, viewport));
      assert.equal(Number(elements.stage.style['--fit-scale']), width / 1920);
      assert.equal(host.getAttribute('data-farm-captions'), null);
      assert.equal(elements.frame.classList.contains('has-farm-captions'), false);
      assert.equal(frame.commands.find((row) => row.op === 'slate').farm.dy, -540);
    }
  } finally { stage.destroy(); }
});

test('paused Farm resize keeps the native viewport fit and the same animation instant', () => {
  const originalObserver = globalThis.ResizeObserver;
  let resized;
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe() {} disconnect() {} };
  const elements = fakeStageElements();
  let viewport = { width: 340, height: 191.25 };
  elements.frame.getBoundingClientRect = () => viewport;
  const stage = createCanvasStage(elements, { dprCap: 1 });
  try {
    stage.setFarmOverlay(true);
    stage.draw(state, sheets);
    for (const box of [{ width: 738, height: 415.125 }, { width: 340, height: 150 }]) {
      viewport = box;
      resized();
      assert.equal(Number(elements.stage.style['--fit-scale']), Math.min(box.width / 1920, box.height / 1080));
      assert.equal(stage.draw(state, sheets).commands.find((row) => row.op === 'slate').farm.dy, -540);
    }
  } finally { stage.destroy(); globalThis.ResizeObserver = originalObserver; }
});

test('Farm lower and plain boards retain native overlay-caption clearance', () => {
  const viewport = { width: 340, height: 191.25, farmCaptions: true };
  const lower = { ...state, slate: { ...state.slate, cards: ['farm_cow', 'farm_board_lower'] } };
  const plain = { ...state, slate: { ...state.slate, cards: ['farm_cow'] } };
  const slate = (value, box) => buildDrawList(value, sheets, box).commands.find((row) => row.op === 'slate');
  const normal = slate(plain, { width: 340, height: 191.25 });
  assert.deepEqual(slate(lower, viewport).cards, normal.cards);
  assert.deepEqual(slate(plain, viewport).cards, normal.cards);
  assert.ok(normal.cards.every((card) => card.dy + card.dh < 1080 * 0.78));
});
