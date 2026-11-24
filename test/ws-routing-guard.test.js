// Guard: every WebSocket message type a public module's handler handles must
// reach that module. core.js routes by a switch (type -> window.<mod>.<fn>)
// and by registerModule(prefix) calls; a type handled but not routed is dead
// in the browser (it falls to the pending queue and is dropped). The owner's
// stuck "Removing N…" button was cli:deleteSavedSessionsDone missing here.
//
//   node --test test/ws-routing-guard.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

// Handlers whose case labels must all be routed. `fn` is the function in
// `file`; `mod`/`method` is how core.js reaches it.
const HANDLERS = [
  { file: 'cli.js', fn: 'handleMessage', mod: 'cliModule', method: 'handleMessage' },
  { file: 'cli.js', fn: 'handleAskMessage', mod: 'cliModule', method: 'handleAskMessage' },
  { file: 'inspector.js', fn: 'handleMessage', mod: 'inspectorModule', method: 'handleMessage' },
  { file: 'capabilities.js', fn: 'handleMessage', mod: 'capabilitiesModule', method: 'handleMessage' },
  { file: 'rules.js', fn: 'handleMessage', mod: 'rulesModule', method: 'handleMessage' },
  { file: 'directories.js', fn: 'handleShellMessage', mod: 'directoriesModule', method: 'handleShellMessage' },
  { file: 'sdk-panel.js', fn: 'handleMessage', mod: 'sdkPanel', method: 'handleMessage' },
];

// Types a module handles on purpose without core.js routing them. Say why.
const ALLOW = {
  // 'cli:foo': 'reason',
};

const TYPE = /^[a-z][a-z-]*:[A-Za-z:]+$/;

// Body of `function name(` by brace matching (strings/regex literals with
// braces are rare in these handlers; the count is checked by the sanity test).
function functionBody(src, name) {
  const at = src.search(new RegExp(`function ${name}\\(`));
  assert.ok(at >= 0, `function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const handledTypes = (h) =>
  new Set([...functionBody(read(h.file), h.fn).matchAll(/case '([^']+)':/g)].map(m => m[1]).filter(t => TYPE.test(t)));

// core.js: case label -> the module call that ends its group (first
// window.<mod>?.<method>( before the group's own `break;` at switch depth).
function coreRoutes() {
  const body = functionBody(read('core.js'), 'handleMessage');
  const routes = new Map();            // type -> Set('mod.method')
  const labels = [...body.matchAll(/case '([^']+)':/g)];
  for (const m of labels) {
    const rest = body.slice(m.index);
    const end = rest.search(/\n {6}break;|\n {4}default:/);
    const group = end < 0 ? rest : rest.slice(0, end);
    const calls = [...group.matchAll(/window\.(\w+)\?\.(\w+)(?:\?\.)?\(msg\)/g)].map(c => `${c[1]}.${c[2]}`);
    if (!routes.has(m[1])) routes.set(m[1], new Set());
    for (const c of calls) routes.get(m[1]).add(c);
  }
  return routes;
}

// registerModule('prefix', handler) in a public module, with the module that
// handler belongs to.
function registeredPrefixes() {
  const out = [];
  for (const f of fs.readdirSync(PUB).filter(n => n.endsWith('.js'))) {
    for (const m of read(f).matchAll(/registerModule\??\.?\(\s*'([^']+)'\s*,\s*([A-Za-z_.]+)/g)) out.push({ file: f, prefix: m[1], handler: m[2] });
  }
  return out;
}

test('the guard sees the handlers and the routes (parsers are not vacuous)', () => {
  const routes = coreRoutes();
  assert.ok(routes.get('cli:output')?.has('cliModule.handleMessage'));
  assert.ok(routes.get('ask:question')?.has('cliModule.handleAskMessage'));
  assert.ok(routes.get('interaction:start')?.has('inspectorModule.handleMessage'));
  assert.ok(handledTypes(HANDLERS[0]).has('cli:output'));
  assert.ok(handledTypes(HANDLERS[0]).size > 15);
  assert.ok(registeredPrefixes().some(p => p.prefix === 'sdk:' && p.file === 'sdk-panel.js'));
});

test('every type a public module handles is routed to it by core.js (or registered by prefix)', () => {
  const routes = coreRoutes();
  const prefixes = registeredPrefixes();
  const missing = [];
  for (const h of HANDLERS) {
    for (const type of handledTypes(h)) {
      if (ALLOW[type]) continue;
      if (routes.get(type)?.has(`${h.mod}.${h.method}`)) continue;
      if (prefixes.some(p => p.file === h.file && type.startsWith(p.prefix))) continue;
      missing.push(`${type} (handled in ${h.file} ${h.fn}, not routed to ${h.mod}.${h.method})`);
    }
  }
  assert.deepStrictEqual(missing, [], 'handled but unrouted: core.js sends these to the pending queue, so the UI never sees them');
});

test('ALLOW only lists types that really are handled and unrouted', () => {
  const all = new Set(HANDLERS.flatMap(h => [...handledTypes(h)]));
  for (const t of Object.keys(ALLOW)) assert.ok(all.has(t), `${t} is allowlisted but no module handles it`);
});
