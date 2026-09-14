/**
 * The board's counter picture: fetched once at the mount, held for the life
 * of the player, and honest about not being there yet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCounterPicture } from '../browser/v0/app/assets/counter-picture.mjs';

const URL_ = 'https://storage.example/fairytale-assets/counters/nut.png';
const settled = () => new Promise((resolve) => setImmediate(resolve));
const bitmap = () => ({ width: 1024, height: 1024, closed: false, close() { this.closed = true; } });

test('the picture is asked for once, is nothing until it lands, and is held once it has', async () => {
  const asked = [];
  let land;
  const decode = (url) => {
    asked.push(url);
    return new Promise((resolve) => { land = resolve; });
  };
  const picture = loadCounterPicture(URL_, { decode });

  assert.equal(picture.url, URL_, 'the list reads the url to know a picture was asked for');
  assert.equal(picture.drawable, null, 'a picture that has not landed is drawn as the apple');
  const landed = bitmap();
  land(landed);
  await settled();
  assert.equal(picture.drawable, landed);
  assert.equal(await picture.landed, landed, '`landed` is the drawable, for the caller that acts on the instant');
  assert.deepEqual(asked, [URL_]);

  // Closed with the player, like every other decoded bitmap.
  picture.close();
  assert.equal(landed.closed, true);
  assert.equal(picture.drawable, null);
});

test('a picture that cannot be fetched is named once, and the apple stands in for good', async () => {
  const warnings = [];
  const picture = loadCounterPicture(URL_, {
    decode: async () => { throw new Error(`asset ${URL_} answered 404`); },
    onWarning: (detail) => warnings.push(detail),
  });
  await settled();

  assert.equal(picture.drawable, null);
  assert.equal(await picture.landed, null, 'a picture that is not coming settles `landed` rather than leaving it hanging');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'media');
  assert.equal(warnings[0].asset, 'board-counter');
  assert.equal(warnings[0].url, URL_);
  assert.match(warnings[0].message, /counter picture could not be loaded: asset .* answered 404/);
});

test('a picture landing after the player went is closed rather than held, and an abort is not a failure', async () => {
  let land;
  const late = loadCounterPicture(URL_, { decode: () => new Promise((resolve) => { land = resolve; }) });
  late.close();
  const landed = bitmap();
  land(landed);
  await settled();
  assert.equal(landed.closed, true, 'a bitmap nobody will draw was kept open');
  assert.equal(late.drawable, null);

  const warnings = [];
  loadCounterPicture(URL_, {
    decode: async () => { throw new DOMException('player destroyed', 'AbortError'); },
    onWarning: (detail) => warnings.push(detail),
  });
  await settled();
  assert.deepEqual(warnings, [], 'the player\'s own teardown was reported as a media failure');
});
