import assert from 'node:assert/strict';
import test from 'node:test';
import { createTextCache } from '../browser/v0/app/stage/text-cache.mjs';
import { fakeContext, fakeElement } from './_dom.mjs';

function fixture(limit = 256) {
  const surfaces = [];
  const cache = createTextCache(() => {
    const canvas = fakeElement('canvas');
    surfaces.push(canvas);
    return canvas;
  }, { limit });
  const context = fakeContext();
  context.font = '40px sans-serif';
  context.fillStyle = '#123456';
  return { cache, context, surfaces };
}

test('measurement and bitmap hits do no further shaping; alpha and position remain live', () => {
  const { cache, context, surfaces } = fixture();
  const metrics = cache.measure(context, 'مرحبا', 200);
  assert.equal(cache.measure(context, 'مرحبا', 200), metrics);
  cache.draw(context, 'مرحبا', 100, 80, 200);
  context.globalAlpha = .25;
  context.translate(15, 20);
  cache.draw(context, 'مرحبا', 150, 90, 200);
  assert.equal(context.of('measureText').length, 1);
  assert.equal(context.of('fillText').length, 0);
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].context.of('fillText').length, 1);
  const [first, second] = context.of('drawImage');
  assert.equal(first[0], second[0]);
  assert.equal(second[1] - first[1], 50);
  assert.equal(second[2] - first[2], 10);
  assert.equal(second.at(-1).alpha, .25);
  assert.deepEqual(second.at(-1).transform, [1, 1, 15, 20]);
});

test('the LRU refreshes measurement and draw hits, evicts the oldest, and clears', () => {
  const { cache, context, surfaces } = fixture(2);
  cache.draw(context, 'A', 0, 0);
  cache.draw(context, 'B', 0, 0);
  cache.measure(context, 'A');
  cache.draw(context, 'C', 0, 0);
  cache.draw(context, 'A', 0, 0);
  assert.equal(surfaces.length, 3);
  cache.draw(context, 'B', 0, 0);
  assert.equal(surfaces.length, 4, 'B was least recently used');
  cache.clear();
  cache.draw(context, 'B', 0, 0);
  assert.equal(surfaces.length, 5);
  // Measurement-only candidates share the same bound as rendered entries.
  cache.measure(context, 'D');
  cache.measure(context, 'E');
  cache.draw(context, 'B', 0, 0);
  assert.equal(surfaces.length, 6);
});

test('the default budget holds 256 entries, including measurement-only entries', () => {
  const { cache, context } = fixture();
  const first = cache.measure(context, '0');
  for (let index = 1; index < 256; index++) cache.measure(context, String(index));
  assert.equal(cache.measure(context, '0'), first);
  cache.measure(context, '256');
  cache.measure(context, '1');
  assert.equal(context.of('measureText').length, 258, 'the oldest untouched measurement was evicted');
});

test('all paint/text settings, width constraints and effective pixel sizes distinguish entries', () => {
  const { cache, context, surfaces } = fixture();
  const draw = (maxWidth) => cache.draw(context, 'Test', 0, 0, maxWidth);
  draw();
  for (const [name, value] of Object.entries({ font: '60px sans-serif', fillStyle: 'red',
    strokeStyle: 'blue', lineWidth: 4, direction: 'rtl', textAlign: 'right', textBaseline: 'top',
    letterSpacing: '2px', fontKerning: 'none' })) {
    const before = surfaces.length;
    context[name] = value;
    draw();
    assert.equal(surfaces.length, before + 1, name);
  }
  draw(80);
  const before = surfaces.length;
  context.setTransform(2, 0, 0, 3, 0, 0);
  draw(80);
  assert.equal(surfaces.length, before + 1);
  const into = surfaces.at(-1).context;
  assert.deepEqual(into.matrix().slice(0, 2), [2, 3]);
  const image = context.of('drawImage').at(-1);
  assert.equal(image[3] * 2, image[0].width);
  assert.equal(image[4] * 3, image[0].height);
});

for (const direction of ['ltr', 'rtl']) {
  for (const align of ['left', 'center', 'right', 'start', 'end']) {
    for (const baseline of ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom']) {
      test(`cached anchor equals direct text: ${direction}/${align}/${baseline}`, () => {
        const { cache, context, surfaces } = fixture();
        Object.assign(context, { direction, textAlign: align, textBaseline: baseline });
        context.setTransform(1.5, 0, 0, 2, 30, 40);
        const text = direction === 'rtl' ? 'مرحبا' : 'Hello';
        for (const maxWidth of [undefined, 50]) {
          const metrics = cache.measure(context, text, maxWidth);
          cache.draw(context, text, 123.25, 87.5, maxWidth);
          const [bitmap, x, y, w, h] = context.of('drawImage').at(-1);
          const raster = surfaces.at(-1).context;
          const [sx, sy, tx, ty] = raster.matrix();
          const [glyph, gx, gy] = raster.of('fillText')[0];
          assert.equal(glyph, text);
          // Undo bitmap pixels -> logical coordinates, then compare the exact
          // anchor and both ink edges with a direct fillText at that anchor.
          assert.ok(Math.abs(x + (gx * sx + tx) * w / bitmap.width - 123.25) < 1e-10);
          assert.ok(Math.abs(y + (gy * sy + ty) * h / bitmap.height - 87.5) < 1e-10);
          const shrink = maxWidth ? Math.min(1, maxWidth / metrics.width) : 1;
          assert.ok(tx - metrics.actualBoundingBoxLeft * shrink * sx >= 2);
          assert.ok(tx + metrics.actualBoundingBoxRight * shrink * sx <= bitmap.width - 2);
          assert.ok(ty - metrics.actualBoundingBoxAscent * sy >= 2);
          assert.ok(ty + metrics.actualBoundingBoxDescent * sy <= bitmap.height - 2);
          assert.equal(raster.textAlign, align);
          assert.equal(raster.textBaseline, baseline);
          assert.equal(raster.direction, direction);
          assert.equal(context.textAlign, align);
          assert.equal(context.textBaseline, baseline);
        }
      });
    }
  }
}

test('invalid maximum widths paint nothing', () => {
  const { cache, context, surfaces } = fixture();
  for (const width of [0, -1, NaN, Infinity]) cache.draw(context, 'Hello', 0, 0, width);
  assert.equal(surfaces.length, 0);
  assert.equal(context.of('drawImage').length, 0);
});
