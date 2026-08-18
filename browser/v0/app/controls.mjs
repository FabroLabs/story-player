/**
 * The control bar's behaviour: one fraction in, three intentions out.
 *
 * It knows nothing about the clock, the media or the canvas — it is handed
 * `{ tMs, playing, ended }` on the frames the runtime draws, and it hands back
 * `toggle`, `seek` and `skip`. That is what keeps the transport honest under a
 * seek: the bar never moves itself, so what it shows is always where the story
 * actually is, not where a pointer was let go.
 *
 * Every write is guarded by what it wrote last. At twenty-four frames a second
 * an unguarded `textContent` is twenty-four style recalculations for a label
 * that changes once a second.
 */

const SKIP_MS = 10_000;

export function createControls(elements, {
  onToggle = () => {}, onSeek = () => {}, onSkip = () => {},
} = {}) {
  const listeners = [];
  const last = { fraction: null, at: null, total: null, remaining: null, mode: null };
  let durationMs = 0;
  let dragging = false;
  let draggedToMs = null;
  let destroyed = false;

  listen(elements.toggle, 'click', () => live() && onToggle());
  listen(elements.back, 'click', () => live() && onSkip(-SKIP_MS));
  listen(elements.forward, 'click', () => live() && onSkip(SKIP_MS));
  // A drag is many seeks and one landing. Every pointer position moves the
  // picture at once (`settled: false`) — that is what makes a scrub bar worth
  // dragging — but only the position the pointer is LET GO at is where the
  // story is asked to sound (`settled: true`). Placing the sound on every move
  // opened a narration element per pointer event, dozens a second, each one a
  // fetch and a decoder the next move threw away.
  listen(elements.scrub, 'pointerdown', (event) => {
    if (!live()) return;
    dragging = true;
    capture('set', event.pointerId);
    seekTo(event, false);
  });
  listen(elements.scrub, 'pointermove', (event) => {
    if (dragging && live()) seekTo(event, false);
  });
  for (const type of ['pointerup', 'pointercancel']) {
    listen(elements.scrub, type, (event) => {
      const wasDragging = dragging;
      dragging = false;
      capture('release', event.pointerId);
      if (!wasDragging || !live()) return;
      // Where the pointer is now if the browser still says, else where the last
      // move left the story: a `pointercancel` carries no useful position.
      const landed = fractionOf(event);
      if (landed !== null) draggedToMs = landed * durationMs;
      if (draggedToMs !== null) onSeek(draggedToMs, { settled: true });
      draggedToMs = null;
    });
  }
  // On the frame rather than on the ShadowRoot: the root already carries the
  // debug hotkey, and a player that installed a second listener there would
  // make "did destroy clean up?" a question with two answers.
  listen(elements.frame, 'keydown', onKeyDown);

  return { arm, show, update, destroy };

  /** The story's length is known: the buttons mean something now. */
  function arm(totalMs) {
    if (destroyed) return;
    durationMs = Number.isFinite(totalMs) && totalMs > 0 ? Math.round(totalMs) : 0;
    elements.toggle.disabled = false;
    elements.scrub.setAttribute('aria-valuemax', String(Math.round(durationMs / 1000)));
    write('total', clockText(durationMs), (text) => { elements.total.textContent = text; });
  }

  /**
   * Shown at begin, not at arm: until the ceremony is dismissed the bar would
   * sit under it, half visible through a translucent overlay, controlling a
   * story that has not started.
   */
  function show() {
    if (destroyed) return;
    elements.root.hidden = false;
  }

  function update({ tMs = 0, playing = false, ended = false } = {}) {
    if (destroyed) return;
    const clamped = Math.max(0, Math.min(durationMs || tMs, tMs));
    const fraction = durationMs > 0 ? clamped / durationMs : 0;
    // A tenth of a percent is half a pixel on a 500px bar: finer than that is a
    // style write nobody can see.
    write('fraction', Math.round(fraction * 1000) / 10, (percent) => {
      elements.fill.style.width = `${percent}%`;
      elements.handle.style.left = `${percent}%`;
      elements.scrub.setAttribute('aria-valuenow', String(Math.round(clamped / 1000)));
      elements.scrub.setAttribute('aria-valuetext', `${clockText(clamped)} of ${clockText(durationMs)}`);
    });
    write('at', clockText(clamped), (text) => { elements.at.textContent = text; });
    write('remaining', remainingText(durationMs - clamped), (text) => {
      elements.remaining.textContent = text;
    });
    write('mode', ended ? 'replay' : playing ? 'pause' : 'play', (mode) => {
      elements.toggle.setAttribute('aria-label', mode);
      elements.toggle.classList.toggle('is-playing', mode === 'pause');
      elements.toggle.classList.toggle('is-replay', mode === 'replay');
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dragging = false;
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    listeners.length = 0;
  }

  /**
   * Live only once the bar is on screen — which is once the story has begun.
   *
   * The listener sits on the stage frame, and the begin ceremony is inside that
   * frame: without this, space on the focused "begin story" button reached the
   * transport, `preventDefault` swallowed the button's own activation, and the
   * story ran behind an overlay that still said "ready when you are" — picture
   * and subtitles, no sound, nothing in the log.
   */
  function live() {
    return !destroyed && elements.root.hidden !== true;
  }

  function onKeyDown(event) {
    if (!live() || isTyping(event.target)) return;
    const key = event.key;
    // Space and Enter belong to whatever button has focus — `cc`, `log`, the
    // transport itself. Swallowing them here (and calling `preventDefault`)
    // would leave a keyboard user unable to press any of them.
    if (isActivatable(event.target) && (key === ' ' || key === 'Spacebar' || key === 'Enter')) return;
    if (key === ' ' || key === 'Spacebar' || key === 'k') {
      event.preventDefault?.();
      onToggle();
    } else if (key === 'ArrowRight') {
      event.preventDefault?.();
      onSkip(SKIP_MS);
    } else if (key === 'ArrowLeft') {
      event.preventDefault?.();
      onSkip(-SKIP_MS);
    } else if (key === 'Home') {
      event.preventDefault?.();
      onSeek(0);
    } else if (key === 'End') {
      event.preventDefault?.();
      onSeek(durationMs);
    }
  }

  /**
   * Where along the bar the pointer is, as an instant.
   *
   * A bar with no width yet — measured before its first layout — would make
   * every fraction Infinity or NaN, so it seeks nowhere instead.
   */
  function seekTo(event, settled = true) {
    const fraction = fractionOf(event);
    if (fraction === null) return;
    const milliseconds = fraction * durationMs;
    if (!settled) draggedToMs = milliseconds;
    onSeek(milliseconds, { settled });
  }

  function fractionOf(event) {
    const box = elements.scrub.getBoundingClientRect?.();
    if (!box || !(box.width > 0) || !Number.isFinite(event?.clientX)) return null;
    return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
  }

  /**
   * Capture is a nicety — it keeps a drag following the pointer once it leaves
   * the bar — and it throws for a pointer the browser no longer considers
   * active. Thrown out of the `pointerdown` handler it would take the seek with
   * it, which is the one thing on this bar that is not optional.
   */
  function capture(action, pointerId) {
    try {
      if (action === 'set') elements.scrub.setPointerCapture?.(pointerId);
      else elements.scrub.releasePointerCapture?.(pointerId);
    } catch { /* the drag simply stops following a pointer that left the bar */ }
  }

  function write(key, value, apply) {
    if (last[key] === value) return;
    last[key] = value;
    apply(value);
  }

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }
}

function clockText(milliseconds) {
  const total = Math.max(0, Math.round((milliseconds ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * How much story is left, in the words a parent uses at bedtime.
 *
 * Rounded UP to the minute: "1 min left" with fifty seconds to go is a promise
 * the story keeps, and "0 min left" is not a sentence anybody wants to read.
 */
function remainingText(milliseconds) {
  const left = Math.max(0, milliseconds ?? 0);
  if (left < 60_000) return `${Math.ceil(left / 1000)} s left`;
  return `${Math.ceil(left / 60_000)} min left`;
}

function isActivatable(target) {
  const tag = (target?.tagName ?? target?.tag ?? '').toLowerCase();
  return tag === 'button' || tag === 'a' || tag === 'summary';
}

function isTyping(target) {
  return target?.tagName === 'INPUT'
    || target?.tagName === 'TEXTAREA'
    || target?.tag === 'input'
    || target?.tag === 'textarea'
    || target?.isContentEditable === true;
}
