import { CARD_BOARD } from '../../policy.mjs';
import { readFarmBoard } from '../../core/farm-board.mjs';
import { readFarmJourney } from '../../core/farm-journey.mjs';
import { readOceanBoard } from '../../core/ocean-board.mjs';
import { lessonGuideBox } from './lesson-guide-layout.mjs';
import { lessonWorldAt } from './lesson-world.mjs';

const round = value => Math.round(value * 100) / 100;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slug = value => typeof value === 'string' && value.length > 0 && !/\s/.test(value);
const fail = message => { throw new Error(`board choreography ${message}`); };

function keys(value, allowed, name) {
  if (!record(value)) fail(`${name} must be an object`);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${name} carries an unknown key`);
}

function tuple(value, size, name) {
  if (!Array.isArray(value) || value.length !== size || !value.every(Number.isFinite)) fail(`${name} must carry ${size} finite numbers`);
  return [...value];
}

function opacity(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) fail('opacity must be between zero and one');
  return value;
}

function keyframes(input, actor) {
  if (!Array.isArray(input) || input.length < 2) fail('keyframes must include both endpoints');
  let previous = -1;
  const frames = input.map(frame => {
    keys(frame, actor ? ['at', 'box', 'opacity', 'clip'] : ['at', 'anchor', 'box', 'opacity'], 'keyframe');
    if (!Number.isFinite(frame.at) || frame.at < 0 || frame.at > 1 || frame.at <= previous) fail('keyframe at values must rise from zero to one');
    previous = frame.at;
    const box = tuple(frame.box, actor ? 3 : 4, 'keyframe box');
    if (actor ? box[2] <= 0 : box[2] <= 0 || box[3] <= 0) fail('box size must be positive');
    const result = { at: frame.at, ...(actor ? {} : { anchor: frame.anchor }), box };
    if (!actor && !['card', 'actor', 'stage'].includes(frame.anchor)) fail('prop anchor must be card, actor or stage');
    if (Object.hasOwn(frame, 'opacity')) result.opacity = opacity(frame.opacity);
    if (Object.hasOwn(frame, 'clip')) {
      const clip = tuple(frame.clip, 4, 'actor clip');
      if (clip[2] <= clip[0] || clip[3] <= clip[1]) fail('actor clip must have positive width and height');
      result.clip = clip;
    }
    return result;
  });
  if (frames[0].at !== 0 || frames.at(-1).at !== 1) fail('keyframes must start at zero and end at one');
  return frames;
}

/** Copy the host's presentation recipe; timeline and caller-owned data stay untouched. */
export function requireChoreography(input) {
  if (!Array.isArray(input)) fail('must be an array');
  let previousEnd = 0;
  const ids = new Set();
  return input.map(track => {
    keys(track, ['id', 'kind', 'start_ms', 'end_ms', 'actor', 'prop', 'caption'], 'track');
    if (!slug(track.id) || ids.has(track.id)) fail('track id must be unique and non-empty without whitespace');
    ids.add(track.id);
    if (!['peek', 'push', 'carry', 'perch', 'run', 'hop', 'grab'].includes(track.kind)) fail('kind must name a supported presentation action');
    if (Object.hasOwn(track, 'caption') && track.caption !== 'top') fail('caption must be top when supplied');
    if (!Number.isFinite(track.start_ms) || !Number.isFinite(track.end_ms) || track.start_ms < previousEnd || track.end_ms <= track.start_ms) {
      fail('windows must be finite, chronological and non-overlapping');
    }
    previousEnd = track.end_ms;
    keys(track.actor, ['mirror', 'keyframes'], 'actor');
    if (Object.hasOwn(track.actor, 'mirror') && typeof track.actor.mirror !== 'boolean') fail('actor mirror must be boolean');
    const actor = {
      ...(Object.hasOwn(track.actor, 'mirror') ? { mirror: track.actor.mirror } : {}),
      keyframes: keyframes(track.actor.keyframes, true),
    };
    const result = { id: track.id, kind: track.kind, start_ms: track.start_ms, end_ms: track.end_ms, actor };
    if (Object.hasOwn(track, 'caption')) result.caption = track.caption;
    if (Object.hasOwn(track, 'prop')) {
      keys(track.prop, ['slug', 'cards', 'card_index', 'hide_card_image', 'keyframes'], 'prop');
      if (!slug(track.prop.slug)) fail('prop slug must be non-empty without whitespace');
      if (!Number.isInteger(track.prop.card_index) || track.prop.card_index < 1 || track.prop.card_index > CARD_BOARD.max) fail('prop card_index must name a fixed card slot');
      const cards = track.prop.cards;
      if (!Array.isArray(cards) || cards.length < 1 || cards.length > CARD_BOARD.max || !cards.every(slug)
        || new Set(cards).size !== cards.length || cards[track.prop.card_index - 1] !== track.prop.slug) {
        fail('prop cards must give a unique ordered board matching its target slot');
      }
      if (Object.hasOwn(track.prop, 'hide_card_image') && typeof track.prop.hide_card_image !== 'boolean') fail('hide_card_image must be boolean');
      result.prop = {
        slug: track.prop.slug, cards: [...cards], card_index: track.prop.card_index,
        ...(Object.hasOwn(track.prop, 'hide_card_image') ? { hide_card_image: track.prop.hide_card_image } : {}),
        keyframes: keyframes(track.prop.keyframes, false),
      };
    }
    return result;
  });
}

/** Renditions cover every authored guide size, including a paused enlarged pose. */
export function lessonGuideHeight(options, height) {
  let size = Math.max(lessonGuideBox(0, height).dh, (options?.world?.actor_box?.[2] ?? 0) * height);
  for (const track of options?.choreography ?? []) {
    for (const frame of track.actor.keyframes) size = Math.max(size, frame.box[2] * height);
  }
  return size;
}

function segment(frames, at) {
  const index = frames.findIndex(frame => frame.at >= at);
  const right = frames[Math.max(0, index)];
  const left = frames[Math.max(0, index - 1)];
  const u = right.at === left.at ? 0 : (at - left.at) / (right.at - left.at);
  return [left, right, u];
}

const mix = (a, b, u) => a + (b - a) * u;
const mixed = (a, b, u) => a.map((value, index) => mix(value, b[index], u));
const rect = values => Object.fromEntries(['dx', 'dy', 'dw', 'dh'].map((key, index) => [key, round(values[index])]));
const exactRect = values => Object.fromEntries(['dx', 'dy', 'dw', 'dh'].map((key, index) => [key, values[index]]));

function choreographyAt(options, tMs, cards) {
  const track = options?.choreography?.find(item => tMs >= item.start_ms && tMs < item.end_ms);
  if (!track) return null;
  if (track.prop && (!cards || track.prop.cards.length !== cards.length || !track.prop.cards.every((slug, index) => slug === cards[index]))) return null;
  return track;
}

function activeGuideTrack(options, state) {
  const world = lessonWorldAt(options, state.tMs);
  if (world) {
    if (!(state.actors ?? []).some(actor => actor.slug === options.guide && actor.kind !== 'object' && actor.opacity > 0 && actor.heightPx > 0)) return null;
    const track = options.choreography?.find(item => state.tMs >= item.start_ms && state.tMs < item.end_ms);
    return choreographyAt(options, state.tMs, world.phase.mode === 'world' ? track?.prop?.cards : state.slate?.cards);
  }
  if (options?.layout !== 'lesson-guide' || !state.slate || !(state.slate.standing ?? state.slate.count > 0)) return null;
  if (state.slate.mode !== 'cards' && state.slate.count !== 0) return null;
  if (readFarmBoard(state.slate) || readFarmJourney(state.slate) || readOceanBoard(state.slate)) return null;
  if (!(state.actors ?? []).some(actor => actor.slug === options.guide && actor.kind !== 'object' && actor.opacity > 0 && actor.heightPx > 0)) return null;
  return choreographyAt(options, state.tMs, state.slate.cards);
}

/** Active presentation must repaint even while the native clip is holding a cell. */
export function choreographyPhase(options, state) {
  const track = activeGuideTrack(options, state);
  return track ? `${track.id}:${state.tMs}` : null;
}

/** Native captions can clear a finite movement lane without changing timeline state. */
export function choreographyCaption(options, state) {
  return activeGuideTrack(options, state)?.caption ?? null;
}

function anchoredBox(frame, actor, card, width, height) {
  const space = frame.anchor === 'actor' ? actor : frame.anchor === 'card' ? card : { dx: 0, dy: 0, dw: width, dh: height };
  const [cx, cy, w, h] = frame.box;
  return [space.dx + (cx - w / 2) * space.dw, space.dy + (cy - h / 2) * space.dh, w * space.dw, h * space.dh];
}

/** One instant, computed entirely from story time. An answer-board mismatch disables the skit. */
export function lessonGuideChoreography(options, board, tMs, width, height, actorOpacity, sheets) {
  const track = choreographyAt(options, tMs, board.cards?.map(card => card.slug));
  if (!track) return null;
  const target = track.prop ? board.cards?.[track.prop.card_index - 1] : null;
  if (track.prop && (target?.slug !== track.prop.slug || !target.url)) return null;
  const at = (tMs - track.start_ms) / (track.end_ms - track.start_ms);
  const [left, right, u] = segment(track.actor.keyframes, at);
  const [x, feet, size] = mixed(left.box, right.box, u);
  const side = size * height;
  const actor = { ...rect([x * width - side / 2, feet * height - side, side, side]),
    opacity: Math.round(actorOpacity * mix(left.opacity ?? 1, right.opacity ?? 1, u) * 10000) / 10000 };
  if (track.actor.mirror) actor.mirror = true;
  if (track.actor.keyframes.some(frame => frame.clip)) {
    const [l, t, r, b] = mixed(left.clip ?? [0, 0, 1, 1], right.clip ?? [0, 0, 1, 1], u);
    actor.clip = { x: round(l * width), y: round(t * height), w: round((r - l) * width), h: round((b - t) * height) };
  }
  let prop = null;
  let paintedBoard = board;
  if (track.prop) {
    const inset = Math.min(target.dw, target.dh) * CARD_BOARD.imageInset;
    const card = { dx: target.dx + inset, dy: target.dy + inset, dw: target.dw - 2 * inset, dh: target.dh - 2 * inset };
    const [from, to, progress] = segment(track.prop.keyframes, at);
    prop = { op: 'prop', slug: track.prop.slug, url: sheets.prop(track.prop.slug)?.url ?? target.url,
      // Card paint retains its inset precision; the dock must use that identical rectangle.
      ...exactRect(mixed(anchoredBox(from, actor, card, width, height), anchoredBox(to, actor, card, width, height), progress)),
      opacity: Math.round(mix(from.opacity ?? 1, to.opacity ?? 1, progress) * 10000) / 10000, anchor: 'center', hud: true };
    if (track.prop.hide_card_image) paintedBoard = { ...board,
      cards: board.cards.map((item, index) => index === track.prop.card_index - 1 ? { ...item, imageHidden: true } : item) };
  }
  return { board: paintedBoard, actor, prop };
}
