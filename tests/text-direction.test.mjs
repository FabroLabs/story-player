/**
 * The canvas has no `dir="auto"`, so the player decides for it: a line reads
 * right to left when its first strong letter is Arabic or Hebrew, and every
 * other line is left exactly as it was drawn before.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlayerTemplate } from '../browser/template.mjs';
import { textDirection } from '../browser/v0/app/stage/text-direction.mjs';
import { installDom } from './_dom.mjs';

test('an Arabic line reads right to left, whatever it ends on', () => {
  assert.equal(textDirection('دورُكِ يا ليلى! متى نأكل الفطور؟'), 'rtl');
  assert.equal(textDirection('أربعة.'), 'rtl');
  assert.equal(textDirection('«٣ + ١ = ٤» أحسنت!'), 'rtl');
  assert.equal(textDirection('שלום'), 'rtl');
});

test('an English line, a bare number and nothing at all stay left to right', () => {
  assert.equal(textDirection('Your turn, Laila! When do we eat breakfast?'), 'ltr');
  assert.equal(textDirection('Laila قالت مرحبا'), 'ltr');
  assert.equal(textDirection('٤.'), 'ltr');
  assert.equal(textDirection('4'), 'ltr');
  assert.equal(textDirection(''), 'ltr');
  assert.equal(textDirection(undefined), 'ltr');
});

test('every element that shows the story’s own words lets the browser pick its direction', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const elements = createPlayerTemplate(host.attachShadow({ mode: 'open' }));
  const story = {
    subtitle: elements.stage.subtitle, title: elements.title, badge: elements.badge.name,
    cardLine: elements.card.line, cardTitle: elements.card.title.name,
  };
  for (const [name, node] of Object.entries(story)) assert.equal(node.getAttribute('dir'), 'auto', name);
});
