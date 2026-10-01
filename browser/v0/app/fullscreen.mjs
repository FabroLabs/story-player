/**
 * The full-screen button: the host's way to fill the screen, or the browser's.
 *
 * An app running this player in a webview fills the screen by turning the
 * phone, which only the app can do — so a host that passes `fullscreen` is
 * asked, `true` or `false`, and says what actually happened through the
 * handle's `setFullscreen`, which is also how it reports a phone turned by
 * hand. Without one, the browser's own fullscreen on the element the player was
 * mounted into, and a landscape lock on top: on a phone that is what the button
 * means, and a browser that cannot lock (a laptop) refuses it harmlessly. A
 * browser with neither — iPhone Safari has no element fullscreen — gets no
 * button at all: a control that does nothing is worse than its absence.
 */

const CHANGES = ['fullscreenchange', 'webkitfullscreenchange'];

export function createFullscreen({ button, target, request = null }) {
  const document = target?.ownerDocument ?? globalThis.document;
  const native = !request && canFill(target, document);
  let active = false;
  let destroyed = false;
  const onClick = () => {
    if (request) request(!active);
    else if (active) leave();
    else enter();
  };
  const onChange = () => set(filling(document) === target);
  button.hidden = !request && !native;
  button.addEventListener('click', onClick);
  if (native) for (const type of CHANGES) document.addEventListener(type, onChange);
  set(native && filling(document) === target);
  return { set, destroy };

  /** What the screen is doing now, whoever changed it. */
  function set(next) {
    if (destroyed) return;
    active = next === true;
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'exit full screen' : 'full screen');
  }

  function enter() {
    const fill = target.requestFullscreen ?? target.webkitRequestFullscreen;
    // Refused — no gesture, a policy, a frame without `allowfullscreen` — is a
    // button that did nothing, which the unchanged mark already says.
    Promise.resolve(fill.call(target, { navigationUI: 'hide' }))
      .then(() => globalThis.screen?.orientation?.lock?.('landscape'))
      .catch(() => {});
  }

  function leave() {
    try { globalThis.screen?.orientation?.unlock?.(); } catch { /* nothing was locked */ }
    const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
    Promise.resolve(exit?.call(document)).catch(() => {});
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    button.removeEventListener('click', onClick);
    if (!native) return;
    for (const type of CHANGES) document.removeEventListener(type, onChange);
    // A story taken down mid-fullscreen must not leave the page filling the
    // screen with an empty box.
    if (filling(document) === target) leave();
  }
}

function canFill(target, document) {
  const enabled = document?.fullscreenEnabled ?? document?.webkitFullscreenEnabled;
  return Boolean(enabled) && typeof (target?.requestFullscreen ?? target?.webkitRequestFullscreen) === 'function';
}

function filling(document) {
  return document?.fullscreenElement ?? document?.webkitFullscreenElement ?? null;
}
