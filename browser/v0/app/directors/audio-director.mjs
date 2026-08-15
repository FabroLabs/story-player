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
  #owned = new Set();
  #fades = new Set();
  #starts = new Set();
  #destroyed = false;
  #signal;

  constructor(library = {}, onWarning = () => {}, { signal = null } = {}) {
    this.#library = library;
    this.#onWarning = onWarning;
    this.#signal = signal;
  }

  unlock() {
    if (this.#destroyed) return Promise.resolve();
    try {
      const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioContextClass) return Promise.resolve();
      this.#audioContext ??= new AudioContextClass();
      return Promise.resolve(this.#audioContext.resume()).catch((error) => {
        this.#warn('audio-context', null, error);
      });
    } catch (error) {
      this.#warn('audio-context', null, error);
      return Promise.resolve();
    }
  }

  playSound(name, origin = null) {
    if (this.#destroyed) return;
    const url = this.#library.sfx?.[name];
    if (!url) {
      this.#warn('sfx', name, new Error('sound is absent from bundle'), origin);
      return;
    }
    const sound = this.#own(new Audio(url));
    sound.preload = 'auto';
    const report = reportOnce((error) => this.#warn('sfx', name, error, origin));
    let start;
    sound.addEventListener('error', () => {
      report(new Error('sound playback failed'));
      start?.cancel('error');
    }, { once: true });
    sound.addEventListener('ended', () => this.#release(sound), { once: true });
    start = this.#beginStart(sound, MEDIA_START_TIMEOUT_MS, {
      onTimeout: () => report(new Error('sound playback start timed out')),
      onError: report,
    });
    void start.promise.then(({ started }) => {
      if (!started) this.#release(sound);
    });
  }

  setMusic(name, origin = null) {
    if (this.#destroyed) return;
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
    if (this.#destroyed) return { ok: false, elapsedMs: 0 };
    const narration = this.#own(new Audio(url));
    narration.preload = 'auto';
    const startedAt = performance.now();
    const completion = mediaCompletion(narration);
    this.#setNarrating(true);

    try {
      const playback = Promise.resolve(narration.play()).then(() => completion);
      const result = await withTimeout(playback, estimatedDurationMs + NARRATION_GRACE_MS, {
        onTimeout: () => this.#warn('narration', url, new Error('narration playback timed out'), origin),
        signal: this.#signal,
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
      this.#release(narration);
    }
  }

  async #replaceMusic(name, url, generation, origin) {
    if (this.#destroyed) return;
    const next = this.#own(new Audio(url));
    next.loop = true;
    next.preload = 'auto';
    next.volume = 0;
    const report = reportOnce((error) => this.#warn('bgm', name, error, origin));
    let start;
    next.addEventListener('error', () => {
      report(new Error('music playback failed'));
      start?.cancel('error');
    }, { once: true });
    start = this.#beginStart(next, MEDIA_START_TIMEOUT_MS, {
      onTimeout: () => report(new Error('music playback start timed out')),
      onError: report,
    });
    this.#pendingMusicStart = start;
    const result = await start.promise;
    if (this.#pendingMusicStart === start) this.#pendingMusicStart = null;
    if (!result.started) {
      this.#release(next);
      return;
    }

    if (this.#destroyed || generation !== this.#musicGeneration) {
      this.#release(next);
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
    this.#release(audio);
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
      const fade = { frame: null, resolve };
      this.#fades.add(fade);
      const finish = () => {
        if (!this.#fades.delete(fade)) return;
        resolve();
      };
      const update = (now) => {
        if (this.#destroyed || (stopWhenStale && generation !== this.#musicGeneration)) {
          finish();
          return;
        }
        const progress = reducedMotion ? 1 : Math.min(1, (now - startedAt) / durationMs);
        audio.volume = clampVolume(start + ((target - start) * progress));
        if (progress < 1) fade.frame = requestAnimationFrame(update);
        else finish();
      };
      fade.frame = requestAnimationFrame(update);
    });
  }

  #warn(asset, name, error, origin = null) {
    if (this.#destroyed) return;
    const context = normalizeOrigin(origin);
    this.#onWarning({
      type: 'media',
      asset,
      ...(name ? { name } : {}),
      message: error?.message ?? String(error),
      ...context,
    });
  }

  #own(media) {
    this.#owned.add(media);
    return media;
  }

  #release(media) {
    if (!this.#owned.delete(media)) return;
    media.pause();
    media.removeAttribute?.('src');
  }

  #beginStart(media, timeoutMs, options) {
    const start = startMedia(media, timeoutMs, options);
    this.#starts.add(start);
    void start.promise.finally(() => this.#starts.delete(start));
    return start;
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#musicGeneration += 1;
    this.#pendingMusicStart?.cancel('destroyed');
    this.#pendingMusicStart = null;
    for (const start of this.#starts) start.cancel('destroyed');
    this.#starts.clear();
    for (const fade of this.#fades) {
      if (fade.frame !== null) cancelAnimationFrame(fade.frame);
      fade.resolve();
    }
    this.#fades.clear();
    for (const media of [...this.#owned]) this.#release(media);
    this.#music = null;
    try {
      void Promise.resolve(this.#audioContext?.close?.()).catch(() => {});
    } catch { /* teardown remains best-effort after every owned medium stopped */ }
    this.#audioContext = null;
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
