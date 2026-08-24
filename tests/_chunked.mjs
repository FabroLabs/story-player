/**
 * A story whose renditions are cut into chunks, written out by hand.
 *
 * The parity corpus cannot answer this one: those seven bundles were published
 * before chunks existed, so nothing in them carries a `rendition_chunks` block.
 * This is the smallest story that has the four shapes a reader has to get right
 * at once — a clip that divides evenly by its chunk length, one that ends in a
 * short padded tail, one shorter than a single chunk, and a clip that is not on
 * stage when the scene opens.
 *
 * The numbers are the engine's, not this file's: `frames_per_chunk` is the
 * frozen table `tools/playerkit/renditions.py` encodes against, and the keys are
 * named the way the catalog names them — content-addressed in the bucket, but a
 * reader only ever treats them as opaque strings.
 */

import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';

const BUCKET = 'fairytale-assets';

export const TIERS = [200, 320, 384, 512];

// FROZEN with the encoder (`chunk_frames` in `tools/playerkit/renditions.py`):
// the longest run of frames whose decoded bitmap still fits the per-chunk share
// of a small device's budget.
export const FRAMES_PER_CHUNK = { 200: 25, 320: 9, 384: 6, 512: 4 };

// 60 cm of character is 600 stage pixels drawn, which no tier below 512 carries
// — so a viewport of nothing still lands on the tier the chunks matter most at.
const HEIGHT_CM = 60;

// 81 frames is the forest catalog's longest clip and the whole reason for this
// phase: at 512 px it re-grids to 4608x4608, which is 85 MB decoded against the
// 48 MB a small device is given. 24 divides by every chunk length; 9 and 3 do
// not, and 3 is shorter than one chunk at any tier.
export const CLIP_FRAMES = {
  'pip idle': 24, 'pip wave': 9, 'bo idle': 81, 'moss idle': 3,
};

export const POSTER = `${BUCKET}/plates/dell.jpg`;

/** Every chunk key of one clip at one tier, in frame order. */
export function chunkKeys(name, frames, size) {
  const framesPerChunk = FRAMES_PER_CHUNK[size];
  return Array.from(
    { length: Math.ceil(frames / framesPerChunk) },
    (_, index) => `${BUCKET}/mobile/sprites/${name}-${size}-c${index}.webp`,
  );
}

export function sheetKey(name, size) {
  return `${BUCKET}/mobile/sprites/${name}-${size}.webp`;
}

function clip(name, frames) {
  return {
    spritesheet: `${BUCKET}/sprites/${name}/spritesheet.png`,
    atlas: null,
    frames,
    fps: 12,
    grid: [frames, 1],
    renditions: Object.fromEntries(TIERS.map((size) => [size, sheetKey(name, size)])),
    rendition_chunks: Object.fromEntries(TIERS.map((size) => [size, {
      frames_per_chunk: FRAMES_PER_CHUNK[size],
      keys: chunkKeys(name, frames, size),
    }])),
  };
}

/**
 * Three characters in one dell. Pip is put down idling and waves partway
 * through — so `pip wave` is a clip the scene draws but does not OPEN on, which
 * is the distinction the gate is built around. Bo idles on the long clip, moss
 * on three frames, less than one chunk at any tier.
 */
export function chunkedStory() {
  const idler = (name, frames, extra = {}) => ({
    height_cm: HEIGHT_CM,
    capability: { idle: { camera: 'idle' }, ...extra.capability },
    clips: { idle: clip(name, frames), ...extra.clips },
  });
  return {
    storylang_version: 0,
    title: 'Three in the dell',
    cast: {
      pip: idler('pip-idle', CLIP_FRAMES['pip idle'], {
        capability: { wave: { camera: 'wave' } },
        clips: { wave: clip('pip-wave', CLIP_FRAMES['pip wave']) },
      }),
      bo: idler('bo-idle', CLIP_FRAMES['bo idle']),
      moss: idler('moss-idle', CLIP_FRAMES['moss idle']),
    },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      place: 'dell',
      plate: { poster: POSTER, video: `${BUCKET}/plates/dell.mp4` },
      steps: [
        { kind: 'cmd', cmd: 'put', subjects: ['pip'], line: 1 },
        { kind: 'cmd', cmd: 'put', subjects: ['bo'], line: 2 },
        { kind: 'cmd', cmd: 'put', subjects: ['moss'], line: 3 },
        { kind: 'chunk', text: 'The dell was quiet.', duration_s: 6, line: 4 },
        { kind: 'cmd', cmd: 'emote', subjects: ['pip'], emotion: 'wave', line: 5 },
        { kind: 'chunk', text: 'Pip waved.', duration_s: 6, line: 6 },
      ],
    }],
  };
}

export function chunkedFixture() {
  const bundle = chunkedStory();
  return { bundle, timeline: compileTimeline(bundle) };
}

/**
 * The same dell, opening on a line of narration with nobody on it yet.
 *
 * An ordinary bedtime shape, and the one that catches a gate reading "the
 * scene's opening" as "the first instant sampled": every scene begins with a
 * `scene` op and a subtitle at t=0, so a scene whose cast arrives a beat later
 * opens on an empty stage.
 */
export function lateEntryFixture() {
  const bundle = chunkedStory();
  bundle.scenes[0].steps = [
    { kind: 'chunk', text: 'The dell was quiet.', duration_s: 3, line: 1 },
    { kind: 'cmd', cmd: 'put', subjects: ['pip'], line: 2 },
    { kind: 'cmd', cmd: 'put', subjects: ['bo'], line: 3 },
    { kind: 'chunk', text: 'Then they came.', duration_s: 3, line: 4 },
  ];
  return { bundle, timeline: compileTimeline(bundle) };
}

/** The same story with the chunk ladders taken off: the whole-sheet path. */
export function withoutChunks(bundle) {
  const stripped = structuredClone(bundle);
  for (const character of Object.values(stripped.cast)) {
    for (const held of Object.values(character.clips)) delete held.rendition_chunks;
  }
  return stripped;
}

/**
 * The grid every object of this story is laid out on, written out by hand.
 *
 * Hand-computed and not asked of `renditionGrid`/`chunkGrid`, which are the
 * functions under test: a fixture that derives its own expectations from the
 * code cannot fail when the code is wrong. `nearSquare(n)` is
 * `[ceil(sqrt n), ceil(n / that)]`, applied to the frame count for a whole
 * sheet and to `min(frames_per_chunk, frames)` for a chunk.
 */
const GRIDS = {
  81: { sheet: [9, 9], chunk: { 200: [5, 5], 320: [3, 3], 384: [3, 2], 512: [2, 2] } },
  24: { sheet: [5, 5], chunk: { 200: [5, 5], 320: [3, 3], 384: [3, 2], 512: [2, 2] } },
  9: { sheet: [3, 3], chunk: { 200: [3, 3], 320: [3, 3], 384: [3, 2], 512: [2, 2] } },
  3: { sheet: [2, 2], chunk: { 200: [2, 2], 320: [2, 2], 384: [2, 2], 512: [2, 2] } },
};

/**
 * What every asset of this story decodes to, in pixels.
 *
 * The one place the sizes are stated, because the whole point of the fixture is
 * the BYTES: a chunk at 512 is a 1024x1024 bitmap and the whole sheet it came
 * from is 2560x2560, and a cache budget cannot tell the difference unless a
 * decode does.
 */
export function decodedSizes(bundle) {
  const sizes = new Map([[POSTER, { width: 1920, height: 1080 }]]);
  for (const character of Object.values(bundle.cast)) {
    for (const held of Object.values(character.clips)) {
      const grids = GRIDS[held.frames];
      for (const size of TIERS) {
        const [wide, tall] = grids.sheet;
        sizes.set(held.renditions[size], { width: wide * size, height: tall * size });
        const [chunkWide, chunkTall] = grids.chunk[size];
        for (const key of held.rendition_chunks?.[size]?.keys ?? []) {
          sizes.set(key, { width: chunkWide * size, height: chunkTall * size });
        }
      }
    }
  }
  return sizes;
}

/** A decode that lands immediately and costs what the real bitmap would. */
export function decodeFrom(sizes) {
  return async (url) => {
    const size = sizes.get(url);
    if (!size) throw new Error(`asset ${url} answered 404`);
    return { ...size, close() {} };
  };
}
