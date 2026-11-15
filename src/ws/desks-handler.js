// desks:* — the Desks view's state (src/desks.js) over the dashboard socket.
// A dashboard gets desks:state on connect and after every change, from any
// dashboard; it sends one message per change:
//   desks:create  { id, name }              desks:rename { id, name }
//   desks:delete  { id }                    desks:restore { desk, index }
//   desks:move    { deskId, kind, key, title?, geom? }
//   desks:return  { kind, key }             desks:rekey { kind, from, to }
//   desks:window  { deskId, kind, key, patch: { geom?, z?, minimized?, maximized?, title? } }
//   desks:windows { deskId, windows: [{ kind, key, patch }] }
//   desks:get     {}  (this socket only)
// A refused change answers desks:error { op, error } to the sender only.
const path = require('path');
const { createDesksStore } = require('../desks');

const PREFIXES = ['desks:'];

const OPS = {
  'desks:create': 'createDesk',
  'desks:rename': 'renameDesk',
  'desks:delete': 'deleteDesk',
  'desks:restore': 'restoreDesk',
  'desks:move': 'moveTab',
  'desks:return': 'returnTab',
  'desks:window': 'setWindow',
  'desks:windows': 'setWindows',
  'desks:rekey': 'rekey',
};

function create(broadcaster, { file, store } = {}) {
  const desks = store || createDesksStore({
    file: file || path.join(require('../utils').DATA_HOME, 'data', 'desks.json'),
  });
  const stateMsg = (s) => ({ type: 'desks:state', state: s || desks.get() });
  desks.onChange((s) => broadcaster.broadcast(stateMsg(s)));

  function handleMessage(ws, msg) {
    if (msg.type === 'desks:get') { ws.send(JSON.stringify(stateMsg())); return; }
    const fn = OPS[msg.type];
    if (!fn) return;
    const r = desks[fn](msg);
    if (!r?.ok) ws.send(JSON.stringify({ type: 'desks:error', op: msg.type, error: r?.error || 'refused' }));
  }

  function onConnect(ws) {
    ws.send(JSON.stringify(stateMsg()));
  }

  return { handleMessage, onConnect, store: desks };
}

module.exports = { PREFIXES, create };
