import { performerFor } from './performers.mjs';
import { createPlayerTemplate } from './template.mjs';
import { resolveMediaUrl } from './v0/app/urls.mjs';

const OWNER = Symbol('FabroStoryPlayer owner');

export { resolveMediaUrl };

export function createStoryPlayer(container, options) {
  if (typeof Element === 'undefined' || !(container instanceof Element)) {
    throw new TypeError('container must be an Element');
  }
  if (!options?.story || typeof options.story !== 'object' || Array.isArray(options.story)) {
    throw new TypeError('story must be a parsed object');
  }
  const factory = performerFor(options.story);
  const root = container.shadowRoot ?? container.attachShadow({ mode: 'open' });
  if (root[OWNER]) throw new Error('container already owns an active story player');
  if (root.childNodes?.length ?? root.children?.length) {
    throw new Error('container ShadowRoot is not empty');
  }
  const abort = new AbortController();
  const elements = createPlayerTemplate(root);
  const token = {};
  root[OWNER] = token;
  let performer = null;
  let destroyed = false;
  try {
    performer = factory({
      root, elements, story: options.story, assetBase: options.assetBase,
      signal: abort.signal, debug: options.debug === true,
    });
  } catch (error) {
    showError(elements, error);
    performer = { ready: Promise.reject(error), destroy() {} };
  }
  const ready = Promise.resolve(performer.ready).catch((error) => {
    if (!destroyed && error?.name !== 'AbortError') showError(elements, error);
    throw error;
  });
  return Object.freeze({
    ready,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      performer?.destroy?.();
      root.replaceChildren();
      if (root[OWNER] === token) delete root[OWNER];
    },
  });
}

function showError(elements, error) {
  elements.title.textContent = 'this story could not be opened';
  elements.status.textContent = error?.message ?? String(error);
  elements.status.classList.add('is-error');
  elements.start.disabled = true;
}
