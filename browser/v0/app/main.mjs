import { compileTimeline } from '../core/timeline/compile.mjs';
import { createBitmapCache } from './assets/bitmap-cache.mjs';
import { createSceneLoader } from './assets/scene-loader.mjs';
import { probeCapability } from './capability.mjs';
import { StoryClock } from './clock.mjs';
import { DebugPanel, ObservableEventLog } from './debug-panel.mjs';
import { createTimelinePlayer } from './timeline-player.mjs';
import { appendStoryScene, requirePlatesBlock, resolveStoryAssets } from './urls.mjs';
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
 *
 * A story that is still being written arrives the same way, one scene at a
 * time: `stream` says the host is watching a writer, `plates` is the manifest's
 * answer to a question the published scenes cannot answer yet, and
 * `appendScene` is how the rest of the story gets here. The player still
 * fetches no Story JSON of its own — the host does, as it always has.
 */
export function createV0Player({
  root, elements, story, assetBase, plates = null, stream = null,
  signal, debug = false, perf = false,
}) {
  // The host's own two arguments, settled before anything is built from them:
  // both are refused here or never again, since the compiler cannot report a
  // bad hint and a bad `stream` would only show up as a badge counting wrong.
  const streaming = requireStream(stream);
  const platesHint = requirePlatesBlock(plates);
  // Optional for a whole story — it can only answer for a place no scene stands
  // in — but not for a growing one: without it a healed step into a place the
  // published scenes have not opened yet is staged one way now and another way
  // once the scene that owns it lands, and the frames already shown are never
  // taken back. A host with no block has no business streaming.
  if (streaming && !platesHint) {
    throw new Error('a story that is still being written must be mounted with its manifest plates block');
  }
  // One compile for the mount and for every append, so the hint cannot be
  // handed to the first and forgotten by the second — the two would then stage
  // the same place differently within one performance.
  const compile = (grown) => compileTimeline(grown, { plates: platesHint });
  const clock = new StoryClock();
  const panel = new DebugPanel(elements.debug, debug, { eventTarget: root });
  const log = new ObservableEventLog(clock, (entry, entries) => panel.addEntry(entry, entries));
  const cleanups = [wireSubtitleToggle(elements)];
  const warn = (detail) => routeWarning(detail, null, log);
  // Read once, before anything is decoded or drawn: the cache is sized from it,
  // the canvas is backed from it, and the loop is paced by it.
  const capability = probeCapability(globalThis);
  const bitmaps = createBitmapCache({
    budgetBytes: capability.bitmapBudget,
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
  let runtimeStory = null;
  let timeline = null;
  let destroyed = false;
  let finished = false;
  let startHandler = null;
  // Said once per distinct refusal for the whole mount, not once per compile: a
  // growing story is recompiled on every append, and a viewer's log would
  // otherwise hold one copy of the same sentence per scene that ever landed.
  const saidRefusals = new Set();
  const ready = initialize();

  return {
    ready,
    appendScene,
    finishStory,
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
      runtimeStory = resolveStoryAssets(story, assetBase);
      // Compiled here because everything downstream needs it: the asset gate
      // reads which sheets a scene draws off the timeline's ops, the runtime
      // plays it, and the debug download carries it so a recorded session can
      // be replayed against the engine's own copy. Compiled AGAIN on every
      // append, whole rather than patched — that is what keeps a growing
      // timeline the finished one's own opening.
      timeline = compile(runtimeStory);
      panel.attachTimeline(timeline);
      logCompileRefusals(timeline);
      // Only when somebody asked to measure: a log that carries a perf section
      // has to say which machine produced it, and a log that does not should
      // not carry an entry nobody will read.
      if (perf) {
        log.append({
          kind: 'capability',
          tier: capability.tier,
          reasons: capability.reasons,
          device_memory: capability.deviceMemory,
          cores: capability.cores,
          dpr: capability.dpr,
          draw_hz: capability.drawHz,
          dpr_cap: capability.dprCap,
          shadows: capability.shadows,
          reduced_motion: capability.reducedMotion,
        });
      }
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
        capability,
        log,
        perf,
        onWarning: warn,
        signal,
        publishedComplete: streaming === null,
        expectedScenes: streaming?.scenes ?? null,
      });
      if (perf) panel.beforeSerialize(() => runtime.flushPerf('download'));
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

  /**
   * One more scene, fetched by the host and handed over parsed.
   *
   * Refused rather than half-applied: the grown story is resolved and compiled
   * into locals first, and only a compile that came back replaces what is
   * playing. So a scene naming a character the manifest never carried throws to
   * the host with the published prefix still on screen, which is the only
   * outcome a child watching would forgive.
   */
  async function appendScene(scene) {
    requireStreamingMount();
    // Refused rather than accepted quietly: the viewer has been shown the end,
    // and a scene that arrives after it can only be reached by scrubbing back
    // to a story the player already said was over.
    if (finished) throw new Error('this story was already finished; nothing more can be appended');
    await ready;
    // A destroyed player has no story to grow, and the host racing its own
    // teardown is not an error worth reporting to it.
    if (destroyed || signal.aborted) return;
    let grown;
    let compiled;
    // Named on the way past, the way the mount names what it could not open.
    // The host is told by the throw, but the log is what a session is read back
    // from later, and a story that lost a scene here would otherwise be
    // indistinguishable in the download from a story that was only ever short.
    try {
      grown = appendStoryScene(runtimeStory, scene, assetBase);
      compiled = compile(grown);
    } catch (error) {
      try {
        log.warning(
          { type: 'stream', message: `an appended scene was refused: ${error.message}` },
          null,
          runtimeStory.scenes?.length ?? null,
        );
      } catch { /* preserve the refusal */ }
      throw error;
    }
    runtimeStory = grown;
    timeline = compiled;
    panel.attachTimeline(timeline);
    logCompileRefusals(timeline);
    await runtime.appendScene({ bundle: runtimeStory, timeline });
  }

  /** The writer stopped: what has been published is the whole story now. */
  async function finishStory(status = 'done') {
    requireStreamingMount();
    if (status !== 'done' && status !== 'failed') {
      throw new TypeError(`finishStory takes 'done' or 'failed', got ${JSON.stringify(status)}`);
    }
    finished = true;
    await ready;
    if (destroyed || signal.aborted) return;
    // The screen treats the two alike, deliberately: the published prefix is the
    // story, and the words about a missing ending are the host's to write beside
    // the player. The RECORD must not — a session whose writer died at scene two
    // and one that reached its ending are otherwise the same download.
    if (status === 'failed') {
      try {
        log.warning({ type: 'stream', message: 'the writer stopped before the story was finished' });
      } catch { /* the story still ends */ }
    }
    runtime.finishStory();
  }

  function requireStreamingMount() {
    if (streaming) return;
    throw new Error('this player was not mounted for a story that is still being written');
  }

  function startStory() {
    if (destroyed || signal.aborted) return;
    elements.start.disabled = true;
    elements.ceremony.classList.add('is-gone');
    runtime.begin();
  }

  /**
   * What the compiler refused, said out loud once, before the story starts.
   *
   * The compiler records every refusal into the schedule — a clip the bundle
   * never carried, a character nobody could place, a camera target it could not
   * resolve — so that a step which was not performed is never merely absent.
   * Nothing at runtime reads those events back: `stateAt` hands `source: step`
   * entries to the band layout and returns, and the cue reader only knows
   * narration, sound and music. Between the live director and here, they went
   * from the panel's warning list to nowhere.
   *
   * They are logged at mount rather than as the story crosses them because they
   * are facts about the STORY, not about this performance: the same bundle
   * compiles to the same refusals on every device, before a single frame is
   * drawn, and their own `t_ms` keeps them in the order they will be reached.
   *
   * Said once per distinct refusal, at the first instant it was raised — the
   * same rule the runtime, the scene loader and the media scheduler already
   * follow. A missing clip is refused at every idle the character has, and a
   * panel holding forty copies of one sentence is a panel nobody reads. The
   * attached timeline still carries every occurrence for a download to count.
   */
  function logCompileRefusals(compiled) {
    for (const event of compiled?.events ?? []) {
      if (event.kind !== 'warning') continue;
      const key = JSON.stringify(event.detail);
      if (saidRefusals.has(key)) continue;
      saidRefusals.add(key);
      log.append({
        t_ms: event.t_ms,
        scene_index: event.scene_index ?? null,
        line: event.line ?? null,
        kind: 'warning',
        detail: event.detail,
      });
    }
  }
}

/**
 * `stream` says the story is still being written, and how long it will be.
 *
 * Its absence is the ordinary case and the one every host had before this
 * existed: a whole story, mounted once. `scenes` is the manifest's count, which
 * the badge needs from the first frame — a story cannot say "scene 1 of 6"
 * while only one scene exists unless somebody tells it about the other five.
 */
function requireStream(stream) {
  if (stream == null) return null;
  if (typeof stream !== 'object' || Array.isArray(stream)) {
    throw new Error('stream must be an object');
  }
  const unknown = Object.keys(stream).filter((key) => key !== 'scenes');
  // A misspelled key is indistinguishable from a deliberate omission — both
  // leave the badge counting up from one — so it is named instead of ignored.
  if (unknown.length > 0) {
    throw new Error(`stream carries ${unknown.map((key) => JSON.stringify(key)).join(', ')}, which it does not take`);
  }
  const scenes = stream.scenes ?? null;
  if (scenes !== null && !(Number.isInteger(scenes) && scenes > 0)) {
    throw new Error(`stream.scenes must be a whole number of scenes, got ${JSON.stringify(scenes)}`);
  }
  return { scenes };
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
