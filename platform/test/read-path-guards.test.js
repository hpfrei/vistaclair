// The guardrails 8A moved onto the engine methods themselves.
//
// The point of the wave is that a guard lives ONE place — the engine method —
// so it holds no matter which entry point was used. These tests exercise the
// engine functions directly, because that is the thing every entry point ends
// up calling; a guard that only holds on the governance kind or only on the
// route is exactly what was wrong before.
//
// None of these assertions need a database: every refusal below is decided
// before the engine opens a connection, which is itself part of the contract
// (a refused call must not do work).
const test = require('node:test');
const assert = require('node:assert/strict');

const spendContext = require('../src/apps/spend-context');
const emailEngine = require('../src/apps/email-engine');
const calendarEngine = require('../src/apps/calendar-engine');

// An app's own user — an app-auth account or a platform identity session.
const asUser = (fn) => spendContext.run({ app: 'my-dashboard', origin: 'route', principal: 'acct:7' }, fn);
// The mailbox owner, the principal every engine guard is written for.
const asOwner = (fn) => spendContext.run({ app: 'my-dashboard', origin: 'route', principal: 'owner' }, fn);

const mail = () => ({
  account: 'a@b.test', uid: '1', from: 'x@y.test',
  body: 'plain', htmlBody: '<p onclick="alert(1)">hi<script>alert(2)</script></p>',
});

// --- the read path's render mode (move 6) ---------------------------------

test('the read path sanitizes by default, so a consumer opts OUT of safety', () => {
  const [out] = emailEngine.renderRows([mail()], {});
  assert.doesNotMatch(out.htmlBody, /alert/);
  assert.match(out.htmlBody, /hi/);
});

test('an empty options object and no options at all mean the same thing', () => {
  const [a] = emailEngine.renderRows([mail()]);
  const [b] = emailEngine.renderRows([mail()], {});
  assert.equal(a.htmlBody, b.htmlBody);
  assert.doesNotMatch(a.htmlBody, /alert/);
});

test('blocked remote images are reported on the row, so a renderer can offer "show images"', () => {
  const [blocked] = emailEngine.renderRows([{ htmlBody: '<img src="https://t.test/p.gif">' }], {});
  assert.equal(blocked.htmlBlockedImages, true);
  const [allowed] = emailEngine.renderRows([{ htmlBody: '<img src="https://t.test/p.gif">' }], { allowImages: true });
  assert.equal(allowed.htmlBlockedImages, undefined);
  assert.match(allowed.htmlBody, /t\.test/);
});

test('text mode drops htmlBody and fills body from it', () => {
  const [out] = emailEngine.renderRows([{ body: '', htmlBody: '<p>Hello <b>there</b></p>' }], { html: 'text' });
  assert.equal(out.htmlBody, undefined);
  assert.match(out.body, /Hello/);
});

test('raw is passthrough and an unknown mode is refused rather than guessed', () => {
  const row = mail();
  assert.equal(emailEngine.renderRows([row], { html: 'raw' })[0], row);
  assert.throws(() => emailEngine.renderRows([row], { html: 'unsafe' }), /unknown html mode/);
  assert.throws(() => emailEngine.renderRows([row], { html: 'sanitised' }), /unknown html mode/);
});

test('a user-facing caller may not ask for raw html at all', () => {
  asUser(() => {
    assert.throws(() => emailEngine.renderRows([mail()], { html: 'raw' }), /raw html is not available/);
  });
  asOwner(() => {
    assert.doesNotThrow(() => emailEngine.renderRows([mail()], { html: 'raw' }));
  });
});

test('a user-facing caller still gets a body — the refusal is of raw, not of reading', () => {
  asUser(() => {
    const [out] = emailEngine.renderRows([mail()], {});
    assert.match(out.htmlBody, /hi/);
    assert.doesNotMatch(out.htmlBody, /alert/);
  });
});

// --- inline image rewriting on the read path -------------------------------
//
// The base an app hands in becomes an attribute value in a document the
// sanitiser otherwise guarantees. Refusing a bad one belongs on the engine
// method, because that is what ctx, the Bridge and semantic search all reach.

const inlineMail = () => ({
  account: 'a@b.test', uid: '1',
  htmlBody: '<img src="cid:logo" alt="logo">',
  attachments: [{ id: '3', contentId: 'logo', inline: true, filename: 'logo.png' }],
});

test('the read path rewrites inline images only when a base is given', () => {
  const [plain] = emailEngine.renderRows([inlineMail()], {});
  assert.match(plain.htmlBody, /src="cid:logo"/);
  assert.equal(plain.htmlInlineImages, undefined);

  const [rewritten] = emailEngine.renderRows([inlineMail()], { inlineImageBase: '/apps/x/att/' });
  assert.match(rewritten.htmlBody, /src="\/apps\/x\/att\/3"/);
  assert.equal(rewritten.htmlInlineImages, 1);
});

test('a base that is not an absolute path or an http(s) URL is refused before anything renders', () => {
  for (const base of ['javascript:alert(1)//', 'data:text/html,x', '//evil.test/', 'apps/x/', 'vbscript:x', '/a b/']) {
    assert.throws(
      () => emailEngine.renderRows([inlineMail()], { inlineImageBase: base }),
      /inlineImageBase must be/,
      `accepted: ${base}`,
    );
  }
  for (const base of ['/apps/x/att/', 'https://host.test/att/', 'http://host.test/att/']) {
    assert.doesNotThrow(() => emailEngine.renderRows([inlineMail()], { inlineImageBase: base }), `refused: ${base}`);
  }
});

test('an unresolved cid is reported rather than silently rendering as alt text', () => {
  const row = inlineMail();
  row.attachments = [];  // mail synced before Content-IDs were captured
  const [out] = emailEngine.renderRows([row], { inlineImageBase: '/apps/x/att/' });
  assert.match(out.htmlBody, /src="cid:logo"/);
  assert.equal(out.htmlInlineImagesUnresolved, 1);
});

// --- permanent delete (move 4) --------------------------------------------

test('permanent delete is refused to an app user before any query runs', async () => {
  await asUser(async () => {
    await assert.rejects(
      emailEngine.assertPurgeable('a@b.test', ['1'], { source: 'bridge' }),
      /not available to app users/,
    );
  });
});

test('the delete sweep re-enters the guard and must not be re-judged', async () => {
  // The owner already authorised this delete; the sweep is the engine
  // finishing it. It resolves with no database because it returns first.
  await asUser(async () => {
    await emailEngine.assertPurgeable('a@b.test', ['1'], { source: 'sweep' });
    await emailEngine.assertPurgeable('a@b.test', ['1'], { source: 'sync' });
  });
});

test('Trash and Spam are the only folders a purge may empty', () => {
  for (const f of ['trash', 'spam', 'junk', '[gmail]/trash', '[gmail]/spam']) {
    assert.ok(emailEngine.PURGEABLE_FOLDERS.has(f), `${f} should be purgeable`);
  }
  for (const f of ['inbox', 'sent', 'archive', 'drafts', '[gmail]/all mail']) {
    assert.ok(!emailEngine.PURGEABLE_FOLDERS.has(f), `${f} must not be purgeable`);
  }
});

// --- calendar (move 5) -----------------------------------------------------

test('choosing which calendars sync is owner-only', async () => {
  await asUser(async () => {
    await assert.rejects(
      calendarEngine.selectCalendars({ account: 'a@b.test', calendarIds: ['primary'] }),
      /owner-only/,
    );
  });
});

test('an app user must name the account they mean — no account reads every mirror', async () => {
  await asUser(async () => {
    await assert.rejects(calendarEngine.listEvents({}), /explicit account is required/);
  });
});

test('the account requirement is a user-facing rule, not a general one', async () => {
  // The owner reading their own whole calendar is the normal case; it fails
  // here only for want of a database, which is a different error entirely.
  await asOwner(async () => {
    await calendarEngine.listEvents({}).then(
      () => {},
      (err) => assert.doesNotMatch(String(err.message), /explicit account is required/),
    );
  });
});
