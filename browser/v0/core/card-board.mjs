import { CARD_BOARD } from '../policy.mjs';
import { readOceanBoard } from './ocean-board.mjs';
import { readFarmBoard } from './farm-board.mjs';
import { readFarmJourney } from './farm-journey.mjs';

/** A card lesson uses the native board, without pretending its pictures are a count. */
export function normaliseCardBoard(payload) {
  if (payload?.mode !== undefined && payload.mode !== 'cards') return null;
  const cards = payload?.cards;
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > CARD_BOARD.max) return null;
  if (cards.some((slug) => typeof slug !== 'string' || !slug || /\s/.test(slug))) return null;
  if (new Set(cards).size !== cards.length) return null;
  const focus = payload.focus === undefined ? null : payload.focus;
  if (focus !== null && (!Number.isInteger(focus) || focus < 1 || focus > cards.length)) return null;
  const prompt = payload.prompt === undefined ? '' : payload.prompt;
  if (typeof prompt !== 'string' || [...prompt].length > CARD_BOARD.promptMax) return null;
  const board = { mode: 'cards', cards: Object.freeze([...cards]), focus, prompt };
  return readOceanBoard(board)?.kind === 'invalid' || readFarmBoard(board)?.kind === 'invalid'
    || readFarmJourney(board)?.kind === 'invalid' ? null : board;
}

/** Shared by both compiler and fold: a valid slot must name a drawable object. */
export function knownCardBoard(payload, objects) {
  const board = normaliseCardBoard(payload);
  return board && board.cards.every((slug) => Object.hasOwn(objects ?? {}, slug)
    && typeof objects[slug]?.svg === 'string' && objects[slug].svg.length > 0) ? board : null;
}

export function sameCards(left, right) {
  if (left?.mode !== 'cards' || right?.mode !== 'cards') return false;
  const previous = readOceanBoard(right);
  const previousFarm = readFarmBoard(right);
  // Removing the wrapper exposes the board already shown settled. Adding a
  // wrapper must still start its new transition at the authored event time.
  const rightCards = previousFarm?.kind === 'farm' && readFarmBoard(left) === null ? previousFarm.board.cards
    : previous?.kind === 'transition' && readOceanBoard(left)?.kind !== 'transition' ? previous.board.cards : right.cards;
  return left.cards.length === rightCards.length && left.cards.every((slug, index) => slug === rightCards[index]);
}
