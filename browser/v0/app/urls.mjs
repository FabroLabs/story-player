/** Storage-root addressing for bucket-qualified v0 media. */

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
      return {
        ...clip,
        spritesheet: resolve(clip?.spritesheet, `cast member ${JSON.stringify(slug)} clip ${JSON.stringify(clipKey)} spritesheet`),
        atlas: clip?.atlas == null
          ? null
          : resolve(clip.atlas, `cast member ${JSON.stringify(slug)} clip ${JSON.stringify(clipKey)} atlas`),
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
  const scenes = (source?.scenes ?? []).map((scene, index) => ({
    ...scene,
    plate: {
      ...scene.plate,
      video: resolve(scene?.plate?.video, `scene ${index} plate video`),
      poster: resolve(scene?.plate?.poster, `scene ${index} plate poster`),
    },
    steps: projectSteps(scene?.steps, resolve, index),
  }));

  return deepFreeze({ ...source, cast, objects, audio, scenes });
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
  for (const [sceneIndex, scene] of story.scenes.entries()) {
    if (!isRecord(scene) || !isRecord(scene.plate) || !Array.isArray(scene.steps)) {
      throw new Error(`scene ${sceneIndex} must carry a plate object and steps array`);
    }
    validateSteps(scene.steps, story, `scene ${sceneIndex}`);
  }
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
    for (const slug of step.subjects ?? []) {
      if (objectSlugs.has(slug)) continue;
      if (!Object.hasOwn(story.cast, slug)) {
        throw new Error(`${stepWhere} subject ${JSON.stringify(slug)} is absent from cast`);
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
