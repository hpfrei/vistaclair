// WebSocket handler for "Sign in to Claude" (src/claude-auth.js): the login
// status the header pill shows, and the one `claude auth login` pty the
// sign-in modal drives. Registered on the dashboard broadcaster under the
// 'claude-auth:' prefix.
//
//   claude-auth:status        { refresh? }        → claude-auth:status
//   claude-auth:login:start   { cols, rows, hostBrowser } → claude-auth:login:started
//   claude-auth:login:input   { data }            (keystrokes, the pasted code)
//   claude-auth:login:resize  { cols, rows }
//   claude-auth:login:cancel
//
// The pty's screen goes only to the dashboards that started or attached to it
// (claude-auth:login:output, then claude-auth:login:exit with the new status).
// Status changes reach every dashboard as claude-auth:status and
// prefs:claudeAuth.

const WebSocket = require('ws');
const caps = require('../capabilities');
const { DATA_HOME } = require('../utils');
const claudeAuth = require('../claude-auth');

const PREFIXES = ['claude-auth:'];
// A login nobody is watching any more (every attached dashboard closed) is
// killed after this long; a reload re-attaches well within it.
const ABANDON_MS = 60 * 1000;

function create(bc, { authStatus = claudeAuth.authStatus, login = claudeAuth.loginProcess } = {}) {
  const watchers = new Set();
  let abandonTimer = null;

  const sendTo = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch {} }
  };

  function statusMessage() {
    const status = authStatus.peek();
    const pref = caps.getClaudeAuthPref(DATA_HOME) || null;
    return {
      type: 'claude-auth:status',
      status,
      subscription: claudeAuth.isSubscription(status),
      // Whether Claude calls are meant to run on the subscription: chosen, or
      // the default with no API key to fall back on. A signed-out CLI then
      // leaves them without a credential, so the dashboard offers to sign in.
      wantsSubscription: pref === 'subscription' || (!pref && !caps.getAnthropicApiKey(DATA_HOME)),
      login: { running: login.running },
    };
  }

  authStatus.on('change', () => {
    bc.broadcast(statusMessage());
    bc.broadcast({
      type: 'prefs:claudeAuth',
      pref: caps.getClaudeAuthPref(DATA_HOME) || null,
      hasSubscription: caps.hasClaudeSubscription(),
      hasApiKey: !!caps.getAnthropicApiKey(DATA_HOME),
    });
  });

  login.on('output', (data) => {
    for (const ws of watchers) sendTo(ws, { type: 'claude-auth:login:output', data });
  });

  login.on('exit', async ({ exitCode, signal, reason }) => {
    clearTimeout(abandonTimer);
    let status = null;
    try { status = await authStatus.refresh(); } catch {}
    const msg = {
      type: 'claude-auth:login:exit',
      exitCode, signal, reason,
      ok: reason === 'exit' && exitCode === 0 && claudeAuth.isSubscription(status),
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
      case 'claude-auth:status':
        if (msg.refresh) {
          authStatus.refresh().catch(() => {}).then(() => sendTo(ws, statusMessage()));
        } else {
          sendTo(ws, statusMessage());
        }
        break;
      case 'claude-auth:login:start': {
        let started = false;
        if (!login.running) {
          try {
            started = login.start({ cols: msg.cols, rows: msg.rows, hostBrowser: !!msg.hostBrowser });
          } catch (e) {
            sendTo(ws, { type: 'claude-auth:login:error', error: `Could not start \`claude auth login\`: ${e.message}` });
            break;
          }
        }
        watch(ws);
        // An already running login is joined, not restarted: what it printed
        // so far comes along so the URL and prompt are on screen.
        sendTo(ws, { type: 'claude-auth:login:started', attached: !started, replay: started ? '' : login.replay });
        if (started) bc.broadcast(statusMessage());
        break;
      }
      case 'claude-auth:login:input':
        if (watchers.has(ws)) login.write(msg.data);
        break;
      case 'claude-auth:login:resize':
        if (watchers.has(ws)) login.resize(msg.cols, msg.rows);
        break;
      case 'claude-auth:login:cancel':
        login.cancel('cancelled');
        break;
    }
  }

  function onConnect(ws) {
    // Primed at startup; before the first answer lands this says null and the
    // change broadcast follows.
    sendTo(ws, statusMessage());
  }

  return { handleMessage, onConnect };
}

// An Agent SDK session's call was refused for its credential: the login has
// lapsed or was signed out. Re-ask the CLI and offer the sign-in.
function notifyAuthFailed(bc, info = {}) {
  claudeAuth.authStatus.invalidate();
  claudeAuth.authStatus.refresh().catch(() => {});
  bc.broadcast({ type: 'claude-auth:needed', reason: 'authentication_failed', ...info });
}

module.exports = { PREFIXES, create, notifyAuthFailed };
