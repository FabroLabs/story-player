/** Opt-in world staging lives outside the shared timeline and its policy. */
import { CARD_BOARD } from '../../policy.mjs';
import { applyWorldCue } from './lesson-world-cues.mjs';

const round = value => Math.round(value * 100) / 100;
const mix = (a, b, u) => a + (b - a) * u;
const fail = message => { throw new Error(`board world ${message}`); };
const slug = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${name} carries unknown keys: ${unknown.join(', ')}`);
}

function tuple(value, length, name) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) fail(`${name} must carry ${length} finite numbers`);
  return [...value];
}

function propFrames(input) {
  if (!Array.isArray(input) || input.length < 2) fail('prop keyframes must include both endpoints');
  let previous = -1;
  const frames = input.map(frame => {
    keys(frame, ['at', 'box', 'opacity', 'anchor'], 'prop keyframe');
    if (!Number.isFinite(frame.at) || frame.at < 0 || frame.at > 1 || frame.at <= previous) fail('prop keyframe at values must rise from zero to one');
    previous = frame.at;
    const box = tuple(frame.box, 4, 'prop box');
    if (box[2] <= 0 || box[3] <= 0) fail('prop box must have positive dimensions');
    if (Object.hasOwn(frame, 'opacity') && (!Number.isFinite(frame.opacity) || frame.opacity < 0 || frame.opacity > 1)) fail('prop opacity must be between zero and one');
    if (Object.hasOwn(frame, 'anchor') && !['stage', 'card'].includes(frame.anchor)) fail('prop anchor must be stage or card');
    return { at: frame.at, box, ...(Object.hasOwn(frame, 'opacity') ? { opacity: frame.opacity } : {}),
      ...(Object.hasOwn(frame, 'anchor') ? { anchor: frame.anchor } : {}) };
  });
  if (frames[0].at !== 0 || frames.at(-1).at !== 1) fail('prop keyframes must start at zero and end at one');
  return frames;
}

function contentOpacity(input) {
  const opacity = value => {
    if (!Number.isFinite(value) || value < 0 || value > 1) fail('content_opacity must be between zero and one');
    return value;
  };
  if (!Array.isArray(input)) return opacity(input);
  if (input.length < 2) fail('content_opacity keyframes must include both endpoints');
  let previous = -1;
  const frames = input.map(frame => {
    keys(frame, ['at', 'opacity'], 'content_opacity keyframe');
    if (!Number.isFinite(frame.at) || frame.at < 0 || frame.at > 1 || frame.at <= previous) fail('content_opacity at values must rise from zero to one');
    previous = frame.at;
    return { at: frame.at, opacity: opacity(frame.opacity) };
  });
  if (frames[0].at !== 0 || frames.at(-1).at !== 1) fail('content_opacity keyframes must start at zero and end at one');
  return frames;
}

function propTarget(prop) {
  if (!['cards', 'card_index', 'hide_card_image'].some(key => Object.hasOwn(prop, key))) {
    if (prop.keyframes.some(frame => frame.anchor === 'card')) fail('a card anchor requires cards and card_index');
    return {};
  }
  if (!Number.isInteger(prop.card_index) || prop.card_index < 1 || prop.card_index > CARD_BOARD.max) fail('prop card_index must name a fixed card slot');
  if (!Array.isArray(prop.cards) || prop.cards.length < 1 || prop.cards.length > CARD_BOARD.max
    || !prop.cards.every(slug) || new Set(prop.cards).size !== prop.cards.length || prop.cards[prop.card_index - 1] !== prop.slug) {
    fail('prop cards must be unique safe slugs matching the target slot');
  }
  if (Object.hasOwn(prop, 'hide_card_image') && typeof prop.hide_card_image !== 'boolean') fail('hide_card_image must be boolean');
  return { cards: [...prop.cards], card_index: prop.card_index,
    ...(Object.hasOwn(prop, 'hide_card_image') ? { hide_card_image: prop.hide_card_image } : {}) };
}

function contentLayout(input) {
  keys(input, ['cards', 'prompt'], 'board content');
  const boxes = Object.fromEntries(['cards', 'prompt'].map(name => {
    const box = tuple(input[name], 4, `content ${name}`);
    if (box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > 1 || box[1] + box[3] > 1) {
      fail(`content ${name} must lie wholly inside the panel`);
    }
    return [name, box];
  }));
  const [a, b] = [boxes.cards, boxes.prompt];
  if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) {
    fail('content cards and prompt must not overlap');
  }
  return boxes;
}

function cues(input) {
  if (!Array.isArray(input)) fail('cues must be an array');
  const ids = new Set();
  let previousEnd = 0;
  return input.map(cue => {
    keys(cue, ['id', 'kind', 'start_ms', 'end_ms', 'cards', 'answer_index', 'presentation'], 'cue');
    if (!slug(cue.id) || ids.has(cue.id)) fail('cue id must be a unique safe slug');
    ids.add(cue.id);
    if (!['thinking', 'reveal'].includes(cue.kind)) fail('cue kind must be thinking or reveal');
    if (Object.hasOwn(cue, 'presentation') && (cue.kind !== 'reveal' || cue.presentation !== 'spotlight')) {
      fail('cue presentation must be spotlight and is only supported for reveal');
    }
    if (!Number.isFinite(cue.start_ms) || !Number.isFinite(cue.end_ms) || cue.start_ms < previousEnd || cue.end_ms <= cue.start_ms) {
      fail('cue windows must be finite, nonnegative, ordered and nonoverlapping');
    }
    previousEnd = cue.end_ms;
    if (!Array.isArray(cue.cards) || cue.cards.length < 1 || cue.cards.length > CARD_BOARD.max
      || !cue.cards.every(slug) || new Set(cue.cards).size !== cue.cards.length) fail('cue cards must be unique safe slugs');
    if (cue.kind === 'thinking' && Object.hasOwn(cue, 'answer_index')) fail('thinking cues cannot identify an answer');
    if (cue.kind === 'reveal' && (!Number.isInteger(cue.answer_index) || cue.answer_index < 1 || cue.answer_index > cue.cards.length)) {
      fail('reveal answer_index must name a fixed card slot');
    }
    return { id: cue.id, kind: cue.kind, start_ms: cue.start_ms, end_ms: cue.end_ms, cards: [...cue.cards],
      ...(cue.kind === 'reveal' ? { answer_index: cue.answer_index } : {}),
      ...(Object.hasOwn(cue, 'presentation') ? { presentation: cue.presentation } : {}) };
  });
}

export function requireLessonWorld(input) {
  keys(input, ['background', 'board', 'actor_box', 'phases', 'cues'], 'recipe');
  if (!slug(input.background)) fail('background must name a safe object slug');
  keys(input.board, ['style', 'panel', 'art', 'art_box', 'content'], 'board');
  if (!['garden', 'royal', 'camp', 'travel'].includes(input.board.style)) fail('board style must be garden, royal, camp or travel');
  const panel = tuple(input.board.panel, 4, 'board panel');
  if (panel[0] < 0 || panel[1] < 0 || panel[2] <= 0 || panel[3] <= 0 || panel[0] + panel[2] > 1 || panel[1] + panel[3] > 1) {
    fail('board panel must be [left, top, width, height] wholly inside the stage');
  }
  let art = {};
  if (Object.hasOwn(input.board, 'art') || Object.hasOwn(input.board, 'art_box')) {
    if (!slug(input.board.art)) fail('board art must name a safe object slug');
    const box = tuple(input.board.art_box, 4, 'board art_box');
    if (box[2] <= 0 || box[3] <= 0) fail('board art_box must have positive dimensions');
    art = { art: input.board.art, art_box: box };
  }
  const actorBox = tuple(input.actor_box, 3, 'actor_box');
  if (actorBox[2] <= 0) fail('actor_box size must be positive');
  if (!Array.isArray(input.phases) || !input.phases.length) fail('phases must be a non-empty array');
  let previousEnd = 0;
  const ids = new Set();
  const phases = input.phases.map(phase => {
    keys(phase, ['id', 'start_ms', 'end_ms', 'mode', 'props', 'content_opacity'], 'phase');
    if (!slug(phase.id) || ids.has(phase.id)) fail('phase id must be a unique safe slug');
    ids.add(phase.id);
    if (!Number.isFinite(phase.start_ms) || !Number.isFinite(phase.end_ms) || phase.start_ms !== previousEnd || phase.end_ms <= phase.start_ms) {
      fail('phase windows must be finite and contiguous, starting at zero');
    }
    previousEnd = phase.end_ms;
    if (!['world', 'lesson'].includes(phase.mode)) fail('phase mode must be world or lesson');
    if (!Array.isArray(phase.props)) fail('phase props must be an array');
    const slugs = new Set();
    const props = phase.props.map(prop => {
      keys(prop, ['slug', 'keyframes', 'cards', 'card_index', 'hide_card_image'], 'prop');
      if (!slug(prop.slug) || slugs.has(prop.slug)) fail('phase prop must name a unique safe object slug');
      slugs.add(prop.slug);
      const keyframes = propFrames(prop.keyframes);
      return { slug: prop.slug, keyframes, ...propTarget({ ...prop, keyframes }) };
    });
    return { id: phase.id, start_ms: phase.start_ms, end_ms: phase.end_ms, mode: phase.mode, props,
      ...(Object.hasOwn(phase, 'content_opacity') ? { content_opacity: contentOpacity(phase.content_opacity) } : {}) };
  });
  return { background: input.background, board: { style: input.board.style, panel, ...art,
    ...(Object.hasOwn(input.board, 'content') ? { content: contentLayout(input.board.content) } : {}) }, actor_box: actorBox, phases,
    ...(Object.hasOwn(input, 'cues') ? { cues: cues(input.cues) } : {}) };
}

export function worldObjectSlugs(world, choreography = []) {
  return world ? [...new Set([world.background, ...(world.board.art ? [world.board.art] : []), ...world.phases.flatMap(phase => phase.props.map(prop => prop.slug)),
    ...choreography.filter(track => track.prop).map(track => track.prop.slug)])] : [];
}

/** Hold the final scene at the story endpoint; seeks have no retained state. */
export function lessonWorldAt(options, tMs) {
  const world = options?.layout === 'lesson-guide' ? options.world : null;
  if (!world) return null;
  const phase = world.phases.find(item => tMs >= item.start_ms && tMs < item.end_ms)
    ?? (tMs < 0 ? world.phases[0] : world.phases.at(-1));
  return { world, phase, at: Math.max(0, Math.min(1, (tMs - phase.start_ms) / (phase.end_ms - phase.start_ms))) };
}

function segment(frames, at) {
  const index = frames.findIndex(frame => frame.at >= at);
  const right = frames[Math.max(0, index)], left = frames[Math.max(0, index - 1)];
  return [left, right, right.at === left.at ? 0 : (at - left.at) / (right.at - left.at)];
}

function matchingTarget(prop, board) {
  if (!prop.cards || prop.cards.length !== board?.cards?.length || !prop.cards.every((slug, index) => slug === board.cards[index].slug)) return null;
  const target = board.cards[prop.card_index - 1];
  return target?.slug === prop.slug && target.url ? target : null;
}

function anchoredPropBox(frame, target, width, height) {
  const inset = target ? Math.min(target.dw, target.dh) * CARD_BOARD.imageInset : 0;
  const area = frame.anchor === 'card'
    ? [target.dx + inset, target.dy + inset, target.dw - inset * 2, target.dh - inset * 2] : [0, 0, width, height];
  const [cx, cy, w, h] = frame.box;
  return [area[0] + (cx - w / 2) * area[2], area[1] + (cy - h / 2) * area[3], w * area[2], h * area[3]];
}

export function lessonWorldProps(scene, width, height, sheets, board) {
  const commands = [{ op: 'prop', slug: scene.world.background, url: sheets.prop(scene.world.background)?.url ?? null,
    dx: 0, dy: 0, dw: width, dh: height, opacity: 1, anchor: 'center', fit: 'cover', hud: true }];
  for (const prop of scene.phase.props) {
    const target = matchingTarget(prop, board);
    if (prop.cards && !target) continue;
    const [left, right, u] = segment(prop.keyframes, scene.at);
    const from = anchoredPropBox(left, target, width, height), to = anchoredPropBox(right, target, width, height);
    const values = from.map((value, index) => u === 1 ? to[index] : mix(value, to[index], u));
    const box = Object.fromEntries(['dx', 'dy', 'dw', 'dh'].map((key, index) => [key, target ? values[index] : round(values[index])]));
    commands.push({ op: 'prop', slug: prop.slug, url: sheets.prop(prop.slug)?.url ?? null,
      ...box,
      opacity: Math.round(mix(left.opacity ?? 1, right.opacity ?? 1, u) * 10000) / 10000, anchor: 'center', hud: true });
  }
  return commands;
}

export function lessonWorldActorBox(world, width, height) {
  const [cx, feet, size] = world.actor_box;
  return { dx: round(cx * width - size * height / 2), dy: round((feet - size) * height), dw: round(size * height), dh: round(size * height) };
}

/** The sitting rim and target cells stay fixed while the board fades into the world. */
export function lessonWorldBoard(board, scene, tMs, width, height, sheets, reducedMotion = false) {
  const [left, top, w, h] = scene.world.board.panel;
  const entering = scene.phase.mode === 'lesson' && scene.phase.start_ms > 0
    && scene.world.phases[scene.world.phases.indexOf(scene.phase) - 1]?.mode !== 'lesson';
  const progress = entering ? Math.max(0, Math.min(1, (tMs - scene.phase.start_ms) / 300)) : 1;
  const panel = { x: round(left * width), y: round(top * height),
    w: round(w * width), h: round(h * height), r: round(height * .018) };
  const cards = board?.cards ?? [];
  const content = scene.world.board.content;
  const row = content?.cards ?? [.04, .285, .92, .56];
  const rowWidth = panel.w * row[2], rowHeight = panel.h * row[3];
  const cell = cards.length ? Math.min(rowWidth / cards.length, rowHeight) : 0;
  const side = cell * .94;
  const fade = scene.phase.content_opacity ?? 1;
  const [from, to, u] = Array.isArray(fade) ? segment(fade, scene.at) : [{ opacity: fade }, { opacity: fade }, 0];
  let art = {};
  if (scene.world.board.art) {
    const [x, y, w, h] = scene.world.board.art_box;
    art = { art: { slug: scene.world.board.art, url: sheets.prop(scene.world.board.art)?.url ?? null,
      dx: x * width, dy: y * height, dw: w * width, dh: h * height } };
  }
  const result = { op: 'slate', hud: true, mode: 'cards', world: { style: scene.world.board.style,
    opacity: 1 - (1 - progress) ** 3, contentOpacity: mix(from.opacity, to.opacity, u), ...art,
    ...(content ? { cardStyle: 'paper' } : {}) }, panel,
    cards: cards.map((card, index) => ({ ...card,
      dx: round(panel.x + panel.w * row[0] + (rowWidth - cell * cards.length) / 2 + cell * index + (cell - side) / 2),
      dy: round(panel.y + panel.h * row[1] + (rowHeight - side) / 2), dw: round(side), dh: round(side),
    })),
    prompt: { text: board?.prompt?.text ?? '', cx: round(panel.x + panel.w / 2), cy: round(panel.y + panel.h * .92),
      maxWidth: round(rowWidth), size: round(Math.min(panel.h * .078, width * .026)) },
  };
  if (content) {
    const [x, y, w, h] = content.prompt, bandHeight = h * panel.h;
    result.prompt = { text: result.prompt.text, cx: round(panel.x + (x + w / 2) * panel.w),
      cy: round(panel.y + y * panel.h + bandHeight * .36), maxWidth: round(w * panel.w),
      size: round(bandHeight * .68),
      indicator: { cy: round(panel.y + y * panel.h + bandHeight * .87), r: round(bandHeight * .055) } };
  }
  for (const prop of scene.phase.props) {
    const target = matchingTarget(prop, result);
    if (prop.hide_card_image && target) target.imageHidden = true;
  }
  return applyWorldCue(result, scene, tMs, reducedMotion);
}
