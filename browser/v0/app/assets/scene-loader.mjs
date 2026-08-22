/**
 * What a scene needs on screen, decoded before it is asked for.
 *
 * The module this replaces had to GUESS: it read a scene's steps, collected the
 * verbs they named, and expanded them through the capability table to the clips
 * the facing ladder might pick. It guessed because nothing else existed — the
 * schedule was traced live, so there was no list of what would actually be
 * shown until it had been shown.
 *
 * There is one now. Every clip a scene can put on screen is on the wire as the
 * `clip` field of a `place`, `move`, `settle`, `clip` or `depart` op carrying
 * that `scene_index`, and the height it is drawn at — the thing that decides
 * which rendition tier is enough — is `stateAt`'s answer at that op's instant.
 * So the set is read, not inferred, and it is exactly the set the canvas will
 * draw from.
 *
 * Two rules survive from the old module, because they were about the viewer
 * rather than about the machinery:
 *
 *   the FIRST scene is a gate — the begin button waits for it
 *   every later scene is a queue — one at a time, during playback
 *
 * What does not survive is the first-frame subset. Gating on all of scene 1 was
 * 64 MB of full-size PNG, so the gate covered the poster and the idles only;
 * at the chosen tier the whole scene is single-digit megabytes, and one set
 * with one progress count is both simpler and honest about what is ready.
 *
 * The plate VIDEO is still not here. It streams, and holding a begin button
 * open for tens of megabytes would defeat the point of having one. The poster
 * is, because the poster is what a viewer looks at until the video arrives.
 */

import { zoneNamed } from '../../core/geometry.mjs';
import { stateAt } from '../../core/state/state.mjs';
import { PAN_SCALE_FLOOR, PUSH_SCALE } from '../../policy.mjs';
import { drawnSpriteHeightPx } from '../stage/presentation-policy.mjs';
import { sheetFor, wantedCellPx } from './rendition-picker.mjs';

/**
 * Everything scene `sceneIndex` draws, at the tier this viewport needs.
 *
 * Pure: it reads the timeline and the bundle and asks `stateAt`, and touches no
 * network, no DOM and no clock. `viewport` is `{ fitScale, dpr, dprCap }`.
 */
export function sceneAssetPlan(timeline, bundle, sceneIndex, viewport = {}) {
  const events = (timeline?.events ?? [])
    .filter((event) => event.source === 'stage' && event.scene_index === sceneIndex);
  const cameraScale = maxCameraScale(events);
  const drawnHeights = measureDrawnHeights(timeline, bundle, sceneIndex, events);

  const sheets = [];
  for (const [key, drawnHeightPx] of drawnHeights) {
    const [slug, clipKey] = splitKey(key);
    const clip = bundle?.cast?.[slug]?.clips?.[clipKey];
    if (!clip) continue;
    const wantedPx = wantedCellPx({ drawnHeightPx, cameraScale, ...viewport });
    const sheet = sheetFor(clip, wantedPx);
    if (!sheet.url) continue;
    sheets.push({ slug, clip: clipKey, drawnHeightPx, wantedPx, ...sheet });
  }

  const props = [];
  for (const event of events) {
    if (event.op !== 'place_object') continue;
    const url = bundle?.objects?.[event.slug]?.svg;
    if (typeof url === 'string' && url && !props.some((prop) => prop.url === url)) {
      props.push({ slug: event.slug, url });
    }
  }

  return {
    sceneIndex,
    cameraScale,
    poster: bundle?.scenes?.[sceneIndex]?.plate?.poster ?? null,
    sheets,
    props,
  };
}

/**
 * The plan's assets in the order a slow link should deliver them.
 *
 * The poster first: it is the one thing a viewer sees behind everything else,
 * so on a slow link it is the frame that stops the stage being a dark
 * rectangle. Then the sheets in the order the scene needs them, then props.
 * Each carries what it is, so a failure can say `poster` rather than `asset`.
 */
export function planAssets(plan) {
  const assets = [];
  const add = (asset) => {
    if (typeof asset.url === 'string' && asset.url && !assets.some((held) => held.url === asset.url)) {
      assets.push(asset);
    }
  };
  add({ url: plan.poster, asset: 'poster' });
  for (const sheet of plan.sheets) {
    add({ url: sheet.url, asset: 'sheet', slug: sheet.slug, clip: sheet.clip });
  }
  for (const prop of plan.props) add({ url: prop.url, asset: 'prop', slug: prop.slug });
  return assets;
}

/**
 * The largest magnification this scene ever reaches.
 *
 * Not a sweep over time, and it does not need to be: a push and a pan both ask
 * for `max(held, their own floor)` so neither can exceed a maximum already set,
 * a pull-out and a reset go home to 1, and a shot carries its scale on the
 * wire. The running maximum is therefore the maximum of those numbers, and the
 * easing between two framings never overshoots either end.
 */
export function maxCameraScale(events) {
  let scale = 1;
  for (const event of events) {
    if (event.op === 'push_in') scale = Math.max(scale, PUSH_SCALE);
    else if (event.op === 'pan') scale = Math.max(scale, PAN_SCALE_FLOOR);
    else if (event.op === 'shot' && Number.isFinite(event.scale)) scale = Math.max(scale, event.scale);
  }
  return scale;
}

/**
 * The tallest each `slug`/`clip` pair is ever drawn during this scene.
 *
 * Sampled at every op instant and at the far end of every op that carries a
 * duration: a clip only changes at an op, so every pair is seen, and a walk's
 * size ramps linearly between the two bands it joins.
 *
 * The ramp is where sampling alone is not enough, and the fix is not more
 * samples. A crowding shove restarts a walk's ramp at the shove's instant with
 * the walk's original duration, so the ramp now ends AFTER the far end this
 * samples — and a mid-walk clip change cancels the `settle` that would have
 * sampled the arrival height anyway. Both are ordinary stories (walk toward the
 * camera, emote on the way, somebody else put down where you are heading), and
 * they would plan the sprite from a height it passes through rather than the
 * one it arrives at: one tier soft, with nothing to show for it.
 *
 * So each actor is measured twice at every instant: what is DRAWN now, and what
 * they stand at when they get where they are going. The second is exact and
 * free — the picture carries the actor's model band from the moment the walk
 * starts, and a band plus their centimetres is the whole size law. Nothing in
 * between the two can be bigger than both.
 */
function measureDrawnHeights(timeline, bundle, sceneIndex, events) {
  const heights = new Map();
  const plate = bundle?.scenes?.[sceneIndex]?.plate ?? null;
  for (const tMs of sampleInstants(events)) {
    const picture = stateAt(timeline, bundle, tMs);
    // A sample landing on the next scene's cut belongs to that scene, not this
    // one: its cast is already gone.
    if (picture.sceneIndex !== sceneIndex) continue;
    for (const actor of picture.actors) {
      if (actor.kind !== 'character' || !actor.clip || actor.clipMissing) continue;
      const key = makeKey(actor.slug, actor.clip);
      const settled = drawnSpriteHeightPx(bundle?.cast?.[actor.slug]?.height_cm, zoneNamed(plate, actor.band));
      heights.set(key, Math.max(heights.get(key) ?? 0, actor.heightPx, settled));
    }
  }
  return heights;
}

function sampleInstants(events) {
  const instants = new Set();
  for (const event of events) {
    if (!Number.isFinite(event.t_ms)) continue;
    instants.add(event.t_ms);
    if (Number.isFinite(event.duration_ms)) instants.add(event.t_ms + event.duration_ms);
  }
  return [...instants].sort((left, right) => left - right);
}

// A slug and a clip key are both bundle identifiers, so a space cannot occur in
// either — and the split takes the FIRST one regardless, so a key that somehow
// carried one would still come back whole rather than truncated.
const KEY_SEPARATOR = ' ';
const makeKey = (slug, clip) => `${slug}${KEY_SEPARATOR}${clip}`;
const splitKey = (key) => {
  const at = key.indexOf(KEY_SEPARATOR);
  return [key.slice(0, at), key.slice(at + 1)];
};

/**
 * The scene loader: plans, fetches, decodes, and reports progress.
 *
 * Every media value it reads is already an absolute URL — `resolveStoryAssets`
 * qualified and validated the whole bundle at mount, renditions included, and
 * `appendStoryScene` does the same for every scene published after it — so
 * nothing here builds a URL, and nothing here can be talked into leaving the
 * asset base. Both doors, because a story that grows arrives through the
 * second one.
 */
export function createSceneLoader({
  timeline, bundle, cache, signal = null, onWarning = () => {},
}) {
  const plans = new Map();
  const warned = new Set();
  // The story as it stands, because a streaming host grows it under us. The
  // plan cache deliberately survives the swap: an appended scene never moves an
  // earlier scene's events (`tests/compile-prefix.test.mjs` is that promise),
  // so every plan already answered is still the answer.
  let story = { timeline, bundle };
  let warming = null;

  return { plan, loadScene, queueRemainingScenes, sceneCount, setStory };

  /** The host published another scene: everything below plans from it now. */
  function setStory(next) {
    story = { timeline: next.timeline, bundle: next.bundle };
  }

  function sceneCount() {
    return story.bundle?.scenes?.length ?? 0;
  }

  function plan(sceneIndex, viewport = {}) {
    const key = `${sceneIndex}:${viewport.fitScale ?? 1}:${viewport.dpr ?? 1}:${viewport.dprCap ?? ''}`;
    if (!plans.has(key)) plans.set(key, sceneAssetPlan(story.timeline, story.bundle, sceneIndex, viewport));
    return plans.get(key);
  }

  /**
   * Decode everything scene `sceneIndex` draws, then report what failed.
   *
   * Never rejects on a broken asset, and never leaves the gate shut: a 404
   * sheet settles like any other, because refusing to start a story over one
   * missing sprite is worse than the placeholder the canvas draws instead.
   * An abort is the one exception — that is the player being destroyed.
   */
  async function loadScene(sceneIndex, viewport = {}, {
    onProgress = () => {}, keep = false, concurrency = 0,
  } = {}) {
    const scenePlan = plan(sceneIndex, viewport);
    reportLegacySheets(scenePlan);
    const assets = planAssets(scenePlan);
    if (keep) cache.keep(assets.map(({ url }) => url));

    throwIfAborted(signal);
    const total = assets.length;
    let done = 0;
    let failed = 0;
    onProgress(0, total);
    if (total === 0) return { total: 0, failed: 0 };

    const fetchOne = async ({ url, ...what }) => {
      try {
        await cache.load(url, { signal });
      } catch (error) {
        // The signal is the authority on "the player was destroyed", not the
        // error's name: a fetch cancelled by the browser under memory pressure
        // and an `img.decode()` that gives up both arrive named `AbortError`,
        // and treating those as a teardown would reject the gate — leaving the
        // begin button disabled for good with nothing in the log to say why.
        if (signal?.aborted) throw error;
        failed += 1;
        // Once per URL: a sheet two clips share must not be two lines in the
        // log, and a scene re-planned at a new size must not repeat itself.
        warnOnce(url, {
          type: 'media', ...what, url, message: error?.message ?? 'asset failed',
        });
      }
      throwIfAborted(signal);
      done += 1;
      onProgress(done, total);
    };

    // `concurrency: 0` means all at once, which is right for the GATE —
    // somebody is watching a progress line and nothing else is competing for
    // the link. The background queue passes 1, because it runs while narration
    // and the plate video are streaming and a burst of sheets would starve them.
    if (concurrency < 1) {
      await Promise.all(assets.map(fetchOne));
    } else {
      const queue = [...assets];
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) await fetchOne(queue.shift());
      });
      await Promise.all(workers);
    }
    return { total, failed };
  }

  /**
   * Warm every scene after `fromIndex`, in playing order, one at a time.
   *
   * Sequential rather than parallel, and that is the whole design: this runs
   * DURING playback, and thirty requests at a slow link would starve the audio
   * and the video the viewer is waiting on right now. The runtime that starts
   * it is phase 8's.
   *
   * Warm is best-effort by construction: nothing is kept, so a later scene's
   * decode may evict an earlier one, and what a scene reports here is what was
   * decoded, not what is still resident when that scene finally opens. The
   * scene's own `loadScene` on the way in is what guarantees residency — this
   * only makes it fast.
   */
  async function queueRemainingScenes(fromIndex, viewport = {}, { onScene = () => {} } = {}) {
    // One queue at a time, however many times a growing story asks: a run
    // already under way reaches the scene that just landed on its own, because
    // the count below is asked again every turn. It answers for its own failure
    // too — handing the same rejection to a second caller would write one
    // broken plan into the log twice, which breaks the same law as never
    // writing it.
    if (warming) return warming.then(() => {}, () => {});
    warming = warmFrom(fromIndex, viewport, onScene);
    return warming;
  }

  async function warmFrom(fromIndex, viewport, onScene) {
    try {
      for (let index = fromIndex; index < sceneCount(); index += 1) {
        // Asked again for every scene when the caller passes a function: the
        // queue outlives a tier demotion and a resize, and the sheets a scene
        // is warmed with have to be the ones it will be opened with.
        const view = typeof viewport === 'function' ? viewport() : viewport;
        const result = await loadScene(index, view, { concurrency: 1 });
        throwIfAborted(signal);
        onScene(index, result.total);
      }
    } finally {
      // Released in the turn the loop ends in rather than a microtask later: a
      // call landing in that gap would be answered by a run that had already
      // walked past the scene it is asking about, and that scene would never be
      // warmed at all.
      warming = null;
    }
  }

  // Said once per clip, not once per scene it appears in: a legacy bundle would
  // otherwise fill the log with the same sentence about the same sheet.
  function reportLegacySheets(scenePlan) {
    for (const sheet of scenePlan.sheets) {
      if (sheet.tier !== null) continue;
      warnOnce(`legacy:${sheet.url}`, {
        type: 'media',
        asset: 'sheet',
        slug: sheet.slug,
        clip: sheet.clip,
        message: 'no renditions in this bundle; drawing from the full-size sheet',
      });
    }
  }

  function warnOnce(key, detail) {
    if (warned.has(key)) return;
    warned.add(key);
    onWarning(detail);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('player destroyed', 'AbortError');
}
