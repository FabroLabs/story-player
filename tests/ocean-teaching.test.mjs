import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { normaliseCardBoard } from '../browser/v0/core/card-board.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { createCanvasStage, paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { sceneAssetPlan, planAssets } from '../browser/v0/app/assets/scene-loader.mjs';
import { signatureOf } from '../browser/v0/app/timeline-player.mjs';
import { fakeContext, fakeStageElements } from './_dom.mjs';
const oceanAsset = (slug) => new URL(`./fixtures/ocean/${slug}.svg`, import.meta.url);

const plate = { resolution: [1920, 1080], poster: 'assets/reef.svg', video: 'assets/reef.mp4', zones: [] };
const cards = (phase, number, index) => [`ocean_${phase}_${number}${index ? `_${index}` : ''}`, 'ocean_fish', `ocean_number_${number}`];
const board = (items, focus = null, prompt = 'Count with me') => ({ kind: 'cmd', cmd: 'board', cards: items, focus, prompt, subjects: [], line: 2 });
const pause = (seconds) => ({ kind: 'cmd', cmd: 'pause', seconds, line: 3 });
const bundleOf = (steps) => ({ storylang_version: 0, title: 'Ocean phases', cast: {}, audio: { sfx: {}, bgm: {} },
  objects: Object.fromEntries(steps.flatMap((step) => step.cards ?? []).map((slug) => [slug, { svg: `assets/${slug}.svg`, height_cm: 30 }])),
  scenes: [{ place: 'reef', plate, steps }],
});
const sheets = { prop: (slug) => ({ url: `assets/${slug}.svg` }), sheet: () => null };
const draw = (slate, elapsed = 0, resolution = [1920, 1080]) => buildDrawList({ plate: { resolution }, actors: [], tMs: elapsed,
  slate: { mode: 'cards', cards: slate, focus: null, prompt: 'Count with me', standing: true, sinceMs: 0 } }, sheets).commands[0];
const geometry = (fish) => fish.map(({ n, targetX, targetY, dw, dh }) => ({ n, targetX, targetY, dw, dh }));

test('arrival visibly adds only the next fish and reserves numeral space without revealing it', () => {
  for (const resolution of [[1920, 1080], [390, 219]]) for (let number = 1; number <= 10; number += 1) {
    const start = draw(cards('arrive', number), 0, resolution);
    const middle = draw(cards('arrive', number), 500, resolution);
    const settled = draw(cards('arrive', number), 1000, resolution);
    assert.equal(start.ocean?.phase, 'arrive');
    assert.equal(start.fish.length, number);
    assert.equal(start.fish.filter((fish) => fish.opacity > 0).length, number - 1);
    assert.ok(middle.fish.at(-1).opacity > 0 && middle.fish.at(-1).opacity < 1);
    assert.notEqual(middle.fish.at(-1).dx, settled.fish.at(-1).dx);
    assert.deepEqual(start.fish.slice(0, -1), settled.fish.slice(0, -1));
    assert.ok(settled.fish.every((fish) => fish.opacity === 1 && fish.dx === fish.targetX && fish.dy === fish.targetY));
    assert.equal(settled.numeral.opacity, 0);
    if (number > 1) assert.deepEqual(geometry(draw(cards('arrive', number - 1), 1000, resolution).fish), geometry(start.fish.slice(0, -1)));
    for (const fish of settled.fish) {
      assert.ok(fish.dx >= settled.fishArea.dx && fish.dy >= settled.fishArea.dy);
      assert.ok(fish.dx + fish.dw <= settled.fishArea.dx + settled.fishArea.dw + 0.02);
      assert.ok(fish.dy + fish.dh <= settled.fishArea.dy + settled.fishArea.dh + 0.02);
    }
  }
});

test('recount keeps the complete group and highlights one fish at a time; reveal alone shows numeral', () => {
  for (let number = 1; number <= 10; number += 1) {
    const full = draw(cards('hold', number), 5000);
    assert.equal(full.ocean?.phase, 'hold');
    assert.equal(full.numeral.opacity, 0);
    for (let index = 1; index <= number; index += 1) {
      const recount = draw(cards('recount', number, index), 5000);
      assert.equal(recount.fish.length, number);
      assert.deepEqual(geometry(recount.fish), geometry(full.fish));
      assert.ok(recount.fish.every((fish) => fish.opacity === 1));
      assert.deepEqual(recount.fish.filter((fish) => fish.highlight).map((fish) => fish.n), [index]);
      assert.equal(recount.numeral.opacity, 0);
    }
    const revealing = draw(cards('reveal', number), 350);
    const revealed = draw(cards('reveal', number), 700);
    assert.ok(revealing.numeral.opacity > 0 && revealing.numeral.opacity < 1);
    assert.equal(revealed.numeral.opacity, 1);
    assert.deepEqual(geometry(revealed.fish), geometry(full.fish));
    assert.deepEqual(revealed.numeral.box, full.numeral.box);
  }
});

test('the phase clock follows story time and survives reverse seeks and narration-only holds', () => {
  const items = [board(cards('arrive', 1)), pause(2), board(cards('reveal', 1)), pause(1),
    board(cards('reveal', 1), null, 'Your turn'), pause(4), board(cards('arrive', 2)), pause(2),
    board(cards('recount', 2, 1)), pause(2), board(cards('recount', 2, 2)), pause(2), board(cards('hold', 2)), pause(2)];
  const bundle = bundleOf(items);
  const timeline = compileTimeline(bundle);
  assert.equal(timeline.events.filter((row) => row.kind === 'warning').length, 0);
  const cursor = createStateCursor(timeline, bundle);
  for (const instant of [0, 500, 1000, 2350, 6000, 7500, 8000, 9500, 11500, 14000, 500, 2350, 0]) {
    const state = stateAt(timeline, bundle, instant);
    assert.deepEqual(cursor.at(instant), state);
    assert.deepEqual(buildDrawList(cursor.at(instant), sheets), buildDrawList(state, sheets));
  }
  const held = stateAt(timeline, bundle, 6000);
  assert.equal(held.slate.sinceMs, 2000, 'same reveal marker must not replay its fade on a response prompt');
  assert.equal(buildDrawList(held, sheets).commands[0].numeral?.opacity, 1);
});

test('the real repaint signature advances throughout each phase and settles when its animation ends', () => {
  for (const [phase, span, index] of [['arrive', 1000], ['reveal', 700], ['recount', 350, 2]]) {
    const state = (tMs) => ({ sceneIndex: 0, tMs, actors: [], slate: { mode: 'cards', standing: true,
      cards: cards(phase, 3, index), focus: null, prompt: '', sinceMs: 100 } });
    const start = signatureOf(state(100));
    const middle = signatureOf(state(100 + span / 2));
    const end = signatureOf(state(100 + span));
    assert.notEqual(start, middle, 'an otherwise still scene must repaint during the phase');
    assert.notEqual(middle, end, 'the final settled frame must be painted');
    assert.equal(end, signatureOf(state(100 + span + 5000)), 'settled phases stop requesting repaint');
  }
});

test('quiz recount preserves three existing card positions and highlights inside only the focused group', () => {
  const groups = ['ocean_group_2', 'ocean_group_3', 'ocean_group_1'];
  const state = (items) => ({ plate, actors: [], tMs: 500, slate: { mode: 'cards', cards: items, focus: 2,
    prompt: 'Count this group', standing: true, sinceMs: 0 } });
  const before = buildDrawList(state(groups), sheets).commands[0];
  for (let index = 1; index <= 3; index += 1) {
    const after = buildDrawList(state([...groups, `ocean_quiz_count_${index}`]), sheets).commands[0];
    assert.deepEqual(after.cards, before.cards);
    assert.deepEqual(after.prompt, before.prompt);
    const ring = after.quizHighlight;
    assert.equal(ring?.n, index);
    assert.equal(ring.cardIndex, 1);
    const target = before.cards[1];
    assert.ok(ring.cx > target.dx && ring.cx < target.dx + target.dw);
    assert.ok(ring.cy > target.dy && ring.cy < target.dy + target.dh);
  }
});

test('small quizzes enlarge fish and place every ring on the actual SVG artwork without moving cards', () => {
  const quantities = [2, 3, 1];
  const groups = quantities.map((n) => `ocean_small_group_${n}`);
  const oldGroups = quantities.map((n) => `ocean_group_${n}`);
  const attribute = (tag, name) => Number(new RegExp(`\\b${name}="([^"]+)"`).exec(tag)?.[1]);
  for (const resolution of [[1920, 1080], [738, 415], [390, 219]]) {
    const frame = (items, focus) => buildDrawList({ plate: { resolution }, actors: [], tMs: 500,
      slate: { mode: 'cards', cards: items, focus, prompt: 'Count this group', standing: true, sinceMs: 0 } }, sheets);
    for (let focus = 1; focus <= 3; focus += 1) {
      const plain = frame(groups, focus).commands[0];
      for (let index = 1; index <= quantities[focus - 1]; index += 1) {
        const list = frame([...groups, `ocean_quiz_count_${index}`], focus);
        const board = list.commands[0];
        assert.ok(board?.quizHighlight, 'small quiz markers must produce an individual fish ring');
        assert.deepEqual(board.cards, plain.cards);
        assert.deepEqual(board.prompt, plain.prompt);
        const context = fakeContext();
        const artwork = { width: 788, height: 272 };
        paintDrawList(context, list, { lookup: () => artwork });
        const [, dx, dy, dw, dh] = context.of('drawImage')[focus - 1];
        const svg = fs.readFileSync(oceanAsset(groups[focus - 1]), 'utf8');
        assert.match(svg, /viewBox="0 0 788 272"/);
        const use = [...svg.matchAll(/<use\b[^>]+>/g)][index - 1]?.[0];
        const image = /<image\b[^>]+id="fish-art"[^>]+>/.exec(svg)?.[0];
        assert.ok(use && image, 'the selected fish must exist in the SVG');
        const x = attribute(use, 'x'), y = attribute(use, 'y');
        const w = attribute(image, 'width'), h = attribute(image, 'height');
        assert.ok([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0);
        assert.ok(Math.abs(board.quizHighlight.cx - (dx + (x + w / 2) * dw / 788)) < 0.001);
        assert.ok(Math.abs(board.quizHighlight.cy - (dy + (y + h / 2) * dh / 272)) < 0.001);
        const oldContext = fakeContext();
        paintDrawList(oldContext, frame(oldGroups, focus), { lookup: () => ({ width: 1304, height: 530 }) });
        const oldWidth = oldContext.of('drawImage')[focus - 1][3];
        assert.ok((dw * w / 788) / (oldWidth * w / 1304) >= 1.6, 'small quiz fish must be at least 60% larger');
      }
    }
  }
});

test('quiz markers reject mixed group families and small-group quantities outside one through three', () => {
  for (const groups of [
    ['ocean_small_group_2', 'ocean_group_3', 'ocean_small_group_1'],
    ['ocean_group_2', 'ocean_small_group_3', 'ocean_group_1'],
    ['ocean_small_group_2', 'ocean_small_group_4', 'ocean_small_group_1'],
  ]) assert.equal(normaliseCardBoard({ cards: [...groups, 'ocean_quiz_count_1'], focus: 2 }), null);
});

test('invalid reserved phase markers are refused instead of drawing misleading cards', () => {
  for (const items of [cards('arrive', 11), cards('recount', 3, 4), ['ocean_arrive_3', 'ocean_fish', 'ocean_number_4'],
    ['ocean_hold_3'], ['ocean_group_2', 'ocean_group_3', 'ocean_group_1', 'ocean_quiz_count_4']]) {
    assert.equal(normaliseCardBoard({ cards: items, focus: items.length === 4 ? 2 : null }), null);
    const timeline = compileTimeline(bundleOf([board(items, items.length === 4 ? 2 : null), pause(2)]));
    assert.ok(timeline.events.some((row) => row.detail?.policy === 'board-cards-unusable'));
  }
});

test('required fish and numeral artwork is preloaded; hidden numerals are not painted', () => {
  const bundle = bundleOf([board(cards('arrive', 3)), pause(2), board(cards('reveal', 3)), pause(2)]);
  const timeline = compileTimeline(bundle);
  const assets = planAssets(sceneAssetPlan(timeline, bundle, 0));
  for (const slug of ['ocean_fish', 'ocean_number_3']) assert.ok(assets.some((asset) => asset.slug === slug && asset.required));
  const fish = { width: 1254, height: 1254, name: 'fish' };
  const numeral = { width: 240, height: 240, name: 'numeral' };
  for (const [instant, numeralCount] of [[1000, 0], [2350, 1], [2700, 1]]) {
    const list = buildDrawList(stateAt(timeline, bundle, instant), sheets);
    const context = fakeContext();
    paintDrawList(context, list, { lookup: (url) => url.endsWith('ocean_fish.svg') ? fish : numeral });
    assert.equal(context.of('drawImage').filter(([image]) => image === fish).length, 3);
    assert.equal(context.of('drawImage').filter(([image]) => image === numeral).length, numeralCount);
  }
});

test('actual short canvas stages keep every teaching phase above two-line bare subtitles', () => {
  for (const [width, height] of [[320, 180], [340, 191], [390, 219]]) {
    const elements = fakeStageElements();
    elements.frame.getBoundingClientRect = () => ({ width, height });
    const stage = createCanvasStage(elements);
    const scale = Math.min(width / 1920, height / 1080);
    const captionTop = 1080 * scale - (15.2 * (2 * 1.55 + 2 * 0.34) + 25.6);
    let targets;
    for (const [phase, index, elapsed] of [['arrive', null, 0], ['arrive', null, 500], ['arrive', null, 1000],
      ['recount', 10, 500], ['hold', null, 500], ['reveal', null, 350], ['reveal', null, 700]]) {
      const state = { plate, actors: [], tMs: elapsed, slate: { mode: 'cards', cards: cards(phase, 10, index),
        focus: null, prompt: 'Our fish friends', standing: true, sinceMs: 0 } };
      const board = stage.draw(state, sheets).commands[0];
      assert.ok(board.fish.every((fish) => (fish.dy + fish.dh) * scale <= captionTop - 8), 'fish must clear the native two-line caption by eight CSS pixels');
      assert.ok((board.numeral.box.dy + board.numeral.box.dh) * scale <= captionTop - 8);
      assert.ok(board.prompt.cy + board.prompt.size / 2 < board.fishArea.dy);
      if (targets) assert.deepEqual(geometry(board.fish), targets, 'phase changes must not resize or move fish targets');
      targets = geometry(board.fish);
    }
    const ordinary = { plate, actors: [], tMs: 1000, slate: { mode: 'cards', cards: ['alphabet_a', 'alphabet_b'], focus: null, prompt: '', sinceMs: 0 } };
    assert.deepEqual(stage.draw(ordinary, sheets), buildDrawList(ordinary, sheets), 'ordinary boards ignore the short-stage adjustment');
    stage.destroy();
  }
});

test('a paused canvas immediately rebuilds teaching layout on phone to desktop and reverse resize', () => {
  const previousObserver = globalThis.ResizeObserver;
  let onResize;
  globalThis.ResizeObserver = class { constructor(callback) { onResize = callback; } observe() {} disconnect() {} };
  const elements = fakeStageElements();
  let view = { width: 340, height: 191 };
  elements.frame.getBoundingClientRect = () => view;
  const fish = { width: 1254, height: 1254 }, numeral = { width: 512, height: 512 };
  const lookup = (url) => url.endsWith('ocean_fish.svg') ? fish : numeral;
  const decoded = { ...sheets, drawable: lookup };
  const state = { plate, actors: [], tMs: 350, slate: { mode: 'cards', cards: cards('reveal', 10),
    focus: null, prompt: 'Our fish friends', standing: true, sinceMs: 0 } };
  const stage = createCanvasStage(elements, { dprCap: 1 });
  try {
    const phone = stage.draw(state, decoded);
    for (const size of [{ width: 960, height: 540 }, { width: 340, height: 191 }]) {
      view = size;
      elements.canvas.context.calls.length = 0;
      onResize();
      const expected = size.height > 260 ? buildDrawList(state, decoded) : phone;
      const context = fakeContext();
      paintDrawList(context, expected, { lookup, scale: Math.min(size.width / 1920, size.height / 1080) });
      assert.deepEqual(elements.canvas.context.of('drawImage'), context.of('drawImage'), 'resize must paint the new layout immediately at unchanged story time');
      assert.equal(elements.canvas.context.of('drawImage').at(-1).at(-1).alpha, 0.5, 'resize must retain reveal progress');
    }
  } finally {
    stage.destroy();
    if (previousObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousObserver;
  }
});
