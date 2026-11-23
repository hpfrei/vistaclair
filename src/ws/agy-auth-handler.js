// WebSocket handler for "Sign in to Antigravity" (src/agy-auth.js): the
// sign-in state the header pill shows, and the one `agy acp --login` pty the
// sign-in modal drives. Registered on the dashboard broadcaster under the
// 'agy-auth:' prefix. Same message set as claude-auth-handler.js:
//
//   agy-auth:status        { refresh? }        → agy-auth:status
//   agy-auth:login:start   { cols, rows }      → agy-auth:login:started
//   agy-auth:login:input   { data }            (the pasted code, then \r)
//   agy-auth:login:resize  { cols, rows }
//   agy-auth:login:cancel
//
// The pty's screen goes only to the dashboards that started or attached to it
// (agy-auth:login:output, then agy-auth:login:exit with the new status).
// Status changes reach every dashboard as agy-auth:status. status is
// { state: not-installed | signed-out | keyring-locked | signed-in | unknown,
// installed, signedIn }; no account detail is read.

const WebSocket = require('ws');
const agyAuth = require('../agy-auth');

const PREFIXES = ['agy-auth:'];
const ABANDON_MS = 60 * 1000;

// The broadcaster reportAgyAuthFailure uses when none is passed.
let activeBc = null;

function create(bc, { authStatus = agyAuth.authStatus, login = agyAuth.loginProcess } = {}) {
  activeBc = bc;
  const watchers = new Set();
  let abandonTimer = null;

  const sendTo = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch {} }
  };

  function statusMessage() {
    return { type: 'agy-auth:status', status: authStatus.peek(), login: { running: login.running } };
  }

  authStatus.on('change', () => bc.broadcast(statusMessage()));

  login.on('output', (data) => {
    for (const ws of watchers) sendTo(ws, { type: 'agy-auth:login:output', data });
  });

  login.on('exit', async ({ exitCode, signal, reason }) => {
    clearTimeout(abandonTimer);
    let status = null;
    try { status = await authStatus.refresh(); } catch {}
    const msg = {
      type: 'agy-auth:login:exit',
      exitCode, signal, reason,
      ok: reason === 'exit' && exitCode === 0 && !!status?.signedIn,
      status,
    };
    for (const ws of watchers) sendTo(ws, msg);
    watchers.clear();
    bc.broadcast(statusMessage());
  });

  function watch(ws) {
    clearTimeout(abandonTimer);
    if (watchers.has(ws)) return;
    watchers.add(ws);
    ws.once('close', () => {
      watchers.delete(ws);
      if (!watchers.size && login.running) {
        abandonTimer = setTimeout(() => { if (!watchers.size) login.cancel('abandoned'); }, ABANDON_MS);
        abandonTimer.unref?.();
      }
    });
  }

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case 'agy-auth:status':
        if (msg.refresh) {
          authStatus.refresh().catch(() => {}).then(() => sendTo(ws, statusMessage()));
        } else {
          sendTo(ws, statusMessage());
        }
        break;
      case 'agy-auth:login:start': {
        let started = false;
        if (!login.running) {
          try {
            started = login.start({ cols: msg.cols, rows: msg.rows });
          } catch (e) {
            sendTo(ws, { type: 'agy-auth:login:error', error: `Could not start \`agy acp --login\`: ${e.message}` });
            break;
          }
        }
        watch(ws);
        sendTo(ws, { type: 'agy-auth:login:started', attached: !started, replay: started ? '' : login.replay });
        if (started) bc.broadcast(statusMessage());
        break;
      }
      case 'agy-auth:login:input':
        if (watchers.has(ws)) login.write(msg.data);
        break;
      case 'agy-auth:login:resize':
        if (watchers.has(ws)) login.resize(msg.cols, msg.rows);
        break;
      case 'agy-auth:login:cancel':
        login.cancel('cancelled');
        break;
    }
  }

  function onConnect(ws) {
    sendTo(ws, statusMessage());
  }

  return { handleMessage, onConnect };
}

// An agy run failed (exit code, stdout, stderr, the `-p` JSON): when it was
// for lack of auth, re-ask agy and tell every dashboard to offer the sign-in.
// Returns the reason ('sign-in-needed' | 'keyring-locked') or null. Future agy
// workers and providers call this with what the run printed.
function reportAgyAuthFailure(info = {}, bc = activeBc) {
  const reason = agyAuth.agyAuthFailureReason(info);
  if (!reason) return null;
  agyAuth.authStatus.invalidate();
  agyAuth.authStatus.refresh().catch(() => {});
  bc?.broadcast({ type: 'agy-auth:needed', reason });
  return reason;
}

module.exports = { PREFIXES, create, reportAgyAuthFailure };
