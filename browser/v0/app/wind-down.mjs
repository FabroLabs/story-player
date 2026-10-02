/**
 * What a bedtime story asks for after its narrative, and the arithmetic of it.
 *
 * Pure: no DOM, no clock, no audio. `wind-down-phase.mjs` applies these to the
 * sky layer and the ambience element. Ported from the web app's own
 * (`frontend-app/src/lib/playback/wind-down.ts`), which played it before the
 * player did, so one story ends the same way in every host.
 */

const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_BASE = '#020304';
/** An ambience that stopped this close to its end has run out. */
const END_SLACK_S = 0.05;

/**
 * The wind-down a bedtime document asks for, or null when it has none that
 * can be played. Colours are checked because they end up in inline styles.
 */
export function readPostStory(story) {
  if (story?.performance?.kind !== 'bedtime') return null;
  const post = story?.metadata?.post_story;
  if (!isRecord(post)) return null;
  const sky = isRecord(story.assets) ? story.assets[post.background_asset] : null;
  const ambience = isRecord(post.ambience) ? post.ambience : null;
  if (
    !isNumber(post.starts_at_ms) || post.starts_at_ms <= 0
    || !isText(sky?.media) || !ambience || !isText(ambience.media)
    || !isNumber(ambience.from_ms) || ambience.from_ms < 0
    || !isNumber(ambience.to_ms) || ambience.to_ms <= ambience.from_ms
  ) {
    return null;
  }
  const reveal = isRecord(post.reveal) ? post.reveal : {};
  const dim = isRecord(post.dim_overlay) ? post.dim_overlay : {};
  const baseColor = color(post.base_color, DEFAULT_BASE);
  return {
    skyMedia: sky.media,
    baseColor,
    dimColor: color(dim.color, baseColor),
    dimOpacity: isNumber(dim.opacity) ? unit(dim.opacity) : 0.3,
    revealMs: isNumber(reveal.duration_ms) && reveal.duration_ms > 0 ? reveal.duration_ms : 0,
    easing: reveal.easing === 'linear' ? 'linear' : 'smoothstep',
    ambience: {
      media: ambience.media,
      fromMs: ambience.from_ms,
      toMs: ambience.to_ms,
      volume: isNumber(ambience.volume) ? unit(ambience.volume) : 1,
    },
  };
}

/** How far the sky has come up over the base colour, `seconds` into the ambience medium. */
export function skyOpacity(post, seconds) {
  if (post.revealMs <= 0) return 1;
  const progress = unit((seconds - post.ambience.fromMs / 1000) / (post.revealMs / 1000));
  return post.easing === 'linear' ? progress : progress * progress * (3 - 2 * progress);
}

/** The wind-down's whole length, in seconds. */
export function windDownSeconds(post) {
  return (post.ambience.toMs - post.ambience.fromMs) / 1000;
}

/** Whole seconds of wind-down left, counted up, as the readout shows them. */
export function secondsLeft(post, seconds) {
  return Math.max(0, Math.ceil(post.ambience.toMs / 1000 - seconds));
}

/** The ambience has reached the end of the wind-down, or stopped just short of it. */
export function windDownOver(post, seconds, paused) {
  const end = post.ambience.toMs / 1000;
  return seconds >= end || (paused && seconds >= end - END_SLACK_S);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

function unit(value) {
  return Math.min(1, Math.max(0, value));
}

function color(value, fallback) {
  return typeof value === 'string' && COLOR.test(value) ? value : fallback;
}
