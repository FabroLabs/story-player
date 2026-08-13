export class SpriteAssetTracker {
  #assets = new Map();

  start(url) {
    if (!this.#assets.has(url)) this.#assets.set(url, { state: 'loading', warned: false });
    return this.#view(url, false);
  }

  markSlow(url) {
    const asset = this.#asset(url);
    if (asset.state === 'loading') asset.state = 'slow';
    return this.#warnedView(url, asset.state === 'slow');
  }

  markReady(url) {
    const asset = this.#asset(url);
    if (asset.state !== 'failed') asset.state = 'ready';
    return this.#view(url, false);
  }

  markFailed(url) {
    const asset = this.#asset(url);
    asset.state = 'failed';
    return this.#warnedView(url, true);
  }

  #asset(url) {
    this.start(url);
    return this.#assets.get(url);
  }

  #warnedView(url, wantsWarning) {
    const asset = this.#assets.get(url);
    const warn = wantsWarning && !asset.warned;
    if (warn) asset.warned = true;
    return this.#view(url, warn);
  }

  #view(url, warn) {
    const state = this.#assets.get(url).state;
    return { state, placeholder: state === 'slow' || state === 'failed', warn };
  }
}
