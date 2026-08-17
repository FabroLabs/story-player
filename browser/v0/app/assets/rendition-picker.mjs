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
 */

import { SPRITE_SOURCE_PX } from '../stage/presentation-policy.mjs';

// A 3x-density phone asks for three times the pixels of a 1x laptop for the
// same picture, and the ladder stops at 512. Past 2 the extra tier is either
// absent or invisible, so the cap is where the honest ceiling already is.
export const DPR_CAP = 2;

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
 * sitting in a bucket. `tier: null` is how the caller knows to say so once.
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
    };
  }
  return {
    url: rendition.url,
    grid: renditionGrid(frames, clip?.grid),
    cellPx: rendition.size,
    tier: rendition.size,
  };
}
