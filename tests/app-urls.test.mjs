import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStoryUrl } from '../browser/shell/urls.mjs';
import {
  normalizeAssetBase,
  resolveAssetKey,
  resolveNarrationUrl,
  resolveStoryAssets,
} from '../browser/v0/app/urls.mjs';

test('resolves a story query path from the repository root instead of the player directory', () => {
  const pageUrl = 'http://localhost:8000/player/index.html?story=build/ruby/story.json';

  assert.equal(
    resolveStoryUrl('build/ruby/story.json', pageUrl),
    'http://localhost:8000/build/ruby/story.json',
  );
});

// Each case names the rule that must refuse it, not merely THAT it is refused:
// the rules overlap, so asserting "it throws" leaves any one of them deletable
// with the suite green. The message is the reader's only clue, and it is the
// one thing that tells the rules apart.
const HOSTILE = [
  ['https://evil.example/story.json', 'not a full URL'],
  ['HTTPS://evil.example/story.json', 'not a full URL'],
  ['javascript:alert(1)', 'not a full URL'],
  ['data:application/json,{}', 'not a full URL'],
  ['//evil.example/story.json', 'not another host'],
  // a backslash is a slash to the URL parser for http(s), so these name a host
  // just as surely as `//` does, and no `/`-only rule sees it
  ['\\\\evil.example/story.json', 'not another host'],
  ['/\\evil.example/story.json', 'not another host'],
  ['../../../etc/passwd', 'may not climb'],
  ['build/../../etc/passwd', 'may not climb'],
  ['..\\..\\etc\\passwd', 'may not climb'],
  // the same climbs in spellings a text search does not recognise but the URL
  // parser does: these went through while the plain `../../x` was refused
  ['build/%2e%2e/%2e%2e/etc/passwd', 'may not climb'],
  ['.%2e/.%2e/etc/passwd', 'may not climb'],
  ['%2E%2E/x.json', 'may not climb'],
];

test('refuses a ?story= that points anywhere but this site, naming the rule', () => {
  // the bundle is trusted once fetched — its fields drive video.src, new Audio()
  // and background-image — so a link that chooses the bundle chooses what this
  // origin performs
  for (const pageUrl of [
    'http://localhost:8000/player/index.html',
    // and again with the player served from a subdirectory, which is the shape
    // the web app uses: there really is somewhere above it to climb to
    'https://app.example/ui/player/index.html',
  ]) {
    for (const [hostile, rule] of HOSTILE) {
      assert.throws(
        () => resolveStoryUrl(hostile, pageUrl),
        (error) =>
          error.message.startsWith(`refusing ?story=${hostile} —`) &&
          error.message.includes(rule),
        `${hostile} on ${pageUrl}: expected the "${rule}" rule`,
      );
    }
  }
});

test('a story path on this site still resolves from the repository root', () => {
  const pageUrl = 'http://localhost:8000/player/index.html';

  assert.equal(resolveStoryUrl('build/x/story.json', pageUrl), 'http://localhost:8000/build/x/story.json');
  assert.equal(resolveStoryUrl('./build/x/story.json', pageUrl), 'http://localhost:8000/build/x/story.json');
  // a leading slash is this origin too, and is what the web app will serve
  assert.equal(resolveStoryUrl('/stories/7/story.json', pageUrl), 'http://localhost:8000/stories/7/story.json');
  // a story whose name merely contains dots is not a climb
  assert.equal(resolveStoryUrl('build/v1.2/story.json', pageUrl), 'http://localhost:8000/build/v1.2/story.json');
  assert.equal(resolveStoryUrl('', pageUrl), null);
});

test('resolves bundled narration beside story.json and refuses absolute narration', () => {
  const storyUrl = 'http://localhost:8000/build/ruby/story.json';

  assert.equal(resolveNarrationUrl('audio/voice.wav', storyUrl), 'http://localhost:8000/build/ruby/audio/voice.wav');
  assert.throws(() => resolveNarrationUrl('https://media.example/voice.wav', storyUrl), /asset key/);
  assert.equal(resolveNarrationUrl(null, storyUrl), null);
});

test('normalizes a trusted asset base as a directory without dropping its path', () => {
  assert.equal(normalizeAssetBase('https://cdn.example/v2/fairytale-assets'), 'https://cdn.example/v2/fairytale-assets/');
  assert.equal(resolveAssetKey('sprites/rabbit/idle.png', 'https://cdn.example/v2/fairytale-assets'), 'https://cdn.example/v2/fairytale-assets/sprites/rabbit/idle.png');
});

test('refuses unsafe asset bases and keys before URL resolution', () => {
  for (const base of [
    '',
    '/assets',
    'ftp://cdn.example/assets',
    'https://user:secret@cdn.example/assets',
    'https://cdn.example/assets?version=1',
    'https://cdn.example/assets#current',
  ]) assert.throws(() => normalizeAssetBase(base), /asset base/);

  for (const key of [
    '',
    'https://evil.example/x.png',
    '//evil.example/x.png',
    '/sprites/x.png',
    'sprites/../x.png',
    'sprites/%2e%2e/x.png',
    'sprites//x.png',
    'sprites\\x.png',
    'sprites/x.png?download=1',
  ]) assert.throws(() => resolveAssetKey(key, 'https://cdn.example/assets'), /asset key/);
});

test('projects every bucket key once without mutating narration or the input bundle', () => {
  const story = {
    cast: {
      rabbit: {
        clips: {
          idle: { spritesheet: 'sprites/rabbit/idle.png', atlas: 'sprites/rabbit/idle.json' },
        },
      },
    },
    objects: { lamp: { svg: 'objects/lamp.svg' } },
    audio: { sfx: { pop: 'audio/sfx/pop.mp3' }, bgm: { calm: 'audio/bgm/calm.mp3' } },
    scenes: [{
      plate: { video: 'plates/dell.mp4', poster: 'plates/dell.jpg' },
      steps: [{ kind: 'chunk', audio: 'audio/narration.wav' }],
    }],
  };
  const before = JSON.stringify(story);
  const projected = resolveStoryAssets(story, 'https://cdn.example/assets');

  assert.equal(JSON.stringify(story), before, 'the saved bundle was mutated');
  assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected.cast.rabbit.clips.idle));
  assert.equal(projected.cast.rabbit.clips.idle.spritesheet, 'https://cdn.example/assets/sprites/rabbit/idle.png');
  assert.equal(projected.cast.rabbit.clips.idle.atlas, 'https://cdn.example/assets/sprites/rabbit/idle.json');
  assert.equal(projected.objects.lamp.svg, 'https://cdn.example/assets/objects/lamp.svg');
  assert.equal(projected.audio.sfx.pop, 'https://cdn.example/assets/audio/sfx/pop.mp3');
  assert.equal(projected.audio.bgm.calm, 'https://cdn.example/assets/audio/bgm/calm.mp3');
  assert.equal(projected.scenes[0].plate.video, 'https://cdn.example/assets/plates/dell.mp4');
  assert.equal(projected.scenes[0].plate.poster, 'https://cdn.example/assets/plates/dell.jpg');
  assert.equal(projected.scenes[0].steps[0].audio, 'audio/narration.wav');
});

test('one identical bundle follows either supplied asset base in every bucket field', () => {
  const story = {
    cast: { rabbit: { clips: { idle: { spritesheet: 'sprites/rabbit.png', atlas: null } } } },
    objects: { lamp: { svg: 'objects/lamp.svg' } },
    audio: { sfx: { pop: 'audio/sfx/pop.mp3' }, bgm: { calm: 'audio/bgm/calm.mp3' } },
    scenes: [{
      plate: { video: 'plates/dell.mp4', poster: 'plates/dell.jpg' },
      steps: [{ kind: 'chunk', audio: 'audio/narration.wav' }],
    }],
  };
  const assetUrls = (projected) => [
    projected.cast.rabbit.clips.idle.spritesheet,
    projected.objects.lamp.svg,
    projected.audio.sfx.pop,
    projected.audio.bgm.calm,
    projected.scenes[0].plate.video,
    projected.scenes[0].plate.poster,
  ];

  for (const base of ['https://assets-a.example/bucket', 'https://assets-b.example/zone']) {
    const projected = resolveStoryAssets(story, base);
    assert.ok(assetUrls(projected).every((url) => url.startsWith(`${base}/`)));
    assert.equal(projected.scenes[0].steps[0].audio, 'audio/narration.wav');
  }
});

test('refuses legacy and mixed clip fields before projecting any story assets', () => {
  for (const clip of [
    { spritesheet_url: 'https://old.example/x.png', atlas_url: null },
    { spritesheet: 'sprites/x.png', spritesheet_url: 'https://old.example/x.png', atlas: null },
  ]) {
    assert.throws(
      () => resolveStoryAssets({ cast: { rabbit: { clips: { idle: clip } } } }, 'https://cdn.example/assets'),
      /legacy asset field/,
    );
  }
});
