// Capability: whatsapp — `whatsapp.status/send/sendButtons/sendList/…`
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

// WhatsApp-only interactive/media sends share one shape: (appName, chatId, params).
async function sendInteractive(app, params, io) {
  const whatsapp = require('../whatsapp');
  if (params.chatId == null) throw new Error('chatId required');
  const fn = io.method.slice('whatsapp.'.length);
  return whatsapp[fn](app.name, params.chatId, params);
}

module.exports = {
  key: 'whatsapp',
  title: 'WhatsApp (Per-App, Cloud API)',
  core: false,
  gated: true,
  methods: ['whatsapp.status', 'whatsapp.send', 'whatsapp.sendButtons', 'whatsapp.sendList', 'whatsapp.sendMedia', 'whatsapp.sendPhoto', 'whatsapp.sendLocation', 'whatsapp.sendCta', 'whatsapp.requestLocation', 'whatsapp.react', 'whatsapp.markRead', 'whatsapp.call'],
  prefixes: ['whatsapp.'],
  ctx: ['whatsapp'],
  keywords: /\b(whatsapp|wa cloud api|business phone number)\b/i,
  summary: '`whatsapp.status/send/sendButtons/sendList/…`',
  visibility: { standalone: true },
  revocable: true,

  buildCtx(app) {
    const whatsapp = require('../whatsapp');
    const name = app.name;
    // Per-app WhatsApp Cloud API. Signature-symmetric with ctx.telegram (swap =
    // rename telegram -> whatsapp) PLUS a WhatsApp-only surface for interactive
    // messages and media. onUpdate's handler gets (rawMessage, normalized) — the
    // SAME normalized shape as Telegram, so handler logic can be channel-blind.
    // `chatId` is the user's wa_id (phone). Inbound is webhook-only; there is no
    // poll mode. Plain send() works only inside the 24h customer-service window.
    return {
      whatsapp: {
        configured: () => whatsapp.hasAccount(name),
        status: () => whatsapp.status(name),
        send: (chatId, text, opts) => whatsapp.send(name, chatId, text, opts),
        sendPhoto: (args) => whatsapp.sendPhoto(name, args),
        call: (method, params) => whatsapp.call(name, method, params),
        onUpdate: (handler) => whatsapp.registerUpdateHandler(name, handler),
        isAllowed: (chatId) => whatsapp.isAllowed(name, chatId),
        accessToken: () => whatsapp.getAccessToken(name),
        botToken: () => whatsapp.getAccessToken(name), // alias keeps a telegram->whatsapp swap clean
        webAppUrl: () => null, // no WhatsApp mini-app surface; present so swap code doesn't throw
        entryUrl: () => null,
        // WhatsApp-only surface (no Telegram analog; swap-code never calls these).
        sendButtons: (chatId, opts) => whatsapp.sendButtons(name, chatId, opts),
        sendList: (chatId, opts) => whatsapp.sendList(name, chatId, opts),
        sendCta: (chatId, opts) => whatsapp.sendCta(name, chatId, opts),
        sendLocation: (chatId, opts) => whatsapp.sendLocation(name, chatId, opts),
        requestLocation: (chatId, opts) => whatsapp.requestLocation(name, chatId, opts),
        sendMedia: (chatId, opts) => whatsapp.sendMedia(name, chatId, opts),
        react: (chatId, messageId, emoji) => whatsapp.react(name, chatId, messageId, emoji),
        markRead: (messageId) => whatsapp.markRead(name, messageId),
        media: {
          upload: (args) => whatsapp.uploadMedia(name, args),
          download: (mediaId) => whatsapp.downloadMedia(name, mediaId),
        },
      },
    };
  },

  bridge: {
    'whatsapp.status': async (app) => require('../whatsapp').status(app.name),
    'whatsapp.send': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      return require('../whatsapp').send(app.name, params.chatId, params.text || '', params.options);
    },
    'whatsapp.call': async (app, params) => {
      if (!params.method) throw new Error('method required');
      return require('../whatsapp').call(app.name, params.method, params.params || {});
    },
    'whatsapp.sendPhoto': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      if (params.photo == null) throw new Error('photo required');
      return require('../whatsapp').sendPhoto(app.name, params);
    },
    'whatsapp.sendButtons': sendInteractive,
    'whatsapp.sendList': sendInteractive,
    'whatsapp.sendCta': sendInteractive,
    'whatsapp.sendLocation': sendInteractive,
    'whatsapp.requestLocation': sendInteractive,
    'whatsapp.sendMedia': sendInteractive,
    'whatsapp.react': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      return require('../whatsapp').react(app.name, params.chatId, params.messageId, params.emoji);
    },
    'whatsapp.markRead': async (app, params) => {
      if (params.messageId == null) throw new Error('messageId required');
      return require('../whatsapp').markRead(app.name, params.messageId);
    },
  },

  // ---- Horst facet: mirrors telegram (phase 6 — the messaging asymmetry) ----
  horst: {
    lane: {
      direct: { 'whatsapp.status': 'whatsapp_status' },
      card: {
        'whatsapp.send': 'whatsapp.send',
        'whatsapp.sendMedia': { missing: 'whatsapp.send carries text; a media send needs an uploaded media id per app number' },
        'whatsapp.sendPhoto': { missing: 'whatsapp.send carries text; a media send needs an uploaded media id per app number' },
        'whatsapp.sendLocation': { missing: 'no chat request behind it yet' },
      },
      never: ['whatsapp.sendButtons', 'whatsapp.sendList', 'whatsapp.sendCta', 'whatsapp.requestLocation', 'whatsapp.react', 'whatsapp.markRead', 'whatsapp.call'],
      why: 'interactive messages, reactions and read receipts belong to an app bot\'s own conversation; whatsapp.call is the raw Cloud API',
    },
    brief: 'whatsapp: per-app WhatsApp Cloud API numbers (sending is approval-gated)',
    tools: [
      {
        def: {
          name: 'whatsapp_status',
          description: 'Which installed apps have a WhatsApp Cloud API number, with the display phone, verified name, mode, access restriction and allowlisted chat count. Never returns tokens. Read-only.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => {
          const whatsapp = require('../whatsapp');
          const { textResult } = require('../horst-facet');
          const accounts = (whatsapp.status().accounts || []).map((a) => ({
            app: a.appName, phone: a.displayPhone || null, name: a.verifiedName || null,
            mode: a.mode || null, restricted: !!a.restricted, allowedChats: (a.allowedChatIds || []).length,
          }));
          return textResult(accounts.length ? accounts : 'No app has a WhatsApp account configured.');
        },
      },
    ],
    kinds: {
      'whatsapp.send': {
        identity: null, // each request is its own act, not a re-derivation
        label: 'Send WhatsApp message',
        about: 'Sends a WhatsApp message from one of the apps\' business numbers to a chat.',
        pinNote: 'Outward-facing: other people read it, and it cannot be recalled.',
        ceiling: 'propose', // outward-facing — human-confirmed, mirrors telegram.send
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'chatId', 'any'); req(p, 'text');
          if (!require('../whatsapp').hasAccount(p.app)) throw new Error(`app "${p.app}" has no WhatsApp account`);
        },
        describe: (p) => `WhatsApp via "${p.app}" to ${p.chatId}: "${String(p.text).slice(0, 60)}"`,
        async execute(p) {
          await require('../whatsapp').send(p.app, p.chatId, p.text);
          return { ok: true, summary: `WhatsApp sent to ${p.chatId} via "${p.app}"` };
        },
      },
    },
  },
};
