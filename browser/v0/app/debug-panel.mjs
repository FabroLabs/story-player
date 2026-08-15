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

export class DebugPanel {
  #elements;
  #document;
  #eventTarget;
  #listeners = [];
  #timers = new Set();
  #urls = new Set();
  #entries = [];
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

  addEntry(entry, entries) {
    if (this.#destroyed) return;
    this.#entries = entries;
    const item = this.#document.createElement('li');
    const label = entry.kind === 'warning' ? 'warning' : entry.cmd ?? entry.kind;
    const time = (entry.t_ms / 1000).toFixed(2).padStart(7, ' ');
    item.className = entry.kind === 'warning' ? 'warning' : '';

    const heading = this.#document.createElement('strong');
    heading.textContent = `${time}s · ${label}`;
    item.append(heading, this.#document.createElement('br'), this.#document.createTextNode(JSON.stringify(entry.detail ?? {})));
    this.#elements.list.append(item);
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

  #json() {
    return `${JSON.stringify(this.#entries, null, 2)}\n`;
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
  }
}

function isTyping(target) {
  return target?.tagName === 'INPUT'
    || target?.tagName === 'TEXTAREA'
    || target?.tag === 'input'
    || target?.tag === 'textarea'
    || target?.isContentEditable;
}
