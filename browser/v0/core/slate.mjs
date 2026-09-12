/**
 * What a counting board IS, as one rule three files read.
 *
 * A board used to be an integer, and an integer is checked wherever it lands.
 * A board is now a small arithmetic claim — "five, because two and three" —
 * and a claim can be internally wrong in a way a range cannot catch: groups of
 * the wrong arity, a `count` that is not the sum its own groups make, a take
 * that ends below nothing. Written out at the compiler AND at the fold, the
 * rule would be two copies of that arithmetic, and the day they drift the
 * player draws a board the compiler would have refused.
 *
 * So the rule is here, and both callers ask it the same question. It answers
 * with the NORMALISED board or with nothing; the warning is the caller's,
 * because the compiler's warnings name a story line and the fold's name an
 * event, and neither belongs to a pure rule.
 *
 * It is also where a v1 step is met: `{count: 3}` — every lesson bundle built
 * before this board existed — means "count three", and it is normalised into
 * the three-field shape rather than refused, so one client draws one board
 * from either producer. The one v1 step it does NOT take is `{count: 0}`,
 * which was `slate(off)`: nothing lowers a board now, the ending included.
 */

import { SLATE } from '../policy.mjs';

export const SLATE_MODES = Object.freeze(['count', 'add', 'subtract']);

/**
 * `payload` is a bundle step, a timeline op or a folded board — all three carry
 * the same three fields. Returns `{count, mode, groups}` with `groups` frozen,
 * or `null` for anything a board cannot be drawn from.
 *
 * Zero is one of those things. It used to be a board: the number `slate(off)`
 * compiled to, and the way a story put its own board away. A board now goes up
 * at the story's first count and is never taken down — the end card is drawn
 * over it — so a step counting nothing is a step asking for something the player
 * no longer does: refused here, out loud at both callers, rather than quietly
 * emptying a panel the rest of the lesson is still drawing on.
 */
export function normaliseSlate(payload) {
  const count = payload?.count;
  if (!Number.isInteger(count) || count < 1 || count > SLATE.max) return null;

  // A producer that names no mode is naming the one board that existed before
  // modes did. `groups` follows from the count, so the shape is complete from
  // here on and nothing downstream has to ask which producer it came from.
  const mode = payload?.mode ?? 'count';
  if (!SLATE_MODES.includes(mode)) return null;
  const groups = Array.isArray(payload?.groups) && payload.groups.length > 0
    ? payload.groups
    : defaultGroups(mode, count);
  if (!groups.every((size) => Number.isInteger(size) && size >= 0)) return null;

  // Every plain count is one group holding its own total.
  if (mode === 'count') {
    return groups.length === 1 && groups[0] === count ? board(count, mode, groups) : null;
  }

  // Two operands, both of them a real quantity: a lesson that joins nothing to
  // three, or takes nothing away from three, is a board a child watches nothing
  // happen on. A take-away that lands on zero is refused by the count check
  // above — an answer of nothing is not an answer a board can show.
  if (groups.length !== 2) return null;
  const [left, right] = groups;
  if (left < 1 || right < 1) return null;
  if (mode === 'add') {
    return left + right === count && count <= SLATE.max ? board(count, mode, groups) : null;
  }
  return left > right && left - right === count && left <= SLATE.max
    ? board(count, mode, groups)
    : null;
}

/** How many counters a board of this shape draws — a subtraction draws its START. */
export function counterCount({ mode, count, groups } = {}) {
  if (mode === 'add') return (groups?.[0] ?? 0) + (groups?.[1] ?? 0);
  if (mode === 'subtract') return groups?.[0] ?? 0;
  return count ?? 0;
}

/**
 * The equation under the counters, token by token, in the order it is revealed.
 *
 * A plain count is one numeral and nothing else: the board says three, and
 * `3 = 3` would be a sentence about numbers rather than the answer to "how
 * many?". It carries the `result` role all the same, because it is the answer
 * and it is written in the answer's colour.
 */
export function equationTokens({ mode, count, groups } = {}) {
  if (mode === 'count') return count > 0 ? [{ text: String(count), role: 'result' }] : [];
  const [left, right] = groups ?? [];
  return [
    { text: String(left), role: 'term' },
    // The ascii hyphen, not a typographic minus: it is the glyph the lessons
    // were drawn with, and the one the `.story` literal is written with.
    { text: mode === 'add' ? '+' : '-', role: 'operator' },
    { text: String(right), role: 'term' },
    { text: '=', role: 'equals' },
    { text: String(count), role: 'result' },
  ];
}

/**
 * How many counters were already standing when this board was raised.
 *
 * A plain count raised over a smaller plain count is the story counting ON —
 * four is three and one more — and those three do not arrive again. The scene
 * they were raised in does not come into it: a board outlives every cut but the
 * ending either, so counters standing before a cut are still standing after.
 * Anything else (a new kind of arithmetic, a count that shrank) is a new board
 * and builds from nothing.
 *
 * It lives beside the rule rather than inside the fold because the compiler has
 * to work out the same number to know how long a board takes; two copies of
 * this is two answers to "is this board still arriving?".
 */
export function carriedFrom(shown, board) {
  return board.mode === 'count' && shown?.mode === 'count' && board.count > shown.count
    ? shown.count
    : 0;
}

/**
 * When each part of a board's build happens, in milliseconds from the instant
 * it was raised. Everything downstream is read off this, so the pacing of a
 * board is one function rather than an arithmetic spread through the drawer.
 */
export function slateSchedule(board, from = 0) {
  const drawn = counterCount(board);
  const first = Math.min(Math.max(from, 0), Math.max(drawn - 1, 0));
  const countersEnd = ((drawn - 1 - first) * SLATE.staggerMs) + SLATE.popMs;
  const taken = board.mode === 'subtract' ? board.groups[1] : 0;
  const revealEnd = taken > 0
    ? countersEnd + ((taken - 1) * SLATE.takeStaggerMs) + SLATE.takeMs
    : countersEnd;
  const tokens = equationTokens(board);
  return {
    from: first,
    countersEnd,
    taken,
    revealEnd,
    tokens,
    endMs: revealEnd + (tokens.length * SLATE.tokenMs),
  };
}

/**
 * How long the whole build lasts — for a caller that has to know whether the
 * board is still moving without drawing it: the player's repaint check, and the
 * compiler asking whether the story leaves the board time to finish.
 */
export function slateBuildMs(slate) {
  const board = normaliseSlate(slate);
  if (!board) return 0;
  return slateSchedule(board, Number.isInteger(slate?.from) ? slate.from : 0).endMs;
}

function defaultGroups(mode, count) {
  return mode === 'count' ? [count] : [];
}

function board(count, mode, groups) {
  return { count, mode, groups: Object.freeze([...groups]) };
}
