/**
 * Deadlines measure SILENCE, not duration: a download is given up when nothing of it has arrived
 * for this long. A 6 MB sheet on a 3 Mbit/s link takes longer than any fixed deadline short enough
 * to catch a dead one, and cutting it there only started it again from zero, for ever.
 */
export const OPENING_TIMEOUT_MS = 30_000;
export const STALL_MS = 15_000;

// Everyone waiting on the link: a hold asks whether bytes are still arriving, not how long it took.
const listeners = new Set();

/** `listener` is called whenever any asset download receives bytes; answers its unsubscribe. */
export function onAssetProgress(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function progressed() {
  for (const listener of listeners) listener();
}

/**
 * `work(signal, touch)`, rejected with a TimeoutError once `timeoutMs` pass without a `touch`.
 * The deadline covers the response body too: receiving headers is not a loaded image.
 */
export async function withAssetDeadline(work, { signal, timeoutMs = OPENING_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  let expire;
  const touch = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted) timer = setTimeout(expire, timeoutMs);
  };
  const canceled = new Promise((_, reject) => {
    onAbort = () => {
      clearTimeout(timer);
      const error = signal?.reason ?? new DOMException('player destroyed', 'AbortError');
      controller.abort(error);
      reject(error);
    };
    expire = () => {
      const error = new DOMException('Story assets stopped downloading. Please try again.', 'TimeoutError');
      controller.abort(error);
      reject(error);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    touch();
  });
  try {
    return await Promise.race([
      canceled,
      controller.signal.aborted ? canceled : work(controller.signal, touch),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

export async function fetchAssetBlob(url, { signal = null, body = 'blob' } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withAssetDeadline(async (requestSignal, touch) => {
        const response = await fetch(url, { credentials: 'omit', mode: 'cors', signal: requestSignal });
        if (!response.ok) {
          const safeUrl = url.replace(/\/s\/[^/]+\//g, '/s/[grant]/');
          const error = new Error(`asset ${safeUrl} answered ${response.status}`);
          error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw error;
        }
        touch();
        return await readBody(response, body, touch);
      }, { signal, timeoutMs: STALL_MS });
    } catch (error) {
      // Decode failures are outside this loop; the same invalid bytes will not heal.
      if (signal?.aborted || attempt > 0 || !(error?.retryable || error?.name === 'TypeError' || error?.name === 'TimeoutError')) throw error;
    }
  }
}

/** The body, read as it arrives: every chunk re-arms this request's deadline and tells the holds. */
async function readBody(response, body, touch) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const whole = await response[body]();
    progressed();
    return whole;
  }
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    touch();
    progressed();
  }
  // The stored type is what lets an SVG decode at all: a browser never sniffs one.
  const blob = new Blob(chunks, { type: response.headers?.get?.('content-type') ?? '' });
  return body === 'blob' ? blob : blob.arrayBuffer();
}
