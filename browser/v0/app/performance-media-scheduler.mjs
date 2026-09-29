import { performanceAudioAt, performanceSoundsBetween } from '../core/performance/audio.mjs';
import { NARRATION_GRACE_MS } from '../policy.mjs';
import { createAudioStore } from './audio-store.mjs';

/**
 * Everything a performance sounds, on the story's clock.
 *
 * The schedule is the document's own `audio` list; this file only keeps each medium where the
 * clock says it is. Three rules make it safe against a slow link:
 *
 *   narration is in memory before it is due — `audio-store.mjs` downloads every line in playing
 *   order after begin (only the opening lines before it), and `blocker` tells the runtime to hold the story
 *   at a line (or at the start of a bed or song) that has not landed, instead of cutting it
 *   a line starts no later than its first word — when it is noticed late, at most its silent
 *   lead-in is skipped; only a viewer's seek lands inside a line
 *   a started line may run past its window by `NARRATION_GRACE_MS`, then is let go; a seek or a
 *   teardown still cuts it at once
 */

// `HTMLMediaElement.HAVE_FUTURE_DATA`: enough to start playing.
const PLAYABLE = 3;
// A bed or song is opened this far ahead of its start, so the story rarely has to wait for it.
const TRACK_AHEAD_MS = 3000;
// And never waited for longer than this: a phone that buffers nothing before `play()` would
// otherwise hold every story at every track. Past it, the track joins when it can.
const TRACK_WAIT_MS = 1500;

export function createPerformanceMediaScheduler({ bundle, onWarning, store = null }) {
  let story = bundle;
  let playing = false;
  let destroyed = false;
  let now = 0;
  let prepared = false;
  // The instant a seek landed on, until time moves: a line opened there lands exactly inside it.
  let landedAt = null;
  const narration = () => story.audio.filter(c => c.kind === 'narration');
  const lines = store ?? createAudioStore(narration());
  const active = new Map();
  const finishing = new Map();
  const ahead = new Map();
  // One-shots sounding now, with their cues: a hold pauses them and a resume goes on with them.
  const sounds = new Map();
  const delivered = new Set();
  const report = (cue, error) => onWarning({ type: 'media', asset: cue.kind,
    message: 'Required story audio failed: ' + (error?.message ?? error), cue: cue.id });
  // Media this scheduler paused or released since it last asked them to play. A pending play()
  // that the browser then rejects with AbortError was interrupted by us, not refused by the
  // device, and is not a story media failure.
  const interrupted = new WeakSet();
  const halt = (media) => { interrupted.add(media); media.pause(); };
  const release = (media) => { halt(media); media.removeAttribute?.('src'); media.load?.(); };

  return {
    prepare, blocker,
    loaded: () => lines.whenAll(),
    advance(from, to) {
      if (destroyed) return;
      // `to` is the exclusive end of the slice; the instant being played is just before it, and
      // `tick` syncs that same instant.
      sync(Math.max(from, to - 1));
      for (const cue of performanceSoundsBetween(story, from, to)) {
        if (delivered.has(cue.id)) continue;
        delivered.add(cue.id);
        const media = open(cue);
        sounds.set(media, cue);
        media.addEventListener('ended', () => { sounds.delete(media); release(media); }, { once: true });
        start(media, cue);
      }
    },
    seek(t) {
      if (destroyed) return;
      clearSounds();
      delivered.clear();
      for (const item of finishing.values()) release(item.media);
      finishing.clear();
      releaseAhead();
      landedAt = t;
      lines.seek(t);
      sync(t, true);
    },
    tick(t) { if (!destroyed) sync(t); },
    pause() {
      playing = false;
      clearSounds();
      for (const item of [...active.values(), ...finishing.values()]) halt(item.media);
    },
    // A hold is a pause the story comes back from where it stood: one-shots wait with it.
    hold() {
      playing = false;
      for (const media of sounds.keys()) halt(media);
      for (const item of [...active.values(), ...finishing.values()]) halt(item.media);
    },
    settle() { this.pause(); },
    // A line that has already finished stays finished: play() would start it again from 0.
    resume() {
      if (destroyed) return;
      if (prepared) lines.start(now);
      playing = true;
      for (const item of [...active.values(), ...finishing.values()]) if (!item.media.ended) start(item.media, item.cue);
      for (const [media, cue] of sounds) if (!media.ended) start(media, cue);
    },
    unlock() { return Promise.resolve(); },
    setStory(next) { story = next.bundle; sync(now); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      playing = false;
      clearSounds();
      for (const item of [...active.values(), ...finishing.values(), ...ahead.values()]) release(item.media);
      active.clear();
      finishing.clear();
      ahead.clear();
      lines.destroy();
    },
  };

  /**
   * The gate: the opening's sound, ready to play from its start.
   *
   * The first two narration lines in memory, and every bed or song sounding before the second
   * one playable from its own beginning. Later lines wait until begin.
   */
  function prepare() {
    prepared = true;
    const opening = narration().sort((a, b) => a.start_ms - b.start_ms).slice(0, 2);
    if (lines.prime) lines.prime(opening);
    else lines.start(0);
    const until = opening.at(-1)?.start_ms ?? 0;
    const tracks = story.audio.filter(c => continuous(c) && c.start_ms <= until);
    return Promise.all([
      ...opening.map(cue => lines.whenReady(cue)),
      ...tracks.map(cue => waitFor(preopen(cue))),
    ]).then(() => {});
  }

  /**
   * The first instant in `[fromMs, toMs)` whose sound is not ready, and a promise for when it is.
   *
   * Asked by the runtime before it crosses a slice, so the story stops just short of it instead of
   * cutting what it could not play. `fromMs` itself counts — a seek lands there, and a line it
   * lands inside must be here as well. A bed or song holds the story only at its own start.
   */
  function blocker(fromMs, toMs) {
    if (destroyed) return null;
    const instants = [fromMs, ...story.audio.filter(c => c.kind !== 'sfx' && c.start_ms > fromMs && c.start_ms < toMs)
      .map(c => c.start_ms)].sort((a, b) => a - b);
    for (const atMs of instants) {
      for (const cue of performanceAudioAt(story, atMs)) {
        if (active.has(cue.id)) continue;
        if (cue.kind === 'narration' && !lines.ready(cue)) return { atMs, until: () => lines.whenReady(cue) };
        if (continuous(cue) && cue.start_ms === atMs) {
          const item = preopen(cue);
          if (!isPlayable(item.media) && !item.waited) return { atMs, until: () => waitFor(item) };
        }
      }
    }
    return null;
  }

  function sync(tMs, seeking = false) {
    if (tMs !== landedAt) landedAt = null;
    now = tMs;
    const wanted = performanceAudioAt(story, tMs);
    const ids = new Set(wanted.map(c => c.id));
    for (const [id, item] of active) {
      if (ids.has(id)) continue;
      active.delete(id);
      if (mayFinish(item, tMs)) finishing.set(id, item);
      else release(item.media);
    }
    for (const [id, item] of finishing) {
      if (item.media.ended || tMs >= windowEnd(item.cue) + NARRATION_GRACE_MS) { release(item.media); finishing.delete(id); }
    }
    for (const [id, item] of ahead) {
      if (windowEnd(item.cue) <= tMs) { release(item.media); ahead.delete(id); }
    }
    for (const cue of story.audio) {
      if (continuous(cue) && cue.start_ms > tMs && cue.start_ms <= tMs + TRACK_AHEAD_MS) preopen(cue);
    }
    for (const cue of wanted) {
      let item = active.get(cue.id);
      if (!item) {
        // Not here yet: the runtime holds the story on it (`blocker`) rather than play a gap.
        if (cue.kind === 'narration' && !lines.ready(cue)) continue;
        item = enter(cue, tMs === landedAt);
      } else if (seeking) item.media.currentTime = cue.offset_ms / 1000;
      item.media.volume = cue.volume;
    }
  }

  /**
   * Put a cue on, from where it should be heard.
   *
   * A narration line noticed late starts at its first word: at most its silent lead-in is skipped
   * and the line is late rather than cut. Beds and music keep their musical time; a seek always
   * lands exactly. A browser may drop a position set before the metadata, so it is set again then.
   */
  function enter(cue, exact) {
    const entry = exact || cue.kind !== 'narration' ? cue.offset_ms : Math.min(cue.offset_ms, cue.metadata?.lead_in_ms ?? 0);
    const media = ahead.get(cue.id)?.media ?? open(cue);
    ahead.delete(cue.id);
    const item = { media, cue };
    active.set(cue.id, item);
    media.addEventListener('loadedmetadata', () => {
      if (destroyed || active.get(cue.id) !== item) return;
      if (!exact && cue.kind === 'narration') { media.currentTime = entry / 1000; return; }
      const current = performanceAudioAt(story, now).find(c => c.id === cue.id);
      if (current) media.currentTime = current.offset_ms / 1000;
    });
    if (media.currentTime !== entry / 1000) media.currentTime = entry / 1000;
    start(media, cue);
    return item;
  }

  /** A line that is speaking when its window closes may finish its sentence, within the grace. */
  function mayFinish(item, tMs) {
    return item.cue.kind === 'narration' && playing && !item.media.ended && !item.media.paused
      && tMs < windowEnd(item.cue) + NARRATION_GRACE_MS;
  }

  /** A bed's or song's element, opened paused at its start so the gate or a hold can wait on it. */
  function preopen(cue) {
    let item = ahead.get(cue.id);
    // An element that failed has nothing more to say: a retry opens the file afresh.
    if (item?.media.error) {
      release(item.media);
      ahead.delete(cue.id);
      item = null;
    }
    if (!item) {
      item = { media: open(cue), cue };
      ahead.set(cue.id, item);
    }
    return item;
  }

  function releaseAhead() {
    for (const item of ahead.values()) release(item.media);
    ahead.clear();
  }

  function start(media, cue) {
    if (!playing || destroyed) return;
    interrupted.delete(media);
    Promise.resolve(media.play()).catch((error) => {
      if (error?.name === 'AbortError' && (destroyed || interrupted.has(media))) return;
      report(cue, error);
    });
  }

  function open(cue) {
    const media = new Audio();
    media.preload = 'auto';
    media.src = cue.kind === 'narration' ? lines.url(cue) : cue.url ?? cue.media;
    media.volume = cue.volume ?? 1;
    media.loop = cue.loop === true;
    media.addEventListener('error', () => {
      if (destroyed) return;
      const detail = media.error;
      report(cue, new Error(detail
        ? `media unavailable (code ${detail.code}: ${detail.message || 'no decoder detail'})`
        : 'media unavailable'));
    });
    return media;
  }

  function clearSounds() { for (const media of sounds.keys()) release(media); sounds.clear(); }
}

function continuous(cue) {
  return cue.kind !== 'sfx' && cue.kind !== 'narration';
}

function windowEnd(cue) {
  return cue.end_ms ?? cue.start_ms + cue.duration_ms;
}

function isPlayable(media) {
  return !(media.readyState < PLAYABLE);
}

function playable(item) {
  if (isPlayable(item.media)) return Promise.resolve();
  return new Promise((resolve) => {
    item.media.addEventListener('canplay', resolve, { once: true });
    item.media.addEventListener('error', resolve, { once: true });
  });
}

/** Playable, or `TRACK_WAIT_MS` gone by — after which the story no longer waits for this track. */
function waitFor(item) {
  let timer = null;
  const patience = new Promise((resolve) => { timer = setTimeout(resolve, TRACK_WAIT_MS); });
  return Promise.race([playable(item), patience]).finally(() => {
    clearTimeout(timer);
    item.waited = true;
  });
}
