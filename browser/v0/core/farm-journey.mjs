import { clampOffset, framingBetween, WIDE_FRAMING } from './state/camera.mjs';

export const JOURNEY_MS = 2800;
export const JOURNEY_LABEL_MS = 4200;
const NAMES = new Set(['wide', 'cow', 'sheep', 'goat', 'pig', 'horse', 'donkey', 'dog', 'cat', 'rabbit', 'chicken', 'duck', 'goose']);
const INVALID = Object.freeze({kind:'invalid'});

// Complete authored endpoints keep this private presentation seekable without
// adding camera operations to the public timeline contract.
export function readFarmJourney(board) {
  const cards = board?.cards;
  if (!Array.isArray(cards) || !cards.some(s => typeof s === 'string' && s.startsWith('farm_view_'))) return null;
  const match = /^farm_view_([a-z]+)_([a-z]+)$/.exec(cards.at(-1));
  if (!match || cards.length !== 2 || !NAMES.has(match[1]) || !NAMES.has(match[2])
    || typeof cards[0] !== 'string' || !cards[0].startsWith('animal_') || !NAMES.has(cards[0].slice(7)) || cards[0] === 'animal_wide' || board.focus != null) return INVALID;
  if (match[2] !== 'wide' && cards[0] !== `animal_${match[2]}`) return INVALID;
  return {kind:'journey',from:match[1],to:match[2]};
}

function endpoint(name, state) {
  if (name === 'wide') return WIDE_FRAMING;
  const actor = state.actors?.find(a=>a.slug === `animal_${name}` && a.kind === 'object');
  if (!actor || ![actor.x,actor.feetY,actor.heightPx].every(Number.isFinite) || actor.heightPx <= 0)
    return WIDE_FRAMING;
  const height = state.plate?.resolution?.[1] || 1080;
  const scale = {cow:2.2,sheep:2.4,goat:2.4,pig:3,horse:3.2,donkey:3.2,dog:2.6,cat:3.2,rabbit:3.2,chicken:3.2,duck:3.2,goose:3.4}[name];
  const centerY = actor.feetY - actor.heightPx / height * 50;
  return {scale,x:clampOffset(50-scale*actor.x,scale),y:clampOffset(50-scale*centerY,scale)};
}

export function journeyCamera(state) {
  const view = readFarmJourney(state?.slate);
  if (view?.kind !== 'journey') return state?.camera ?? WIDE_FRAMING;
  const elapsed = Math.max(0,(state.tMs ?? 0)-(state.slate.sinceMs ?? 0));
  const value = framingBetween(endpoint(view.from,state),endpoint(view.to,state),Math.min(1,elapsed/JOURNEY_MS));
  return {scale:Number(value.scale.toFixed(6)),x:Number(value.x.toFixed(4)),y:Number(value.y.toFixed(4))};
}

export function journeyLabel(state,width,height) {
  const view = readFarmJourney(state?.slate);
  if (view?.kind !== 'journey' || view.to === 'wide' || !state.slate.prompt) return [];
  const elapsed = (state.tMs ?? 0)-(state.slate.sinceMs ?? 0);
  const alpha = Math.max(0,Math.min(1,(elapsed-3800)/400));
  if (!alpha) return [];
  const actor = state.actors?.find(a=>a.slug === `animal_${view.to}`);
  if (!actor) return [];
  const camera = journeyCamera(state);
  const centerX = (actor.x*camera.scale+camera.x)/100*width;
  return [{op:'farm-label',hud:true,text:state.slate.prompt,opacity:alpha,
    x:centerX-width*.11,y:height*.04+(1-alpha)*18,w:width*.22,h:height*.13}];
}


/** A standing camera can outlive its actors at a scene cut. Check after every
 * same-time group so placing the actors again at that cut remains valid. */
export function withFarmTargetWarnings(events) {
  const result = [], props = new Set();
  let view = null, sceneIndex = null, lastMissing = '';
  for (let i = 0; i < events.length;) {
    const time = events[i].t_ms;
    let origin = events[i];
    do {
      const event = events[i++];
      result.push(event);
      if (event.source !== 'stage') continue;
      origin = event;
      if (event.op === 'scene') { props.clear(); sceneIndex = event.scene_index; lastMissing = ''; }
      if (event.op === 'place_object') props.add(event.slug);
      if (event.op === 'remove_object') props.delete(event.slug);
      if (event.op === 'slate') view = event.mode === 'cards' ? readFarmJourney(event) : null;
    } while (i < events.length && events[i].t_ms === time);
    const missing = view?.kind === 'journey'
      ? [...new Set([view.from, view.to])].filter(name => name !== 'wide' && !props.has(`animal_${name}`)) : [];
    const key = missing.join(',');
    if (i < events.length && key && key !== lastMissing) result.push({
      t_ms: time, source: 'step', scene_index: sceneIndex, line: origin.line ?? null, kind: 'warning',
      detail: {type:'policy',policy:'farm-camera-target-missing',targets:missing},
    });
    lastMissing = key;
  }
  return result;
}
