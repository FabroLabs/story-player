import { withTimeout } from '../clock.mjs';
import { startMedia } from './media-start.mjs';
import {
  DUCKED_MUSIC_VOLUME,
  DUCK_FADE_MS,
  MUSIC_FADE_MS,
  MUSIC_VOLUME,
  NARRATION_GRACE_MS,
} from '../../policy.mjs';

const MEDIA_START_TIMEOUT_MS = 3_000;

export class AudioDirector {
  #library;
  #onWarning;
  #music = null;
  #pendingMusicStart = null;
  #musicGeneration = 0;
  #narrating = false;
  #audioContext = null;

  constructor(library = {}, onWarning = () => {}) {
    this.#library = library;
    this.#onWarning = onWarning;
  }

  unlock() {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextClass) return Promise.resolve();
    this.#audioContext ??= new AudioContextClass();
    return this.#audioContext.resume().catch((error) => {
      this.#warn('audio-context', null, error);
    });
  }

  playSound(name, origin = null) {
    const url = this.#library.sfx?.[name];
    if (!url) {
      this.#warn('sfx', name, new Error('sound is absent from bundle'), origin);
      return;
    }
    const sound = new Audio(url);
    sound.preload = 'auto';
    const report = reportOnce((error) => this.#warn('sfx', name, error, origin));
    let start;
    sound.addEventListener('error', () => {
      report(new Error('sound playback failed'));
      start?.cancel('error');
    }, { once: true });
    start = startMedia(sound, MEDIA_START_TIMEOUT_MS, {
      onTimeout: () => report(new Error('sound playback start timed out')),
      onError: report,
    });
    void start.promise;
  }

  setMusic(name, origin = null) {
    const generation = ++this.#musicGeneration;
    this.#pendingMusicStart?.cancel('superseded');
    this.#pendingMusicStart = null;
    if (name === 'off') {
      const previous = this.#music;
      this.#music = null;
      if (previous) void this.#fadeOut(previous, generation);
      return;
    }

    const url = this.#library.bgm?.[name];
    if (!url) {
      this.#warn('bgm', name, new Error('music is absent from bundle'), origin);
      return;
    }
    void this.#replaceMusic(name, url, generation, origin);
  }

  async playNarration(url, estimatedDurationMs, origin = null) {
    const narration = new Audio(url);
    narration.preload = 'auto';
    const startedAt = performance.now();
    const completion = mediaCompletion(narration);
    this.#setNarrating(true);

    try {
      const playback = Promise.resolve(narration.play()).then(() => completion);
      const result = await withTimeout(playback, estimatedDurationMs + NARRATION_GRACE_MS, {
        onTimeout: () => this.#warn('narration', url, new Error('narration playback timed out'), origin),
      });
      if (result.timedOut) {
        narration.pause();
        return { ok: false, elapsedMs: performance.now() - startedAt };
      }
      if (!result.value.ok) {
        this.#warn('narration', url, result.value.error, origin);
        narration.pause();
        return { ok: false, elapsedMs: performance.now() - startedAt };
      }
      return { ok: true, elapsedMs: performance.now() - startedAt };
    } catch (error) {
      narration.pause();
      this.#warn('narration', url, error, origin);
      return { ok: false, elapsedMs: performance.now() - startedAt };
    } finally {
      this.#setNarrating(false);
    }
  }

  async #replaceMusic(name, url, generation, origin) {
    const next = new Audio(url);
    next.loop = true;
    next.preload = 'auto';
    next.volume = 0;
    const report = reportOnce((error) => this.#warn('bgm', name, error, origin));
    let start;
    next.addEventListener('error', () => {
      report(new Error('music playback failed'));
      start?.cancel('error');
    }, { once: true });
    start = startMedia(next, MEDIA_START_TIMEOUT_MS, {
      onTimeout: () => report(new Error('music playback start timed out')),
      onError: report,
    });
    this.#pendingMusicStart = start;
    const result = await start.promise;
    if (this.#pendingMusicStart === start) this.#pendingMusicStart = null;
    if (!result.started) return;

    if (generation !== this.#musicGeneration) {
      next.pause();
      next.removeAttribute('src');
      return;
    }
    const previous = this.#music;
    this.#music = next;
    const target = this.#narrating ? DUCKED_MUSIC_VOLUME : MUSIC_VOLUME;
    this.#fadeVolume(next, target, MUSIC_FADE_MS, generation);
    if (previous) void this.#fadeOut(previous, generation);
  }

  async #fadeOut(audio, generation) {
    await this.#fadeVolume(audio, 0, MUSIC_FADE_MS, generation, false);
    audio.pause();
    audio.removeAttribute('src');
  }

  #setNarrating(active) {
    this.#narrating = active;
    if (!this.#music) return;
    const target = active ? DUCKED_MUSIC_VOLUME : MUSIC_VOLUME;
    this.#fadeVolume(this.#music, target, DUCK_FADE_MS, this.#musicGeneration);
  }

  #fadeVolume(audio, target, durationMs, generation, stopWhenStale = true) {
    const start = audio.volume;
    const startedAt = performance.now();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return new Promise((resolve) => {
      const update = (now) => {
        if (stopWhenStale && generation !== this.#musicGeneration) {
          resolve();
          return;
        }
        const progress = reducedMotion ? 1 : Math.min(1, (now - startedAt) / durationMs);
        audio.volume = clampVolume(start + ((target - start) * progress));
        if (progress < 1) requestAnimationFrame(update);
        else resolve();
      };
      requestAnimationFrame(update);
    });
  }

  #warn(asset, name, error, origin = null) {
    const context = normalizeOrigin(origin);
    this.#onWarning({
      type: 'media',
      asset,
      ...(name ? { name } : {}),
      message: error?.message ?? String(error),
      ...context,
    });
  }
}

function normalizeOrigin(origin) {
  if (typeof origin === 'number') return { line: origin };
  if (origin && typeof origin === 'object') return origin;
  return { line: null };
}

function mediaCompletion(media) {
  return new Promise((resolve) => {
    media.addEventListener('ended', () => resolve({ ok: true }), { once: true });
    for (const eventName of ['error', 'stalled', 'abort']) {
      media.addEventListener(
        eventName,
        () => resolve({ ok: false, error: new Error(`narration ${eventName}`) }),
        { once: true },
      );
    }
  });
}

function clampVolume(value) {
  return Math.max(0, Math.min(1, value));
}

function reportOnce(report) {
  let reported = false;
  return (error) => {
    if (reported) return;
    reported = true;
    report(error);
  };
}
