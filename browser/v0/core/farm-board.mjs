import { readOceanBoard } from './ocean-board.mjs';
import { readFarmJourney, JOURNEY_LABEL_MS } from './farm-journey.mjs';

export const FARM_BOARD_MS = 1200;
const RESERVED = /^farm_board_/;
const INVALID = Object.freeze({ kind: 'invalid' });

/** Explicit complete boards make the raised view deterministic at every seek. */
export function readFarmBoard(board) {
  const cards = board?.cards;
  if (!Array.isArray(cards) || !cards.some((slug) => RESERVED.test(slug))) return null;
  const name = cards.at(-1);
  if (!['farm_board_lift', 'farm_board_lower'].includes(name) || cards.length < 2 || cards.length > 4
    || cards.slice(0, -1).some((slug) => RESERVED.test(slug)) || board.focus > cards.length - 1) return INVALID;
  const base = { ...board, cards: cards.slice(0, -1) };
  if (readOceanBoard(base) !== null) return INVALID;
  return { kind: 'farm', name, board: base };
}

export function farmAnimationMs(board) {
  if (readFarmJourney(board)?.kind === 'journey') return JOURNEY_LABEL_MS;
  return readFarmBoard(board)?.kind === 'farm' ? FARM_BOARD_MS : 0;
}

/** Presentation belongs to the whole explicit Farm scene, including plain boards. */
export function sceneHasFarmBoard(scene) {
  return (scene?.steps ?? []).some((step) => step?.cmd === 'board'
    && (readFarmBoard(step)?.kind === 'farm' || readFarmJourney(step)?.kind === 'journey'));
}

export function farmBoardMotion(farm, elapsed, height) {
  const progress = Math.max(0, Math.min(1, elapsed / FARM_BOARD_MS));
  const eased = progress * progress * (3 - 2 * progress);
  const raised = farm.name === 'farm_board_lift' ? eased : 1 - eased;
  return { name: farm.name, progress, dy: raised === 0 ? 0 : -height * raised };
}
