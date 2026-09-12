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
 * from either producer.
 */

import { SLATE } from '../policy.mjs';

export const SLATE_MODES = Object.freeze(['count', 'add', 'subtract']);

/**
 * `payload` is a bundle step, a timeline op or a folded board — all three carry
 * the same three fields. Returns `{count, mode, groups}` with `groups` frozen,
 * or `null` for anything a board cannot be drawn from.
 */
export function normaliseSlate(payload) {
  const count = payload?.count;
  if (!Number.isInteger(count) || count < 0 || count > SLATE.max) return null;

  // A producer that names no mode is naming the one board that existed before
  // modes did. `groups` follows from the count, so the shape is complete from
  // here on and nothing downstream has to ask which producer it came from.
  const mode = payload?.mode ?? 'count';
  if (!SLATE_MODES.includes(mode)) return null;
  const groups = Array.isArray(payload?.groups) && payload.groups.length > 0
    ? payload.groups
    : defaultGroups(mode, count);
  if (!groups.every((size) => Number.isInteger(size) && size >= 0)) return null;

  if (mode === 'count') {
    // Zero IS the board going away, and it is the only count drawn by no
    // counters at all — every other board has one group holding its own total.
    if (count === 0) return groups.length === 0 ? board(0, mode, []) : null;
    return groups.length === 1 && groups[0] === count ? board(count, mode, groups) : null;
  }

  // Two operands, both of them a real quantity: a lesson that joins nothing to
  // three, or takes nothing away from three, is a board a child watches nothing
  // happen on. `0` is also how `off` is spelled, and a board that lands on it
  // by arithmetic would go away instead of answering.
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

function defaultGroups(mode, count) {
  if (mode !== 'count') return [];
  return count > 0 ? [count] : [];
}

function board(count, mode, groups) {
  return { count, mode, groups: Object.freeze([...groups]) };
}
