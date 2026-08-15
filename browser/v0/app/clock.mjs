export class StoryClock {
  #now;
  #signal;
  #startedAt = null;

  constructor({ now = defaultNow, signal = null } = {}) {
    this.#now = now;
    this.#signal = signal;
  }

  start() {
    if (this.#startedAt === null) this.#startedAt = this.#now();
  }

  now() {
    return this.#startedAt === null ? 0 : Math.max(0, Math.round(this.#now() - this.#startedAt));
  }

  wait(milliseconds) {
    return wait(milliseconds, setTimeout, { signal: this.#signal });
  }
}

export function wait(milliseconds, setTimer = setTimeout, { signal = null, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimer(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function withTimeout(promise, milliseconds, options = {}) {
  const {
    fallback = null,
    onTimeout = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    signal = null,
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const finish = (complete) => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      complete();
      return true;
    };
    const onAbort = () => {
      clearTimer(timer);
      finish(() => reject(abortError()));
    };
    const timer = setTimer(() => {
      finish(() => {
        onTimeout();
        resolve({ timedOut: true, value: fallback });
      });
    }, Math.max(0, milliseconds));
    signal?.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(promise).then(
      (value) => {
        finish(() => {
          clearTimer(timer);
          resolve({ timedOut: false, value });
        });
      },
      (error) => {
        finish(() => {
          clearTimer(timer);
          reject(error);
        });
      },
    );
  });
}

function defaultNow() {
  return performance.now();
}

function abortError() {
  return new DOMException('player destroyed', 'AbortError');
}
