/**
 * Which sheet a clip is drawn from, and how that sheet's cells are laid out.
 *
 * The bucket holds the originals a 512 px cell was authored at: 259 of the
 * forest catalog's 453 sheets are 5x5 (2560x2560, 26 MB decoded), and 48 are a
 * single 81-frame strip — 41472x512, 85 MB decoded, 5.7 s to fetch and decode
 * on this link. A browser that asks for those is paying for pixels nobody can
 * see: a 15 cm hedgehog on a far band is drawn about 45 px tall.
 *
 * So every clip in the bundle carries `renditions` — the same content-addressed
 * webp ladder the phone reads, 200/320/384/512, about 17x smaller — and this
 * module answers the only two questions a drawer has:
 *
 *   which step of the ladder is enough for the size this sprite is drawn at
 *   what grid that step is in, which is NOT the grid the bundle records
 *
 * The second one is the trap. `grid` in `story.json` describes the ORIGINAL
 * sheet, and the encode re-grids a one-row strip into a near-square so it fits
 * a texture limit. Reading a rendition with the original grid picks the wrong
 * cell for every frame and errors nowhere: the sprite animates, it is simply
 * the wrong picture. The rule is published (`wiki/clients/mobile.md`, "The grid
 * rule") and is reproduced here rather than shipped in the bundle, because it
 * is a property of the encode recipe, not of a story.
 *
 * A step of that ladder is also emitted CUT INTO CHUNKS — short runs of frames,
 * `rendition_chunks` beside `renditions` — and where the bundle carries them
 * they answer a third question: which chunk holds the frame being drawn, and
 * which cell of it. That is what keeps a scene inside the memory budget. One
 * 81-frame clip at 512 px is a 4608x4608 bitmap, 81 MB decoded against the
 * 48 MB a small device gets, so eviction can never reach the budget and the tab
 * is reloaded out from under a child; a four-frame chunk is 4 MB, and the
 * player holds the one under the playhead plus the next.
 */

import { SPRITE_SOURCE_PX } from '../stage/presentation-policy.mjs';

// A 3x-density phone asks for three times the pixels of a 1x laptop for the
// same picture, and the ladder stops at 512. Past 2 the extra tier is either
// absent or invisible, so the cap is where the honest ceiling already is.
export const DPR_CAP = 2;

// A clip is drawn from one chunk at a time and the next one is fetched while it
// draws: two, because a window of one leaves nothing to fetch ahead into. The
// ENCODER sized every chunk against this same number — `KEEP_WINDOW` in
// `tools/playerkit/renditions.py` — so a window widened here alone puts the
// measured budget out by exactly the chunks it added.
export const KEEP_WINDOW = 2;

/**
 * The rendition's own grid, from the frame count and the ORIGINAL grid.
 *
 * `ceil(sqrt(frames))` columns for a one-row strip, everything already
 * two-dimensional left exactly as it is — reflowing a 5x5 would only churn
 * object names for no texture-size win. Trailing cells in the last row are
 * transparent, and frame order stays row-major, so `frameCell` keeps working
 * unchanged against this grid.
 */
export function renditionGrid(frames, grid) {
  const [columns, rows] = grid ?? [frames, 1];
  if (rows !== 1 || !(frames > 1)) return [columns, rows];
  const wide = Math.ceil(Math.sqrt(frames));
  return [wide, Math.ceil(frames / wide)];
}

/**
 * How many source pixels tall a sheet's cell must be for this sprite.
 *
 * Four multiplications, and each one is a place the picture is magnified
 * between the sheet and the viewer's eye:
 *
 *   drawnHeightPx  the sprite's height on the 1920x1080 logical stage, band
 *                  scale already in it — `stateAt`'s answer, never re-derived
 *   fitScale       that stage letterboxed into the element it is mounted in
 *   dpr            device pixels per CSS pixel, capped
 *   cameraScale    the most this scene's camera ever magnifies the plate
 *
 * The camera term is per SCENE rather than per instant on purpose: a push-in
 * that starts eight seconds in must not be the moment a sharper sheet begins
 * downloading, and one sheet is what the scene loads.
 */
export function wantedCellPx({
  drawnHeightPx, fitScale = 1, dpr = 1, dprCap = DPR_CAP, cameraScale = 1,
}) {
  const height = Number.isFinite(drawnHeightPx) && drawnHeightPx > 0 ? drawnHeightPx : 0;
  const density = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, dprCap);
  const fit = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1;
  const camera = Number.isFinite(cameraScale) && cameraScale > 0 ? cameraScale : 1;
  return height * fit * density * camera;
}

/**
 * The grid EVERY chunk of a clip is laid out on — the short last one included.
 *
 * One grid per clip, and that is the whole law. A clip rarely divides by its
 * chunk length (437 of the forest catalog's 453 sheets end short at 384 px), and
 * laying the tail on its own tight canvas would make the grid vary WITHIN a
 * clip — 25 frames on 5x5, the 15-frame tail on 4x4. A reader trusting the
 * clip's grid would then draw the wrong cells for the last fraction of every
 * loop, silently, forever. The encoder pads the tail instead, exactly as
 * `renditionGrid` pads a sheet's last row.
 *
 * `min` is the other half: 267 of those sheets are SHORTER than one 200 px
 * chunk, and sizing their canvas by the full chunk length would lay a one-frame
 * clip on a 5x5 grid — six times the whole-sheet rendition it is meant to be
 * cheaper than, on exactly the devices this exists to protect.
 */
export function chunkGrid(framesPerChunk, frames) {
  const count = Math.min(framesPerChunk, frames);
  return renditionGrid(count, [count, 1]);
}

/**
 * The chunk ladder for one tier, or null when there is none to read.
 *
 * Refusing is a whole answer here. A key list one short of the clip is not a
 * ladder with a hole in it — it is a ladder whose every index past the hole
 * points at the wrong frames, and drawing from it is the silent wrong picture
 * this module exists to prevent. The caller falls back to the whole sheet,
 * which is where every bundle written before chunks existed already lives.
 */
function chunkLadder(clip, size, frames) {
  const block = clip?.rendition_chunks?.[size];
  const framesPerChunk = block?.frames_per_chunk;
  const urls = block?.keys;
  if (!Number.isInteger(framesPerChunk) || framesPerChunk < 1) return null;
  if (!Array.isArray(urls) || urls.length !== Math.ceil(frames / framesPerChunk)) return null;
  if (!urls.every((url) => typeof url === 'string' && url)) return null;
  return { framesPerChunk, urls, grid: chunkGrid(framesPerChunk, frames) };
}

/**
 * The sheet a frame is drawn from, and where in it that frame sits.
 *
 * `chunkStart` is the frame the returned sheet BEGINS at, so the cell is
 * `frameCell(frame - chunkStart, grid)`. An unchunked sheet answers 0 and the
 * arithmetic is the identity it has always been.
 */
export function chunkAt(sheet, frame) {
  const chunks = sheet?.chunks;
  if (!chunks) return { url: sheet?.url ?? null, grid: sheet?.grid ?? null, chunkStart: 0 };
  const index = chunkIndex(chunks, frame);
  return {
    url: chunks.urls[index],
    grid: chunks.grid,
    chunkStart: index * chunks.framesPerChunk,
  };
}

/**
 * The chunks that must be resident for this frame: the one under the playhead
 * and the next, wrapping, because a clip loops.
 *
 * An unchunked sheet is its own window of one — the whole-sheet path, unchanged.
 */
export function chunkWindow(sheet, frame, window = KEEP_WINDOW) {
  if (!sheet?.chunks) return sheet?.url ? [sheet.url] : [];
  const { urls } = sheet.chunks;
  const first = chunkIndex(sheet.chunks, frame);
  const wanted = Math.min(Math.max(1, window), urls.length);
  return Array.from({ length: wanted }, (_, step) => urls[(first + step) % urls.length]);
}

// A clip loops, so a frame past the last one is the first one again — the same
// wrap `frameIndexAt` applies to the frame itself, applied to the chunk holding
// it. A frame that is not a whole number of frames is frame zero, as everywhere.
function chunkIndex({ urls, framesPerChunk }, frame) {
  const at = Number.isInteger(frame) && frame >= 0 ? Math.floor(frame / framesPerChunk) : 0;
  return ((at % urls.length) + urls.length) % urls.length;
}

/**
 * The smallest tier that carries `wantedPx`, or the largest one there is.
 *
 * "Pick only from what your route offers" — a tier that is not in the map is
 * not in the bucket, and there is no resize service to ask. Falling back to the
 * biggest tier rather than to the original PNG is the whole point of the
 * ladder: 512 is 17x smaller than the strip it came from even when it is not
 * quite enough, and a slightly soft sprite beats an 85 MB decode.
 */
export function pickRendition(renditions, wantedPx) {
  const tiers = Object.entries(renditions ?? {})
    .map(([size, url]) => ({ size: Number(size), url }))
    .filter(({ size, url }) => Number.isFinite(size) && size > 0 && typeof url === 'string' && url)
    .sort((left, right) => left.size - right.size);
  if (tiers.length === 0) return null;
  return tiers.find(({ size }) => size >= wantedPx) ?? tiers.at(-1);
}

/**
 * The sheet to draw this clip from: a rendition when the bundle carries them,
 * the original otherwise.
 *
 * A bundle built before renditions existed still plays — it is the shape the
 * published CDN player was fed, and refusing it would break every story already
 * sitting in a bucket. `tier: null` is how the caller knows to say so once, and
 * `chunks: null` is the same answer about the chunk ladder: whole sheet, today's
 * path, no branch anywhere downstream.
 */
export function sheetFor(clip, wantedPx) {
  const frames = clip?.frames ?? 1;
  const rendition = pickRendition(clip?.renditions, wantedPx);
  if (!rendition) {
    return {
      url: clip?.spritesheet ?? null,
      grid: clip?.grid ?? [frames, 1],
      cellPx: SPRITE_SOURCE_PX,
      tier: null,
      chunks: null,
    };
  }
  return {
    url: rendition.url,
    grid: renditionGrid(frames, clip?.grid),
    cellPx: rendition.size,
    tier: rendition.size,
    chunks: chunkLadder(clip, rendition.size, frames),
  };
}
