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
      plates: options.plates ?? null, stream: options.stream ?? null,
      signal: abort.signal, debug: options.debug === true, perf: options.perf === true,
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
    appendScene,
    finishStory,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      abort.abort();
      performer?.destroy?.();
      root.replaceChildren();
      if (root[OWNER] === token) delete root[OWNER];
    },
  });

  /**
   * The two calls a host watching a writer makes, and the two a host with a
   * finished story never does.
   *
   * Always here, because that is what a feature test is for: a build too old to
   * follow a growing story does not have them at all, and one that has them
   * always means them. A player mounted without `stream` says so — it refuses
   * rather than quietly accepting scenes it will never show.
   */
  async function appendScene(scene) {
    if (destroyed) return;
    if (typeof performer?.appendScene === 'function') await performer.appendScene(scene);
    else await refuse();
  }

  async function finishStory(status) {
    if (destroyed) return;
    if (typeof performer?.finishStory === 'function') await performer.finishStory(status);
    else await refuse();
  }

  /**
   * Either the mount threw — `ready` is carrying the reason, and re-throwing it
   * is the honest answer — or this build's performer does not follow a growing
   * story, in which case saying nothing would be the one thing the feature test
   * above promises never happens.
   */
  async function refuse() {
    await ready;
    throw new Error('this player cannot follow a story that is still being written');
  }
}

function showError(elements, error) {
  elements.title.textContent = 'this story could not be opened';
  elements.status.textContent = error?.message ?? String(error);
  elements.status.classList.add('is-error');
  elements.start.disabled = true;
}
