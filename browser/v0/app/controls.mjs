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
  // How long the overlay outlives the pointer that woke it, and how long the
  // mark a click leaves lives. Named so a test does not have to wait them out.
  idleMs = 2600, flashMs = 620,
} = {}) {
  const listeners = [];
  const last = { fraction: null, at: null, total: null, remaining: null, mode: null };
  let durationMs = 0;
  let dragging = false;
  let draggedToMs = null;
  let hidden = false;
  let running = false;
  // Which device is steering: the last one to say anything. A pointer that has
  // moved is a viewer who can move it again; a keyboard is a viewer whose only
  // way back to the transport is the control that has focus.
  let steering = 'pointer';
  let idleTimer = null;
  let flashOn = null;
  let flashOff = null;
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
  // On the STAGE, not the frame: the overlay is a set of the frame's other
  // children, so a click that lands on a button, the scrub, the ceremony or the
  // end card never reaches this listener at all. No blocklist to keep in step
  // with the template — the picture is simply the only thing under it.
  //
  // The picture is the play/pause switch, as it is in every video player. The
  // OVERLAY is not what a click decides: that is the pointer's business below.
  listen(elements.stage, 'click', () => {
    if (!live()) return;
    // Which glyph, decided before the toggle: the bar still shows what the
    // story was doing when the click landed.
    flash(last.mode === 'pause' ? 'pause' : 'play');
    onToggle();
  });
  // The overlay follows the pointer, not the clicks: it comes back whenever the
  // pointer moves and withdraws once the story has been left alone for a while.
  for (const type of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup']) {
    listen(elements.frame, type, () => {
      steering = 'pointer';
      wake();
    });
  }
  // A pointer that has left the player is not reaching for the transport, and
  // that holds whether the story is running or standing still: a paused story
  // with nobody over it is a picture, not a control panel.
  //
  // Except on a finger. A device with no hover fires `pointerout` and
  // `pointerleave` immediately after every `pointerup`, so obeying this on
  // touch would leave the transport visible only while a finger is held down.
  listen(elements.frame, 'pointerleave', (event) => {
    if (event?.pointerType === 'touch') return;
    if (live()) bare(true);
  });
  // Focus is the keyboard's pointer. Without this, a viewer who tabbed to the
  // transport and then read for three seconds lost it to the countdown — and
  // with it every key, because the only `keydown` listener is inside the frame
  // a blurred focus has just left.
  listen(elements.frame, 'focusin', wake);
  listen(elements.frame, 'focusout', wake);

  return { arm, show, update, destroy };

  /**
   * The length of what is published is known: the buttons mean something now.
   * Said again, longer, on every appended scene — not a one-shot initialiser,
   * and a guard that made it one would freeze the bar at the prefix's end.
   */
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
    if (elements.actions) elements.actions.hidden = false;
    wake();
  }

  /**
   * Take the overlay away, or bring it back.
   *
   * One class on the frame rather than an attribute per element: the three
   * things that go — the transport, the story's name, the toggles — are three
   * places in the template, and a rule that names them together cannot fall out
   * of step with a fourth arriving later.
   */
  function bare(next) {
    if (destroyed || next === hidden) return;
    // Nothing is taken away from a hand that is on it: a drag holds the bar it
    // is dragging, and a KEYBOARD holds whatever it is on.
    if (next && (dragging || holdsKeyboard())) return;
    // A button clicked with a mouse keeps focus without keeping attention — and
    // it is about to become `visibility: hidden`, which would drop that focus
    // out of the player entirely and take every key with it. The frame is where
    // the keys are read, so the focus goes there first.
    if (next) parkFocus();
    hidden = next;
    elements.frame?.classList?.toggle('is-bare', next);
  }

  /**
   * Is a KEYBOARD on something in here?
   *
   * Two halves, and both are needed. The shadow root answers `null` for
   * "nothing in here" — the document's own `activeElement` would only ever say
   * "the host element". And `steering` is which device put it there: clicking
   * `cc` with a mouse leaves that button focused without a keyboard being
   * anywhere near it, and read as "somebody is on this control" it kept the
   * transport on screen for the rest of the story.
   *
   * `:focus-visible` is the browser's own version of this question and would be
   * the obvious thing to ask — but it answers `true` for a plain mouse click on
   * a button in at least one engine, which is exactly the case this has to tell
   * apart. Tracked here instead, where it is one flag and cannot surprise us.
   */
  function holdsKeyboard() {
    return steering === 'keyboard' && Boolean(focused());
  }

  function focused() {
    return elements.frame?.getRootNode?.()?.activeElement ?? null;
  }

  function parkFocus() {
    if (!focused()) return;
    elements.frame?.focus?.({ preventScroll: true });
  }

  /**
   * Somebody is here: show the overlay, and start counting again.
   *
   * Only a RUNNING story is counted down. A paused one, or one at its end, is a
   * story whose viewer is looking for the transport — hiding it from them would
   * be the player deciding it knows better.
   */
  function wake() {
    if (!live()) return;
    bare(false);
    clearTimeout(idleTimer);
    idleTimer = running ? setTimeout(() => bare(true), idleMs) : null;
  }

  /**
   * The mark a click leaves in the middle of the picture.
   *
   * Put back on the next task rather than now: a class removed and re-added in
   * one go does not replay a CSS animation, so a second click inside the first
   * mark's life would leave it stuck mid-fade.
   */
  function flash(kind) {
    const mark = elements.flash;
    if (!mark?.classList) return;
    mark.classList.remove('is-on');
    mark.classList.toggle('is-pause', kind === 'pause');
    clearTimeout(flashOn);
    clearTimeout(flashOff);
    flashOn = setTimeout(() => mark.classList.add('is-on'), 0);
    flashOff = setTimeout(() => mark.classList.remove('is-on'), flashMs);
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
      // Written here rather than watched from outside: the mode is already the
      // one thing the bar is told about the story, and the overlay's countdown
      // starts and stops with it.
      running = mode === 'pause';
      wake();
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dragging = false;
    // The idle countdown and the mark's two timers outlive a torn-down player
    // otherwise, and both end in a write to elements that are already gone.
    clearTimeout(idleTimer);
    clearTimeout(flashOn);
    clearTimeout(flashOff);
    idleTimer = flashOn = flashOff = null;
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
    // A keyboard has no pointer to wake the overlay with, so any key does it —
    // before anything else, or a story could only be steered by controls
    // nobody can see or reach. It also takes the wheel: from here until a
    // pointer moves again, whatever has focus is somebody's only way around.
    steering = 'keyboard';
    wake();
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
