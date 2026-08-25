import { compileTimeline } from '../core/timeline/compile.mjs';
import { createBitmapCache } from './assets/bitmap-cache.mjs';
import { createSceneLoader } from './assets/scene-loader.mjs';
import { probeCapability } from './capability.mjs';
import { createCardPhase } from './card-phase.mjs';
import { StoryClock } from './clock.mjs';
import { DebugPanel, ObservableEventLog } from './debug-panel.mjs';
import { createTimelinePlayer } from './timeline-player.mjs';
import {
  appendStoryScene, requireCardsBlock, requirePlatesBlock, resolveStoryAssets,
} from './urls.mjs';
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
 *
 * `cards` are the two performances either side of the story — the world's intro
 * film and its end card, with the music the story's writer chose. They are
 * sequenced here rather than compiled into the timeline (see `card-phase.mjs`),
 * which is what keeps `t` the story's own: the intro plays between the begin
 * click and `runtime.begin()`, the end card between the story stopping and its
 * end screen. A mount with no `cards` reaches none of it.
 */
export function createV0Player({
  root, elements, story, assetBase, plates = null, stream = null, cards = null,
  signal, debug = false, perf = false,
}) {
  // The host's own three arguments, settled before anything is built from them:
  // each is refused here or never again, since the compiler cannot report a bad
  // hint, a bad `stream` would only show up as a badge counting wrong, and a bad
  // card would be a black rectangle after the ceremony had already gone.
  const streaming = requireStream(stream);
  const platesHint = requirePlatesBlock(plates);
  const cardsBlock = requireCardsBlock(cards, assetBase);
  // Optional for a whole story — it can only answer for a place no scene stands
  // in — but not for a growing one: without it a healed step into a place the
  // published scenes have not opened yet is staged one way now and another way
  // once the scene that owns it lands, and the frames already shown are never
  // taken back. A host with no block has no business streaming.
  if (streaming && !platesHint) {
    throw new Error('a story that is still being written must be mounted with its manifest plates block');
  }
  // Mounted before there is a scene to play. Only for a story being written and
  // only behind an intro card: the card is the fourteen seconds the first scene
  // is published in, and without one the viewer would be shown a spinner for
  // them. Nothing is resolved or compiled until that first scene lands — the
  // compiler refuses an empty story, and rightly: an empty schedule is not the
  // opening of anything.
  const deferred = Boolean(streaming) && Boolean(cardsBlock?.intro)
    && Array.isArray(story?.scenes) && story.scenes.length === 0;
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
  const card = cardsBlock
    ? createCardPhase({ elements: elements.card, cards: cardsBlock, onWarning: warn })
    : null;
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
  // Whoever is behind the curtain waiting for a story that does not exist yet.
  // Settled by the first appended scene once it is DECODED, by the writer
  // stopping without one, or by teardown — never by a clock: liveness is the
  // host's here as everywhere. `opened` is the same answer asked synchronously,
  // because a scene that landed while the card was still playing must not be
  // begun before its own gate has finished.
  let openTheStory = null;
  let opened = false;
  const opening = deferred ? new Promise((resolve) => { openTheStory = resolve; }) : null;
  const openStory = () => {
    opened = true;
    openTheStory?.();
  };
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
      card?.destroy();
      runtime?.destroy();
      bitmaps.destroy();
      panel.destroy();
      // A begin that is still inside its card, or behind a curtain waiting for
      // a story nobody will publish now: both are let go, and both check
      // `destroyed` on the way out.
      openStory();
    },
  };

  async function initialize() {
    try {
      if (deferred) {
        // The manifest's own title, since there is no resolved bundle to read
        // it off yet. Everything else the ceremony shows is the card's.
        elements.title.textContent = story.title ?? 'tonight’s story';
        elements.badge.name.textContent = story.title ?? '';
      } else {
        buildRuntime(resolveStoryAssets(story, assetBase));
      }
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

  /**
   * Everything that is downstream of having a story: the schedule, the asset
   * gate and the runtime that plays them.
   *
   * Called at the mount for a story that has scenes, and at the first appended
   * one for a story mounted before it had any. Both paths compile the SAME way —
   * whole, with the manifest's plates — so a story that grew from nothing is the
   * same performance as one that arrived complete.
   */
  function buildRuntime(resolved) {
    runtimeStory = resolved;
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
      onEnd: () => (card?.hasEnd ? playCard(() => card.playEnd()) : null),
      onEndLeft: () => card?.cancel(),
      onReplay: () => {
        if (!card?.hasIntro) return false;
        void replay();
        return true;
      },
      onSceneOpen: (index, count, complete) => {
        if (card?.hasEnd && complete && index === count - 1) card.warmEnd();
      },
    });
    if (perf) panel.beforeSerialize(() => runtime.flushPerf('download'));
  }

  async function armStart() {
    elements.start.disabled = true;
    // Before the scene behind it: the card is what the click plays, and a story
    // whose opening film starts a second late has spent that second on the one
    // frame nobody is looking at.
    card?.warmIntro();
    // The whole first scene, kept in the cache while it is the scene on screen.
    // Each failure has already said which asset it was, so there is no summary
    // to add here: one broken sheet is one line in the log, not two.
    //
    // A story mounted before it had a scene has none of this to do: what arms
    // the button there is the card, and the first appended scene is gated
    // behind the curtain instead.
    if (runtime) {
      await runtime.prepare((done, total) => {
        if (signal.aborted || destroyed) return;
        elements.status.textContent = total
          ? `loading the opening… ${done}/${total}`
          : 'ready when you are';
      });
      throwIfAborted(signal);
    }
    elements.status.textContent = 'ready when you are';
    elements.start.disabled = false;
    startHandler = () => { void startStory(); };
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
    if (!runtime) {
      await openWith(scene);
      return;
    }
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

  /**
   * The first scene of a story that was mounted before it had one.
   *
   * The envelope was whole at the mount — cast, objects, audio all come off the
   * manifest — so this is the ordinary resolve with one scene in it, and the
   * same refusals: a scene naming somebody the manifest never carried throws to
   * the host with the card still playing over an empty stage.
   *
   * Gated the way the mount gates its opening, and for the same reason: the
   * curtain is about to come down on this scene, and a cut onto one that has
   * not decoded is the one moment a viewer is certain to be watching. A gate
   * that THREW would strand whoever is behind that curtain, so a scene whose
   * assets will not come is opened anyway — with placeholders and a named
   * warning, which is what every other cut in this player does.
   *
   * A refused scene is a different thing: nothing was published, so there is
   * nothing to open, and the spinner stays up. Liveness is the host's here as
   * everywhere — it publishes another scene or says the writer stopped.
   */
  async function openWith(scene) {
    try {
      buildRuntime(resolveStoryAssets({ ...story, scenes: [scene] }, assetBase));
    } catch (error) {
      try {
        log.warning({ type: 'stream', message: `an appended scene was refused: ${error.message}` }, null, 0);
      } catch { /* preserve the refusal */ }
      throw error;
    }
    try {
      await runtime.prepare();
    } catch (error) {
      if (!destroyed && !signal.aborted && error?.name !== 'AbortError') {
        warn({
          type: 'media',
          asset: 'scene',
          message: `the opening scene could not be prepared: ${error?.message ?? String(error)}`,
          scene_index: 0,
        });
      }
    }
    if (destroyed || signal.aborted) return;
    openStory();
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
    // Nothing was ever published: there is no runtime to tell, and what has to
    // happen is that whoever is waiting behind the curtain stops waiting.
    if (!runtime) {
      openStory();
      return;
    }
    runtime.finishStory();
  }

  function requireStreamingMount() {
    if (streaming) return;
    throw new Error('this player was not mounted for a story that is still being written');
  }

  /**
   * The viewer pressed begin.
   *
   * Everything up to the first `await` is the click's own tick, and it has to
   * be: the ceremony withdraws on the gesture rather than a frame later, the
   * audio session is unlocked by the gesture or not at all, and the card's music
   * is the one sound that starts inside it. What follows is the intro card, and
   * the story is begun when the curtain falls on it.
   */
  async function startStory() {
    if (destroyed || signal.aborted) return;
    elements.start.disabled = true;
    elements.ceremony.classList.add('is-gone');
    if (!card?.hasIntro) {
      await enterStory();
      return;
    }
    // Only when a card is about to stand between the click and `begin()`: with
    // no card the two are the same tick, and unlocking twice would say twice
    // whatever a device that refuses has to say. A story mounted before it had
    // a scene has no runtime to ask yet — what spends its gesture there is the
    // card's own music, started in this same tick.
    runtime?.unlockMedia();
    await playCard(() => card.playIntro());
    if (destroyed || signal.aborted) return;
    await enterStory();
  }

  /**
   * A card, with the transport out of the way for as long as it is up.
   *
   * The bar is only ever COVERED by the card layer, and covered is not the same
   * as gone: its keys are live wherever the focus is, and space under a replayed
   * intro card would start the story behind it. It goes back to whatever it was
   * when the card is over, whether the card played out or was taken away.
   */
  async function playCard(perform) {
    runtime?.holdTransport();
    try {
      await perform();
    } finally {
      runtime?.releaseTransport();
    }
  }

  /**
   * The curtain is down: the story plays, or waits here until it exists.
   *
   * The gate is the OPENING, not the runtime: a scene that landed while the card
   * was still playing has a runtime the instant it is compiled, and beginning
   * there would cut onto a scene whose sheets are still decoding and a transport
   * that has not been armed.
   */
  async function enterStory() {
    if (opening && !opened) {
      elements.stage.waiting.hidden = false;
      await opening;
      if (destroyed || signal.aborted) return;
      elements.stage.waiting.hidden = true;
    }
    // The writer stopped before publishing a single scene. There is no story to
    // play, and standing in a spinner for one nobody is writing is the one thing
    // worse than saying so.
    if (!runtime) {
      elements.stage.end.hidden = false;
      return;
    }
    runtime.begin();
  }

  /** A replay is the whole performance again: the card, then the story. */
  async function replay() {
    await playCard(() => card.playIntro());
    if (destroyed || signal.aborted) return;
    runtime.play();
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
