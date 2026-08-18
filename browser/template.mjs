const STYLESHEET = new URL('./styles.css', import.meta.url).href;

export function createPlayerTemplate(root, { stylesheet = STYLESHEET } = {}) {
  const document = root.ownerDocument ?? globalThis.document;
  const link = element(document, 'link', { rel: 'stylesheet', href: stylesheet });
  // No chrome of our own above the picture: what a site embeds is a rectangle
  // of video. The two buttons that used to live in a brand strip are playback
  // controls, so they moved into the control bar with the others, and closing,
  // fullscreen and casting belong to the page that mounted us.
  const subtitles = element(document, 'button', {
    className: 'quiet-button', type: 'button', 'aria-label': 'hide subtitles', 'aria-pressed': 'true',
  }, [element(document, 'span', { text: 'cc', 'aria-hidden': 'true' })]);
  const debugToggle = element(document, 'button', {
    className: 'quiet-button', type: 'button', 'aria-label': 'open event log', 'aria-expanded': 'false',
  }, [element(document, 'span', { text: 'log', 'aria-hidden': 'true' })]);
  const poster = element(document, 'div', { className: 'plate-poster' });
  // `preload="auto"`: the plate is asked to play the instant its source is set,
  // so waiting for a readiness event before fetching would cost every scene
  // opening a round trip. The plate layer is what the camera transforms — the
  // poster and the video move together, under the canvas.
  const video = element(document, 'video', { className: 'plate-video', muted: '', loop: '', playsinline: '', preload: 'auto' });
  video.muted = true;
  video.loop = true;
  const plate = element(document, 'div', { className: 'plate-layer' }, [poster, video]);
  // One canvas for the whole cast. It is hidden from assistive technology on
  // purpose: its content changes twenty-four times a second and carries no text,
  // and what a screen reader needs from a story is the subtitle area below,
  // which is a live region.
  const canvas = element(document, 'canvas', { className: 'stage-canvas', 'aria-hidden': 'true' });
  const stage = element(document, 'div', { className: 'logical-stage' }, [
    plate,
    canvas,
    element(document, 'div', { className: 'stage-vignette', 'aria-hidden': 'true' }),
  ]);
  const title = element(document, 'h1', { text: 'preparing your story…' });
  const start = element(document, 'button', { className: 'start-button', type: 'button', disabled: '' }, [
    element(document, 'span', { className: 'play-mark', 'aria-hidden': 'true' }),
    element(document, 'span', { text: 'begin story' }),
  ]);
  start.disabled = true;
  const status = element(document, 'p', { className: 'load-status', role: 'status', text: 'loading the story bundle' });
  const ceremony = element(document, 'div', { className: 'start-ceremony' }, [
    element(document, 'div', { className: 'ceremony-glow', 'aria-hidden': 'true' }),
    element(document, 'p', { className: 'eyebrow', text: 'a bedtime story' }), title, start, status,
  ]);
  const subtitle = element(document, 'p', { className: 'subtitle' });
  const mediaNote = element(document, 'p', { className: 'media-note' });
  const subtitleArea = element(document, 'div', {
    className: 'subtitle-wrap', 'aria-live': 'polite', 'aria-atomic': 'true',
  }, [subtitle, mediaNote]);
  const end = element(document, 'div', { className: 'end-overlay', hidden: '' }, [
    element(document, 'span', { className: 'end-moon', 'aria-hidden': 'true' }),
    element(document, 'p', { text: 'the end' }),
    element(document, 'span', { text: 'sleep well' }),
  ]);
  end.hidden = true;
  const badge = createBadge(document);
  const controls = createControlBar(document, { subtitles, debugToggle });
  const frame = element(document, 'section', { className: 'stage-frame', 'aria-label': 'story stage' }, [
    element(document, 'div', { className: 'stage-letterbox', 'aria-hidden': 'true' }),
    stage, badge.root, ceremony, subtitleArea, end, controls.root,
  ]);
  const shell = element(document, 'main', { className: 'player-shell' }, [frame]);
  const debugClose = element(document, 'button', { className: 'icon-button', type: 'button', 'aria-label': 'close event log', text: '×' });
  const debugList = element(document, 'ol', { className: 'event-list' });
  const debugCopy = element(document, 'button', { type: 'button', text: 'copy json' });
  const debugDownload = element(document, 'button', { type: 'button', text: 'download' });
  const debugStatus = element(document, 'span', { className: 'debug-status', role: 'status' });
  const debugPanel = element(document, 'aside', {
    className: 'debug-panel', 'aria-label': 'event log', 'aria-hidden': 'true', inert: '',
  }, [
    element(document, 'header', {}, [
      element(document, 'div', {}, [
        element(document, 'p', { className: 'eyebrow', text: 'playback trace' }),
        element(document, 'h2', { text: 'event log' }),
      ]), debugClose,
    ]),
    element(document, 'div', { className: 'debug-actions' }, [debugCopy, debugDownload, debugStatus]), debugList,
  ]);
  debugPanel.setAttribute('inert', '');
  root.replaceChildren(link, shell, debugPanel);
  return {
    title, status, start, ceremony, subtitles, subtitleArea, debugToggle, badge,
    controls: { ...controls, frame },
    stage: { frame, stage, canvas, plate, poster, video, subtitle, mediaNote, end },
    debug: {
      panel: debugPanel, toggle: debugToggle, close: debugClose, copy: debugCopy,
      download: debugDownload, list: debugList, status: debugStatus,
    },
  };
}

/**
 * The story's own name, over the picture, where the mockup puts it — not in a
 * bar above the stage. An embedded player has no header, so anything the viewer
 * should read while the story plays is drawn on the stage or nowhere.
 */
function createBadge(document) {
  const name = element(document, 'p', { className: 'story-name' });
  const scene = element(document, 'p', { className: 'story-scene' });
  const root = element(document, 'div', { className: 'story-badge' }, [name, scene]);
  return { root, name, scene };
}

/**
 * The control bar: position, transport, and the two toggles.
 *
 * The scrub is a `div` with `role="slider"` rather than an `<input type=range>`
 * because the fill and the handle are drawn from one fraction the runtime
 * already has, and a range input would need its own value plumbing to say the
 * same thing. Everything a pointer can do here, the keyboard can do too — the
 * handlers live in `v0/app/controls.mjs`.
 */
function createControlBar(document, { subtitles, debugToggle }) {
  const fill = element(document, 'div', { className: 'scrub-fill' });
  const handle = element(document, 'div', { className: 'scrub-handle' });
  const scrub = element(document, 'div', {
    className: 'scrub',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'story position',
    'aria-valuemin': '0',
    'aria-valuemax': '0',
    'aria-valuenow': '0',
  }, [fill, handle]);
  const at = element(document, 'span', { className: 'time-at', text: '0:00' });
  const total = element(document, 'span', { className: 'time-total', text: '0:00' });
  const remaining = element(document, 'span', { className: 'chip', text: '' });
  const back = element(document, 'button', {
    className: 'round-button skip-back', type: 'button', 'aria-label': 'back ten seconds',
  }, [element(document, 'span', { className: 'skip-mark', 'aria-hidden': 'true' })]);
  const forward = element(document, 'button', {
    className: 'round-button skip-forward', type: 'button', 'aria-label': 'forward ten seconds',
  }, [element(document, 'span', { className: 'skip-mark', 'aria-hidden': 'true' })]);
  const toggle = element(document, 'button', {
    className: 'play-button', type: 'button', 'aria-label': 'play', disabled: '',
  }, [element(document, 'span', { className: 'transport-mark', 'aria-hidden': 'true' })]);
  toggle.disabled = true;
  const root = element(document, 'div', {
    className: 'controls', role: 'group', 'aria-label': 'playback controls', hidden: '',
  }, [
    scrub,
    element(document, 'div', { className: 'times' }, [at, total]),
    element(document, 'div', { className: 'control-row' }, [
      remaining,
      element(document, 'div', { className: 'transport' }, [back, toggle, forward]),
      element(document, 'div', { className: 'side-buttons' }, [subtitles, debugToggle]),
    ]),
  ]);
  root.hidden = true;
  return { root, scrub, fill, handle, at, total, remaining, back, forward, toggle };
}

function element(document, tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}
