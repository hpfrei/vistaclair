// Capability: telegram — `telegram.status/send/…` + Web App (mini-app)
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.

// A file riding along with a governed Telegram message. Kept deliberately
// narrow: the three things Telegram renders differently, a payload that is
// either bytes (base64) or a reference Telegram fetches itself, and a filename
// — which is the only part of a document the recipient sees before opening it.
const MEDIA_TYPES = ['photo', 'document', 'audio'];
const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // Telegram's own bot-upload ceiling

function validateMedia(media) {
  if (typeof media !== 'object' || Array.isArray(media)) throw new Error('media must be an object');
  const type = String(media.type || 'document');
  if (!MEDIA_TYPES.includes(type)) throw new Error(`media.type must be one of ${MEDIA_TYPES.join(', ')}`);
  if (media.data == null && !media.ref) throw new Error('media requires data or ref');
  if (media.data != null) {
    if (typeof media.data !== 'string') throw new Error('media.data must be base64');
    // 4 base64 chars per 3 bytes — checked before decoding so an oversized
    // payload never becomes a 50 MB Buffer just to be rejected.
    if (Math.floor(media.data.length * 3 / 4) > MAX_MEDIA_BYTES) throw new Error('media is larger than 50 MB');
  }
  if (media.filename != null && /[\r\n/]/.test(String(media.filename))) {
    throw new Error('media.filename must not contain a line break or a path separator');
  }
}

module.exports = {
  key: 'telegram',
  title: 'Telegram (Per-App Bot)',
  core: false,
  gated: true,
  methods: ['telegram.status', 'telegram.send', 'telegram.sendPhoto', 'telegram.sendAudio', 'telegram.sendDocument', 'telegram.call', 'telegram.downloadFile'],
  prefixes: ['telegram.'],
  ctx: ['telegram'],
  keywords: /\b(telegram|bot token|webapp|chat ?id)\b/i,
  summary: '`telegram.status/send/…` + Web App (mini-app)',
  visibility: { standalone: true },
  revocable: true,

  buildCtx(app) {
    const telegram = require('../telegram');
    const name = app.name;
    return {
      telegram: {
        configured: () => telegram.hasBot(name),
        status: () => telegram.status(name),
        send: (chatId, text, opts) => telegram.send(name, chatId, text, opts),
        sendPhoto: (args) => telegram.sendPhoto(name, args),
        sendAudio: (args) => telegram.sendAudio(name, args),
        sendDocument: (args) => telegram.sendDocument(name, args),
        call: (method, params) => telegram.call(name, method, params),
        // Handler receives (rawUpdate, normalized) — the second arg is the same flat
        // shape ctx.whatsapp delivers, so a handler can be channel-agnostic. The
        // wrapper is applied here; telegram.js itself still passes only the raw update.
        // Voice/audio/video_note messages are auto-transcribed before delivery.
        onUpdate: (handler) => telegram.registerUpdateHandler(name, async (raw) => {
          const normalized = telegram.normalizeTelegramUpdate(raw);
          if (normalized.media?.file_id && (normalized.type === 'voice' || normalized.type === 'audio' || normalized.type === 'video_note')) {
            try {
              const { buffer, contentType } = await telegram.downloadFile(name, normalized.media.file_id);
              const result = await require('../ai-media').aiTranscribe(name, {
                audio: buffer.toString('base64'),
                mimeType: contentType || normalized.media.mime_type,
                filename: `telegram_${normalized.type}.ogg`,
              });
              normalized.text = result.text || '';
              normalized.transcription = { text: result.text, duration: normalized.media.duration, model: result.model, silent: result.silent };
            } catch (err) {
              normalized.transcription = { error: err.message };
              if (normalized.chatId) {
                telegram.send(name, normalized.chatId, `Voice transcription failed: ${err.message}`).catch(() => {});
              }
            }
          }
          handler(raw, normalized);
        }),
        downloadFile: (fileId) => telegram.downloadFile(name, fileId),
        // `{ customDomain: true }` → the recorded custom domain's URL (else
        // the platform one): the owner's Configure → Website domain field
        // (`websiteDomainField`, per host — a slave's own value on a mirror).
        // No argument stays the platform URL a bot's web_app button opens.
        // The redirects that make that domain land on the entry page are the
        // perimeter's (surfaces.js + index.js), its nginx block and Check are
        // app-manager's (accessInfo / checkDomain) — not ours.
        webAppUrl: (opts) => telegram.webAppUrl(name, opts),
        entryUrl: (opts) => telegram.entryUrl(name, opts),
        botToken: () => telegram.getToken(name),
        isAllowed: (chatId) => telegram.isAllowed(name, chatId),
      },
    };
  },

  bridge: {
    'telegram.status': async (app) => require('../telegram').status(app.name),
    'telegram.send': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      return require('../telegram').send(app.name, params.chatId, params.text || '', params.options);
    },
    'telegram.call': async (app, params) => {
      if (!params.method) throw new Error('method required');
      return require('../telegram').call(app.name, params.method, params.params || {});
    },
    'telegram.sendPhoto': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      if (params.photo == null) throw new Error('photo required');
      return require('../telegram').sendPhoto(app.name, params);
    },
    'telegram.sendDocument': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      if (params.document == null) throw new Error('document required');
      const p = { ...params };
      if (typeof p.document === 'string' && !/^https?:\/\//i.test(p.document) && /^[A-Za-z0-9+/=\s]+$/.test(p.document) && p.filename) {
        p.document = Buffer.from(p.document, 'base64'); // base64 payload over the Bridge
      }
      return require('../telegram').sendDocument(app.name, p);
    },
    'telegram.sendAudio': async (app, params) => {
      if (params.chatId == null) throw new Error('chatId required');
      if (typeof params.audio !== 'string' || !params.audio) throw new Error('audio required (base64)');
      let audioBuf;
      try { audioBuf = Buffer.from(params.audio, 'base64'); } catch (e) { throw new Error('audio must be base64'); }
      return require('../telegram').sendAudio(app.name, { ...params, audio: audioBuf });
    },
    'telegram.downloadFile': async (app, params) => {
      if (!params.fileId) throw new Error('fileId required');
      const { buffer, contentType, filePath } = await require('../telegram').downloadFile(app.name, params.fileId);
      return { data: buffer.toString('base64'), contentType, filePath };
    },
  },

  // ---- Horst facet: read-only tools, approval-gated kinds --------------------
  horst: {
    lane: {
      direct: { 'telegram.status': 'telegram_status' },
      card: {
        'telegram.send': 'telegram.send', 'telegram.sendPhoto': 'telegram.send',
        'telegram.sendAudio': 'telegram.send', 'telegram.sendDocument': 'telegram.send',
      },
      never: ['telegram.call', 'telegram.downloadFile'],
      why: 'raw Bot API calls and an app bot\'s file downloads are the app\'s own; the owner\'s files reach Horst as artifacts',
    },
    brief: 'telegram: per-app bots (sending to chats/groups is approval-gated)',
    tools: [
      {
        def: {
          name: 'telegram_status',
          description: 'Which installed apps have a Telegram bot, with configured mode (poll/webhook), current inbound (webhook/poll — poll with a fallback reason while the public URL is unreachable), the last delivery check, access restriction and allowlisted chat count, plus whether a public webhook URL is configured. Never returns tokens. Read-only.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => {
          const telegram = require('../telegram');
          const { textResult } = require('../horst-facet');
          const s = telegram.status();
          const bots = (s.bots || []).map((b) => ({
            app: b.appName, username: b.botUsername || null, mode: b.mode || null,
            inbound: b.inbound || b.mode || null,
            fallback: b.fallback ? { since: new Date(b.fallback.since).toISOString(), reason: b.fallback.reason } : null,
            lastCheck: b.lastCheck ? { at: new Date(b.lastCheck.at).toISOString(), ok: b.lastCheck.ok, reason: b.lastCheck.reason } : null,
            ...(b.monitored === false ? { monitoredBy: 'app process' } : {}),
            webApp: !!b.webAppEnabled, restricted: !!b.restricted, allowedChats: (b.allowedChatIds || []).length,
          }));
          return textResult({ publicUrlConfigured: !!s.publicUrl, bots });
        },
      },
    ],
    kinds: {
      'telegram.send': {
        appProposable: true, // apps may stage it (docs/governance.md, appMayStage)
        identity: null, // each request is its own act, not a re-derivation
        label: 'Send Telegram message',
        about: 'Sends a Telegram message to a chat, group or channel, optionally with a file attached.',
        pinNote: 'Outward-facing: other people read it, and it cannot be recalled.',
        ceiling: 'propose', // outward-facing (groups/channels) — human-confirmed
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'chatId', 'any');
          // A file may carry the message on its own — Telegram puts `text` in
          // the caption — so text is only required when there is nothing else.
          if (!p.media) req(p, 'text');
          if (p.media) validateMedia(p.media);
        },
        describe: (p) => `Telegram to chat ${p.chatId}: "${String(p.text || p.media?.filename || '').slice(0, 60)}"`
          + (p.media ? ` (+ ${p.media.type || 'document'} ${p.media.filename || ''})`.trimEnd() : ''),
        execute(p, proposal, helpers) {
          const fn = helpers && helpers.launcher ? helpers.launcher('telegram.send') : null;
          if (!fn) throw new Error('telegram.send launcher not registered (platform Telegram not initialized)');
          return fn(p);
        },
      },
    },
  },
};
