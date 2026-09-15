export function performanceAudioAt(story, tMs) {
  return story.audio
    .filter(
      (c) =>
        c.kind !== "sfx" &&
        tMs >= c.start_ms &&
        tMs < (c.end_ms ?? c.start_ms + c.duration_ms),
    )
    .map((c) => {
      const elapsed = tMs - c.start_ms;
      let volume = c.volume ?? 1;
      for (const key of c.gain_keys ?? []) {
        if (key[0] > tMs) break;
        volume = key[1];
      }
      return {
        ...c,
        volume,
        offset_ms: c.loop ? elapsed % c.duration_ms : elapsed,
      };
    });
}
export function performanceSoundsBetween(story, fromMs, toMs) {
  return story.audio.filter(
    (c) => c.kind === "sfx" && c.start_ms >= fromMs && c.start_ms < toMs,
  );
}
