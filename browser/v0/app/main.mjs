import { compileTimeline } from '../core/timeline/compile.mjs';
import { createBitmapCache } from './assets/bitmap-cache.mjs';
import { createSceneLoader } from './assets/scene-loader.mjs';
import { StoryClock } from './clock.mjs';
import { DebugPanel, ObservableEventLog } from './debug-panel.mjs';
import { createTimelinePlayer } from './timeline-player.mjs';
import { resolveStoryAssets } from './urls.mjs';
import { routeWarning } from './warning-router.mjs';

const SUBTITLES_KEY = 'storytime:subtitles';

/**
 * The player, from the outside: mount, gate, begin, play, release.
 *
 * What lives here is everything that is true before there is a performance —
 * the clock the log stamps its entries with, the decoded-bitmap cache, the
 * begin ceremony, the subtitle preference — and nothing that is about playing.
 * The performance itself is `timeline-player.mjs`: one compiled schedule, one
 * loop, one function of t.
 */
export function createV0Player({ root, elements, story, assetBase, signal, debug = false }) {
  const clock = new StoryClock();
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
  // The log button opens the panel, so a build that has no panel open to it has
  // no button either — a control that does nothing is worse than one absence.
  elements.debugToggle.hidden = !debug;
  let runtime = null;
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
      runtime?.destroy();
      bitmaps.destroy();
      panel.destroy();
    },
  };

  async function initialize() {
    try {
      const runtimeStory = resolveStoryAssets(story, assetBase);
      // Compiled once, here, because everything downstream needs it: the asset
      // gate reads which sheets a scene draws off the timeline's ops, the
      // runtime plays it, and the debug download carries it so a recorded
      // session can be replayed against the engine's own copy.
      const timeline = compileTimeline(runtimeStory);
      panel.attachTimeline(timeline);
      elements.title.textContent = runtimeStory.title ?? 'tonight’s story';
      elements.badge.name.textContent = runtimeStory.title ?? '';
      loader = createSceneLoader({
        timeline, bundle: runtimeStory, cache: bitmaps, signal, onWarning: warn,
      });
      runtime = createTimelinePlayer({
        elements,
        bundle: runtimeStory,
        timeline,
        clock,
        loader,
        cache: bitmaps,
        onWarning: warn,
        signal,
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
    await runtime.prepare((done, total) => {
      if (signal.aborted || destroyed) return;
      elements.status.textContent = total
        ? `loading the opening… ${done}/${total}`
        : 'ready when you are';
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
    elements.ceremony.classList.add('is-gone');
    runtime.begin();
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
