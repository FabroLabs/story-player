/**
 * Everything you hear, on the story's clock.
 *
 * The director this replaces OWNED the schedule: it awaited each narration file
 * and the story's time was whatever that await had cost. Here the schedule is
 * already decided — `cuesBetween` says what starts in the slice of time the
 * runtime just crossed — so this file only has to obey it, which is what makes
 * pausing and seeking possible at all:
 *
 *   pause      every medium stops where it is; nothing is rescheduled
 *   seek       `soundingAt` says what should be SOUNDING at the instant landed
 *              on, and how far into it — one narration, one music track, no
 *              replay of ten minutes of sound effects
 *   fades      advanced by `tick(t)` on STORY time, not by `requestAnimationFrame`
 *              on the browser's: a duck that kept easing through a pause would
 *              come back at a volume the story never asked for
 *
 * Failures are named once per medium and never stop the story. The distinction
 * that matters is between a refusal the DEVICE made — an autoplay policy, an
 * audio session taken away — and the one this file made itself: pausing a
 * medium rejects its own pending `play()` with `AbortError`, and reporting that
 * would fill the log with failures every time somebody drags the scrub bar.
 */

import { cuesBetween, soundingAt } from '../core/state/cues.mjs';
import {
  DUCKED_MUSIC_VOLUME,
  DUCK_FADE_MS,
  MUSIC_FADE_MS,
  MUSIC_VOLUME,
} from '../policy.mjs';

// A narration crossed within this much of its own cue starts from the top.
// Anything later — a slow frame, a seek, a tab that came back — starts inside
// the file, because a line that begins half a second after its subtitle is a
// line out of sync with the picture for its whole length.
const LATE_START_MS = 120;

export function createMediaScheduler({ timeline, bundle, onWarning = () => {} }) {
  const owned = new Map();
  const fades = new Map();
  const sounds = new Set();
  const named = new Set();
  let narration = null;
  let music = null;
  let held = new Set();
  let context = null;
  let destroyed = false;
  // Swapped when a streaming host publishes another scene. Everything the
  // schedule is read from goes through here, so the cue after the append comes
  // off the grown timeline and the one before it off the same events as before.
  let story = { timeline, bundle };

  return { advance, seek, tick, pause, resume, unlock, destroy, setStory };

  function setStory(next) {
    story = { timeline: next.timeline, bundle: next.bundle };
  }

  /** Start whatever begins in `[fromMs, toMs)`. The runtime crosses time once. */
  function advance(fromMs, toMs) {
    if (destroyed) return;
    for (const cue of cuesBetween(story.timeline, story.bundle, fromMs, toMs)) {
      if (cue.kind === 'narration') startNarration(cue, toMs - cue.tMs, toMs);
      else if (cue.kind === 'sound') startSound(cue);
      else setMusic(cue, toMs);
    }
  }

  /**
   * Land at `tMs`: the sound of that instant, and nothing else.
   *
   * Sound effects are deliberately not replayed — an effect is a moment, and
   * `soundingAt` already refuses to report one — so a seek is silent until the
   * next cue the story crosses.
   */
  function seek(tMs) {
    if (destroyed) return;
    // A fade is a line drawn between two instants of STORY time, and a seek
    // moves that time out from under it: landing before a fade began leaves it
    // clamped at its starting volume for as long as it takes the story to reach
    // its start again — a track stuck loud, or one that never releases. A cut
    // finishes every fade instead.
    settleFades();
    stopNarration();
    for (const sound of [...sounds]) release(sound);
    const sounding = soundingAt(story.timeline, story.bundle, tMs);
    if (sounding.narration) startNarration(sounding.narration, sounding.narration.offsetMs, tMs);
    if (!sounding.music) stopMusic(tMs);
    else if (sounding.music.name !== music?.name) setMusic(sounding.music, tMs);
  }

  /** Advance the fades, and notice a narration that has run out. */
  function tick(tMs) {
    if (destroyed) return;
    for (const [media, fade] of [...fades]) {
      const progress = fade.durationMs > 0
        ? Math.min(1, Math.max(0, (tMs - fade.startMs) / fade.durationMs))
        : 1;
      media.volume = clampVolume(fade.from + ((fade.to - fade.from) * progress));
      if (progress < 1) continue;
      fades.delete(media);
      // A track faded to nothing is a track nobody can hear again: the only
      // reason to fade rather than cut was the ear, and holding the element
      // afterwards would leave a muted `<audio>` decoding for the rest of the
      // story.
      if (fade.to === 0 && media !== music?.media) release(media);
    }
    // `ended` is the ordinary way a line finishes and it is handled where it
    // fires; this is the other way — a file shorter than the schedule thought,
    // or one that never reports at all. Either way the music must come back up.
    if (narration && tMs >= narration.endsAtMs) stopNarration(tMs);
  }

  /**
   * Everything sounding stops, and is remembered until it is resumed.
   *
   * The set is added to rather than rebuilt, because pausing an already paused
   * story is ordinary: every seek of one pauses again (`timeline-player.mjs`
   * freezes what the scrub moved into place), and a replay pauses at the end
   * and again at zero. A rebuild found each medium already paused, skipped it,
   * and handed `resume` an empty set — so a viewer who paused, dragged the bar
   * and pressed play lost the scene's music for the rest of the story, with
   * `setMusic` returning early on the name it was still holding.
   */
  function pause() {
    if (destroyed) return;
    for (const media of owned.keys()) {
      if (media.paused) continue;
      held.add(media);
      media.pause();
    }
  }

  function resume() {
    if (destroyed) return;
    for (const media of held) {
      if (!owned.has(media)) continue;
      // A device that took the audio session away while the story was paused —
      // a call, another app — refuses here, and the story would otherwise come
      // back from the pause silent with nothing in the log.
      play(media, 'playback would not resume');
    }
    held = new Set();
  }

  /**
   * Spend the viewer's gesture on the audio hardware.
   *
   * A refusal is reported and survived: a story with no sound is worse than a
   * story that starts, and every medium here still tries on its own.
   */
  function unlock() {
    if (destroyed) return Promise.resolve();
    try {
      const AudioContextClass = globalThis.window?.AudioContext
        ?? globalThis.window?.webkitAudioContext;
      if (!AudioContextClass) return Promise.resolve();
      context ??= new AudioContextClass();
      return Promise.resolve(context.resume?.()).catch((error) => {
        report({ asset: 'audio-context', message: error?.message ?? String(error) });
      });
    } catch (error) {
      report({ asset: 'audio-context', message: error?.message ?? String(error) });
      return Promise.resolve();
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    fades.clear();
    for (const media of [...owned.keys()]) release(media);
    narration = null;
    music = null;
    held = new Set();
    named.clear();
    try {
      void Promise.resolve(context?.close?.()).catch(() => {});
    } catch { /* teardown stays best-effort once every medium is released */ }
    context = null;
  }

  function startNarration(cue, offsetMs, tMs) {
    stopNarration(tMs);
    const media = open(cue, 'narration');
    if (!media) return;
    const offset = Math.max(0, Math.round(offsetMs));
    if (offset > LATE_START_MS) media.currentTime = offset / 1000;
    narration = { media, cue, endsAtMs: cue.tMs + cue.durationMs };
    media.addEventListener('ended', () => {
      if (narration?.media === media) stopNarration();
    }, { once: true });
    media.addEventListener('error', () => {
      warn(media, 'narration playback failed');
      if (narration?.media === media) stopNarration();
    }, { once: true });
    // A line whose file gives up mid-download is truncated rather than waited
    // for — the schedule is fixed — but it is still a failure somebody should
    // be able to read about afterwards.
    media.addEventListener('stalled', () => warn(media, 'narration stalled mid-line'), { once: true });
    duck(true, tMs);
    play(media, 'narration would not start');
  }

  function stopNarration(tMs = null) {
    if (!narration) return;
    const { media } = narration;
    narration = null;
    release(media);
    duck(false, tMs);
  }

  function startSound(cue) {
    if (cue.missing) {
      report(detailFor(cue, 'sfx', 'sound is absent from bundle'));
      return;
    }
    const media = open(cue, 'sfx');
    if (!media) return;
    sounds.add(media);
    media.addEventListener('ended', () => release(media), { once: true });
    media.addEventListener('error', () => {
      warn(media, 'sound playback failed');
      release(media);
    }, { once: true });
    // A medium that is fetching and getting nothing neither rejects `play()`
    // nor fires `error` — it fires this, and until the deleted start-timeout
    // watchdog was replaced by it, a scene that lost its effects said nothing
    // anywhere.
    media.addEventListener('stalled', () => warn(media, 'sound stalled before it was heard'), { once: true });
    play(media, 'sound would not start');
  }

  /**
   * `music(off)` stops what is playing; any other name replaces it.
   *
   * A name the bundle does not carry is reported and otherwise ignored — the
   * live director did the same, and silencing a story because one track name
   * was misspelled is the louder mistake.
   */
  function setMusic(cue, tMs) {
    if (cue.name === 'off') {
      stopMusic(tMs);
      return;
    }
    if (cue.missing) {
      report(detailFor(cue, 'bgm', 'music is absent from bundle'));
      return;
    }
    if (music?.name === cue.name) return;
    const media = open(cue, 'bgm');
    if (!media) return;
    media.loop = true;
    media.volume = 0;
    fadeOutMusic(tMs);
    music = { media, name: cue.name };
    media.addEventListener('error', () => {
      warn(media, 'music playback failed');
      if (music?.media === media) {
        music = null;
        release(media);
      }
    }, { once: true });
    media.addEventListener('stalled', () => warn(media, 'music stalled before it was heard'), { once: true });
    fadeTo(media, narration ? DUCKED_MUSIC_VOLUME : MUSIC_VOLUME, MUSIC_FADE_MS, tMs);
    play(media, 'music would not start', () => {
      if (music?.media === media) music = null;
    });
  }

  function stopMusic(tMs) {
    fadeOutMusic(tMs);
    music = null;
  }

  /** Every fade jumps to its own end, and a track faded to nothing goes. */
  function settleFades() {
    for (const [media, fade] of [...fades]) {
      fades.delete(media);
      media.volume = clampVolume(fade.to);
      if (fade.to === 0 && media !== music?.media) release(media);
    }
  }

  function fadeOutMusic(tMs) {
    if (!music) return;
    // Dropped from the pause set as it goes: a track on its way out must not be
    // restarted by a `resume` that arrives before the fade has finished.
    held.delete(music.media);
    fadeTo(music.media, 0, MUSIC_FADE_MS, tMs);
  }

  function duck(active, tMs) {
    if (!music) return;
    fadeTo(music.media, active ? DUCKED_MUSIC_VOLUME : MUSIC_VOLUME, DUCK_FADE_MS, tMs);
  }

  /**
   * A fade is a line between two volumes in story time. Written the instant it
   * starts so a `tick` that never comes — a paused story, a destroyed player —
   * leaves the volume where the ear last heard it rather than mid-ramp.
   */
  function fadeTo(media, target, durationMs, tMs) {
    if (!Number.isFinite(tMs)) {
      media.volume = clampVolume(target);
      fades.delete(media);
      return;
    }
    fades.set(media, {
      from: clampVolume(media.volume ?? 1), to: target, startMs: tMs, durationMs,
    });
  }

  function open(cue, asset) {
    const url = cue.media;
    if (typeof url !== 'string' || !url) return null;
    const media = new globalThis.Audio(url);
    media.preload = 'auto';
    owned.set(media, { cue, asset });
    return media;
  }

  /**
   * Ask a medium to play, and say so when the device says no.
   *
   * `AbortError` is the one refusal that is not a failure: it is what a browser
   * rejects a pending `play()` with when THIS file paused the medium — every
   * pause, every seek, every teardown — and reporting it would name the player
   * for doing exactly what it was asked.
   */
  function play(media, message, onRefusal = () => {}) {
    const refused = (error) => {
      // A medium this file paused is a medium this file still owns. Releasing
      // it here stripped its `src` while `narration` still pointed at it: a
      // scrub of a paused story re-opened the line, paused it one statement
      // later, and the rejection that arrived from that pause killed the line
      // and left the music ducked for the length of a line nobody could hear.
      if (error?.name === 'AbortError') return;
      warn(media, message);
      onRefusal();
      release(media);
    };
    try {
      const attempt = media.play?.();
      if (attempt?.catch) attempt.catch(refused);
    } catch (error) {
      refused(error);
    }
  }

  function release(media) {
    if (!owned.delete(media)) return;
    fades.delete(media);
    sounds.delete(media);
    held.delete(media);
    media.pause?.();
    media.removeAttribute?.('src');
  }

  /** One line per medium, whatever else goes wrong with it afterwards. */
  function warn(media, message) {
    const source = owned.get(media);
    if (!source || named.has(media)) return;
    named.add(media);
    report(detailFor(source.cue, source.asset, message));
  }

  function detailFor(cue, asset, message) {
    return {
      asset,
      ...(cue.name ? { name: cue.name } : {}),
      ...(cue.media ? { url: cue.media } : {}),
      message,
      line: cue.line ?? null,
      scene_index: cue.sceneIndex ?? null,
    };
  }

  function report(detail) {
    if (destroyed) return;
    onWarning({ type: 'media', ...detail });
  }
}

function clampVolume(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
