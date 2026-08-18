import { EventLog } from '../core/event-log.mjs';

export class ObservableEventLog extends EventLog {
  #onEntry;

  constructor(clock, onEntry = () => {}) {
    super(clock);
    this.#onEntry = onEntry;
  }

  append(entry) {
    const recorded = super.append(entry);
    this.#onEntry(recorded, this.entries());
    return recorded;
  }
}

// The list is a tail, not an archive: the download carries every entry, so the
// only thing an unbounded list of nodes buys is a slower panel on the story
// that needed it most.
const VISIBLE_ENTRIES = 500;

export class DebugPanel {
  #elements;
  #document;
  #eventTarget;
  #listeners = [];
  #timers = new Set();
  #urls = new Set();
  #entries = [];
  #timeline = null;
  #beforeSerialize = null;
  #open = false;
  #destroyed = false;

  constructor(elements, initiallyOpen = false, { eventTarget = globalThis.document } = {}) {
    this.#elements = elements;
    this.#document = elements.panel.ownerDocument ?? globalThis.document;
    this.#eventTarget = eventTarget;
    this.#listen(elements.toggle, 'click', () => this.toggle());
    this.#listen(elements.close, 'click', () => this.close());
    this.#listen(elements.copy, 'click', () => this.copy());
    this.#listen(elements.download, 'click', () => this.download());
    this.#listen(eventTarget, 'keydown', (event) => {
      if (event.key.toLowerCase() !== 'd' || event.metaKey || event.ctrlKey || isTyping(event.target)) return;
      this.toggle();
    });
    if (initiallyOpen) this.open();
  }

  /**
   * The schedule the story is being played from, for the download.
   *
   * A log of what went wrong answers "what did the player do"; the timeline
   * answers "what was it asked to do", and only the two together let a session
   * be checked against the engine's own copy of the same compile.
   */
  attachTimeline(timeline) {
    if (this.#destroyed) return;
    this.#timeline = timeline ?? null;
  }

  /**
   * Something to do before the log is serialized — the runtime writes the perf
   * section of the scene on screen, which nothing else would close until the
   * story reached the next cut.
   */
  beforeSerialize(callback) {
    this.#beforeSerialize = typeof callback === 'function' ? callback : null;
  }

  addEntry(entry, entries) {
    if (this.#destroyed) return;
    this.#entries = entries;
    if (entry.kind === 'perf') this.#perf(entry);
    const item = this.#document.createElement('li');
    const label = entry.kind === 'warning' ? 'warning' : entry.cmd ?? entry.kind;
    const time = (entry.t_ms / 1000).toFixed(2).padStart(7, ' ');
    item.className = entry.kind === 'warning' ? 'warning' : '';

    const heading = this.#document.createElement('strong');
    heading.textContent = `${time}s · ${label}`;
    item.append(heading, this.#document.createElement('br'), this.#document.createTextNode(bodyOf(entry)));
    this.#elements.list.append(item);
    while (this.#elements.list.children.length > VISIBLE_ENTRIES) {
      this.#elements.list.children[0].remove();
    }
    this.#elements.list.scrollTop = this.#elements.list.scrollHeight;
  }

  toggle() {
    if (this.#destroyed) return;
    if (this.#open) this.close();
    else this.open();
  }

  open() {
    if (this.#destroyed) return;
    this.#open = true;
    this.#elements.panel.classList.add('is-open');
    this.#elements.panel.setAttribute('aria-hidden', 'false');
    this.#elements.panel.removeAttribute('inert');
    this.#elements.toggle.setAttribute('aria-expanded', 'true');
    this.#elements.toggle.setAttribute('aria-label', 'close event log');
  }

  close() {
    if (this.#destroyed) return;
    this.#open = false;
    this.#elements.panel.classList.remove('is-open');
    this.#elements.panel.setAttribute('aria-hidden', 'true');
    this.#elements.panel.setAttribute('inert', '');
    this.#elements.toggle.setAttribute('aria-expanded', 'false');
    this.#elements.toggle.setAttribute('aria-label', 'open event log');
    this.#elements.toggle.focus({ preventScroll: true });
  }

  async copy() {
    if (this.#destroyed) return;
    try {
      await navigator.clipboard.writeText(this.#json());
      this.#status('copied');
    } catch {
      this.#status('copy blocked');
    }
  }

  download() {
    if (this.#destroyed) return;
    const blob = new Blob([this.#json()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    this.#urls.add(url);
    const anchor = this.#document.createElement('a');
    anchor.href = url;
    anchor.download = 'story-event-log.json';
    anchor.click();
    this.#later(() => {
      URL.revokeObjectURL(url);
      this.#urls.delete(url);
    }, 0);
    this.#status('downloaded');
  }

  // The timeline verbatim with the log beside it, so `jq .events` on a
  // downloaded session and on the engine's `story.timeline.json` are the same
  // question — that diff is what proves both ran the same compiler.
  /**
   * The last thing measured, in one line.
   *
   * A summary rather than a table: the whole history is in the download, and
   * what the panel is for is noticing — mid-story, on the machine that is
   * struggling — that the tier fell or that a scene ran at 12 frames.
   */
  #perf(entry) {
    const perf = this.#elements.perf;
    if (!perf) return;
    perf.hidden = false;
    if (entry.reason === 'tier') {
      perf.textContent = `tier ${entry.from} → ${entry.to}`;
      return;
    }
    const scene = entry.scene_index === null ? 'gate' : `scene ${entry.scene_index + 1}`;
    const parts = [
      scene,
      entry.tier,
      `${entry.frames} frames`,
      `p95 ${entry.frame_ms?.p95 ?? '—'} ms`,
      `max ${entry.frame_ms?.max ?? '—'} ms`,
      `${entry.slow_frames} slow`,
    ];
    if (entry.lag_p95_ms !== null && entry.lag_p95_ms !== undefined) parts.push(`lag ${entry.lag_p95_ms} ms`);
    if (entry.video_dropped !== undefined) parts.push(`${entry.video_dropped}/${entry.video_total} dropped`);
    if (entry.heap_mb !== undefined) parts.push(`${entry.heap_mb} MB heap`);
    perf.textContent = parts.join(' · ');
  }

  #json() {
    try {
      // The entries this appends arrive through `addEntry`, which is what keeps
      // `#entries` current — so the flush must happen before the snapshot below.
      this.#beforeSerialize?.();
    } catch {
      // A log that cannot be closed is still a log worth downloading.
    }
    const payload = this.#timeline ? { ...this.#timeline, log: this.#entries } : this.#entries;
    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  #status(message) {
    if (this.#destroyed) return;
    this.#elements.status.textContent = message;
    this.#later(() => {
      if (this.#elements.status.textContent === message) this.#elements.status.textContent = '';
    }, 1_800);
  }

  #listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.#listeners.push({ target, type, handler });
  }

  #later(callback, milliseconds) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#destroyed) callback();
    }, milliseconds);
    this.#timers.add(timer);
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const { target, type, handler } of this.#listeners) target.removeEventListener(type, handler);
    this.#listeners = [];
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const url of this.#urls) URL.revokeObjectURL(url);
    this.#urls.clear();
    this.#entries = [];
    this.#timeline = null;
  }
}

/**
 * What to show under an entry's heading.
 *
 * A warning carries its `detail`; the entries this player writes about itself —
 * the capability probe, a perf section — are flat, and printing `detail ?? {}`
 * for those put an empty object under every one of them. The tier, the reasons
 * and the core count are the whole reason the capability line exists.
 */
function bodyOf(entry) {
  if (entry.detail !== undefined) return JSON.stringify(entry.detail ?? {});
  const { t_ms: _t, kind: _kind, scene_index: _scene, line: _line, ...rest } = entry;
  return JSON.stringify(rest);
}

function isTyping(target) {
  return target?.tagName === 'INPUT'
    || target?.tagName === 'TEXTAREA'
    || target?.tag === 'input'
    || target?.tag === 'textarea'
    || target?.isContentEditable;
}
