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
  KEEP_WINDOW,
  chunkAt,
  chunkGrid,
  chunkWindow,
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

/** Nine frames cut into threes: three chunks, every one of them a 2x2 canvas. */
function chunkedClip(frames = 9, framesPerChunk = 4) {
  const keys = Array.from(
    { length: Math.ceil(frames / framesPerChunk) },
    (_, index) => `base/mobile/sprites/chunk-${index}.webp`,
  );
  return {
    spritesheet: 'base/sprites/x/spritesheet.png',
    frames,
    grid: [frames, 1],
    renditions: LADDER,
    rendition_chunks: { 320: { frames_per_chunk: framesPerChunk, keys } },
  };
}

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
    url: LADDER[320], grid: [9, 8], cellPx: 320, tier: 320, chunks: null,
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
    url: 'base/sprites/x/spritesheet.png', grid: [5, 5], cellPx: 512, tier: null, chunks: null,
  });
});

test('every chunk of a clip is laid out on one grid, the short last one included', () => {
  assert.deepEqual(chunkGrid(4, 81), [2, 2], '512 px: four frames on a 2x2 canvas');
  assert.deepEqual(chunkGrid(6, 81), [3, 2], '384 px');
  assert.deepEqual(chunkGrid(9, 81), [3, 3], '320 px');
  assert.deepEqual(chunkGrid(25, 81), [5, 5], '200 px');
  assert.deepEqual(
    chunkGrid(4, 9),
    chunkGrid(4, 81),
    'the tail is PADDED to the clip grid; a grid that varied inside a clip draws the wrong cells',
  );
  assert.deepEqual(
    chunkGrid(25, 1),
    [1, 1],
    'a one-frame clip on a 5x5 canvas would decode 3.8 MB for a frame that needs 0.15',
  );
  assert.deepEqual(chunkGrid(4, 3), [2, 2], 'three frames still cost the 2x2 the count rounds up to');
});

test('a chunked clip answers which object holds a frame, and where that object starts', () => {
  const sheet = sheetFor(chunkedClip(), 300);

  assert.deepEqual(sheet.chunks, {
    framesPerChunk: 4,
    grid: [2, 2],
    urls: [
      'base/mobile/sprites/chunk-0.webp',
      'base/mobile/sprites/chunk-1.webp',
      'base/mobile/sprites/chunk-2.webp',
    ],
  });
  assert.equal(sheet.url, LADDER[320], 'the whole-sheet rendition stays beside the chunks');

  assert.deepEqual(chunkAt(sheet, 0), { url: sheet.chunks.urls[0], grid: [2, 2], chunkStart: 0 });
  assert.deepEqual(chunkAt(sheet, 3), { url: sheet.chunks.urls[0], grid: [2, 2], chunkStart: 0 });
  assert.deepEqual(chunkAt(sheet, 4), { url: sheet.chunks.urls[1], grid: [2, 2], chunkStart: 4 });
  assert.deepEqual(
    chunkAt(sheet, 8),
    { url: sheet.chunks.urls[2], grid: [2, 2], chunkStart: 8 },
    'the ninth frame is alone in a chunk padded to the same 2x2',
  );
  assert.deepEqual(chunkAt(sheet, 12), chunkAt(sheet, 0), 'a clip loops, and so does its ladder');
  assert.deepEqual(chunkAt(sheet, Number.NaN), chunkAt(sheet, 0), 'a frame that is not one is frame zero');
});

test('an unchunked sheet answers the same question with the whole sheet', () => {
  const sheet = sheetFor({ frames: 65, grid: [65, 1], renditions: LADDER }, 300);
  assert.deepEqual(chunkAt(sheet, 40), { url: LADDER[320], grid: [9, 8], chunkStart: 0 });
});

test('the window is the chunk under the playhead and the next, and it wraps', () => {
  const sheet = sheetFor(chunkedClip(), 300);
  const [first, second, third] = sheet.chunks.urls;

  assert.equal(KEEP_WINDOW, 2, 'the encoder sized every chunk against a window of two');
  assert.deepEqual(chunkWindow(sheet, 0), [first, second]);
  assert.deepEqual(chunkWindow(sheet, 5), [second, third]);
  assert.deepEqual(chunkWindow(sheet, 8), [third, first], 'the chunk after the last one is the first');
  assert.deepEqual(chunkWindow(sheet, 0, 1), [first], 'a scene warmed ahead takes the opening chunk only');
  assert.deepEqual(
    chunkWindow(sheetFor(chunkedClip(3), 300), 0),
    ['base/mobile/sprites/chunk-0.webp'],
    'a clip of one chunk is not held twice',
  );
  assert.deepEqual(
    chunkWindow(sheetFor({ frames: 65, grid: [65, 1], renditions: LADDER }, 300), 40),
    [LADDER[320]],
    'an unchunked sheet is its own window',
  );
});

test('a chunk ladder that cannot be read is refused, and the whole rendition is drawn', () => {
  const short = chunkedClip();
  short.rendition_chunks[320].keys.pop();
  assert.equal(
    sheetFor(short, 300).chunks,
    null,
    'a list one short does not have a hole in it — every index past the hole is the wrong frames',
  );

  const noLength = chunkedClip();
  delete noLength.rendition_chunks[320].frames_per_chunk;
  assert.equal(sheetFor(noLength, 300).chunks, null, 'without the length nothing can find the chunk for a frame');

  const empty = chunkedClip();
  empty.rendition_chunks[320].keys[1] = '';
  assert.equal(sheetFor(empty, 300).chunks, null);

  const long = chunkedClip();
  long.rendition_chunks[320].keys.push(long.rendition_chunks[320].keys.at(-1));
  assert.equal(
    sheetFor(long, 300).chunks,
    null,
    'a list one too long wraps the window onto a key the bucket does not carry',
  );

  const otherTier = chunkedClip();
  assert.equal(sheetFor(otherTier, 500).chunks, null, 'the tier drawn is the tier the chunks must be on');
  assert.equal(sheetFor(otherTier, 500).url, LADDER[512], 'and that tier is still drawn, whole');
});
