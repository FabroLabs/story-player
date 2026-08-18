/**
 * The runtime: one clock, one loop, and a picture that is a function of t.
 *
 * Nothing here decides what the story does. `compileTimeline` decided that once,
 * before the first frame; `stateAt` answers what the instant looks like; this
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

import { stateAt } from '../core/state/state.mjs';
import { DEFAULT_DRAW_HZ, tierSettings } from './capability.mjs';
import { createControls } from './controls.mjs';
import { createMediaScheduler } from './media-scheduler.mjs';
import { createPerfRecorder } from './perf.mjs';
import { createCanvasStage, sceneSheets } from './stage/canvas-stage.mjs';
import { createVideoPlate } from './stage/video-plate.mjs';

const SKIP_MS = 10_000;

export function createTimelinePlayer({
  elements, bundle, timeline, clock, loader, cache, log = null,
  capability = tierSettings('high'), perf = false, onWarning = () => {}, signal = null,
}) {
  const durationMs = Math.max(0, Math.round(timeline?.duration_ms ?? 0));
  // 24 fps is the ceiling the phone client holds and the cadence the sprite
  // sheets were authored at; a weak machine is given half of it rather than a
  // number of its own, so the loop skips every other tick exactly.
  let tier = {
    dprCap: capability.dprCap,
    drawHz: capability.drawHz || DEFAULT_DRAW_HZ,
    shadows: capability.shadows !== false,
  };
  let frameIntervalMs = 1000 / tier.drawHz;
  const stage = createCanvasStage(elements.stage, {
    onWarning, dprCap: capability.dprCap, shadows: capability.shadows,
  });
  const plate = createVideoPlate(elements.stage, { onWarning });
  const media = createMediaScheduler({ timeline, bundle, onWarning });
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
  let signature = null;
  let subtitle = null;
  // The first instant the scheduler has not been told about yet. Cues are
  // half-open — `[from, to)` — so a story whose first line starts at t=0 needs
  // the very first slice to be `[0, 1)`, and a seek to t needs the cue AT t to
  // be the seek's business and never the next slice's.
  let mediaNextMs = 0;
  let lastFrameAt = -Infinity;
  let frame = null;
  let ended = false;
  let started = false;
  let resumeWhenVisible = false;
  let destroyed = false;

  listen(document, 'visibilitychange', () => {
    if (document?.visibilityState === 'hidden') hide();
    else if (resumeWhenVisible) play();
  });
  listen(globalThis.window ?? null, 'pagehide', hide);

  return {
    viewport,
    prepare,
    begin,
    destroy,
    play,
    pause,
    seekTo,
    isPlaying: () => clock.running,
    // Sections are written at scene boundaries, so the scene ON SCREEN has not
    // been written yet — and that is exactly the scene somebody downloading a
    // log in the middle of it is asking about.
    flushPerf: (reason = 'flush') => recorder?.flush(reason) ?? null,
  };

  /**
   * How much the picture is magnified between the sheet and the eye.
   *
   * Asked of the stage rather than derived here: it is the one thing that
   * measures stage DOM, and a second definition of the letterbox scale would
   * drift from the one the picture is actually drawn at.
   */
  function viewport() {
    // The tier's own ceiling goes with it: a sheet chosen for 2x and drawn at
    // 1.5x is bytes a weak device downloaded and decoded for nothing, which is
    // the opposite of what demoting it was for.
    return {
      fitScale: stage.fitScale(),
      dpr: globalThis.devicePixelRatio ?? 1,
      dprCap: tier.dprCap,
    };
  }

  /** The gate: the whole opening scene decoded, then the first frame drawn. */
  async function prepare(onProgress = () => {}) {
    // The plate answers for its own element: `video-plate.mjs` is the only file
    // that touches the `<video>`, and the recorder asks it rather than reaching
    // past it.
    recorder?.watchVideo({ getVideoPlaybackQuality: () => plate.quality() });
    await loader.loadScene(0, viewport(), { keep: true, onProgress });
    if (destroyed || signal?.aborted) return;
    render(0, { force: true });
    controls.arm(durationMs);
    controls.update({ tMs: 0, playing: false, ended: false });
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
    void loader.queueRemainingScenes(1, viewport(), {}).catch(warmingFailed);
  }

  function play() {
    if (destroyed) return;
    // Pressing play on an ended story is a replay, and a replay is a seek: the
    // transport has one button and the runtime has one way back to the start.
    if (ended) seekTo(0);
    resumeWhenVisible = false;
    clock.start();
    plate.play();
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
    if (destroyed || !clock.running) return;
    clock.pause();
    stopLoop();
    plate.pause();
    media.pause();
    recorder?.pause();
    // The sliver between the last frame and this click is time the story stood
    // at but never crossed. It is given up rather than replayed on resume: at
    // most one frame of cues, and firing them a pause later would put a line
    // half a second behind its own subtitle.
    mediaNextMs = clock.now() + 1;
    render(clock.now(), { force: true });
  }

  function toggle() {
    if (destroyed) return;
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
  function seekTo(milliseconds) {
    if (destroyed) return;
    const t = clamp(milliseconds);
    clock.seek(t);
    if (started) {
      media.seek(t);
      // Scrubbing a paused story moves what WOULD be sounding into place and
      // freezes it there; the resume plays it from the offset the seek chose.
      // Without this, dragging the bar of a paused story talks.
      if (!clock.running) media.pause();
    }
    mediaNextMs = t + 1;
    // Scrubbing back out of the end takes the end overlay with it, but it does
    // not start the story: a paused player stays paused wherever it is put.
    if (ended && t < durationMs) {
      ended = false;
      elements.stage.end.hidden = true;
    }
    render(t, { force: true });
  }

  function skip(deltaMs) {
    seekTo(clock.now() + (Number.isFinite(deltaMs) ? deltaMs : SKIP_MS));
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    listeners.length = 0;
    controls.destroy();
    media.destroy();
    plate.destroy();
    stage.destroy();
    recorder?.destroy();
  }

  /**
   * A tier the recorder lowered, applied to everything it means.
   *
   * The picture gets cheaper in three places at once — fewer device pixels,
   * fewer draws, no shadows — and the cache stops holding as much, because the
   * machine that produced five seconds of slow frames is the one whose tab gets
   * reloaded out from under the child.
   */
  function applyTier(name) {
    if (destroyed) return;
    const next = tierSettings(name);
    tier = { dprCap: next.dprCap, drawHz: next.drawHz, shadows: next.shadows };
    frameIntervalMs = 1000 / next.drawHz;
    stage.setTier({ dprCap: next.dprCap, shadows: next.shadows });
    cache?.setBudget?.(next.bitmapBudget);
  }

  // A hidden tab is a paused story that remembers it was playing. The browser
  // throttles `requestAnimationFrame` there to a crawl, so a story left running
  // would drift out of sync with its own audio instead of waiting.
  function hide() {
    if (destroyed || !clock.running) return;
    pause();
    resumeWhenVisible = true;
  }

  function startLoop() {
    if (frame !== null || destroyed) return;
    lastFrameAt = -Infinity;
    frame = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (frame === null) return;
    cancelAnimationFrame(frame);
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
    frame = requestAnimationFrame(tick);
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
    const t = clamp(tMs);
    const state = stateAt(timeline, bundle, t);
    openScene(state);
    report(state.warnings);
    // Only a RUNNING story crosses time. A paused one is redrawn at the instant
    // it stands at — by the pause itself, by a scrub, by a resize — and handing
    // that instant to the scheduler would start the line that happens to fall
    // in the sliver since the last frame, reading itself out over a frozen
    // picture.
    if (started && clock.running) {
      if (t >= mediaNextMs) {
        media.advance(mediaNextMs, t + 1);
        mediaNextMs = t + 1;
      }
      media.tick(t);
    }
    plate.aim(state.camera);
    paint(state, force);
    say(state.subtitle);
    controls.update({ tMs: t, playing: clock.running, ended });
    if (!ended && (state.ended || (durationMs > 0 && t >= durationMs))) finish();
  }

  function paint(state, force) {
    const next = signatureOf(state);
    if (!force && next === signature) return;
    signature = next;
    stage.draw(state, sheets);
  }

  function say(text) {
    const next = text ?? '';
    if (next === subtitle) return;
    subtitle = next;
    elements.stage.subtitle.textContent = next;
  }

  /**
   * A cut: the plate swaps, the sheets swap, and the scene the story has just
   * reached is kept in the cache while it is the scene on screen.
   *
   * The load is not awaited. Every later scene was already warmed in playing
   * order, and a story that stopped at a cut to wait for a decode would stutter
   * on exactly the frame a viewer is most likely to be watching.
   */
  function openScene(state) {
    if (state.sceneIndex === sceneIndex) return;
    sceneIndex = state.sceneIndex;
    signature = null;
    // One perf section per scene, so a log from a slow phone says WHERE it was
    // slow rather than that it was.
    recorder?.scene(sceneIndex);
    elements.badge.scene.textContent = sceneIndex === null
      ? ''
      : `scene ${sceneIndex + 1} of ${bundle?.scenes?.length ?? sceneIndex + 1}`;
    if (sceneIndex === null) {
      sheets = null;
      plate.showScene(null);
      return;
    }
    const view = viewport();
    sheets = sceneSheets(loader.plan(sceneIndex, view), cache);
    plate.showScene(bundle?.scenes?.[sceneIndex]?.plate ?? null);
    void loader.loadScene(sceneIndex, view, { keep: true }).catch(warmingFailed);
  }

  /**
   * A broken asset is named by the loader itself, once, and settles: what
   * reaches here is the other kind — a plan that threw, or the abort of a
   * destroyed player. Silence would leave a scene drawing placeholders for the
   * rest of the story against a clean log.
   */
  function warmingFailed(error) {
    if (destroyed || signal?.aborted || error?.name === 'AbortError') return;
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
    ended = true;
    resumeWhenVisible = false;
    clock.pause();
    stopLoop();
    plate.pause();
    media.pause();
    recorder?.flush('end');
    recorder?.pause();
    elements.stage.end.hidden = false;
    controls.update({ tMs: durationMs, playing: false, ended: true });
  }

  // `stateAt` hands back every warning raised by every event up to t, so the
  // same sentence arrives on every frame of the rest of the story. Each one is
  // logged the first time it is seen and never again.
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

/**
 * What the picture looks like, as one comparable string.
 *
 * Rounded to what the eye and the canvas can tell apart: a hundredth of a
 * percent of stage width, a tenth of a pixel of height. Two instants with the
 * same signature paint the same picture, so the second one is not painted.
 */
function signatureOf(state) {
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
    );
  }
  return parts.join('|');
}

function round(value, places) {
  if (!Number.isFinite(value)) return value ?? null;
  const step = 10 ** places;
  return Math.round(value * step) / step;
}
