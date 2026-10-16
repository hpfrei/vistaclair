// WebSocket handler for the in-browser CLI terminal: tab lifecycle, input,
// file upload, resize, settings, scrollback, and saved-session management.
// Registered on the dashboard broadcaster under the 'cli:' prefix, and 'sdk:'
// for the Agent SDK panel (src/sdk-session.js): send, interrupt, setModel,
// history, todo.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const caps = require('../capabilities');
const { DATA_HOME, ensureDir } = require('../utils');
const createProxyRouter = require('../proxy');
const { clearPendingQuestionsForTab } = createProxyRouter;
const folders = require('../session-folders');
const { readTranscript } = require('../sdk-session');

const PROJECT_ROOT = DATA_HOME;
const PREFIXES = ['cli:', 'sdk:'];
const UUID_RE = /^[0-9a-f-]{36}$/i;
const SCROLLBACK_CHUNK_SIZE = 16 * 1024;

function sendScrollbackChunked(ws, tabId, data) {
  if (data.length <= SCROLLBACK_CHUNK_SIZE) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cli:output', tabId, data }));
    }
    return;
  }
  let offset = 0;
  function sendNext() {
    if (offset >= data.length || ws.readyState !== WebSocket.OPEN) return;
    const chunk = data.slice(offset, offset + SCROLLBACK_CHUNK_SIZE);
    offset += SCROLLBACK_CHUNK_SIZE;
    ws.send(JSON.stringify({ type: 'cli:output', tabId, data: chunk }));
    setImmediate(sendNext);
  }
  sendNext();
}

function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));
  const mgr = bc.cliSessionManager;
  if (!mgr) return;

  switch (msg.type) {
    case 'cli:newTab': {
      const newTabId = mgr.nextTabId();
      mgr.getOrCreate(newTabId);
      // Echo the client's correlation id so it can match the reply to the
      // request it made, instead of assuming replies arrive in request order.
      send({ type: 'cli:newTab', tabId: newTabId, reqId: msg.reqId || null });
      break;
    }
    case 'cli:open': {
      // "New CLI in directory…": openCli asks Simple / Orchestrator and an SDK
      // session's billing (the same ask an app's Change gets) — only what the
      // message leaves open — then mints the tab and launches it. The tab reaches every
      // client through cli:tabs; the reply lets the requester switch to it.
      if (!msg.cwd || !bc.orchestration) break;
      const cols = msg.cols || 80;
      const rows = msg.rows || 24;
      const reply = (data) => { if (ws.readyState === WebSocket.OPEN) send({ type: 'cli:opened', reqId: msg.reqId || null, ...data }); };
      bc.orchestration.openCli({
        cwd: msg.cwd, cols, rows, autoMemory: msg.autoMemory === true,
        ...(msg.engine === 'cli' || msg.engine === 'sdk' ? { engine: msg.engine } : {}),
        ...(msg.mode === 'simple' || msg.mode === 'orchestrator' ? { mode: msg.mode } : {}),
        // The requesting viewer sized the PTY, so it starts as the owner.
        beforeLaunch: (tabId) => mgr.getOrCreate(tabId).resizeFrom(ws, cols, rows),
      }).then(reply, (err) => reply({ error: err.message }));
      break;
    }
    case 'cli:closeTab':
      if (msg.tabId) {
        // A run member closes only when orchestration allows it: a worker once
        // its work is complete (or force-closed: abandoned), an orchestrator
        // while none of its workers runs.
        const check = bc.orchestration?.closeCheck(msg.tabId, { force: msg.force === true }) || { ok: true };
        if (!check.ok) {
          send({ type: 'cli:closeRefused', tabId: msg.tabId, reason: check.reason, canForce: !!check.canForce, forget: !!msg.forget });
          break;
        }
        // `forget` also drops the session from the resume list, the same as
        // the × on a saved session in the "+" menu. Read the sessId first:
        // remove() discards the session object.
        const forgetId = msg.forget ? mgr.get(msg.tabId)?.sessId : null;
        clearPendingQuestionsForTab(msg.tabId);
        mgr.remove(msg.tabId);
        if (forgetId) mgr.deleteSavedSession(forgetId);
        mgr.broadcastTabs();
      }
      break;
    case 'cli:spawn':
      if (msg.tabId && msg.cwd) {
        // The spawning viewer sized the PTY, so it starts as the owner.
        mgr.getOrCreate(msg.tabId).resizeFrom(ws, msg.cols || 80, msg.rows || 24);
        if (msg.shell) {
          const session = mgr.getOrCreate(msg.tabId);
          session.spawnShell(msg.cwd, msg.cols || 80, msg.rows || 24);
        } else {
          if (msg.hidden) {
            const session = mgr.getOrCreate(msg.tabId);
            session.hidden = true;
          }
          mgr.spawn(msg.tabId, msg.cwd, msg.cols || 80, msg.rows || 24, { resumeSessionId: msg.resumeSessionId || undefined, autoMemory: msg.autoMemory === true });
          if (msg.prompt) {
            mgr.writeWhenReady(msg.tabId, msg.prompt);
            if (msg.autoSubmit) {
              mgr.writeWhenReady(msg.tabId, '\r', 200);
            }
          }
        }
      }
      break;
    case 'cli:input':
      if (msg.tabId) {
        // Whoever types owns the PTY size (see CliSession.claim).
        mgr.claim(ws, msg.tabId);
        mgr.write(msg.tabId, msg.data || '');
      }
      break;
    case 'cli:claim':
      // Focus/tap without a keystroke — a phone viewer wants the reflow.
      if (msg.tabId) {
        if (msg.cols && msg.rows) mgr.resizeFrom(ws, msg.tabId, msg.cols, msg.rows);
        mgr.claim(ws, msg.tabId);
      }
      break;
    case 'cli:uploadFile':
      if (msg.tabId && msg.data) {
        try {
          const session = mgr.get(msg.tabId);
          const subfolder = session?.sessId || msg.tabId;
          const uploadsDir = path.join(DATA_HOME, 'interactions', subfolder, 'uploads');
          ensureDir(uploadsDir);

          const match = (msg.data || '').match(/^data:([^;]*);base64,(.+)$/);
          if (!match) throw new Error('Invalid data URL');
          const buffer = Buffer.from(match[2], 'base64');
          let safeName = (msg.filename || 'file').replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
          if (safeName.length > 200) safeName = safeName.slice(0, 200);
          const filePath = path.join(uploadsDir, safeName);
          fs.writeFileSync(filePath, buffer);

          const ext = path.extname(safeName).toLowerCase();
          const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
          const injection = isImage
            ? `the image at ${filePath} must be read and contains: `
            : `the file at ${filePath} has been provided and `;
          mgr.write(msg.tabId, injection);
          send({ type: 'cli:fileUploaded', tabId: msg.tabId, filePath });
        } catch (err) {
          send({ type: 'cli:fileUploaded', tabId: msg.tabId, error: err.message });
        }
      }
      break;
    case 'cli:resize':
      // Honoured only from the viewer that owns the session; a second
      // browser opening the tab must not reflow the first one's terminal.
      if (msg.tabId) mgr.resizeFrom(ws, msg.tabId, msg.cols || 80, msg.rows || 24);
      break;
    case 'cli:kill':
      if (msg.tabId) {
        clearPendingQuestionsForTab(msg.tabId);
        mgr.kill(msg.tabId);
      }
      break;
    case 'cli:settings':
      if (msg.tabId && msg.settings) {
        mgr.updateSettings(msg.tabId, msg.settings);
        const session = mgr.get(msg.tabId);
        if (session) {
          send({ type: 'cli:settingsData', tabId: msg.tabId, settings: session.getSettings() });
        }
      }
      break;
    case 'cli:getSettings':
      if (msg.tabId) {
        const session = mgr.get(msg.tabId);
        // Carries the credential join, so the picker reads `usable` instead of
        // deciding for itself what an absent API key means.
        const models = caps.listModelsWithAvailability(PROJECT_ROOT);
        const sessId = session && session.sessId;
        send({
          type: 'cli:settingsData',
          tabId: msg.tabId,
          settings: session ? session.getSettings() : {},
          models,
          hasSubscription: caps.hasClaudeSubscription(),
          interactionsDir: sessId ? path.join(DATA_HOME, 'interactions', sessId) : null,
        });
      }
      break;
    case 'cli:removeLastTurn':
      if (msg.tabId) {
        const result = mgr.removeLastInteractionTurn(msg.tabId);
        send({ type: 'cli:lastTurnRemoved', tabId: msg.tabId, ok: result.ok, reason: result.reason || null });
      }
      break;
    case 'cli:requestScrollback':
      if (msg.tabId) {
        const session = mgr.get(msg.tabId);
        const scrollback = session?.getScrollback();
        if (scrollback) sendScrollbackChunked(ws, msg.tabId, scrollback);
      }
      break;
    case 'cli:getSavedSessions':
      send({ type: 'cli:savedSessions', sessions: mgr.getSavedSessions() });
      break;
    case 'cli:deleteSavedSession':
      if (msg.sessionId) {
        const entry = mgr.findSaved(msg.sessionId);
        const st = entry?.settings?.orchestration;
        if (st?.role === 'orchestrator') {
          send({ type: 'cli:actionResult', action: 'delete', error: 'An orchestrator is deleted with its whole run (Delete run).' });
          break;
        }
        if (st?.role === 'worker' && !msg.force) {
          const group = mgr.getSavedSessions().find(s => s.id === msg.sessionId)?.group;
          if (group && !group.completed && !group.runMissing) {
            send({ type: 'cli:deleteRefused', sessionId: msg.sessionId, canForce: true, reason: 'This worker has not finished its work. Deleting it abandons it: its orchestrator will not resume it.' });
            break;
          }
        }
        mgr.deleteSavedSession(msg.sessionId);
        if (st?.role === 'worker') bc.orchestration?.noteMemberDeleted(entry);
        send({ type: 'cli:savedSessions', sessions: mgr.getSavedSessions() });
      }
      break;
    // --- Pause / resume (src/session-control.js, src/orchestration.js) ---
    case 'cli:pause': {
      // A run's orchestrator pauses the whole run; a worker only through it.
      const session = msg.tabId ? mgr.get(msg.tabId) : null;
      const st = session?.getSettings().orchestration;
      actionResult(send, 'pause', msg, () => {
        if (st?.role === 'worker') throw new Error('A worker is paused through its orchestrator: pause the run.');
        if (st?.role === 'orchestrator') return bc.orchestration.pauseRun(st.runId);
        return bc.sessionControl.pause(msg.tabId);
      });
      break;
    }
    case 'cli:pauseRun':
      actionResult(send, 'pause', msg, () => bc.orchestration.pauseRun(String(msg.runId || '')));
      break;
    case 'cli:interrupt':
      actionResult(send, 'interrupt', msg, () => bc.sessionControl.interrupt(msg.tabId));
      break;
    case 'cli:refreshOrchestrator':
      actionResult(send, 'refresh', msg, () => bc.orchestration.refreshOrchestrator(String(msg.runId || '')));
      break;
    case 'cli:resumeSaved':
      // A saved session (paused, interrupted or plain) with its own transcript;
      // a paused one is told to pick up from its folder.
      // A run worker goes through orchestration (its brief seeds a fresh start).
      // A conversation that can no longer be restored is started fresh from
      // the session's folder (result `fresh: true`).
      actionResult(send, 'resume', msg, () => {
        const id = String(msg.sessionId || '');
        if (mgr.findSaved(id)?.settings?.orchestration?.role === 'worker') return bc.orchestration.resumeSavedWorker(id);
        return bc.sessionControl.resumeSaved(id, { cols: msg.cols || 120, rows: msg.rows || 32 });
      });
      break;
    case 'cli:resumeRun':
      actionResult(send, 'resumeRun', msg, () => bc.orchestration.resumeRun(String(msg.runId || ''), { fresh: msg.fresh === true }));
      break;
    case 'cli:deleteRun':
      actionResult(send, 'deleteRun', msg, () => bc.orchestration.deleteRun(String(msg.runId || ''), { force: msg.force === true }));
      send({ type: 'cli:savedSessions', sessions: mgr.getSavedSessions() });
      break;
    // --- Agent SDK panel ---
    case 'sdk:send': {
      // A refusal (not running, an image too large) comes back as an error
      // notice in the session's own event stream.
      const session = sdkSession(mgr, msg.sessId);
      try {
        if (!session) throw new Error('that Agent SDK session is not running');
        session.submit(String(msg.text || ''), { images: Array.isArray(msg.images) ? msg.images : [] });
      } catch (e) {
        sendNotice(send, msg.sessId, `Not sent: ${e.message}`);
      }
      break;
    }
    case 'sdk:interrupt': {
      const session = sdkSession(mgr, msg.sessId);
      if (session) session.interrupt();
      break;
    }
    case 'sdk:setModel': {
      // The session persists its settings (manifest, saved entry) itself; a
      // run member's run.json follows through orchestration. The new model
      // reaches the panel as a status event; a refusal as an error notice.
      const live = msg.sessId ? mgr.getBySessId(String(msg.sessId)) : null;
      const session = sdkSession(mgr, msg.sessId);
      (async () => {
        try {
          if (!session) throw new Error(live ? 'not an Agent SDK session' : 'that Agent SDK session is not running');
          await session.setModel(msg.model);
        } catch (e) {
          try { sendNotice(send, msg.sessId, `Model not changed: ${e.message}`); } catch {}
          return;
        }
        try { bc.orchestration?.memberModelChanged(session, session.getSettings().model); } catch (e) {
          console.error(`[sdk:setModel] run record: ${e.message}`);
        }
      })();
      break;
    }
    case 'sdk:history': {
      // One session ({ sessId }), or every member of a run ({ runId }).
      if (msg.runId) {
        const run = bc.orchestration?.getRun(String(msg.runId));
        const d = run ? bc.orchestration.describeRun(run) : null;
        const ids = d ? [d.orchestratorSessId, ...d.workers.map(w => w.sessId)].filter(Boolean) : [];
        send({ type: 'sdk:history', runId: msg.runId, sessions: ids.map(id => ({ sessId: id, events: historyOf(mgr, id) })) });
        break;
      }
      if (!UUID_RE.test(String(msg.sessId || ''))) break;
      send({ type: 'sdk:history', sessId: msg.sessId, events: historyOf(mgr, msg.sessId) });
      break;
    }
    case 'sdk:todo': {
      if (!UUID_RE.test(String(msg.sessId || ''))) break;
      const dir = mgr.sessionDirOf(msg.sessId);
      const folder = dir ? folders.readFolder(dir) : null;
      let notes = '';
      if (dir) { try { notes = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'); } catch {} }
      send({
        type: 'sdk:todo', sessId: msg.sessId,
        rows: (folder?.items || []).map(i => ({ id: i.id, description: i.description, dependsOn: i.dependsOn, status: i.status })),
        notes,
      });
      break;
    }
  }
}

function sdkSession(mgr, sessId) {
  const s = sessId ? mgr.getBySessId(String(sessId)) : null;
  return s && s.kind === 'sdk' ? s : null;
}

// A session's transcript envelopes, live or saved (its folder outlives it).
function historyOf(mgr, sessId) {
  const live = sdkSession(mgr, sessId);
  if (live) return live.history();
  const dir = mgr.sessionDirOf(sessId);
  return dir ? readTranscript(dir, { sessId }) : [];
}

function sendNotice(send, sessId, text) {
  send({ type: 'sdk:event', sessId: sessId || null, ts: Date.now(), ev: { platform: { kind: 'notice', level: 'error', text } } });
}

// Run one pause/resume action and answer the requester with its result or error.
function actionResult(send, action, msg, fn) {
  let out;
  try { out = { ...(fn() || {}) }; } catch (e) { out = { error: e.message }; }
  send({ type: 'cli:actionResult', action, reqId: msg.reqId || null, tabId: msg.tabId || null, runId: msg.runId || null, sessionId: msg.sessionId || null, ...out });
}

module.exports = { PREFIXES, handleMessage };
