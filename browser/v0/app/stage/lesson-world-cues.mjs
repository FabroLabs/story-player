/** Authored answer presentation samples only story time; it never scores a child. */
const clamp = value => Math.max(0, Math.min(1, value));
const TAU = Math.PI * 2;
const smooth = value => { const u = clamp(value); return u * u * (3 - 2 * u); };

export function applyWorldCue(board, scene, tMs, reducedMotion = false) {
  if (scene.phase.mode !== 'lesson') return board;
  const cue = scene.world.cues?.find(item => tMs >= item.start_ms && tMs < item.end_ms);
  if (!cue || cue.cards.length !== board.cards.length || !cue.cards.every((slug, index) => slug === board.cards[index].slug)) return board;
  const elapsed = tMs - cue.start_ms;
  const cards = board.cards.map(card => ({ ...card, focused: false }));
  if (cue.kind === 'thinking') {
    const { prompt } = board;
    const base = prompt.indicator ?? { cy: prompt.cy + prompt.size * .85, r: prompt.size * .1 };
    const dots = Array.from({ length: 3 }, (_, index) => {
      const breath = (1 - Math.cos(TAU * (elapsed / 1800 - index * .16))) / 2;
      return { cx: prompt.cx + (index - 1) * base.r * 3.8, cy: base.cy,
        r: base.r * (.9 + .1 * breath), opacity: .4 + .4 * breath };
    });
    return { ...board, cards, engagement: { kind: cue.kind, dots } };
  }
  const card = cards[cue.answer_index - 1], size = Math.min(card.dw, card.dh);
  const duration = cue.end_ms - cue.start_ms;
  if (cue.presentation === 'spotlight') {
    card.spotlight = spotlightPose(card, board.panel, elapsed, duration, reducedMotion);
    return { ...board, cards, engagement: { kind: cue.kind, presentation: cue.presentation } };
  }
  const pop = clamp(elapsed / Math.min(450, duration));
  const lifetime = Math.min(1200, duration), hold = Math.min(350, lifetime / 2);
  const burst = clamp(elapsed / lifetime);
  const opacity = clamp(elapsed / Math.min(80, hold)) * (1 - clamp((elapsed - hold) / (lifetime - hold))) ** 1.2;
  const glow = clamp(elapsed / 100) * clamp((cue.end_ms - tMs) / 250);
  const sparkles = Array.from({ length: 8 }, (_, index) => {
    const angle = -Math.PI / 2 + Math.PI / 8 + index * TAU / 8;
    const reach = size * (.52 + .16 * (1 - (1 - burst) ** 2));
    const r = size * (.044 + (index % 2) * .011), edge = Math.max(1, r * .14), padding = r + edge / 2;
    const { panel } = board;
    return { cx: Math.max(panel.x + padding, Math.min(panel.x + panel.w - padding, card.dx + card.dw / 2 + Math.cos(angle) * reach)),
      cy: Math.max(panel.y + padding, Math.min(panel.y + panel.h - padding, card.dy + card.dh / 2 + Math.sin(angle) * reach)),
      r, edge, opacity };
  });
  card.focused = true;
  card.reveal = { scale: pop < 1 ? 1 + .06 * Math.sin(Math.PI * pop) : 1, glow, sparkles };
  return { ...board, cards, engagement: { kind: cue.kind } };
}

function spotlightPose(card, panel, elapsed, duration, reducedMotion) {
  if (reducedMotion) return { scaleX: 1, scaleY: 1, lift: 0, emphasis: 1 };
  const speed = Math.min(1, duration / 1800), time = elapsed / speed;
  const frames = [[0, 1, 1, 0], [100, 1.025, .96, 0], [320, 1.12, 1.12, .10],
    [500, 1.075, 1.075, .065], [700, 1.09, 1.09, .075]];
  const rightIndex = frames.findIndex(frame => frame[0] >= time);
  const right = frames[rightIndex < 0 ? frames.length - 1 : rightIndex];
  const left = frames[Math.max(0, rightIndex < 0 ? frames.length - 1 : rightIndex - 1)];
  const progress = right[0] === left[0] ? 0 : smooth((time - left[0]) / (right[0] - left[0]));
  const settle = smooth((duration - elapsed) / (260 * speed));
  const value = index => left[index] + (right[index] - left[index]) * progress;
  const { dx, dy, dw, dh } = card, size = Math.min(dw, dh);
  // Keep a raised outer card inside the face, even with a tightly authored row.
  const cx = dx + dw / 2, cy = dy + dh / 2, padding = size * .007;
  const maxScaleX = Math.max(1, Math.min((cx - panel.x - padding) * 2 / dw, (panel.x + panel.w - cx - padding) * 2 / dw));
  const maxScaleY = Math.max(1, Math.min((cy - panel.y - padding) * 2 / dh, (panel.y + panel.h - cy - padding) * 2 / dh));
  const scaleX = Math.min(maxScaleX, 1 + (value(1) - 1) * settle);
  const scaleY = Math.min(maxScaleY, 1 + (value(2) - 1) * settle);
  const lift = Math.max(0, Math.min(size * value(3) * settle, dy - panel.y - padding - dh * (scaleY - 1) / 2));
  return { scaleX, scaleY, lift, emphasis: smooth(time / 120) * settle };
}
