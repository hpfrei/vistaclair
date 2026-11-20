// A governed Telegram message may now carry a file.
//
// The `telegram.send` kind used to be text-only, which meant an app tool had to
// exist purely to push bytes at a chat outside governance. The field closes
// that gap, so these tests cover both halves: what the kind will accept, and
// where the launcher actually routes each media type.
const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../src/apps/capabilities');
const platformHorst = require('../src/apps/platform-horst');
const telegram = require('../src/apps/telegram');

const kind = capabilities.horstKinds()['telegram.send'];

test('the kind still exists, still outward-facing, still pinned to propose', () => {
  assert.equal(kind.ceiling, 'propose');
  assert.equal(kind.defaultLevel, 'propose');
});

test('text alone is still a complete message', () => {
  assert.doesNotThrow(() => kind.validate({ chatId: 7, text: 'hi' }));
});

test('a file alone is a complete message — Telegram renders the text as a caption', () => {
  assert.doesNotThrow(() => kind.validate({ chatId: 7, media: { type: 'document', data: 'AAAA', filename: 'r.pdf' } }));
  assert.throws(() => kind.validate({ chatId: 7 }), /text/);
});

test('media must name a type the platform actually sends', () => {
  assert.throws(() => kind.validate({ chatId: 7, media: { type: 'video', data: 'AAAA' } }), /media\.type/);
  for (const type of ['photo', 'document', 'audio']) {
    assert.doesNotThrow(() => kind.validate({ chatId: 7, media: { type, data: 'AAAA' } }));
  }
});

test('media without bytes or a reference is not a file', () => {
  assert.throws(() => kind.validate({ chatId: 7, media: { type: 'document', filename: 'x' } }), /data or ref/);
  assert.doesNotThrow(() => kind.validate({ chatId: 7, media: { type: 'document', ref: 'https://x.test/a.pdf' } }));
});

test('an oversized payload is refused before it is decoded', () => {
  // 4 base64 chars per 3 bytes — the check reads the length, it does not
  // allocate 50 MB to find out the answer.
  const huge = 'A'.repeat(80 * 1024 * 1024);
  assert.throws(() => kind.validate({ chatId: 7, media: { type: 'document', data: huge } }), /50 MB/);
});

test('a filename may not smuggle a path or a header break', () => {
  for (const filename of ['../../etc/passwd', 'a\r\nContent-Type: x', 'dir/file.pdf']) {
    assert.throws(() => kind.validate({ chatId: 7, media: { type: 'document', data: 'AAAA', filename } }), /filename/);
  }
  assert.doesNotThrow(() => kind.validate({ chatId: 7, media: { type: 'document', data: 'AAAA', filename: 'report 2026.pdf' } }));
});

test('the approval card says a file is attached, because that is what the human is approving', () => {
  const text = kind.describe({ chatId: 7, text: 'here you go', media: { type: 'document', filename: 'report.pdf', data: 'AAAA' } });
  assert.match(text, /report\.pdf/);
  assert.match(text, /document/);
  assert.doesNotMatch(kind.describe({ chatId: 7, text: 'plain' }), /document/);
});

// --- launcher routing ------------------------------------------------------

function capture(fn) {
  const calls = [];
  const originals = {};
  for (const name of ['sendPhoto', 'sendAudio', 'sendDocument']) {
    originals[name] = telegram[name];
    telegram[name] = async (app, args) => { calls.push({ name, app, args }); return { ok: true }; };
  }
  // `call` is (appName, method, params) — the raw Bot API escape hatch, used
  // both for a media reference and by sendControlMessage for the text itself.
  originals.call = telegram.call;
  telegram.call = async (app, method, params) => { calls.push({ name: 'call', app, method, args: params }); return { ok: true, message_id: 1 }; };
  return fn(calls).finally(() => { for (const [name, orig] of Object.entries(originals)) telegram[name] = orig; });
}

test('each media type reaches its own Telegram method, on the control bot', async () => {
  await capture(async (calls) => {
    for (const [type, method] of [['photo', 'sendPhoto'], ['audio', 'sendAudio'], ['document', 'sendDocument']]) {
      await platformHorst.sendControlPayload({ chatId: 5, text: 'cap', media: { type, data: Buffer.from('x').toString('base64') } });
      const last = calls[calls.length - 1];
      assert.equal(last.name, method, `${type} went to ${last.name}`);
      assert.equal(last.app, '__platform__');
      assert.equal(last.args.caption, 'cap');
      assert.ok(Buffer.isBuffer(last.args.photo || last.args.audio || last.args.document), 'bytes should be decoded');
    }
  });
});

test('a reference is passed through as-is — Telegram fetches it, we do not', async () => {
  await capture(async (calls) => {
    await platformHorst.sendControlPayload({ chatId: 5, media: { type: 'document', ref: 'https://x.test/a.pdf' } });
    assert.equal(calls[0].name, 'call');
    assert.equal(calls[0].method, 'sendDocument');
    assert.equal(calls[0].args.document, 'https://x.test/a.pdf');
    assert.equal(calls[0].args.chat_id, 5);
  });
});

test('text too long for a caption follows the file instead of being cut', async () => {
  await capture(async (calls) => {
    const long = 'x'.repeat(1500);
    await platformHorst.sendControlPayload({ chatId: 5, text: long, media: { type: 'document', data: 'AAAA' } });
    assert.equal(calls[0].args.caption, undefined, 'an over-long caption must not be sent as one');
    assert.ok(calls.some((c) => c.method === 'sendMessage' && String(c.args.text || '').includes('xxx')), 'the text must still arrive');
  });
});
