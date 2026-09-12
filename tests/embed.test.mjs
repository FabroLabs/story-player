import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { fakeElement, installDom } from './_dom.mjs';

const VALID_STORY = Object.freeze({
  storylang_version: 0,
  title: 'Moonlight',
  cast: {},
  objects: {},
  audio: { sfx: {}, bgm: {} },
  scenes: [{
    place: 'dell',
    plate: { poster: 'assets/dell.jpg', video: 'assets/dell.mp4' },
    steps: [],
  }],
});

test('requires a real Element and an already-parsed story object synchronously', (t) => {
  const dom = installDom();
  t.after(dom.restore);

  assert.throws(
    () => createStoryPlayer({}, { story: VALID_STORY, assetBase: 'https://storage.example/' }),
    /container must be an Element/,
  );
  assert.throws(
    () => createStoryPlayer(fakeElement(), { story: 'story.json', assetBase: 'https://storage.example/' }),
    /story must be a parsed object/,
  );
});

test('refuses only an unregistered Storylang version before mutating the host', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');

  assert.throws(
    () => createStoryPlayer(host, {
      story: { ...VALID_STORY, storylang_version: 17 },
      assetBase: 'https://storage.example/',
    }),
    /bundle version 17 unknown to this player \(knows: 0\)/,
  );
  assert.equal(host.shadowRoot, undefined);
});

test('mounts one self-contained Shadow DOM player from parsed JSON', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: VALID_STORY,
    assetBase: 'https://storage.example/root',
  });

  await player.ready;
  assert.ok(host.shadowRoot, 'the host has no ShadowRoot');
  assert.equal(host.shadowRoot.mode, 'open');
  assert.ok(host.shadowRoot.children.length > 1, 'the player did not build its own surface');
  assert.equal(typeof player.destroy, 'function');
});

test('the ceremony opens with the kicker it was mounted with, or the bedtime line', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const mounted = [];
  const eyebrowOf = (options) => {
    const host = document.createElement('div');
    mounted.push(createStoryPlayer(host, {
      story: VALID_STORY, assetBase: 'https://storage.example/', ...options,
    }));
    // Scoped to the ceremony: the debug drawer's header wears the same class.
    return findByClass(findByClass(host.shadowRoot, 'start-ceremony'), 'eyebrow').textContent;
  };

  assert.equal(eyebrowOf({ kicker: 'a counting lesson' }), 'a counting lesson');
  assert.equal(eyebrowOf({ kicker: '  a counting lesson  ' }), 'a counting lesson');
  assert.equal(eyebrowOf({}), 'a bedtime story');
  // A host's mistake still reads as a sentence. An empty eyebrow over the
  // story's name is a hole in the opening screen that nobody asked for, and
  // the bedtime line is true of every story this player can be handed.
  for (const kicker of [null, 42, '   ', {}, ['a counting lesson']]) {
    assert.equal(eyebrowOf({ kicker }), 'a bedtime story', JSON.stringify(kicker));
  }

  // Mounted players are opening their assets; torn down only once each has
  // settled, or the aborts land after this test has ended.
  await Promise.allSettled(mounted.map((player) => player.ready));
  for (const player of mounted) player.destroy();
});

// The mount is behind a ShadowRoot and this file's DOM is the hand-written one,
// which carries children and classes but no selector engine.
function findByClass(node, className) {
  if (node?.className === className) return node;
  for (const child of node?.children ?? []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

test('two players own independent roots and lifecycle state', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const left = document.createElement('div');
  const right = document.createElement('div');
  const first = createStoryPlayer(left, { story: VALID_STORY, assetBase: 'https://one.example/' });
  await first.ready;
  const second = createStoryPlayer(right, { story: VALID_STORY, assetBase: 'https://two.example/' });

  await second.ready;
  assert.notEqual(left.shadowRoot, right.shadowRoot);
  first.destroy();
  assert.equal(left.shadowRoot.children.length, 0);
  assert.ok(right.shadowRoot.children.length > 0, 'destroying one player damaged its sibling');
  second.destroy();
});

test('refuses an invalid current-version story instead of reporting an empty performance ready', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const player = createStoryPlayer(document.createElement('div'), {
    story: { storylang_version: 0 },
    assetBase: 'https://storage.example/',
  });

  await assert.rejects(player.ready, /non-empty scenes/);
  player.destroy();
});

test('refuses unresolved cast references during ready instead of after the begin gesture', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const player = createStoryPlayer(document.createElement('div'), {
    story: {
      ...VALID_STORY,
      scenes: [{
        ...VALID_STORY.scenes[0],
        steps: [{ kind: 'cmd', cmd: 'put', subjects: ['missing-fox'], line: 7 }],
      }],
    },
    assetBase: 'https://storage.example/',
  });

  await assert.rejects(player.ready, /missing-fox.*absent from cast/);
  player.destroy();
});

test('opens a lesson that rings and takes a prop, and still refuses either around nobody', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  // The mount door used to hold every subject to the cast, so the numeral card a
  // maths lesson rings — a prop, never cast — turned the whole lesson into "this
  // story could not be opened". `take` carries its prop the same way a ring
  // does, in `subjects` with no `objects` beside it, and the compiler resolves
  // both against the props standing in the scene as well as the cast; this is
  // that same rule at the door, for both of them.
  const lesson = (cmd, slug) => ({
    ...VALID_STORY,
    objects: { numeral_3: { height_cm: 40, svg: 'assets/three.svg' } },
    scenes: [{
      ...VALID_STORY.scenes[0],
      steps: [
        { kind: 'cmd', cmd: 'place_object', objects: ['numeral_3'], line: 6 },
        { kind: 'cmd', cmd, subjects: [slug], line: 7 },
      ],
    }],
  });

  for (const cmd of ['highlight', 'take']) {
    const player = createStoryPlayer(document.createElement('div'), {
      story: lesson(cmd, 'numeral_3'),
      assetBase: 'https://storage.example/',
    });
    await player.ready;
    player.destroy();

    const wrong = createStoryPlayer(document.createElement('div'), {
      story: lesson(cmd, 'fox'),
      assetBase: 'https://storage.example/',
    });
    await assert.rejects(wrong.ready, /fox.*absent from cast and objects/, cmd);
    wrong.destroy();
  }
});

test('refuses a second live owner and preserves foreign ShadowRoot content', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const activeHost = document.createElement('div');
  const active = createStoryPlayer(activeHost, {
    story: VALID_STORY,
    assetBase: 'https://storage.example/',
  });
  assert.throws(
    () => createStoryPlayer(activeHost, { story: VALID_STORY, assetBase: 'https://storage.example/' }),
    /already owns an active story player/,
  );
  active.destroy();
  await assert.rejects(active.ready, (error) => error?.name === 'AbortError');

  const foreignHost = document.createElement('div');
  const root = foreignHost.attachShadow({ mode: 'open' });
  const text = document.createTextNode('caller-owned');
  root.append(text);
  assert.throws(
    () => createStoryPlayer(foreignHost, { story: VALID_STORY, assetBase: 'https://storage.example/' }),
    /ShadowRoot is not empty/,
  );
  assert.equal(root.childNodes[0], text);
});
