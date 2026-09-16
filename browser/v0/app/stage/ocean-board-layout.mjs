import { oceanProgress } from '../../core/ocean-board.mjs';

const round = (value) => Math.round(value * 10000) / 10000;

/** Native bare captions: 15.2px * (two 1.55 lines + .68 padding) + 25.6px bottom. */
export function captionSafeTeachingRow(row, prompt, plateHeight, cssHeight) {
  if (!(cssHeight > 0 && cssHeight < 260)) return row;
  const scale = cssHeight / plateHeight;
  const top = Math.max(row.y, prompt.cy + prompt.size / 2 + 4 / scale);
  // Round the 83.056px caption band up, then leave eight CSS pixels of air.
  const bottom = Math.min(row.y + row.h, (cssHeight - 84 - 8) / scale);
  return { ...row, y: top, h: Math.max(0, bottom - top) };
}

/** Fixed school arc or five-by-two slots; neither depends on current N. */
export function teachingLayout(ocean, elapsed, row, sheets) {
  const progress = oceanProgress(ocean, elapsed);
  const fishArea = { dx: row.x, dy: row.y, dw: row.w * 0.76, dh: row.h };
  const cell = Math.min(fishArea.dw / 5, fishArea.dh / (ocean.school ? 1 : 2));
  const side = cell * 0.9;
  const left = fishArea.dx + (fishArea.dw - cell * 5) / 2;
  const top = fishArea.dy + (fishArea.dh - cell * 2) / 2;
  const fish = Array.from({ length: ocean.quantity }, (_, index) => {
    const targetX = round(ocean.school ? fishArea.dx + (index + 0.5) * fishArea.dw / 5 - side / 2
      : left + (index % 5) * cell + (cell - side) / 2);
    const targetY = round(ocean.school ? fishArea.dy + [0.72, 0.35, 0.22, 0.35, 0.72][index] * (fishArea.dh - side)
      : top + Math.floor(index / 5) * cell + (cell - side) / 2);
    const arriving = ocean.phase === 'arrive' && index === ocean.quantity - 1;
    const eased = 1 - (1 - progress) ** 3;
    return {
      n: index + 1, url: sheets.prop(ocean.fish)?.url ?? null, targetX, targetY,
      dx: arriving ? round(targetX + cell * 0.6 * (1 - eased)) : targetX,
      dy: arriving ? round(targetY - cell * 0.13 * Math.sin(Math.PI * progress)) : targetY,
      dw: round(side), dh: round(side), opacity: arriving ? round(progress) : 1,
      highlight: ocean.highlight === index + 1,
      highlightProgress: ocean.highlight === index + 1 ? progress : 0,
    };
  });
  const numeralSide = Math.min(row.w * 0.2, row.h * 0.8);
  const box = { dx: round(row.x + row.w * 0.9 - numeralSide / 2), dy: round(row.y + (row.h - numeralSide) / 2),
    dw: round(numeralSide), dh: round(numeralSide) };
  return { ocean, fishArea, fish,
    numeral: { url: ocean.numeral ? sheets.prop(ocean.numeral)?.url ?? null : null, box, opacity: ocean.phase === 'reveal' ? progress : 0 } };
}

/** A wrapper contains its complete base board, so seeks need no frame history. */
export function transitionLayout(wrapper, elapsed, board, width) {
  const progress = Math.max(0, Math.min(1, elapsed / wrapper.duration));
  const incoming = wrapper.name === 'ocean_zone_in';
  const opacity = incoming ? progress : 1 - progress;
  const area = board.fishArea ?? {
    dx: Math.min(...board.cards.map((card) => card.dx)), dy: Math.min(...board.cards.map((card) => card.dy)),
    dw: Math.max(...board.cards.map((card) => card.dx + card.dw)) - Math.min(...board.cards.map((card) => card.dx)),
    dh: Math.max(...board.cards.map((card) => card.dh)),
  };
  const hiding = wrapper.name === 'ocean_hide_out';
  const envelope = progress > 0 && progress < 1 ? Math.sin(Math.PI * progress) : 0;
  const seeds = hiding ? [[0.12, 0.58], [0.32, 0.28], [0.51, 0.63], [0.72, 0.3], [0.89, 0.62], [0.38, 0.73], [0.66, 0.73]]
    : [[0.12, 0.72], [0.32, 0.35], [0.53, 0.65], [0.75, 0.3], [0.9, 0.69]];
  return { name: wrapper.name, progress, opacity, dx: round(width * 0.025 * (incoming ? 1 - progress : -progress)),
    bubbles: seeds.map(([x, y], index) => ({ cx: round(area.dx + x * area.dw),
      cy: round(area.dy + (y - progress * 0.13) * area.dh),
      r: round(Math.min(area.dw, area.dh) * (hiding ? 0.15 : 0.055) * (0.8 + (index % 3) * 0.15 + envelope * 0.3)),
      opacity: round(envelope * (hiding ? 0.78 : 0.42)) })) };
}

/** Both group families use 240px fish at (16+column*258,16+row*258). */
export function quizHighlight(ocean, elapsed, cards, insetFraction) {
  const card = cards[ocean.cardIndex];
  const { width, height, columns } = ocean.layout;
  const inset = Math.min(card.dw, card.dh) * insetFraction;
  const scale = Math.min((card.dw - 2 * inset) / width, (card.dh - 2 * inset) / height);
  const imageX = card.dx + (card.dw - width * scale) / 2;
  const imageY = card.dy + (card.dh - height * scale) / 2;
  const index = ocean.highlight - 1;
  return { n: ocean.highlight, cardIndex: ocean.cardIndex,
    cx: round(imageX + (136 + index % columns * 258) * scale),
    cy: round(imageY + (136 + Math.floor(index / columns) * 258) * scale),
    rx: round(116 * scale), ry: round(102 * scale), progress: oceanProgress(ocean, elapsed) };
}
