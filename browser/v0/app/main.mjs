import { firstPaintAssets, preload, queueRemainingScenes } from './asset-preloader.mjs';
import { AudioDirector } from './directors/audio-director.mjs';
import { StoryClock } from './clock.mjs';
import { DebugPanel, ObservableEventLog } from './debug-panel.mjs';
import { PlaybackDirector } from './directors/playback-director.mjs';
import { StageRenderer } from './stage/stage-renderer.mjs';
import { resolveStoryAssets } from './urls.mjs';
import { routeWarning } from './warning-router.mjs';

const SUBTITLES_KEY = 'storytime:subtitles';

export function createV0Player({ root, elements, story, assetBase, signal, debug = false }) {
  const clock = new StoryClock({ signal });
  const panel = new DebugPanel(elements.debug, debug, { eventTarget: root });
  const log = new ObservableEventLog(clock, (entry, entries) => panel.addEntry(entry, entries));
  const cleanups = [wireSubtitleToggle(elements)];
  let stage = null;
  let audio = null;
  let director = null;
  let runtimeStory = null;
  let destroyed = false;
  let startHandler = null;
  const ready = initialize();

  return {
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (startHandler) elements.start.removeEventListener('click', startHandler);
      for (const cleanup of cleanups) cleanup();
      director?.destroy?.();
      stage?.destroy?.();
      audio?.destroy?.();
      panel.destroy();
    },
  };

  async function initialize() {
    try {
      runtimeStory = resolveStoryAssets(story, assetBase);
      elements.title.textContent = runtimeStory.title ?? 'tonight’s story';
      let routedDirector = null;
      const warn = (detail) => routeWarning(detail, routedDirector, log);
      stage = new StageRenderer(elements.stage, warn);
      audio = new AudioDirector(runtimeStory.audio, warn, { signal });
      director = new PlaybackDirector({ story: runtimeStory, stage, audio, clock, log, signal });
      routedDirector = director;
      await armStart();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        try {
          log.warning({ type: 'bundle', message: error.message });
        } catch { /* preserve the initialization error */ }
      }
      throw error;
    }
  }

  async function armStart() {
    const urls = firstPaintAssets(runtimeStory, runtimeStory.scenes?.[0]);
    elements.start.disabled = true;
    const result = await preload(urls, {
      signal,
      onProgress: (done, total) => {
        if (signal.aborted || destroyed) return;
        elements.status.textContent = total
          ? `loading the opening… ${done}/${total}`
          : 'ready when you are';
      },
    });
    throwIfAborted(signal);
    if (result.failed > 0) {
      director.warning({
        type: 'media',
        asset: 'preload',
        message: `${result.failed} opening preload failed; playback may use placeholders`,
      });
    }
    elements.status.textContent = 'ready when you are';
    elements.start.disabled = false;
    startHandler = () => { void startStory(); };
    elements.start.addEventListener('click', startHandler, { once: true });
  }

  async function startStory() {
    if (destroyed || signal.aborted) return;
    elements.start.disabled = true;
    elements.status.textContent = 'opening the story…';
    void audio.unlock();
    clock.start();
    stage.startAnimation();
    elements.ceremony.classList.add('is-gone');
    void queueRemainingScenes(runtimeStory, {
      signal,
      onScene: (index, count) => {
        if (destroyed || signal.aborted) return;
        log.append({
          scene_index: index, line: null, kind: 'note',
          detail: { type: 'media', asset: 'preload', scene: index, assets: count },
        });
      },
    }).catch((error) => {
      if (error?.name !== 'AbortError') director.warning({ type: 'media', asset: 'preload', message: error.message });
    });
    try {
      await director.play();
    } catch (error) {
      if (destroyed || error?.name === 'AbortError') return;
      director.warning({ type: 'playback', message: error.message });
      elements.ceremony.classList.remove('is-gone');
      elements.title.textContent = 'the story paused';
      elements.status.textContent = 'open the event log for details';
      elements.status.classList.add('is-error');
    }
  }
}

function wireSubtitleToggle(elements) {
  const { subtitles: button, subtitleArea: area } = elements;
  apply(readPreference(SUBTITLES_KEY) !== 'off');
  const onClick = () => {
    const next = button.getAttribute('aria-pressed') !== 'true';
    apply(next);
    writePreference(SUBTITLES_KEY, next ? 'on' : 'off');
  };
  button.addEventListener('click', onClick);
  return () => button.removeEventListener('click', onClick);

  function apply(on) {
    area.hidden = !on;
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'hide subtitles' : 'show subtitles');
  }
}

function readPreference(key) {
  try {
    return globalThis.window?.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writePreference(key, value) {
  try {
    globalThis.window?.localStorage?.setItem(key, value);
  } catch { /* a preference may remain session-only */ }
}

function throwIfAborted(signal) {
  if (signal.aborted) throw new DOMException('player destroyed', 'AbortError');
}
