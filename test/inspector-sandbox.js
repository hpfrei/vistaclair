// public/inspector.js in a node:vm sandbox on the fake DOM (test/inspector-fake-dom.js):
// the real page markup of the Inspector view (from public/index.html), the
// real helper modules it loads after (wide-layout, retention, lanes, session
// cards), the tab layer (tab-host, its menu) and Desks (#view-desks, desks.js),
// and a stand-in for public/core.js's window.dashboard that records
// what is sent on the websocket. d3 is a chain that draws nothing.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDom } = require('./inspector-fake-dom');

const PUB = path.join(__dirname, '..', 'public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');

// d3.select(x).anything(...).more(...) — a no-op chain.
function d3Stub() {
  const chain = new Proxy(function () {}, {
    get(t, k) {
      if (k === 'empty') return () => true;
      if (k === 'node') return () => null;
      if (k === 'size') return () => 0;
      if (k === 'nodes') return () => [];
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'then') return undefined;
      return chain;
    },
    apply() { return chain; },
  });
  return { select: () => chain, selectAll: () => chain, line: () => chain, curveBasis: chain, curveMonotoneY: chain, path: () => chain };
}

function loadInspector() {
  const dom = createDom();
  const { window, document } = dom;
  const html = read('index.html');
  const main = html.match(/<main id="view-dashboard"[\s\S]*?<\/main>/)[0];
  dom.mount('<link rel="icon" href="favicon.svg">', document.head);
  dom.mount('<nav><button class="header-tab" data-view="dashboard">Inspector</button></nav>');
  // Shown: the page opens on the Inspector for these tests.
  dom.mount(main.replace(' class="hidden" style="display:none"', ''));
  // Desks (hidden, as the page opens): Inspector tabs can go into its windows.
  dom.mount(html.match(/<div id="view-desks"[\s\S]*?<div class="desks-taskbar"[^>]*><\/div>\s*<\/div>/)[0]);
  dom.mount('<footer><div id="footerStats">0 turns</div><div id="footerTokens"></div><div id="footerCache"></div><div id="footerCost"></div><button id="footerReset"></button></footer>');

  const sent = [];
  const state = { interactions: [], selection: null };
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  window.dashboard = {
    state,
    escHtml: esc,
    highlightJSON: v => esc(JSON.stringify(v)),
    renderJSON: v => esc(JSON.stringify(v)),
    jsonBlock: v => `<div class="json-block jt-root">${esc(JSON.stringify(v))}</div>`,
    formatDuration: ms => ms == null ? '--' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`,
    truncate: (s, n) => !s ? '' : s.length > n ? s.slice(0, n) + '...' : s,
    renderMarkdown: (text, el) => { if (el) el.textContent = text; },
    renderMarkdownDebounced: (text, el) => { if (el) el.textContent = text; },
    cancelRenderDebounce: () => {},
    sendWs: m => sent.push(m),
    linkifyFilePaths: () => {},
    openFilePreview: () => {},
    openTextPreview: () => {},
    fileCategory: ext => ({ png: 'image', jpg: 'image', mp4: 'video', mp3: 'audio' })[ext] || 'text',
    statsEl: document.getElementById('footerStats'),
    registerView: () => {},
  };
  window.d3 = d3Stub();
  window.switchView = () => {};
  const ctx = vm.createContext(window);
  // In the page's order: the tab layer before core.js's users, desks.js last.
  for (const f of ['tab-context-menu.js', 'tab-host.js', 'desk-layout.js', 'session-cards.js', 'wide-layout.js',
    'inspector-retention.js', 'inspector-lanes.js', 'inspector.js', 'desks.js']) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  dom.counters.getElementById.length = 0;
  return { dom, window, document, sent, state, mod: window.inspectorModule };
}

// Interactions as the server sends them (summary shape is enough for the
// timeline and the lanes).
let _ts = 1_000_000;
function turn(instanceId, id, { text = `reply ${id}`, status = 'complete', ts } = {}) {
  const t = ts ?? (_ts += 1000);
  return {
    id, instanceId, timestamp: t, status, endpoint: '/v1/messages', isStreaming: false,
    request: { model: 'claude-x', _messageCount: 1, _lastMessage: { role: 'user', hasText: true },
      _newUserText: `prompt ${id}`, _firstUserText: `prompt ${id}` },
    response: status === 'complete'
      ? { status: 200, body: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } }
      : { sseEvents: [] },
    usage: { input_tokens: 10, output_tokens: 5 },
    timing: { startedAt: t, duration: 500 },
    _summary: true,
  };
}

module.exports = { loadInspector, turn };
