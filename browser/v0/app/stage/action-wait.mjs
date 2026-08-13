import { withTimeout } from '../clock.mjs';

export function waitForActorAction(action, completion, timeoutMs, options = {}) {
  const cancellation = action?.cancelled ?? new Promise(() => {});
  return withTimeout(Promise.race([completion, cancellation]), timeoutMs, options);
}
