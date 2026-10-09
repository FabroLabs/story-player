import assert from 'node:assert/strict';
import test from 'node:test';

import { createMp4Writer, videoTicks } from '../browser/v0/app/mp4-writer.mjs';

/** The boxes in `bytes`, one level deep: `[{ type, start, end, body }]`. */
function boxes(bytes, from = 0, to = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = [];
  for (let at = from; at < to;) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    assert.ok(size >= 8 && at + size <= to, `${type} states a length inside its parent`);
    found.push({ type, start: at, end: at + size, body: at + 8 });
    at += size;
  }
  return found;
}
const inside = (bytes, box, skip = 0) => boxes(bytes, box.body + skip, box.end);
const named = (list, type) => list.filter((box) => box.type === type);
const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);

function write({ video = { codec: 'avc', width: 1278, height: 718, description: Uint8Array.of(1, 100, 0, 40) },
  audio = { codec: 'aac', sampleRate: 48000, channels: 2, description: Uint8Array.of(0x11, 0x90) } } = {}) {
  const pieces = [];
  const writer = createMp4Writer({ video, audio, durationMs: 4000, write: (piece) => pieces.push(piece) });
  const file = () => Uint8Array.from(pieces.flatMap((piece) => [...piece]));
  return { writer, pieces, file };
}

test('the header names both tracks, and holds no samples of its own', () => {
  const { file } = write();
  const top = boxes(file());
  assert.deepEqual(top.map((box) => box.type), ['ftyp', 'moov']);
  const moov = inside(file(), top[1]);
  assert.deepEqual(moov.map((box) => box.type), ['mvhd', 'trak', 'trak', 'mvex']);
  const text = Buffer.from(file()).toString('latin1');
  for (const expected of ['avc1', 'avcC', 'mp4a', 'esds', 'vide', 'soun', 'mehd', 'trex']) assert.ok(text.includes(expected), expected);
  // mehd: the story's length, known before the first frame.
  const mehd = named(inside(file(), named(moov, 'mvex')[0]), 'mehd')[0];
  assert.equal(u32(file(), mehd.body + 4), 4000);
});

test('each piece carries its picture and sound, found by counting from its own header', () => {
  const { writer, file } = write();
  const frame = (fill, length) => new Uint8Array(length).fill(fill);
  writer.video({ data: frame(1, 30), duration: videoTicks(1000 / 24), key: true });
  writer.video({ data: frame(2, 10), duration: videoTicks(1000 / 24), key: false });
  writer.audio({ data: frame(3, 7), duration: 1024 });
  writer.flush();
  writer.video({ data: frame(4, 20), duration: videoTicks(1000 / 24), key: true });
  writer.flush();
  writer.flush();
  const length = writer.finish();
  const bytes = file();
  assert.equal(length, bytes.length);
  const top = boxes(bytes);
  assert.deepEqual(top.map((box) => box.type), ['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat', 'mfra'], 'an empty flush writes nothing');

  const [first, second] = named(top, 'moof');
  const trafs = named(inside(bytes, first), 'traf');
  assert.equal(trafs.length, 2);
  const [picture, sound] = trafs.map((traf) => {
    const parts = inside(bytes, traf);
    const trun = named(parts, 'trun')[0];
    const tfdt = named(parts, 'tfdt')[0];
    return {
      track: u32(bytes, named(parts, 'tfhd')[0].body + 4), time: u32(bytes, tfdt.body + 8),
      flags: u32(bytes, trun.body) & 0xffffff, count: u32(bytes, trun.body + 4), offset: u32(bytes, trun.body + 8), trun,
    };
  });
  assert.deepEqual([picture.track, picture.count, picture.time], [1, 2, 0]);
  assert.deepEqual([sound.track, sound.count, sound.time], [2, 1, 0]);
  // Offsets count from the fragment's own first byte, into the mdat that follows it.
  assert.equal(bytes[first.start + picture.offset], 1, 'the first frame');
  assert.equal(bytes[first.start + picture.offset + 30], 2, 'the second, straight after it');
  assert.equal(bytes[first.start + sound.offset], 3, 'the sound, after the picture');
  // Per frame: a duration, a size, and whether it can be seeked to.
  assert.deepEqual([u32(bytes, picture.trun.body + 12), u32(bytes, picture.trun.body + 16), u32(bytes, picture.trun.body + 20)],
    [3750, 30, 0x02000000]);
  assert.equal(u32(bytes, picture.trun.body + 32), 0x01010000, 'a frame that leans on the one before it');
  assert.deepEqual([u32(bytes, sound.trun.body + 12), u32(bytes, sound.trun.body + 16)], [1024, 7]);

  const later = inside(bytes, named(inside(bytes, second), 'traf')[0]);
  assert.equal(u32(bytes, named(later, 'tfdt')[0].body + 8), 7500, 'the second piece starts where the first one’s frames ended');
  assert.equal(u32(bytes, named(inside(bytes, second), 'mfhd')[0].body + 4), 2);

  // The index: where each piece of picture starts, and its own length at the very end.
  const mfra = named(top, 'mfra')[0];
  const tfra = inside(bytes, mfra)[0];
  assert.equal(u32(bytes, tfra.body + 12), 2);
  assert.equal(u32(bytes, tfra.body + 16 + 12), first.start, 'the first piece, by its place in the file');
  assert.equal(u32(bytes, tfra.body + 16 + 19 + 4), 7500);
  assert.equal(u32(bytes, tfra.body + 16 + 19 + 12), second.start);
  assert.equal(u32(bytes, bytes.length - 4), mfra.end - mfra.start);
  writer.video({ data: frame(9, 5), duration: 1, key: true });
  assert.equal(writer.finish(), length, 'a finished file takes nothing more');
});

test('a browser without the licensed codecs is written as vp9 and opus', () => {
  const head = new Uint8Array(19);
  head.set(Buffer.from('OpusHead'));
  new DataView(head.buffer).setUint16(10, 312, true);
  const { file } = write({
    video: { codec: 'vp9', width: 1280, height: 720, description: 'vp09.00.31.08' },
    audio: { codec: 'opus', sampleRate: 48000, channels: 2, description: head },
  });
  const text = Buffer.from(file()).toString('latin1');
  for (const expected of ['vp09', 'vpcC', 'Opus', 'dOps']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('avc1'));
  const at = text.indexOf('dOps') + 4;
  assert.deepEqual([...file().subarray(at, at + 4)], [0, 2, 1, 56], 'version, channels and the pre-skip, big end first');
  assert.throws(() => write({ video: { codec: 'hevc', width: 2, height: 2 } }), /cannot be written/);
});
