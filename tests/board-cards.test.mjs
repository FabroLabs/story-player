import assert from 'node:assert/strict';
import test from 'node:test';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { resolveStoryAssets, appendStoryScene } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { sceneSheets, paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { createSceneLoader, sceneAssetPlan, planAssets, sceneKeepUrls } from '../browser/v0/app/assets/scene-loader.mjs';
import { createBitmapCache } from '../browser/v0/app/assets/bitmap-cache.mjs';
import { fakeContext } from './_dom.mjs';

const plate = { resolution: [1920, 1080], poster: 'assets/poster.svg', video: 'assets/plate.mp4', zones: [] };
const card = (cards = ['a', 'apple'], focus = null, prompt = '') => ({ kind: 'cmd', cmd: 'board', subjects: [], cards, focus, prompt, line: 2 });
const pause = (seconds) => ({ kind: 'cmd', cmd: 'pause', seconds, line: 3 });
const lesson = (steps = [card(), pause(5)]) => ({
  storylang_version: 0, title: 'Cards', cast: {},
  objects: Object.fromEntries(['a', 'apple', 'b', 'ball'].map((slug) => [slug, { svg: `assets/${slug}.svg`, height_cm: 30 }])),
  audio: { sfx: {}, bgm: {} }, scenes: [{ place: 'dell', plate, steps }],
});

test('board cards compile as a native slate and stand before the first spoken line', () => {
  const bundle = lesson([pause(1), card(['a', 'apple'], 2, 'apple'), pause(2)]);
  const timeline = compileTimeline(bundle);
  assert.equal(stateAt(timeline, bundle, 0).slate.standing, true);
  const event = timeline.events.find((row) => row.op === 'slate' && row.mode === 'cards');
  assert.deepEqual(event, { t_ms: 1000, source: 'stage', op: 'slate', scene_index: 0, line: 2, mode: 'cards', cards: ['a', 'apple'], focus: 2, prompt: 'apple' });
  assert.equal(timeline.duration_ms, 3000);
  assert.equal(timeline.events.filter((row) => row.kind === 'warning').length, 0);
});

test('focus and prompt changes preserve card arrival time, replacement resets it, and seeking restores the answer', () => {
  const bundle = lesson([card(), pause(1), card(['a', 'apple'], 2, 'apple'), pause(1), card(['b', 'ball']), pause(1)]);
  bundle.scenes.push({ place: 'dell', plate, steps: [pause(2)] });
  const timeline = compileTimeline(bundle);
  const cursor = createStateCursor(timeline, bundle);
  for (const instant of [4500, 500, 1500, 2500, 5000]) assert.deepEqual(cursor.at(instant), stateAt(timeline, bundle, instant));
  assert.deepEqual(stateAt(timeline, bundle, 1500).slate, { mode: 'cards', cards: ['a', 'apple'], focus: 2, prompt: 'apple', standing: true, sinceMs: 0 });
  const final = stateAt(timeline, bundle, 5000).slate;
  assert.deepEqual(final, { mode: 'cards', cards: ['b', 'ball'], focus: null, prompt: '', standing: true, sinceMs: 2000 });
  const mutated = stateAt(timeline, bundle, 1500); mutated.slate.cards.reverse();
  assert.deepEqual(stateAt(timeline, bundle, 1500).slate.cards, ['a', 'apple']);
});

for (const invalid of [card([]), card(['a', 'a']), card(['a', 'apple', 'b', 'ball', 'a']), card(['a'], 0), card(['a'], 2), card(['a'], 1.5), card(['a'], null, 'x'.repeat(65)), card(['absent']), card(['a'], null, null)]) {
  test(`invalid board is refused by compiler and mounting: ${JSON.stringify(invalid)}`, () => {
    const bundle = lesson([invalid, pause(1)]);
    const timeline = compileTimeline(bundle);
    assert.ok(timeline.events.some((row) => row.detail?.policy === 'board-cards-unusable'));
    assert.equal(timeline.events.some((row) => row.op === 'slate' && row.mode === 'cards'), false);
    assert.throws(() => resolveStoryAssets(bundle, 'http://localhost:8767/'), /board|card/i);
  });
}

test('card references are also checked in appended scenes and together blocks', () => {
  const bundle = lesson();
  const resolved = resolveStoryAssets(bundle, 'http://localhost:8767/');
  assert.throws(() => appendStoryScene(resolved, { place: 'dell', plate, steps: [{ kind: 'together', steps: [card(['missing'])] }] }, 'http://localhost:8767/'), /board|card/i);
  const timeline = compileTimeline(lesson([{ kind: 'together', line: 1, steps: [card(['a'], 1)] }, pause(1)]));
  assert.ok(timeline.events.some((row) => row.op === 'slate' && row.mode === 'cards'));
});

test('omitted focus and prompt clear the previous answer, and prompt limits count Unicode code points', () => {
  const reset = { kind: 'cmd', cmd: 'board', subjects: [], cards: ['a', 'apple'], line: 4 };
  const bundle = lesson([card(['a', 'apple'], 2, 'apple'), pause(1), reset, pause(1)]);
  const slate = stateAt(compileTimeline(bundle), bundle, 1500).slate;
  assert.equal(slate.focus, null);
  assert.equal(slate.prompt, '');
  assert.equal(slate.sinceMs, 0);
  const text = '\u{1F34E}'.repeat(64);
  assert.doesNotThrow(() => resolveStoryAssets(lesson([card(['a'], null, text)]), 'http://localhost:8767/'));
  assert.throws(() => resolveStoryAssets(lesson([card(['a'], null, text + 'a')]), 'http://localhost:8767/'), /board/i);
});

test('a forged card slate is refused by stateAt without replacing the valid board', () => {
  const bundle = lesson();
  const timeline = compileTimeline(bundle);
  timeline.events.splice(-1, 0, { source: 'stage', op: 'slate', mode: 'cards', cards: ['missing'], focus: null, prompt: '', t_ms: 1000, scene_index: 0, line: 4 });
  timeline.events.sort((left, right) => left.t_ms - right.t_ms);
  const state = stateAt(timeline, bundle, 2000);
  assert.deepEqual(state.slate.cards, ['a', 'apple']);
  assert.ok(state.warnings.some((row) => row.policy === 'board-cards-unusable'));
});

test('card artwork is planned and kept even when the board is inherited from another scene', () => {
  const bundle = lesson(); bundle.scenes.push({ place: 'dell', plate, steps: [pause(2)] });
  const timeline = compileTimeline(bundle);
  for (const index of [0, 1]) {
    const plan = sceneAssetPlan(timeline, bundle, index);
    assert.deepEqual(plan.boardCards.map(({ slug }) => slug), ['a', 'apple']);
    assert.equal(planAssets(plan).filter(({ asset }) => asset === 'board-card').length, 2);
    assert.ok(sceneKeepUrls(plan, []).includes('assets/apple.svg'));
  }
});

test('native draw list carries the board images, focused slot and readable prompt', () => {
  const bundle = lesson([card(['a', 'apple'], 2, 'apple'), pause(3)]);
  const timeline = compileTimeline(bundle);
  const plan = sceneAssetPlan(timeline, bundle, 0);
  const drawable = { width: 320, height: 256 };
  const list = buildDrawList(stateAt(timeline, bundle, 1000), sceneSheets(plan, { get: () => drawable }));
  const board = list.commands.find(({ op }) => op === 'slate');
  assert.equal(board.mode, 'cards');
  assert.deepEqual(board.cards.map(({ slug, focused }) => [slug, focused]), [['a', false], ['apple', true]]);
  assert.equal(board.prompt.text, 'apple');
  assert.ok(board.prompt.cy + board.prompt.size / 2 < Math.min(...board.cards.map(({ dy }) => dy)), 'prompt belongs above the picture cards');
  for (const image of board.cards) {
    assert.ok(image.dx >= board.panel.x && image.dy >= board.panel.y);
    assert.ok(image.dx + image.dw <= board.panel.x + board.panel.w);
    assert.ok(image.dy + image.dh <= board.panel.y + board.panel.h);
    assert.ok(image.dy + image.dh <= list.height * 0.74, 'the native subtitle and transport band stays clear');
  }
  const context = fakeContext();
  paintDrawList(context, list, { lookup: () => drawable });
  assert.equal(context.of('drawImage').length, 2);
  assert.ok(context.of('fillText').some((row) => row[0] === 'apple'));
});

test('a required card decode failure rejects the scene gate and names the missing card', async (t) => {
  const bundle = lesson(); const timeline = compileTimeline(bundle);
  const warnings = [];
  const cache = createBitmapCache({ decode: async (url) => { if (url.endsWith('apple.svg')) throw new Error('broken image'); return { width: 16, height: 16 }; } });
  t.after(() => cache.destroy());
  const loader = createSceneLoader({ timeline, bundle, cache, onWarning: (warning) => warnings.push(warning) });
  await assert.rejects(loader.loadScene(0, {}, { keep: true }), /apple|board/i);
  assert.ok(warnings.some(({ asset, slug }) => asset === 'board-card' && slug === 'apple'));
});


test('invalid cards inside narration cues are rejected on mount and append', () => {
  const steps = [{ kind: 'chunk', text: 'Look here.', audio: 'assets/voice.mp3', duration_seconds: 1,
    cues: [{ at: 0.08, step: card(['missing']) }] }, pause(1)];
  assert.throws(() => resolveStoryAssets(lesson(steps), 'http://localhost:8767/'), /board|card/i);
  const resolved = resolveStoryAssets(lesson(), 'http://localhost:8767/');
  assert.throws(() => appendStoryScene(resolved, { place: 'dell', plate, steps }, 'http://localhost:8767/'), /board|card/i);
});
