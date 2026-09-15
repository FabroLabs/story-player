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
 * The intro's ending is a beat rather than a stop: its last frame is held, and
 * where the manifest says who the story is about, the name and the lead are
 * raised over that held frame by `card-title.mjs` — on a layer of its own, so
 * they outlive the curtain this file draws.
 *
 * Nothing here holds the story up, and that is the law this file is written
 * around: a card whose film fails, is refused, never starts, or stops moving
 * mid-play ends the phase with a named warning, and the promise a card hands
 * back always settles — a story waiting on one that never resolved would be a
 * child looking at a still frame with a clean log beside it.
 */

import {
  CARD_TITLE_HOLD_CEILING_MS, CARD_TITLE_HOLD_MS, CARD_TITLE_TAIL_MS,
} from './card-title.mjs';

// The card's own numbers. Deliberately NOT in `V0_POLICY`: that surface is the
// contract between the timeline compiler and every client that interprets it,
// and a card is played by this player alone — the phone client is handed the
// same manifest blocks and will time its own. Nothing here reaches the schedule.
export const CARD_MUSIC_VOLUME = 0.6;
// A quarter of the level above, which is what "ducked" means for the story's
// music too — loud enough to stay under the line, quiet enough to be under it.
export const CARD_DUCKED_MUSIC_VOLUME = 0.15;
// How far into the card the story's name is spoken, on a card that has no
// title beat to save it for — every story published before the manifest said
// who its lead was. A card that DOES name one shows nothing here: the name
// waits for the held last frame, which is `CARD_TITLE_HOLD_MS`.
export const CARD_LINE_DELAY_MS = 1_000;
// The hold. A film that has just stopped is not the same as a film that is
// over: cut on the frame the last motion landed on and an ending reads as a
// dropped connection. The last frame stays on screen, with the music still
// playing, for long enough to be a held beat rather than a stutter. A card with
// a title to raise over that frame holds longer — `CARD_TITLE_HOLD_MS`.
export const CARD_HOLD_MS = 1_200;
// The black a card arrives through, on each side of it: whatever was on screen
// goes under black over this, and the film comes up out of the black over the
// same again. Matches the transitions in `styles.css` — pinned, like the
// curtain, and for the same reason.
export const CARD_REVEAL_MS = 250;
// The curtain, whole: the film going under the layer's own ink over
// `CARD_REVEAL_MS`, then the ink going out onto the story over what is left.
// The arrival run backwards — a card that dissolved straight into scene one
// reads as a blur rather than an ending, two lit forests crossing over.
// Matches the transitions in `styles.css` — a shorter timer here would cut the
// fade, a longer one would leave a transparent layer taking clicks.
export const CARD_CURTAIN_MS = 700;

/** The second half of the curtain: the black going out onto the story. */
export const CARD_CURTAIN_OUT_MS = CARD_CURTAIN_MS - CARD_REVEAL_MS;

// The step of the music's fade. An `<audio>` element has no ramp of its own and
// a card has no clock to hang a WebAudio graph off, so the slope is drawn by
// hand: short enough steps that the ear hears one fall rather than a staircase.
export const CARD_MUSIC_FADE_STEP_MS = 60;
// How long a card may be unresponsive before the story stops waiting for it:
// one that has not put a frame on screen, one that stopped moving mid-play, and
// a spoken line that never arrived to be made room for. The same bound the
// plate holds itself to, for the same reason — a slow link is not a failure,
// and a story stopped forever in front of one is.
export const CARD_READY_TIMEOUT_MS = 6_000;

export function createCardPhase({ elements, cards, title = null, onWarning = () => {} }) {
  const { layer, video, line, skip } = elements;
  const intro = cards?.intro ?? null;
  const endCard = cards?.end_card ?? null;
  const document = video.ownerDocument ?? globalThis.document ?? null;
  let active = null;
  let curtain = null;
  // The end card's music, going quiet under a frame that is staying put.
  let quiet = null;
  // The black beat inside the curtain: the film is down, the ink is not yet.
  let blackout = null;
  // One `<video>`, used twice and never at once, so the films are warmed in the
  // order they are played: the end card may not take the element until the
  // opening has had it, or a story that opens on scene 0 — which is also its
  // last — would fetch its closing film over its opening one.
  let openingOver = !intro;
  let wantedEnd = null;
  // The phase whose curtain is falling, and the two things falling with it: the
  // music being ramped down inside the fade, and the promise the story is
  // waiting on. All three end together, wherever the curtain ends.
  let pending = null;
  let lingering = null;
  let fade = null;
  // Paused because the tab went away. A card is not on the story's clock, so
  // nothing else would stop it: the picture would freeze where the browser left
  // it while the music played on in a pocket.
  let held = false;
  let destroyed = false;

  video.muted = true;
  const onSkip = () => close(active, { curtain: true });
  const onVisibility = () => {
    if (destroyed) return;
    const away = document?.visibilityState === 'hidden';
    if (active) {
      if (away) holdCard(active);
      else resumeCard(active);
      return;
    }
    // A curtain has no phase left behind it to hold, and a hidden tab clamps
    // both its timer and the fade's steps to something far longer than either:
    // the music would play on in a pocket and then be cut rather than faded,
    // which is the failure this whole handler exists to prevent. A fade nobody
    // can watch is a fade that is over.
    if (away && curtain !== null) hideLayer();
    // The end card's frame is staying either way — it is the end screen's
    // backdrop, not a fade. What cannot wait is the music: a hidden tab clamps
    // its steps into something far longer than the fade, and it would be cut
    // rather than faded. A fade nobody can hear is a fade that is over.
    if (away && quiet !== null) { stopQuiet(); dropMusic(); }
    // The title's own fade is started by the curtain and outlives the phase by
    // the rest of it, so nothing above reaches it — and the story underneath
    // pauses with the tab. A fade left running in the dark is a viewer coming
    // back to their story already begun with nothing over it.
    if (away) title?.freeze();
    else title?.thaw();
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
    cancel() {
      close(active, { curtain: false });
      // NOW includes a card that is already fading, and the end card's held
      // frame standing as the end screen's backdrop. Its music outlives the
      // phase by the length of the curtain, and a viewer who has just scrubbed
      // back into the story would otherwise hear the end card playing over it —
      // and watch it over the scene they scrubbed to.
      if (curtain !== null || layer.classList.contains('is-backdrop')) hideLayer();
      // Last, because the line above ends a curtain, and a curtain is what puts
      // the title on its way out.
      title?.clear();
    },
    destroy,
  };

  function play(card, kind) {
    if (destroyed || !card) return Promise.resolve();
    close(active, { curtain: false });
    clearCurtain();
    // Whatever the last card left standing goes now: a replayed opening must
    // not be watched through the title of the one before it.
    title?.clear();
    return new Promise((resolve) => {
      // The title beat is the INTRO's ending — the end card carries no name and
      // no character, by the same rule that keeps one film per world: it is the
      // opening that has to say which story this is.
      //
      // And only where there is a name to raise. The words come off the card's
      // narration block, which a story built without a voice does not carry:
      // the beat would then be a lone sprite over five seconds of held frame
      // with the story's name shown nowhere, which is worse than the short hold
      // it replaced.
      const beat = kind === 'intro' && card.narration ? title : null;
      const phase = {
        kind, resolve, closed: false, started: false, spoke: false, spoken: false,
        film: card.video, narration: card.narration ?? null,
        media: [], timers: [], listeners: [], named: new Set(), music: null,
        held: [], stall: null, holding: false, hold: null,
        title: beat, holdMs: beat ? CARD_TITLE_HOLD_MS : CARD_HOLD_MS,
      };
      active = phase;
      held = false;
      line.textContent = '';
      skip.setAttribute('aria-label', kind === 'intro' ? 'skip the opening' : 'skip to the end');
      // Everything below is one synchronous stretch inside a promise executor,
      // and a throw in it would reject the phase — which is awaited bare by the
      // two calls that gate the story, and would leave the viewer behind an
      // opaque layer with nothing in the log. It cannot be allowed to escape.
      try {
        openOnBlack(phase);
        startVideo(phase, card.video);
        startMusic(phase, card.music);
      } catch (error) {
        warn(phase, card.video, `the card could not be started (${error?.message ?? String(error)})`);
        close(phase, { curtain: false });
      }
    });
  }

  /**
   * The card arrives through black rather than in front of it.
   *
   * `[hidden]` is `display: none`, and nothing transitions out of that: clearing
   * the attribute alone put a full-frame film on screen in one frame, over a
   * ceremony that was still fading underneath where nobody could see it. So the
   * layer is laid out transparent first, and only then asked to go opaque — the
   * screen goes under black over `CARD_REVEAL_MS`, and the film comes up out of
   * the black over the same again once it has.
   */
  function openOnBlack(phase) {
    layer.classList.remove('is-gone', 'is-backdrop');
    layer.classList.add('is-arriving', 'is-dark');
    layer.hidden = false;
    // Reading a layout property is what makes the state above a frame of its
    // own: without it the browser coalesces "laid out" and "opaque" into one and
    // there is nothing for the transition to run between.
    layer.getBoundingClientRect?.();
    layer.classList.remove('is-arriving');
    timer(phase, CARD_REVEAL_MS, () => layer.classList.remove('is-dark'));
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
      // The sheet is fetched against the film's own running time and is never
      // waited for: what the beat needs is the name, and the lead is company.
      phase.title?.warm();
      // A card that ends on a title beat does not also read the name over the
      // film — that line IS the beat now, and hearing it twice is the version
      // this replaced.
      if (phase.narration && !phase.title) speak(phase, phase.narration);
    });
    listen(phase, 'ended', () => holdLastFrame(phase));
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

  /**
   * The film is over, and stays on screen anyway.
   *
   * Everything that used to happen on `ended` happened in that one tick — the
   * music stopped mid-bar, the curtain started, the story began — so the film's
   * last stretch was a cross-fade over a performance already running and its
   * final frame was never actually seen. The beat below IS the ending; the
   * curtain comes after it, which is the order a title sequence has.
   */
  function holdLastFrame(phase) {
    if (phase.closed || phase.holding) return;
    phase.holding = true;
    // Guarded like `play`'s own opening stretch, and for the same reason: this
    // one runs inside the `ended` handler, and a throw escaping it would take
    // `armHold` with it — a phase that never closes, a promise that never
    // settles, and a viewer left on a frozen last frame for ever.
    if (phase.title) {
      try {
        openTitleBeat(phase);
      } catch (error) {
        // Keyed apart from the film's own lines. `warn` allows one line per
        // key, and the film has already spoken under this url whenever it
        // stalled once — which would swallow the only line saying why the
        // opening it recovered into has no name on it.
        warn(
          phase,
          phase.film,
          `the title card could not be raised (${error?.message ?? String(error)})`,
          'title-beat',
        );
      }
    }
    armHold(phase);
  }

  /**
   * The held frame with the story's name on it.
   *
   * Everything the early line used to do at one second into the film happens
   * here instead, over a picture that has stopped: the name is written on the
   * layer above the card, the voice reads it, and the music makes room the same
   * way it always did. The sprite is raised with it where there is one — and
   * where there is not, the beat is the name alone rather than a shorter card.
   */
  function openTitleBeat(phase) {
    phase.spoke = true;
    phase.title.reveal(phase.narration?.text ?? null);
    if (phase.narration) readTitle(phase, phase.narration);
  }

  function armHold(phase) {
    // Never two at once. Three things reach this — the film ending, the line's
    // length arriving, and a tab coming back — and a second timer laid over a
    // live one would close the card on whichever of them was shorter.
    clearHold(phase);
    phase.hold = setTimeout(() => {
      phase.hold = null;
      close(phase, { curtain: true });
    }, phase.holdMs);
    phase.timers.push(phase.hold);
  }

  function clearHold(phase) {
    if (phase.hold === null) return;
    clearTimeout(phase.hold);
    phase.hold = null;
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
      readTitle(phase, narration);
    });
  }

  /**
   * The voice, wherever the words are being shown.
   *
   * Called a second into the film by the card that writes its name across it,
   * and at the held last frame by the one that ends on a title beat — the same
   * ducking, the same bound, the same handing back of the room it took.
   */
  function readTitle(phase, narration) {
    // A story built without a voice still has its title on screen, and the
    // music has nothing to make room for.
    if (!narration.audio) return;
    const media = open(phase, narration.audio);
    duck(phase, true);
    // The one thing the card cannot work out for itself: how long the name it
    // is showing takes to say. Asked of the element rather than guessed, once,
    // as soon as the file has a duration to give.
    media.addEventListener('loadedmetadata', () => holdForTheLine(phase, media.duration), { once: true });
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
  }

  /**
   * The beat waits for the line, within reason.
   *
   * Only ever LENGTHENS the hold, and only a beat that is already running: a
   * short title does not shorten the ending, and the early-line path has a film
   * playing under it and nothing to wait for. A line whose duration never
   * arrives leaves the floor exactly as it was, which is the card every story
   * got before this.
   *
   * The hold is re-armed whole from here rather than topped up. What that costs
   * is the moment between the beat opening and the file answering — the element
   * is created at the hold and answers in a frame or two — and what it buys is
   * one length in one place, which `resumeCard` re-arms after a hidden tab
   * without knowing any of this happened.
   */
  function holdForTheLine(phase, seconds) {
    if (destroyed || phase.closed || !phase.title || !phase.holding) return;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const wanted = Math.min(
      CARD_TITLE_HOLD_CEILING_MS,
      Math.round(seconds * 1_000) + CARD_TITLE_TAIL_MS,
    );
    if (wanted <= phase.holdMs) return;
    phase.holdMs = wanted;
    // The length is recorded whatever the tab is doing, but a beat a hidden tab
    // stopped by hand stays stopped. Armed here it would run the held frame, the
    // curtain and the title's fade out in the dark, and the viewer would come
    // back to a story already begun with the card they never saw. `resumeCard`
    // arms this length when the tab comes back, which is the whole reason the
    // length lives on the phase rather than in the timer.
    if (held) return;
    armHold(phase);
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
    // The sprite is the one moving thing left on screen once the film has
    // ended: a loop still breathing over a frozen picture and silent music is
    // the tell that the beat was never really stopped.
    phase.title?.freeze();
    // The held frame is on no clock the browser stops, so the beat it is being
    // held for has to be stopped by hand — or a phone locked on the last frame
    // comes back to a card already gone.
    clearHold(phase);
  }

  function resumeCard(phase) {
    if (!held) return;
    held = false;
    for (const { media, url } of phase.held) request(phase, media, url, 'card audio would not resume');
    phase.held = [];
    phase.title?.thaw();
    // A film that has already ended is not asked to play again: what is on
    // screen is its last frame. The beat starts over rather than resuming, so a
    // viewer who looked away gets the whole of it instead of its stub.
    if (phase.holding) {
      armHold(phase);
      return;
    }
    playFilm(phase, phase.film);
  }

  /**
   * The phase is over, however it ended.
   *
   * `curtain` is the difference between an ending and a cancellation: a card
   * that played out, was skipped, or gave up on a film that stopped moving hands
   * the stage over behind a fade, while one taken away by a replay, a teardown
   * or a broken file goes at once — there is nothing behind it worth fading.
   *
   * A drawn curtain is a beat of its own rather than a decoration over one: the
   * music is ramped down INSIDE it instead of stopping with it, and the story is
   * not begun until it is over. A story started behind the fade is a cross-fade
   * between two performances, and its first line is spoken into a card.
   */
  function close(phase, { curtain: draw }) {
    if (!phase || phase.closed || phase !== active) return;
    phase.closed = true;
    active = null;
    held = false;
    if (phase.kind === 'intro') openingOver = true;
    if (!draw) {
      release(phase);
      hideLayer();
      // The title leaves ON the curtain, so a close with no curtain behind it —
      // a broken film, a refusal, a teardown — has nothing to take it out, and
      // leaving it up would put the last card's name over the whole of what
      // follows.
      phase.title?.clear();
      phase.resolve();
      return;
    }
    // The END card does not hand the stage back — it keeps it. Its last frame
    // is what "the end" is written over, so there is no curtain here: the film
    // stays exactly where it stopped and the layer only drops out of the card's
    // z-index into the story's, under the end screen and the transport. The
    // phase is over at once, which is what raises them; the music still goes,
    // over the length the curtain would have taken, under a picture that stays.
    if (phase.kind === 'end') {
      release(phase, { keepMusic: true });
      fadeMusic();
      layer.classList.add('is-backdrop');
      quiet = setTimeout(() => { quiet = null; dropMusic(); }, CARD_CURTAIN_MS);
      phase.resolve();
      return;
    }
    pending = phase;
    release(phase, { keepMusic: true });
    fadeMusic();
    drawCurtain();
  }

  /**
   * The curtain, which is the arrival run backwards.
   *
   * A card that simply dissolved into the story would not read as an ending at
   * all: one lit forest cross-fading into another lit forest over 700 ms is a
   * blur, not a curtain, and a viewer watching for it does not see it. So the
   * picture goes first, under the layer's own ink, and the ink goes second —
   * film, black, story, the same three beats the opening has in the other order.
   *
   * The exception is a card curtained INSIDE its own arrival, which is already
   * black and has no picture left to take down. `release` has cancelled the
   * timer that would have ended the arrival, so the black is taken off here
   * instead and the fade is of the film — otherwise the card would spend its
   * whole beat on a black rectangle in front of a story that has not begun.
   */
  function drawCurtain() {
    // The timer alone: a curtain being STARTED must not run the end of one.
    stopCurtainTimer();
    const arriving = layer.classList.contains('is-dark');
    layer.classList.remove('is-arriving');
    if (arriving) {
      layer.classList.remove('is-dark');
      goOut();
    } else {
      layer.classList.add('is-dark');
      blackout = setTimeout(() => {
        blackout = null;
        goOut();
      }, CARD_REVEAL_MS);
    }
    curtain = setTimeout(hideLayer, CARD_CURTAIN_MS);
  }

  /**
   * The ink goes out onto the story, and the title goes out with it.
   *
   * The name and the sprite are on a layer of their own above the card so the
   * FILM can be taken out from under them — not so they can outlast the ending.
   * They leave on the same half of the curtain the black does, and what the
   * story opens on is the story.
   */
  function goOut() {
    layer.classList.add('is-gone');
    pending?.title?.leave();
  }

  function stopCurtainTimer() {
    if (blackout !== null) {
      clearTimeout(blackout);
      blackout = null;
    }
    if (curtain === null) return;
    clearTimeout(curtain);
    curtain = null;
  }

  function hideLayer() {
    clearCurtain();
    layer.hidden = true;
    layer.classList.remove('is-gone', 'is-arriving', 'is-dark', 'is-backdrop');
    line.textContent = '';
    video.pause?.();
    // The element is free: whatever was asked for while it was the picture can
    // have it now.
    flushEnd();
  }

  /**
   * The curtain is over, however it got there — its own timer, a teardown, or a
   * card starting on top of it.
   *
   * Everything the fade was carrying ends here, and the promise is the one that
   * matters: a phase left unsettled is a story waiting for ever behind a layer
   * that is already gone, which is the one failure this file has no recovery
   * for. It is settled last, so the element is free before the story has it.
   */
  function clearCurtain() {
    stopCurtainTimer();
    stopQuiet();
    dropMusic();
    const waiting = pending;
    pending = null;
    waiting?.resolve();
  }

  /** The card's music, wherever it was in its fade. */
  function dropMusic() {
    stopFade();
    if (!lingering) return;
    lingering.pause?.();
    lingering.removeAttribute?.('src');
    lingering = null;
  }

  function stopQuiet() {
    if (quiet === null) return;
    clearTimeout(quiet);
    quiet = null;
  }

  /**
   * The card's music, taken down inside the curtain instead of stopped with it.
   *
   * Cut on the same tick the fade started, the last thing a viewer heard of the
   * opening was a track ending mid-bar under a picture that was still there.
   * The ramp reaches silence a step before the layer goes, so the fade is over
   * by the time the story is handed the stage.
   */
  function fadeMusic() {
    const media = lingering;
    if (!media) return;
    // From the card's own level, ducked or not: the close that started this fade
    // stopped the spoken line the music was making room for, and the `ended` that
    // would have handed the level back can no longer fire. One step up rather
    // than a slope, for the reason `duck` is a step — the ear is meeting the
    // fade anyway, and a curtain at a quarter volume is one nobody hears.
    media.volume = CARD_MUSIC_VOLUME;
    const steps = Math.max(1, Math.floor(CARD_CURTAIN_MS / CARD_MUSIC_FADE_STEP_MS));
    const from = CARD_MUSIC_VOLUME;
    let step = 0;
    const down = () => {
      step += 1;
      media.volume = step >= steps ? 0 : from * (1 - step / steps);
      fade = step >= steps ? null : setTimeout(down, CARD_MUSIC_FADE_STEP_MS);
    };
    fade = setTimeout(down, CARD_MUSIC_FADE_STEP_MS);
  }

  function stopFade() {
    if (fade === null) return;
    clearTimeout(fade);
    fade = null;
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

  /**
   * The phase lets go of everything it was holding — except, when a curtain is
   * about to be drawn, of the music, which has a fade left to play. That one
   * element outlives the phase and is released by `clearCurtain` instead.
   */
  function release(phase, { keepMusic = false } = {}) {
    clearStall(phase);
    clearHold(phase);
    for (const id of phase.timers) clearTimeout(id);
    phase.timers = [];
    for (const [type, handler] of phase.listeners) video.removeEventListener(type, handler);
    phase.listeners = [];
    const spared = keepMusic ? phase.music : null;
    for (const { media } of phase.media) {
      if (media === spared) continue;
      media.pause?.();
      media.removeAttribute?.('src');
    }
    phase.media = [];
    phase.held = [];
    if (spared) lingering = spared;
    phase.music = null;
  }

  function listen(phase, type, handler) {
    phase.listeners.push([type, handler]);
    video.addEventListener(type, handler);
  }

  function timer(phase, milliseconds, handler) {
    phase.timers.push(setTimeout(handler, milliseconds));
  }

  /**
   * One line per file, whatever else goes wrong with it afterwards.
   *
   * `key` is that file by default. A failure that is not the file's own — the
   * title beat refusing to be raised over it — passes its own key instead, or
   * a film that stalled once would be the last word on it.
   */
  function warn(phase, url, message, key = url) {
    if (phase.named.has(key)) return;
    phase.named.add(key);
    onWarning({ type: 'media', asset: `${phase.kind}-card`, url, message });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    close(active, { curtain: false });
    hideLayer();
    title?.clear();
    skip.removeEventListener('click', onSkip);
    document?.removeEventListener?.('visibilitychange', onVisibility);
    video.pause?.();
    video.removeAttribute?.('src');
    // Removing the attribute alone does not reliably stop the fetch: the
    // resource selection algorithm has to be re-run, which is what this does.
    video.load?.();
  }
}
