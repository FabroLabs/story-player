/**
 * Decoded sheets, held to a byte budget, evicted least-recently-used first.
 *
 * A decoded sheet is not its download: the 320 px rendition of an 81-frame clip
 * is a 2880x2880 bitmap — 33 MB of RAM from a 400 KB file. Holding every sheet
 * a ten-minute story touches is how a phone tab gets reloaded out from under a
 * child, so the cache is sized in DECODED bytes and throws the oldest away
 * first. `deviceMemory <= 3` halves the budget, because the devices that report
 * it are the ones that reload.
 *
 * Two rules keep it from being a lie:
 *
 *   the CURRENT scene's sheets are kept — evicting a sheet that is on screen
 *   would blank a character mid-sentence to save memory it needs right back
 *
 *   an in-flight decode is shared — a scene asks for the same sheet from two
 *   clips, and a second fetch of a 400 KB object over a 290 KB/s link is a
 *   second of somebody's evening
 *
 * The drawable is an `ImageBitmap` where the browser has one and an `Image`
 * where it does not (old iOS Safari). `drawImage` takes either, so nothing
 * downstream branches; only `close()` does, and only bitmaps have it.
 */

const MEGABYTE = 1024 * 1024;
export const DEFAULT_BUDGET_BYTES = 96 * MEGABYTE;
export const SMALL_DEVICE_BUDGET_BYTES = 48 * MEGABYTE;
export const SMALL_DEVICE_MEMORY_GB = 3;

// RGBA, one byte a channel. The browser may hold a decoded bitmap in fewer
// (some keep 16-bit surfaces) but never in more, so this is the budget's own
// worst case rather than a measurement it cannot make.
const BYTES_PER_PIXEL = 4;

export function defaultBudgetBytes(navigatorLike = globalThis.navigator) {
  const memory = navigatorLike?.deviceMemory;
  return Number.isFinite(memory) && memory <= SMALL_DEVICE_MEMORY_GB
    ? SMALL_DEVICE_BUDGET_BYTES
    : DEFAULT_BUDGET_BYTES;
}

export function createBitmapCache({
  budgetBytes: startingBudgetBytes = defaultBudgetBytes(),
  decode = decodeDrawable,
  onOverBudget = () => {},
} = {}) {
  // Insertion order IS the LRU order: a hit deletes and re-sets the entry, so
  // the front of the map is always the least recently used.
  const entries = new Map();
  const inFlight = new Map();
  let budgetBytes = startingBudgetBytes;
  let kept = new Set();
  let heldBytes = 0;
  let destroyed = false;

  return {
    get(url) {
      const entry = entries.get(url);
      if (!entry) return null;
      entries.delete(url);
      entries.set(url, entry);
      return entry.drawable;
    },

    has(url) {
      return entries.has(url);
    },

    /**
     * The decoded sheet at `url`, decoding it if this is the first ask.
     *
     * Rejects on a failed decode and remembers nothing: the caller counts the
     * failure and the story keeps its time, and a later scene that needs the
     * same sheet is free to try again on a link that may have come back.
     */
    async load(url, { signal = null } = {}) {
      const cached = this.get(url);
      if (cached) return cached;
      const running = inFlight.get(url);
      if (running) return running;

      const work = (async () => {
        const drawable = await decode(url, { signal });
        // The decode outlived the cache: `createImageBitmap` takes no signal, so
        // a destroy mid-decode lands here with a live bitmap and an emptied map.
        // Storing it would leak exactly the bytes this module exists to bound,
        // and would make `destroy()`'s promise — everything closed — false.
        if (destroyed || signal?.aborted) {
          drawable?.close?.();
          throw abortError();
        }
        const bytes = drawableBytes(drawable);
        entries.set(url, { drawable, bytes });
        heldBytes += bytes;
        // Never the entry just inserted: a single sheet bigger than the whole
        // budget (a 512 tier of an 81-frame clip is 81 MB against a 48 MB
        // budget on a small device) would otherwise be closed and then handed
        // to the caller, who draws a closed bitmap — a blank character.
        evict(url);
        return drawable;
      })();
      inFlight.set(url, work);
      try {
        return await work;
      } finally {
        inFlight.delete(url);
      }
    },

    /** The sheets that may not be evicted — the scene on screen. */
    keep(urls) {
      kept = new Set(urls);
    },

    /**
     * Lower the ceiling mid-story, which is what a demotion does.
     *
     * Evicts immediately rather than waiting for the next decode: the reason
     * the tier fell is that this machine is already struggling, and holding the
     * old budget until the next scene opens is holding it through exactly the
     * minutes that made it fall.
     */
    setBudget(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes === budgetBytes) return;
      budgetBytes = bytes;
      evict();
    },

    get bytes() {
      return heldBytes;
    },

    get size() {
      return entries.size;
    },

    destroy() {
      destroyed = true;
      for (const { drawable } of entries.values()) drawable?.close?.();
      entries.clear();
      inFlight.clear();
      kept = new Set();
      heldBytes = 0;
    },
  };

  function evict(justLoaded = null) {
    for (const [url, entry] of entries) {
      if (heldBytes <= budgetBytes) return;
      if (kept.has(url) || url === justLoaded) continue;
      entries.delete(url);
      heldBytes -= entry.bytes;
      entry.drawable?.close?.();
    }
    // Nothing left that may go. Said out loud rather than tolerated, because a
    // budget that quietly does not hold is worse than no budget: the log reads
    // "the opening loaded fine" right up to the moment the tab is reloaded.
    if (heldBytes > budgetBytes) onOverBudget({ heldBytes, budgetBytes, kept: kept.size });
  }
}

/**
 * RGBA bytes of a decoded drawable.
 *
 * `??` will not do here: an `HTMLImageElement`'s `width` is a number whatever
 * happens, so a fallback arm behind `??` is unreachable — and an SVG carrying
 * only a `viewBox` decodes to width 0, which would charge the budget nothing
 * for something it is holding.
 */
function drawableBytes(drawable) {
  const width = positive(drawable?.width) || positive(drawable?.naturalWidth);
  const height = positive(drawable?.height) || positive(drawable?.naturalHeight);
  return width * height * BYTES_PER_PIXEL;
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fetch once, decode off the main thread when the browser can.
 *
 * The fetch is explicit rather than an `Image` src for three reasons: it aborts
 * with the player's own signal, it fails loudly with a status instead of a bare
 * `error` event, and the blob it produces feeds BOTH decode paths — so the
 * fallback costs no second request. `mode: 'cors'` and `credentials: 'omit'`
 * are what keeps the canvas untainted; the assets bucket serves the headers for
 * it (`tools/assets_bucket_cors.py` on the engine side).
 */
export async function decodeDrawable(url, { signal = null } = {}) {
  const response = await fetch(url, { credentials: 'omit', mode: 'cors', signal });
  if (!response.ok) throw new Error(`asset ${url} answered ${response.status}`);
  const blob = await response.blob();
  throwIfAborted(signal);
  let refusal = null;
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      return await globalThis.createImageBitmap(blob);
    } catch (error) {
      // Old iOS Safari has the function but refuses some blobs (SVG among
      // them), which is the same situation as not having it at all. It is NOT
      // the only way this throws, though — a truncated body and a device out
      // of memory land here too, and the fallback is about to decode the same
      // bytes on the main thread. So the reason is carried rather than lost:
      // if the second path fails as well, the log says what the first said.
      refusal = error;
    }
  }
  return decodeViaImage(blob, signal, refusal);
}

/**
 * Decode through an `Image`, which every browser has.
 *
 * The object URL is revoked on every exit — including the abort — because a
 * blob that is never revoked is held for the life of the page, and this path
 * runs on the devices with the least memory to spare.
 */
function decodeViaImage(blob, signal, refusal = null) {
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  return new Promise((resolve, reject) => {
    const finish = (settle) => (value) => {
      signal?.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(objectUrl);
      settle(value);
    };
    const fail = finish(reject);
    const succeed = finish(resolve);
    function onAbort() {
      // Detaching the source is what actually stops the decode; without it the
      // browser finishes a full-size sheet for a player that no longer exists.
      image.removeAttribute?.('src');
      fail(abortError());
    }
    if (signal?.aborted) return onAbort();

    // Listeners before `src`: an environment that settles the source
    // synchronously would otherwise lose both events, and nothing would ever
    // settle this promise — a begin button disabled for good.
    image.addEventListener?.('load', () => succeed(image), { once: true });
    image.addEventListener?.('error', () => fail(decodeError(refusal)), { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = objectUrl;
    if (typeof image.decode === 'function') {
      image.decode().then(() => succeed(image), () => fail(decodeError(refusal)));
    }
    return undefined;
  });
}

function decodeError(refusal) {
  return refusal
    ? new Error(`image decode failed after createImageBitmap refused it: ${refusal.message}`)
    : new Error('image decode failed');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  return new DOMException('player destroyed', 'AbortError');
}
