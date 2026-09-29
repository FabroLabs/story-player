/** Deadlines cover the response body too: receiving headers is not a loaded image. */
export const OPENING_TIMEOUT_MS = 30_000;
const ATTEMPT_TIMEOUT_MS = 15_000;

export async function withAssetDeadline(work, { signal, timeoutMs = OPENING_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => {
      clearTimeout(timer);
      const error = signal?.reason ?? new DOMException('player destroyed', 'AbortError');
      controller.abort(error);
      reject(error);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new DOMException('Story assets took too long to download. Please try again.', 'TimeoutError');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      canceled,
      controller.signal.aborted ? canceled : work(controller.signal),
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
      return await withAssetDeadline(async (requestSignal) => {
        const response = await fetch(url, { credentials: 'omit', mode: 'cors', signal: requestSignal });
        if (!response.ok) {
          const safeUrl = url.replace(/\/s\/[^/]+\//g, '/s/[grant]/');
          const error = new Error(`asset ${safeUrl} answered ${response.status}`);
          error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          await response.body?.cancel();
          throw error;
        }
        return await response[body]();
      }, { signal, timeoutMs: ATTEMPT_TIMEOUT_MS });
    } catch (error) {
      // Decode failures are outside this loop; the same invalid bytes will not heal.
      if (signal?.aborted || attempt > 0 || !(error?.retryable || error?.name === 'TypeError' || error?.name === 'TimeoutError')) throw error;
    }
  }
}
