import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseCardBoard } from '../browser/v0/core/card-board.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { sceneAssetPlan, planAssets } from '../browser/v0/app/assets/scene-loader.mjs';
import { signatureOf } from '../browser/v0/app/timeline-player.mjs';
import { fakeContext } from './_dom.mjs';

const plate = { resolution: [1920, 1080], poster: 'assets/reef.svg', video: 'assets/reef.mp4', zones: [] };
const sheets = { prop: (slug) => ({ url: `assets/${slug}.svg` }), sheet: () => null };
const school = (phase, n, index) => [`ocean_school_${phase}_${n}${index ? `_${index}` : ''}`, 'ocean_fish', `ocean_number_${n}`];
const slate = (cards, tMs = 5000, focus = null) => ({ plate, actors: [], tMs,
  slate: { mode: 'cards', cards, focus, prompt: 'Our fish friends', sinceMs: 0, standing: true } });
const draw = (cards, tMs, view, focus) => buildDrawList(slate(cards, tMs, focus), sheets, view).commands[0];
const geometry = (fish) => fish.map(({ n, targetX, targetY, dw, dh }) => ({ n, targetX, targetY, dw, dh }));
const command = (cards, focus = null) => ({ kind: 'cmd', cmd: 'board', cards, focus, prompt: 'Our fish friends', subjects: [], line: 2 });
const pause = (seconds) => ({ kind: 'cmd', cmd: 'pause', seconds, line: 3 });
const bundleOf = (steps) => ({ storylang_version: 0, title: 'Ocean flow', cast: {}, audio: { bgm: {}, sfx: {} },
  objects: Object.fromEntries(steps.flatMap((s) => s.cards ?? []).map((slug) => [slug, { svg: `assets/${slug}.svg`, height_cm: 30 }])),
  scenes: [{ place: 'reef', plate, steps }] });

test('school fish fill a fixed gentle arc with stable count order and caption clearance', () => {
  for (const view of [{ width: 1920, height: 1080 }, { width: 340, height: 191 }, { width: 390, height: 219 }]) {
    let previous = [];
    for (let n = 1; n <= 5; n += 1) {
      const settled = draw(school('hold', n), 5000, view);
      assert.equal(settled?.ocean?.school, true, 'school markers must use the arc renderer');
      assert.deepEqual(geometry(settled.fish).slice(0, previous.length), previous);
      previous = geometry(settled.fish);
      const { dx, dy, dw, dh } = settled.fishArea;
      const side = 0.9 * Math.min(dw / 5, dh);
      for (const [i, fish] of settled.fish.entries()) {
        assert.ok(Math.abs(fish.targetX + fish.dw / 2 - (dx + (i + 0.5) * dw / 5)) < 0.001);
        assert.ok(Math.abs(fish.targetY + fish.dh / 2 - (dy + side / 2 + [0.72, 0.35, 0.22, 0.35, 0.72][i] * (dh - side))) < 0.001);
      }
      const phases = [['arrive', null, 0], ['arrive', null, 500], ['arrive', null, 1000],
        ...Array.from({ length: n }, (_, i) => ['recount', i + 1, 175]), ['hold', null, 5000], ['reveal', null, 0], ['reveal', null, 350], ['reveal', null, 700]];
      for (const [phase, index, instant] of phases) {
        const frame = draw(school(phase, n, index), instant, view);
        assert.deepEqual(geometry(frame.fish), previous);
        assert.deepEqual(frame.fish.slice(0, n - 1).map(({ dx, dy }) => [dx, dy]), settled.fish.slice(0, n - 1).map(({ dx, dy }) => [dx, dy]));
        if (view.height < 260) {
          const scale = Math.min(view.width / 1920, view.height / 1080);
          assert.ok(frame.fish.every((fish) => (fish.dy + fish.dh) * scale < 1080 * scale - 84 - 8));
        }
      }
    }
  }
});

test('school empty reserves the same area with no fish or zero label; school quantities stop at five', () => {
  const empty = draw(['ocean_school_empty', 'ocean_fish'], 5000);
  assert.equal(empty?.ocean?.quantity, 0);
  assert.deepEqual(empty.fish, []);
  assert.equal(empty.numeral.opacity, 0);
  assert.equal(empty.numeral.url, null);
  assert.deepEqual(empty.fishArea, draw(school('hold', 1), 5000).fishArea);
  for (const cards of [school('hold', 6), school('recount', 3, 4), ['ocean_school_empty'], ['ocean_school_empty', 'ocean_number_0']]) {
    assert.equal(normaliseCardBoard({ cards }), null);
  }
});

test('transition wrappers animate a settled base board with their own bounded story clock', () => {
  for (const [name, duration] of [['ocean_zone_out', 700], ['ocean_zone_in', 700], ['ocean_hide_out', 700], ['ocean_goodbye_out', 1200]]) {
    const cards = [...school('reveal', 3), name];
    const start = draw(cards, 0), mid = draw(cards, duration / 2), end = draw(cards, duration);
    assert.equal(mid?.transition?.name, name);
    assert.equal(mid.transition.progress, 0.5);
    assert.equal(mid.transition.opacity, 0.5);
    assert.equal(start.transition.opacity, name === 'ocean_zone_in' ? 0 : 1);
    assert.equal(end.transition.opacity, name === 'ocean_zone_in' ? 1 : 0);
    assert.equal(start.numeral.opacity, 1, 'the wrapper must not replay the underlying numeral reveal');
    assert.deepEqual(geometry(start.fish), geometry(end.fish));
    assert.ok(mid.transition.bubbles.length > 0);
    assert.ok(mid.transition.bubbles.every((b) => [b.cx, b.cy, b.r, b.opacity].every(Number.isFinite)));
    assert.ok(end.transition.bubbles.every((b) => b.opacity === 0));
    assert.deepEqual(end, draw(cards, duration + 4000));
    assert.notEqual(signatureOf(slate(cards, 0)), signatureOf(slate(cards, duration / 2)));
    assert.equal(signatureOf(slate(cards, duration)), signatureOf(slate(cards, duration + 500)));
  }
});

test('static quiz and hand wrappers preserve base card geometry and validate underlying focus', () => {
  for (const items of [['ocean_small_group_2', 'ocean_small_group_3', 'ocean_small_group_1'], ['ocean_clap', 'ocean_number_2'], ['ocean_small_group_2']]) {
    const plain = draw(items, 5000, null, 1);
    const wrapped = draw([...items, 'ocean_zone_in'], 700, null, 1);
    assert.ok(wrapped?.transition);
    assert.deepEqual(wrapped.cards, plain.cards);
    assert.deepEqual(wrapped.prompt, plain.prompt);
    assert.equal(normaliseCardBoard({ cards: [...items, 'ocean_zone_in'], focus: items.length + 1 }), null);
  }
});

test('malformed, nested and temporally ambiguous wrappers are rejected', () => {
  for (const cards of [
    ['ocean_zone_out'], ['ocean_zone_out', 'ocean_fish'], ['ocean_fish', 'ocean_zone_out', 'ocean_zone_in'],
    ['a', 'b', 'c', 'd', 'ocean_zone_out'], ['ocean_fish', 'ocean_zone_unknown'],
    [...school('arrive', 3), 'ocean_zone_in'], [...school('recount', 3, 1), 'ocean_zone_out'],
    ['ocean_arrive_3', 'ocean_fish', 'ocean_number_3', 'ocean_zone_in'],
  ]) assert.equal(normaliseCardBoard({ cards }), null, cards.join(' '));
});

test('dropping a wrapper preserves settled reveal; new transitions start at their authored boundary and survive seeking', () => {
  const items = school('reveal', 2);
  const bundle = bundleOf([command([...items, 'ocean_zone_in']), pause(0.7), command(items), pause(1),
    command([...items, 'ocean_zone_out']), pause(0.7), command(['ocean_clap', 'ocean_number_2', 'ocean_zone_in']), pause(0.7)]);
  const timeline = compileTimeline(bundle);
  assert.equal(timeline.events.filter((e) => e.kind === 'warning').length, 0);
  const cursor = createStateCursor(timeline, bundle);
  for (const instant of [0, 350, 700, 1000, 1700, 2050, 2400, 2750, 3100, 2050, 350, 700]) {
    assert.deepEqual(cursor.at(instant), stateAt(timeline, bundle, instant));
    assert.deepEqual(buildDrawList(cursor.at(instant), sheets), buildDrawList(stateAt(timeline, bundle, instant), sheets));
  }
  assert.equal(stateAt(timeline, bundle, 700).slate.sinceMs, 0);
  assert.equal(buildDrawList(stateAt(timeline, bundle, 700), sheets).commands[0].numeral.opacity, 1);
  assert.equal(stateAt(timeline, bundle, 1700).slate.sinceMs, 1700);
});

test('transition paint fades fish and numerals together without leaking canvas alpha or transforms', () => {
  const fish = { width: 1254, height: 1254 }, numeral = { width: 512, height: 512 };
  for (const items of [[...school('reveal', 3), 'ocean_zone_out'], ['ocean_clap', 'ocean_number_2', 'ocean_zone_in']]) {
    const context = fakeContext();
    paintDrawList(context, buildDrawList(slate(items, 350), sheets), { lookup: (url) => url.endsWith('ocean_fish.svg') ? fish : numeral });
    const images = context.of('drawImage');
    assert.ok(images.length >= 2);
    assert.ok(images.every((call) => call.at(-1).alpha === 0.5));
    assert.equal(context.globalAlpha, 1);
    assert.deepEqual(context.matrix(), [1, 1, 0, 0]);
  }
});

test('wrapped board artwork and markers remain required native preload dependencies', () => {
  const cards = [...school('reveal', 3), 'ocean_zone_in'];
  const bundle = bundleOf([command(cards), pause(0.7)]);
  const timeline = compileTimeline(bundle);
  assert.equal(timeline.events.filter((e) => e.kind === 'warning').length, 0);
  const assets = planAssets(sceneAssetPlan(timeline, bundle, 0));
  for (const slug of cards) assert.ok(assets.some((asset) => asset.slug === slug && asset.required), slug);
});

test('same-board restoration across a scene boundary preserves the numeral before the outgoing wrapper', () => {
  const base = school('reveal', 2);
  const first = [command(base), pause(2)];
  const second = [command(base), pause(0.8), command([...base, 'ocean_zone_out']), pause(0.7)];
  const bundle = bundleOf([...first, ...second]);
  bundle.scenes = [first, second].map((steps) => ({ place: 'reef', plate, steps }));
  const timeline = compileTimeline(bundle);
  const cursor = createStateCursor(timeline, bundle);
  for (const instant of [1999, 2000, 2400, 2799, 2800, 3150, 3500, 2400, 1999, 2000]) {
    const state = stateAt(timeline, bundle, instant);
    assert.deepEqual(cursor.at(instant), state);
    const frame = buildDrawList(state, sheets).commands[0];
    assert.equal(frame.numeral.opacity, 1);
    assert.equal(state.slate.sinceMs, instant < 2800 ? 0 : 2800);
  }
});
