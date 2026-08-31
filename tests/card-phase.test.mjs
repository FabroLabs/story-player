/**
 * The two performances either side of the story.
 *
 * What these hold is the seam rather than the film: a card is not in the
 * compiled timeline, so everything worth asserting is about ORDER — the story
 * does not begin until the intro is over, the end screen does not arrive until
 * the end card is, a replay is both of them again, and a card that breaks costs
 * the story nothing but a line in the log. The scrub bar covers the story alone
 * throughout, which is what keeps `t` the story's own.
 *
 * The clock, the frames, the audio and the timers are all scripted: a card is
 * made of a `<video>` that reports for itself and two timers, and a test that
 * waited them out would be asserting on node's scheduler rather than on the
 * player.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import {
  CARD_CURTAIN_MS,
  CARD_CURTAIN_OUT_MS,
  CARD_DUCKED_MUSIC_VOLUME,
  CARD_HOLD_MS,
  CARD_LINE_DELAY_MS,
  CARD_MUSIC_FADE_STEP_MS,
  CARD_MUSIC_VOLUME,
  CARD_READY_TIMEOUT_MS,
  CARD_REVEAL_MS,
  createCardPhase,
} from '../browser/v0/app/card-phase.mjs';
import {
  CARD_TITLE_CELL_PX,
  CARD_TITLE_FADE_MS,
  CARD_TITLE_HOLD_CEILING_MS,
  CARD_TITLE_HOLD_MS,
  CARD_TITLE_OUT_MS,
  CARD_TITLE_TAIL_MS,
  createCardTitle,
} from '../browser/v0/app/card-title.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { fakeElement, findByClass, installAudio, installDom, virtualFrames } from './_dom.mjs';

const ASSET_BASE = 'https://storage.example/';
const TITLE = 'The owl’s quiet friend';

test('the begin click plays the intro card, and the story waits behind it', async (t) => {
  const player = await mount(t);
  player.begin();

  // The ceremony goes on the gesture itself, not a frame later: the click is
  // the one instant the media may be spent, and everything below happened
  // inside it.
  assert.equal(player.ceremony.classList.contains('is-gone'), true);
  assert.equal(player.layer.hidden, false, 'the card layer never came up');
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'the card played an unresolved path');
  assert.equal(player.video.paused, false, 'the card film was never asked to play');
  assert.equal(player.video.muted, true, 'a card that is not muted is a card an autoplay policy may refuse');

  const music = player.audio.at(-1);
  assert.equal(music.url, `${ASSET_BASE}bucket/intro-music.mp3`);
  assert.equal(music.played, true, 'the card music did not start inside the click');
  assert.equal(music.loop, true, 'a track shorter than its card would leave it silent');
  assert.equal(music.volume, CARD_MUSIC_VOLUME);

  // Nothing of the story: the transport belongs to a clock that has not
  // started, and the loop is not running.
  assert.equal(player.controls.hidden, true, 'the transport came up over the card');
  assert.equal(player.frames.pending(), 0, 'the story started under the card');
  assert.equal(player.end.hidden, true);
});

test('the story’s name is read over the card, and the music makes room for it', async (t) => {
  const player = await mount(t);
  player.begin();
  const music = player.audio.at(-1);

  // Armed by the first frame really on screen rather than by the click: a title
  // read over a card that is still arriving is read over nothing.
  assert.equal(player.line.textContent, '');
  player.video.dispatch('playing');
  player.timers.runOf(CARD_LINE_DELAY_MS);

  assert.equal(player.line.textContent, TITLE, 'the card never showed the name it was speaking');
  const spoken = player.audio.at(-1);
  assert.equal(spoken.url, `${ASSET_BASE}jobs/story-7/audio/title.wav`);
  assert.equal(spoken.played, true, 'the title was written but never read');
  assert.equal(music.volume, CARD_DUCKED_MUSIC_VOLUME, 'the line was read over music at full volume');

  spoken.listeners.get('ended')({ type: 'ended' });
  assert.equal(music.volume, CARD_MUSIC_VOLUME, 'the music stayed ducked after the line it made room for');
});

test('the film’s last frame is held, and only then handed over behind a curtain', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');
  const music = player.audio.at(-1);

  player.video.dispatch('ended');
  await settle();

  // The ending is the held frame. Nothing else has happened yet: the picture is
  // the film's own last one, the music is still playing over it, and the story
  // is not running behind it.
  assert.equal(player.layer.classList.contains('is-gone'), false, 'the curtain cut the film’s ending short');
  assert.equal(music.paused, false, 'the music stopped on the frame the film ran out on');
  assert.equal(music.volume, CARD_MUSIC_VOLUME, 'the music started fading before the ending was over');
  assert.equal(player.controls.hidden, true, 'the story began under the card’s last frame');
  assert.equal(player.frames.pending(), 0);

  player.timers.runOf(CARD_HOLD_MS);
  await settle();
  assert.equal(player.layer.classList.contains('is-gone'), true, 'the card cut instead of fading');
  assert.equal(player.layer.hidden, false, 'the card was taken away before it could fade');
  // Still nothing of the story: a curtain the story starts behind is a
  // cross-fade between two performances, and its first line is spoken into one.
  assert.equal(player.controls.hidden, true, 'the story started behind the curtain');
  assert.equal(player.frames.pending(), 0, 'the story asked for a frame from under the card');

  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.layer.hidden, true, 'the faded card stayed in the way');
  assert.equal(player.line.textContent, '', 'the story’s name outlived the card it was written on');
  assert.equal(music.paused, true, 'the card music played on over the story');
  assert.equal(music.removed, true, 'the card music was left holding its file');
  assert.equal(player.controls.hidden, false, 'the story never began');
  assert.ok(player.frames.pending() > 0, 'the story began without asking for a frame');
});

test('the music is faded down inside the curtain rather than cut with it', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');
  const music = player.audio.at(-1);

  player.video.dispatch('ended');
  player.timers.runOf(CARD_HOLD_MS);
  await settle();
  assert.equal(music.paused, false, 'the music was cut on the tick the curtain started');

  // One slope rather than a step, and one that reaches silence before the layer
  // it is falling under is taken away.
  let previous = music.volume;
  const steps = Math.floor(CARD_CURTAIN_MS / CARD_MUSIC_FADE_STEP_MS);
  for (let step = 0; step < steps; step += 1) {
    player.timers.runOf(CARD_MUSIC_FADE_STEP_MS);
    assert.ok(music.volume < previous, `the fade stopped falling at step ${step}`);
    previous = music.volume;
  }
  assert.equal(music.volume, 0, 'the fade never reached silence');
  assert.equal(music.paused, false, 'the music was released before its fade was over');

  player.timers.runOf(CARD_CURTAIN_MS);
  assert.equal(music.paused, true, 'the faded-out music was left running under the story');
  assert.equal(music.removed, true, 'the faded-out music was left holding its file');
});

test('the card comes up through black instead of in front of it', async (t) => {
  const player = await mount(t);
  player.begin();

  // Inside the click: the layer is on screen and laid out, but transparent —
  // `display: none` is a state nothing transitions out of, so the frame with
  // `is-arriving` on it is the only thing that makes the fade possible at all.
  assert.equal(player.layer.hidden, false);
  assert.equal(player.layer.classList.contains('is-arriving'), false, 'the layer was left transparent for ever');
  assert.equal(player.layer.classList.contains('is-dark'), true, 'the film was revealed before the black arrived');

  player.timers.runOf(CARD_REVEAL_MS);
  assert.equal(player.layer.classList.contains('is-dark'), false, 'the film never came out of the black');
});

test('the black is laid out for a frame before it is asked to arrive', async (t) => {
  const card = bareCard(t);
  const seen = [];
  // The one thing the class names alone cannot say: `display: none` is a state
  // nothing transitions out of, so the layer has to be READ while it is laid out
  // and still transparent. Without that read the browser folds "laid out" and
  // "opaque" into one frame and the card cuts to black — the bug this arrival
  // was written to fix, silently back with a green suite.
  card.layer.getBoundingClientRect = () => {
    seen.push(card.layer.classList.values().join(' '));
    return { width: 0, height: 0 };
  };

  card.phase.playIntro();
  assert.deepEqual(seen, ['is-arriving is-dark'], 'nothing forced the transparent frame the fade needs');
  assert.equal(card.layer.classList.contains('is-arriving'), false, 'the layer was left transparent for ever');
  assert.deepEqual(card.warnings, [], 'the arrival threw and the card was named for it');
});

test('a card curtained inside its own arrival fades its picture, not a black rectangle', async (t) => {
  const player = await mount(t);
  player.begin();
  assert.equal(player.layer.classList.contains('is-dark'), true);

  // Skip before the reveal timer has fired. `release` cancels that timer, so
  // without the curtain taking the black off itself the layer would spend its
  // whole fade at `opacity: 0` on the film — 700 ms of nothing, in front of a
  // story that is not begun until the fade is over.
  player.skip.dispatch('click');
  await settle();
  assert.equal(player.layer.classList.contains('is-gone'), true);
  assert.equal(player.layer.classList.contains('is-dark'), false, 'the curtain faded out a black rectangle');
  assert.equal(player.layer.classList.contains('is-arriving'), false);
});

test('skip takes the opening away at once, wherever it had got to', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');
  const music = player.audio.at(-1);

  // Always reachable, and its own control: the transport is hidden until the
  // story begins and dead while it is hidden, so a skip inside it could not be
  // pressed at the one moment it is for.
  assert.equal(player.skip.parent, player.layer);
  player.skip.dispatch('click');
  await settle();

  // The curtain starts on the click, with no beat before it: a viewer who
  // pressed skip wants out of the opening, not the ending of it held for them.
  // The picture keeps moving through the fade rather than freezing where the
  // skip landed, and the music falls with the fade.
  assert.equal(player.layer.classList.contains('is-gone'), true, 'skip held the card it was asked to drop');
  assert.equal(music.paused, false, 'the skipped card’s music was cut instead of faded');
  assert.equal(player.controls.hidden, true, 'the story started behind the skip’s curtain');

  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.layer.hidden, true);
  assert.equal(music.paused, true, 'the skipped card kept its music');
  assert.equal(player.controls.hidden, false, 'skip did not reach the story');
  assert.ok(player.frames.pending() > 0);
  assert.equal(player.video.paused, true, 'the skipped film played on behind the story');
});

test('a card that cannot be played costs the story a line in the log, not its opening', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('error');
  await settle();

  assert.equal(player.layer.hidden, true, 'a broken card was left on screen to fade over the story');
  assert.equal(player.controls.hidden, false, 'a broken card stopped the story');
  assert.match(player.log(), /card video could not be played/);
});

test('a card that never puts a frame on screen is not waited on for ever', async (t) => {
  const player = await mount(t);
  player.begin();
  assert.equal(player.controls.hidden, true);

  player.timers.runOf(CARD_READY_TIMEOUT_MS);
  await settle();

  assert.equal(player.controls.hidden, false, 'the story stood behind a card that never started');
  assert.match(player.log(), /card video did not start/);
});

test('the end card plays between the story stopping and its end screen', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  const heard = player.audio.length;

  player.frames.advanceTo(player.duration);

  // The card opens on a story that has really stopped — the plate paused, the
  // clock stopped, the transport already reading `replay`.
  assert.equal(player.plate.paused, true, 'the story kept rolling under its own end card');
  assert.equal(player.toggle.getAttribute('aria-label'), 'replay');
  assert.equal(player.layer.hidden, false, 'the end card never came up');
  assert.equal(player.video.src, `${ASSET_BASE}bucket/end.mp4`);
  assert.equal(player.end.hidden, true, 'the end screen arrived over the card that precedes it');

  const music = player.audio.at(-1);
  assert.ok(player.audio.length > heard, 'the end card played in silence');
  assert.equal(music.url, `${ASSET_BASE}bucket/end-music.mp3`, 'the end card played the intro’s track');
  assert.equal(music.played, true);

  player.skip.dispatch('click');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.end.hidden, false, 'the end screen never arrived after the card');
  assert.equal(music.paused, true);
});

test('the end card’s film is warmed as the last scene opens, not before', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();

  // Inside the first scene of two: the end card is minutes away and the bytes
  // belong to the scene the viewer is watching.
  player.frames.advanceTo(500);
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'the end card took the opening’s bandwidth');

  player.frames.advanceTo(player.sceneOpensAt(1) + 50);
  assert.equal(player.video.src, `${ASSET_BASE}bucket/end.mp4`, 'the end card was still being fetched when it was needed');
});

test('the end card never takes the element while the opening is still on screen', async (t) => {
  // One scene, which is therefore also the LAST scene: `onSceneOpen` says so at
  // the mount's own first frame and again the instant the story begins — both
  // times while the one `<video>` the cards share is showing the opening.
  const player = await mount(t, { story: oneSceneStory() });
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'the end card was fetched over the opening at the mount');

  player.begin();
  player.video.dispatch('ended');
  player.timers.runOf(CARD_HOLD_MS);
  await settle();

  // Mid-curtain: the layer is still on screen, fading over the story it is
  // about to hand the stage to. Swapping the source here blanks the frame being
  // faded, and the curtain becomes a cut to black.
  assert.equal(player.layer.hidden, false);
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'the end card blanked the fading opening');

  player.timers.runOf(CARD_CURTAIN_MS);
  assert.equal(player.video.src, `${ASSET_BASE}bucket/end.mp4`, 'the end card was never fetched at all');
});

test('a writer who finishes mid-curtain does not blank the fade either', async (t) => {
  const player = await mount(t, { published: 1, stream: { scenes: 2 }, story: oneSceneStory() });
  player.begin();
  player.video.dispatch('ended');
  player.timers.runOf(CARD_HOLD_MS);
  await settle();
  assert.equal(player.layer.hidden, false, 'the curtain is not up — this test proves nothing now');

  // The host says the writer stopped while the curtain is still fading. That is
  // the one thing that asks for the end card at an instant the opening is still
  // the picture, because `finishStory` announces the scene on screen again.
  await player.handle.finishStory('done');
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'the end card blanked the fading opening');

  player.timers.runOf(CARD_CURTAIN_MS);
  assert.equal(player.video.src, `${ASSET_BASE}bucket/end.mp4`, 'the end card was never fetched at all');
});

test('the transport is out of the way for as long as a card is up', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story is playing and the transport is not there');

  player.frames.advanceTo(player.duration);
  assert.equal(player.layer.hidden, false, 'the end card never came up');

  // The bar is only ever COVERED by the card layer, and covered is not gone:
  // its keys are live wherever the focus is. A viewer pressing them under an
  // opaque film would be steering a story they cannot see.
  assert.equal(player.controls.hidden, true, 'the transport stayed live under the end card');
  player.frame.dispatch('keydown', { key: 'Home', preventDefault() {} });
  player.frame.dispatch('keydown', { key: ' ', preventDefault() {} });
  await settle();
  assert.equal(player.layer.hidden, false, 'a key under the card took the card away');
  assert.equal(player.end.hidden, true, 'a key under the card brought the end screen forward');
  assert.equal(player.frames.pending(), 0, 'a key under the card started the story behind it');

  player.skip.dispatch('click');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.controls.hidden, false, 'the transport never came back after the card');
  assert.equal(player.end.hidden, false);
});

test('the transport is out of the way of a REPLAYED opening too', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  player.frames.advanceTo(player.duration);
  player.skip.dispatch('click');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();

  // The bar has been shown by now — `begin()` showed it and nothing hides it —
  // so this is the one card that plays over a live transport unless it is taken
  // away. A space bar here started the story behind the opening film, audible,
  // and lost the seconds it ran for.
  player.toggle.dispatch('click');
  assert.equal(player.layer.hidden, false, 'the replay skipped the opening');
  assert.equal(player.controls.hidden, true, 'the transport stayed live under the replayed opening');

  player.frame.dispatch('keydown', { key: ' ', preventDefault() {} });
  assert.equal(player.frames.pending(), 0, 'a key under the replayed card started the story behind it');

  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.equal(player.controls.hidden, false, 'the transport never came back after the replay');
  assert.ok(player.frames.pending() > 0, 'the story never came back after its replayed opening');
});

test('a replay is the whole performance again: the card, then the story', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  player.frames.advanceTo(player.duration);
  player.skip.dispatch('click');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.end.hidden, false);

  player.toggle.dispatch('click');

  // Straight back into the opening film, inside the click that asked for the
  // replay — and the story is standing at zero behind it rather than running.
  assert.equal(player.layer.hidden, false, 'the replay skipped the opening');
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`);
  assert.equal(player.end.hidden, true, 'the end screen stayed up over the replay');
  assert.equal(player.frames.pending(), 0, 'the story ran under the card it was replaying behind');
  const music = player.audio.at(-1);
  assert.equal(music.url, `${ASSET_BASE}bucket/intro-music.mp3`);

  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.ok(player.frames.pending() > 0, 'the story never came back after its replayed opening');
  assert.equal(player.at.textContent, '0:00', 'the replay resumed where the story had ended');
});

test('a player mounted without cards is the player that was there before them', async (t) => {
  const player = await mount(t, { cards: null });
  player.begin();
  await settle();

  assert.equal(player.layer.hidden, true, 'a story with no cards came up behind a card layer');
  assert.equal(player.controls.hidden, false, 'the story waited for a card nobody passed');
  player.frames.advanceTo(player.duration);
  assert.equal(player.end.hidden, false, 'the end screen waited for a card nobody passed');
});

test('destroy takes a card and its music with it', async (t) => {
  const player = await mount(t);
  player.begin();
  const music = player.audio.at(-1);

  player.handle.destroy();
  assert.equal(music.paused, true, 'the card music outlived the player');
  assert.equal(music.removed, true, 'the card music was left holding its file');
  assert.equal(player.video.src, '', 'the card film was left decoding for a player that is gone');
});

test('every ending settles the promise the story is waiting behind', async (t) => {
  const card = bareCard(t);
  const done = [];

  // Played out. Nothing settles when the film ends, and nothing settles when
  // the beat it is held for is over — only when the curtain has really left the
  // screen, which is the instant the story is handed a stage of its own.
  const played = card.phase.playIntro().then(() => done.push('played'));
  card.video.dispatch('ended');
  await settle();
  assert.deepEqual(done, [], 'the story was let go on the film’s last frame');
  card.timers.runOf(CARD_HOLD_MS);
  await settle();
  assert.deepEqual(done, [], 'the story was let go behind a curtain still on screen');
  card.timers.runOf(CARD_CURTAIN_MS);
  await played;

  // Cancelled. There is nothing worth fading behind a card taken away, so it
  // goes at once and the promise goes with it — untouched by any of this.
  const cancelled = card.phase.playEnd().then(() => done.push('cancelled'));
  card.phase.cancel();
  await cancelled;

  // And a teardown DURING a curtain: the phase is closed, the layer is fading,
  // its timer will never fire, and the promise is held by nothing else. This is
  // the one route the deferral opened, and a story left waiting on it would be
  // a child in front of a still frame with a clean log beside them.
  const torn = card.phase.playIntro().then(() => done.push('torn'));
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);
  await settle();
  card.phase.destroy();
  await torn;

  assert.deepEqual(done, ['played', 'cancelled', 'torn']);
});

test('a story mounted before it has a scene opens on its card and waits behind it', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 } });

  // Nothing is compiled yet — an empty story is not the opening of anything —
  // but the ceremony reads the manifest's own title and the button is armed by
  // the card alone.
  assert.equal(player.title.textContent, TITLE);
  assert.equal(player.start.disabled, false, 'the begin button waited for a scene that does not exist');

  player.begin();
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`);
  player.video.dispatch('ended');
  playOut(player);
  await settle();

  // The card ran out before the writer published: the spinner says so, and the
  // story is entered the moment the scene is there and decoded.
  assert.equal(player.waiting.hidden, false, 'nothing said why the story had not started');
  assert.equal(player.controls.hidden, true, 'the story began without a scene');

  await player.appendScene(0);
  await settle();
  assert.equal(player.waiting.hidden, true, 'the spinner outlived the scene it was waiting for');
  assert.equal(player.controls.hidden, false, 'the scene landed and the story never started');
  assert.ok(player.frames.pending() > 0);
  assert.equal(player.badge.textContent, 'scene 1 of 3', 'the badge lost the count the manifest gave it');
});

test('a scene that lands during the card is played the moment the curtain falls', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 } });
  player.begin();

  await player.appendScene(0);
  await settle();
  assert.equal(player.controls.hidden, true, 'the scene that landed cut the card short');
  assert.equal(player.waiting.hidden, true, 'a story with its scene in hand said it was waiting');

  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story that was ready never started');
  assert.ok(player.frames.pending() > 0);
});

test('a writer who publishes nothing at all is not left behind the curtain', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 } });
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.equal(player.waiting.hidden, false);

  await player.handle.finishStory('failed');
  await settle();

  assert.equal(player.waiting.hidden, true, 'the spinner outlived the story nobody wrote');
  assert.equal(player.end.hidden, false, 'a story with nothing in it never ended');
});

test('a story with no scenes is only mounted when a card and a writer are both there', async (t) => {
  const dom = installDom();
  const audio = installAudio();
  const players = [];
  t.after(() => {
    for (const player of players) player.destroy();
    audio.restore();
    dom.restore();
  });
  const refuses = async (options) => {
    const player = createStoryPlayer(document.createElement('div'), {
      story: { ...cardStory(), scenes: [] },
      assetBase: ASSET_BASE,
      plates: platesOf(cardStory()),
      ...options,
    });
    players.push(player);
    await assert.rejects(player.ready, /non-empty scenes array/);
  };

  // No cards at all: the mount every host had before them, refused where it
  // always was — by the resolver, before anything is compiled.
  await refuses({ stream: { scenes: 3 } });
  // An end card is not an opening. Without a film to play there is nothing for
  // the first scene to be published during, and begin would land on a spinner.
  await refuses({ stream: { scenes: 3 }, cards: { end_card: cardBlocks().end_card } });
  // And a card with no writer behind it: nothing may ever be appended, so the
  // viewer would be left behind the curtain with no way for a story to arrive.
  await refuses({ cards: cardBlocks() });
});

test('the begin click spends the gesture on the story’s audio, not only the card’s', async (t) => {
  const player = await mount(t);
  let resumed = 0;
  // A card puts a quarter of a minute between the gesture and `begin()`, and an
  // audio session resumed outside a gesture is one iOS leaves suspended: the
  // card's own music would play and the whole story after it would not.
  window.AudioContext = class {
    resume() {
      resumed += 1;
      return Promise.resolve();
    }
  };

  player.begin();
  assert.equal(resumed, 1, 'the gesture was spent on the card alone');
});

test('the opening film is fetched before the click, not by it', async (t) => {
  const player = await mount(t);

  // Warmed while the first scene was decoding. Without it the card comes up
  // black for as long as the mp4 takes to arrive — right after the ceremony
  // has withdrawn, which is the one moment the screen has nothing else on it.
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'the opening film was not warmed');
  assert.equal(player.video.paused, true, 'the warmed film started playing before anybody pressed begin');
});

test('a film that stops moving does not hold the story behind it', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');

  // Buffering is not failing: a card that comes back is left alone.
  player.video.dispatch('waiting');
  assert.match(player.log(), /card video stalled/);
  player.video.dispatch('playing');
  player.timers.runOf(CARD_READY_TIMEOUT_MS);
  await settle();
  assert.equal(player.layer.hidden, false, 'a card that merely buffered was cut short');
  assert.equal(player.controls.hidden, true);

  // One that does not is the case no event ends: not `ended`, not `error`, and
  // the ready deadline disarmed itself the moment the first frame landed.
  player.video.dispatch('waiting');
  player.timers.runOf(CARD_READY_TIMEOUT_MS);
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story stood behind a film that had stopped moving');
});

test('a spoken title the device refuses hands the music back', async (t) => {
  const player = await mount(t);
  player.begin();
  const music = player.audio.at(-1);
  const Original = globalThis.Audio;
  t.after(() => { globalThis.Audio = Original; });
  // The title is opened a second into the card — outside the gesture — which is
  // exactly where a device refuses a fresh element.
  globalThis.Audio = class extends Original {
    play() {
      this.played = true;
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    }
  };

  player.video.dispatch('playing');
  player.timers.runOf(CARD_LINE_DELAY_MS);
  assert.equal(music.volume, CARD_DUCKED_MUSIC_VOLUME, 'the music never made room for the line');
  await settle();

  assert.equal(music.volume, CARD_MUSIC_VOLUME, 'the music kept making room for a voice that never came');
  assert.match(player.log(), /spoken title would not start/);
});

test('a title that never arrives at all gives the music back on its own', async (t) => {
  const player = await mount(t);
  player.begin();
  const music = player.audio.at(-1);
  player.video.dispatch('playing');
  player.timers.runOf(CARD_LINE_DELAY_MS);
  assert.equal(music.volume, CARD_DUCKED_MUSIC_VOLUME);

  // Neither refused nor broken: a file still fetching into silence. There is no
  // story clock here to end the line the way the scheduler ends one.
  player.timers.runOf(CARD_READY_TIMEOUT_MS);
  assert.equal(music.volume, CARD_MUSIC_VOLUME, 'a line nobody heard held the music down for the whole card');
});

test('a tab that goes away takes the card’s picture and music together', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');
  const music = player.audio.at(-1);

  // A card is not on the story's clock, so nothing else would stop it: a phone
  // that locks mid-opening would otherwise play the music on in a pocket.
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.equal(player.video.paused, true, 'the film played on in a hidden tab');
  assert.equal(music.paused, true, 'the music played on in a hidden tab');

  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  assert.equal(player.video.paused, false, 'the film never came back');
  assert.equal(music.paused, false, 'the music never came back');
});

test('a tab that goes away during the held frame keeps the beat, and does not replay the film', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');
  player.video.dispatch('ended');

  // The held frame is on no clock the browser stops, so the beat would run out
  // in the dark: a phone locked on the last frame comes back to a card gone.
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.throws(
    () => player.timers.runOf(CARD_HOLD_MS),
    /no timer was armed/,
    'the held beat ran on in a hidden tab',
  );

  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  // And the film is NOT asked to play again — it has already ended, so a card
  // that restarted it would never reach its own ending, and the story behind it
  // would wait for a curtain that is never drawn.
  assert.equal(player.video.paused, true, 'the ended film was started again on the way back');
  playOut(player);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story never started after the tab came back');
});

test('a tab that goes away mid-curtain ends the fade rather than leaving it in a pocket', async (t) => {
  const card = bareCard(t);
  const done = [];
  card.phase.playIntro().then(() => done.push('gone'));
  const music = card.audio[0];
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);
  assert.equal(music.paused, false, 'the curtain is not fading — this test proves nothing now');

  // A hidden tab clamps the curtain's own timer and the fade's steps to the same
  // floor, so the ramp never runs: the track would play on out of a pocket and
  // then be CUT, which is the failure the fade was written to remove.
  globalThis.document.visibilityState = 'hidden';
  globalThis.document.dispatch('visibilitychange');
  await settle();
  assert.equal(music.paused, true, 'the card’s music played on in a hidden tab');
  assert.equal(card.layer.hidden, true, 'a fade nobody could see was left on screen');
  assert.deepEqual(done, ['gone'], 'the story was left waiting behind a fade nobody could see');
});

test('cancel takes a card away even when it is already fading', async (t) => {
  const card = bareCard(t);
  const done = [];
  card.phase.playIntro().then(() => done.push('gone'));
  const music = card.audio[0];
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);
  assert.equal(music.paused, false, 'the curtain is not fading — this test proves nothing now');

  // What `cancel` is for: a replay, a teardown, a scrub back out of the end
  // card. Its music outlives the phase by the whole curtain now, and a viewer
  // who has just returned to the story would hear the card playing over it.
  card.phase.cancel();
  await settle();
  assert.equal(music.paused, true, 'the cancelled card kept its music over the story');
  assert.equal(card.layer.hidden, true, 'the cancelled card stayed on screen fading');
  assert.deepEqual(done, ['gone']);
});

test('a card skipped over its own spoken line still fades from the music’s full level', async (t) => {
  const player = await mount(t);
  player.begin();
  const music = player.audio.at(-1);
  player.video.dispatch('playing');
  player.timers.runOf(CARD_LINE_DELAY_MS);
  assert.equal(music.volume, CARD_DUCKED_MUSIC_VOLUME);

  // The skip stops the voice the music was making room for, and the `ended` that
  // would have handed the level back can never fire — the element is gone with
  // the phase. A curtain played at a quarter volume is one nobody hears.
  player.skip.dispatch('click');
  assert.equal(music.volume, CARD_MUSIC_VOLUME, 'the curtain’s music stayed under a voice that had stopped');
  player.timers.runOf(CARD_MUSIC_FADE_STEP_MS);
  assert.ok(
    music.volume < CARD_MUSIC_VOLUME && music.volume > CARD_DUCKED_MUSIC_VOLUME,
    'the fade started from the ducked level rather than the card’s own',
  );
});

test('the end card of a story its writer has just finished is warmed too', async (t) => {
  const player = await mount(t, { published: 1, stream: { scenes: 2 } });
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  player.frames.advanceTo(500);

  // The warm is gated on the story being complete, and a streaming story is not
  // complete until the host says so. A viewer already inside the last published
  // scene when the writer stops would otherwise meet a cold end card.
  assert.equal(player.video.src, `${ASSET_BASE}bucket/intro.mp4`, 'an unfinished story warmed its end card');
  await player.handle.finishStory('done');
  assert.equal(player.video.src, `${ASSET_BASE}bucket/end.mp4`, 'the end card was still cold when the writer stopped');
});

test('a first scene the player refuses leaves the spinner up rather than an empty story', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 } });
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();

  const stranger = structuredClone(cardStory().scenes[0]);
  stranger.steps[0] = { kind: 'cmd', line: 2, cmd: 'put', subjects: ['nobody_here'], position: null, facing: null };
  await assert.rejects(() => player.handle.appendScene(stranger), /nobody_here/);
  await settle();

  // Nothing was published, so there is nothing to open: the spinner stays and
  // liveness is the host's, exactly as it is for a refusal mid-story.
  assert.equal(player.waiting.hidden, false, 'a refused first scene took the spinner down');
  assert.equal(player.end.hidden, true, 'a refused first scene ended a story that never started');
  assert.match(player.log(), /an appended scene was refused/);

  // And the scene that was actually written still goes in afterwards.
  await player.appendScene(0);
  await settle();
  assert.equal(player.waiting.hidden, true);
  assert.equal(player.controls.hidden, false, 'the story never started after the refusal was fixed');
});

test('a scene that lands while the card plays is not begun before it is decoded', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 } });
  const release = holdAssets();
  t.after(release);
  player.begin();
  const landing = player.appendScene(0);
  await settle();

  // The curtain falls while the scene is still decoding. The runtime exists by
  // then — `buildRuntime` is synchronous — so a gate that asked whether it
  // existed would cut onto placeholder sprites, an unplayed plate and a
  // transport that has not been armed.
  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.equal(player.waiting.hidden, false, 'the curtain fell onto a scene that had not decoded');
  assert.equal(player.controls.hidden, true, 'the story began on an undecoded scene');

  release();
  await landing;
  await settle();
  assert.equal(player.waiting.hidden, true, 'the spinner outlived the scene it was waiting for');
  assert.equal(player.controls.hidden, false, 'the decoded scene never started');
  assert.notEqual(player.total.textContent, '0:00', 'the story began before its transport was armed');
});

test('a host that tears the player down mid-scene is not handed the abort', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 } });
  const release = holdAssets();
  t.after(release);
  player.begin();
  const landing = player.appendScene(0);
  await settle();

  // The gate in front of the curtain awaits a decode that a teardown cancels.
  // A host racing its own `destroy()` is not an error worth reporting to it —
  // the promise it is holding has to settle, not throw.
  player.handle.destroy();
  release();
  await landing;
});

test('a first scene whose assets never come still opens the story', async (t) => {
  const player = await mount(t, { published: 0, stream: { scenes: 3 }, assets: () => ({ status: 500 }) });
  player.begin();
  player.video.dispatch('ended');
  playOut(player);
  await settle();

  await player.appendScene(0);
  await settle();

  // The gate is there so the cut lands on a decoded scene, not so a broken one
  // can strand a viewer behind the curtain for ever. A scene plays with
  // placeholders and a named warning — what every other cut in this player does.
  assert.equal(player.waiting.hidden, true, 'a scene with broken assets left the spinner up for ever');
  assert.equal(player.controls.hidden, false, 'a scene with broken assets never started');
});

test('a card that names its lead ends on a title beat instead of an early line', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  // The sheet is fetched against the film's running time, so this is the whole
  // of the wait the card ever does for it.
  await settle();

  // Nothing over the moving picture. The line this card would have read a
  // second in is the beat it is about to end on, and reading it twice is the
  // opening this replaced.
  assert.throws(
    () => player.timers.runOf(CARD_LINE_DELAY_MS),
    /no timer was armed/,
    'the early line was still armed on a card with a title beat',
  );
  assert.equal(player.line.textContent, '');
  assert.equal(player.titleLayer.hidden, true, 'the title came up over the film rather than its ending');

  const music = player.audio.at(-1);
  player.video.dispatch('ended');
  await settle();

  // The held frame, with the name on it and the lead standing in it.
  assert.equal(player.titleLayer.hidden, false, 'the film ended on nothing');
  assert.equal(player.titleLayer.classList.contains('is-shown'), true, 'the title popped instead of fading in');
  assert.equal(player.titleName.textContent, TITLE);
  const spoken = player.audio.at(-1);
  assert.equal(spoken.url, `${ASSET_BASE}jobs/story-7/audio/title.wav`);
  assert.equal(spoken.played, true, 'the name was written on the beat but never read');
  assert.equal(music.volume, CARD_DUCKED_MUSIC_VOLUME, 'the name was read over music at full volume');

  // The sprite is one cell of the RENDITION's grid — 2x2 for a four-frame
  // strip — blitted at the size it decoded, which is what the canvas is backed
  // by. A card reading the bundle's own 4x1 grid draws a slice of two frames
  // and says nothing about it.
  const drawn = sprites(player);
  assert.ok(drawn.length > 0, 'the lead was never drawn');
  assert.deepEqual(drawn.at(-1).slice(2, 10), [0, 0, 32, 32, 0, 0, 32, 32]);
  assert.deepEqual(player.titleCanvas.sizes.at(-1), ['height', 32]);

  // The smallest step of the ladder, not the sharpest. The 512 tier of an
  // eighty-frame idle clip is an 85 MB decode held beside the opening scene's
  // own sheets, for three seconds of decoration.
  assert.ok(player.fetched().includes(SPRITE), `the card never asked for ${SPRITE}`);
  assert.equal(
    player.fetched().includes(SHARPER_SPRITE),
    false,
    `the card asked for ${CARD_TITLE_CELL_PX}px and was handed the sharpest tier there is`,
  );

  // And it is alive: three eighths of a second in, the fourth frame of the loop.
  player.frames.advanceTo(375);
  assert.deepEqual(sprites(player).at(-1).slice(2, 6), [32, 32, 32, 32], 'the sprite is a still picture');
  // Sized once, at the first frame. Assigning `width` or `height` CLEARS a real
  // canvas even when the number is unchanged, so a resize per frame is a sprite
  // that flickers or vanishes on whichever driver clears after it blits.
  assert.deepEqual(player.titleCanvas.sizes, [['width', 32], ['height', 32]]);

  // The beat is the title's, not the plain hold's.
  assert.throws(() => player.timers.runOf(CARD_HOLD_MS), /no timer was armed/);
  player.timers.runOf(CARD_TITLE_HOLD_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true, 'the curtain never came');
});

test('the title outlives the FILM and leaves with the black, not after it', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();
  player.timers.runOf(CARD_TITLE_HOLD_MS);

  // First half of the curtain: the film goes under the black with the name
  // still on it. Fading the name with the FILM would leave the black bare.
  assert.equal(player.titleLayer.hidden, false, 'the title left with the film it was raised over');
  assert.equal(player.titleLayer.classList.contains('is-fading'), false, 'the title left before the black did');
  // The one thing the class names cannot say. Nested inside the card layer the
  // assertions below would still pass — the fake DOM cascades neither `hidden`
  // nor `display` — while a real browser took the title away with the film.
  assert.notEqual(player.titleLayer.parent, player.layer, 'the title is inside the card it outlives');
  assert.equal(player.titleLayer.parent, player.frame, 'the title left the stage frame');

  // Second half: the black goes out onto the story, and the name goes with it.
  player.timers.runOf(CARD_REVEAL_MS);
  assert.equal(player.titleLayer.classList.contains('is-fading'), true, 'the title stayed on over the story');
  assert.equal(player.titleLayer.hidden, false, 'the title was taken away instead of faded');

  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.layer.hidden, true, 'the card outstayed its curtain');
  assert.equal(player.controls.hidden, false, 'the story never began');

  player.timers.runOf(CARD_TITLE_OUT_MS);
  assert.equal(player.titleLayer.hidden, true, 'a transparent layer was left over the story');
  assert.equal(player.titleName.textContent, '', 'the story name outlived the beat it was raised on');
});

test('a story published before the manifest named a lead opens the way it was built to', async (t) => {
  const player = await mount(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_LINE_DELAY_MS);

  assert.equal(player.line.textContent, TITLE, 'the card without a lead lost its written name');
  assert.equal(player.titleLayer.hidden, true, 'a card with no lead raised a title layer anyway');

  player.video.dispatch('ended');
  playOut(player);
  await settle();
  assert.equal(player.controls.hidden, false);
  assert.equal(player.titleLayer.hidden, true, 'the title beat played for a story that never named a lead');
});

test('a lead the story never cast still gets its beat, with one line in the log', async (t) => {
  const player = await mountLead(t, 'nobody');
  assert.match(player.log(), /not in this story/, 'the missing lead was never named');

  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();

  // Title-only: the name is the card, the sprite was the company.
  assert.equal(player.titleLayer.hidden, false, 'a lead this story never cast cost it the whole beat');
  assert.equal(player.titleName.textContent, TITLE);
  assert.equal(sprites(player).length, 0, 'something was drawn for a character that is not here');

  playOutTitle(player);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story waited on a sprite that does not exist');
});

test('a sprite sheet that has not decoded costs the story nothing', async (t) => {
  const player = await mountLead(t);
  // Held from here on, so the card's own fetch is still in flight when its film
  // runs out. The opening scene was prepared before this and is unaffected.
  const release = holdAssets();
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();

  assert.equal(player.titleLayer.hidden, false, 'a sheet that was late took the name down with it');
  assert.equal(player.titleName.textContent, TITLE);
  assert.equal(sprites(player).length, 0);
  assert.match(player.log(), /was not ready when the title card began/);

  // And the beat is the same length it always is: the sprite is never waited on.
  playOutTitle(player);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story waited for a sprite sheet');
  release();
  await settle();
});

/** The beat, opened, with the narration element the card is reading from. */
async function openBeat(t, options) {
  const player = await mountLead(t, ...(options ? [options] : []));
  player.begin();
  player.video.dispatch('playing');
  await settle();
  player.video.dispatch('ended');
  await settle();
  return { player, spoken: player.audio.at(-1) };
}

test('the beat waits for a name that takes longer than its floor to say', async (t) => {
  const { player, spoken } = await openBeat(t);

  // The line used to have the rest of a fourteen-second film to be read over
  // and now has only this beat, so the beat asks it how long it is.
  spoken.duration = 4.1;
  spoken.listeners.get('loadedmetadata')({ type: 'loadedmetadata' });
  assert.throws(
    () => player.timers.runOf(CARD_TITLE_HOLD_MS),
    /no timer was armed/,
    'the card kept its floor and cut the title mid-word',
  );

  player.timers.runOf(4_100 + CARD_TITLE_TAIL_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true, 'the curtain never came');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story never began');
});

test('a name shorter than the floor does not shorten the beat', async (t) => {
  const { player, spoken } = await openBeat(t);
  spoken.duration = 1.4;
  spoken.listeners.get('loadedmetadata')({ type: 'loadedmetadata' });

  // The floor is the beat's own shape — the fade in, the name, a moment of the
  // picture. A short title is read inside it, not chased by the curtain.
  player.timers.runOf(CARD_TITLE_HOLD_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true);
});

test('a name with no end to it is still let go of', async (t) => {
  const { player, spoken } = await openBeat(t);
  spoken.duration = 45;
  spoken.listeners.get('loadedmetadata')({ type: 'loadedmetadata' });

  // Whatever the file turns out to be, a story is not held behind its own name.
  assert.throws(() => player.timers.runOf(45_000 + CARD_TITLE_TAIL_MS), /no timer was armed/);
  player.timers.runOf(CARD_TITLE_HOLD_CEILING_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true, 'the beat ran past its own ceiling');
});

test('a line that never says how long it is keeps the floor', async (t) => {
  const { player } = await openBeat(t);
  // No `loadedmetadata` at all — a file still fetching, or one the device will
  // not measure. This is the card every story got before the beat asked.
  player.timers.runOf(CARD_TITLE_HOLD_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true);
});

test('a longer beat still starts over whole after a hidden tab', async (t) => {
  const { player, spoken } = await openBeat(t);
  spoken.duration = 4.1;
  spoken.listeners.get('loadedmetadata')({ type: 'loadedmetadata' });

  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  // The beat begins again rather than resuming, at the length it had grown to:
  // a viewer who looked away gets the whole of the name, not its stub.
  player.timers.runOf(4_100 + CARD_TITLE_TAIL_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true, 'the lengthened beat was lost with the tab');
});

test('the end card carries no title, and holds for the plain beat', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();
  playOutTitle(player);
  await settle();
  player.timers.runOf(CARD_TITLE_OUT_MS);
  assert.equal(player.titleLayer.hidden, true);

  // To the end of the story, where the closing film plays. One film per world
  // is shared by every story told in it, and the name belongs to the opening:
  // an ending that announced the title again would be reading the credits out.
  player.frames.advanceTo(player.duration);
  await settle();
  assert.equal(player.layer.hidden, false, 'the end card never came up — this test proves nothing');
  player.video.dispatch('playing');
  player.video.dispatch('ended');
  assert.equal(player.titleLayer.hidden, true, 'the end card raised the opening’s title');
  assert.throws(
    () => player.timers.runOf(CARD_TITLE_HOLD_MS),
    /no timer was armed/,
    'the end card held for a title beat it does not have',
  );
  player.timers.runOf(CARD_HOLD_MS);
  // And it does not fade at all: the end card STAYS. Its last frame is what the
  // end screen is written over, so the layer drops to a backdrop rather than
  // handing the stage back to the scene the story stopped on.
  assert.equal(player.layer.classList.contains('is-gone'), false, 'the end card faded the story back in');
  assert.equal(player.layer.classList.contains('is-backdrop'), true, 'the end card did not become the backdrop');
  assert.equal(player.layer.hidden, false, 'the end card took its own last frame away');
});

test('a replayed opening asks for the lead’s sheet again', async (t) => {
  let broken = true;
  const player = await mount(t, {
    cards: leadCards(),
    story: leadStory(),
    assets: (url) => (url.includes('moth-right-200') && broken ? { status: 404 } : {}),
  });
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();

  // A sheet that answered 404 is a different failure from one still fetching,
  // and the log has to be able to tell a broken file from a slow link.
  assert.match(player.log(), /could not be decoded/, 'a sheet that 404ed was never named');
  assert.equal(sprites(player).length, 0);
  playOutTitle(player);
  await settle();
  player.timers.runOf(CARD_TITLE_OUT_MS);

  player.frames.advanceTo(player.duration);
  await settle();
  player.skip.dispatch('click');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.end.hidden, false, 'the story never reached its end — this test proves nothing');

  // The replay is a whole performance again, and the sheet is asked for again
  // with it: a story's worth of scenes has been decoded since, and the card's
  // own sheet is the first thing the cache lets go of.
  broken = false;
  player.toggle.dispatch('click');
  assert.equal(player.titleLayer.hidden, true, 'the replay opened behind the title it was replacing');
  player.video.dispatch('playing');
  await settle();
  player.video.dispatch('ended');
  await settle();
  assert.ok(sprites(player).length > 0, 'the replayed opening lost its lead');
});

test('a skip before the ending raises no title over the story', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();

  // A viewer who skips wants out, not a title card — and nothing may fade up
  // over the story afterwards either.
  player.skip.dispatch('click');
  assert.equal(player.titleLayer.hidden, true, 'the skip raised the beat it was skipping');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story never began');
  assert.equal(player.titleLayer.hidden, true, 'a title faded up over the story out of nowhere');
  assert.throws(() => player.timers.runOf(CARD_TITLE_OUT_MS), /no timer was armed/);
});

test('a skip DURING the beat keeps the title it is already showing', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  await settle();
  player.video.dispatch('ended');
  await settle();
  assert.equal(player.titleLayer.hidden, false);

  player.skip.dispatch('click');
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.titleLayer.hidden, false, 'skipping out of the beat cut the title with the card');
  player.timers.runOf(CARD_TITLE_OUT_MS);
  assert.equal(player.titleLayer.hidden, true);
});

test('the title is laid out for a frame before it is asked to appear', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist) });
  const seen = [];
  beat.layer.getBoundingClientRect = () => {
    seen.push(beat.layer.classList.values().join(' '));
    return { width: 0, height: 0 };
  };

  beat.title.reveal(TITLE);
  // The same trap the card layer is opened around: `display: none` is a state
  // nothing transitions out of, so the layer has to be READ while it is laid
  // out and still transparent. Without the read the title snaps onto the held
  // frame with a green suite behind it.
  assert.deepEqual(seen, [''], 'nothing forced the transparent frame the fade needs');
  assert.equal(beat.layer.classList.contains('is-shown'), true);
});

test('the loop comes back on the pose it froze on', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist) });
  beat.title.reveal(TITLE);
  beat.frames.advanceTo(375);
  assert.deepEqual(beat.drawn().at(-1).slice(2, 4), [32, 32], 'the loop never reached the fourth frame');

  beat.title.freeze();
  assert.equal(beat.frames.pending(), 0, 'the loop ran on in a hidden tab');
  beat.frames.setWall(9_000);
  beat.title.thaw();
  // Not frame zero: a character that jumps a third of the way through its own
  // breath is the one thing the still picture it replaced would never have done.
  assert.deepEqual(beat.drawn().at(-1).slice(2, 4), [32, 32], 'the sprite snapped back to the start');
});

test('a manifest mounted under its own name is read all the same', (t) => {
  // A manifest carries BOTH keys and they are different blocks: `cast` there is
  // a slug-to-display-name map, and the cast a player is mounted with is
  // `cast_bundle`. A host that mounts the manifest itself before the first
  // scene exists — the shape `docs/embedding.md` documents — hands over both,
  // so reading `cast` first would find the lead's NAME where its clips should
  // be and report a character with nothing to stand in.
  const beat = bareTitle(t, {
    story: { cast: { [LEAD]: 'Moth' }, cast_bundle: { [LEAD]: soloist } },
  });
  beat.title.reveal(TITLE);
  assert.deepEqual(beat.said(), []);
  assert.ok(beat.drawn().length > 0, 'the lead was not found under the manifest’s own key');
});

test('a bundle the sheet reader cannot make sense of costs a sprite, not the story', (t) => {
  // `grid` is a pair everywhere the engine writes one; a number here throws out
  // of `renditionGrid`, three levels below this file. This runs inside the
  // player's own constructor, so an escape is not a card without a picture —
  // it is a viewer told the STORY could not be opened.
  const beat = bareTitle(t, {
    story: oneCharacter({
      capability: { idle: { right: 'odd' } },
      clips: {
        odd: {
          spritesheet: 'bucket/odd.png', frames: 4, grid: 4, renditions: { 200: 'bucket/odd-200.webp' },
        },
      },
    }),
  });
  assert.equal(beat.said().length, 1, `the reader said ${beat.said().length} lines`);
  assert.match(beat.said()[0], /could not be read/);
  beat.title.reveal(TITLE);
  assert.equal(beat.name.textContent, TITLE, 'the beat lost its name with the sprite');
  assert.equal(beat.drawn().length, 0);
});

test('a canvas that hands out no context is named rather than left blank', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist), canvas: fakeElement('div') });
  assert.deepEqual(beat.said(), ['the intro card’s lead has no canvas to be drawn on']);
  // And nothing is fetched for a picture that cannot be drawn: the bytes would
  // be charged to a memory budget the scene on screen is competing for.
  beat.title.warm();
  assert.equal(beat.loaded().length, 0, 'a sheet was decoded for a canvas that cannot draw it');
});

test('a sheet that fails is one line, not two', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist), cache: brokenCache() });
  beat.title.warm();
  return Promise.resolve().then(() => {
    beat.title.reveal(TITLE);
    // "could not be decoded" and "was not ready" are two different sentences
    // about one file, and the second one is not even true.
    assert.deepEqual(beat.said(), ['the lead’s sprite sheet could not be decoded (no)']);
  });
});

test('a second performance gets its own lines', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist), cache: emptyCache() });
  beat.title.reveal(TITLE);
  beat.title.clear();
  beat.title.reveal(TITLE);
  assert.equal(beat.said().length, 2, 'a replay that failed the same way said nothing at all');
});

test('a title that throws on its way up costs the card nothing but a line', async (t) => {
  const card = bareCard(t, {
    title: recordingTitle({ reveal() { throw new Error('no canvas'); } }),
  });
  const done = [];
  card.phase.playIntro().then(() => done.push('gone'));
  card.video.dispatch('playing');
  card.video.dispatch('ended');

  // The beat is raised inside the `ended` handler and the hold is armed after
  // it. A throw taken with the hold is a card that never closes and a story
  // waiting on a promise that never settles.
  assert.match(card.warnings.at(-1).message, /the title card could not be raised/);
  card.timers.runOf(CARD_TITLE_HOLD_MS);
  card.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.deepEqual(done, ['gone'], 'the phase promise never settled');
});

test('a card that ends without a curtain takes its title with it', async (t) => {
  const title = recordingTitle();
  const card = bareCard(t, { title });
  const done = [];
  card.phase.playIntro().then(() => done.push('gone'));
  card.video.dispatch('playing');
  card.video.dispatch('ended');
  assert.ok(title.calls.includes('reveal'), 'the beat never opened — this test proves nothing');

  // A film that breaks after its own ending: there is no fade for the title to
  // outlive, and no curtain to take it out.
  card.video.dispatch('error');
  assert.equal(title.calls.at(-1), 'clear', 'the title was left over the whole story');
  await settle();
  assert.deepEqual(done, ['gone']);
});

test('a title on its way out stops with the tab, and the story under it', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();
  playOutTitle(player);
  await settle();
  assert.equal(player.titleLayer.hidden, false, 'the title was taken away rather than faded');

  // The card phase is over by the time the fade finishes, and the story under
  // it pauses with the tab: a fade left running in the dark is a viewer coming
  // back to a story already begun with nothing over it.
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.throws(
    () => player.timers.runOf(CARD_TITLE_OUT_MS),
    /no timer was armed/,
    'the title finished leaving in a hidden tab',
  );

  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  player.timers.runOf(CARD_TITLE_OUT_MS);
  assert.equal(player.titleLayer.hidden, true, 'the title never finished leaving');
});

test('a lead with no name to raise keeps the card it always had', async (t) => {
  const cards = leadCards();
  delete cards.intro.narration;
  const player = await mount(t, { cards, story: leadStory() });
  player.begin();
  player.video.dispatch('playing');
  await settle();
  player.video.dispatch('ended');
  await settle();

  // The words come off the narration block. Without one there is no name to
  // show, and a lone sprite held for five seconds over a film that has stopped
  // is worse than the short beat it would replace.
  assert.equal(player.titleLayer.hidden, true, 'a card with no name raised a title anyway');
  assert.throws(() => player.timers.runOf(CARD_TITLE_HOLD_MS), /no timer was armed/);
  player.timers.runOf(CARD_HOLD_MS);
  player.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.equal(player.controls.hidden, false, 'the story never began');
});



test('a lead with no idle to stand in is still drawn', (t) => {
  // Facing right first, then left — pinned by the mounted beat. What is left is
  // the two below: an idle this world keys differently, and a character with no
  // idle at all, whose first clip of anything is still a picture of it.
  const facing = bareTitle(t, {
    story: oneCharacter({
      capability: { idle: { camera: 'still' } },
      clips: { still: { spritesheet: 'bucket/still.png' } },
    }),
  });
  facing.title.reveal(TITLE);
  assert.deepEqual(facing.said(), []);
  assert.ok(facing.drawn().length > 0, 'an idle keyed at the camera drew nothing');

  const busy = bareTitle(t, {
    story: oneCharacter({
      capability: { move: { left: 'walk' } },
      clips: { walk: { spritesheet: 'bucket/walk.png' } },
    }),
  });
  busy.title.reveal(TITLE);
  assert.deepEqual(busy.said(), []);
  assert.ok(busy.drawn().length > 0, 'a character with no idle at all left a hole on the card');
});

test('every way a lead can answer badly is one line, and a card that still plays', (t) => {
  const cases = [
    [{ capability: {}, clips: {} }, /carries no clip to stand in/],
    [{ capability: { idle: { right: 'gone' } }, clips: {} }, /carries no clip to stand in/],
    [{ capability: { idle: { right: 'bare' } }, clips: { bare: {} } }, /no sheet behind it/],
    [
      { capability: { idle: { right: 'far' } }, clips: { far: { spritesheet: 'https://elsewhere.example/far.png' } } },
      /could not be addressed/,
    ],
  ];
  for (const [member, expected] of cases) {
    const beat = bareTitle(t, { story: oneCharacter(member) });
    beat.title.reveal(TITLE);
    assert.equal(beat.said().length, 1, `${expected} said ${beat.said().length} lines`);
    assert.match(beat.said()[0], expected);
    // Said, and then the card carries on: the name IS the beat, the lead was
    // company, and the story behind it is untouched either way.
    assert.equal(beat.layer.hidden, false);
    assert.equal(beat.name.textContent, TITLE);
    assert.equal(beat.drawn().length, 0);
  }
});

test('a sheet the cache never held is named once, whatever the loop is asked', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist), cache: emptyCache() });
  beat.title.reveal(TITLE);
  beat.frames.advanceTo(400);
  beat.frames.advanceTo(800);
  assert.deepEqual(beat.said(), ['the lead’s sprite sheet was not ready when the title card began']);
  assert.equal(beat.drawn().length, 0);
  assert.equal(beat.name.textContent, TITLE);
});

test('the sprite freezes with the tab and comes back with it', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();
  assert.ok(player.frames.pending() > 0, 'the sprite loop never started — this test proves nothing');

  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  // The film is frozen and the music is paused; a sprite still breathing over
  // them is the tell that the beat was never really stopped.
  assert.equal(player.frames.pending(), 0, 'the sprite kept looping over a frozen card');

  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  assert.ok(player.frames.pending() > 0, 'the sprite never came back with the tab');
  playOutTitle(player);
  await settle();
  assert.equal(player.controls.hidden, false);
});

test('a teardown mid-fade takes the title with it', async (t) => {
  const player = await mountLead(t);
  player.begin();
  player.video.dispatch('playing');
  player.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  await settle();
  player.video.dispatch('ended');
  await settle();
  playOutTitle(player);
  await settle();
  assert.equal(player.titleLayer.hidden, false, 'the fade never started — this test proves nothing');

  player.handle.destroy();
  assert.equal(player.titleLayer.hidden, true, 'a torn-down player left its title on the page');
});

test('the stylesheet really takes a hidden card layer off the screen', () => {
  const css = fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8');

  // The same weak-`hidden` trap `.quiet-button[hidden]`, `.end-overlay[hidden]`
  // and `.subtitle-wrap[hidden]` are each spelled out for: the layer is laid out
  // by a `display` of its own, and any `display:` beats the UA rule behind the
  // attribute. Without this line every test above passes while a real browser
  // plays the whole story behind an opaque card.
  assert.match(
    css,
    /\.card-layer\[hidden\]\s*\{[^}]*display:\s*none/,
    'styles.css does not force the hidden card layer to actually disappear',
  );
  // And nothing on it filters: a full-frame blur over a playing video is the
  // cost the stage refuses everywhere else.
  assert.doesNotMatch(css.replaceAll(/\/\*[\s\S]*?\*\//g, ''), /\.card-[a-z]+[^{}]*\{[^}]*filter:/);

  // The curtain is one fade written in two places. Shorten the timer and the
  // layer is taken away mid-fade; lengthen it and a transparent layer sits over
  // the story taking the clicks meant for it.
  const fade = css.match(/\.card-layer\s*\{[^}]*transition:\s*opacity\s*(\d+)ms/);
  assert.ok(fade, 'no transition on .card-layer — the curtain is a cut now');
  assert.equal(Number(fade[1]), CARD_CURTAIN_MS, 'the curtain timer and the stylesheet disagree');

  // A curtain drawn while the arrival is still in flight must still be the
  // curtain: these selectors weigh the same, so the fade is spelled out on
  // `is-gone` as well and placed after them.
  const gone = css.match(/\.card-layer\.is-gone\s*\{[^}]*transition:\s*opacity\s*(\d+)ms/);
  assert.ok(gone, 'a card skipped during its own arrival fades at the arrival’s speed');
  // The SECOND half of the curtain. The first is the film going under the ink
  // at the reveal's own speed; what is left of the beat is the ink going out.
  assert.equal(Number(gone[1]), CARD_CURTAIN_OUT_MS, 'the curtain’s two halves and the stylesheet disagree');
  assert.equal(CARD_CURTAIN_OUT_MS + CARD_REVEAL_MS, CARD_CURTAIN_MS, 'the two halves no longer make the curtain');

  // The arrival is one fade written in two places too, and the film comes out of
  // the black over the same number the black arrived in.
  const black = css.match(/\.card-layer\.is-arriving,\s*\.card-layer\.is-dark\s*\{[^}]*transition:\s*opacity\s*(\d+)ms/);
  assert.ok(black, 'nothing fades the card layer up — the opening is a cut to black now');
  assert.equal(Number(black[1]), CARD_REVEAL_MS, 'the reveal timer and the stylesheet disagree');
  const film = css.match(/\.card-video\s*\{[^}]*transition:\s*opacity\s*(\d+)ms/);
  assert.ok(film, 'the film is not faded up — it pops out of the black');
  assert.equal(Number(film[1]), CARD_REVEAL_MS, 'the film’s reveal and the stylesheet disagree');
  // And `is-arriving` is the transparent state the reflow in `openOnBlack` is
  // forced for: without a rule making it transparent there is nothing to fade.
  assert.match(css, /\.card-layer\.is-arriving\s*\{[^}]*opacity:\s*0/);
  // The film is what the black is IN FRONT OF. Without this the layer's own ink
  // is never uncovered: the card fades up film-and-all in the same 250 ms, the
  // classes above still come and go in the right order, and the black beat the
  // whole arrival exists for is simply not there.
  assert.match(
    css,
    /\.card-layer\.is-arriving\s+\.card-video,\s*\.card-layer\.is-dark\s+\.card-video\s*\{[^}]*opacity:\s*0/,
    'nothing hides the film under the black — the opening is a cut again',
  );
});

test('the stylesheet keeps the title beat off the card it outlives', () => {
  const css = fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8');

  // The same weak-`hidden` trap as the card layer, and the same consequence: a
  // title that cannot leave the screen sits over every story that follows it.
  assert.match(
    css,
    /\.card-title\[hidden\]\s*\{[^}]*display:\s*none/,
    'styles.css does not force the hidden title layer to actually disappear',
  );
  // It covers the whole stage while the story plays underneath, so a layer that
  // took clicks would take the ones meant for the picture.
  assert.match(css, /\.card-title\s*\{[^}]*pointer-events:\s*none/);
  // Above the card it outlives — a title that fades WITH the film leaves the
  // story opening on nothing.
  const above = css.match(/\.card-title\s*\{[^}]*z-index:\s*(\d+)/);
  const card = css.match(/\.card-layer\s*\{[^}]*z-index:\s*(\d+)/);
  assert.ok(above && card, 'neither layer says where it sits — the stacking is an accident now');
  assert.ok(Number(above[1]) > Number(card[1]), 'the title is drawn under the card it has to outlive');

  // Both fades are one number written in two places, exactly like the curtain.
  const shown = css.match(/\.card-title\s*\{[^}]*transition:\s*opacity\s*(\d+)ms/);
  assert.ok(shown, 'the title pops onto the held frame instead of fading in');
  assert.equal(Number(shown[1]), CARD_TITLE_FADE_MS, 'the title fade and the stylesheet disagree');
  const out = css.match(/\.card-title\.is-fading\s*\{[^}]*transition:\s*opacity\s*(\d+)ms/);
  assert.ok(out, 'the title is cut off the story rather than faded off it');
  assert.equal(Number(out[1]), CARD_TITLE_OUT_MS, 'the slow fade and the stylesheet disagree');

  // And the two levels the fades run between. Without these the layer is laid
  // out at nothing for ever: the film ends, the card holds its three seconds on
  // a blank frame, the name is spoken over nothing, and every JS assertion
  // above still passes because the class really is on the element.
  assert.match(css, /\.card-title\s*\{[^}]*opacity:\s*0/, 'the title has no transparent state to fade from');
  assert.match(css, /\.card-title\.is-shown\s*\{[^}]*opacity:\s*1/, 'nothing ever makes the title visible');

  // The sprite is sized against this layer, which `inset: 0` makes definite —
  // never against the window. An embedded player is a box on somebody's page,
  // and a `vh` sprite is two thirds of a phone's screen inside a 16:9 frame a
  // third of it tall, with the name pushed off the bottom edge.
  const box = css.match(/\.card-title\s*\{([^}]*)\}/);
  assert.ok(box && /inset:\s*0/.test(box[1]) && /display:\s*flex/.test(box[1]), 'the title layer is not a definite box');
  const sprite = css.match(/\.card-title-sprite\s*\{([^}]*)\}/);
  assert.ok(sprite, 'no .card-title-sprite rule — this reader is stale, not the stylesheet');
  assert.doesNotMatch(sprite[1], /\d(vh|vw)/, 'the sprite is sized against the window rather than the player');
  assert.match(sprite[1], /height:\s*\d+%/, 'the sprite is not sized against the layer it sits in');
});

test('a name whose length lands while the tab is away does not run the ending in the dark', async (t) => {
  const { player, spoken } = await openBeat(t);
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');

  // A hidden tab does not stop a file loading, so the one thing the beat was
  // waiting for can arrive after the beat has been stopped by hand. Armed on
  // it, the held frame, the curtain and the title's fade would run out unwatched
  // and the viewer would come back to a story already begun with nothing over
  // it — which is the exact failure `holdCard` clears the hold to prevent.
  spoken.duration = 4.1;
  spoken.listeners.get('loadedmetadata')({ type: 'loadedmetadata' });
  assert.throws(
    () => player.timers.runOf(4_100 + CARD_TITLE_TAIL_MS),
    /no timer was armed/,
    'the ending was let go of while nobody was watching',
  );

  // The length is still learned. It is the arming that waits for the viewer.
  document.visibilityState = 'visible';
  document.dispatch('visibilitychange');
  player.timers.runOf(4_100 + CARD_TITLE_TAIL_MS);
  assert.equal(player.layer.classList.contains('is-gone'), true, 'the beat came back at the wrong length');
});

test('a title told to leave while the tab is away waits for it to come back', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist) });
  beat.title.reveal(TITLE);
  beat.title.freeze();

  // The curtain can reach its second half after the tab has gone: the phase is
  // over by then, so nothing hands this beat a second freeze. A fade counted
  // down in the dark takes the title away before the viewer is back to read it.
  beat.title.leave();
  assert.throws(
    () => beat.timers.runOf(CARD_TITLE_OUT_MS),
    /no timer was armed/,
    'the title counted its own way out with the tab away',
  );

  beat.title.thaw();
  beat.timers.runOf(CARD_TITLE_OUT_MS);
  assert.equal(beat.layer.hidden, true, 'the title was left on the page');
});

test('a title that throws after the film has already stalled is still named', async (t) => {
  const card = bareCard(t, {
    title: recordingTitle({ reveal() { throw new Error('no canvas'); } }),
  });
  card.phase.playIntro();
  // A film that buffered once has spoken under its own url, and one line per
  // file is the rule. The beat failing is a different thing that went wrong
  // with the same card, and it is the only word on why the opening it
  // recovered into carries no name.
  card.video.dispatch('stalled');
  assert.match(card.warnings.at(-1).message, /stalled/, 'the film never spoke — this test proves nothing');
  card.video.dispatch('playing');
  card.video.dispatch('ended');
  assert.match(
    card.warnings.at(-1).message,
    /the title card could not be raised/,
    'the film’s own line swallowed the only word about the missing title',
  );
});

test('a second performance whose sheet is merely late is named for that', (t) => {
  const beat = bareTitle(t, { story: oneCharacter(soloist), cache: brokenCache() });
  beat.title.warm();
  return Promise.resolve().then(() => {
    beat.title.reveal(TITLE);
    beat.title.clear();
    // The replay's sheet did not refuse — it had not arrived. A refusal
    // remembered across the performance that owned it leaves the second one
    // with a hole beside the name and a log with nothing in it at all.
    beat.title.reveal(TITLE);
    assert.deepEqual(
      beat.said().slice(1),
      ['the lead’s sprite sheet was not ready when the title card began'],
      'the performance before it did the replay’s talking',
    );
  });
});

test('a sheet gone by the replay is not blamed on the memory budget', async (t) => {
  let held = true;
  const drawable = { width: 64, height: 64 };
  const beat = bareTitle(t, {
    story: oneCharacter(soloist),
    cache: { has: () => held, get: () => (held ? drawable : null), load: async () => drawable },
  });
  beat.title.warm();
  await settle();
  beat.title.reveal(TITLE);
  beat.title.clear();

  // Which of the two sentences is true is a fact about THIS performance. A
  // sheet that decoded for the one before and has since gone is, to the replay,
  // a sheet still on the wire — the budget had nothing to do with it.
  held = false;
  beat.title.reveal(TITLE);
  assert.deepEqual(
    beat.said(),
    ['the lead’s sprite sheet was not ready when the title card began'],
    'the replay was told about a memory budget it never hit',
  );
});

test('a replayed opening takes down the title the last one left standing', async (t) => {
  const title = recordingTitle();
  const card = bareCard(t, { title });
  card.phase.playIntro();
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  card.video.dispatch('ended');
  playOutTitle(card);
  await settle();
  assert.equal(title.calls.at(-1), 'leave', 'the way out never started — this test proves nothing');

  // The title is still fading when the curtain ends, and a replay can land
  // inside that. Left standing, the old name watches the new film — and its own
  // fade then takes the NEW title down behind it.
  card.phase.playIntro();
  assert.equal(title.calls.at(-1), 'clear', 'a replay was watched through the title of the card before it');
});

test('a cancel mid-fade takes the title with it', async (t) => {
  const title = recordingTitle();
  const card = bareCard(t, { title });
  card.phase.playIntro();
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS); // out of the arrival's black, as a real card is
  card.video.dispatch('ended');
  playOutTitle(card);
  await settle();
  assert.equal(title.calls.at(-1), 'leave', 'the way out never started — this test proves nothing');

  // A scrub out of the end, a replay from the end screen: whatever the title
  // was fading over is gone, so it has nothing left to fade over.
  card.phase.cancel();
  assert.equal(title.calls.at(-1), 'clear', 'a cancelled story kept the last card’s name over it');
});

test('an end card that carries a name of its own still raises no title', async (t) => {
  const cards = cardBlocks();
  const title = recordingTitle();
  const card = bareCard(t, {
    title,
    cards: { ...cards, end_card: { ...cards.end_card, narration: cards.intro.narration } },
  });
  card.phase.playEnd();
  card.video.dispatch('playing');
  card.video.dispatch('ended');

  // The beat is the OPENING's ending. A closing film that happens to carry a
  // narration block would otherwise raise the story's name and its lead over
  // the credits and hold six seconds for it.
  assert.equal(title.calls.includes('reveal'), false, 'the end card raised the opening’s title');
  assert.throws(
    () => card.timers.runOf(CARD_TITLE_HOLD_MS),
    /no timer was armed/,
    'the end card held for a title beat it does not have',
  );
  card.timers.runOf(CARD_HOLD_MS);
  assert.equal(card.layer.classList.contains('is-backdrop'), true, 'the end card did not become the backdrop');
});


test('the curtain takes the picture down before it takes the layer', async (t) => {
  const card = bareCard(t);
  const done = [];
  card.phase.playIntro().then(() => done.push('gone'));
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS);
  assert.equal(card.layer.classList.contains('is-dark'), false, 'the film never came out of the black');
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);

  // The film goes first, under the layer's own ink. A card that dissolved
  // straight into the story reads as nothing at all — one lit forest over
  // another — which is the whole reason the ending has a black beat.
  assert.equal(card.layer.classList.contains('is-dark'), true, 'the curtain dissolved the film into the story');
  assert.equal(card.layer.classList.contains('is-gone'), false, 'the ink went out with the picture still on it');

  card.timers.runOf(CARD_REVEAL_MS);
  assert.equal(card.layer.classList.contains('is-gone'), true, 'the black never went out onto the story');
  assert.equal(card.layer.classList.contains('is-dark'), true, 'the film came back up inside the curtain');

  card.timers.runOf(CARD_CURTAIN_MS);
  await settle();
  assert.deepEqual(done, ['gone'], 'the phase promise never settled');
  assert.equal(card.layer.hidden, true);
});

test('a skip goes through the same black as an ending', async (t) => {
  const card = bareCard(t);
  card.phase.playIntro();
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS);
  card.skip.dispatch('click');

  // A viewer who skips wants out, not a title card — but they get the same
  // ending, at once instead of after the hold.
  assert.equal(card.layer.classList.contains('is-dark'), true, 'the skip dissolved the film into the story');
  assert.equal(card.layer.classList.contains('is-gone'), false);
  card.timers.runOf(CARD_REVEAL_MS);
  assert.equal(card.layer.classList.contains('is-gone'), true);
});

test('a teardown inside the black beat still settles the story’s promise', async (t) => {
  const card = bareCard(t);
  const done = [];
  card.phase.playIntro().then(() => done.push('gone'));
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS);
  card.skip.dispatch('click');
  assert.equal(card.layer.classList.contains('is-gone'), false, 'the black beat never started — this proves nothing');

  // Between the picture going down and the ink going out there is a timer of
  // its own, and a phase torn down across it must not leave the story waiting.
  card.phase.destroy();
  await settle();
  assert.deepEqual(done, ['gone']);
  assert.throws(
    () => card.timers.runOf(CARD_REVEAL_MS),
    /no timer was armed/,
    'the black beat was left running after the teardown',
  );
});

test('the end card stays, and the end screen is written over its last frame', async (t) => {
  const card = bareCard(t);
  const done = [];
  card.phase.playEnd().then(() => done.push('gone'));
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS);
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);
  await settle();

  // The phase is over the moment the hold is — that is what brings the end
  // screen and the transport back — but the picture is not: the closing film's
  // last frame is the ground the end screen stands on.
  assert.deepEqual(done, ['gone'], 'the end screen was left waiting on a phase that never settled');
  assert.equal(card.layer.hidden, false, 'the end screen has nothing to stand on');
  assert.equal(card.layer.classList.contains('is-backdrop'), true);
  assert.equal(card.layer.classList.contains('is-gone'), false, 'the last frame was faded out from under the end screen');

  // The music is the one thing that does leave, over the length the curtain
  // used to take. An end screen is a quiet place.
  const music = card.audio.find((a) => (a.url || '').includes('end-music'));
  assert.ok(music, 'the end card played no music — this test proves nothing');
  assert.equal(music.paused, false, 'the music was cut rather than faded');
  card.timers.runOf(CARD_CURTAIN_MS);
  assert.equal(music.paused, true, 'the end card’s music played on under the end screen');
});

test('scrubbing back out of the end takes the backdrop with it', async (t) => {
  const card = bareCard(t);
  card.phase.playEnd();
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS);
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);
  await settle();
  assert.equal(card.layer.classList.contains('is-backdrop'), true, 'the backdrop never came up');

  // A story dragged back into is not one that ended: the closing film's frame
  // has no business over the scene the pointer landed on.
  card.phase.cancel();
  assert.equal(card.layer.hidden, true, 'the end card stayed over a story that started again');
  assert.equal(card.layer.classList.contains('is-backdrop'), false, 'the backdrop class outlived the backdrop');
});

test('a hidden tab takes the end card’s music but leaves its picture', async (t) => {
  const card = bareCard(t);
  card.phase.playEnd();
  card.video.dispatch('playing');
  card.timers.runOf(CARD_REVEAL_MS);
  card.video.dispatch('ended');
  card.timers.runOf(CARD_HOLD_MS);
  await settle();
  const music = card.audio.find((a) => (a.url || '').includes('end-music'));

  // The frame is staying either way — it is a backdrop, not a fade. The music
  // cannot wait: a hidden tab clamps its steps and it would be cut, not faded.
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.equal(music.paused, true, 'the music went on in a pocket');
  assert.equal(card.layer.hidden, false, 'the end screen lost the frame it stands on');
  assert.equal(card.layer.classList.contains('is-backdrop'), true);
});

test('the stylesheet puts the backdrop under the end screen and the transport', () => {
  const css = fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8');
  const backdrop = css.match(/\.card-layer\.is-backdrop\s*\{([^}]*)\}/);
  assert.ok(backdrop, 'no .card-layer.is-backdrop rule — the end card is still a card');
  const depth = Number(backdrop[1].match(/z-index:\s*(\d+)/)?.[1]);
  const end = Number(css.match(/\.end-overlay\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
  const bar = Number(css.match(/\.controls\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
  const stage = Number(css.match(/\.stage-canvas\s*\{[^}]*z-index:\s*(\d+)/)?.[1]);
  assert.ok(depth < end, `the end screen is behind the frame it is written on (${depth} vs ${end})`);
  assert.ok(depth < bar, `the transport is behind the backdrop (${depth} vs ${bar})`);
  assert.ok(depth > stage, `the backdrop is behind the story it replaces (${depth} vs ${stage})`);
  // Nothing to click and nothing to skip: the card is over.
  assert.match(backdrop[1], /pointer-events:\s*none/);
  assert.match(css, /\.card-layer\.is-backdrop\s+\.card-skip\s*\{[^}]*display:\s*none/);
});

const floorZone = {
  name: 'floor', surface: 'floor', description: '', depth: null, scale: null,
  polygon: [[20, 80], [80, 80], [80, 100], [20, 100]],
};

const plateOf = (name) => ({
  video: `bucket/${name}.mp4`,
  poster: `bucket/${name}.jpg`,
  resolution: [1920, 1080],
  default_zone: 'floor',
  zones: [floorZone],
});

const soloist = {
  height_cm: 70,
  capability: { idle: { left: 'moth-idle-left', right: 'moth-idle-right' } },
  clips: {
    'moth-idle-left': { spritesheet: 'bucket/moth-left.png', frames: 4, fps: 8, grid: [4, 1] },
    // The one the card is meant to pick: idle, facing right, and a ladder to
    // read it off. `renditionGrid` re-grids a 4x1 strip into 2x2, which is
    // exactly the trap a card drawing from the bundle's own grid would fall in.
    'moth-idle-right': {
      spritesheet: 'bucket/moth-right.png',
      frames: 4,
      fps: 8,
      grid: [4, 1],
      // A ladder rather than one step, so which tier the card asks for is a
      // decision this fixture can catch it making.
      renditions: { 200: 'bucket/moth-right-200.webp', 512: 'bucket/moth-right-512.webp' },
    },
  },
};

const LEAD = 'moth';
const SPRITE = `${ASSET_BASE}bucket/moth-right-200.webp`;
const SHARPER_SPRITE = `${ASSET_BASE}bucket/moth-right-512.webp`;

/**
 * The card phase's title beat with none of the player around it.
 *
 * Everywhere else the beat is watched through a mounted story, which is the
 * right way round for every question but two: what a lead the bundle answers
 * badly does, and what the loop draws frame by frame. Both are about this
 * module alone, and reaching them through a mount would mean a whole fixture
 * story per branch.
 */
function bareTitle(t, { story, lead = LEAD, cache = heldSheet(), canvas = fakeElement('canvas') } = {}) {
  const dom = installDom();
  const frames = virtualFrames();
  const timers = installTimers();
  const elements = { layer: fakeElement('div'), canvas, name: fakeElement('p') };
  const warnings = [];
  const title = createCardTitle({
    elements, story, assetBase: ASSET_BASE, lead, cache, onWarning: (w) => warnings.push(w),
  });
  t.after(() => {
    title.clear();
    timers.restore();
    frames.restore();
    dom.restore();
  });
  return {
    ...elements,
    title,
    frames,
    timers,
    said: () => warnings.map(({ message }) => message),
    loaded: () => cache.asked ?? [],
    drawn: () => (elements.canvas.context?.calls ?? []).filter(([name]) => name === 'drawImage'),
  };
}

/** A cache holding one decoded sheet, and one holding nothing. */
function heldSheet({ width = 64, height = 64 } = {}) {
  const drawable = { width, height };
  const asked = [];
  return {
    asked, has: () => true, get: () => drawable, load: async (url) => { asked.push(url); return drawable; },
  };
}

function emptyCache() {
  const asked = [];
  return { asked, has: () => false, get: () => null, load: async (url) => { asked.push(url); return null; } };
}

/** A cache whose decode fails, which is not the same as one still fetching. */
function brokenCache() {
  const asked = [];
  return {
    asked,
    has: () => false,
    get: () => null,
    load: async (url) => {
      asked.push(url);
      throw new Error('no');
    },
  };
}

function oneCharacter(member) {
  return { cast: { [LEAD]: member } };
}

/**
 * The lead is cast but never staged, which is the point: the sheet the title
 * beat draws from is then the CARD's own fetch rather than one the opening
 * scene had already put in the cache, so "was it ready?" is a real question.
 */
function leadStory() {
  const story = cardStory();
  return { ...story, cast: { ...story.cast, [LEAD]: soloist } };
}

function leadCards(lead = LEAD) {
  const cards = cardBlocks();
  cards.intro.lead = lead;
  return cards;
}

function mountLead(t, lead = LEAD) {
  return mount(t, { cards: leadCards(lead), story: leadStory() });
}

/** The ending of a card that has a title to raise: a longer beat, then the fade. */
function playOutTitle(player) {
  player.timers.runOf(CARD_TITLE_HOLD_MS);
  // The curtain is two beats now: the film goes under the black, and then the
  // black — and the title with it — goes out onto the story.
  player.timers.runOf(CARD_REVEAL_MS);
  player.timers.runOf(CARD_CURTAIN_MS);
}

function sprites(player) {
  return (player.titleCanvas.context?.calls ?? []).filter(([name]) => name === 'drawImage');
}

const walker = {
  height_cm: 90,
  capability: { idle: { camera: 'idle' }, move: { left: 'move-left', right: 'move-right' } },
  clips: {
    idle: { spritesheet: 'bucket/idle.png' },
    'move-left': { spritesheet: 'bucket/left.png' },
    'move-right': { spritesheet: 'bucket/right.png' },
  },
};

/**
 * Two scenes, so "the last one" is a scene the story reaches rather than opens
 * on, and somebody on stage in the first — a scene with nobody in it decodes
 * nothing, and the gate in front of the curtain would have nothing to wait for.
 */
function cardStory() {
  return {
    storylang_version: 0,
    title: TITLE,
    cast: { ruby: walker },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [
      {
        line: 1,
        place: 'dell',
        time: 'day',
        plate: plateOf('dell'),
        steps: [
          { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: null, facing: null },
          { kind: 'chunk', line: 3, text: 'A beat.', duration_s: 2 },
        ],
      },
      {
        line: 3,
        place: 'pond',
        time: 'dusk',
        plate: plateOf('pond'),
        steps: [{ kind: 'chunk', line: 4, text: 'Another.', duration_s: 2 }],
      },
    ],
  };
}

/** The shape where the first scene is also the last one. */
function oneSceneStory() {
  const whole = cardStory();
  return { ...whole, scenes: whole.scenes.slice(0, 1) };
}

function cardBlocks() {
  return {
    intro: {
      video: 'bucket/intro.mp4',
      music: 'bucket/intro-music.mp3',
      narration: { text: TITLE, audio: 'jobs/story-7/audio/title.wav' },
    },
    end_card: { video: 'bucket/end.mp4', music: 'bucket/end-music.mp3' },
  };
}

function platesOf(bundle) {
  const block = {};
  for (const scene of bundle.scenes) (block[scene.place] ??= {})[scene.time] = scene.plate;
  return block;
}

/**
 * Every timer the player arms, held rather than run.
 *
 * A card is two timers and a `<video>`: the delay before the story's name is
 * read, and the bound on a film that never starts. Both are fired by name here,
 * so a test says which instant it is standing at instead of sleeping through it.
 */
function installTimers() {
  const held = new Map();
  const setOriginal = globalThis.setTimeout;
  const clearOriginal = globalThis.clearTimeout;
  let id = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    id += 1;
    held.set(id, { callback, milliseconds });
    return id;
  };
  globalThis.clearTimeout = (key) => { held.delete(key); };
  return {
    runOf(milliseconds) {
      let ran = 0;
      for (const [key, timer] of [...held]) {
        if (timer.milliseconds !== milliseconds) continue;
        held.delete(key);
        timer.callback();
        ran += 1;
      }
      assert.ok(ran > 0, `no timer was armed for ${milliseconds}ms`);
    },
    restore() {
      globalThis.setTimeout = setOriginal;
      globalThis.clearTimeout = clearOriginal;
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

/**
 * The whole of a card's ending, which is two instants rather than one: the beat
 * the last frame is held for, and the curtain that follows it. A test standing
 * between them is standing inside the ending, not after it.
 */
function playOut(player) {
  player.timers.runOf(CARD_HOLD_MS);
  player.timers.runOf(CARD_CURTAIN_MS);
}

/**
 * The card phase with none of the player around it.
 *
 * Everywhere else a card is watched through what the story does afterwards,
 * which is the right way round for every question but one: the promise itself.
 * The law this file is written around is that it always settles, and every
 * ending now defers it to the end of a fade — so here it is the return value
 * rather than something inferred from a transport coming back.
 */
function bareCard(t, { title = null, cards = cardBlocks() } = {}) {
  const dom = installDom();
  const audio = installAudio();
  const timers = installTimers();
  const elements = {
    layer: fakeElement('div'),
    video: fakeElement('video'),
    line: fakeElement('p'),
    skip: fakeElement('button'),
  };
  const warnings = [];
  const phase = createCardPhase({
    elements,
    cards,
    title,
    onWarning: (warning) => warnings.push(warning),
  });
  t.after(() => {
    phase.destroy();
    timers.restore();
    audio.restore();
    dom.restore();
  });
  return { ...elements, phase, timers, audio: audio.opened, warnings };
}

/** A title that answers every call by writing down that it was called. */
function recordingTitle(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push(name);
    overrides[name]?.(...args);
  };
  return {
    calls,
    warm: record('warm'),
    reveal: record('reveal'),
    freeze: record('freeze'),
    thaw: record('thaw'),
    leave: record('leave'),
    clear: record('clear'),
  };
}

/**
 * Every asset fetch from here on, held until the returned function is called.
 *
 * The one seam that makes "was the story begun before its scene had decoded?" a
 * question with a definite answer rather than a race against node's scheduler.
 */
function holdAssets() {
  const original = globalThis.fetch;
  const waiting = [];
  let released = false;
  globalThis.fetch = (...args) => new Promise((resolve, reject) => {
    if (released) {
      Promise.resolve(original(...args)).then(resolve, reject);
      return;
    }
    waiting.push(() => Promise.resolve(original(...args)).then(resolve, reject));
  });
  return () => {
    released = true;
    for (const go of waiting.splice(0)) go();
  };
}

async function mount(t, {
  cards = cardBlocks(), published = null, stream = null, assets = () => ({}), story = cardStory(),
} = {}) {
  const whole = story;
  const dom = installDom({ assets });
  const frames = virtualFrames();
  const audio = installAudio();
  const timers = installTimers();
  let handle = null;
  t.after(() => handle?.destroy());
  t.after(() => {
    timers.restore();
    audio.restore();
    frames.restore();
    dom.restore();
  });

  const host = document.createElement('div');
  const scenes = published === null ? whole.scenes : whole.scenes.slice(0, published);
  handle = createStoryPlayer(host, {
    story: { ...whole, scenes },
    assetBase: ASSET_BASE,
    ...(stream ? { plates: platesOf(whole), stream } : {}),
    ...(cards ? { cards } : {}),
  });
  await handle.ready;

  const root = host.shadowRoot;
  const fetched = dom.fetched;
  const timeline = compileTimeline({ ...whole, scenes: whole.scenes }, { plates: platesOf(whole) });
  return {
    handle,
    frames,
    timers,
    fetched,
    audio: audio.opened,
    duration: timeline.duration_ms,
    sceneOpensAt: (index) => timeline.events.find(
      (event) => event.op === 'scene' && event.scene_index === index,
    ).t_ms,
    appendScene: (index) => handle.appendScene(structuredClone(whole.scenes[index])),
    begin: () => findByClass(root, 'start-button').dispatch('click'),
    log: () => findByClass(root, 'event-list').children
      .map((entry) => entry.childNodes.at(-1)?.textContent ?? '').join('\n'),
    layer: findByClass(root, 'card-layer'),
    video: findByClass(root, 'card-video'),
    line: findByClass(root, 'card-line'),
    skip: findByClass(root, 'card-skip'),
    titleLayer: findByClass(root, 'card-title'),
    titleName: findByClass(root, 'card-title-name'),
    titleCanvas: findByClass(root, 'card-title-sprite'),
    plate: findByClass(root, 'plate-video'),
    ceremony: findByClass(root, 'start-ceremony'),
    controls: findByClass(root, 'controls'),
    waiting: findByClass(root, 'waiting-overlay'),
    end: findByClass(root, 'end-overlay'),
    badge: findByClass(root, 'story-scene'),
    title: findByClass(root, 'start-ceremony').children.find((node) => node.tag === 'h1'),
    start: findByClass(root, 'start-button'),
    toggle: findByClass(root, 'play-button'),
    at: findByClass(root, 'time-at'),
    total: findByClass(root, 'time-total'),
    frame: findByClass(root, 'stage-frame'),
  };
}
