import { compileTimeline } from '../core/timeline/compile.mjs';
import { createBitmapCache } from './assets/bitmap-cache.mjs';
import { createSceneLoader } from './assets/scene-loader.mjs';
import { AudioDirector } from './directors/audio-director.mjs';
import { StoryClock } from './clock.mjs';
import { DebugPanel, ObservableEventLog } from './debug-panel.mjs';
import { StageRenderer } from './stage/stage-renderer.mjs';
import { resolveStoryAssets } from './urls.mjs';
import { routeWarning } from './warning-router.mjs';

const SUBTITLES_KEY = 'storytime:subtitles';

// The live director that used to drive this file is gone: a story's schedule is
// now compiled once, up front, by `core/timeline/compile.mjs`. The runtime that
// plays that schedule — clock, media, canvas, controls — is the next piece of
// work, and until it lands the player mounts, loads its opening and says so
// rather than pretending to perform. Nothing publishes from here in the
// meantime: the CDN build is cut from `main`, and this never reaches it.
const NO_RUNTIME = 'this build has no playback runtime yet';

export function createV0Player({ root, elements, story, assetBase, signal, debug = false }) {
  const clock = new StoryClock({ signal });
  const panel = new DebugPanel(elements.debug, debug, { eventTarget: root });
  const log = new ObservableEventLog(clock, (entry, entries) => panel.addEntry(entry, entries));
  const cleanups = [wireSubtitleToggle(elements)];
  const warn = (detail) => routeWarning(detail, null, log);
  const bitmaps = createBitmapCache({
    onOverBudget: ({ heldBytes, budgetBytes }) => warn({
      type: 'media',
      asset: 'cache',
      message: `the scene on screen needs ${megabytes(heldBytes)} MB of decoded sheets against a ${megabytes(budgetBytes)} MB budget`,
    }),
  });
  let stage = null;
  let audio = null;
  let runtimeStory = null;
  let loader = null;
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
      stage?.destroy?.();
      audio?.destroy?.();
      bitmaps.destroy();
      panel.destroy();
    },
  };

  async function initialize() {
    try {
      runtimeStory = resolveStoryAssets(story, assetBase);
      // The schedule is compiled here because the asset gate is the first thing
      // that needs it: which sheets a scene draws is read off the timeline's
      // ops, not guessed from the steps. Phase 8's runtime takes this call over.
      const timeline = compileTimeline(runtimeStory);
      elements.title.textContent = runtimeStory.title ?? 'tonight’s story';
      stage = new StageRenderer(elements.stage, warn);
      audio = new AudioDirector(runtimeStory.audio, warn, { signal });
      loader = createSceneLoader({
        timeline, bundle: runtimeStory, cache: bitmaps, signal, onWarning: warn,
      });
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
    elements.start.disabled = true;
    // The whole first scene, kept in the cache while it is the scene on screen.
    // Each failure has already said which asset it was, so there is no summary
    // to add here: one broken sheet is one line in the log, not two.
    await loader.loadScene(0, stageViewport(), {
      keep: true,
      onProgress: (done, total) => {
        if (signal.aborted || destroyed) return;
        elements.status.textContent = total
          ? `loading the opening… ${done}/${total}`
          : 'ready when you are';
      },
    });
    throwIfAborted(signal);
    elements.status.textContent = 'ready when you are';
    elements.start.disabled = false;
    startHandler = () => startStory();
    elements.start.addEventListener('click', startHandler, { once: true });
  }

  function startStory() {
    if (destroyed || signal.aborted) return;
    elements.start.disabled = true;
    // The reason goes on the status line rather than into the log alone, and
    // the title keeps the story's own name: "paused" would read as a state this
    // build could come back from, and this one cannot.
    warn({ type: 'playback', message: NO_RUNTIME });
    elements.status.textContent = NO_RUNTIME;
    elements.status.classList.add('is-error');
  }

  /**
   * How much the picture is magnified between the sheet and the eye.
   *
   * Both numbers are asked for rather than derived here: the stage renderer is
   * the one thing that measures stage DOM, and a second definition of the
   * letterbox scale would drift from the one the picture is actually drawn at.
   */
  function stageViewport() {
    return { fitScale: stage.fitScale(), dpr: globalThis.devicePixelRatio ?? 1 };
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

function megabytes(bytes) {
  return Math.round(bytes / (1024 * 1024));
}
