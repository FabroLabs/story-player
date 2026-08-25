import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAssetBase,
  requireCardsBlock,
  resolveMediaUrl,
  resolveStoryAssets,
} from '../browser/v0/app/urls.mjs';

const BASE = 'https://storage.example.com/root';

test('resolves bucket-qualified media under the one caller-supplied storage base', () => {
  assert.equal(
    resolveMediaUrl('fairytale-assets/sprites/rabbit/idle.png', BASE),
    'https://storage.example.com/root/fairytale-assets/sprites/rabbit/idle.png',
  );
  assert.equal(
    resolveMediaUrl('jobs/story-7/audio/voice.wav', BASE),
    'https://storage.example.com/root/jobs/story-7/audio/voice.wav',
  );
  assert.equal(
    resolveMediaUrl('audio/voice.wav', BASE),
    'https://storage.example.com/root/audio/voice.wav',
    'a syntactically valid bucket cannot be guessed to be a legacy directory',
  );
  assert.equal(
    resolveMediaUrl('999.999.999.999/object.png', BASE),
    'https://storage.example.com/root/999.999.999.999/object.png',
    'numeric DNS names that are not IP addresses remain valid S3 bucket names',
  );
});

test('normalizes a trusted asset base as a directory without dropping its path', () => {
  assert.equal(normalizeAssetBase(BASE), `${BASE}/`);
});

test('refuses unsafe bases and any path that is not bucket-qualified', () => {
  for (const base of [
    '',
    '/assets',
    'ftp://storage.example/assets',
    'https://user:secret@storage.example/assets',
    'https://storage.example/assets?version=1',
    'https://storage.example/assets#current',
  ]) assert.throws(() => normalizeAssetBase(base), /asset base/);

  for (const mediaPath of [
    '',
    'story.json',
    'https://evil.example/x.png',
    '//evil.example/x.png',
    '/fairytale-assets/sprites/x.png',
    'fairytale-assets/sprites/../x.png',
    'fairytale-assets/sprites/./x.png',
    'fairytale-assets/sprites/%2e%2e/x.png',
    'fairytale-assets/sprites/%2fsecret.png',
    'fairytale-assets/sprites/%5csecret.png',
    'fairytale-assets/sprites//x.png',
    'fairytale-assets\\sprites\\x.png',
    'fairytale-assets/sprites/x.png?download=1',
    'fairytale-assets/sprites/x.png#frame',
    'a.-b/object.png',
    'a-.b/object.png',
    '127.0.0.1/object.png',
    'Abc/object.png',
    'ab/object.png',
    `${'a'.repeat(64)}/object.png`,
    '-abc/object.png',
    'abc-/object.png',
    'a..b/object.png',
  ]) assert.throws(() => resolveMediaUrl(mediaPath, BASE), /media path/);
});

test('projects permanent and narration media once without mutating the saved bundle', () => {
  const story = {
    cast: {
      rabbit: {
        clips: {
          idle: {
            spritesheet: 'fairytale-assets/sprites/rabbit/idle.png',
            atlas: 'fairytale-assets/sprites/rabbit/idle.json',
          },
        },
      },
    },
    objects: { lamp: { svg: 'fairytale-assets/objects/lamp.svg' } },
    audio: {
      sfx: { pop: 'fairytale-assets/audio/sfx/pop.mp3' },
      bgm: { calm: 'fairytale-assets/audio/bgm/calm.mp3' },
    },
    scenes: [{
      plate: {
        video: 'fairytale-assets/plates/dell.mp4',
        poster: 'fairytale-assets/plates/dell.jpg',
      },
      steps: [
        { kind: 'chunk', audio: 'jobs/story-7/audio/open.wav' },
        {
          kind: 'together',
          steps: [{ kind: 'chunk', audio: 'jobs/story-7/audio/nested.wav' }],
        },
      ],
    }],
  };
  const before = JSON.stringify(story);
  const projected = resolveStoryAssets(story, BASE);

  assert.equal(JSON.stringify(story), before, 'the saved bundle was mutated');
  assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected.cast.rabbit.clips.idle));
  assert.equal(projected.cast.rabbit.clips.idle.spritesheet, `${BASE}/fairytale-assets/sprites/rabbit/idle.png`);
  assert.equal(projected.cast.rabbit.clips.idle.atlas, `${BASE}/fairytale-assets/sprites/rabbit/idle.json`);
  assert.equal(projected.objects.lamp.svg, `${BASE}/fairytale-assets/objects/lamp.svg`);
  assert.equal(projected.audio.sfx.pop, `${BASE}/fairytale-assets/audio/sfx/pop.mp3`);
  assert.equal(projected.audio.bgm.calm, `${BASE}/fairytale-assets/audio/bgm/calm.mp3`);
  assert.equal(projected.scenes[0].plate.video, `${BASE}/fairytale-assets/plates/dell.mp4`);
  assert.equal(projected.scenes[0].plate.poster, `${BASE}/fairytale-assets/plates/dell.jpg`);
  assert.equal(projected.scenes[0].steps[0].audio, `${BASE}/jobs/story-7/audio/open.wav`);
  assert.equal(
    projected.scenes[0].steps[1].steps[0].audio,
    `${BASE}/jobs/story-7/audio/nested.wav`,
  );
});

test('the identical bundle follows either supplied base for every media field', () => {
  const story = {
    cast: { rabbit: { clips: { idle: { spritesheet: 'assets/rabbit.png', atlas: null } } } },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      plate: { video: 'assets/dell.mp4', poster: 'assets/dell.jpg' },
      steps: [{ kind: 'chunk', audio: 'jobs/7/audio/line.wav' }],
    }],
  };

  for (const base of ['https://a.example/storage', 'https://b.example/media']) {
    const projected = resolveStoryAssets(story, base);
    assert.equal(projected.cast.rabbit.clips.idle.spritesheet, `${base}/assets/rabbit.png`);
    assert.equal(projected.scenes[0].steps[0].audio, `${base}/jobs/7/audio/line.wav`);
  }
});

test('refuses legacy, mixed, and old narration shapes before projection', () => {
  for (const clip of [
    { spritesheet_url: 'https://old.example/x.png', atlas_url: null },
    {
      spritesheet: 'assets/x.png',
      spritesheet_url: 'https://old.example/x.png',
      atlas: null,
    },
  ]) {
    assert.throws(
      () => resolveStoryAssets({ cast: { rabbit: { clips: { idle: clip } } } }, BASE),
      /legacy asset field/,
    );
  }

  assert.equal(
    resolveStoryAssets({
      cast: {}, objects: {}, audio: { sfx: {}, bgm: {} },
      scenes: [{ plate: { video: 'plates/open.mp4', poster: 'plates/open.jpg' }, steps: [] }],
    }, BASE).scenes[0].plate.poster,
    `${BASE}/plates/open.jpg`,
    'plates is a valid bucket name; the player has no bucket allowlist to call it legacy',
  );
});

test('renditions are projected and validated exactly like the sheet they stand in for', () => {
  const story = {
    cast: {
      rabbit: {
        clips: {
          idle: {
            spritesheet: 'fairytale-assets/sprites/rabbit/idle/spritesheet.png',
            atlas: null,
            renditions: {
              200: 'fairytale-assets/mobile/sprites/aaa.webp',
              384: 'fairytale-assets/mobile/sprites/bbb.webp',
            },
          },
        },
      },
    },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{ plate: { video: 'plates/open.mp4', poster: 'plates/open.jpg' }, steps: [] }],
  };

  const projected = resolveStoryAssets(story, BASE);
  assert.deepEqual(projected.cast.rabbit.clips.idle.renditions, {
    200: `${BASE}/fairytale-assets/mobile/sprites/aaa.webp`,
    384: `${BASE}/fairytale-assets/mobile/sprites/bbb.webp`,
  });

  // A bundle from before renditions existed is the shape the published player
  // was fed, and it still plays: no key rather than an empty one.
  const legacy = resolveStoryAssets({
    ...story,
    cast: { rabbit: { clips: { idle: { spritesheet: 'fairytale-assets/sprites/rabbit/idle/spritesheet.png', atlas: null } } } },
  }, BASE);
  assert.equal(Object.hasOwn(legacy.cast.rabbit.clips.idle, 'renditions'), false);

  for (const bad of ['https://evil.example/x.webp', '../secret.webp', 'fairytale-assets/x.webp?v=1']) {
    assert.throws(
      () => resolveStoryAssets({
        ...story,
        cast: {
          rabbit: {
            clips: {
              idle: {
                spritesheet: 'fairytale-assets/sprites/rabbit/idle/spritesheet.png',
                atlas: null,
                renditions: { 200: bad },
              },
            },
          },
        },
      }, BASE),
      /rendition "200" has invalid media path/,
    );
  }
});

test('chunk keys go through the same door as the rendition they were cut from', () => {
  const clip = (extra) => ({
    cast: {
      rabbit: {
        clips: {
          idle: {
            spritesheet: 'fairytale-assets/sprites/rabbit/idle/spritesheet.png',
            atlas: null,
            renditions: { 200: 'fairytale-assets/mobile/sprites/aaa.webp' },
            ...extra,
          },
        },
      },
    },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{ plate: { video: 'plates/open.mp4', poster: 'plates/open.jpg' }, steps: [] }],
  });

  const projected = resolveStoryAssets(clip({
    rendition_chunks: {
      200: {
        frames_per_chunk: 25,
        keys: ['fairytale-assets/mobile/sprites/c0.webp', 'fairytale-assets/mobile/sprites/c1.webp'],
      },
    },
  }), BASE);
  assert.deepEqual(projected.cast.rabbit.clips.idle.rendition_chunks, {
    200: {
      frames_per_chunk: 25,
      keys: [
        `${BASE}/fairytale-assets/mobile/sprites/c0.webp`,
        `${BASE}/fairytale-assets/mobile/sprites/c1.webp`,
      ],
    },
  });

  // A bundle from before chunks existed carries no key rather than an empty one,
  // and the picker then draws the whole rendition — today's path, untouched.
  assert.equal(Object.hasOwn(resolveStoryAssets(clip({}), BASE).cast.rabbit.clips.idle, 'rendition_chunks'), false);

  // A block whose keys are not a list is left empty rather than thrown away with
  // the story: the picker checks the list against the clip's frame count anyway
  // and falls back, which is a story that plays.
  assert.deepEqual(
    resolveStoryAssets(clip({ rendition_chunks: { 200: { frames_per_chunk: 25, keys: null } } }), BASE)
      .cast.rabbit.clips.idle.rendition_chunks[200].keys,
    [],
  );

  for (const bad of ['https://evil.example/x.webp', '../secret.webp', 'fairytale-assets/x.webp?v=1']) {
    assert.throws(
      () => resolveStoryAssets(clip({
        rendition_chunks: { 200: { frames_per_chunk: 25, keys: ['fairytale-assets/mobile/sprites/c0.webp', bad] } },
      }), BASE),
      /rendition chunk "200"\/1 has invalid media path/,
      `a chunk key of ${bad} reached the network`,
    );
  }
});

test('the cards block is resolved at the door, slot by slot', () => {
  const cards = requireCardsBlock({
    intro: {
      video: 'fairytale-assets/intros/forest/lantern.mp4',
      music: 'fairytale-assets/intro_music/gentle_lullaby.mp3',
      narration: { text: 'The owl’s quiet friend', audio: 'jobs/story-7/audio/title.wav' },
      // A field a later manifest grew. This build performs the three above and
      // plays the card rather than refusing a story over a key it does not read.
      duration_ms: 14_000,
    },
    end_card: { video: 'fairytale-assets/intros/forest/goodnight.mp4', music: 'fairytale-assets/intro_music/dusk.mp3' },
  }, BASE);

  assert.deepEqual(cards, {
    intro: {
      video: `${BASE}/fairytale-assets/intros/forest/lantern.mp4`,
      music: `${BASE}/fairytale-assets/intro_music/gentle_lullaby.mp3`,
      narration: { text: 'The owl’s quiet friend', audio: `${BASE}/jobs/story-7/audio/title.wav` },
    },
    end_card: {
      video: `${BASE}/fairytale-assets/intros/forest/goodnight.mp4`,
      music: `${BASE}/fairytale-assets/intro_music/dusk.mp3`,
      narration: null,
    },
  });
  assert.ok(Object.isFrozen(cards.intro), 'a resolved card can be written to by whoever plays it');
});

test('a card with nothing to play, and one with only half of it, are told apart', () => {
  // No block, and a block with neither slot in it, are the same nothing: the
  // one caller that reads this asks `if (cards)`, and `{}` is truthy.
  assert.equal(requireCardsBlock(null, BASE), null);
  assert.equal(requireCardsBlock({}, BASE), null);

  // One slot alone is a real answer — a world with an opening film and no
  // closing one still opens.
  const opening = requireCardsBlock({ intro: { video: 'bucket/intro.mp4' } }, BASE);
  assert.deepEqual(opening, {
    intro: { video: `${BASE}/bucket/intro.mp4`, music: null, narration: null },
  });
});

test('what the cards block refuses, it refuses before a frame is drawn', () => {
  const refuses = (cards, pattern) => assert.throws(() => requireCardsBlock(cards, BASE), pattern);

  refuses('intro.mp4', /cards must be an object/);
  // A misspelled slot is indistinguishable from a deliberate omission, and both
  // leave the story opening on nothing at all.
  refuses({ into: { video: 'bucket/intro.mp4' } }, /"into", which it does not take/);
  refuses({ intro: 'bucket/intro.mp4' }, /cards intro must be an object/);
  refuses({ intro: {} }, /cards intro video has invalid media path/);
  refuses({ intro: { video: 'https://elsewhere.example/intro.mp4' } }, /cards intro video has invalid media path/);
  refuses({ intro: { video: 'bucket/intro.mp4', music: '../escape.mp3' } }, /cards intro music has invalid media path/);
  refuses(
    { intro: { video: 'bucket/intro.mp4', narration: { audio: 'jobs/7/title.wav' } } },
    /cards intro narration must carry the line to speak/,
  );
  refuses(
    { intro: { video: 'bucket/intro.mp4', narration: { text: 'A story', audio: '/etc/passwd' } } },
    /cards intro narration audio has invalid media path/,
  );
});
