const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const telegram = require('./telegram');
const miniAppAuth = require('./tg-miniapp-auth');
const tgRuns = require('./platform-tg-runs');

// Telegram-driven CLI sessions for the platform control bot. A chat can bind
// ONE session Telegram launched itself (an app change flow, or a generic
// platform CLI); plain chat text is relayed to it. Interaction happens in
// the Mini App (/pro/tg-session/); the chat receives push notifications with
// an "Open session" web_app button. An app change is an orchestration run: its
// binding records the runId and resolves the run's current orchestrator tab
// (a resume or a refresh moves it). Orchestration runs bound from the Sessions
// list or the dashboard are platform-tg-runs.js — many per chat, never relayed
// to. Both kinds persist in one encrypted file (`sessions`, `runs`) so they
// survive server restarts (GUI-reload resilience).

const KEY = '__platform__'; // platform-telegram.js bot key
const MINIAPP_PATH = '/pro/tg-session/';
// Distinct from the Vista approvals app's header: both Mini Apps live under
// /pro/* and request headers are global to the origin (tg-miniapp-auth.js).
const SESSION_HEADER = 'X-TG-Session';

let deps = {}; // { cliSessionManager, store, secretStore, broadcaster, appsDir, proDir, appManager, launchChangeSession, scheduleRestart, pendingQuestions, clearPendingQuestionsForTab, orchestration?, isOwnerRequest? }
let state = { sessions: {}, runs: {} }; // sessions: chatId → { tabId, target, startedAt, runId? }; runs: platform-tg-runs.js
// chatId → Set<notified event keys for the current turn> (debounce)
const notified = new Map();

function statePath() {
  return path.join(deps.appsDir, '.tg-sessions.enc');
}

function loadState() {
  state = deps.secretStore.readSecretFile(statePath(), deps.appsDir, { fallback: { sessions: {}, runs: {} } });
  if (!state.sessions) state.sessions = {};
  if (!state.runs) state.runs = {};
}

// Atomic: written beside, then renamed over (the card ids must survive a crash).
function saveState() {
  const tmp = `${statePath()}.tmp`;
  deps.secretStore.writeSecretFile(tmp, state, deps.appsDir);
  fs.renameSync(tmp, statePath());
}

function init(options) {
  deps = options;
  loadState();
  tgRuns.init({
    orchestration: deps.orchestration,
    cliSessionManager: deps.cliSessionManager,
    store: deps.store,
    broadcaster: deps.broadcaster,
    pendingQuestions: deps.pendingQuestions,
    isOwnerRequest: deps.isOwnerRequest,
    controlChatId: deps.controlChatId,
    state: { get: () => state, save: saveState },
    ...(deps.runsOptions || {}), // tests: timing knobs, tgCall
  });
  if (deps.broadcaster?.onBroadcast) {
    deps.broadcaster.onBroadcast(handleBroadcast);
    deps.broadcaster.onBroadcast(tgRuns.handleBroadcast);
  }
  // Server just (re)started: tell bound chats their session survived.
  for (const [chatId, binding] of Object.entries(state.sessions)) {
    notifyChat(Number(chatId), `Vistaclair is back up. Your session (${describeTarget(binding.target)}) is still bound — open it to continue.`, true);
  }
}

function describeTarget(target) {
  return target?.type === 'app' ? `app "${target.name}"` : 'platform';
}

function getBinding(chatId) {
  return state.sessions[String(chatId)] || null;
}

// The binding's live tab: an app change's run resolves its CURRENT
// orchestrator tab; otherwise (tg-pro, a CLI fallback) the tab it opened.
function tabOf(binding) {
  return (binding.runId && tgRuns.orchestratorTabOf(binding.runId)) || binding.tabId;
}

function bindingByTabId(tabId) {
  for (const [chatId, b] of Object.entries(state.sessions)) {
    if (tabOf(b) === tabId || b.tabId === tabId) return { chatId: Number(chatId), ...b };
  }
  return null;
}

function instanceIdFor(binding) {
  const session = deps.cliSessionManager.get(tabOf(binding));
  return session?.sessId ? `cli-${session.sessId}` : null;
}

function miniAppUrl() {
  return miniAppAuth.miniAppUrl(MINIAPP_PATH);
}

function openSessionMarkup() {
  const url = miniAppUrl();
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: '▶ Open session', web_app: { url } }]] };
}

async function notifyChat(chatId, text, withButton) {
  try {
    await telegram.call(KEY, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(withButton && openSessionMarkup() ? { reply_markup: openSessionMarkup() } : {}),
    });
  } catch (err) {
    console.error('[tg-session] notify failed:', err.message);
  }
}

// --- Launch ---

function launch(chatId, target, prompt) {
  if (getBinding(chatId)) throw new Error('A session is already bound to this chat. End it first.');
  let tabId;
  if (target.type === 'app') {
    // launchChangeSession is async (an Agent SDK orchestrator through core's
    // openCli) and may first ask the owner to confirm API-key billing. The chat
    // is bound before, so that question reaches it (handleBroadcast, the Mini
    // App's pendingQuestions); a decline or a failure unbinds it again.
    tabId = `app-${target.name}`;
    state.sessions[String(chatId)] = { tabId, target, startedAt: Date.now() };
    saveState();
    notified.delete(chatId);
    let started;
    try {
      started = deps.launchChangeSession(target.name, { prompt, autoSubmit: true });
    } catch (err) {
      unbind(chatId, tabId);
      throw err;
    }
    if (started && typeof started.then === 'function') {
      started.then((res) => {
        if (res && res.cancelled) {
          unbind(chatId, tabId);
          notifyChat(chatId, 'The session was not started: the owner declined to bill it to the API key.', false);
          return;
        }
        // An orchestrator: remember its run, the tab is resolved from it.
        const b = getBinding(chatId);
        const session = res && res.tabId ? deps.cliSessionManager.get(res.tabId) : null;
        let runId = null;
        try { runId = session?.getSettings?.().orchestration?.runId || null; } catch {}
        if (b && b.tabId === tabId && (runId || res?.tabId !== tabId)) {
          if (runId) b.runId = runId;
          if (res.tabId) b.tabId = res.tabId;
          saveState();
        }
      }, (err) => {
        unbind(chatId, tabId);
        notifyChat(chatId, `Could not start the session: ${err.message}`, false);
      });
    }
    return { tabId };
  } else {
    tabId = 'tg-pro';
    deps.cliSessionManager.launchSession(tabId, {
      cwd: deps.proDir,
      title: 'TG: platform',
      prompt,
      autoSubmit: true,
    });
  }
  state.sessions[String(chatId)] = { tabId, target, startedAt: Date.now() };
  saveState();
  notified.delete(chatId);
  return { tabId };
}

// A binding made for a launch that did not open.
function unbind(chatId, tabId) {
  const b = getBinding(chatId);
  if (!b || b.tabId !== tabId) return;
  delete state.sessions[String(chatId)];
  saveState();
}

// --- Broadcast tap → chat notifications ---

function notifyOnce(chatId, key, text) {
  let set = notified.get(chatId);
  if (!set) { set = new Set(); notified.set(chatId, set); }
  if (set.has(key)) return;
  set.add(key);
  notifyChat(chatId, text, true);
}

function handleBroadcast(msg) {
  try {
    if (msg.type === 'ask:question' && msg.tabId) {
      const b = bindingByTabId(msg.tabId);
      // pro-billing-*: index.js asks the owner to confirm API-key billing first.
      const text = String(msg.askId || '').startsWith('pro-billing-')
        ? 'Starting this session would bill the Anthropic API key — open the session to confirm or decline.'
        : 'Claude has a question — open the session to answer.';
      if (b) notifyOnce(b.chatId, `ask:${msg.askId}`, text);
    } else if (msg.type === 'interaction:complete' && msg.interaction?.hookEvent === 'Stop') {
      for (const [chatId, binding] of Object.entries(state.sessions)) {
        if (msg.interaction.instanceId === instanceIdFor(binding)) {
          notified.delete(Number(chatId)); // new turn boundary → reset debounce
          notifyOnce(Number(chatId), 'stop', 'Turn finished — Claude is waiting for you.');
        }
      }
    } else if (msg.type === 'cli:exit') {
      const b = bindingByTabId(msg.tabId);
      if (b) notifyOnce(b.chatId, 'exit', 'The CLI session process exited. You can still view the transcript, or end the session.');
    }
  } catch (err) {
    console.error('[tg-session] broadcast handler error:', err.message);
  }
}

// --- Session interaction ---

// One user turn through the session's own submit (a PTY tab types it and
// presses Enter; an Agent SDK session queues a user message).
function sendTurn(chatId, text) {
  const binding = getBinding(chatId);
  if (!binding) throw new Error('No session bound to this chat');
  const session = deps.cliSessionManager.get(tabOf(binding));
  if (!session || session.running === false) throw new Error('The session is not running');
  notified.delete(chatId);
  session.submit(text);
}

function interrupt(chatId) {
  const binding = getBinding(chatId);
  if (!binding) throw new Error('No session bound to this chat');
  const session = deps.cliSessionManager.get(tabOf(binding));
  if (session) session.interrupt();
}

function pendingAsksFor(tabId) {
  const out = [];
  for (const [askId, pending] of deps.pendingQuestions) {
    if ((pending.ctx?.tabId || pending.message?.tabId) === tabId) {
      out.push({ askId, formData: pending.formData || {}, questions: pending.questions || [] });
    }
  }
  return out;
}

function isBusy(binding) {
  const instanceId = instanceIdFor(binding);
  if (!instanceId) return false;
  return deps.store.getAll().some((i) =>
    i.instanceId === instanceId && (i.status === 'pending' || i.status === 'streaming'));
}

// Extract a slim {role, text, ts} transcript from the interaction store.
// Assistant text: response.body.content[] text blocks. User text: the last
// genuine user message in request.messages (string content, or text blocks
// with no tool_result — same heuristic as cli-sessions rollbackTranscript).
function buildTranscript(binding) {
  const session = deps.cliSessionManager.get(tabOf(binding));
  if (!session?.sessId) return [];
  const interactions = deps.store.loadSessionIntoMemory(session.sessId)
    .filter((i) => !i.isHook && !i.isMcp && !i.deleted);

  const out = [];
  let lastUserText = null;
  for (const i of interactions) {
    const messages = i.request?.messages || [];
    for (let m = messages.length - 1; m >= 0; m--) {
      const msg = messages[m];
      if (msg.role !== 'user') continue;
      let text = null;
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content) && !msg.content.some((b) => b?.type === 'tool_result')) {
        text = msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      }
      if (text && text.trim() && text !== lastUserText) {
        out.push({ role: 'user', text, ts: i.timestamp });
        lastUserText = text;
      }
      break; // only the last user message per interaction
    }
    const content = i.response?.body?.content;
    if (Array.isArray(content)) {
      const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      if (text.trim()) out.push({ role: 'assistant', text, ts: i.timestamp });
    }
  }
  return out;
}

// --- End session ---

function gitStatus(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null); // not a repo / git missing — informational only
      resolve(stdout.split('\n').filter(Boolean).length);
    });
  });
}

async function assessEnd(chatId) {
  const binding = getBinding(chatId);
  if (!binding) return { bound: false };
  const session = deps.cliSessionManager.get(tabOf(binding));
  const busy = isBusy(binding);
  const pendingAsks = pendingAsksFor(tabOf(binding)).length;
  const dirtyFiles = session?.cwd ? await gitStatus(session.cwd) : null;
  return { bound: true, busy, pendingAsks, dirtyFiles, cliStatus: session?.status || 'idle' };
}

async function endSession(chatId, { force } = {}) {
  const binding = getBinding(chatId);
  if (!binding) throw new Error('No session bound to this chat');
  const assessment = await assessEnd(chatId);
  if (assessment.busy && !force) {
    return { ended: false, assessment };
  }
  // Reject pending asks so the MCP tool call doesn't hang for hours.
  const tabId = tabOf(binding);
  try { deps.clearPendingQuestionsForTab(tabId); } catch {}
  if (assessment.cliStatus === 'running') {
    interrupt(chatId);
    await new Promise((r) => setTimeout(r, 2000));
    deps.cliSessionManager.kill(tabId);
  }
  delete state.sessions[String(chatId)];
  saveState();
  notified.delete(chatId);

  const parts = [`Session ended (${describeTarget(binding.target)}).`];
  if (assessment.pendingAsks) parts.push(`${assessment.pendingAsks} unanswered question(s) were cancelled.`);
  if (assessment.dirtyFiles) parts.push(`${assessment.dirtyFiles} file(s) with uncommitted changes remain in the working tree.`);
  parts.push('The CLI tab remains resumable from the dashboard.');
  const summary = parts.join(' ');
  notifyChat(chatId, summary, false);
  return { ended: true, assessment, summary };
}

// --- Mini App API ---

// Mounted by platform/index.js on the pro router (auth-exempt subtree;
// every endpoint self-authenticates via initData exchange / bearer token —
// the shared implementation lives in tg-miniapp-auth.js).
function mountApi(router) {
  const base = '/pro/tg-session/api';
  const { authed } = miniAppAuth.mountAuth(router, base, { key: KEY, header: SESSION_HEADER });

  router.get(`${base}/state`, authed(async (req, res, rec) => {
    const binding = getBinding(rec.chatId);
    if (!binding) return res.json({ bound: false });
    const session = deps.cliSessionManager.get(tabOf(binding));
    res.json({
      bound: true,
      target: binding.target,
      startedAt: binding.startedAt,
      cliStatus: session?.status || 'idle',
      busy: isBusy(binding),
      pendingQuestions: pendingAsksFor(tabOf(binding)),
      transcript: buildTranscript(binding),
    });
  }));

  router.post(`${base}/send`, authed(async (req, res, rec) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    sendTurn(rec.chatId, text);
    res.json({ ok: true });
  }));

  router.post(`${base}/answer`, authed(async (req, res, rec) => {
    const { askId, answer } = req.body || {};
    const binding = getBinding(rec.chatId);
    if (!binding) return res.status(400).json({ error: 'no session bound' });
    const pending = deps.pendingQuestions.get(askId);
    if (!pending || (pending.ctx?.tabId || pending.message?.tabId) !== tabOf(binding)) {
      return res.status(404).json({ error: 'question not pending for this session' });
    }
    if (!Array.isArray(answer)) return res.status(400).json({ error: 'answer must be an array' });
    pending.resolve(answer);
    deps.broadcaster.broadcast({ type: 'ask:answered', askId });
    notified.delete(rec.chatId);
    res.json({ ok: true });
  }));

  router.post(`${base}/esc`, authed(async (req, res, rec) => {
    interrupt(rec.chatId);
    res.json({ ok: true });
  }));

  router.post(`${base}/end`, authed(async (req, res, rec) => {
    const result = await endSession(rec.chatId, { force: !!req.body?.force });
    res.json(result);
  }));

  // Orchestration runs: <base>/runs, <base>/run/:runId[/…] (same auth), and
  // the owner-authed /pro/tg-handoff/* outside this exempt subtree.
  tgRuns.mountApi(router, base, authed);
  tgRuns.mountHandoff(router);
}

module.exports = {
  init, mountApi, launch, sendTurn, interrupt, assessEnd, endSession,
  getBinding, miniAppUrl, openSessionMarkup, describeTarget,
};
