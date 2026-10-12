/**
 * The Moonykids mark and the name under it.
 *
 * Two pictures, not a picture and a line of text: the player ships no font, and the name is the
 * brand's own lettering. What these pin is what keeps the pair one thing — the same two pictures,
 * in the same order, on the stage, on the card layer and in a saved video — and the one rule that
 * is the stylesheet's alone: the name is as wide as the mark, so it is shown only where a mark is
 * wide enough to read it under.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { BRAND_MARK, BRAND_WORD } from '../browser/brand.mjs';
import { createPlayerTemplate } from '../browser/template.mjs';
import { findByClass, installDom } from './_dom.mjs';

function png(dataUrl) {
  const [type, encoded] = dataUrl.split(',');
  const bytes = Buffer.from(encoded, 'base64');
  return { type, signature: bytes.toString('latin1', 1, 4), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the name is a picture of its own: one line of lettering, embedded like the mark', () => {
  const mark = png(BRAND_MARK);
  const word = png(BRAND_WORD);
  assert.equal(word.type, 'data:image/png;base64');
  assert.equal(word.signature, 'PNG');
  assert.equal(mark.width, mark.height, 'the mark is no longer the square the name was drawn under');
  assert.ok(word.width > word.height * 3, 'the name is a line under the mark, not a second mark');
});

test('the stage and the card layer each carry the mark with the name under it', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const elements = createPlayerTemplate(host.attachShadow({ mode: 'open' }));
  const pictures = (brand) => brand.children.map((picture) => picture.getAttribute('src'));

  for (const [where, layer] of [['stage', elements.stage.stage], ['card layer', elements.card.layer]]) {
    const brand = findByClass(layer, 'story-brand');
    assert.ok(brand, `no mark on the ${where}`);
    assert.deepEqual(pictures(brand), [BRAND_MARK, BRAND_WORD], `the ${where} lost a picture`);
    assert.equal(brand.children[1].className, 'brand-word');
    // Decoration twice over: nothing here is for a screen reader, or for a drag.
    assert.equal(brand.getAttribute('aria-hidden'), 'true');
    for (const picture of brand.children) assert.equal(picture.getAttribute('draggable'), 'false');
  }
  // What a saved video draws: the stage's own two pictures, in their order.
  assert.deepEqual(elements.stage.brand, findByClass(elements.stage.stage, 'story-brand').children);
});

test('the name is shown only on a player wide enough to read it', () => {
  const css = fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.story-brand \.brand-word\s*\{\s*display:\s*none;\s*\}/, 'the name is not withheld by default');
  // A stage 600 wide is a frame at least that wide and 16:9's 338 tall: the frame is the
  // container, and a wide strip inside an app letterboxes a far smaller stage.
  assert.match(
    css,
    /@container player \(min-width: 600px\) and \(min-height: 338px\)\s*\{\s*\.story-brand \.brand-word\s*\{\s*display:\s*block;\s*\}\s*\}/,
    'no rule brings the name back on a player that can show it',
  );
});
