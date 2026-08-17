/**
 * The smallest DOM `StageRenderer` will accept, so the renderer can be tested.
 *
 * It had no test file at all. Every other player module is unit-tested against
 * its own seam, but the one that decides how big a character is drawn, where
 * their feet land and who covers whom was reachable only through a browser —
 * and this branch shipped FOUR bugs into it that a fully green suite called
 * fine (a registry iterated with a Map API it lacks, two board projections
 * dropping `zone`, crowding spreading in line order, and a cross-band move
 * that never resized). Three were caught by eye; the fourth by an audit,
 * weeks later.
 *
 * NOT a general DOM. It implements exactly the calls `stage-renderer.mjs`
 * makes — a fake that answered more than the real thing is asked would let a
 * test pass on behaviour the browser never runs. If the renderer starts
 * calling something new, this file fails loudly rather than silently
 * returning undefined, which is the point: `style` and `classList` are the
 * only bags of arbitrary keys, and everything else is an explicit method.
 */

function fakeStyle() {
  // A plain bag, plus the one method the renderer uses on it. Reading a style
  // back is how the tests assert size and position, so it must behave like an
  // ordinary object.
  return {
    setProperty(name, value) {
      this[name] = String(value);
    },
  };
}

export class FakeElement {}

function fakeClassList(element) {
  const held = new Set();
  return {
    add: (...names) => names.forEach((name) => held.add(name)),
    remove: (...names) => names.forEach((name) => held.delete(name)),
    toggle: (name, force) => (force ? held.add(name) : held.delete(name)),
    contains: (name) => held.has(name),
    get size() {
      return held.size;
    },
    // for assertions
    values: () => [...held],
    element,
  };
}

export function fakeElement(tag = 'div') {
  const listeners = new Map();
  const childNodes = [];
  const element = {
    tag,
    nodeType: tag === '#text' ? 3 : 1,
    className: '',
    hidden: false,
    parent: null,
    childNodes,
    attributes: {},
    removed: false,
    // video-only, harmless elsewhere
    paused: true,
    currentTime: 0,
    src: '',
  };
  Object.setPrototypeOf(element, FakeElement.prototype);
  Object.defineProperty(element, 'children', {
    get: () => childNodes.filter((child) => child.nodeType === 1),
  });
  element.style = fakeStyle();
  element.classList = fakeClassList(element);
  element.append = (...kids) => {
    for (const kid of kids) {
      kid.parent = element;
      childNodes.push(kid);
    }
  };
  element.replaceChildren = (...kids) => {
    for (const child of childNodes) child.parent = null;
    childNodes.splice(0, childNodes.length);
    element.append(...kids);
  };
  element.remove = () => {
    const at = element.parent ? element.parent.childNodes.indexOf(element) : -1;
    if (at >= 0) element.parent.childNodes.splice(at, 1);
    element.removed = true;
  };
  element.setAttribute = (name, value) => {
    element.attributes[name] = String(value);
  };
  element.getAttribute = (name) => element.attributes[name] ?? null;
  element.removeAttribute = (name) => {
    delete element.attributes[name];
    if (name === 'src') element.src = '';
  };
  element.focus = () => {
    element.focused = true;
  };
  element.click = () => element.dispatch('click');
  element.getRootNode = () => {
    let root = element;
    while (root.parent) root = root.parent;
    return root;
  };
  element.attachShadow = ({ mode }) => {
    if (element.shadowRoot) throw new Error('shadow root already attached');
    const root = fakeElement('#shadow-root');
    root.host = element;
    root.mode = mode;
    root.ownerDocument = element.ownerDocument ?? globalThis.document;
    element.shadowRoot = root;
    return root;
  };
  // The renderer reads this only to force a style flush before starting a
  // transition; the numbers are the logical stage, so `#fitStage` computes a
  // scale of exactly 1.
  element.getBoundingClientRect = () => ({
    width: 1920, height: 1080, top: 0, left: 0, right: 1920, bottom: 1080, x: 0, y: 0,
  });
  element.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  };
  element.removeEventListener = (type, handler) => {
    listeners.get(type)?.delete(handler);
  };
  /** Fire a listener the browser would have fired. Returns how many ran. */
  element.dispatch = (type, event = {}) => {
    const held = [...(listeners.get(type) ?? [])];
    for (const handler of held) handler({ type, target: element, ...event });
    return held.length;
  };
  element.listenerCount = (type) => listeners.get(type)?.size ?? 0;
  element.pause = () => {
    element.paused = true;
  };
  element.play = () => {
    element.paused = false;
    return Promise.resolve();
  };
  element.load = () => {};
  return element;
}

/** The element bag `new StageRenderer(elements)` destructures. */
export function fakeStageElements() {
  return {
    frame: fakeElement(),
    stage: fakeElement(),
    camera: fakeElement(),
    plate: fakeElement(),
    sprites: fakeElement(),
    poster: fakeElement(),
    video: fakeElement('video'),
    subtitle: fakeElement(),
    mediaNote: fakeElement(),
    end: fakeElement(),
  };
}

/**
 * Install the globals the renderer reaches for, and return the undo.
 *
 * `requestAnimationFrame` is deliberately a no-op that never schedules: the
 * frame loop is `startAnimation`'s business and a test that started one would
 * never finish. `Image` resolves nothing by itself — a test that wants a
 * sprite to load calls `.dispatch('load')` on it through `lastImage()`.
 *
 * `fetch` and `createImageBitmap` are the asset layer's two seams, and they
 * settle by themselves: the scene loader awaits them, so a fake that waited to
 * be poked would deadlock every test that mounts a player. `assets(url)` is
 * what a test overrides to make one answer 404 or come back a different size;
 * node has a real `fetch` and no `createImageBitmap`, so both are replaced
 * rather than filled in — a test must never reach the network.
 */
export function installDom({ assets = () => ({}) } = {}) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    Element: globalThis.Element,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    ResizeObserver: globalThis.ResizeObserver,
    Image: globalThis.Image,
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const images = [];
  const documentNode = fakeElement('#document');
  documentNode.createElement = (tag) => {
    const element = fakeElement(tag);
    element.ownerDocument = documentNode;
    return element;
  };
  documentNode.createTextNode = (text) => {
    const node = fakeElement('#text');
    node.textContent = String(text);
    node.ownerDocument = documentNode;
    return node;
  };
  globalThis.document = documentNode;
  globalThis.Element = FakeElement;
  globalThis.HTMLInputElement = class extends FakeElement {};
  globalThis.HTMLTextAreaElement = class extends FakeElement {};
  const storage = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    matchMedia: () => ({ matches: false }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { clipboard: { writeText: async () => {} } },
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.Image = class {
    constructor() {
      const element = fakeElement('img');
      images.push(element);
      return element;
    }
  };
  const fetched = [];
  globalThis.fetch = async (url, { signal } = {}) => {
    const href = String(url);
    fetched.push(href);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const { status = 200, width = 64, height = 64 } = assets(href) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      blob: async () => ({ size: width * height, pixels: { width, height } }),
    };
  };
  globalThis.createImageBitmap = async (blob) => ({
    width: blob?.pixels?.width ?? 1,
    height: blob?.pixels?.height ?? 1,
    close() { this.closed = true; },
  });
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  return {
    lastImage: () => images.at(-1),
    fetched: () => [...fetched],
    restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete globalThis.navigator;
    },
  };
}

/** px off an element's style, as a number — the tests compare sizes. */
export function px(value) {
  const number = Number.parseFloat(String(value ?? '').replace('px', ''));
  return Number.isFinite(number) ? number : null;
}
