/**
 * The runtime: one clock, one loop, and a picture that is a function of t.
 *
 * Nothing here decides what the story does. `compileTimeline` decided that
 * before the first frame — and again, whole, for every scene a host appends
 * after it; the state cursor answers what the instant looks like (the same
 * answer `stateAt` gives, read forward instead of cold); this
 * file only moves t forward and hands the answer to the three planes that show
 * it — the canvas, the plate and the media scheduler — plus the control bar that
 * reports it. That is the whole reason pause, seek and idle are three lines each
 * instead of a rewrite: they are all just t.
 *
 * The loop draws at most twenty-four times a second, and only when the picture
 * really changed. A paused, hidden, ended or destroyed player runs no loop at
 * all — `requestAnimationFrame` is not scheduled, so a story left open in a
 * background tab costs nothing.
 */

import { createStateCursor } from '../core/state/cursor.mjs';
import { slateBuildMs } from '../core/slate.mjs';
import { oceanAnimationMs } from '../core/ocean-board.mjs';
import { farmAnimationMs, sceneHasFarmBoard } from '../core/farm-board.mjs';
import { journeyCamera } from '../core/farm-journey.mjs';
import { FLASH, HIGHLIGHT } from '../policy.mjs';
import { onAssetProgress } from './assets/asset-request.mjs';
import { KEEP_CADENCE_MS } from './assets/scene-loader.mjs';
import { createAudioStore } from './audio-store.mjs';
import { DEFAULT_DRAW_HZ, tierSettings } from './capability.mjs';
import { createControls } from './controls.mjs';
import { createMediaScheduler } from './media-scheduler.mjs';
import { createPerfRecorder } from './perf.mjs';
import { createCanvasStage, sceneSheets } from './stage/canvas-stage.mjs';
import { choreographyPhase } from './stage/lesson-guide-choreography.mjs';
import { createVideoPlate } from './stage/video-plate.mjs';

const SKIP_MS = 10_000;
// A performance that reaches sound or pictures that have not landed holds on
// its last frame until they do. The spinner shows only once a hold outlasts a
// blink; a hold during which nothing arrives for HOLD_TIMEOUT_MS stops the
// story with a note, and play asks again — a slow link still delivering is
// waited for. A scene whose sheets would not load is asked for again this often.
const HOLD_SPINNER_MS = 300;
const HOLD_TIMEOUT_MS = 20_000;
const RETRY_MS = 1_000;

// What a stepped take sounds: nothing. Its sound is mixed from the schedule.
const SILENT = Object.freeze({
  unlock: async () => {}, seek() {}, resume() {}, pause() {}, advance() {}, tick() {}, settle() {}, setStory() {}, destroy() {},
});

export function createTimelinePlayer({
  elements, bundle, timeline, clock, loader, cache, log = null,
  // The board's counter picture, when the host gave one (`counter-picture.mjs`).
  // It rides with every scene's sheets, because a board can be raised in any.
  counter = null, board = null,
  capability = tierSettings('high'), perf = false, onWarning = () => {}, signal = null,
  publishedComplete = true,
  // The seams the presentation phases either side of the story hang on. All
  // default to nothing, so a mount without cards runs the file it ran before
  // them: `onEnd` may hand back a promise to hold the end screen behind, and is
  // told whether the story was playing when it got there; `onEndLeft` takes
  // back whatever `onEnd` started; `onEndToggle` may claim play/pause while the
  // story is over (a wind-down's sound); `onReplay` may claim the way back to
  // the start; and `onSceneOpen` says which scene is on screen.
  onState = () => {},
  onEnd = () => null, onEndLeft = () => {}, onEndToggle = () => false, onReplay = () => false,
  onSceneOpen = () => {},
}) {
  // The story as it stands. A host watching a writer grows it under the runtime
  // — `appendScene` swaps both halves at once — so nothing below reads the two
  // arguments again after this line.
  let story = { bundle, timeline };
  // The picture, read forward. Every frame asks for a t a little past the last
  // one, so the fold is held open across them instead of replayed from zero on
  // each — see `cursor.mjs`. `appendScene` hands it the story that replaced this
  // one; nothing else here knows the difference.
  const cursor = createStateCursor(timeline, bundle);
  let durationMs = Math.max(0, Math.round(timeline?.duration_ms ?? 0));
  // Whether the end of what is published is the end of the STORY. Only the host
  // knows: a prefix compiles its own `end` op because a compiler handed three
  // scenes cannot know a fourth is coming.
  let complete = publishedComplete !== false;
  // 24 fps is the ceiling the phone client holds and the cadence the sprite
  // sheets were authored at; a weak machine is given half of it rather than a
  // number of its own, so the loop skips every other tick exactly.
  // Only the two numbers this file reads back. The shadow flag rode here too
  // and was read by nobody — the stage is told it directly, at construction and
  // again on every demotion — so a field that looked like the runtime's opinion
  // about shadows, and defaulted the opposite way to the value actually passed
  // one line below, is gone rather than kept in step.
  let tier = {
    dprCap: capability.dprCap,
    drawHz: capability.drawHz || DEFAULT_DRAW_HZ,
  };
  let frameIntervalMs = 1000 / tier.drawHz;
  const stage = createCanvasStage(elements.stage, {
    onWarning, dprCap: capability.dprCap, shadows: capability.shadows, board, reducedMotion: capability.reducedMotion === true,
    subtitles: () => !elements.subtitleArea?.hidden,
    capturePlate: () => !story.bundle?.performance && !board?.world ? plate.captureFrame() : null,
  });
  const plate = createVideoPlate(elements.stage, { onWarning });
  // A performance's narration, downloaded once and kept by the runtime rather
  // than by a scheduler: a recording swaps the scheduler for one whose sound it
  // can hear, and the lines must not be fetched again for it.
  const narration = bundle?.performance
    ? createAudioStore(bundle.audio.filter((cue) => cue.kind === 'narration'))
    : null;
  let media = createMediaScheduler({ timeline, bundle, onWarning: mediaWarned, store: narration });
  const controls = createControls(elements.controls, {
    onToggle: toggle, onSeek: seekTo, onSkip: skip,
  });
  // Opt-in, because measuring costs a `PerformanceObserver`, a quarter-second
  // timer and a per-frame push on machines that are already the reason it
  // exists. What it may change is the tier, and only downwards.
  const recorder = perf && log
    ? createPerfRecorder({ log, tier: capability.tier ?? 'high', signal, onDemote: applyTier })
    : null;
  const reported = new Set();
  const document = elements.stage.frame?.ownerDocument ?? globalThis.document ?? null;
  const listeners = [];
  let sheets = null;
  let sceneIndex = null;
  // The viewport the scene on screen was planned with, and the story instant its
  // chunk window was last held at. The viewport is remembered rather than
  // re-measured: asking the stage for its letterbox ten times a second is a
  // forced layout on the devices this window exists to protect.
  let sceneView = null;
  let heldAtMs = null;
  let heldCast = null;
  let signature = null;
  let subtitle = null;
  let note = '';
  let boardFailure = null;
  // The first instant the scheduler has not been told about yet. Cues are
  // half-open — `[from, to)` — so a story whose first line starts at t=0 needs
  // the very first slice to be `[0, 1)`, and a seek to t needs the cue AT t to
  // be the seek's business and never the next slice's.
  let mediaNextMs = 0;
  let lastFrameAt = -Infinity;
  let frame = null;
  let ended = false;
  let started = false;
  // The story is held, not ended: `'writer'` when playback caught up with the
  // writer (the stage dims until the next scene lands or the host says there is
  // none), `'media'` when a performance reached sound or pictures that have not
  // landed (the last frame stays up until they do). `resumeAfterAppend` is the
  // transport's promise about what happens then, and a viewer may change it
  // while they wait.
  let waiting = null;
  let resumeAfterAppend = false;
  let resumeWhenVisible = false;
  // A pointer is down on the scrub bar: the picture follows it, the sound is
  // held until it lands. See `seekTo`.
  let scrubbing = false;
  let destroyed = false;
  // Which hold is current, its spinner and give-up timers, and its ear on the link.
  let holds = 0;
  let holdTimers = [];
  let unwatchHold = null;
  // The scene a paused seek landed in before its sheets did, being fetched.
  let awaitedCut = null;
  // Which arrival at the end the screen is still owed. An end card is played
  // between reaching the end and showing it, and a viewer who scrubs back out
  // in the middle of one has left an end that must not arrive behind them.
  let endArrival = 0;
  // The story is being recorded (`video-export.mjs`): `{ size }`, the frame the
  // canvas is backed at for the length of the take.
  let exporting = null;
  // Where frames come from: the display, or a fast take stepping the story by
  // hand (`fast-export.mjs`). Asked of the globals each time, as before.
  const display = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
  let frames = display;

  listen(document, 'visibilitychange', () => {
    if (document?.visibilityState === 'hidden') hide();
    else if (resumeWhenVisible) play();
  });
  listen(globalThis.window ?? null, 'pagehide', hide);

  // The counter picture lands whenever its fetch does, and its landing changes
  // nothing the signature reads: a board already settled — paused, or running
  // with nothing moving — would show it at the next thing that moved. So the
  // landing is a frame of its own. Not before the first frame has been drawn,
  // which reads the picture like any other.
  void counter?.landed?.then((drawable) => {
    if (!drawable || destroyed || sceneIndex === null) return;
    render(clock.now(), { force: true });
  });

  return {
    viewport,
    prepare,
    begin,
    // The gesture, spent without starting the story. With a card between the
    // begin click and `begin()`, the two are half a minute apart — and the
    // audio session is unlocked by the click or not at all.
    unlockMedia: () => { void media.unlock(); },
    // The transport, out of the way of a card and back afterwards. The bar is
    // drawn under the card layer, so this is about the KEYS: `live()` is what
    // makes them mean something, and a story started behind an opaque film is
    // the failure it prevents.
    holdTransport: () => controls.conceal(),
    releaseTransport: () => controls.reveal(),
    destroy,
    play,
    pause,
    seekTo,
    beginExport,
    endExport,
    pauseExport: () => { if (exporting) { pause(); media.pause(); } },
    resumeExportTail: () => { if (exporting && ended) media.resume(); },
    appendScene,
    finishStory,
    isPlaying: () => clock.running,
    getState,
    // Sections are written at scene boundaries, so the scene ON SCREEN has not
    // been written yet — and that is exactly the scene somebody downloading a
    // log in the middle of it is asking about.
    flushPerf: (reason = 'flush') => recorder?.flush(reason) ?? null,
  };

  function getState() {
    return {
      tMs: clamp(clock.now()), durationMs, playing: waiting ? resumeAfterAppend : clock.running,
      ended, started, sceneIndex, subtitle: subtitle ?? '',
    };
  }

  function updateControls(value) {
    controls.update(value);
    onState(getState());
  }

  /**
   * How much the picture is magnified between the sheet and the eye.
   *
   * Asked of the stage rather than derived here: it is the one thing that
   * measures stage DOM, and a second definition of the letterbox scale would
   * drift from the one the picture is actually drawn at.
   */
  function viewport() {
    // A recording is drawn at its own frame, not the screen's: its sheets are
    // chosen for the pixels the file will have.
    if (exporting) {
      return { fitScale: stage.exportScale() ?? 1, dpr: 1, dprCap: 1, ...(board?.layout ? { board } : {}) };
    }
    // The tier's own ceiling goes with it: a sheet chosen for 2x and drawn at
    // 1.5x is bytes a weak device downloaded and decoded for nothing, which is
    // the opposite of what demoting it was for.
    return {
      fitScale: stage.fitScale(),
      dpr: globalThis.devicePixelRatio ?? 1,
      dprCap: tier.dprCap,
      ...(board?.layout ? { board } : {}),
    };
  }

  /** The gate: the whole opening scene decoded, then the first frame drawn. */
  async function prepare(onProgress = () => {}) {
    // The plate answers for its own element: `video-plate.mjs` is the only file
    // that touches the `<video>`, and the recorder asks it rather than reaching
    // past it.
    recorder?.watchVideo({ getVideoPlaybackQuality: () => plate.quality() });
    // Sound first: the opening's lines and its bed are small, and a story that
    // opens on pictures and then waits for its first word has opened wrong. A
    // gate that cannot get them lets the story start anyway — the hold at the
    // line is what waits, and what says so if it has to.
    const sound = within(media.prepare?.(), HOLD_TIMEOUT_MS);
    await Promise.all([sound, loader.loadScene(0, viewport(), { keep: true, onProgress })]);
    if (destroyed || signal?.aborted) return;
    render(0, { force: true });
    controls.arm(durationMs);
    updateControls({ tMs: 0, playing: false, ended: false });
  }

  /** The viewer pressed begin: this is the one gesture the media can spend. */
  function begin() {
    if (destroyed || started) return;
    started = true;
    // Nothing sounds before the gesture that unlocked the audio, so the
    // scheduler's clock starts here rather than at the frame the gate drew.
    mediaNextMs = clock.now();
    controls.show();
    void media.unlock();
    play();
    // Warmed one scene at a time, during playback and behind the story's own
    // streaming: a burst of sheets here would starve the narration and the plate
    // the viewer is waiting on right now.
    //
    // The viewport is handed over as the QUESTION, not as the answer it had at
    // this instant: a tier demotion lowers `dprCap` and a resize moves the
    // letterbox, and a queue holding the begin-time numbers would spend the
    // rest of the story fetching sheets `openScene` will never ask for.
    // A performance's pictures wait behind its narration: a line is a few
    // hundred kilobytes and a sheet a few megabytes, and the line is sooner.
    const warm = () => loader.queueRemainingScenes(1, viewport, {}).catch(warmingFailed);
    if (media.loaded) void media.loaded().then(warm);
    else void warm();
  }

  function play() {
    if (destroyed || boardFailure) return;
    // Waiting for a scene nobody has written yet: there is no time to move, so
    // what the button means is the resume, and the story takes it the moment
    // the scene lands. A transport that did nothing here would be a dead
    // control at the one point a viewer is most likely to press it.
    if (waiting) {
      resumeAfterAppend = true;
      updateControls({ tMs: clock.now(), playing: true, ended: false });
      return;
    }
    // The end of a recording is the end of the take: the file is being written.
    if (ended && exporting) return;
    // Pressing play on an ended story is a replay, and a replay is a seek: the
    // transport has one button and the runtime has one way back to the start.
    //
    // What a replay IS, though, is not the runtime's to decide: a mount that
    // opened with an intro card opens with it again, and the story is asked for
    // once the curtain falls. The seek has already happened either way, so the
    // story is standing at zero behind whatever the app puts in front of it.
    if (ended) {
      seekTo(0);
      if (onReplay()) return;
    }
    resumeWhenVisible = false;
    clock.start();
    plate.play();
    // Play pressed with the pointer still down on the bar: the landing the
    // release would have made is made now, or the story would come back
    // sounding the line it was dragged away from.
    if (scrubbing) {
      scrubbing = false;
      media.seek(clock.now());
    }
    media.resume();
    recorder?.resume();
    startLoop();
    render(clock.now(), { force: true });
    // A tab that was already hidden when the story was told to play never gets
    // a `visibilitychange` to pause on, and a hidden tab is given no animation
    // frames — so the clock would stand still under a plate video that kept
    // rolling. Noticed here rather than waited for.
    if (document?.visibilityState === 'hidden') hide();
  }

  function pause() {
    if (destroyed) return;
    if (waiting === 'media') {
      leaveWaiting(false);
      updateControls({ tMs: clock.now(), playing: false, ended: false });
      return;
    }
    if (waiting) {
      resumeAfterAppend = false;
      // `settle` left the line being read out sounding — that is the whole
      // point of the wait. A viewer who presses pause under the spinner is
      // asking for that to stop too, and a transport reading `paused` over a
      // voice still speaking is the control lying about what it did.
      media.pause();
      updateControls({ tMs: clock.now(), playing: false, ended: false });
      return;
    }
    if (!clock.running) return;
    clock.pause();
    stopLoop();
    plate.pause();
    media.pause();
    recorder?.pause();
    // `mediaNextMs` is deliberately left where the last frame put it. The sliver
    // between that frame and this click is time the story stood at but never
    // crossed, and a line whose cue falls inside it has not been started yet.
    // Story time does not move while paused, so on resume the first frame
    // crosses that sliver at most one frame late — the line starts from the top
    // (`LATE_START_MS`), a few tens of milliseconds after its subtitle. Skipping
    // the sliver instead lost the line for good: subtitle on screen, nothing to
    // hear, until the next cue.
    render(clock.now(), { force: true });
  }

  function toggle() {
    if (destroyed) return;
    if (waiting) {
      if (resumeAfterAppend) pause();
      else play();
      return;
    }
    if (ended && onEndToggle()) return;
    if (ended || !clock.running) play();
    else pause();
  }

  /**
   * Land on an instant.
   *
   * The media is told separately from the picture: crossing time forward starts
   * what begins in the slice, but landing on an instant asks what should be
   * SOUNDING there — and the two questions have different answers for every
   * sound effect the seek jumped over.
   */
  function seekTo(milliseconds, options) {
    // A recording is one unbroken run of the story: nothing moves it but the
    // recording itself.
    if (exporting) return;
    land(milliseconds, options);
  }

  function land(milliseconds, { settled = true } = {}) {
    if (destroyed || boardFailure) return;
    const t = clamp(milliseconds);
    clock.seek(t);
    if (started) {
      if (settled) {
        placeSound(t);
      } else if (!scrubbing) {
        // The first move of a drag: what was sounding is hushed and held, and
        // nothing is opened until the pointer lands. Placing the sound on every
        // move opened one narration element per pointer event — a fetch and a
        // decoder each — and threw it away on the next.
        scrubbing = true;
        media.pause();
      }
    }
    mediaNextMs = t + 1;
    // Scrubbing back out of the end takes the end overlay with it, but it does
    // not start the story: a paused player stays paused wherever it is put.
    if (ended && t < durationMs) {
      ended = false;
      // And it takes the end card with it, along with the arrival the card was
      // still going to announce — a story dragged back into is not one that
      // ends the moment its closing film runs out.
      endArrival += 1;
      onEndLeft();
      elements.stage.end.hidden = true;
    }
    // Scrubbing back out of the wait takes the spinner with it and leaves the
    // story where the pointer put it, paused — the same thing scrubbing out of
    // the end does. The append that arrives later finds nothing to resume.
    // Out of a hold, though, the story goes on playing from where it landed —
    // and holds again there if that is not ready either.
    if (waiting && t < durationMs) leaveWaiting(waiting === 'media', { hushed: scrubbing });
    render(t, { force: true });
  }

  /**
   * The sound of the instant landed on.
   *
   * Scrubbing a paused story moves what WOULD be sounding into place and
   * freezes it there; the resume plays it from the offset the seek chose.
   * Without the pause, dragging the bar of a paused story talks. A RUNNING
   * story resumes what the drag hushed — its music, still held — around the
   * line the landing opened.
   */
  function placeSound(t) {
    scrubbing = false;
    media.seek(t);
    if (clock.running) media.resume();
    else media.pause();
  }

  function skip(deltaMs) {
    seekTo(clock.now() + (Number.isFinite(deltaMs) ? deltaMs : SKIP_MS));
  }

  /**
   * Make ready to record the story from its start.
   *
   * The story is stopped and taken back to zero, the canvas is backed at the
   * recording's frame, the loop draws at the full cadence whatever the device's
   * tier, and the sound comes from a scheduler built on `output` — every
   * element it opens is one the recording hears. Seeking is locked until
   * `endExport`. Resolves once the opening scene is decoded at the new size and
   * drawn; the caller starts its recorder and then plays.
   *
   * With a `timebase` the take is stepped rather than filmed: the story reads
   * time and asks for frames from it instead of from the wall clock and the
   * display, and it sounds nothing — its sound is mixed from the schedule.
   */
  async function beginExport({ output, size, onError = () => {}, timebase = null }) {
    if (destroyed || exporting) return;
    const returnTo = clock.now();
    pause();
    if (timebase) {
      if (clock.running) throw new Error('the story could not be stopped to be saved');
      stopLoop();
      clock.useNow(timebase.now);
      frames = timebase;
    }
    exporting = { size, onError, readyScene: null, sceneLoad: null, returnTo, stepped: timebase !== null };
    const mine = exporting;
    controls.lockSeeking(true);
    stage.setExportSize(size);
    frameIntervalMs = 1000 / DEFAULT_DRAW_HZ;
    if (timebase) {
      media.destroy();
      media = SILENT;
    } else swapMedia(output);
    // Planned again at the recording's size, not at the size the screen had.
    sceneIndex = null;
    sceneView = null;
    land(0);
    const sound = within(media.prepare?.(), HOLD_TIMEOUT_MS);
    await Promise.all([
      sound, stage.prepareExport(), loader.loadScene(0, viewport(), { keep: true }),
      !story.bundle?.performance && !board?.world ? plate.prepareExport() : null,
    ]);
    if (destroyed || exporting !== mine) return;
    render(clock.now(), { force: true });
  }

  /** The recording is over, kept or not: the player is the player again. */
  function endExport() {
    if (destroyed || !exporting) return;
    const { returnTo, stepped } = exporting;
    pause();
    if (stepped) {
      // A frame still asked of the take's own timebase would never be given.
      stopLoop();
      if (clock.running) clock.pause();
      clock.useNow();
      frames = display;
    }
    exporting = null;
    controls.lockSeeking(false);
    stage.setExportSize(null);
    frameIntervalMs = 1000 / tier.drawHz;
    swapMedia(null);
    sceneIndex = null;
    sceneView = null;
    land(returnTo);
  }

  /** The story's sound, from a fresh scheduler whose elements come from `output`. */
  function swapMedia(output) {
    media.destroy();
    media = createMediaScheduler({
      timeline: story.timeline, bundle: story.bundle, onWarning: mediaWarned, store: narration, output,
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    clearHoldTimers();
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    listeners.length = 0;
    controls.destroy();
    media.destroy();
    narration?.destroy();
    plate.destroy();
    stage.destroy();
    recorder?.destroy();
  }

  /**
   * A tier the recorder lowered, applied to everything it means.
   *
   * The picture gets cheaper in two places at once — fewer device pixels and
   * fewer draws, the shadow being off on every tier for now — and the cache
   * stops holding as much, because the
   * machine that produced five seconds of slow frames is the one whose tab gets
   * reloaded out from under the child.
   */
  function applyTier(name) {
    if (destroyed) return;
    const next = tierSettings(name);
    tier = { dprCap: next.dprCap, drawHz: next.drawHz };
    // A recording keeps the full cadence for the length of the take.
    if (!exporting) frameIntervalMs = 1000 / next.drawHz;
    stage.setTier({ dprCap: next.dprCap, shadows: next.shadows });
    cache?.setBudget?.(next.bitmapBudget);
  }

  // A hidden tab is a paused story that remembers it was playing. The browser
  // throttles `requestAnimationFrame` there to a crawl, so a story left running
  // would drift out of sync with its own audio instead of waiting.
  function hide() {
    // A stepped take does not lean on the display, so a hidden tab only slows it.
    if (destroyed || !clock.running || exporting?.stepped) return;
    pause();
    resumeWhenVisible = !exporting;
  }

  function startLoop() {
    if (frame !== null || destroyed) return;
    lastFrameAt = -Infinity;
    frame = frames.request(tick);
  }

  function stopLoop() {
    if (frame === null) return;
    frames.cancel(frame);
    frame = null;
  }

  /**
   * The cadence is measured on the FRAME's clock, not the story's.
   *
   * Story time jumps: seek back ten seconds and it is ten seconds smaller than
   * it was a frame ago. Throttling against that would refuse to draw until the
   * story had climbed back to where it started — a frozen picture over a
   * running plate, and ten seconds of cues withheld and then dumped in one
   * frame when it finally caught up.
   */
  function tick(frameMs) {
    if (destroyed) return;
    frame = frames.request(tick);
    const now = Number.isFinite(frameMs) ? frameMs : lastFrameAt + frameIntervalMs;
    // Every animation frame, not every drawn one: what the recorder is asking
    // is whether the BROWSER is keeping up with its own display, and the draw
    // cadence is deliberately slower than that.
    recorder?.frame(now);
    if (now - lastFrameAt < frameIntervalMs) return;
    lastFrameAt = now;
    render(clock.now());
  }

  /**
   * One instant, on every plane that shows it.
   *
   * `force` is for the instants nobody is looping through — the first frame, a
   * seek, a pause — where the picture must be repainted even though the runtime
   * would otherwise decide nothing had changed.
   */
  function render(tMs, { force = false } = {}) {
    if (destroyed) return;
    let t = clamp(tMs);
    // Sound or a cut this frame would reach that has not landed: the story
    // stands at that instant and holds there. Nothing is crossed on the frame
    // that finds it — a sound effect started here would be cut by the hold a
    // moment later — so what fell before it is started when the hold ends.
    const hold = started && clock.running && !scrubbing && !waiting ? holdAt(t) : null;
    if (hold) {
      t = hold.atMs;
      clock.seek(t);
    }
    const state = cursor.at(t);
    const shown = openScene(state);
    if (exporting && !story.bundle?.performance && (
      exporting.readyScene !== sceneIndex || (!board?.world && !plate.captureReady())
    )) {
      if (clock.running && !waiting) holdFor({
        atMs: t, until: () => Promise.all([exporting.sceneLoad, !board?.world ? plate.prepareExport() : null]),
      });
      return;
    }
    // A performance keeps its scene whole from the moment it opens, so it has no
    // chunk window to hold — and holding one would take back the scene on screen
    // just as a cut hold had made room for the next, trading the two for ever.
    if (shown && !story.bundle?.performance) holdChunks(t, state, force);
    report(state.warnings);
    // Only a RUNNING story crosses time. A paused one is redrawn at the instant
    // it stands at — by the pause itself, by a scrub, by a resize — and handing
    // that instant to the scheduler would start the line that happens to fall
    // in the sliver since the last frame, reading itself out over a frozen
    // picture. A story being dragged is running but hushed: its sound is placed
    // once, where the pointer lands, not started at every instant it passes.
    if (started && clock.running && !scrubbing && !hold) {
      if (t >= mediaNextMs) {
        media.advance(mediaNextMs, t + 1);
        mediaNextMs = t + 1;
      }
      media.tick(t);
    }
    plate.aim(journeyCamera(state));
    // The other half of "behind the board". Everything else the board changes
    // about the picture is a draw-list answer, but the plate is a `<video>` on
    // its own compositor layer that the canvas never touches, so the blur has
    // to be asked for here — from the same instant, on the same clock.
    // The opaque card panel protects the lesson; its surrounding forest stays visible.
    plate.frost(!board?.world && boardStanding(state.slate) && state.slate?.mode !== 'cards', state.plate?.resolution?.[1]);
    // A cut whose sheets are not decoded is not drawn at all: the last frame
    // stays up until every one of them is, never a scene with parts missing.
    if (shown) {
      paint(state, force);
      say(state.subtitle);
    }
    if (hold) {
      holdFor(hold);
      return;
    }
    // The wait owns the transport while it is up: the button says what happens
    // when the scene lands, and the stopped clock underneath would say the
    // opposite — including to `toggle`, which reads the button back.
    if (!waiting) updateControls({ tMs: t, playing: clock.running, ended });
    if (ended || waiting) return;
    if (!(state.ended || (durationMs > 0 && t >= durationMs))) return;
    // The end of what is PUBLISHED is not the end of the story. Which of the
    // two this is, only the host knows — so an incomplete story waits here
    // instead of ending, and keeps waiting until a scene lands or the host
    // says the writer stopped.
    if (complete) finish();
    else waitForScene();
  }

  /**
   * The stage caught up with the writer.
   *
   * Everything stops exactly the way the end stops it, minus the end: the
   * picture stays on its last frame, the spinner says why, and the transport
   * keeps meaning something — `resumeAfterAppend` remembers whether the story
   * was playing when it got here, so a viewer who paused before the last frame
   * is not started again by a scene landing.
   */
  function waitForScene() {
    waiting = 'writer';
    resumeAfterAppend = clock.running;
    clock.pause();
    stopLoop();
    plate.pause();
    // The instant the stage caught up with the writer is the end of the line
    // the prefix stopped on, so `settle` rather than `pause`: the sentence is
    // finished under the spinner instead of being frozen mid-word and picked up
    // again when the scene lands.
    media.settle();
    elements.stage.waiting.hidden = false;
    updateControls({ tMs: clock.now(), playing: resumeAfterAppend, ended: false });
  }

  function leaveWaiting(resume, { hushed = false } = {}) {
    if (!waiting) return;
    waiting = null;
    clearHoldTimers();
    elements.stage.waiting.hidden = true;
    if (elements.stage.hold) elements.stage.hold.hidden = true;
    const wanted = resumeAfterAppend;
    resumeAfterAppend = false;
    if (!resume || !wanted) return;
    if (hushed) runHushed();
    else play();
  }

  /**
   * The story runs on under a drag that began in a hold, and stays silent until
   * the pointer lands: `placeSound` starts the sound there, as for any drag.
   */
  function runHushed() {
    resumeWhenVisible = false;
    clock.start();
    plate.play();
    recorder?.resume();
    startLoop();
  }

  /**
   * One more scene, published while the story is being watched.
   *
   * The schedule is recompiled by the caller and handed over whole rather than
   * patched here, because that is what makes the swap safe: an appended scene
   * never moves an event the viewer has already crossed, so the story they are
   * inside is the same story — only longer.
   */
  async function appendScene(next) {
    if (destroyed) return;
    // The instant a waiting story stopped at is the instant the scene that has
    // just landed opens on, and the runtime crossed that slice already —
    // against a schedule which had nothing in it there. So the scheduler is
    // wound back to the end that is about to move, and no further: a line the
    // story really did read would otherwise start over.
    mediaNextMs = Math.min(mediaNextMs, durationMs);
    story = { bundle: next.bundle, timeline: next.timeline };
    durationMs = Math.max(0, Math.round(next.timeline?.duration_ms ?? 0));
    cursor.setStory(story.timeline, story.bundle);
    media.setStory(story);
    loader.setStory(story);
    controls.arm(durationMs);
    // The one scene in a story that nothing warms. Scene 0 is gated before the
    // first frame and every later one is queued while the story plays, but a
    // scene the viewer is already waiting on is reached the instant it is
    // published — so resuming straight into it opens on a plate that has not
    // loaded and stand-in thumbnails for the cast. The story is stopped and the
    // spinner is already up: the decode is free here and visible one tick later.
    if (waiting === 'writer') await warmAppended();
    if (destroyed) return;
    leaveWaiting(true);
    // The warm queue runs to the end of what was published and returns; the
    // scene that just landed is past that end, so it is asked for again from
    // there. A queue still running answers for itself and this call is free.
    if (started) void loader.queueRemainingScenes(sceneCount() - 1, viewport, {}).catch(warmingFailed);
    // An appended scene that moved nothing puts the wait straight back up, and
    // that wait has already said what the transport reads.
    if (!waiting) updateControls({ tMs: clock.now(), playing: clock.running, ended });
  }

  /**
   * The scene the wait is about to resume into, decoded before it is shown.
   *
   * A failure does not hold the story in the spinner. An asset that is never
   * coming would keep a child looking at it forever, and the scene still plays
   * without its sheets — placeholders and a named warning, which is what every
   * other cut in this player already does when a decode fails.
   */
  async function warmAppended() {
    try {
      await loader.loadScene(sceneCount() - 1, viewport(), { keep: true });
    } catch (error) {
      warmingFailed(error);
    }
  }

  /**
   * The host says the writer stopped — for any reason, well or badly.
   *
   * There is one behaviour for both: the published prefix is the story, so the
   * next end reached is the real one. A story that failed halfway is a story
   * that ends early, and the words about the missing ending are the host's to
   * write, next to the player rather than inside it.
   */
  function finishStory() {
    if (destroyed || complete) return;
    complete = true;
    // The scene on screen has not changed, but what comes after it has: a
    // viewer already inside the last scene when the writer stopped would
    // otherwise reach an end card nothing had warmed.
    onSceneOpen(sceneIndex, sceneCount(), complete);
    // Already sitting at the end of the prefix with the spinner up: that end
    // was the story's, and nothing is coming to move it.
    if (waiting !== 'writer') return;
    leaveWaiting(false);
    finish();
  }

  function paint(state, force) {
    const next = signatureOf(state, board);
    if (!force && !exporting && next === signature) return;
    signature = next;
    stage.draw(state, sheets);
  }

  function say(text) {
    const next = text ?? '';
    if (next === subtitle) return;
    subtitle = next;
    elements.stage.subtitle.textContent = next;
    // The note belongs to the line it was raised for. A new line — or the
    // silence between two — is the end of it.
    showNote('');
  }

  /**
   * The one media failure a viewer without the debug drawer can see.
   *
   * The director this runtime replaced wrote this sentence under the subtitle
   * whenever a line's audio would not play; the element, its stylesheet rule
   * and its test outlived the writer. A line that cannot be heard is still a
   * line that can be read, and the subtitle for it is already on screen.
   */
  function mediaWarned(detail) {
    if (exporting) exporting.onError(new Error(detail.message || 'story audio could not be saved'));
    if (story.bundle?.performance) { pause(); showNote(detail.message); onWarning(detail); return; }
    if (detail?.asset === 'narration') showNote('narration unavailable · read along');
    onWarning(detail);
  }

  function showNote(text) {
    const next = boardFailure ?? text ?? '';
    if (next === note) return;
    note = next;
    elements.stage.mediaNote.textContent = next;
  }

  /**
   * A cut: the plate swaps, the sheets swap, and the scene the story has just
   * reached is kept in the cache while it is the scene on screen.
   *
   * The load is not awaited. Every later scene was already warmed in playing
   * order, and a story that stopped at a cut to wait for a decode would stutter
   * on exactly the frame a viewer is most likely to be watching. A performance
   * is the exception: its sheets are too big to keep warm, so its cut is opened
   * only once they are all decoded (`cutReady`), and until then the story
   * holds on the last frame rather than show a scene with parts missing.
   */
  function openScene(state) {
    if (state.sceneIndex === sceneIndex) {
      // A performance's scene can lose its sheets while it is on screen: a seek
      // into a scene that was not ready decoded that one in their place. Seeking
      // back fetches them again rather than drawing the scene without them.
      if (cutReady(sceneIndex)) return true;
      awaitCut(sceneIndex);
      return false;
    }
    if (!cutReady(state.sceneIndex)) {
      awaitCut(state.sceneIndex);
      return false;
    }
    sceneIndex = state.sceneIndex;
    stage.setFarmOverlay(sceneHasFarmBoard(story.bundle?.scenes?.[sceneIndex]));
    signature = null;
    // One perf section per scene, so a log from a slow phone says WHERE it was
    // slow rather than that it was.
    recorder?.scene(sceneIndex);
    // Which scene is on screen, and whether there is anything after it. What
    // reads this is the end card, warming its film as the last scene opens:
    // early enough to be there when the story stops, late enough not to take
    // bandwidth from the scenes the viewer is watching now.
    onSceneOpen(sceneIndex, sceneCount(), complete);
    // The window belongs to the scene it was measured in: a cut invalidates it,
    // and the render that opened this scene holds a new one on the same frame.
    heldAtMs = null;
    heldCast = null;
    if (sceneIndex === null) {
      sheets = null;
      sceneView = null;
      plate.showScene(null);
      return true;
    }
    const view = viewport();
    sceneView = view;
    const opened = sceneIndex;
    sheets = sceneSheets(loader.plan(sceneIndex, view), cache, counter);
    plate.showScene(story.bundle?.scenes?.[sceneIndex]?.plate ?? null);
    const loading = loader.loadScene(sceneIndex, view, { keep: true, onRequiredImage: () => imageArrived(opened) })
      // A running story draws the sheets as they land, on its next frame. A
      // PAUSED one has no next frame: a scrub into a scene that is not decoded
      // yet painted placeholders and stopped, and they stayed on screen until
      // somebody pressed play. Only for the scene still on screen — a cut that
      // has already happened has its own paint coming.
      .then(() => {
        if (exporting && opened === sceneIndex) exporting.readyScene = opened;
        imageArrived(opened);
      });
    if (exporting) exporting.sceneLoad = loading;
    void loading.catch(warmingFailed);
    // The next scene's sheets, decoded while this one plays, as far as the
    // budget allows: the cut to it is then only a hold for what did not fit.
    if (story.bundle?.performance) void loader.prepareScene(opened + 1, opened, view).catch(warmingFailed);
    return true;
  }

  /** A performance's cut is shown only once every sheet its scene draws is decoded. */
  function cutReady(index) {
    return !story.bundle?.performance || index === null || loader.sceneReady(index, sceneView ?? viewport());
  }

  /**
   * A paused story sought into a scene that is not decoded shows its last
   * frame until the scene is, and then the scene. A running one holds instead
   * (`holdAt`), and asks for the same sheets there.
   */
  function awaitCut(index) {
    if (awaitedCut === index) return;
    awaitedCut = index;
    void loader.loadScene(index, sceneView ?? viewport(), { keep: true })
      .then(() => {
        if (awaitedCut === index) awaitedCut = null;
        if (!destroyed && !clock.running && !waiting) render(clock.now(), { force: true });
      }, () => { if (awaitedCut === index) awaitedCut = null; });
  }

  /**
   * The first thing between the last frame and `t` a performance cannot show or
   * sound yet: a line or the start of a bed or song still downloading, or a cut
   * whose sheets are not decoded. `null` for everything else, and for every
   * other kind of story.
   */
  function holdAt(t) {
    if (!story.bundle?.performance) return null;
    const from = Math.min(mediaNextMs, t);
    const found = [media.blocker?.(from, t + 1), cutBlocker(from, t)].filter(Boolean);
    return found.sort((a, b) => a.atMs - b.atMs)[0] ?? null;
  }

  /**
   * A scene the story reaches in `(fromMs, tMs]`, or the one standing at `tMs`,
   * whose sheets are not all decoded. Not a scene the story is leaving: holding
   * for it would take the next one's sheets back, and the two would trade them.
   */
  function cutBlocker(fromMs, tMs) {
    for (const [index, scene] of (story.bundle.scenes ?? []).entries()) {
      const reached = scene.start_ms >= fromMs && scene.start_ms <= tMs;
      const standing = scene.start_ms <= tMs && tMs < scene.end_ms;
      if ((!reached && !standing) || cutReady(index)) continue;
      return { atMs: Math.max(scene.start_ms, fromMs), until: () => sceneLanded(index) };
    }
    return null;
  }

  /** Decode a held-for scene, asking again after a failure while the hold lasts. */
  async function sceneLanded(index) {
    while (!destroyed && waiting === 'media') {
      try {
        await loader.loadScene(index, sceneView ?? viewport(), { keep: true });
        return;
      } catch (error) {
        // A file the store does not have does not arrive by waiting: the hold says so at once.
        if (signal?.aborted || error?.retryable === false) throw error;
        await new Promise((resolve) => { setTimeout(resolve, RETRY_MS); });
      }
    }
  }

  /**
   * Stop on the last frame until what the story reached has landed.
   *
   * Picture, voice and music stop together, exactly as a pause stops them, and
   * the transport keeps reading "playing". The spinner comes only if the wait
   * outlasts a blink; a wait that does not end at all stops the story with a
   * note, and play asks again.
   */
  function holdFor(hold) {
    waiting = 'media';
    resumeAfterAppend = true;
    clock.pause();
    stopLoop();
    plate.pause();
    // Sound effects too, and they go on with the story: a pause ends them.
    if (media.hold) media.hold();
    else media.pause();
    recorder?.pause();
    clearHoldTimers();
    holds += 1;
    const mine = holds;
    const current = () => mine === holds && waiting === 'media';
    const giveUp = () => {
      if (!current()) return;
      leaveWaiting(false);
      showNote('Story media could not be loaded. Press play to try again.');
      updateControls({ tMs: clock.now(), playing: false, ended: false });
      exporting?.onError(new Error('story media could not be loaded for saving'));
    };
    const quiet = () => setTimeout(giveUp, HOLD_TIMEOUT_MS);
    holdTimers = [
      setTimeout(() => { if (current() && elements.stage.hold) elements.stage.hold.hidden = false; }, HOLD_SPINNER_MS),
      quiet(),
    ];
    // Every byte that lands restarts the count: only a link gone silent ends the hold.
    unwatchHold = onAssetProgress(() => {
      clearTimeout(holdTimers[1]);
      holdTimers[1] = quiet();
    });
    void hold.until().then(
      () => { if (current()) leaveWaiting(true); },
      (error) => { if (error?.retryable === false || exporting) giveUp(); },
    );
    updateControls({ tMs: clock.now(), playing: true, ended: false });
  }

  function clearHoldTimers() {
    for (const timer of holdTimers) clearTimeout(timer);
    holdTimers = [];
    unwatchHold?.();
    unwatchHold = null;
  }

  function imageArrived(opened) {
    if (destroyed || boardFailure || opened !== sceneIndex) return;
    // Board content can stay still indefinitely. A decoded image changes the
    // picture without changing state, so even a running loop needs invalidation.
    signature = null;
    if (!clock.running) render(clock.now(), { force: true });
  }

  /**
   * The chunks under the playhead, held against eviction.
   *
   * On the STORY's clock, and `force` is what every instant nobody looped
   * through arrives with — the first frame, a seek, a pause. Those move the
   * window at once; the cadence is only for playing forwards. The difference is
   * still measured both ways, because a t that went backwards without a force
   * behind it would otherwise hold nothing until the story caught up with
   * itself.
   *
   * Whole-sheet bundles reach this too, and it costs them one Map lookup and a
   * keep set identical to the one the gate already set — every sheet pinned and
   * the props unfiltered, because there is no window there to make room for.
   */
  function holdChunks(tMs, state, force) {
    if (sceneIndex === null || sceneView === null) return;
    // A drag is not an instant the story is AT, it is a preview of one. Every
    // pointer move seeks with `force`, and holding on each would re-pin the
    // cache at a place the pointer has already left and ask for the chunks of
    // an instant nobody stopped on — sixty fetches for a one-second drag,
    // each evicted by the next move, over the link the plate video is
    // streaming on. The landing (`placeSound` clears this first) holds once.
    if (scrubbing) return;
    const settled = !force && heldAtMs !== null && Math.abs(tMs - heldAtMs) < KEEP_CADENCE_MS;
    if (settled && !castMoved(state.actors)) return;
    heldAtMs = tMs;
    heldCast = state.actors;
    const opened = sceneIndex;
    const landing = loader.holdScene(sceneIndex, sceneView, state.actors, {
      onRequiredImage: () => imageArrived(opened),
    });
    // A running story draws what lands on its next frame. A PAUSED one has no
    // next frame — and since the window fetches most of a scene now, a scrub
    // INSIDE one scene is the case `openScene` never sees: the chunks the
    // scrubbed-to instant needs arrive after the only paint anyone asked for,
    // and the stage stands in with the pose it was holding. Only for the scene
    // still on screen, and only when the hold really asked for something, so
    // the repaint cannot hold from itself for ever.
    if (!landing) return;
    void landing.then(() => imageArrived(opened)).catch(warmingFailed);
  }

  /**
   * Somebody changed clip, or came on, or left.
   *
   * The one moment the window is wrong and the cadence has not noticed yet: a
   * character who starts waving is drawing from an object nothing has asked for,
   * and waiting out the rest of the tick to ask is a tenth of a second of the
   * pose they were in before. Compared field by field against the array the last
   * hold was made from — this runs on every drawn frame, and a key built per
   * frame to answer "nothing changed" would be the cheapest thing here to get
   * wrong.
   */
  function castMoved(actors) {
    if (heldCast === null || heldCast.length !== actors.length) return true;
    for (const [index, actor] of actors.entries()) {
      if (actor.slug !== heldCast[index].slug || actor.clip !== heldCast[index].clip) return true;
    }
    return false;
  }

  function sceneCount() {
    return story.bundle?.scenes?.length ?? 0;
  }

  /**
   * A broken asset is named by the loader itself, once, and settles: what
   * reaches here is the other kind — a plan that threw, or the abort of a
   * destroyed player. Silence would leave a scene drawing placeholders for the
   * rest of the story against a clean log.
   */
  function warmingFailed(error) {
    if (destroyed || signal?.aborted || error?.name === 'AbortError') return;
    if (exporting) exporting.onError(error);
    if (error?.code === 'BOARD_IMAGE_UNAVAILABLE') {
      boardFailure = `${error.message}. Reload the lesson to try again.`;
      resumeWhenVisible = false;
      resumeAfterAppend = false;
      clock.pause();
      stopLoop();
      plate.pause();
      media.pause();
      recorder?.pause();
      updateControls({ tMs: clock.now(), playing: false, ended: false });
      // Reuse the native stopping screen so a subtitle preference cannot hide
      // a failure of the lesson itself. No end phase is played on this path.
      elements.stage.end.children[1].textContent = 'picture unavailable';
      elements.stage.end.children[2].textContent = 'reload the lesson to try again';
      elements.stage.end.setAttribute('role', 'alert');
      elements.stage.end.hidden = false;
      showNote(boardFailure);
      return;
    }
    if (story.bundle?.performance) {
      pause();
      showNote('Story media could not be loaded. Reopen to retry.');
    }
    onWarning({
      type: 'media',
      asset: 'scene',
      message: `scene assets could not be prepared: ${error?.message ?? String(error)}`,
      scene_index: sceneIndex,
    });
  }

  /**
   * The end is a state, not an event: the video stops, the loop stops, and the
   * transport turns into a replay. The error path lands here too — a story that
   * cannot go on is over, and idling is the only honest thing to show.
   */
  function finish() {
    const wasRunning = clock.running;
    ended = true;
    resumeWhenVisible = false;
    clock.pause();
    stopLoop();
    plate.pause();
    // The clock runs out ON the last line, never past it, so the end is reached
    // while the last sentence is still being read — and it is left to finish
    // rather than cut, which is the whole of the reported bug at the one
    // instant the schedule's own grace cannot reach.
    media.settle();
    recorder?.flush('end');
    recorder?.pause();
    revealEnd(wasRunning);
    updateControls({ tMs: durationMs, playing: false, ended: true });
  }

  /**
   * The end screen, once whatever the app puts before it is over.
   *
   * A mount with an end card plays it here — after the teardown above, so the
   * card opens on a story that has really stopped rather than over its last
   * frames — and the screen waits behind it. A mount without one is answered
   * with nothing and shows the end on this line, exactly as it always did.
   *
   * The arrival is counted because a card takes seconds: a viewer who scrubs
   * back into the story in the middle of one has left an end that must not turn
   * up behind them, and a failure to play the card is still an end reached.
   */
  function revealEnd(playing) {
    endArrival += 1;
    const mine = endArrival;
    const card = onEnd({ playing });
    if (!card?.then) {
      elements.stage.end.hidden = false;
      return;
    }
    const show = () => {
      if (destroyed || mine !== endArrival || !ended) return;
      elements.stage.end.hidden = false;
    };
    void card.then(show, show);
  }

  // The cursor hands back every warning raised by every event up to t — the
  // same list `stateAt` would — so the same sentence arrives on every frame of
  // the rest of the story. Each one is logged the first time it is seen and
  // never again.
  function report(warnings) {
    for (const warning of warnings ?? []) {
      const key = JSON.stringify(warning);
      if (reported.has(key)) continue;
      reported.add(key);
      onWarning(warning);
    }
  }

  function listen(target, type, handler) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  function clamp(milliseconds) {
    if (!Number.isFinite(milliseconds)) return 0;
    const t = Math.max(0, Math.round(milliseconds));
    return durationMs > 0 ? Math.min(durationMs, t) : t;
  }
}

/** `promise`, or nothing after `ms` — whichever comes first. */
function within(promise, ms) {
  if (!promise) return Promise.resolve();
  let timer = null;
  return Promise.race([
    promise.catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * What the picture looks like, as one comparable string.
 *
 * Rounded to what the eye and the canvas can tell apart: a hundredth of a
 * percent of stage width, a tenth of a pixel of height. Two instants with the
 * same signature paint the same picture, so the second one is not painted.
 *
 * Everything above the lesson's two overlays moves because somebody moved. The
 * overlays move because the CLOCK moved, and a counting scene is often one prop
 * standing still — a prop's `frame` is `null` for its whole life — so without
 * their own progress in here the string is constant for the scene and the board
 * never arrives, the pop never runs and the ring never pulses.
 */
export function signatureOf(state, board = null) {
  if (state.renderNodes) return JSON.stringify([state.camera, state.renderNodes, state.transition]);
  const parts = [
    state.sceneIndex,
    round(state.camera?.scale, 4),
    round(state.camera?.x, 3),
    round(state.camera?.y, 3),
  ];
  for (const actor of state.actors ?? []) {
    parts.push(
      actor.slug,
      actor.clip,
      actor.frame,
      round(actor.x, 2),
      round(actor.feetY, 1),
      round(actor.heightPx, 1),
      round(actor.opacity, 2),
      overlayPhase(state.tMs, actor.highlightMs, HIGHLIGHT.durationMs),
    );
  }
  // The board's own identity — five counted and two-and-three are the same
  // total and different pictures — and how far through BUILDING it is. The
  // build, not the first pop: a board goes on moving for as long as its
  // counters are arriving, its taken ones crossing out and its equation
  // writing itself, and a signature that settled after the first counter would
  // freeze the rest of the lesson on a still scene. Then the cues' marks, which
  // land long after the build has: which counters are swept, and how far the
  // flash is through its pulse.
  parts.push(
    boardStanding(state.slate) ? 1 : 0,
    state.slate?.count ?? 0,
    state.slate?.mode ?? 'count',
    (state.slate?.groups ?? []).join(','),
    overlayPhase(state.tMs, state.slate?.sinceMs, slateBuildMs(state.slate)),
    (state.slate?.rings ?? []).join(','),
    overlayPhase(state.tMs, state.slate?.flashAt, FLASH.pulseMs),
  );
  if (state.slate?.mode === 'cards') {
    parts.push(JSON.stringify([state.slate.cards, state.slate.focus, state.slate.prompt]));
    const span = Math.max(oceanAnimationMs(state.slate), farmAnimationMs(state.slate));
    if (span > 0) parts.push(overlayPhase(state.tMs, state.slate.sinceMs, span));
  }
  const choreography = choreographyPhase(board, state);
  if (choreography !== null) parts.push('choreography', choreography);
  if (board?.world) parts.push('world', state.tMs);
  return parts.join('|');
}

/**
 * Whether a board is on screen at all — the empty one a lesson opens on
 * included. The fold says so in its own word; a picture from an older producer
 * that has no word for it is read by its count, as it always was.
 */
function boardStanding(slate) {
  return slate?.standing ?? ((slate?.count ?? 0) > 0);
}

/**
 * How far an overlay is through its own animation, or 1 once it is over.
 *
 * The ceiling is the point: while it runs, every instant is a different string
 * and every frame is painted; the moment it lands, one last repaint settles it
 * and a still scene goes back to costing nothing. Without that, a ring that
 * finished an hour of story ago would keep the loop redrawing for ever.
 */
function overlayPhase(tMs, sinceMs, spanMs) {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(tMs)) return 1;
  const elapsed = tMs - sinceMs;
  return elapsed >= 0 && elapsed < spanMs ? round(elapsed / spanMs, 3) : 1;
}

function round(value, places) {
  if (!Number.isFinite(value)) return value ?? null;
  const step = 10 ** places;
  return Math.round(value * step) / step;
}
