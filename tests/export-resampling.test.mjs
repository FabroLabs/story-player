import assert from 'node:assert/strict';
import test from 'node:test';
import * as audio from '../browser/v0/app/export-audio.mjs';

function resample(source, inputRate, outputRate) {
  assert.equal(typeof audio.resampleSource, 'function', 'streamed audio needs bounded rate conversion');
  return audio.resampleSource(source, inputRate, outputRate);
}
function toneSource(rate, length, frequencies = [720, 1280]) {
  const reads = [];
  return { length, reads, async read(from, count) {
    assert.ok(from >= 0 && count >= 0 && from + count <= length);
    reads.push({from, count});
    return frequencies.map(frequency => Float32Array.from({length: count}, (_, i) => 0.3 * Math.sin(2 * Math.PI * frequency * (from + i) / rate)));
  }};
}

test('44.1 kHz stereo keeps pitch and phase at 48 kHz across arbitrary read boundaries', async () => {
  const source = toneSource(44100, 44100);
  const converted = resample(source, 44100, 48000);
  assert.equal(converted.length, 48000);
  const all = await converted.read(1600, 6000);
  const first = await converted.read(1600, 1237), second = await converted.read(2837, 4763);
  for (const [channel, frequency] of [720, 1280].entries()) {
    assert.deepEqual(all[channel], Float32Array.from([...first[channel], ...second[channel]]));
    for (let i = 0; i < 6000; i++) {
      const expected = 0.3 * Math.sin(2 * Math.PI * frequency * (1600 + i) / 48000);
      assert.ok(Math.abs(all[channel][i] - expected) < 0.0005);
    }
  }
});

test('rate conversion reads only the requested window of a multi-hour track', async () => {
  const source = toneSource(44100, 44100 * 7200, [1000]);
  const converted = resample(source, 44100, 48000);
  const result = await converted.read(48000 * 3600, 2048);
  assert.equal(result[0].length, 2048);
  assert.equal(source.reads.length, 1);
  assert.ok(source.reads[0].count < 2200, 'must not decode the whole file');
});

test('downsampling rejects frequencies above the output Nyquist limit', async () => {
  const converted = resample(toneSource(96000, 96000, [1000, 30000]), 96000, 48000);
  const [low, high] = await converted.read(3000, 4096);
  const rms = values => Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
  assert.ok(rms(low) > 0.20);
  assert.ok(rms(high) < 0.003, 'high frequencies must not alias into the audible mix');
});

test('loop reads return the same phase after wrapping and retain exact half-second duration', async () => {
  const converted = resample(toneSource(44100, 22050), 44100, 48000);
  assert.equal(converted.length, 24000);
  const initial = await converted.read(0, 100);
  await converted.read(23900, 100);
  assert.deepEqual(await converted.read(0, 100), initial);
  const cue = {start_ms: 0, end_ms: 1100, loop: true};
  const left = new Float32Array(52800), right = new Float32Array(52800);
  await audio.mixCue(cue, converted, 0, left, right, 48000);
  assert.deepEqual(left.slice(0, 24000), left.slice(24000, 48000));
  assert.deepEqual(right.slice(0, 4800), right.slice(48000));
});

test('constant audio remains constant at the first and last resampled frames', async () => {
  const source = {length: 100, read: async (_, count) => [new Float32Array(count).fill(0.25)]};
  const converted = resample(source, 44100, 48000);
  for (const value of (await converted.read(0, converted.length))[0]) assert.ok(Math.abs(value - 0.25) < 1e-6);
});

test('equal-rate and empty sources retain their existing reader', () => {
  const source = toneSource(48000, 48000);
  assert.equal(resample(source, 48000, 48000), source);
  const empty = {length: 0};
  assert.equal(resample(empty, 44100, 48000), empty);
});
