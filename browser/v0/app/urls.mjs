/**
 * Storage-root addressing for bucket-qualified v0 media, and the mount-time
 * shape checks for what a host hands over beside the story — `requirePlatesBlock`
 * is where the manifest's `plates` is settled, `requireCardsBlock` where the
 * intro and end cards are, and `appendStoryScene` is where a scene published
 * after the mount is qualified the same way the rest was.
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function requireMediaPath(path, where = 'media path') {
  const refuse = () => {
    throw new Error(`${where} has invalid media path ${JSON.stringify(path)}`);
  };
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')) refuse();
  if (SCHEME.test(path) || path.includes('?') || path.includes('#')) refuse();
  const rawSegments = path.split('/');
  if (rawSegments.length < 2 || rawSegments.some((segment) => !segment)) refuse();
  const segments = rawSegments.map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      refuse();
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) refuse();
    if (!SEGMENT.test(decoded) || decoded !== segment) refuse();
    return decoded;
  });
  const bucket = segments[0];
  if (
    !BUCKET.test(bucket)
    || bucket.includes('..')
    || bucket.includes('.-')
    || bucket.includes('-.')
    || isIpv4Address(bucket)
  ) refuse();
  return segments.join('/');
}

export function normalizeAssetBase(assetBase) {
  let parsed;
  try {
    parsed = new URL(assetBase);
  } catch {
    throw new Error(`asset base must be an absolute http(s) URL, got ${JSON.stringify(assetBase)}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`asset base must use http(s), got ${parsed.protocol || 'no protocol'}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('asset base must not carry credentials, query, or fragment');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
  return parsed.href;
}

export function resolveMediaUrl(path, assetBase, where = 'media path') {
  const base = normalizeAssetBase(assetBase);
  const resolved = new URL(requireMediaPath(path, where), base);
  const baseUrl = new URL(base);
  if (resolved.origin !== baseUrl.origin || !resolved.pathname.startsWith(baseUrl.pathname)) {
    throw new Error(`${where} escaped the asset base`);
  }
  return resolved.href;
}

function projectMap(entries, project) {
  return Object.fromEntries(Object.entries(entries ?? {}).map(([key, value]) => [key, project(value, key)]));
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function resolveStoryAssets(story, assetBase) {
  const source = cloneValue(story);
  const base = normalizeAssetBase(assetBase);
  const resolve = (key, where) => resolveMediaUrl(key, base, where);

  const cast = projectMap(source?.cast, (character, slug) => ({
    ...character,
    clips: projectMap(character?.clips, (clip, clipKey) => {
      if (Object.hasOwn(clip ?? {}, 'spritesheet_url') || Object.hasOwn(clip ?? {}, 'atlas_url')) {
        throw new Error(`cast member ${JSON.stringify(slug)} clip ${JSON.stringify(clipKey)} has a legacy asset field`);
      }
      const where = `cast member ${JSON.stringify(slug)} clip ${JSON.stringify(clipKey)}`;
      return {
        ...clip,
        spritesheet: resolve(clip?.spritesheet, `${where} spritesheet`),
        atlas: clip?.atlas == null
          ? null
          : resolve(clip.atlas, `${where} atlas`),
        // Renditions are ordinary bucket-qualified media, so they go through
        // exactly the same validation as the sheet they stand in for — an
        // absolute URL or a traversal in one is refused before it is fetched,
        // not after. A bundle built before renditions existed carries none, and
        // that is not an error: it plays from the originals.
        ...(clip?.renditions == null
          ? {}
          : {
            renditions: projectMap(
              clip.renditions,
              (path, size) => resolve(path, `${where} rendition ${JSON.stringify(size)}`),
            ),
          }),
        // The same ladder cut into chunks, qualified key by key. A block whose
        // `keys` is not a list is left as an empty one rather than refused: the
        // picker checks the list against the clip's frame count anyway and falls
        // back to the whole rendition, which is a story that plays. A key that
        // IS there goes through the same door as every other media path — an
        // absolute URL or a traversal inside one is refused before it is
        // fetched, not after.
        ...(clip?.rendition_chunks == null
          ? {}
          : {
            rendition_chunks: projectMap(clip.rendition_chunks, (block, size) => ({
              ...block,
              keys: (Array.isArray(block?.keys) ? block.keys : []).map(
                (path, index) => resolve(path, `${where} rendition chunk ${JSON.stringify(size)}/${index}`),
              ),
            })),
          }),
      };
    }),
  }));

  const objects = projectMap(source?.objects, (object, slug) => ({
    ...object,
    svg: resolve(object?.svg, `object ${JSON.stringify(slug)} svg`),
  }));
  const audio = {
    sfx: projectMap(source?.audio?.sfx, (key, name) => resolve(key, `audio sfx/${name}`)),
    bgm: projectMap(source?.audio?.bgm, (key, name) => resolve(key, `audio bgm/${name}`)),
  };
  if (!Array.isArray(source?.scenes) || source.scenes.length === 0) {
    throw new Error('story must carry a non-empty scenes array');
  }
  validateStoryReferences(source);
  const scenes = source.scenes.map((scene, index) => projectScene(scene, resolve, index));

  return deepFreeze({ ...source, cast, objects, audio, scenes });
}

/**
 * The same story with one more scene on the end, resolved and frozen.
 *
 * The envelope a story is mounted with — cast, objects, audio — is whole before
 * scene one exists, because the manifest carries it whole. So an appended scene
 * is validated AGAINST that envelope rather than allowed to extend it: a step
 * naming a character the manifest never carried is refused here, and the prefix
 * the viewer is watching keeps playing.
 *
 * Scenes arrive in publishing order, and nothing here can check that — a host
 * strips a published scene's own index when it joins it. A host that appends
 * out of order gets a timeline whose earlier events move, which is the one
 * promise this path exists to keep.
 */
export function appendStoryScene(story, scene, assetBase) {
  const index = story?.scenes?.length ?? 0;
  const source = cloneValue(scene);
  const base = normalizeAssetBase(assetBase);
  validateScene(source, story, index);
  const resolved = projectScene(source, (key, where) => resolveMediaUrl(key, base, where), index);
  return Object.freeze({
    ...story,
    scenes: Object.freeze([...story.scenes, deepFreeze(resolved)]),
  });
}

/**
 * The manifest's `plates` block, checked at the one door it comes in through.
 *
 * The compiler cannot report a bad block itself: a warning is an EVENT, so one
 * raised on the hint path would appear in a prefix and not in the finished
 * compile, and the prefix would stop being the finished timeline's opening.
 * The shape is therefore settled here, where a refusal is the host's to fix and
 * costs nobody a frame.
 */
export function requirePlatesBlock(plates) {
  if (plates == null) return null;
  if (!isRecord(plates)) throw new Error('plates must be an object keyed by place');
  for (const [place, byTime] of Object.entries(plates)) {
    if (!isRecord(byTime)) {
      throw new Error(`plates place ${JSON.stringify(place)} must be an object keyed by time`);
    }
    for (const [time, plate] of Object.entries(byTime)) {
      // The traced zones are the only field the compiler reads off a hinted
      // plate, so a leaf without them is a block that answers nothing —
      // silently, which is the failure this check exists to make loud.
      if (!isRecord(plate) || !Array.isArray(plate.zones) || plate.zones.length === 0) {
        throw new Error(`plates entry ${JSON.stringify(place)} at ${JSON.stringify(time)} is not a plate`);
      }
    }
  }
  // A block with no places in it answers nothing, which is exactly what no block
  // at all does — so it IS no block. Said here rather than left to the caller,
  // because the one caller that cares asks `if (!plates)`: an empty object is
  // truthy, and a streaming mount would have passed the guard that exists to
  // refuse a growing story with nothing to stage its unopened places from.
  if (Object.keys(plates).length === 0) return null;
  return deepFreeze(cloneValue(plates));
}

/**
 * The manifest's `intro` and `end_card` blocks, checked and resolved at the door.
 *
 * Resolved HERE rather than when the card is played, for the reason every other
 * mount-time check exists: a card is reached after the viewer has pressed begin,
 * and a bad path found there is a black rectangle where the story's opening was,
 * with the ceremony already gone. Found here it is a refusal the host can read
 * before a single frame.
 *
 * The slots are named exactly, because a misspelled one is indistinguishable
 * from a deliberate omission — both leave the story opening on nothing. What is
 * INSIDE a slot is the manifest's own shape and is only read for the fields this
 * player performs, so a block that grows a field is played by a build that
 * predates it rather than refused by one.
 */
export function requireCardsBlock(cards, assetBase) {
  if (cards == null) return null;
  if (!isRecord(cards)) throw new Error('cards must be an object carrying intro, end_card, or both');
  const unknown = Object.keys(cards).filter((slot) => slot !== 'intro' && slot !== 'end_card');
  if (unknown.length > 0) {
    throw new Error(`cards carries ${unknown.map((slot) => JSON.stringify(slot)).join(', ')}, which it does not take`);
  }
  const base = normalizeAssetBase(assetBase);
  const resolved = {};
  for (const slot of ['intro', 'end_card']) {
    const card = cards[slot];
    if (card == null) continue;
    if (!isRecord(card)) throw new Error(`cards ${slot} must be an object carrying its video`);
    resolved[slot] = {
      video: resolveMediaUrl(card.video, base, `cards ${slot} video`),
      // A card with no track of its own plays silent rather than not at all: a
      // story whose music the writer left out is still a story that opens.
      music: card.music == null ? null : resolveMediaUrl(card.music, base, `cards ${slot} music`),
      narration: requireCardLine(card.narration, slot, base),
      lead: requireCardLead(card.lead, slot),
    };
  }
  // Both slots empty is the same nothing as no block at all — said here so the
  // one caller that asks `if (cards)` cannot be answered by a truthy `{}`.
  if (Object.keys(resolved).length === 0) return null;
  return deepFreeze(resolved);
}

/**
 * The line spoken over a card: its words, and the voice reading them.
 *
 * The audio is optional and the text is not. Narration is synthesised at the
 * writer's edge and a story may be built without a voice at all, but the words
 * are what the card shows — a line with nothing to display is a block that says
 * nothing in either medium.
 */
function requireCardLine(narration, slot, base) {
  if (narration == null) return null;
  if (!isRecord(narration) || typeof narration.text !== 'string' || !narration.text) {
    throw new Error(`cards ${slot} narration must carry the line to speak`);
  }
  return {
    text: narration.text,
    audio: narration.audio == null
      ? null
      : resolveMediaUrl(narration.audio, base, `cards ${slot} narration audio`),
  };
}

/**
 * Who the card's title beat is about, by cast slug.
 *
 * Optional, and its absence is not a lesser card: every story published before
 * the manifest carried this key plays the opening it was built for — the name
 * read a second into the film — while a card that names a lead ends on a title
 * beat instead. Only the SHAPE is settled here. Whether the story actually cast
 * that character is a question about the mounted bundle rather than about this
 * block, and the answer to it is a warning and a card with no sprite on it, not
 * a refusal that would cost the viewer the story.
 */
function requireCardLead(lead, slot) {
  if (lead == null) return null;
  if (typeof lead !== 'string' || !lead) {
    throw new Error(`cards ${slot} lead must be the lead character's cast slug`);
  }
  return lead;
}

function projectScene(scene, resolve, index) {
  return {
    ...scene,
    plate: {
      ...scene.plate,
      video: resolve(scene?.plate?.video, `scene ${index} plate video`),
      poster: resolve(scene?.plate?.poster, `scene ${index} plate poster`),
    },
    steps: projectSteps(scene?.steps, resolve, index),
  };
}

function isIpv4Address(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(
    (part) => /^(0|[1-9][0-9]*)$/.test(part) && Number(part) <= 255,
  );
}

function validateStoryReferences(story) {
  if (!isRecord(story.cast) || !isRecord(story.objects) || !isRecord(story.audio)) {
    throw new Error('story cast, objects, and audio must be objects');
  }
  for (const [sceneIndex, scene] of story.scenes.entries()) validateScene(scene, story, sceneIndex);
}

function validateScene(scene, story, index) {
  if (!isRecord(scene) || !isRecord(scene.plate) || !Array.isArray(scene.steps)) {
    throw new Error(`scene ${index} must carry a plate object and steps array`);
  }
  validateSteps(scene.steps, story, `scene ${index}`);
}

function validateSteps(steps, story, where) {
  for (const [stepIndex, step] of steps.entries()) {
    const stepWhere = `${where} step ${stepIndex}`;
    if (!isRecord(step)) throw new Error(`${stepWhere} must be an object`);
    if (step.kind === 'together') {
      if (!Array.isArray(step.steps)) throw new Error(`${stepWhere} must carry a steps array`);
      validateSteps(step.steps, story, stepWhere);
    }
    const objectSlugs = new Set(step.objects ?? []);
    for (const slug of objectSlugs) {
      if (!Object.hasOwn(story.objects, slug)) {
        throw new Error(`${stepWhere} object ${JSON.stringify(slug)} is absent from objects`);
      }
    }
    // `highlight` and `take` are the commands whose subject may be a prop: a
    // maths lesson rings the numeral card it just spoke, and takes it away
    // again. The compiler resolves both against the props standing in the scene
    // as well as the cast, so refusing the same slug at the door would turn every
    // such lesson into "this story could not be opened" — which is what it did.
    const named = step.cmd === 'highlight' || step.cmd === 'take' ? story.objects : null;
    for (const slug of step.subjects ?? []) {
      if (objectSlugs.has(slug)) continue;
      if (named && Object.hasOwn(named, slug)) continue;
      if (!Object.hasOwn(story.cast, slug)) {
        throw new Error(
          `${stepWhere} subject ${JSON.stringify(slug)} is absent from `
          + `${named ? 'cast and objects' : 'cast'}`,
        );
      }
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectSteps(steps, resolve, sceneIndex) {
  return (steps ?? []).map((step) => ({
    ...step,
    ...(step?.audio == null
      ? {}
      : { audio: resolve(step.audio, `scene ${sceneIndex} narration`) }),
    ...(Array.isArray(step?.steps)
      ? { steps: projectSteps(step.steps, resolve, sceneIndex) }
      : {}),
  }));
}
