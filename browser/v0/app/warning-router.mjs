export function routeWarning(detail, director, log) {
  if (director) return director.warning(detail);
  if (!detail || typeof detail !== 'object') return log.warning(detail, null, null);
  const { line = null, scene_index: sceneIndex = null, ...payload } = detail;
  return log.warning(payload, line, sceneIndex);
}
