/**
 * What a scene needs on screen, fetched before it is asked for.
 *
 * Nothing preloaded before this. `#verifySprite` started an `Image` the first
 * time a clip was applied, so every sheet arrived while the scene that wanted
 * it was already playing — measured against the real bucket at ~290 KB/s, a
 * 1 MB sheet takes 3.7 s and the renderer's own 5 s deadline fires on most of
 * them. The picture assembles itself in front of the viewer.
 *
 * Two rules, and the second is why this is not simply "fetch everything":
 *
 *   the FIRST scene is a gate — the begin button waits for it
 *   every later scene is a queue — fetched in order, during playback
 *
 * A story's whole sprite set is far too much to gate on: this bundle carries
 * 70 sheets across four characters, and a viewer would stare at a spinner for
 * minutes. So a scene's set is derived from what that scene actually does —
 * the verbs its steps name, plus idle, resolved through the capability table
 * to the handful of clips the facing ladder can pick from. Everything else is
 * still lazy, and still warns if it is late.
 *
 * The plate VIDEO is deliberately not here. It streams, `#loadPlate` already
 * waits on `canplay` with its own deadline, and holding the gate open for tens
 * of megabytes would defeat the point. The poster is, because the poster is
 * what a viewer looks at until the video is ready.
 */

/** Characters this scene puts, moves, emotes or travels — in first-seen order. */
function castOf(scene) {
  const slugs = [];
  const walk = (steps) => {
    for (const step of steps ?? []) {
      if (step.kind === 'together') {
        walk(step.steps);
        continue;
      }
      for (const slug of step.subjects ?? []) if (!slugs.includes(slug)) slugs.push(slug);
    }
  };
  walk(scene.steps);
  return slugs;
}

/** The verbs a scene can ask of a character: always idle, plus what it names. */
function verbsOf(scene, slug) {
  const verbs = new Set(['idle']);
  const walk = (steps) => {
    for (const step of steps ?? []) {
      if (step.kind === 'together') {
        walk(step.steps);
        continue;
      }
      if (!(step.subjects ?? []).includes(slug)) continue;
      if (step.cmd === 'emote' && step.emotion) verbs.add(step.emotion);
      // a walk picks a locomotion clip, and a travel walks off the same way
      if (step.cmd === 'move' || step.cmd === 'travel') {
        verbs.add('move');
        verbs.add('walk');
        verbs.add('fly');
      }
    }
  };
  walk(scene.steps);
  return verbs;
}

/**
 * Every asset URL this scene can put on screen, deduped, poster first.
 *
 * Poster first on purpose: it is the one thing a viewer sees behind
 * everything else, so on a slow link it is the frame that stops the stage
 * being a dark rectangle.
 */
/**
 * The subset a viewer sees in the scene's FIRST frame: the poster, each
 * character's idle, and any prop put there.
 *
 * This is what the begin button waits for, and the split is forced by
 * measurement, not taste. Gating on everything scene 1 can reach is 20 assets
 * and **64 MB** against this bucket — 221 s of spinner in front of a
 * four-minute story. First paint is 7 assets and 14 MB. The rest of the scene
 * is still fetched before any later scene, so it arrives during the opening
 * narration rather than when a face needs to change.
 *
 * The honest fix is one layer up and not here: `story.manifest.json` already
 * carries 200/320/384 px webp renditions of every one of these sheets — the
 * same scene is 3.5 MB at 200 px — and the player asks for full-size PNGs
 * regardless. Until it reads those, no gate can be both complete and quick.
 */
export function firstPaintAssets(story, scene) {
  const urls = [];
  const add = (url) => {
    if (typeof url === 'string' && url && !urls.includes(url)) urls.push(url);
  };
  add(scene?.plate?.poster);
  for (const slug of castOf(scene ?? {})) {
    const character = story?.cast?.[slug];
    for (const clipKey of Object.values(character?.capability?.idle ?? {})) {
      add(character?.clips?.[clipKey]?.spritesheet);
    }
  }
  for (const step of scene?.steps ?? []) {
    for (const slug of step.objects ?? []) add(story?.objects?.[slug]?.svg);
  }
  return urls;
}

export function sceneAssets(story, scene) {
  const urls = [];
  const add = (url) => {
    if (typeof url === 'string' && url && !urls.includes(url)) urls.push(url);
  };

  add(scene?.plate?.poster);
  for (const slug of castOf(scene ?? {})) {
    const character = story?.cast?.[slug];
    if (!character) continue;
    for (const verb of verbsOf(scene, slug)) {
      const facings = character.capability?.[verb];
      if (!facings) continue;
      for (const clipKey of Object.values(facings)) {
        add(character.clips?.[clipKey]?.spritesheet);
      }
    }
  }
  // props are drawn from a flat SVG and are on screen the instant they are put
  for (const step of scene?.steps ?? []) {
    for (const slug of step.objects ?? []) add(story?.objects?.[slug]?.svg);
  }
  return urls;
}

/**
 * Fetch `urls`, reporting progress, resolving when every one has settled.
 *
 * Never rejects, and never leaves the gate shut: a 404 sheet or a dead link
 * resolves like any other, because refusing to start a story over one missing
 * asset would be worse than the pop-in this exists to remove. The renderer
 * still warns about anything genuinely broken when it comes to draw it.
 *
 * `load` is injected so this is testable without a network or a DOM.
 */
export async function preload(urls, {
  onProgress = () => {}, load = loadImage, concurrency = 0, signal = null,
} = {}) {
  throwIfAborted(signal);
  const total = urls.length;
  onProgress(0, total);
  if (total === 0) return { total: 0, failed: 0 };

  let done = 0;
  let failed = 0;
  const fetchOne = async (url) => {
    try {
      await abortable(load(url, { signal }), signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      failed += 1;
    }
    throwIfAborted(signal);
    done += 1;
    onProgress(done, total);
  };

  // `concurrency: 0` means all at once, which is right for the GATE — somebody
  // is watching a progress line and nothing else is competing for the link. The
  // background queue passes 1, because it runs while narration audio and the
  // plate video are streaming and a burst of sheets would starve them.
  if (concurrency < 1) {
    await Promise.all(urls.map(fetchOne));
  } else {
    const queue = [...urls];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await fetchOne(queue.shift());
    });
    await Promise.all(workers);
  }
  return { total, failed };
}

/**
 * Warm the browser cache for every scene after the first, in playing order.
 *
 * Sequential rather than parallel, and that is the whole design: these run
 * DURING playback, and firing thirty requests at a slow link would starve the
 * narration audio and the plate video the viewer is waiting on right now.
 */
export async function queueRemainingScenes(story, {
  load = loadImage, onScene = () => {}, signal = null,
} = {}) {
  // Scene 0 first: the gate only covered its first frame, so the rest of the
  // scene now playing outranks every scene that has not opened yet.
  for (let index = 0; index < (story?.scenes?.length ?? 0); index += 1) {
    const urls = sceneAssets(story, story.scenes[index]);
    await preload(urls, { load, concurrency: 1, signal });
    throwIfAborted(signal);
    onScene(index, urls.length);
  }
}

function loadImage(url, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      image.removeAttribute?.('src');
      reject(abortError());
    };
    image.addEventListener('load', () => { cleanup(); resolve(url); }, { once: true });
    image.addEventListener('error', () => { cleanup(); reject(new Error(`asset failed: ${url}`)); }, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return new DOMException('player destroyed', 'AbortError');
}
