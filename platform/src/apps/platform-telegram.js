const telegram = require('./telegram');
const tgSession = require('./platform-tg-session');
const tgRuns = require('./platform-tg-runs');
const platformHorst = require('./platform-horst');
const platformLogin = require('./platform-login');

// Telegram control bot for the Vistaclair dashboard ITSELF (not an app). Reuses
// the per-app telegram.js machinery under a reserved key that can never collide
// with a real app (app names must match /^[a-z0-9][a-z0-9-]*$/, so a leading
// underscore is impossible). Restricted by default and CLAIMED BY CODE: the
// owner's authenticated dashboard shows a one-time claim link
// (`t.me/<bot>?start=claim_<code>`, telegram.js); a private-chat `/start
// claim_<code>` makes that Telegram user the owner. Inbound messages never
// claim the bot, and an unclaimed bot serves nobody.
//
// This chat is also HORST's Telegram chat (docs/horst-surfaces.md): free-text messages in
// the claimed chat — when no CLI session is bound — go to Horst's chat pipeline
// and he answers here. The briefing is NOT pushed here: it restates what the
// owner has already seen, so it is journalled and read through an app
// (ctx.horst.briefing()) instead of landing in this chat.
//
// Control capabilities: launch app-change / vistaclair-pro CLI sessions (interaction via the
// /pro/tg-session/ Mini App, notifications in chat), restart the server, and
// end a bound session with a safety assessment. While a session is bound,
// plain messages go to that session — /menu always shows the buttons.
// "💻 Sessions" follows orchestration runs (platform-tg-runs.js): a live card
// per run and pushes, messages to a run only through the Mini App — plain
// text never goes to a run.
//
// EVERY control action is privileged: isPrivileged(message | callback) needs
// restricted mode, a PRIVATE chat, and the sender to be the claimed owner
// (telegram.isOwnerAct — the same rule as the dashboard-login approval). The
// chat id alone never grants anything, so a group the bot sits in gives its
// members nothing. There is no button that hands out the dashboard AUTH_TOKEN:
// the owner logs in with the QR login (platform-login.js). An unrestricted bot
// offers no buttons at all — it can only point you at the dashboard Apps setup
// page.

const KEY = '__platform__';
const APPS_PER_PAGE = 8;
let appManager = null;
let scheduleRestart = null;
// chatId → { mode: 'awaiting-app-prompt', appName } | { mode: 'awaiting-pro-prompt' }
const chatStates = new Map();

// The one privilege check. `actor` is the inbound message OR callback query
// (chat + sender). Anything else — a bare chat id included — is refused.
function isPrivileged(actor) {
  if (!actor || typeof actor !== 'object') return false;
  const isCallback = actor.data !== undefined || (actor.message && !actor.chat);
  const chat = isCallback ? actor.message?.chat : actor.chat;
  return telegram.isOwnerAct(KEY, chat, actor.from);
}

// Presentation only (which menu text/buttons to show for a chat we are about to
// write to): the claimed owner's private chat has the owner's user id as its id.
// Never use this to authorise anything — isPrivileged does that.
function isOwnerChat(chatId) {
  const bot = telegram.getBot(KEY);
  const uid = bot?.restricted ? telegram.claimedOwner(KEY) : null;
  return uid != null && Number(chatId) === uid;
}

// Returns undefined for an unprivileged chat: no rows means no keyboard at all
// (Telegram rejects an empty inline_keyboard), and reply() omits reply_markup.
function mainKeyboard(chatId) {
  if (!isOwnerChat(chatId)) return undefined;
  const rows = [];
  const bound = tgSession.getBinding(chatId);
  if (bound) {
    const open = tgSession.openSessionMarkup();
    if (open) rows.push(open.inline_keyboard[0]);
    rows.push([{ text: '⏹ End session', callback_data: 'vc_end_session' }]);
  } else {
    rows.push([
      { text: '🛠 Change app', callback_data: 'vc_change_app:0' },
      { text: '💻 Vistaclair-pro CLI', callback_data: 'vc_pro_cli' },
    ]);
  }
  rows.push([
    { text: '📒 Directives', callback_data: 'vc_directives' },
    ...(tgRuns.enabled() ? [{ text: '💻 Sessions', callback_data: 'vr_list' }] : []),
  ]);
  // Approvals open the Mini App directly — it is the decision surface now.
  // With no public URL there is no Mini App, so the button falls back to the
  // in-chat digest rather than becoming a dead link.
  const approvalsUrl = platformHorst.approvalsUrl();
  rows.push([
    approvalsUrl
      ? { text: '📥 Approvals', web_app: { url: approvalsUrl } }
      : { text: '📥 Approvals', callback_data: 'vc_approvals' },
    { text: '☑ Todos', callback_data: 'vc_todos' },
    { text: '🎯 Missions', callback_data: 'vc_missions' },
  ]);
  rows.push([{ text: '📋 Apps & bots', callback_data: 'vc_bots:0' }]);
  const sessionsRow = platformLogin.menuRow(chatId);
  if (sessionsRow) rows.push(sessionsRow);
  rows.push([{ text: '🔄 Restart Vistaclair', callback_data: 'vc_restart' }]);
  return { inline_keyboard: rows };
}

async function reply(chatId, text, markup, parseMode) {
  return telegram.call(KEY, 'sendMessage', {
    chat_id: chatId,
    text,
    ...(markup ? { reply_markup: markup } : {}),
    ...(parseMode ? { parse_mode: parseMode } : {}),
  }).catch(() => null);
}

function menuText(chatId) {
  const binding = tgSession.getBinding(chatId);
  if (binding) {
    return `Horst here — a CLI session is bound to this chat: ${tgSession.describeTarget(binding.target)}. `
      + 'Plain messages go to that session as your next instruction; /menu brings these buttons back, '
      + 'and I\'ll chat with you again once the session ends.';
  }
  if (isOwnerChat(chatId)) {
    return 'Horst here — this is the Vistaclair control chat. Just write to me to chat, '
      + 'or pick a control action below. (/menu shows this again.)';
  }
  return 'Vistaclair control bot. No actions are available in this chat: control actions '
    + '(sessions, restart) and chatting with Horst all require restricted mode '
    + 'with this chat claimed by its owner — see the dashboard Apps setup page.';
}

function appListKeyboard(page) {
  const apps = appManager ? appManager.list() : [];
  const start = page * APPS_PER_PAGE;
  const slice = apps.slice(start, start + APPS_PER_PAGE);
  const rows = slice.map((a) => [{ text: a.name, callback_data: `vc_app:${a.name}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Prev', callback_data: `vc_change_app:${page - 1}` });
  if (start + APPS_PER_PAGE < apps.length) nav.push({ text: 'Next ▶', callback_data: `vc_change_app:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '✖ Cancel', callback_data: 'vc_cancel' }]);
  return { rows, count: apps.length };
}

// All installed apps and every configured app bot. Bots with a known username
// get a t.me url button — tapping it opens a chat with that bot directly, so
// the owner can reach a bot they never started (or lost in their chat history).
function appsBotsView(page) {
  const apps = appManager ? appManager.list() : [];
  const bots = telegram.listBots().filter((b) => b.appName !== KEY);
  const byApp = new Map(bots.map((b) => [b.appName, b]));
  const appNames = new Set(apps.map((a) => a.name));

  const lines = ['Installed apps and their Telegram bots:', ''];
  for (const a of apps) {
    const bot = byApp.get(a.name);
    lines.push(bot?.botUsername ? `• ${a.name} — @${bot.botUsername}` : `• ${a.name} — no bot`);
  }
  // Bots whose app was removed still hold a registration; show them too.
  const orphans = bots.filter((b) => !appNames.has(b.appName) && b.botUsername);
  for (const b of orphans) lines.push(`• ${b.appName} (app removed) — @${b.botUsername}`);
  if (!apps.length && !orphans.length) lines.push('No apps installed.');

  const linked = [
    ...apps.filter((a) => byApp.get(a.name)?.botUsername)
      .map((a) => ({ label: a.name, username: byApp.get(a.name).botUsername })),
    ...orphans.map((b) => ({ label: b.appName, username: b.botUsername })),
  ];
  if (linked.length) lines.push('', 'Tap a button to open a chat with that bot:');

  const start = page * APPS_PER_PAGE;
  const rows = linked.slice(start, start + APPS_PER_PAGE)
    .map((l) => [{ text: `💬 ${l.label} (@${l.username})`, url: `https://t.me/${l.username}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Prev', callback_data: `vc_bots:${page - 1}` });
  if (start + APPS_PER_PAGE < linked.length) nav.push({ text: 'Next ▶', callback_data: `vc_bots:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '✖ Close', callback_data: 'vc_cancel' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || '';
  await telegram.call(KEY, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  if (chatId == null) return;

  // Every callback is privileged: the owner, in their private chat. Anyone
  // else's tap (a forwarded card, a crafted callback, a group member) is
  // dropped without a reply — an old 'vc_get_auth_token' button included.
  if (!isPrivileged(cq)) return;

  // Dashboard login cards and sessions (owner-only again, checked there).
  if (platformLogin.handles(data)) {
    await platformLogin.handleCallback(cq);
    return;
  }

  if (data === 'vc_directives') {
    const items = platformHorst.listDirectives();
    const active = items.filter((i) => i.status === 'active');
    const pending = items.filter((i) => i.status === 'pending');
    const lines = ['Your directives for Horst:', ''];
    for (const i of active) lines.push(`✅ #${i.id}: ${i.text}`);
    for (const i of pending) lines.push(`⏳ #${i.id} (awaiting confirmation): ${i.text}`);
    if (!active.length && !pending.length) lines.push('None yet — just tell me "from now on …" in chat.');
    const rows = pending.map((i) => ([
      { text: `✅ Confirm #${i.id}`, callback_data: `horst_dir:${i.id}:active` },
      { text: `✖ Dismiss #${i.id}`, callback_data: `horst_dir:${i.id}:inactive` },
    ]));
    rows.push([{ text: '✖ Close', callback_data: 'vc_cancel' }]);
    await reply(chatId, lines.join('\n'), { inline_keyboard: rows });
  } else if (data === 'vc_approvals') {
    // One notice with a way in, not the queue itself. Falls back to sending the
    // cards when no Mini App is reachable (platform-horst.sendApprovalsDigest).
    const { count } = await platformHorst.sendApprovalsDigest(chatId);
    if (!count) await reply(chatId, 'No proposals awaiting approval.', mainKeyboard(chatId));
  } else if (data.startsWith('horst_prop:')) {
    // horst_prop:<id>:approve:<payload version> — a card sent before an edit
    // carries the old version and is refused (governance.decide).
    const [, id, decision, version] = data.split(':');
    try {
      const p = await platformHorst.decideProposal(id, decision, 'telegram', { version: version ?? null });
      const outcome = p.status === 'executed' ? `✅ Approved and executed: ${p.summary}`
        : p.status === 'failed' ? `❌ Approved but execution failed: ${p.summary} — ${p.error}`
        : `🚫 Denied: ${p.summary}`;
      await reply(chatId, outcome);
    } catch (err) {
      await reply(chatId, `Could not decide proposal: ${err.message}`);
    }
  } else if (data === 'vc_todos') {
    const todos = await platformHorst.listOpenTodos();
    if (!todos.length) {
      await reply(chatId, 'No open todos. Tell me "remind me …" in chat to add one.', mainKeyboard(chatId));
      return;
    }
    const now = new Date();
    const lines = ['Your open todos:', ''];
    const rows = [];
    for (const t of todos.slice(0, 8)) {
      const eff = t.snoozedUntil || t.dueAt;
      const flag = t.watch ? '⏳' : (eff && new Date(eff) <= now ? '❗' : '▫');
      lines.push(`${flag} #${t.id} ${t.title}${eff ? ` — ${new Date(eff).toLocaleString()}` : ''}${t.watch ? ' (waiting for reply)' : ''}`);
      rows.push([
        { text: `✅ Done #${t.id}`, callback_data: `horst_todo:${t.id}:done` },
        { text: '💤 1d', callback_data: `horst_todo:${t.id}:snooze:1d` },
      ]);
    }
    if (todos.length > 8) lines.push(`…and ${todos.length - 8} more in Horst > Todos.`);
    rows.push([{ text: '✖ Close', callback_data: 'vc_cancel' }]);
    await reply(chatId, lines.join('\n'), { inline_keyboard: rows });
  } else if (data === 'vc_missions') {
    const items = platformHorst.listMissions();
    if (!items.length) {
      await reply(chatId, 'No missions yet — assign one in chat: "your mission: …"', mainKeyboard(chatId));
      return;
    }
    const icon = { active: '🟢', pending: '⏳', paused: '⏸', blocked: '🔴', done: '✅', abandoned: '✖', proposed: '💡' };
    const lines = ['Horst\'s missions:', ''];
    const rows = [];
    for (const m of items.slice(0, 10)) {
      lines.push(`${icon[m.status] || '·'} ${m.title} (${m.status})${m.progress?.[0] ? ` — ${m.progress[0].note.slice(0, 60)}` : ''}`);
      if (m.status === 'pending') {
        rows.push([
          { text: `✅ Confirm: ${m.title.slice(0, 30)}`, callback_data: `horst_mis:${m.id}:active` },
          { text: '✖ Dismiss', callback_data: `horst_mis:${m.id}:abandoned` },
        ]);
      }
    }
    rows.push([{ text: '✖ Close', callback_data: 'vc_cancel' }]);
    await reply(chatId, lines.join('\n'), { inline_keyboard: rows });
  } else if (data.startsWith('horst_mis:')) {
    const [, id, status] = data.split(':');
    const m = platformHorst.setMissionStatus(id, status === 'active' ? 'active' : 'abandoned');
    await reply(chatId, m
      ? (status === 'active' ? `🎯 Mission confirmed: ${m.title} — reviews every ${m.reviewCadenceDays} day(s).` : `Mission dismissed: ${m.title}`)
      : 'That mission no longer exists.');
  } else if (data.startsWith('horst_todo:')) {
    const [, id, action, arg] = data.split(':');
    try {
      const outcome = await platformHorst.todoAction(id, action, arg);
      // A nudge card closes in place — original body + outcome line, buttons
      // gone (same rule as approval cards) — so a stale card is never left
      // actionable. Anything else (todo list, undo chips) replies as before.
      const src = cq.message;
      if (src && String(src.text || '').startsWith('⏰ Todo due:')) {
        const body = String(src.text).slice(0, 4090 - outcome.length - 2);
        await telegram.call(KEY, 'editMessageText', {
          chat_id: chatId, message_id: src.message_id, text: `${body}\n\n${outcome}`,
        }).catch(() => reply(chatId, outcome)); // >48h-old cards can't be edited
      } else {
        await reply(chatId, outcome);
      }
    } catch (err) {
      await reply(chatId, `Todo action failed: ${err.message}`);
    }
  } else if (data.startsWith('horst_dir:')) {
    const [, id, status] = data.split(':');
    const item = platformHorst.setDirectiveStatus(id, status === 'active' ? 'active' : 'inactive');
    await reply(chatId, item
      ? (status === 'active' ? `Directive #${item.id} confirmed — it now always applies.` : `Directive #${item.id} dismissed.`)
      : 'That directive no longer exists.');
  } else if (data.startsWith('vc_bots:')) {
    const page = parseInt(data.split(':')[1], 10) || 0;
    const view = appsBotsView(page);
    await reply(chatId, view.text, view.markup);
  } else if (data.startsWith('vc_change_app:')) {
    if (tgSession.getBinding(chatId)) {
      await reply(chatId, 'A session is already bound to this chat. End it first.', mainKeyboard(chatId));
      return;
    }
    const page = parseInt(data.split(':')[1], 10) || 0;
    const { rows, count } = appListKeyboard(page);
    if (!count) {
      await reply(chatId, 'No apps installed yet.', mainKeyboard(chatId));
      return;
    }
    await reply(chatId, 'Which app do you want to change?', { inline_keyboard: rows });
  } else if (data.startsWith('vc_app:')) {
    const appName = data.slice('vc_app:'.length);
    chatStates.set(chatId, { mode: 'awaiting-app-prompt', appName });
    await reply(chatId, `Reply with the change you want for "${appName}".\n\n(Or /cancel to abort.)`);
  } else if (data === 'vc_pro_cli') {
    if (tgSession.getBinding(chatId)) {
      await reply(chatId, 'A session is already bound to this chat. End it first.', mainKeyboard(chatId));
      return;
    }
    chatStates.set(chatId, { mode: 'awaiting-pro-prompt' });
    await reply(chatId, 'Reply with your instruction for the vistaclair-pro CLI.\n\n(Or /cancel to abort.)');
  } else if (data === 'vc_cancel') {
    chatStates.delete(chatId);
    await reply(chatId, 'Cancelled.', mainKeyboard(chatId));
  } else if (data === 'vc_restart') {
    const binding = tgSession.getBinding(chatId);
    const warn = binding
      ? `⚠️ A session is bound to this chat (${tgSession.describeTarget(binding.target)}) — a restart will interrupt any in-flight turn. `
      : '';
    await reply(chatId, `${warn}Restart Vistaclair now?`, {
      inline_keyboard: [[
        { text: '✅ Yes, restart', callback_data: 'vc_restart_confirm' },
        { text: '✖ Cancel', callback_data: 'vc_cancel' },
      ]],
    });
  } else if (data === 'vc_restart_confirm') {
    if (!scheduleRestart) {
      await reply(chatId, 'Restart is not available (host did not provide it).');
      return;
    }
    await reply(chatId, 'Restarting Vistaclair…');
    scheduleRestart();
  } else if (data === 'vc_end_session') {
    if (!tgSession.getBinding(chatId)) {
      await reply(chatId, 'No session is bound to this chat.', mainKeyboard(chatId));
      return;
    }
    try {
      const result = await tgSession.endSession(chatId, {});
      if (!result.ended) {
        await reply(chatId, 'Claude is still working on a turn. End anyway?', {
          inline_keyboard: [[
            { text: '⏹ End anyway', callback_data: 'vc_end_force' },
            { text: '⏳ Keep waiting', callback_data: 'vc_cancel' },
          ]],
        });
      }
      // ended: endSession already sent the summary message
    } catch (err) {
      await reply(chatId, `End session failed: ${err.message}`);
    }
  } else if (data === 'vr_list' || data.startsWith('vr:') || data.startsWith('vq:')) {
    // Orchestration runs: the list, a card's buttons, a question's answers.
    await tgRuns.handleCallback(chatId, data, cq.message);
  } else if (data === 'vc_end_force') {
    try {
      await tgSession.endSession(chatId, { force: true });
    } catch (err) {
      await reply(chatId, `End session failed: ${err.message}`);
    }
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  if (chatId == null) return;
  const text = (msg.text || '').trim();
  const priv = isPrivileged(msg);

  // `/start claim_<code>` reaches us only after telegram.js redeemed the code
  // (a bad one never gets here): this private chat now is the owner's.
  if (telegram.isClaimStart({ message: msg })) {
    chatStates.delete(chatId);
    if (priv) await reply(chatId, '✅ This chat now controls Vistaclair. Only you can use this bot.', mainKeyboard(chatId));
    return;
  }

  // A dashboard login QR (`/start login_<code>`) comes first: it never reaches
  // the menu, a bound session or Horst, and only the owner gets a reply.
  if (telegram.isLoginStart({ message: msg })) {
    if (priv) await platformLogin.handleStart(msg);
    return;
  }
  if (/^\/sessions(?:@\w+)?$/.test(text) && priv && await platformLogin.handleSessionsCommand(msg)) return;

  if (text === '/cancel') {
    chatStates.delete(chatId);
    await reply(chatId, 'Cancelled.', mainKeyboard(chatId));
    return;
  }

  if (text === '/start' || text === '/menu' || text === '/help') {
    if (priv || msg.chat?.type === 'private') await reply(chatId, menuText(chatId), mainKeyboard(chatId));
    return;
  }

  const pending = chatStates.get(chatId);
  if (pending && text && priv) {
    chatStates.delete(chatId);
    try {
      const target = pending.mode === 'awaiting-app-prompt'
        ? { type: 'app', name: pending.appName }
        : { type: 'pro' };
      tgSession.launch(chatId, target, text);
      const open = tgSession.openSessionMarkup();
      await reply(chatId,
        `Session started for ${tgSession.describeTarget(target)}. `
        + (open ? 'Open it below to follow along — you\'ll also get notified here when Claude needs you.'
                : 'No public URL is configured, so the Mini App button is unavailable — you\'ll get chat notifications; plain messages go to Claude.'),
        open || mainKeyboard(chatId));
    } catch (err) {
      await reply(chatId, `Could not start the session: ${err.message}`, mainKeyboard(chatId));
    }
    return;
  }

  // A reply to a long-running tool's question (agent/horst-jobs.js) is its
  // answer, whatever else the chat is bound to.
  if (priv && text && msg.reply_to_message && !text.startsWith('/')) {
    const answered = platformHorst.answerJobQuestion(msg, msg.reply_to_message.message_id, text);
    if (answered) {
      await reply(chatId, answered.text);
      return;
    }
  }

  // Bound session: plain text = next instruction for Claude.
  if (priv && tgSession.getBinding(chatId) && text && !text.startsWith('/')) {
    try {
      tgSession.sendTurn(chatId, text);
      await reply(chatId, '→ Sent to Claude.');
    } catch (err) {
      await reply(chatId, `Send failed: ${err.message}`);
    }
    return;
  }

  // Media in the claimed chat (voice/photo/document): enrich into text so the
  // turn flows through the same Horst chat — voice notes get a spoken reply
  // back (2026-08; absorbed from the retired my-dashboard TG assistant).
  let effectiveText = text && !text.startsWith('/') ? text : '';
  let spokenTurn = false;
  if (priv && !effectiveText && msg && (msg.voice || msg.audio || msg.video_note || msg.photo || msg.document)) {
    telegram.call(KEY, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const enriched = await platformHorst.enrichTelegramMedia(msg);
    if (enriched) {
      if (enriched.note && !enriched.text) {
        await reply(chatId, enriched.note);
        return;
      }
      effectiveText = enriched.text;
      spokenTurn = !!enriched.spoken;
    }
  }

  // Free text (or enriched media) in the claimed chat with no bound session:
  // this is Horst's chat. He replies here; directives his reply proposes get
  // confirm buttons.
  if (priv && effectiveText) {
    telegram.call(KEY, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      const r = await platformHorst.chatFromTelegram(chatId, effectiveText);
      const markupRows = [
        ...r.pendingDirectives.map((d) => ([
          { text: `✅ Confirm directive #${d.id}`, callback_data: `horst_dir:${d.id}:active` },
          { text: '✖ Dismiss', callback_data: `horst_dir:${d.id}:inactive` },
        ])),
        ...(r.todos || []).map((t) => ([
          { text: `↩ Undo todo: ${String(t.title).slice(0, 40)}`, callback_data: `horst_todo:${t.id}:undo` },
        ])),
        ...(r.pendingMissions || []).map((m) => ([
          { text: `🎯 Confirm mission: ${String(m.title).slice(0, 30)}`, callback_data: `horst_mis:${m.id}:active` },
          { text: '✖ Dismiss', callback_data: `horst_mis:${m.id}:abandoned` },
        ])),
      ];
      const markup = markupRows.length ? { inline_keyboard: markupRows } : undefined;
      // Files the turn's tools returned (an image a tool made, …) ride on the
      // reply as an "Open in Vista" link (and a picture's preview).
      await platformHorst.sendTurnReply(chatId, r.text, markup, r.deliveries);
      if (spokenTurn && !r.busy) platformHorst.speakReply(chatId, r.text).catch(() => {});
    } catch (err) {
      await reply(chatId, `Horst hit an error: ${err.message}`);
    }
    return;
  }

  // Anything else (empty messages, unknown commands): show the menu — in the
  // owner's chat or a private one; groups get no reply.
  if (priv || msg.chat?.type === 'private') await reply(chatId, menuText(chatId), mainKeyboard(chatId));
}

async function handleUpdate(update) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    const msg = update.message || update.edited_message;
    if (msg) return await handleMessage(msg);
  } catch (err) {
    console.error('[platform-telegram] update error:', err.message);
  }
}

// The persistent launcher next to the message box. The control bot's Mini App
// is Vista (the approvals surface), so this resolves the URL through the same
// approvalsUrl() the inline buttons use — one resolution, so the two can never
// disagree about whether a Mini App exists.
//
// With no public URL there is no Mini App, and the button must fall back to the
// command menu rather than point at a dead link — the same discipline as
// proposalButtons(). Re-run whenever that answer can change: at boot, when a
// bot is configured, and from telegram.setPublicUrl().
async function syncMenuButton() {
  if (!telegram.hasBot(KEY)) return;
  const url = platformHorst.approvalsUrl();
  const menuButton = url
    ? { type: 'web_app', text: '📥 Approvals', web_app: { url } }
    : { type: 'default' };
  try {
    // telegram.call resolves with Telegram's envelope instead of throwing, so a
    // refusal arrives as { ok: false } and would otherwise vanish right here —
    // leaving the launcher absent with nothing in the log to explain it.
    const res = await telegram.call(KEY, 'setChatMenuButton', { menu_button: menuButton });
    if (!res?.ok) {
      console.warn('[platform-telegram] setChatMenuButton refused:', res?.description || 'unknown error');
    }
  } catch (err) {
    // Never fatal: the inline '📥 Approvals' button in /menu is the same
    // surface by another door, so a failed launcher costs reachability, not
    // access.
    console.warn('[platform-telegram] setChatMenuButton:', err.message);
  }
}

// Registered once at boot. It only fires when a bot is configured (telegram.js
// won't dispatch otherwise) and only for chats that pass the restriction check.
function init(_token, options = {}) {
  appManager = options.appManager || null;
  scheduleRestart = options.scheduleRestart || null;
  telegram.registerUpdateHandler(KEY, handleUpdate);
  // Fire-and-forget: boot must not block on a Telegram round-trip, and a bot
  // configured in an earlier run needs its launcher restored (the menu button
  // lives on Telegram's side, but the URL it points at may have changed while
  // we were down).
  syncMenuButton();
}

async function setBot(token) {
  const fresh = !telegram.hasBot(KEY);
  const result = await telegram.setBot(KEY, token);
  // Restricted by default on first configuration.
  if (result.ok && fresh) telegram.setRestricted(KEY, true);
  // A newly configured bot starts with the default menu; give it the launcher
  // without making the caller wait for Telegram.
  if (result.ok) syncMenuButton();
  return result;
}

async function removeBot() {
  return telegram.removeBot(KEY);
}

function setRestricted(restricted) {
  return telegram.setRestricted(KEY, restricted);
}

function removeAllowedChat(chatId) {
  const result = telegram.removeAllowedChat(KEY, chatId);
  chatStates.delete(Number(chatId));
  return result;
}

// A fresh claim code for the dashboard to show its owner (never sent to chat):
// → { ok, code, expiresAt, link } — `link` is the t.me deep link, null until the
// bot's username is known.
function createClaimCode() {
  return telegram.createClaimCode(KEY);
}

function hasBot() {
  return telegram.hasBot(KEY);
}

async function test() {
  if (!telegram.hasBot(KEY)) return { ok: false, error: 'No control bot configured' };
  return telegram.call(KEY, 'getMe', {});
}

function status() {
  const st = telegram.status(KEY);
  return { ...st, claimed: !!st.restricted && telegram.claimedOwner(KEY) != null };
}

module.exports = {
  KEY, init, isPrivileged, setBot, removeBot, setRestricted, removeAllowedChat, createClaimCode,
  hasBot, test, status, syncMenuButton,
};
