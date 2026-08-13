export class ActorRegistry {
  #entries = new Map();

  attach(slug, actor) {
    this.#invalidate(this.#entries.get(slug));
    this.#entries.set(slug, { actor, generation: 0, action: null });
    return actor;
  }

  get(slug) {
    return this.#entries.get(slug)?.actor ?? null;
  }

  values() {
    return [...this.#entries.values()].map(({ actor }) => actor);
  }

  begin(slug) {
    const entry = this.#entries.get(slug);
    if (!entry) return null;
    this.#cancelAction(entry);
    entry.generation += 1;
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve({ cancelled: true });
    });
    const token = { slug, entry, generation: entry.generation, cancelled };
    entry.action = { token, cancel };
    return token;
  }

  supersede(slug) {
    const entry = this.#entries.get(slug);
    this.#invalidate(entry);
    return entry?.actor ?? null;
  }

  isCurrent(token) {
    return Boolean(token)
      && this.#entries.get(token.slug) === token.entry
      && token.entry.generation === token.generation;
  }

  remove(token) {
    if (!this.isCurrent(token)) return false;
    this.#finishAction(token);
    token.entry.generation += 1;
    this.#entries.delete(token.slug);
    return true;
  }

  complete(token) {
    if (!this.isCurrent(token)) return false;
    this.#finishAction(token);
    return true;
  }

  removeCurrent(slug) {
    const entry = this.#entries.get(slug);
    if (!entry) return null;
    this.#invalidate(entry);
    this.#entries.delete(slug);
    return entry.actor;
  }

  clear() {
    for (const entry of this.#entries.values()) this.#invalidate(entry);
    this.#entries.clear();
  }

  #invalidate(entry) {
    if (!entry) return;
    this.#cancelAction(entry);
    entry.generation += 1;
  }

  #cancelAction(entry) {
    if (!entry?.action) return;
    const { cancel } = entry.action;
    entry.action = null;
    cancel();
  }

  #finishAction(token) {
    if (token.entry.action?.token === token) token.entry.action = null;
  }
}
