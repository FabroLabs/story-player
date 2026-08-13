/** Asset addressing for v0 bundles. Bundle assets use bucket-relative keys;
 * narration remains relative to story.json. Both shapes are validated before
 * the URL parser sees them, so a leading slash or encoded climb cannot escape
 * the base supplied by trusted host code. */

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

function requireAssetKey(key, where = 'asset') {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new Error(`${where} has invalid asset key ${JSON.stringify(key)}`);
  }
  return key;
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

export function resolveAssetKey(key, assetBase, where = 'asset') {
  const base = normalizeAssetBase(assetBase);
  const resolved = new URL(requireAssetKey(key, where), base);
  const baseUrl = new URL(base);
  if (resolved.origin !== baseUrl.origin || !resolved.pathname.startsWith(baseUrl.pathname)) {
    throw new Error(`${where} escaped the asset base`);
  }
  return resolved.href;
}

export function resolveNarrationUrl(path, storyUrl) {
  if (!path) return null;
  return new URL(requireAssetKey(path, 'narration'), storyUrl).href;
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
  const resolve = (key, where) => resolveAssetKey(key, base, where);

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
  const scenes = (source?.scenes ?? []).map((scene, index) => ({
    ...scene,
    plate: {
      ...scene.plate,
      video: resolve(scene?.plate?.video, `scene ${index} plate video`),
      poster: resolve(scene?.plate?.poster, `scene ${index} plate poster`),
    },
  }));

  return deepFreeze({ ...source, cast, objects, audio, scenes });
}
