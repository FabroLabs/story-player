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
 *
 * What a scene KEEPS is a smaller question than what it loads, and since the
 * renditions are cut into chunks the two are no longer the same list. A scene
 * that pinned every sheet it can draw asked for 158 to 406 MB against a 48 to
 * 96 MB budget, so eviction thrashed and the same sheet was fetched eight times.
 * Now the pinned set is the poster, the props and — per character on stage — the
 * chunk under their playhead plus the next: `sceneKeepUrls`, re-asked by the
 * runtime on `KEEP_CADENCE_MS`. A bundle with no chunk ladder keeps its sheets
 * whole, exactly as it always did.
 */

import { zoneNamed } from '../../core/geometry.mjs';
import { stateAt } from '../../core/state/state.mjs';
import { PAN_SCALE_FLOOR, PUSH_SCALE } from '../../policy.mjs';
import { drawnSpriteHeightPx } from '../stage/presentation-policy.mjs';
import { KEEP_WINDOW, chunkWindow, sheetFor, wantedCellPx } from './rendition-picker.mjs';

/**
 * How often the runtime re-asks which chunks are under the playhead.
 *
 * The shortest chunk a clip can hold the stage with is four frames — the 512 px
 * step — at 24 fps, which is 166 ms, and the window has to be re-read at least
 * twice inside one or the next chunk is asked for after it is already being
 * drawn. That law is pinned in `tests/scene-loader.test.mjs` against the
 * fastest clip the corpus actually carries, so a future 30 fps clip fails here
 * rather than stalling in a browser.
 *
 * It lives here rather than in `policy.mjs` because it is the cadence of THIS
 * module's window, not a number the story language or the stage knows about.
 */
export const KEEP_CADENCE_MS = 80;

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
  const { drawnHeights, openingFrames } = measureDrawnHeights(timeline, bundle, sceneIndex, events);

  const sheets = [];
  for (const [key, drawnHeightPx] of drawnHeights) {
    const [slug, clipKey] = splitKey(key);
    const clip = bundle?.cast?.[slug]?.clips?.[clipKey];
    if (!clip) continue;
    const wantedPx = wantedCellPx({ drawnHeightPx, cameraScale, ...viewport });
    const sheet = sheetFor(clip, wantedPx);
    if (!sheet.url) continue;
    sheets.push({
      slug,
      clip: clipKey,
      drawnHeightPx,
      wantedPx,
      // The frame this clip stands at when the scene opens, or null for a clip
      // that comes on later. It is what the GATE holds a window around: the
      // begin button waits for the picture the viewer is about to see, not for
      // every pose the scene reaches in the next forty seconds.
      openingFrame: openingFrames.get(key) ?? null,
      // A chunk ladder the reader had to refuse (see `sheetFor`). The plan is
      // pure, so it records it and `reportLegacySheets` is what says it out loud.
      chunksRefused: sheet.tier !== null && clip.rendition_chunks != null && sheet.chunks === null,
      ...sheet,
    });
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
 *
 * A chunked clip is not fetched whole. `window` is how many chunks the clips on
 * stage at the opening are worth: two at the GATE, because those are the frames
 * about to be drawn, and one everywhere else — a scene warmed ahead needs the
 * chunk it opens on, not the loop it settles into. Every other clip in the scene
 * gets its first chunk either way, so the pose a character walks on with is in
 * the browser's cache before the story reaches it. What is FETCHED here is not
 * what is KEPT: see `sceneKeepUrls`.
 */
export function planAssets(plan, { window = 1 } = {}) {
  const assets = [];
  const add = (asset) => {
    if (typeof asset.url === 'string' && asset.url && !assets.some((held) => held.url === asset.url)) {
      assets.push(asset);
    }
  };
  add({ url: plan.poster, asset: 'poster' });
  for (const sheet of plan.sheets) {
    const opens = Number.isInteger(sheet.openingFrame);
    for (const url of chunkWindow(sheet, sheet.openingFrame ?? 0, opens ? window : 1)) {
      add({ url, asset: 'sheet', slug: sheet.slug, clip: sheet.clip });
    }
  }
  for (const prop of plan.props) add({ url: prop.url, asset: 'prop', slug: prop.slug });
  return assets;
}

/**
 * What may not be evicted while this scene is the scene on screen.
 *
 * This is the list the whole memory budget is sized against: the poster (7.9 MB
 * decoded, and charged before a single sheet), the props, and — per character
 * actually on stage — the chunk under their playhead plus the next. Five
 * characters at 4 MB a chunk is 40 MB, which is what fits beside the poster in
 * the 48 MB a small device gets. Keeping one chunk more per clip is how that
 * budget is missed.
 *
 * `actors` is `stateAt`'s answer for the instant being drawn. Without it — at
 * the gate, before there is a first frame — the plan's own opening frames stand
 * in, which is the same window one tick earlier.
 *
 * An UNCHUNKED sheet is kept whole, exactly as every sheet was before chunks
 * existed: a bundle with no chunk ladder is a bundle whose memory behaviour must
 * not change under it.
 */
export function sceneKeepUrls(plan, actors = null) {
  return keepAssets(plan, actors).map(({ url }) => url);
}

/**
 * The same list, each entry carrying what it IS.
 *
 * `planAssets` names its assets so a failure can say `poster` rather than
 * `asset`, and the window is now the path most of a scene's objects are fetched
 * through — so it names them too. A chunk that will not load names the character
 * and clip it belongs to; the URL alone is content-addressed and tells a reader
 * nothing.
 */
function keepAssets(plan, actors = null) {
  const assets = [];
  const add = (asset) => {
    if (typeof asset.url === 'string' && asset.url && !assets.some((held) => held.url === asset.url)) {
      assets.push(asset);
    }
  };
  add({ url: plan?.poster, asset: 'poster' });
  // The props ON STAGE, not every prop the scene ever places. The budget has
  // 92 KB of slack at the engine's own worst case (five characters, two chunks
  // each, beside the poster), and a 256 px SVG is four times that — so a lantern
  // put down in the first line and taken away in the second must not still be
  // pinned in the last. Before there is a first frame, the plan's list is all
  // there is, and it was what the gate decoded anyway.
  //
  // Only where a chunk ladder made the budget tight. A whole-sheet scene pins
  // its sheets entire — that IS its cost — and on the stories that already
  // exceed the budget with them, the un-pinned props are the only thing
  // eviction can reach: dropped on the first frame, and back as a placeholder
  // in the line that puts them down.
  const cutUp = (plan?.sheets ?? []).some((sheet) => sheet.chunks);
  const onStage = actors === null || !cutUp
    ? null
    : new Set(actors.map((actor) => actor.slug));
  for (const prop of plan?.props ?? []) {
    if (onStage === null || onStage.has(prop.slug)) add({ url: prop.url, asset: 'prop', slug: prop.slug });
  }

  const chunked = new Map();
  for (const sheet of plan?.sheets ?? []) {
    if (!sheet.chunks) {
      add({ url: sheet.url, asset: 'sheet', slug: sheet.slug, clip: sheet.clip });
      continue;
    }
    chunked.set(makeKey(sheet.slug, sheet.clip), sheet);
    if (actors === null && Number.isInteger(sheet.openingFrame)) {
      for (const url of chunkWindow(sheet, sheet.openingFrame)) {
        add({ url, asset: 'sheet', slug: sheet.slug, clip: sheet.clip });
      }
    }
  }
  for (const actor of actors ?? []) {
    const sheet = chunked.get(makeKey(actor.slug, actor.clip));
    if (!sheet) continue;
    for (const url of chunkWindow(sheet, actor.frame ?? 0)) {
      add({ url, asset: 'sheet', slug: sheet.slug, clip: sheet.clip });
    }
  }
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
  const openingFrames = new Map();
  const plate = bundle?.scenes?.[sceneIndex]?.plate ?? null;
  let opened = false;
  for (const tMs of sampleInstants(events)) {
    const picture = stateAt(timeline, bundle, tMs);
    // A sample landing on the next scene's cut belongs to that scene, not this
    // one: its cast is already gone.
    if (picture.sceneIndex !== sceneIndex) continue;
    let cast = false;
    for (const actor of picture.actors) {
      if (actor.kind !== 'character' || !actor.clip || actor.clipMissing) continue;
      const key = makeKey(actor.slug, actor.clip);
      const settled = drawnSpriteHeightPx(bundle?.cast?.[actor.slug]?.height_cm, zoneNamed(plate, actor.band));
      heights.set(key, Math.max(heights.get(key) ?? 0, actor.heightPx, settled));
      // The first sample with anybody IN it is the scene opening — NOT simply
      // the first sample. Every scene begins with a `scene` op and a subtitle,
      // and a scene that opens on a line of narration puts its cast a beat
      // later: counted from the first sample, that scene would open with an
      // empty stage and the gate would keep none of the sprites it is about to
      // draw. The frame is read rather than assumed to be zero because nothing
      // in the state core promises a clip begins at the instant it is sampled.
      if (!opened) openingFrames.set(key, Number.isInteger(actor.frame) ? actor.frame : 0);
      cast = true;
    }
    if (cast) opened = true;
  }
  return { drawnHeights: heights, openingFrames };
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
  // What failed since the last scene opened. Separate from `warned`, which is
  // about the LOG — a second line about the same broken object helps nobody, but
  // a second attempt at it, minutes later on a link that has come back, is the
  // difference between a character frozen on a stand-in and a story that
  // recovers.
  let refused = new Set();
  // The story as it stands, because a streaming host grows it under us. The
  // plan cache deliberately survives the swap: an appended scene never moves an
  // earlier scene's events (`tests/compile-prefix.test.mjs` is that promise),
  // so every plan already answered is still the answer.
  let story = { timeline, bundle };
  let warming = null;

  return { plan, loadScene, holdScene, queueRemainingScenes, sceneCount, setStory };

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
    // `keep` is what tells the two callers apart: the scene being OPENED is the
    // one whose opening chunks are about to be drawn, and the ones being warmed
    // ahead only need the chunk they will open on.
    const assets = planAssets(scenePlan, { window: keep ? KEEP_WINDOW : 1 });
    // Deliberately not `assets`: the gate FETCHES the first chunk of every clip
    // in the scene so a character walking on later does not wait for one, and
    // KEEPS only the window the budget is sized for. Everything else is
    // evictable the moment the cache is under pressure.
    if (keep) {
      cache.keep(sceneKeepUrls(scenePlan));
      refused = new Set();
    }

    throwIfAborted(signal);
    const total = assets.length;
    let done = 0;
    let failed = 0;
    onProgress(0, total);
    if (total === 0) return { total: 0, failed: 0 };

    const fetchOne = async ({ url, ...what }) => {
      const landed = await attempt(url, what);
      if (!landed) failed += 1;
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

  /**
   * Hold the window the playhead is inside, and fetch what is not in it yet.
   *
   * Called by the runtime on a cadence rather than per frame — the answer only
   * changes when a chunk boundary is crossed, and rebuilding a keep set at 24 Hz
   * to say the same thing is work a slow device does not have to spare.
   *
   * The fetch is what makes the window worth having: asking for the NEXT chunk
   * while the current one draws is the difference between a decode that lands
   * before it is needed and a character frozen on their last cell.
   *
   * Answers a promise for what it started fetching, or `null` when the window
   * was already resident. A RUNNING story ignores it and draws what landed on
   * its next frame; a paused one has no next frame, and this is how it knows to
   * take one — the same repaint `loadScene` earns at a scene cut.
   */
  function holdScene(sceneIndex, viewport = {}, actors = null) {
    const scenePlan = plan(sceneIndex, viewport);
    const wanted = keepAssets(scenePlan, actors);
    cache.keep(wanted.map(({ url }) => url));
    const landing = [];
    for (const { url, ...what } of wanted) {
      // `refused` is the do-not-retry list for THIS scene. Without it a 404
      // chunk would be asked for again every cadence tick until the scene ends
      // — the cache deliberately remembers no failure, so nothing else stops it
      // — and with it a link that dropped for one object gets a fresh chance
      // the next time a scene opens, which is the cache's own promise.
      if (cache.has(url) || refused.has(url)) continue;
      landing.push(attempt(url, what));
    }
    // Null rather than a resolved promise: the caller repaints on what lands,
    // and a hold that asked for nothing must not schedule a frame — including
    // the frame that this repaint itself would hold from.
    return landing.length > 0 ? Promise.all(landing) : null;
  }

  /**
   * One asset, decoded; `false` when it failed and was named in the log.
   *
   * The signal is the authority on "the player was destroyed", not the error's
   * name: a fetch cancelled by the browser under memory pressure and an
   * `img.decode()` that gives up both arrive named `AbortError`, and treating
   * those as a teardown would reject the gate — leaving the begin button
   * disabled for good with nothing in the log to say why.
   */
  async function attempt(url, what) {
    try {
      await cache.load(url, { signal });
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      refused.add(url);
      // Once per URL: a sheet two clips share must not be two lines in the log,
      // and a scene re-planned at a new size must not repeat itself.
      warnOnce(url, {
        type: 'media', ...what, url, message: error?.message ?? 'asset failed',
      });
      return false;
    }
  }

  // Said once per clip, not once per scene it appears in: a legacy bundle would
  // otherwise fill the log with the same sentence about the same sheet.
  function reportLegacySheets(scenePlan) {
    for (const sheet of scenePlan.sheets) {
      if (sheet.chunksRefused) {
        // Loud because it is a BUILD fault, not a shape a bundle is allowed to
        // have. Two ways in, and the message covers both: a key list that does
        // not match the clip's frame count (reading it would draw the wrong
        // frames rather than fail), and a clip whose ladder skips the tier this
        // viewport chose (the engine emits all four or none). The whole sheet is
        // drawn instead — correct, and the memory budget this clip was cut up
        // for is the thing that is lost.
        warnOnce(`chunks:${sheet.url}`, {
          type: 'media',
          asset: 'sheet',
          slug: sheet.slug,
          clip: sheet.clip,
          message: `chunk ladder unusable at ${sheet.tier} px; drawing from the whole rendition`,
        });
      }
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
