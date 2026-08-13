export class EventLog {
  #entries = [];
  #now;

  constructor(now = () => 0) {
    this.#now = typeof now === 'function' ? now : now.now.bind(now);
  }

  append(entry) {
    const { key: _key, t_ms: suppliedTime, ...payload } = entry;
    const recorded = {
      t_ms: suppliedTime ?? this.#now(),
      ...payload,
    };
    this.#entries.push(recorded);
    return copy(recorded);
  }

  warning(detail, line = null, sceneIndex = null) {
    return this.append({ scene_index: sceneIndex, line, kind: 'warning', detail });
  }

  entries() {
    return this.#entries.map(copy);
  }

  toJSON() {
    return this.entries();
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}
