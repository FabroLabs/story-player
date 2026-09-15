export function clipSelection(node, assets, time) {
  const segment = (node.segments ?? []).find(
    (s) => time >= s.start_ms && time < s.end_ms,
  );
  const assetId = segment?.asset ?? node.asset;
  const clip = segment
    ? {
        ...segment.clip,
        start_ms: segment.start_ms + (segment.clip?.start_ms ?? 0),
      }
    : (node.clip ?? {});
  const asset = assets[assetId];
  const selected = clip.frames ?? asset.frames?.map((_, i) => i) ?? [0];
  return { assetId, asset, clip, selected };
}
export function selectedFrame(selection, time) {
  const { clip, selected } = selection;
  const raw = Math.floor(
    (Math.max(0, time - (clip.start_ms ?? 0)) * (clip.fps ?? 12)) / 1000,
  );
  return (
    clip.hold ??
    selected[
      clip.loop === false
        ? Math.min(raw, selected.length - 1)
        : raw % selected.length
    ]
  );
}

// Interval boundaries select the same clip/segment as stateAt. A loop longer
// than its selection needs only one pass, so long holds don't grow validation.
export function sampledFrames(node, assets, start, end, includeEnd = false) {
  const boundaries = [
    start,
    end,
    ...(node.segments ?? [])
      .flatMap((s) => [s.start_ms, s.end_ms])
      .filter((t) => t > start && t < end),
  ].sort((a, b) => a - b);
  const sampled = new Map();
  const add = (selection, frame) => {
    if (!sampled.has(selection.assetId))
      sampled.set(selection.assetId, new Set());
    sampled.get(selection.assetId).add(frame);
  };
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i],
      b = boundaries[i + 1];
    if (b <= a) continue;
    const selection = clipSelection(node, assets, a),
      { clip, selected } = selection;
    if (clip.hold !== undefined) {
      add(selection, clip.hold);
      continue;
    }
    const startMs = clip.start_ms ?? 0,
      fps = clip.fps ?? 12;
    const first = Math.floor((Math.max(0, a - startMs) * fps) / 1000);
    const last = Math.max(
      0,
      Math.ceil((Math.max(0, b - startMs) * fps) / 1000) - 1,
    );
    if (clip.loop === false) {
      for (
        let k = Math.min(first, selected.length - 1);
        k <= Math.min(last, selected.length - 1);
        k++
      )
        add(selection, selected[k]);
    } else if (last - first + 1 >= selected.length) {
      for (const frame of selected) add(selection, frame);
    } else
      for (let k = first; k <= last; k++)
        add(selection, selected[k % selected.length]);
  }
  if (includeEnd) {
    const selection = clipSelection(node, assets, end);
    add(selection, selectedFrame(selection, end));
  }
  return sampled;
}
