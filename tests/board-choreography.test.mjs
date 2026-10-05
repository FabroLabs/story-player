import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';
import { read } from './_parity.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { createSceneLoader } from '../browser/v0/app/assets/scene-loader.mjs';
import { signatureOf } from '../browser/v0/app/timeline-player.mjs';

const GUIDE = { layout: 'lesson-guide', guide: 'helper' };
const sheets = { sheet: () => ({ url: 'assets/helper.webp', grid: [8, 8] }), prop: slug => ({ url: `assets/${slug}.svg` }) };
const state = (tMs, cards = ['one', 'two', 'target', 'four']) => ({
  tMs, plate: { resolution: [1920, 1080] }, camera: { scale: 2, x: 12, y: 3 },
  actors: [{ slug: 'helper', kind: 'character', opacity: 1, heightPx: 200, clip: 'gesture', frame: 31 }],
  slate: { mode: 'cards', cards, focus: 3, prompt: 'Which one?', standing: true, sinceMs: 0 },
});
const track = (kind = 'push') => ({
  id: 'supplied-object', kind, start_ms: 1000, end_ms: 5000,
  actor: { mirror: true, keyframes: [
    { at: 0, box: [.90, .99, .32] },
    { at: .5, box: [.65, .99, .32], opacity: .8 },
    { at: 1, box: [.90, .99, .32] },
  ] },
  prop: { slug: 'target', cards: ['one', 'two', 'target', 'four'], card_index: 3, hide_card_image: true, keyframes: [
    { at: 0, anchor: 'card', box: [.5, .5, 1, 1] },
    { at: .5, anchor: 'actor', box: [.75, .58, .35, .35] },
    { at: 1, anchor: 'stage', box: [1.15, .80, .08, .14], opacity: 0 },
  ] },
});
const options = item => ({ ...GUIDE, choreography: [item] });
const listAt = (tMs, item = track(), cards) => buildDrawList(state(tMs, cards), sheets, null, options(item));
const sprite = list => list.commands.find(command => command.op === 'sprite');
const prop = list => list.commands.find(command => command.op === 'prop');

test('mount validates and freezes supplied skit tracks without freezing caller data', () => {
  const input = options(track());
  const resolved = requireBoardBlock(input, 'https://storage.example/');
  assert.deepEqual(resolved, input);
  assert.ok(Object.isFrozen(resolved.choreography[0].actor.keyframes[0].box));
  assert.ok(!Object.isFrozen(input.choreography[0].actor.keyframes[0].box));
  input.choreography[0].actor.keyframes[0].box[0] = .4;
  assert.equal(resolved.choreography[0].actor.keyframes[0].box[0], .9);
});

test('diagnostic movement kinds share the existing presentation and accept only the top caption lane', () => {
  for (const kind of ['perch', 'run', 'hop', 'grab']) {
    const item = track(kind); delete item.prop;
    item.caption = 'top';
    const board = requireBoardBlock(options(item), 'https://storage.example/');
    assert.equal(board.choreography[0].caption, 'top');
    assert.deepEqual(buildDrawList(state(3000), sheets, null, board).commands[0],
      buildDrawList(state(3000), sheets, null, GUIDE).commands[0]);
    assert.equal(sprite(buildDrawList(state(3000), sheets, null, board)).dx, 1075.2);
  }
  for (const caption of ['bottom', '', null, 60, true]) {
    const item = track(); item.caption = caption;
    assert.throws(() => requireBoardBlock(options(item), 'https://storage.example/'), /caption/);
  }
});

test('malformed, overlapping or non-finite presentation cannot reach paint', () => {
  const bad = [];
  for (const change of [
    value => { value.kind = 'unknown'; }, value => { value.end_ms = value.start_ms; },
    value => { value.start_ms = -1; }, value => { value.actor.keyframes[1].at = 0; },
    value => { value.actor.keyframes[2].at = .9; }, value => { value.actor.keyframes[0].box[2] = 0; },
    value => { value.actor.keyframes[0].box[0] = NaN; }, value => { value.actor.keyframes[1].opacity = 2; },
    value => { value.actor.mirror = 'yes'; }, value => { value.actor.keyframes[1].clip = [0, .9, 1, .2]; },
    value => { value.prop.card_index = 0; }, value => { value.prop.slug = 'two words'; },
    value => { value.prop.keyframes[1].anchor = 'unknown'; }, value => { value.actor.clip = 'gesture'; },
    value => { delete value.prop.cards; }, value => { value.prop.cards = ['one', 'one', 'target']; },
    value => { value.prop.cards = ['one', 'target', 'two']; },
  ]) { const item = track(); change(item); bad.push(options(item)); }
  bad.push({ choreography: [track()] });
  bad.push({ ...GUIDE, choreography: [track(), { ...track(), id: 'overlap', start_ms: 4500, end_ms: 8500 }] });
  for (const input of bad) assert.throws(() => requireBoardBlock(input, 'https://storage.example/'), /choreography/);
});

test('an active push changes one card image and the supplied cells, preserving every shell and prompt', () => {
  const original = buildDrawList(state(3000), sheets, null, GUIDE);
  const list = listAt(3000);
  const expected = structuredClone(original.commands[0]);
  expected.cards[2].imageHidden = true;
  assert.deepEqual(list.commands[0], expected);
  assert.equal(state(3000).slate.cards[2], 'target');
  assert.deepEqual([sprite(list).dx, sprite(list).dy, sprite(list).dw, sprite(list).dh], [1075.2, 723.6, 345.6, 345.6]);
  assert.equal(sprite(list).opacity, .8);
  assert.equal(sprite(list).mirror, true);
  assert.deepEqual(sprite(list).cell, [7, 3], 'the ordinary core clip frame stays authoritative');
  assert.equal(prop(list).slug, 'target');
  assert.equal(prop(list).hud, true);
  assert.equal(prop(list).anchor, 'center');
  assert.ok(Math.abs(prop(list).dw - 120.96) < 1e-9);
  assert.equal(prop(list).dx + prop(list).dw / 2, 1334.4);
  assert.ok(sprite(list).dy > Math.max(...list.commands[0].cards.map(card => card.dy + card.dh)));
});

test('arbitrary seek order, repeated paused instants and viewport changes return identical choreography', () => {
  const item = track();
  const wanted = JSON.stringify(listAt(3200, item));
  for (const tMs of [4999, 1000, 8000, 3200, 2200, 3200]) {
    const list = listAt(tMs, item);
    if (tMs === 3200) assert.equal(JSON.stringify(list), wanted);
  }
  assert.equal(JSON.stringify(buildDrawList(state(3200), sheets, { width: 390, height: 219.375 }, options(item))), wanted);
  assert.deepEqual(item, track(), 'building a picture must not mutate authored keyframes');
});

test('paint signatures follow finite skit progress even while every sprite frame is held', () => {
  const board = options(track());
  assert.equal(signatureOf(state(1400)), signatureOf(state(1600)), 'the fixture holds every ordinary paint input');
  assert.notEqual(signatureOf(state(1400), board), signatureOf(state(1600), board));
  assert.notEqual(signatureOf(state(4999), board), signatureOf(state(5000), board), 'window end must restore the picture');
  assert.equal(signatureOf(state(5000), board), signatureOf(state(6000), board), 'settled skits must stop repainting');
  assert.equal(signatureOf(state(1600), board), signatureOf(state(1600), board), 'paused instants remain fixed');
});

test('outside finite windows and on a changed answer board, the original cells return exactly', () => {
  for (const tMs of [0, 999, 5000, 6000, 8000]) {
    assert.deepEqual(listAt(tMs), buildDrawList(state(tMs), sheets, null, GUIDE));
  }
  const alternatives = ['target', 'one', 'two'];
  assert.deepEqual(listAt(3000, track(), alternatives), buildDrawList(state(3000, alternatives), sheets, null, GUIDE),
    'a supplied third-slot target must never hide the third child-answer alternative');
  for (const changed of [['one', 'two', 'target'], ['two', 'one', 'target'], ['two', 'one', 'target', 'four']]) {
    assert.deepEqual(listAt(3000, track(), changed), buildDrawList(state(3000, changed), sheets, null, GUIDE),
      'a target remaining in the same slot does not authorize a different board');
  }
  const missing = { ...state(3000), actors: [] };
  assert.deepEqual(buildDrawList(missing, sheets, null, options(track())), buildDrawList(missing, sheets, null, GUIDE));
});

test('carry docks to the exact centered card image rectangle and accepts fully transparent endpoints', () => {
  const item = track('carry');
  item.actor.mirror = false;
  item.actor.keyframes[0].opacity = 0;
  item.prop.keyframes = [
    { at: 0, anchor: 'actor', box: [.65, .55, .35, .35], opacity: 0 },
    { at: .9, anchor: 'card', box: [.5, .5, 1, 1] },
    { at: 1, anchor: 'card', box: [.5, .5, 1, 1] },
  ];
  requireBoardBlock(options(item), 'https://storage.example/');
  const list = listAt(4600, item);
  const card = list.commands[0].cards[2];
  const inset = card.dw * .06;
  assert.deepEqual([prop(list).dx, prop(list).dy, prop(list).dw, prop(list).dh],
    [card.dx + inset, card.dy + inset, card.dw - 2 * inset, card.dh - 2 * inset]);
  assert.equal(sprite(listAt(1000, item)).opacity, 0);
});

test('peek body clipping is pure stage geometry and masks only the supplied actor', () => {
  const item = track('peek'); delete item.prop;
  item.actor = { keyframes: [
    { at: 0, box: [.9, .99, .32], clip: [0, 0, 1, 1] },
    { at: .5, box: [.9, 1.09, .32], clip: [0, 0, 1, .93] },
    { at: 1, box: [.9, .99, .32], clip: [0, 0, 1, 1] },
  ] };
  const list = listAt(3000, item);
  assert.deepEqual(list.commands[0], buildDrawList(state(3000), sheets, null, GUIDE).commands[0]);
  assert.deepEqual(sprite(list).clip, { x: 0, y: 0, w: 1920, h: 1004.4 });
  assert.equal(sprite(list).dy, 831.6);
  assert.ok(sprite(list).dy + sprite(list).dh > sprite(list).clip.h, 'body really lies below the mask');
  assert.deepEqual(sprite(listAt(5000, item)), sprite(buildDrawList(state(5000), sheets, null, GUIDE)));
});

test('canvas hides only the target image, preserves target shell paint, and docks portrait SVGs identically', () => {
  const item = track('carry');
  item.actor.mirror = false;
  item.prop.keyframes = [{ at: 0, anchor: 'card', box: [.5, .5, 1, 1] }, { at: 1, anchor: 'card', box: [.5, .5, 1, 1] }];
  const images = { 'assets/helper.webp': { width: 4096, height: 4096 } };
  for (const slug of ['one', 'two', 'target', 'four']) images[`assets/${slug}.svg`] = { width: 512, height: 640 };
  const lookup = url => images[url] ?? null;
  const before = fakeContext(); const during = fakeContext();
  paintDrawList(before, buildDrawList(state(3000), sheets, null, GUIDE), { lookup });
  paintDrawList(during, listAt(3000, item), { lookup });
  assert.deepEqual(during.of('stroke'), before.of('stroke'), 'fixed card borders and panel keep their paint');
  const targetPaint = context => context.of('drawImage').filter(call => call[0] === images['assets/target.svg']);
  assert.equal(targetPaint(during).length, 1, 'one overlay must replace the hidden target image');
  assert.deepEqual(targetPaint(during), targetPaint(before), 'the docked overlay and canonical card use the same SVG fitting');
  assert.ok(!during.of('fillText').some(call => call[0] === 'image unavailable'));
});

test('actor mirroring and mask are isolated from prop, HUD camera and fallback paint', () => {
  const item = track();
  for (const frame of item.actor.keyframes) frame.clip = [0, .65, 1, .93];
  const list = listAt(3000, item);
  const context = fakeContext();
  const helper = { width: 4096, height: 4096 }; const glyph = { width: 512, height: 640 };
  paintDrawList(context, list, { scale: 2, lookup: url => url === 'assets/helper.webp' ? helper : glyph });
  const paints = context.of('drawImage');
  assert.deepEqual(paints.find(call => call[0] === helper).at(-1).transform, [-2, 2, 4992, 0]);
  assert.deepEqual(paints.filter(call => call[0] === glyph).at(-1).at(-1).transform, [2, 2, 0, 0]);
  assert.deepEqual(context.of('rect'), [[0, 702, 1920, 302.4]]);
  assert.equal(context.of('clip').length, 1);
  assert.equal(context.depth(), 0);
  assert.deepEqual(context.matrix().map(value => Math.round(value * 100) / 100), [4, 4, 460.8, 64.8]);
  const missing = fakeContext();
  let fallbackMatrix;
  paintDrawList(missing, list, { lookup: () => null, onMissing: (ctx, command) => {
    if (command.slug === 'helper') fallbackMatrix = ctx.matrix(); return true;
  } });
  assert.deepEqual(fallbackMatrix, [-1, 1, 2496, 0], 'cached or placeholder actor uses the same reflection');
  assert.equal(missing.depth(), 0);
});

test('loader chooses a sharp enough tier for the largest authored actor cell and separates cached plans', () => {
  const bundle = read('golden_push_dusk', 'bundle');
  bundle.objects = { target: { svg: 'assets/target.svg', height_cm: 30 } };
  bundle.scenes = [{ ...bundle.scenes[0], steps: [
    { kind: 'cmd', cmd: 'put', subjects: ['robin'], objects: [], position: 'center', facing: null, beside: null, zone: null },
    { kind: 'cmd', cmd: 'board', cards: ['target'], subjects: [], focus: null, prompt: '' },
    { kind: 'cmd', cmd: 'pause', seconds: 8 },
  ] }];
  const timeline = compileTimeline(bundle);
  const item = track('peek'); delete item.prop;
  item.actor.keyframes[1].box[2] = .6;
  const board = { layout: 'lesson-guide', guide: 'robin', choreography: [item] };
  const viewport = { fitScale: 1, dpr: 1 };
  const loader = createSceneLoader({ timeline, bundle, cache: { get: () => null } });
  const original = loader.plan(0, { ...viewport, board: { layout: 'lesson-guide', guide: 'robin' } });
  const choreographed = loader.plan(0, { ...viewport, board });
  assert.notStrictEqual(original, choreographed);
  for (const sheet of choreographed.sheets.filter(sheet => sheet.slug === 'robin')) {
    assert.ok(sheet.drawnHeightPx >= 648);
    assert.ok(sheet.wantedPx >= 648);
  }
});
