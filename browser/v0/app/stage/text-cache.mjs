// Canvas allocation belongs to the stage. This cache only holds its private
// text surfaces; it never measures layout, reads a clock, or changes the caller.
const TEXT_STATE = [
  'font', 'fillStyle', 'strokeStyle', 'lineWidth', 'lineJoin', 'miterLimit',
  'direction', 'textAlign', 'textBaseline', 'fontKerning', 'fontStretch',
  'fontVariantCaps', 'letterSpacing', 'wordSpacing', 'textRendering', 'lang',
];

export function createTextCache(createCanvas, { limit = 256 } = {}) {
  const entries = new Map();

  function entryFor(context, text, maxWidth) {
    const matrix = context.getTransform();
    const sx = Math.hypot(matrix.a, matrix.b) || 1;
    const sy = Math.hypot(matrix.c, matrix.d) || 1;
    const state = TEXT_STATE.map((name) => context[name]);
    const key = JSON.stringify([String(text), state, maxWidth ?? null, sx, sy]);
    let entry = entries.get(key);
    if (entry) entries.delete(key);
    else entry = { metrics: context.measureText(text), state, sx, sy, bitmap: null };
    entries.set(key, entry);
    if (entries.size > limit) entries.delete(entries.keys().next().value);
    return entry;
  }

  return {
    measure(context, text, maxWidth) {
      return entryFor(context, text, maxWidth).metrics;
    },
    draw(context, text, x, y, maxWidth) {
      // Like fillText, a nonpositive or nonfinite maximum paints nothing.
      if (maxWidth !== undefined && (!(maxWidth > 0) || !Number.isFinite(maxWidth))) return;
      const entry = entryFor(context, text, maxWidth);
      if (!entry.bitmap) {
        const { metrics, sx, sy, state } = entry;
        const size = Number.parseFloat(/([\d.]+)px/.exec(context.font)?.[1]) || 16;
        const shrink = maxWidth === undefined ? 1 : Math.min(1, maxWidth / (metrics.width || 1));
        // TextMetrics bounds are relative to the SAME alignment and baseline
        // anchor as fillText (including start/end in RTL). Keep that anchor in
        // the bitmap, rather than guessing a baseline from the font size.
        const align = context.textAlign;
        const right = align === 'right' || (align === 'start' && context.direction === 'rtl')
          || (align === 'end' && context.direction !== 'rtl');
        const advanceLeft = right ? metrics.width : align === 'center' ? metrics.width / 2 : 0;
        const pad = 2 + (context.lineWidth || 0) * Math.max(1, context.miterLimit || 1) / 2;
        const left = Math.floor((-((metrics.actualBoundingBoxLeft ?? advanceLeft) * shrink) - pad) * sx) / sx;
        const top = Math.floor((-(metrics.actualBoundingBoxAscent ?? size * 2) - pad) * sy) / sy;
        const width = Math.max(1, Math.ceil((((metrics.actualBoundingBoxRight ?? (metrics.width - advanceLeft)) * shrink) + pad - left) * sx));
        const height = Math.max(1, Math.ceil(((metrics.actualBoundingBoxDescent ?? size * 2) + pad - top) * sy));
        const bitmap = createCanvas(width, height);
        const into = bitmap?.getContext?.('2d');
        if (!into) return;
        // Dimensions reset the context, so apply state afterwards. Alpha,
        // clipping, shadows and filters stay on the destination drawImage.
        bitmap.width = width;
        bitmap.height = height;
        TEXT_STATE.forEach((name, index) => { if (state[index] != null) into[name] = state[index]; });
        into.setTransform(sx, 0, 0, sy, -left * sx, -top * sy);
        if (maxWidth === undefined) into.fillText(text, 0, 0);
        else into.fillText(text, 0, 0, maxWidth);
        Object.assign(entry, { bitmap, left, top, width: width / sx, height: height / sy });
      }
      context.drawImage(entry.bitmap, x + entry.left, y + entry.top, entry.width, entry.height);
    },
    clear() { entries.clear(); },
  };
}
