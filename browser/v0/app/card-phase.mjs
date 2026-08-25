/**
 * The two performances either side of the story: the intro card and the end
 * card.
 *
 * Neither is IN the story. The compiled timeline is the story's own, `t` covers
 * it and nothing else, and a scrub bar that could be dragged into a title
 * sequence would be dragging through time the schedule does not have. So a card
 * is a PHASE rather than a stretch of the timeline: its own `<video>` is the
 * clock, the music is slaved to it, and the runtime is not begun until the
 * curtain falls. `main.mjs` is where the two are sequenced.
 *
 * The card mp4s carry no sound of their own — the music is a separate track the
 * story's writer chose — so the video plays MUTED and no autoplay policy has an
 * opinion about it. The music is not muted, and it starts inside the click that
 * dismissed the ceremony, which is the one gesture the media can spend.
 *
 * Nothing here holds the story up, and that is the law this file is written
 * around: a card whose film fails, is refused, never starts, or stops moving
 * mid-play ends the phase with a named warning, and the promise a card hands
 * back always settles — a story waiting on one that never resolved would be a
 * child looking at a still frame with a clean log beside it.
 */

// The card's own numbers. Deliberately NOT in `V0_POLICY`: that surface is the
// contract between the timeline compiler and every client that interprets it,
// and a card is played by this player alone — the phone client is handed the
// same manifest blocks and will time its own. Nothing here reaches the schedule.
export const CARD_MUSIC_VOLUME = 0.6;
// A quarter of the level above, which is what "ducked" means for the story's
// music too — loud enough to stay under the line, quiet enough to be under it.
export const CARD_DUCKED_MUSIC_VOLUME = 0.15;
// How far into the card the story's name is spoken. The cards open on movement
// rather than on a held frame, and a title read over the very first of it lands
// before a viewer has settled into the picture.
export const CARD_LINE_DELAY_MS = 1_000;
// The curtain: how long the card stays on screen once the phase is over, fading
// over the story that has already started behind it. Matches the transition in
// `styles.css` — a shorter timer here would cut the fade, a longer one would
// leave a transparent layer taking clicks.
export const CARD_CURTAIN_MS = 700;
// How long a card may be unresponsive before the story stops waiting for it:
// one that has not put a frame on screen, one that stopped moving mid-play, and
// a spoken line that never arrived to be made room for. The same bound the
// plate holds itself to, for the same reason — a slow link is not a failure,
// and a story stopped forever in front of one is.
export const CARD_READY_TIMEOUT_MS = 6_000;

export function createCardPhase({ elements, cards, onWarning = () => {} }) {
  const { layer, video, line, skip } = elements;
  const intro = cards?.intro ?? null;
  const endCard = cards?.end_card ?? null;
  const document = video.ownerDocument ?? globalThis.document ?? null;
  let active = null;
  let curtain = null;
  // One `<video>`, used twice and never at once, so the films are warmed in the
  // order they are played: the end card may not take the element until the
  // opening has had it, or a story that opens on scene 0 — which is also its
  // last — would fetch its closing film over its opening one.
  let openingOver = !intro;
  let wantedEnd = null;
  // Paused because the tab went away. A card is not on the story's clock, so
  // nothing else would stop it: the picture would freeze where the browser left
  // it while the music played on in a pocket.
  let held = false;
  let destroyed = false;

  video.muted = true;
  const onSkip = () => close(active, { curtain: true });
  const onVisibility = () => {
    if (destroyed || !active) return;
    if (document?.visibilityState === 'hidden') holdCard(active);
    else resumeCard(active);
  };
  skip.addEventListener('click', onSkip);
  document?.addEventListener?.('visibilitychange', onVisibility);

  return {
    hasIntro: Boolean(intro),
    hasEnd: Boolean(endCard),
    /**
     * Start the fetch before anybody is waiting on it.
     *
     * The intro is warmed while the opening scene is being decoded, so the click
     * that dismisses the ceremony finds a file already on its way; the end card
     * is asked for as the last scene opens, which is late enough not to compete
     * with the scenes the viewer is watching and early enough to be there. What
     * it is asked for is remembered rather than done, because the element it
     * would take may still be showing the opening.
     */
    warmIntro: () => warmFilm(intro?.video),
    warmEnd() {
      wantedEnd = endCard?.video ?? null;
      flushEnd();
    },
    playIntro: () => play(intro, 'intro'),
    playEnd: () => play(endCard, 'end'),
    /** Take the card away NOW: a replay, a scrub out of the end, a teardown. */
    cancel: () => close(active, { curtain: false }),
    destroy,
  };

  function play(card, kind) {
    if (destroyed || !card) return Promise.resolve();
    close(active, { curtain: false });
    clearCurtain();
    return new Promise((resolve) => {
      const phase = {
        kind, resolve, closed: false, started: false, spoke: false, spoken: false,
        film: card.video, narration: card.narration ?? null,
        media: [], timers: [], listeners: [], named: new Set(), music: null,
        held: [], stall: null,
      };
      active = phase;
      held = false;
      layer.classList.remove('is-gone');
      layer.hidden = false;
      line.textContent = '';
      skip.setAttribute('aria-label', kind === 'intro' ? 'skip the opening' : 'skip to the end');
      // Everything below is one synchronous stretch inside a promise executor,
      // and a throw in it would reject the phase — which is awaited bare by the
      // two calls that gate the story, and would leave the viewer behind an
      // opaque layer with nothing in the log. It cannot be allowed to escape.
      try {
        startVideo(phase, card.video);
        startMusic(phase, card.music);
      } catch (error) {
        warn(phase, card.video, `the card could not be started (${error?.message ?? String(error)})`);
        close(phase, { curtain: false });
      }
    });
  }

  /**
   * The card's picture, and the clock every other part of the phase is on.
   *
   * `playing` — the first frame actually on screen — is what arms the spoken
   * line, so the story's name is read over a card the viewer can see rather
   * than over a rectangle that is still arriving. It is also what calls off the
   * two watchdogs: one for a film that never starts, one for a film that starts
   * and then stops, neither of which any event would otherwise end.
   */
  function startVideo(phase, url) {
    listen(phase, 'playing', () => {
      phase.started = true;
      clearStall(phase);
      if (phase.narration) speak(phase, phase.narration);
    });
    listen(phase, 'ended', () => close(phase, { curtain: true }));
    listen(phase, 'error', () => {
      warn(phase, url, 'card video could not be played');
      close(phase, { curtain: false });
    });
    // A medium that is fetching and getting nothing neither rejects `play()`
    // nor fires `error`: it fires these. Without them a film that buffered out
    // three seconds in held the story behind a frozen frame for ever.
    for (const type of ['stalled', 'waiting']) {
      listen(phase, type, () => waitOut(phase, url));
    }
    if (video.src !== url) {
      video.src = url;
      video.load?.();
    } else {
      // A replay opens the file this mount already played: it is sitting on its
      // own last frame, and asking for it again from there is one still picture.
      try {
        video.currentTime = 0;
      } catch { /* a source that will not seek plays from where it stands */ }
    }
    timer(phase, CARD_READY_TIMEOUT_MS, () => {
      if (phase.started) return;
      warn(phase, url, 'card video did not start');
      close(phase, { curtain: false });
    });
    playFilm(phase, url);
  }

  /**
   * Ask the film to run, and survive being told no in either of the two ways a
   * browser says it — a rejected promise, or a throw from `play()` itself.
   */
  function playFilm(phase, url) {
    const refused = (error) => {
      // `AbortError` is what a browser rejects the pending `play()` of a medium
      // THIS file paused with — every skip, every hidden tab, every teardown —
      // and reporting it would name the player for doing what it was asked.
      if (destroyed || phase.closed || error?.name === 'AbortError') return;
      warn(phase, url, `card video would not start (${error?.name ?? 'refused'})`);
      close(phase, { curtain: false });
    };
    try {
      const attempt = video.play?.();
      if (attempt?.catch) attempt.catch(refused);
    } catch (error) {
      refused(error);
    }
  }

  /**
   * The film stopped moving. Named once, then given the same patience a film
   * that never started gets — and called off by the `playing` that a card which
   * merely buffered will fire on its way back.
   */
  function waitOut(phase, url) {
    if (phase.closed) return;
    warn(phase, url, 'card video stalled');
    if (phase.stall !== null) return;
    phase.stall = setTimeout(() => {
      phase.stall = null;
      close(phase, { curtain: true });
    }, CARD_READY_TIMEOUT_MS);
    phase.timers.push(phase.stall);
  }

  function clearStall(phase) {
    if (phase.stall === null) return;
    clearTimeout(phase.stall);
    phase.stall = null;
  }

  function startMusic(phase, url) {
    if (!url) return;
    const media = open(phase, url);
    media.loop = true;
    media.volume = CARD_MUSIC_VOLUME;
    phase.music = media;
    media.addEventListener('error', () => warn(phase, url, 'card music could not be played'), { once: true });
    media.addEventListener('stalled', () => warn(phase, url, 'card music stalled before it was heard'), { once: true });
    request(phase, media, url, 'card music would not start');
  }

  /**
   * The story's name, read over the card.
   *
   * Written as well as spoken: the cards are one film per world, shared by every
   * story told in it, so the picture carries no title of its own — and a name
   * only a listener gets is a name half the audience never hears.
   *
   * The music makes room for the line the moment it is asked for rather than
   * when it is heard, so the first word is never spoken over a full track — and
   * every way the line can fail to arrive hands that room back, because a card
   * playing near-silently under a voice that never comes is the worse failure.
   */
  function speak(phase, narration) {
    if (phase.spoke) return;
    phase.spoke = true;
    timer(phase, CARD_LINE_DELAY_MS, () => {
      if (destroyed || phase.closed) return;
      line.textContent = narration.text;
      // A story built without a voice still has its title on screen, and the
      // music has nothing to make room for.
      if (!narration.audio) return;
      const media = open(phase, narration.audio);
      duck(phase, true);
      media.addEventListener('playing', () => { phase.spoken = true; }, { once: true });
      media.addEventListener('ended', () => duck(phase, false), { once: true });
      media.addEventListener('error', () => {
        warn(phase, narration.audio, 'the spoken title could not be played');
        duck(phase, false);
      }, { once: true });
      media.addEventListener('stalled', () => warn(phase, narration.audio, 'the spoken title stalled'), { once: true });
      request(phase, media, narration.audio, 'the spoken title would not start', () => duck(phase, false));
      // A line that was neither refused nor broken and simply never arrived —
      // a file still fetching into silence. There is no clock here to end it
      // the way the story's own scheduler ends a line, so this is the bound.
      timer(phase, CARD_READY_TIMEOUT_MS, () => {
        if (phase.spoken) return;
        duck(phase, false);
      });
    });
  }

  function duck(phase, under) {
    if (!phase.music || phase.closed) return;
    // One step rather than a fade. The story's music fades because it is crossed
    // on a clock that can be paused and seeked; a card has neither, and the two
    // instants this happens at — the first word and the silence after the last —
    // are both moments the ear is already meeting something new.
    phase.music.volume = under ? CARD_DUCKED_MUSIC_VOLUME : CARD_MUSIC_VOLUME;
  }

  /** The tab went away: the picture and the music stop together, or not at all. */
  function holdCard(phase) {
    if (held) return;
    held = true;
    phase.held = phase.media.filter(({ media }) => media.paused === false);
    video.pause?.();
    for (const { media } of phase.held) media.pause?.();
  }

  function resumeCard(phase) {
    if (!held) return;
    held = false;
    for (const { media, url } of phase.held) request(phase, media, url, 'card audio would not resume');
    phase.held = [];
    playFilm(phase, phase.film);
  }

  /**
   * The phase is over, however it ended.
   *
   * `curtain` is the difference between an ending and a cancellation: a card
   * that played out, was skipped, or gave up on a film that stopped moving hands
   * the stage over behind a fade, while one taken away by a replay, a teardown
   * or a broken file goes at once — there is nothing behind it worth fading.
   */
  function close(phase, { curtain: draw }) {
    if (!phase || phase.closed || phase !== active) return;
    phase.closed = true;
    active = null;
    held = false;
    if (phase.kind === 'intro') openingOver = true;
    release(phase);
    if (draw) drawCurtain();
    else hideLayer();
    phase.resolve();
  }

  function drawCurtain() {
    layer.classList.add('is-gone');
    clearCurtain();
    curtain = setTimeout(hideLayer, CARD_CURTAIN_MS);
  }

  function hideLayer() {
    clearCurtain();
    layer.hidden = true;
    layer.classList.remove('is-gone');
    line.textContent = '';
    video.pause?.();
    // The element is free: whatever was asked for while it was the picture can
    // have it now.
    flushEnd();
  }

  function clearCurtain() {
    if (curtain === null) return;
    clearTimeout(curtain);
    curtain = null;
  }

  function flushEnd() {
    if (!openingOver) return;
    warmFilm(wantedEnd);
  }

  /**
   * The file, opened early — but never onto an element the viewer can see.
   *
   * While a card is up, playing or fading out over the story, the `<video>` IS
   * the picture: swapping its source there blanks a frame somebody is looking
   * at, and turns the curtain into a cut to black.
   */
  function warmFilm(url) {
    if (destroyed || !url || active || curtain !== null || video.src === url) return;
    video.src = url;
    video.load?.();
  }

  function open(phase, url) {
    const media = new globalThis.Audio(url);
    media.preload = 'auto';
    phase.media.push({ media, url });
    return media;
  }

  function request(phase, media, url, message, onRefusal = () => {}) {
    const refused = (error) => {
      if (destroyed || phase.closed || error?.name === 'AbortError') return;
      warn(phase, url, message);
      onRefusal();
    };
    try {
      const attempt = media.play?.();
      if (attempt?.catch) attempt.catch(refused);
    } catch (error) {
      refused(error);
    }
  }

  function release(phase) {
    clearStall(phase);
    for (const id of phase.timers) clearTimeout(id);
    phase.timers = [];
    for (const [type, handler] of phase.listeners) video.removeEventListener(type, handler);
    phase.listeners = [];
    for (const { media } of phase.media) {
      media.pause?.();
      media.removeAttribute?.('src');
    }
    phase.media = [];
    phase.held = [];
    phase.music = null;
  }

  function listen(phase, type, handler) {
    phase.listeners.push([type, handler]);
    video.addEventListener(type, handler);
  }

  function timer(phase, milliseconds, handler) {
    phase.timers.push(setTimeout(handler, milliseconds));
  }

  /** One line per file, whatever else goes wrong with it afterwards. */
  function warn(phase, url, message) {
    if (phase.named.has(url)) return;
    phase.named.add(url);
    onWarning({ type: 'media', asset: `${phase.kind}-card`, url, message });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    close(active, { curtain: false });
    hideLayer();
    skip.removeEventListener('click', onSkip);
    document?.removeEventListener?.('visibilitychange', onVisibility);
    video.pause?.();
    video.removeAttribute?.('src');
    // Removing the attribute alone does not reliably stop the fetch: the
    // resource selection algorithm has to be re-run, which is what this does.
    video.load?.();
  }
}
