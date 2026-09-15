import {
  PERFORMANCE_CAPABILITIES,
  validatePerformance,
} from "./validation.mjs";
export function auditPerformance(story) {
  validatePerformance(story);
  const used = new Set(["transform", "layers"]);
  let nodes = 0;
  for (const scene of story.scenes) {
    if (scene.camera) used.add("camera");
    if (scene.transition) used.add("transition");
    for (const n of scene.nodes) {
      nodes++;
      if (story.assets[n.asset].type === "sprite" || n.clip) used.add("clip");
      if (story.assets[n.asset].type === "shape") used.add("shapes");
      if (n.attach || (n.path?.to && !Array.isArray(n.path.to)))
        used.add("attachment");
      for (const key of [
        "path",
        "glow",
        "mask",
        "water",
        "projection",
        "particles",
        "travel",
      ])
        if (n[key]) used.add(key);
      if (n.lights?.length) used.add("lights");
      if (n.segments?.length) used.add("segments");
    }
  }
  if (story.audio.length) used.add("audio");
  const media = [
    ...Object.values(story.assets).map((a) => a.media),
    ...story.audio.map((a) => a.media),
  ].filter(Boolean);
  return {
    kind: "wht",
    supported_capabilities: [...PERFORMANCE_CAPABILITIES].sort(),
    used_capabilities: [...used].sort(),
    declared_capabilities: [...story.performance.required_capabilities].sort(),
    scene_count: story.scenes.length,
    node_count: nodes,
    media_count: new Set(media).size,
    duration_ms: story.scenes.at(-1).end_ms,
  };
}
