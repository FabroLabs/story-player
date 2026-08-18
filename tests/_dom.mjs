/**
 * The smallest DOM the player will accept, so its DOM-facing modules can be
 * tested without a browser.
 *
 * NOT a general DOM. It implements exactly the calls those modules make — a
 * fake that answered more than the real thing is asked would let a test pass on
 * behaviour the browser never runs. If a module starts calling something new,
 * this file fails loudly rather than silently returning undefined, which is the
 * point: `style` and `classList` are the only bags of arbitrary keys, and
 * everything else is an explicit method.
 *
 * The 2D context is the same idea one layer down. It records what it was asked
 * to draw and in which order, because that IS the picture as far as this suite
 * can see it: `canvas-stage.mjs` has no DOM to read back, so the call log is
 * the only place its arithmetic becomes visible.
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
  if (tag === 'video') {
    // What a real plate answers the perf recorder with. Settable by a test:
    // `element.quality = { droppedVideoFrames: 3, totalVideoFrames: 100 }`.
    element.quality = { droppedVideoFrames: 0, totalVideoFrames: 0 };
    element.getVideoPlaybackQuality = () => element.quality;
  }
  if (tag === 'canvas') {
    // One context per element, as a real canvas hands out: asking twice must
    // not silently hand back a second, empty recorder.
    element.getContext = (kind) => {
      if (kind !== '2d') return null;
      element.context = element.context ?? fakeContext();
      return element.context;
    };
    // Every write to `width`/`height` is kept, not just the last value: a real
    // canvas is CLEARED by the assignment even when the number is unchanged, so
    // "did it write the same size twice?" is a question about the picture.
    element.sizes = [];
    for (const axis of ['width', 'height']) {
      let held = 300;
      Object.defineProperty(element, axis, {
        configurable: true,
        get: () => held,
        set: (value) => {
          held = value;
          element.sizes.push([axis, value]);
        },
      });
    }
  }
  return element;
}

/**
 * A 2D context that draws nothing, remembers everything, and MODELS the two
 * pieces of state a drawer can corrupt.
 *
 * `calls` is an ordered log of `[name, ...arguments]`. On top of that it keeps
 * a real transform and a real `save`/`restore` stack, because a recorder alone
 * cannot see the worst mutation this stage allows: the shadow paints inside a
 * `save`/`translate`/`scale`/`restore`, and dropping the `restore` leaves every
 * later command translated onto somebody's feet and squashed flat — the whole
 * cast off the stage, with every `drawImage` argument in the log unchanged.
 *
 * The transform is the 2x3 affine the canvas keeps, `[a, d, e, f]` here since
 * nothing in this player skews or rotates. `drawImage` records the transform
 * and the alpha in force when it ran, which is what a test actually wants to
 * ask about: not "was it called" but "where would it have landed".
 */
export function fakeContext() {
  const calls = [];
  let transform = [1, 1, 0, 0];
  const stack = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const context = {
    calls,
    globalAlpha: 1,
    fillStyle: null,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: null,
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    arc: record('arc'),
    ellipse: record('ellipse'),
    fill: record('fill'),
    setTransform(a, b, c, d, e, f) {
      calls.push(['setTransform', a, b, c, d, e, f]);
      transform = [a, d, e, f];
    },
    translate(x, y) {
      calls.push(['translate', x, y]);
      const [a, d, e, f] = transform;
      transform = [a, d, e + (a * x), f + (d * y)];
    },
    scale(x, y) {
      calls.push(['scale', x, y]);
      const [a, d, e, f] = transform;
      transform = [a * x, d * y, e, f];
    },
    save() {
      calls.push(['save']);
      stack.push([[...transform], context.globalAlpha, context.fillStyle]);
    },
    restore() {
      calls.push(['restore']);
      const held = stack.pop();
      if (!held) throw new Error('restore with nothing saved');
      transform = held[0];
      context.globalAlpha = held[1];
      context.fillStyle = held[2];
    },
    drawImage: (...args) => calls.push([
      'drawImage', ...args, { alpha: context.globalAlpha, transform: [...transform] },
    ]),
    createRadialGradient: (...args) => gradient('radial', args, calls),
    createLinearGradient: (...args) => gradient('linear', args, calls),
    /** Every call of one name, arguments only. */
    of(name) {
      return calls.filter(([called]) => called === name).map(([, ...args]) => args);
    },
    /** The names in order, for asserting that a shadow precedes its sprite. */
    names() {
      return calls.map(([called]) => called);
    },
    /**
     * `[a, d, e, f]` right now — for asserting nothing was left on the floor.
     * Named `matrix` rather than `transform` because the real context's
     * `transform()` MULTIPLIES one in; a fake that answered a different
     * question under that name would be a trap.
     */
    matrix() {
      return [...transform];
    },
    /** How many `save`s are still open. Anything but 0 at the end is a leak. */
    depth() {
      return stack.length;
    },
  };
  return context;
}

function gradient(kind, args, calls) {
  const stops = [];
  calls.push([`create${kind === 'radial' ? 'Radial' : 'Linear'}Gradient`, ...args]);
  return { kind, args, stops, addColorStop: (offset, color) => stops.push([offset, color]) };
}

/** The element bag the canvas stage and the video plate destructure. */
export function fakeStageElements() {
  return {
    frame: fakeElement(),
    stage: fakeElement(),
    canvas: fakeElement('canvas'),
    plate: fakeElement(),
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
