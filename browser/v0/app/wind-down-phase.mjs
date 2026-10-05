/**
 * The moonlit wind-down after a bedtime story, as a phase of its own.
 *
 * Like the end card (`card-phase.mjs`), it is never on the story's clock: the
 * narrative ends where it ends, and this begins there. The sky picture comes
 * up over its base colour while the same ambience bed plays on from where the
 * narrative left it, the dock counts it down with Stop, and when it runs out,
 * or is stopped, the sky stays and the sound does not:
 *
 *   null        the story is on screen
 *   'winddown'  the sky is up and the ambience plays on
 *   'quiet'     stopped, or run out: silence, and the sky stays
 *
 * A seek back into the story takes all of it away (`leave`), and play from the
 * quiet is a replay — the runtime's own, from zero.
 */

import { secondsLeft, skyOpacity, windDownOver, windDownSeconds } from './wind-down.mjs';

export function createWindDownPhase({ elements, post, resolve, onChange = () => {} }) {
  const document = elements.frame?.ownerDocument ?? globalThis.document;
  const audio = new Audio();
  // A second element for the same bed the story was playing: the story's own
  // has been settled at its end. It is opened by the begin gesture (`prime`),
  // not by a download competing with the opening at mount.
  audio.preload = 'none';
  audio.src = resolve(post.ambience.media);
  audio.volume = post.ambience.volume;
  elements.picture.src = resolve(post.skyMedia);
  elements.sky.style.backgroundColor = post.baseColor;
  elements.shade.style.backgroundColor = post.dimColor;
  elements.shade.style.opacity = String(post.dimOpacity);
  const total = windDownSeconds(post);
  let phase = null;
  let primed = false;
  let frame = null;
  let left = null;
  let settle = null;
  let destroyed = false;

  audio.addEventListener('playing', () => sounding(true));
  audio.addEventListener('pause', () => sounding(false));
  audio.addEventListener('ended', () => {
    if (phase === 'winddown') quiet('Sleep well');
  });
  audio.addEventListener('error', fail);
  elements.stop.addEventListener('click', stop);
  document?.addEventListener?.('visibilitychange', hidden);

  return { prime, begin, toggle, stop, leave, pause, destroy, phase: () => phase };

  /**
   * The begin gesture, spent on this element too: a phone lets a medium start
   * by itself later only if a tap has started it once. Played silent and
   * parked, so the wind-down can begin on its own when the story ends.
   */
  function prime() {
    if (primed || destroyed) return;
    primed = true;
    audio.muted = true;
    Promise.resolve(audio.play())
      .then(() => { if (phase !== 'winddown') audio.pause(); }, () => {})
      .finally(() => { audio.muted = false; });
  }

  /**
   * The story has stopped at its end. The returned promise settles only if the
   * wind-down cannot be played, which is when the runtime shows its own end
   * screen instead: a played wind-down ends on the quiet sky, never on "the end".
   */
  function begin({ playing = true } = {}) {
    if (destroyed) return null;
    set('winddown');
    elements.sky.hidden = false;
    elements.layer.style.opacity = String(skyOpacity(post, post.ambience.fromMs / 1000));
    audio.currentTime = post.ambience.fromMs / 1000;
    showLeft(secondsLeft(post, audio.currentTime));
    elements.toggle.setAttribute('aria-label', playing ? 'pause' : 'resume');
    if (playing) play();
    tick();
    return new Promise((resolve) => { settle = resolve; });
  }

  /** Play or pause what is sounding: claimed only while the wind-down is. */
  function toggle() {
    if (phase !== 'winddown') return false;
    if (audio.paused) play();
    else audio.pause();
    return true;
  }

  function pause() {
    if (phase === 'winddown') audio.pause();
  }

  /** Silence at once; the sky stays. */
  function stop() {
    if (phase === 'winddown') quiet('Stopped');
  }

  /** Back into the story: the sky, the sound and the readout go with it. */
  function leave() {
    if (phase === null) return;
    audio.pause();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    settle = null;
    elements.sky.hidden = true;
    set(null);
  }

  function quiet(word) {
    audio.pause();
    elements.chip.textContent = word;
    elements.toggle.setAttribute('aria-label', 'replay');
    if (word === 'Sleep well') showLeft(0);
    set('quiet');
  }

  function play() {
    Promise.resolve(audio.play()).catch((error) => {
      // Interrupted by our own pause, or no gesture to start from: the
      // wind-down waits, paused, for the toggle.
      if (error?.name !== 'AbortError' && error?.name !== 'NotAllowedError') fail();
    });
  }

  /**
   * A wind-down that cannot sound is not played silently: the runtime's own
   * end screen is what a story that cannot go on shows.
   */
  function fail() {
    if (destroyed || phase !== 'winddown') return;
    const settled = settle;
    leave();
    settled?.();
  }

  /** One frame: the sky comes up, the readout counts down, and the end is noticed. */
  function tick() {
    frame = null;
    if (destroyed || phase !== 'winddown') return;
    const seconds = audio.currentTime;
    elements.layer.style.opacity = String(skyOpacity(post, seconds));
    showLeft(secondsLeft(post, seconds));
    if (windDownOver(post, seconds, audio.paused)) {
      quiet('Sleep well');
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function showLeft(seconds) {
    if (seconds === left) return;
    left = seconds;
    const done = total > 0 ? Math.min(100, Math.max(0, (1 - seconds / total) * 100)) : 100;
    elements.fill.style.width = `${done}%`;
    elements.line.setAttribute('aria-valuenow', String(Math.round(done)));
    elements.times.textContent = `Wind-down · ${clockText(seconds)} left`;
  }

  function sounding(on) {
    if (phase !== 'winddown') return;
    elements.frame.classList.toggle('is-sounding', on);
    elements.toggle.setAttribute('aria-label', on ? 'pause' : 'resume');
  }

  function set(next) {
    if (next === phase) return;
    phase = next;
    elements.frame.classList.toggle('is-wind-down', next === 'winddown');
    elements.frame.classList.toggle('is-quiet', next === 'quiet');
    if (next !== 'winddown') elements.frame.classList.remove('is-sounding');
    onChange(next);
  }

  // A hidden page is a paused story, and its wind-down with it.
  function hidden() {
    if (document?.visibilityState === 'hidden') pause();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    leave();
    elements.stop.removeEventListener('click', stop);
    document?.removeEventListener?.('visibilitychange', hidden);
    audio.pause();
    audio.removeAttribute('src');
    audio.load?.();
  }
}

function clockText(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
