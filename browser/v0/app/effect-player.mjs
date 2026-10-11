/**
 * Sound effects, played from memory through one audio context.
 *
 * An effect used to be an `<audio>` of its own, opened at its cue. A story with two hundred of
 * them asks a phone's browser for a new media player every second, and the players it cannot
 * make in time are the narration's: lines start late, lose their last words, or are never heard.
 * A decoded effect (`effect-store.mjs`) costs none of that — one buffer, as many plays as the
 * story has cues for it.
 *
 * The context is made for the first decode — at the gate, so the opening's effects are in memory
 * before the story begins — and woken by `unlock`, on the gesture that begins it. It is trusted
 * with the effects only once it has been seen running: where there is no web audio, or a browser
 * will not start it, `usable` stays false and every effect is an element as before.
 */
export function createEffectPlayer({ globalObject = globalThis } = {}) {
  const Context = globalObject.AudioContext ?? globalObject.webkitAudioContext;
  const sounding = new Set();
  let context = null;
  let ran = false;
  let destroyed = false;

  return { unlock, canDecode, usable, decode, play, stopAll, hold, resume, destroy };

  /** Spend the viewer's gesture on the context. Safe to call again: there is only ever one. */
  function unlock() {
    open();
    wake();
  }

  /** Whether effects can be decoded here at all: with no web audio, none is. */
  function canDecode() {
    return !destroyed && typeof Context === 'function';
  }

  function open() {
    if (context || !canDecode()) return;
    try {
      context = new Context();
    } catch { /* a browser that refuses a context plays effects from elements */ }
  }

  /**
   * Effects may be played here. True from the first time the context is seen running and through
   * every hold after it: a hold suspends the context, and what is started while it comes back
   * sounds the moment it does.
   */
  function usable() {
    notice();
    return ran && !destroyed;
  }

  /** Bytes to a buffer. Older WebKit takes callbacks and returns nothing. */
  function decode(bytes) {
    open();
    if (!context) return Promise.reject(new Error('no audio context to decode with'));
    return new Promise((resolve, reject) => {
      const answer = context.decodeAudioData(bytes, resolve, reject);
      answer?.then?.(resolve, reject);
    });
  }

  function play(buffer, volume = 1) {
    if (!usable()) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(context.destination);
    const voice = { source, gain };
    source.onended = () => letGo(voice);
    sounding.add(voice);
    source.start();
  }

  function stopAll() {
    for (const voice of [...sounding]) {
      voice.source.onended = null;
      // A source that has already run out throws when it is stopped again.
      try { voice.source.stop(); } catch { /* it had stopped by itself */ }
      letGo(voice);
    }
  }

  /** The story holds: effects stop where they are and go on with it. */
  function hold() {
    settled(() => context?.suspend?.());
  }

  function resume() {
    wake();
  }

  function destroy() {
    if (destroyed) return;
    stopAll();
    destroyed = true;
    settled(() => context?.close?.());
  }

  function wake() {
    if (!context || destroyed) return;
    settled(() => context.resume?.(), notice);
    notice();
  }

  function notice() {
    if (context?.state === 'running') ran = true;
  }

  function letGo(voice) {
    if (!sounding.delete(voice)) return;
    voice.source.disconnect?.();
    voice.gain.disconnect?.();
  }
}

/** Ask the context for something it answers with a promise, or throws at, and mind neither. */
function settled(ask, then = () => {}) {
  try {
    Promise.resolve(ask()).then(then, () => {});
  } catch { /* a context that refuses is a context `usable` already answers for */ }
}
