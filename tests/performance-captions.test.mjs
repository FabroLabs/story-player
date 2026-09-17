import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';

function storyWithCaptions() {
  return {
    performance: {
      kind: 'wht', resolution: [1000, 562.5],
      required_capabilities: ['audio', 'captions'],
    },
    assets: {},
    scenes: [
      { id: 'first', start_ms: 0, end_ms: 2000, nodes: [] },
      { id: 'second', start_ms: 2000, end_ms: 4000, nodes: [] },
    ],
    audio: [
      { id: 'song', kind: 'music', media: 'songs/abc.m4a', start_ms: 0,
        duration_ms: 4000, end_ms: 4000, volume: 1, loop: false },
    ],
    captions: [
      { start_ms: 250, end_ms: 1000, text: 'A is for apple' },
      { start_ms: 1000, end_ms: 1800, text: 'B is for ball' },
      { start_ms: 1900, end_ms: 2500, text: 'C is for cat' },
      { start_ms: 3000, end_ms: 4000, text: 'Sing A to Z!' },
    ],
  };
}

test('captions follow absolute half-open intervals, gaps and scene cuts in any seek order', () => {
  const story = storyWithCaptions();
  const timeline = compileTimeline(story);
  const cursor = createStateCursor(timeline, story);
  const before = JSON.stringify(story);
  for (const [time, subtitle] of [
    [3999, 'Sing A to Z!'], [1000, 'B is for ball'], [249, ''],
    [250, 'A is for apple'], [999.5, 'A is for apple'], [1800, ''],
    [1900, 'C is for cat'], [2000, 'C is for cat'], [2500, ''],
    [3000, 'Sing A to Z!'], [4000, ''], [5000, ''], [0, ''],
  ]) {
    assert.equal(stateAt(timeline, story, time).subtitle, subtitle, String(time));
    assert.equal(cursor.at(time).subtitle, subtitle, `cursor ${time}`);
  }
  assert.equal(JSON.stringify(story), before);
});

test('a present caption array owns subtitles even when empty or in a narration gap', () => {
  const story = storyWithCaptions();
  story.audio.push({ id: 'voice', kind: 'narration', media: 'songs/voice.m4a',
    start_ms: 0, duration_ms: 2500, text: 'Narration fallback' });
  assert.equal(stateAt(compileTimeline(story), story, 0).subtitle, '');
  assert.equal(stateAt(compileTimeline(story), story, 250).subtitle, 'A is for apple');
  story.captions = [];
  assert.equal(stateAt(compileTimeline(story), story, 250).subtitle, '');
  delete story.captions;
  const timeline = compileTimeline(story);
  assert.equal(stateAt(timeline, story, 250).subtitle, 'Narration fallback');
  assert.equal(stateAt(timeline, story, 2500).subtitle, '');
});

test('captions leave the single full-volume nonlooping song and timeline events unchanged', () => {
  const story = storyWithCaptions();
  const withCaptions = compileTimeline(story);
  const state = stateAt(withCaptions, story, 2000);
  delete story.captions;
  const withoutCaptions = compileTimeline(story);
  assert.deepEqual(withCaptions.events, withoutCaptions.events);
  assert.deepEqual(state.audio, stateAt(withoutCaptions, story, 2000).audio);
  assert.equal(story.audio.length, 1);
  assert.equal(story.audio[0].volume, 1);
  assert.equal(story.audio[0].loop, false);
});

test('caption presence requires the captions capability, including an empty array', () => {
  for (const captions of [[], [{ start_ms: 0, end_ms: 1000, text: 'A' }]]) {
    const story = storyWithCaptions();
    story.captions = captions;
    story.performance.required_capabilities = ['audio'];
    assert.throws(() => compileTimeline(story), /captions.*capability/i);
  }
});

const invalidCaptions = [
  ['null array', null], ['object array', {}], ['undefined array', undefined],
  ['null cue', [null]], ['array cue', [[]]], ['missing fields', [{}]],
  ...[
    ['missing start', { end_ms: 1000, text: 'A' }],
    ['missing end', { start_ms: 0, text: 'A' }],
    ['missing text', { start_ms: 0, end_ms: 1000 }],
    ['negative start', { start_ms: -1 }], ['nonfinite start', { start_ms: NaN }],
    ['infinite end', { end_ms: Infinity }], ['string time', { start_ms: '0' }],
    ['null time', { start_ms: null }], ['empty interval', { end_ms: 0 }],
    ['reversed interval', { start_ms: 1001 }], ['past story', { end_ms: 4001 }],
    ['empty text', { text: '' }], ['blank text', { text: ' \n\t' }],
    ['nonstring text', { text: 3 }], ['null text', { text: null }],
    ['unknown field', { alignment: 'top' }],
  ].map(([name, fields]) => [name, [name.startsWith('missing') ? fields :
    { start_ms: 0, end_ms: 1000, text: 'A', ...fields }]]),
  ['overlap', [{ start_ms: 0, end_ms: 1001, text: 'A' },
    { start_ms: 1000, end_ms: 2000, text: 'B' }]],
  ['unordered', [{ start_ms: 2000, end_ms: 3000, text: 'B' },
    { start_ms: 0, end_ms: 1000, text: 'A' }]],
];
for (const [name, captions] of invalidCaptions) {
  test(`invalid captions refuse before playback: ${name}`, () => {
    const story = storyWithCaptions();
    story.captions = captions;
    assert.throws(() => compileTimeline(story), /performance/i);
  });
}

test('caption edits cannot reuse compiled instructions from a different lyric or timing', () => {
  for (const edit of [
    (story) => { story.captions[0].text = 'A different lyric'; },
    (story) => { story.captions[0].start_ms = 251; },
    (story) => { story.captions[0].end_ms = 999; },
    (story) => { delete story.captions; },
  ]) {
    const story = storyWithCaptions();
    story.instructions = compileTimeline(story);
    edit(story);
    assert.throws(() => compileTimeline(story), /instructions do not match/i);
  }
});
