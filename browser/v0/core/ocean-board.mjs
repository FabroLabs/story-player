/** Explicit local lesson markers carried by the existing board-card contract. */
export const OCEAN_TIMING = Object.freeze({ arrive: 1000, recount: 350, hold: 0, reveal: 700, quiz: 350, empty: 0 });
const RESERVED = /^ocean_(?:(?:arrive|recount|hold|reveal|quiz_count)_|school_|zone_|hide_|goodbye_)/;
const WRAPPER = /^ocean_(?:zone_|hide_|goodbye_)/;
const TRANSITIONS = Object.freeze({ ocean_zone_out: 700, ocean_zone_in: 700, ocean_hide_out: 700, ocean_goodbye_out: 1200 });
const INVALID = Object.freeze({ kind: 'invalid' });
const GROUP_LAYOUT = Object.freeze({ width: 1304, height: 530, columns: 5 });
const SMALL_GROUP_LAYOUT = Object.freeze({ width: 788, height: 272, columns: 3 });

export function readOceanBoard(board, allowTransition = true) {
  const cards = board?.cards;
  if (!Array.isArray(cards) || !cards.some((slug) => RESERVED.test(slug))) return null;
  if (cards.some((slug) => WRAPPER.test(slug))) {
    const name = cards.at(-1);
    if (!allowTransition || !Object.hasOwn(TRANSITIONS, name) || cards.length < 2 || cards.length > 4
      || cards.slice(0, -1).some((slug) => WRAPPER.test(slug)) || board.focus > cards.length - 1) return INVALID;
    const base = { ...board, cards: cards.slice(0, -1) };
    const ocean = readOceanBoard(base, false);
    if (ocean?.kind === 'invalid' || ['arrive', 'recount'].includes(ocean?.phase)) return INVALID;
    return { kind: 'transition', name, duration: TRANSITIONS[name], board: base, ocean };
  }
  if (cards[0] === 'ocean_school_empty') {
    return cards.length === 2 && cards[1] === 'ocean_fish'
      ? { kind: 'teaching', phase: 'empty', quantity: 0, highlight: null, fish: 'ocean_fish', numeral: null, school: true }
      : INVALID;
  }
  const teaching = /^ocean_(school_)?(arrive|recount|hold|reveal)_([1-9]|10)(?:_([1-9]|10))?$/.exec(cards[0]);
  if (teaching) {
    const [, school, phase, value, index] = teaching;
    const quantity = Number(value);
    const highlight = index === undefined ? null : Number(index);
    if ((school && quantity > 5) || cards.length !== 3 || cards[1] !== 'ocean_fish' || cards[2] !== `ocean_number_${quantity}`
      || (phase === 'recount' ? highlight === null || highlight > quantity : highlight !== null)) return INVALID;
    return { kind: 'teaching', phase, quantity, highlight, fish: cards[1], numeral: cards[2], ...(school ? { school: true } : {}) };
  }
  const quiz = /^ocean_quiz_count_([1-9]|10)$/.exec(cards[3]);
  if (cards.length !== 4 || !quiz || !Number.isInteger(board.focus) || board.focus < 1 || board.focus > 3) return INVALID;
  const small = /^ocean_small_group_/.test(cards[0]);
  const family = small ? /^ocean_small_group_([1-3])$/ : /^ocean_group_([1-9]|10)$/;
  const groups = cards.slice(0, 3).map((slug) => family.exec(slug));
  if (groups.some((match) => !match)) return INVALID;
  const quantities = groups.map((match) => Number(match[1]));
  const highlight = Number(quiz[1]);
  if (highlight > quantities[board.focus - 1]) return INVALID;
  return { kind: 'quiz', phase: 'quiz', quantities, cardIndex: board.focus - 1, highlight,
    layout: small ? SMALL_GROUP_LAYOUT : GROUP_LAYOUT };
}

export function oceanAnimationMs(board) {
  const ocean = readOceanBoard(board);
  if (ocean?.kind === 'transition') return ocean.duration;
  return ocean && ocean.kind !== 'invalid' ? OCEAN_TIMING[ocean.phase] : 0;
}

export function oceanProgress(ocean, elapsed) {
  const span = OCEAN_TIMING[ocean.phase];
  return span > 0 ? Math.max(0, Math.min(1, elapsed / span)) : 1;
}
