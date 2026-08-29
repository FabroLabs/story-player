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
  CARD_DUCKED_MUSIC_VOLUME,
  CARD_HOLD_MS,
  CARD_LINE_DELAY_MS,
  CARD_MUSIC_FADE_STEP_MS,
  CARD_MUSIC_VOLUME,
  CARD_READY_TIMEOUT_MS,
  CARD_REVEAL_MS,
  createCardPhase,
} from '../browser/v0/app/card-phase.mjs';
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
  assert.equal(Number(gone[1]), CARD_CURTAIN_MS, 'the curtain timer and the stylesheet disagree');

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
function bareCard(t) {
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
    cards: cardBlocks(),
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
  const timeline = compileTimeline({ ...whole, scenes: whole.scenes }, { plates: platesOf(whole) });
  return {
    handle,
    frames,
    timers,
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
