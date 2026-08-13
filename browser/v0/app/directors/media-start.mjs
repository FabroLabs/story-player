export function startMedia(media, timeoutMs, options = {}) {
  const {
    onTimeout = () => {},
    onError = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  let state = 'pending';
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const stop = () => {
    media.pause();
    media.removeAttribute?.('src');
  };
  const timer = setTimer(() => {
    if (!cancel('timeout')) return;
    onTimeout();
  }, Math.max(0, timeoutMs));

  const fail = (error) => {
    if (state !== 'pending') return;
    state = 'failed';
    clearTimer(timer);
    stop();
    onError(error);
    resolveResult({ started: false, reason: 'error' });
  };

  try {
    Promise.resolve(media.play()).then(
      () => {
        if (state !== 'pending') {
          stop();
          return;
        }
        state = 'started';
        clearTimer(timer);
        resolveResult({ started: true, reason: null });
      },
      fail,
    );
  } catch (error) {
    fail(error);
  }

  function cancel(reason = 'cancelled') {
    if (state !== 'pending') return false;
    state = 'cancelled';
    clearTimer(timer);
    stop();
    resolveResult({ started: false, reason });
    return true;
  }

  return { promise: result, cancel };
}
