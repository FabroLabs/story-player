/**
 * Which sheet, at which size, in which grid.
 *
 * The grid half is the one that fails silently in a browser: read a re-gridded
 * rendition with the original strip's grid and every frame index lands on the
 * wrong cell, animating a plausible wrong picture with no error anywhere.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DPR_CAP,
  pickRendition,
  renditionGrid,
  sheetFor,
  wantedCellPx,
} from '../browser/v0/app/assets/rendition-picker.mjs';

const LADDER = {
  200: 'base/mobile/sprites/a.webp',
  320: 'base/mobile/sprites/b.webp',
  384: 'base/mobile/sprites/c.webp',
  512: 'base/mobile/sprites/d.webp',
};

test('a one-row strip re-grids to near-square; anything two-dimensional is left alone', () => {
  assert.deepEqual(renditionGrid(65, [65, 1]), [9, 8], '65 frames: ceil(sqrt) columns, ceil(n/cols) rows');
  assert.deepEqual(renditionGrid(81, [81, 1]), [9, 9]);
  assert.deepEqual(renditionGrid(48, [48, 1]), [7, 7], 'the last row keeps transparent trailing cells');
  assert.deepEqual(renditionGrid(25, [5, 5]), [5, 5], 'reflowing a grid would churn names for no win');
  assert.deepEqual(renditionGrid(1, [1, 1]), [1, 1], 'a single frame has nothing to reflow');
  assert.deepEqual(renditionGrid(12, undefined), [4, 3], 'a clip with no grid is read as a strip, and re-grids');
});

test('the smallest tier that carries the size wins, and the largest is the ceiling', () => {
  assert.equal(pickRendition(LADDER, 0).size, 200);
  assert.equal(pickRendition(LADDER, 200).size, 200, 'exactly enough is enough');
  assert.equal(pickRendition(LADDER, 201).size, 320);
  assert.equal(pickRendition(LADDER, 384).size, 384);
  assert.equal(pickRendition(LADDER, 900).size, 512, 'a soft sprite beats an 85 MB decode');
  assert.equal(pickRendition({}, 200), null);
  assert.equal(pickRendition(undefined, 200), null);
  assert.equal(
    pickRendition({ 200: 'base/a.webp', nonsense: 'base/b.webp', 320: '' }, 300).size,
    200,
    'a tier that is not a size, or carries no key, is not a tier',
  );
});

test('every magnification between the sheet and the eye multiplies the size asked for', () => {
  assert.equal(wantedCellPx({ drawnHeightPx: 100 }), 100);
  assert.equal(wantedCellPx({ drawnHeightPx: 100, fitScale: 0.5 }), 50);
  assert.equal(wantedCellPx({ drawnHeightPx: 100, dpr: 2 }), 200);
  assert.equal(wantedCellPx({ drawnHeightPx: 100, cameraScale: 1.55 }), 155);
  assert.equal(
    wantedCellPx({ drawnHeightPx: 100, dpr: 3 }),
    100 * DPR_CAP,
    'past the cap the ladder has nothing left to give',
  );
  assert.equal(wantedCellPx({ drawnHeightPx: 100, dpr: 3, dprCap: 1.5 }), 150, 'the low tier lowers the cap');
  assert.equal(
    wantedCellPx({ drawnHeightPx: 100, fitScale: 0, dpr: 0, cameraScale: 0 }),
    100,
    'a stage with no size yet must not quietly ask for the smallest sheet there is',
  );
  assert.equal(wantedCellPx({ drawnHeightPx: Number.NaN }), 0);
});

test('a clip with renditions is drawn from one, in the rendition grid', () => {
  const clip = { spritesheet: 'base/sprites/x/spritesheet.png', frames: 65, grid: [65, 1], renditions: LADDER };
  const sheet = sheetFor(clip, 300);

  assert.deepEqual(sheet, {
    url: LADDER[320], grid: [9, 8], cellPx: 320, tier: 320,
  });
  assert.equal(
    sheetFor(clip, 300).grid.join('x') === clip.grid.join('x'),
    false,
    'the bundle grid describes the ORIGINAL sheet and must not be used to read a rendition',
  );
});

test('a bundle from before renditions existed still plays, and says which one it is', () => {
  const clip = { spritesheet: 'base/sprites/x/spritesheet.png', frames: 25, grid: [5, 5] };
  assert.deepEqual(sheetFor(clip, 300), {
    url: 'base/sprites/x/spritesheet.png', grid: [5, 5], cellPx: 512, tier: null,
  });
});
