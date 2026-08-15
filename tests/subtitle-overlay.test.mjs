/**
 * The subtitle area may never cost the picture more than the words it shows.
 *
 * Two bugs, both invisible to every other test in this suite because nothing
 * here runs a browser: a container band painted a gradient over the bottom 37%
 * of the stage whether or not there was a line to read, and the `cc` toggle
 * hid the `<p>` while the band it sat in stayed. Subtitles "off" still cost a
 * third of the picture.
 *
 * So the rule this file pins is a rule about pixels, not about styling taste:
 * anything painted must be attached to the text, and the toggle must take the
 * whole area away. Pixel rules are read from `styles.css`; the toggle runs
 * through the real instance controller against the repository's strict DOM
 * fixture, because there is no longer a standalone player document or shell.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { installDom } from './_dom.mjs';

const read = (path) => fs.readFileSync(new URL(`../browser/${path}`, import.meta.url), 'utf8');

/**
 * Every declaration written for one class, wherever it is written.
 *
 * The regex matches innermost blocks only, so a rule inside `@media` is
 * returned with its media wrapper dropped — deliberate: an override that only
 * applies under 700px paints just as many pixels on a phone, and this file is
 * asking what can be painted at all, not where.
 */
function declarationsFor(css, className) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const scoped = new RegExp(`(^|[\\s>+~])\\.${className}(?![\\w-])`);
  const found = [];

  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = selectors.split(',').map((one) => one.trim()).find((one) => scoped.test(one));
    if (!selector) continue;
    for (const piece of body.split(';')) {
      const at = piece.indexOf(':');
      if (at === -1) continue;
      found.push({
        selector,
        property: piece.slice(0, at).trim(),
        value: piece.slice(at + 1).trim(),
      });
    }
  }
  return found;
}

/** The declarations of one property, for reporting which rule carries it. */
const withProperty = (declarations, property) =>
  declarations.filter((one) => one.property === property || one.property.startsWith(`${property}-`));

const describe = (hits) => hits.map((one) => `${one.selector} { ${one.property}: ${one.value} }`).join(', ');

test('the subtitle container paints nothing — an empty line must cost zero pixels', () => {
  // The band bug itself. `.subtitle-wrap` is in the DOM from the first frame
  // and never leaves, so every pixel it paints is painted over a story that
  // has not said anything yet. A gradient here is a permanent dark bar; a
  // min-height here is a permanent reservation, and the two together were 37%
  // of a 608px stage with the subtitle empty.
  const css = read('styles.css');
  const wrap = declarationsFor(css, 'subtitle-wrap');
  assert.ok(wrap.length > 0, 'no .subtitle-wrap rule in styles.css — this reader is stale, not the stylesheet');

  const painted = withProperty(wrap, 'background');
  assert.equal(painted.length, 0, `.subtitle-wrap paints a background over the stage: ${describe(painted)}`);

  // Naming `min-height` alone would let the same reservation back in through
  // `height`, through a top padding, or through a `top` that stretches an
  // element already anchored to `bottom: 0` — all three grow the box the same
  // way and all three would sail past a min-height-only guard.
  const reserved = wrap.filter(
    (one) =>
      ['height', 'min-height', 'top', 'inset'].includes(one.property) ||
      one.property === 'padding-top' ||
      (one.property === 'padding' && !/^0(\D|$)/.test(one.value)),
  );
  assert.equal(
    reserved.length,
    0,
    `.subtitle-wrap is sized by something other than the words in it, so it holds stage even when empty: ${describe(reserved)}`,
  );
});

test('the subtitle line and the media note reserve no height of their own', () => {
  // Same failure one layer down, and the one that bites after the band is
  // gone: a height on the text is a visible empty box the moment the
  // background moves onto the text, which is what step 3 of the fix does.
  const css = read('styles.css');

  for (const className of ['subtitle', 'media-note']) {
    const reserved = declarationsFor(css, className).filter((one) => ['height', 'min-height'].includes(one.property));
    assert.equal(reserved.length, 0, `.${className} reserves height while empty: ${describe(reserved)}`);
  }
});

test('the subtitle background belongs to the text, so it hugs the words', () => {
  // What replaces the band: an inline box per wrapped line (the webvtt/BBC
  // shape). `display: inline` is the load-bearing half — a block element with
  // a background paints a full-width bar even with one short word in it, which
  // is the band bug rebuilt one element lower. `box-decoration-break: clone`
  // is what gives the second and third wrapped lines their own padded box
  // instead of one ragged shape spanning all three.
  const declarations = declarationsFor(read('styles.css'), 'subtitle');
  const painted = withProperty(declarations, 'background');
  assert.ok(painted.length > 0, '.subtitle has no background of its own — the words are unreadable over a light plate');

  // `:empty` carries a `display: none` of its own; it is the next test's business.
  const display = declarations
    .filter((one) => one.property === 'display' && !one.selector.includes(':empty'))
    .map((one) => one.value);
  assert.ok(
    display.includes('inline'),
    `.subtitle paints a background without being inline, so one short word paints a stage-wide bar (display: ${display.join(', ') || 'unset'})`,
  );
  assert.ok(
    declarations.some((one) => one.property.endsWith('box-decoration-break') && one.value === 'clone'),
    '.subtitle does not clone its box across wrapped lines',
  );
});

test('the media note is a line of its own, never a bar across the stage', () => {
  // The note stacks under the subtitle, and two inline siblings would share a
  // line — so this one is a block, and `fit-content` is then the whole of what
  // stands between it and a full-width band. It is one short line by
  // construction ("narration unavailable · read along"), so it needs no
  // per-line cloning; what it must never do is paint the picture.
  const declarations = declarationsFor(read('styles.css'), 'media-note');
  const painted = withProperty(declarations, 'background');
  assert.ok(painted.length > 0, '.media-note has no background of its own — it is unreadable over a light plate');

  const widths = declarations.filter((one) => one.property === 'width').map((one) => one.value);
  assert.ok(
    widths.includes('fit-content'),
    `.media-note paints a background without being shrink-wrapped, so it is a bar across the stage (width: ${widths.join(', ') || 'unset'})`,
  );
});

test('an empty line is not drawn at all', () => {
  // The resting state between every two lines of narration, and the state the
  // page loads in. An inline box with padding still paints that padding with
  // no text in it, and a shrink-wrapped block still paints its own — so
  // emptiness has to be a rule, not a consequence.
  const css = read('styles.css');

  for (const className of ['subtitle', 'media-note']) {
    const guarded = declarationsFor(css, className).some(
      (one) => one.selector.includes(':empty') && one.property === 'display' && one.value === 'none',
    );
    assert.ok(guarded, `.${className} is still drawn when it holds no text — nothing sets \`display: none\` on :empty`);
  }
});

test('turning subtitles off takes the whole subtitle area with it', async (t) => {
  // The toggle bug. `cc` off used to hide `#subtitle` alone, leaving the band
  // it sat in — and, once the band is gone, it would still leave the media
  // note, which reads "narration unavailable · read along" and is a lie the
  // moment there is nothing to read along with. The instance must hide the
  // container holding both lines, not one child.
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: {
      storylang_version: 0,
      cast: {}, objects: {}, audio: { sfx: {}, bgm: {} },
      scenes: [{
        place: 'dell',
        plate: { poster: 'assets/dell.jpg', video: 'assets/dell.mp4' },
        steps: [],
      }],
    },
    assetBase: 'https://storage.example/',
  });
  t.after(() => player.destroy());
  dom.lastImage().dispatch('load');
  await player.ready;

  const area = find(host.shadowRoot, (node) => node.className === 'subtitle-wrap');
  const subtitle = find(host.shadowRoot, (node) => node.className === 'subtitle');
  const note = find(host.shadowRoot, (node) => node.className === 'media-note');
  const button = find(host.shadowRoot, (node) => node.getAttribute?.('aria-label') === 'hide subtitles');
  assert.equal(subtitle.parent, area);
  assert.equal(note.parent, area);
  assert.equal(button.dispatch('click'), 1);
  assert.equal(area.hidden, true);
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  // Same weak-`hidden` trap `.quiet-button[hidden]` and `.end-overlay[hidden]`
  // already carry: the wrap is positioned and displayed by a rule of its own,
  // and any `display:` on it beats the UA's `hidden`. Without this line the
  // toggle above is one stylesheet edit from doing nothing, with a green suite.
  assert.match(
    read('styles.css'),
    /\.subtitle-wrap\[hidden\]\s*\{[^}]*display:\s*none/,
    'styles.css does not force the hidden subtitle area to actually disappear',
  );
});

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
