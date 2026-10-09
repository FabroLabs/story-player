import assert from 'node:assert/strict';
import test from 'node:test';

import { looksLikeMp4, readM4a } from '../browser/v0/app/m4a-reader.mjs';

const ascii = (text) => [...text].map((letter) => letter.charCodeAt(0));
const u16 = (value) => [(value >>> 8) & 0xff, value & 0xff];
const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const box = (type, ...parts) => { const body = parts.flat(); return [...u32(8 + body.length), ...ascii(type), ...body]; };
const full = (type, ...parts) => box(type, [0, 0, 0, 0], ...parts);

/**
 * A small m4a as the engine's encoder lays one out: the table of contents first,
 * three packets in two chunks, and an edit list that drops the encoder's lead-in.
 * `0x12 0x10` is plain AAC at 44.1 kHz in stereo.
 */
function m4a({ sizes = [5, 6, 7], lead = 1024, soundFirst = true, entry = 'mp4a', config = [0x12, 0x10] } = {}) {
  const esds = full('esds', [0x03, 0x19, 0, 0, 0], [0x04, 0x11, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0)], [0x05, config.length, ...config], [0x06, 1, 2]);
  const sound = (offsets) => box('trak',
    box('edts', full('elst', u32(1), u32(0), u32(lead), u32(0x00010000))),
    box('mdia',
      full('mdhd', u32(0), u32(0), u32(44100), u32(0), u16(0x55c4), u16(0)),
      full('hdlr', u32(0), ascii('soun'), new Array(12).fill(0), [0]),
      box('minf', box('stbl',
        full('stsd', u32(1), box(entry, new Array(6).fill(0), u16(1), new Array(8).fill(0), u16(2), u16(16), u16(0), u16(0), u32(44100 * 65536), esds)),
        full('stts', u32(1), u32(sizes.length), u32(1024)),
        full('stsc', u32(2), u32(1), u32(2), u32(1), u32(2), u32(1), u32(1)),
        full('stsz', u32(0), u32(sizes.length), ...sizes.map(u32)),
        full('stco', u32(offsets.length), ...offsets.map(u32))))));
  const picture = box('trak', box('mdia', full('hdlr', u32(0), ascii('vide'), new Array(12).fill(0), [0])));
  const head = box('ftyp', ascii('M4A '), u32(0), ascii('isom'));
  const moovLength = box('moov', ...(soundFirst ? [] : [picture]), sound([0, 0])).length;
  const data = head.length + moovLength + 8;
  const moov = box('moov', ...(soundFirst ? [] : [picture]), sound([data, data + sizes[0] + sizes[1]]));
  const payload = sizes.flatMap((size, index) => new Array(size).fill(index + 1));
  return Uint8Array.from([...head, ...moov, ...box('mdat', payload)]);
}

test('an engine m4a is read from its table of contents: what it is, and where every packet lies', () => {
  const bytes = m4a();
  const sound = readM4a(bytes);
  assert.equal(sound.codec, 'mp4a.40.2');
  assert.equal(sound.sampleRate, 44100);
  assert.equal(sound.channels, 2);
  assert.deepEqual([...sound.description], [0x12, 0x10]);
  assert.equal(sound.frames, 1024);
  assert.equal(sound.skip, 1024, 'the encoder’s lead-in, which the file itself says to drop');
  assert.deepEqual(sound.samples.map((packet) => packet.size), [5, 6, 7]);
  // Two packets share the first chunk and the third has a chunk of its own.
  for (const [index, packet] of sound.samples.entries()) {
    assert.deepEqual([...bytes.subarray(packet.offset, packet.offset + packet.size)], new Array(packet.size).fill(index + 1));
  }
  assert.equal(readM4a(bytes.buffer).samples.length, 3, 'an ArrayBuffer is read as well');
});

test('the sound track is found beside a picture, and a file with no lead-in drops nothing', () => {
  assert.equal(readM4a(m4a({ soundFirst: false, lead: 0 })).skip, 0);
  assert.equal(readM4a(m4a({ soundFirst: false })).samples.length, 3);
});

test('anything that is not plain AAC in an ordinary mp4 is refused, so the take can fall back', () => {
  assert.throws(() => readM4a(Uint8Array.from(ascii('RIFF....WAVEfmt '))), /table of contents/);
  assert.throws(() => readM4a(m4a({ entry: 'alac' })), /not AAC/);
  assert.throws(() => readM4a(m4a({ config: [0x2b, 0x92] })), /plain AAC/);
  const cut = m4a();
  assert.throws(() => readM4a(cut.subarray(0, cut.length - 4)), /outside the file/);
  assert.equal(looksLikeMp4(m4a()), true);
  assert.equal(looksLikeMp4(Uint8Array.from(ascii('RIFF....WAVEfmt '))), false);
});
