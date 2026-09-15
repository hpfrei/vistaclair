// WebSocket handler for the in-browser CLI terminal: tab lifecycle, input,
// file upload, resize, settings, scrollback, and saved-session management.
// Registered on the dashboard broadcaster under the 'cli:' prefix.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const caps = require('../capabilities');
const { DATA_HOME, ensureDir } = require('../utils');
const createProxyRouter = require('../proxy');
const { clearPendingQuestionsForTab } = createProxyRouter;

const PROJECT_ROOT = DATA_HOME;
const PREFIXES = ['cli:'];
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
    case 'cli:closeTab':
      if (msg.tabId) {
        clearPendingQuestionsForTab(msg.tabId);
        mgr.remove(msg.tabId);
        mgr.broadcastTabs();
      }
      break;
    case 'cli:spawn':
      if (msg.tabId && msg.cwd) {
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
      if (msg.tabId) mgr.write(msg.tabId, msg.data || '');
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
      if (msg.tabId) mgr.resize(msg.tabId, msg.cols || 80, msg.rows || 24);
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
        mgr.deleteSavedSession(msg.sessionId);
        send({ type: 'cli:savedSessions', sessions: mgr.getSavedSessions() });
      }
      break;
  }
}

module.exports = { PREFIXES, handleMessage };
