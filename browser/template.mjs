const STYLESHEET = new URL('./styles.css', import.meta.url).href;

export function createPlayerTemplate(root, { stylesheet = STYLESHEET } = {}) {
  const document = root.ownerDocument ?? globalThis.document;
  const link = element(document, 'link', { rel: 'stylesheet', href: stylesheet });
  const brand = element(document, 'div', { className: 'brand', 'aria-label': 'story player' }, [
    element(document, 'span', { className: 'brand-moon', 'aria-hidden': 'true' }),
    element(document, 'span', { text: 'storytime' }),
  ]);
  const subtitles = element(document, 'button', {
    className: 'quiet-button', type: 'button', 'aria-label': 'hide subtitles', 'aria-pressed': 'true',
  }, [element(document, 'span', { text: 'cc', 'aria-hidden': 'true' })]);
  const debugToggle = element(document, 'button', {
    className: 'quiet-button', type: 'button', 'aria-label': 'open event log', 'aria-expanded': 'false',
  }, [element(document, 'span', { text: 'log', 'aria-hidden': 'true' })]);
  const header = element(document, 'header', { className: 'player-header' }, [brand, subtitles, debugToggle]);
  const poster = element(document, 'div', { className: 'plate-poster' });
  const video = element(document, 'video', { className: 'plate-video', muted: '', loop: '', playsinline: '', preload: 'metadata' });
  video.muted = true;
  video.loop = true;
  const plate = element(document, 'div', { className: 'plate-layer' }, [poster, video]);
  const sprites = element(document, 'div', { className: 'sprite-layer' });
  const camera = element(document, 'div', { className: 'camera-layer' }, [
    element(document, 'div', { className: 'drift-layer' }, [plate, sprites]),
  ]);
  const stage = element(document, 'div', { className: 'logical-stage' }, [
    camera,
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
  const frame = element(document, 'section', { className: 'stage-frame', 'aria-label': 'story stage' }, [
    element(document, 'div', { className: 'stage-letterbox', 'aria-hidden': 'true' }), stage, ceremony, subtitleArea, end,
  ]);
  const shell = element(document, 'main', { className: 'player-shell' }, [header, frame]);
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
    title, status, start, ceremony, subtitles, subtitleArea, debugToggle,
    stage: { frame, stage, camera, plate, poster, video, sprites, subtitle, mediaNote, end },
    debug: {
      panel: debugPanel, toggle: debugToggle, close: debugClose, copy: debugCopy,
      download: debugDownload, list: debugList, status: debugStatus,
    },
  };
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
