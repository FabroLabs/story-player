/**
 * The picture a counter on the counting board is drawn as, when the host gave
 * one (`board.counter` at the mount).
 *
 * Fetched and decoded once, at the mount, and held for the life of the player
 * rather than put through the sheet cache: the cache keeps what the scene on
 * screen draws from and evicts the rest under pressure, and a counter picture
 * belongs to every board in the story rather than to any one scene's sheets. A
 * board raised three scenes after the last one would otherwise find its picture
 * gone and fall back to the apple with nothing in the log to say so.
 *
 * What is returned is the answer `sceneSheets` hands the draw list and the
 * stage: `url` says a picture was asked for, `drawable` is it once it has
 * landed and `null` until then — and for good, if the fetch failed, which is
 * named once. The stage draws the apple it always drew in both cases. `landed`
 * is the same answer as a promise, for the one caller that has to act on the
 * instant: nothing about the STATE changes when a picture lands, so a board
 * already settled would otherwise show it at the next thing that moved.
 */

import { decodeDrawable } from './bitmap-cache.mjs';

export function loadCounterPicture(url, { decode = decodeDrawable, signal = null, onWarning = () => {} } = {}) {
  const picture = { url, drawable: null, landed: null, close };
  let closed = false;
  // Settles with the drawable, or with `null` for a picture that is not coming
  // — never left hanging, so a caller waiting on it is always answered.
  picture.landed = decode(url, { signal }).then((drawable) => {
    // Landed after the player went: nothing will draw it, and a bitmap nobody
    // closes is the leak the cache is otherwise careful about.
    if (closed || signal?.aborted) {
      drawable?.close?.();
      return null;
    }
    picture.drawable = drawable;
    return drawable;
  }, (error) => {
    if (closed || error?.name === 'AbortError') return null;
    onWarning({
      type: 'media',
      asset: 'board-counter',
      url,
      message: `the board's counter picture could not be loaded: ${error?.message ?? String(error)}`,
    });
    return null;
  });
  return picture;

  function close() {
    closed = true;
    picture.drawable?.close?.();
    picture.drawable = null;
  }
}
