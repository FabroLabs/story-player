/**
 * The intro card's ending: the story's name, and the character it is about.
 *
 * A world's intro film is shared by every story told in it, so the film alone
 * never says which story this is. The name used to be read a second into the
 * picture and written across it while it moved — over an establishing shot, at
 * the moment a viewer is still reading the frame. The beat below is where a
 * title sequence actually puts it: the film plays out, its last frame is held,
 * and the name fades in over that held frame with the lead standing beside it,
 * alive in its idle loop.
 *
 * Two rules shape everything here.
 *
 * It outlives the FILM, not the card. The title is not on the card layer — it
 * is its own element above it, so the curtain can take the film out from under
 * the name and leave the name standing on the black. It goes with that black,
 * on the curtain's second half: a title inside the card would be pulled off the
 * moment the film was, and one that outlasted the curtain would still be
 * fading over a scene that had already begun.
 *
 * It never holds the story up, and it never takes the story down. That is
 * `card-phase.mjs`'s law and it reaches in here whole: a lead the story never
 * cast, a character with no clip to stand in, a bundle whose clip is shaped in
 * a way nothing here expects, a sheet that has not decoded by the time the film
 * ends — each is one named line in the log and a beat that plays with the name
 * alone. NOTHING here may throw at its caller: the lead is read inside the
 * player's own constructor, where an exception is a story that will not open at
 * all, and the beat is raised inside the `ended` handler, where one is a phase
 * promise that never settles.
 */

import { frameCell, frameIndexAt } from '../core/clips.mjs';
import { sheetFor } from './assets/rendition-picker.mjs';
import { resolveMediaUrl } from './urls.mjs';

// The FLOOR of the held frame when there is a title to raise over it: long
// enough for the fade below, a spoken name of the ordinary length, and a moment
// of the picture after it.
//
// A floor rather than the whole length, because the line used to have the rest
// of the film to be read over and now has only this. Measured on four real
// builds, a four-to-five word title is spoken in 1.4–2.2 s, which fits — but a
// longer one would be cut mid-word by a card that had already decided how long
// its own ending was, and a title sequence that clips the title is the failure
// this whole beat exists to fix. So the card asks the voice how long it is.
export const CARD_TITLE_HOLD_MS = 3_000;
// And never waits past this, however long the line turns out to be or however
// badly it fails: a story is not held behind its own name.
export const CARD_TITLE_HOLD_CEILING_MS = 6_000;
// The picture after the last syllable. Without it the curtain starts on the
// word, which is the same cut this beat replaced, moved later.
export const CARD_TITLE_TAIL_MS = 600;
// The name and the sprite coming up over the held frame. Matches the transition
// in `styles.css`, pinned by the card's constants test like every other number
// here: a timer and a stylesheet that disagree about a fade is a fade cut in
// half at one end or a dead layer left at the other.
export const CARD_TITLE_FADE_MS = 500;
// The way out, taken with the black rather than after it. The name and the
// sprite belong to the card, so they go when the card does: held over the story
// they are a title sequence still running over a scene that has begun, which is
// the one place they are in the way. Matches the curtain's second half in
// `styles.css` — the ink and the name reach nothing at the same moment.
export const CARD_TITLE_OUT_MS = 450;
// The cell size the lead's sheet is asked for. NOT the sprite's size on a
// device's screen, which is what the stage asks the same ladder for. A scene
// draws its cast from CHUNKS of a tier — a few frames at a time — while a card
// takes a whole sheet, so what this number buys is paid in full and shared with
// nothing: the 200 tier of an eighty-frame idle clip is a 1800x1800 bitmap,
// 12 MB decoded, against the 512 tier's 4608x4608 and 85 MB. Seven times the
// memory on a three-second decoration, held beside the opening scene's own
// sheets. A title card is not where sharpness is spent.
export const CARD_TITLE_CELL_PX = 200;

export function createCardTitle({
  elements, story, assetBase, lead, cache, signal = null, onWarning = () => {},
}) {
  const { layer, canvas, name } = elements;
  const context = canvas.getContext?.('2d') ?? null;
  const named = new Set();
  const sprite = findSprite();
  // The one timer the beat ever has: the fade out, started by the curtain.
  // Held rather than fired and forgotten, because it has to be able to STOP —
  // see `freeze`.
  let waiting = null;
  let frame = null;
  let looping = false;
  let started = 0;
  let frozen = null;
  let decoded = false;
  let refused = false;

  return { warm, reveal, freeze, thaw, leave, clear };

  /**
   * The sheet, asked for while the film is still playing.
   *
   * The whole point of the beat is that it does not wait: the decode is started
   * at the film's first frame and is either there when the film ends or is not,
   * and the card behaves the same either way.
   *
   * Asked EVERY time rather than once per mount. The cache is the thing that
   * knows whether this is a fetch — it shares an in-flight decode and answers a
   * held one instantly — and a replay is exactly the case an "already warmed"
   * flag gets wrong: a whole story's scenes have been decoded since, the card's
   * sheet was evicted under them, and the opening it is replaying would come
   * back without its lead.
   */
  function warm() {
    if (!sprite) return;
    cache.load(sprite.url, { signal }).then(
      () => { decoded = true; },
      (error) => {
        if (error?.name === 'AbortError') return;
        refused = true;
        warn(`the lead’s sprite sheet could not be decoded (${error?.message ?? String(error)})`, sprite.url);
      },
    );
  }

  /** The held frame has the title on it now. */
  function reveal(text) {
    name.textContent = text ?? '';
    layer.hidden = false;
    // The same trap the card layer is opened around: `[hidden]` is
    // `display: none`, and nothing transitions out of that. Reading a layout
    // property is what makes the transparent state a frame of its own.
    layer.getBoundingClientRect?.();
    layer.classList.add('is-shown');
    startLoop();
  }

  /**
   * The tab went away.
   *
   * Everything the beat is made of stops together: the sprite's loop, and the
   * clock the linger is counted on. The story underneath pauses with the tab
   * too, so a linger that ran on in the dark would be a viewer coming back to
   * a story already begun with nothing over it — the same failure the held
   * frame's own beat is stopped by hand to avoid.
   */
  function freeze() {
    if (layer.hidden || frozen !== null) return;
    frozen = now();
    stopLoop();
    holdTimer();
  }

  function thaw() {
    if (frozen === null) return;
    // The loop carries on from the pose it froze on rather than snapping back
    // to the start: a character that jumps a third of the way through its own
    // breath is the one thing a still picture would not have done.
    started += now() - frozen;
    frozen = null;
    armTimer();
    if (looping) tick(now());
  }

  /**
   * The black is going out, and the name goes with it.
   *
   * Started by the curtain's second half rather than by its end: what the two
   * of them uncover is the story, and a name still fading over an opening scene
   * is the card refusing to be over.
   */
  function leave() {
    if (layer.hidden) return;
    layer.classList.add('is-fading');
    after(CARD_TITLE_OUT_MS, clear);
  }

  /** Off NOW: a replay, a second card, a teardown. */
  function clear() {
    stopTimer();
    stopLoop();
    looping = false;
    frozen = null;
    layer.hidden = true;
    layer.classList.remove('is-shown', 'is-fading');
    name.textContent = '';
    // A replay is a new performance and it gets its own lines. Kept, a sheet
    // that failed the first time and fails again would say nothing at all,
    // which is the one thing worse than saying it twice.
    //
    // The two flags that decide WHICH line go with them. `refused` left
    // standing gags a second performance whose sheet merely arrived late —
    // the beat is title-only and the log says nothing at all — and `decoded`
    // left standing blames the memory budget for a sheet still on the wire.
    named.clear();
    refused = false;
    decoded = false;
  }

  /**
   * Which picture of the lead this card stands: its idle loop, facing right.
   *
   * The catalog's faces are left and right only, so the fallbacks walk the same
   * way the stage's own facing fallback does — the other side, then whatever
   * variant of idling this character has. A character with no idle at all is
   * still drawn: the first clip of the first thing it can do is a picture of
   * it, and a title card with a hole in it is worse than one with a still.
   *
   * Wrapped whole, because this runs inside the player's constructor: a bundle
   * whose clip is shaped in a way the sheet reader does not expect throws from
   * three levels down, and the viewer would be told the STORY could not be
   * opened because a decoration could not be measured.
   */
  function findSprite() {
    try {
      return readSprite();
    } catch (error) {
      warn(`the intro card’s lead sprite could not be read (${error?.message ?? String(error)})`);
      return null;
    }
  }

  function readSprite() {
    if (!context) {
      warn('the intro card’s lead has no canvas to be drawn on');
      return null;
    }
    // `cast_bundle` FIRST. A manifest carries both keys and they are not the
    // same block: its `cast` is a slug-to-display-name map, while the cast a
    // player is mounted with — clips, sheets, heights — is `cast_bundle`. A
    // host that joins the two before mounting (the ordinary case) hands over
    // only `cast`, and this falls through to it.
    const casting = story?.cast_bundle ?? story?.cast ?? null;
    if (!casting || !Object.hasOwn(casting, lead)) {
      warn(`the intro card names ${JSON.stringify(lead)}, who is not in this story’s cast`);
      return null;
    }
    const member = casting[lead];
    const pose = poseClip(member?.capability);
    const clip = pose ? member?.clips?.[pose] : null;
    if (!clip) {
      warn(`the intro card’s lead ${JSON.stringify(lead)} carries no clip to stand in`);
      return null;
    }
    const sheet = sheetFor(clip, CARD_TITLE_CELL_PX);
    if (!sheet.url) {
      warn(`the intro card’s lead ${JSON.stringify(lead)} has a clip with no sheet behind it`);
      return null;
    }
    let url;
    try {
      url = resolveMediaUrl(sheet.url, assetBase, 'the intro card’s lead sprite');
    } catch (error) {
      warn(`the intro card’s lead sprite could not be addressed (${error.message})`);
      return null;
    }
    return { url, grid: sheet.grid, fps: clip.fps, frames: clip.frames };
  }

  function startLoop() {
    if (!sprite) return;
    if (!cache.has(sprite.url)) {
      // The film ended before the sheet did. Named for what actually happened:
      // a sheet that failed outright has already said so and is not named
      // twice, and one the cache decoded and then threw away to stay inside its
      // budget is not the same thing as one still on the wire. The beat is
      // shortened for none of them — the name is the card, the sprite was the
      // company.
      if (!refused) warn(missingSheet(), sprite.url);
      return;
    }
    started = now();
    looping = true;
    tick(started);
  }

  function missingSheet() {
    return decoded
      ? 'the lead’s sprite sheet was dropped to stay inside the memory budget'
      : 'the lead’s sprite sheet was not ready when the title card began';
  }

  function tick(at) {
    paint(at);
    frame = globalThis.requestAnimationFrame?.(tick) ?? null;
  }

  function stopLoop() {
    if (frame === null) return;
    globalThis.cancelAnimationFrame?.(frame);
    frame = null;
  }

  /**
   * One cell of the sheet, blitted at its own size.
   *
   * The canvas is backed by exactly one cell and scaled by the stylesheet, so
   * the sprite's size on screen is a CSS question and this is a straight copy.
   * The cell is measured off the bitmap that actually decoded rather than from
   * the tier that was asked for — a sheet served at a size nobody expected then
   * draws the right cell smaller instead of a slice of two wrong ones.
   */
  function paint(at) {
    const drawable = cache.get(sprite.url);
    // Evicted under us: the cache holds the scene on screen ahead of a card's
    // decoration, and a closed bitmap is not something to draw from. Said once,
    // in the same words the beat would have used had it never started.
    if (!drawable) {
      warn(missingSheet(), sprite.url);
      return;
    }
    const [columns, rows] = sprite.grid;
    const width = sourceSize(drawable, 'width') / columns;
    const height = sourceSize(drawable, 'height') / rows;
    if (!(width > 0) || !(height > 0)) return;
    // Assigning either of these CLEARS a real canvas, so they are written only
    // when they change — otherwise every frame would be a resize.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const [column, row] = frameCell(
      frameIndexAt((at - started) / 1000, sprite.fps, sprite.frames), sprite.grid,
    );
    context.clearRect(0, 0, width, height);
    context.drawImage(
      drawable, column * width, row * height, width, height, 0, 0, width, height,
    );
  }

  function after(milliseconds, handler) {
    waiting = { handler, remaining: milliseconds, armedAt: 0, id: null };
    armTimer();
  }

  function armTimer() {
    const held = waiting;
    // A beat the tab stopped stays stopped, whatever reaches it while it is
    // away: `thaw` is the only thing that starts this clock again. A linger
    // armed in the dark runs out there, and the viewer comes back to a story
    // already begun with nothing over it — the failure `freeze` exists for.
    if (!held || held.id !== null || frozen !== null) return;
    held.armedAt = now();
    held.id = setTimeout(() => {
      waiting = null;
      held.handler();
    }, held.remaining);
  }

  function holdTimer() {
    if (!waiting || waiting.id === null) return;
    clearTimeout(waiting.id);
    waiting.id = null;
    waiting.remaining = Math.max(0, waiting.remaining - (now() - waiting.armedAt));
  }

  function stopTimer() {
    if (waiting !== null && waiting.id !== null) clearTimeout(waiting.id);
    waiting = null;
  }

  function now() {
    return globalThis.performance?.now?.() ?? 0;
  }

  /** One line per thing that went wrong, however many frames go past it. */
  function warn(message, url = null) {
    if (named.has(message)) return;
    named.add(message);
    onWarning({ type: 'media', asset: 'intro-card', url, message });
  }
}

function poseClip(capability) {
  const idle = capability?.idle ?? {};
  const pose = idle.right ?? idle.left ?? Object.values(idle)[0];
  if (pose) return pose;
  for (const variants of Object.values(capability ?? {})) {
    const first = Object.values(variants ?? {})[0];
    if (first) return first;
  }
  return null;
}

/** An `ImageBitmap` measures one way and the `Image` fallback the other. */
function sourceSize(drawable, axis) {
  const natural = axis === 'width' ? drawable?.naturalWidth : drawable?.naturalHeight;
  const measured = drawable?.[axis];
  return Number.isFinite(measured) && measured > 0 ? measured : (natural ?? 0);
}
