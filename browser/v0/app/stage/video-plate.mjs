/**
 * The background: one hardware-decoded `<video>`, aimed by the same camera the
 * canvas above it draws with.
 *
 * The plate stays a DOM video on purpose. Drawing it into the canvas would cost
 * a full-frame copy every frame and hand a 1920x1080 h264 stream to the CPU;
 * left where it is, the browser decodes it on the video engine and composites it
 * as its own layer, and the canvas over it composites as a second. Two layers,
 * no copies.
 *
 * The camera reaches it as a CSS transform because that is free — the plate's
 * pixels never change, only where they land — but it is written on the STORY's
 * clock, once per framing, not handed to a CSS transition. A transition runs on
 * the browser's clock: pausing the story mid-push would keep the ground sliding
 * under a frozen cast, and a seek would glide the plate across the stage instead
 * of cutting to where the story is. One clock, both planes.
 */

// One definition of "no camera at all", shared with the canvas above so that
// the two planes cannot disagree about what an unusable framing means.
import { WIDE_CAMERA } from './draw-list.mjs';

// Long enough that a slow link is not called a failure, short enough that a
// viewer is told something rather than watching a still poster forever. The
// story does not wait on it: the picture plays over the poster either way.
export const PLATE_READY_TIMEOUT_MS = 6_000;
const CAMERA_ORIGIN = '0 0';

export function createVideoPlate(elements, { onWarning = () => {}, gestureTarget = elements.frame } = {}) {
  const { plate, poster, video } = elements;
  let token = 0;
  let deadline = null;
  let framing = null;
  let listeners = [];
  let retry = null;
  let scene = null;
  let running = false;
  let wanted = false;
  let destroyed = false;

  plate.style.transformOrigin = CAMERA_ORIGIN;

  return { showScene, aim, play, pause, destroy };

  /**
   * Open a scene's plate: poster first, then the video, playing as soon as the
   * source is set.
   *
   * `preload="auto"` and an immediate `play()` rather than the old wait on
   * `canplay`: a muted loop is allowed to start by every autoplay policy there
   * is, and waiting for a readiness event before asking cost the opening of
   * every scene a round trip it did not need. What is waited for is `playing` —
   * the first frame actually on screen — which is when the poster may go.
   */
  function showScene(next) {
    if (destroyed) return;
    token += 1;
    const mine = token;
    releaseScene();
    scene = next ?? null;
    running = false;
    poster.style.backgroundImage = next?.poster ? `url("${cssUrl(next.poster)}")` : 'none';
    poster.classList.remove('is-ready');
    video.classList.remove('is-ready');
    video.pause();
    video.poster = next?.poster ?? '';
    video.src = next?.video ?? '';
    video.load?.();

    listen('playing', () => {
      if (mine !== token) return;
      running = true;
      clearDeadline();
      video.classList.add('is-ready');
      poster.classList.add('is-ready');
    });
    listen('error', () => {
      if (mine !== token) return;
      clearDeadline();
      // The poster is the fallback and it is already on screen, so this is a
      // downgrade rather than a stop: the story keeps its time either way.
      warn('plate video failed to load; the poster is what the scene shows');
      video.classList.remove('is-ready');
      poster.classList.remove('is-ready');
    });

    if (wanted) start();
  }

  /**
   * Aim the plate. Written only when the framing really moved — a story holds
   * one framing for most of its length, and a transform re-written every frame
   * with the same three numbers is a compositor update per frame for nothing.
   *
   * Rounded here rather than trusted from the caller, and to the same places
   * the draw list rounds to: a scale finer than an offset, because a scale
   * multiplies every coordinate under it. It is what makes "did it move?" a
   * question about the picture instead of about the last bit of a float.
   */
  function aim(camera) {
    if (destroyed) return;
    // A framing that is not three numbers opens WIDE rather than holding what
    // was there, because that is what the canvas above does with the same input
    // (`draw-list.mjs`): the alternative is a cast drawn wide over a ground
    // still pushed in — feet off the floor, and a picture that looks fine.
    const usable = camera && Number.isFinite(camera.scale)
      && Number.isFinite(camera.x) && Number.isFinite(camera.y);
    const { scale, x, y } = usable ? camera : WIDE_CAMERA;
    const next = `translate(${round(x, 4)}%, ${round(y, 4)}%) scale(${round(scale, 6)})`;
    if (next === framing) return;
    framing = next;
    plate.style.transform = next;
  }

  function play() {
    wanted = true;
    if (!destroyed) start();
  }

  function pause() {
    wanted = false;
    if (destroyed) return;
    // The deadline goes with the request: a plate nobody is asking to play
    // cannot be late, and reporting it as late would put a media failure in the
    // log for a perfectly good scene sitting behind a pause or a begin button.
    clearDeadline();
    video.pause();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    token += 1;
    releaseScene();
    video.pause();
    video.removeAttribute?.('src');
    video.load?.();
  }

  /**
   * Ask the plate to run, and survive being told no.
   *
   * A refusal is usually an autoplay policy rather than a broken asset: the
   * browser wants a gesture first. That one is remembered rather than raised,
   * and the next touch or the next return to the tab tries again — which is
   * exactly when the policy will allow it. Any OTHER refusal is a real failure
   * and is named as one: promising "it will start on the next touch" for a
   * codec this device cannot decode is a promise the player cannot keep.
   */
  function start() {
    // Asked to play before there is a scene to play: a real `<video>` with an
    // empty source rejects with a media error, which would be reported as a
    // blocked autoplay and arm a retry for something that was never refused.
    if (!video.src) return;
    armDeadline();
    const attempt = video.play?.();
    if (!attempt?.catch) return;
    attempt.catch((error) => {
      if (destroyed || !wanted || error?.name === 'AbortError') return;
      if (error?.name === 'NotAllowedError') {
        // The deadline goes with the refusal. A plate waiting for a gesture is
        // not a late plate, and leaving it armed logs "it will start on the
        // next touch" and then, six seconds later, "it has not started" — two
        // lines about one event that contradict each other. The retry's own
        // `start()` arms a fresh one when the gesture comes.
        clearDeadline();
        warn('plate video was not allowed to start yet; it will start on the next touch');
        armRetry();
        return;
      }
      warn(`plate video would not start (${error?.name ?? 'refused'}); the poster is what the scene shows`);
    });
  }

  /**
   * The clock on "has this plate actually started?", armed by the REQUEST and
   * not by the scene: a plate is only late once somebody is waiting for it.
   */
  function armDeadline() {
    if (deadline !== null || running) return;
    const mine = token;
    deadline = setTimeout(() => {
      deadline = null;
      if (mine !== token || destroyed) return;
      warn('plate video has not started; the poster is what the scene shows');
    }, PLATE_READY_TIMEOUT_MS);
  }

  function armRetry() {
    if (retry) return;
    const again = () => {
      disarmRetry();
      if (!destroyed && wanted) start();
    };
    const target = gestureTarget ?? null;
    const document = video.ownerDocument ?? globalThis.document ?? null;
    target?.addEventListener?.('pointerdown', again, { once: true });
    document?.addEventListener?.('visibilitychange', again, { once: true });
    retry = () => {
      target?.removeEventListener?.('pointerdown', again);
      document?.removeEventListener?.('visibilitychange', again);
    };
  }

  function disarmRetry() {
    retry?.();
    retry = null;
  }

  function releaseScene() {
    clearDeadline();
    disarmRetry();
    for (const [type, handler] of listeners) video.removeEventListener(type, handler);
    listeners = [];
  }

  function listen(type, handler) {
    listeners.push([type, handler]);
    video.addEventListener(type, handler);
  }

  function clearDeadline() {
    if (deadline === null) return;
    clearTimeout(deadline);
    deadline = null;
  }

  function warn(message) {
    onWarning({ type: 'media', asset: 'plate-video', url: scene?.video ?? video.src ?? null, message });
  }
}

function cssUrl(value) {
  return String(value ?? '').replace(/["\\\n\r]/g, (character) => `\\${character}`);
}

function round(value, places) {
  const step = 10 ** places;
  return Math.round(value * step) / step;
}
