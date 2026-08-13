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
  #entries = [];
  #open = false;

  constructor(elements, initiallyOpen = false) {
    this.#elements = elements;
    elements.toggle.addEventListener('click', () => this.toggle());
    elements.close.addEventListener('click', () => this.close());
    elements.copy.addEventListener('click', () => this.copy());
    elements.download.addEventListener('click', () => this.download());
    document.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'd' || event.metaKey || event.ctrlKey || isTyping(event.target)) return;
      this.toggle();
    });
    if (initiallyOpen) this.open();
  }

  addEntry(entry, entries) {
    this.#entries = entries;
    const item = document.createElement('li');
    const label = entry.kind === 'warning' ? 'warning' : entry.cmd ?? entry.kind;
    const time = (entry.t_ms / 1000).toFixed(2).padStart(7, ' ');
    item.className = entry.kind === 'warning' ? 'warning' : '';

    const heading = document.createElement('strong');
    heading.textContent = `${time}s · ${label}`;
    item.append(heading, document.createElement('br'), document.createTextNode(JSON.stringify(entry.detail ?? {})));
    this.#elements.list.append(item);
    this.#elements.list.scrollTop = this.#elements.list.scrollHeight;
  }

  toggle() {
    if (this.#open) this.close();
    else this.open();
  }

  open() {
    this.#open = true;
    this.#elements.panel.classList.add('is-open');
    this.#elements.panel.setAttribute('aria-hidden', 'false');
    this.#elements.panel.removeAttribute('inert');
    this.#elements.toggle.setAttribute('aria-expanded', 'true');
    this.#elements.toggle.setAttribute('aria-label', 'close event log');
  }

  close() {
    this.#open = false;
    this.#elements.panel.classList.remove('is-open');
    this.#elements.panel.setAttribute('aria-hidden', 'true');
    this.#elements.panel.setAttribute('inert', '');
    this.#elements.toggle.setAttribute('aria-expanded', 'false');
    this.#elements.toggle.setAttribute('aria-label', 'open event log');
    this.#elements.toggle.focus({ preventScroll: true });
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.#json());
      this.#status('copied');
    } catch {
      this.#status('copy blocked');
    }
  }

  download() {
    const blob = new Blob([this.#json()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'story-event-log.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.#status('downloaded');
  }

  #json() {
    return `${JSON.stringify(this.#entries, null, 2)}\n`;
  }

  #status(message) {
    this.#elements.status.textContent = message;
    setTimeout(() => {
      if (this.#elements.status.textContent === message) this.#elements.status.textContent = '';
    }, 1_800);
  }
}

function isTyping(target) {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target?.isContentEditable;
}
