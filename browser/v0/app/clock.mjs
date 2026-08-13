export class StoryClock {
  #now;
  #startedAt = null;

  constructor({ now = defaultNow } = {}) {
    this.#now = now;
  }

  start() {
    if (this.#startedAt === null) this.#startedAt = this.#now();
  }

  now() {
    return this.#startedAt === null ? 0 : Math.max(0, Math.round(this.#now() - this.#startedAt));
  }

  wait(milliseconds) {
    return wait(milliseconds);
  }
}

export function wait(milliseconds, setTimer = setTimeout) {
  return new Promise((resolve) => setTimer(resolve, Math.max(0, milliseconds)));
}

export function withTimeout(promise, milliseconds, options = {}) {
  const {
    fallback = null,
    onTimeout = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimer(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      resolve({ timedOut: true, value: fallback });
    }, Math.max(0, milliseconds));

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      },
    );
  });
}

function defaultNow() {
  return performance.now();
}
