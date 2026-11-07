// Images pasted into a prompt. Claude Code's UserPromptSubmit hook carries the
// prompt text only; the transcript names the image in a meta record of the
// same promptId. The store reads it from there and stamps it on the hook, so
// the Inspector can show the screenshot that went with the prompt.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonWhenReady } = require('./wait-for');

const { imageSourcesInText, promptImagesInRecord } = require('../src/prompt-images');

function freshStore(home) {
  process.env.VISTACLAIR_HOME = home;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/capabilities')];
  const InteractionStore = require('../src/store');
  return new InteractionStore(200);
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));

const SESS = 'f0d701bb-de26-4b7f-b6eb-eddcef36827b';
const PROMPT_ID = 'bece5688-faca-44db-acfd-763afa2d3062';
const IMG = `/tmp/claude-1000/-home-hp-vistaclair/${SESS}/images/1.png`;

// The two records Claude Code 2.1 writes for a prompt with a pasted image.
const promptRecord = {
  type: 'user', promptId: PROMPT_ID, imagePasteIds: [1], sessionId: SESS,
  message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'text', text: 'screenshot shows the preview panel' },
  ] },
};
const imageMetaRecord = {
  type: 'user', promptId: PROMPT_ID, isMeta: true, sessionId: SESS,
  message: { role: 'user', content: [{ type: 'text', text: `[Image: source: ${IMG}]` }] },
};

// The hook record as server.js builds it from the payload — note: no image.
function promptHook(id) {
  const hookData = {
    session_id: SESS, transcript_path: '', prompt_id: PROMPT_ID,
    hook_event_name: 'UserPromptSubmit', prompt: 'screenshot shows the preview panel', timestamp: 1000,
  };
  return {
    id, timestamp: 1000, isHook: true, instanceId: `cli-${SESS}`, hookEvent: 'UserPromptSubmit',
    toolName: null, toolUseId: null, hookAgentId: null, request: hookData,
    response: { status: 200, body: null }, timing: { startedAt: 1000, duration: 0 },
    status: 'complete', isStreaming: false,
  };
}

const jsonl = recs => recs.map(r => JSON.stringify(r) + '\n').join('');

test('image paths are read from the [Image: source: …] text of a prompt record', () => {
  assert.deepStrictEqual(imageSourcesInText(`[Image: source: ${IMG}]`), [IMG]);
  assert.deepStrictEqual(imageSourcesInText('[Image: source: /a/1.png] and [Image: source: /a/2.jpg]'), ['/a/1.png', '/a/2.jpg']);
  assert.deepStrictEqual(imageSourcesInText('[Image #1] no source here'), []);
  assert.deepStrictEqual(promptImagesInRecord(imageMetaRecord), [IMG]);
  assert.strictEqual(promptImagesInRecord(promptRecord), null, 'the base64 block names no path');
  assert.strictEqual(promptImagesInRecord({ ...imageMetaRecord, promptId: undefined }), null);
  assert.strictEqual(promptImagesInRecord({ ...imageMetaRecord, type: 'assistant' }), null);
  assert.deepStrictEqual(promptImagesInRecord({ type: 'user', promptId: 'p', message: { content: `[Image: source: ${IMG}]` } }), [IMG]);
});

test('a prompt hook saved after its transcript records carries the pasted image', async (t) => {
  const home = tmpDir();
  const transcript = path.join(tmpDir(), `${SESS}.jsonl`);
  fs.writeFileSync(transcript, jsonl([promptRecord, imageMetaRecord]));

  const store = freshStore(home);
  t.after(() => store.forgetSession(`cli-${SESS}`, SESS));
  store.registerSession(`cli-${SESS}`, SESS);
  store.attachTraceIndex(SESS, transcript, null);

  const hook = promptHook('hook-1');
  hook.request.transcript_path = transcript;
  store.add(hook);
  store.save(hook.id);

  assert.deepStrictEqual(hook.promptImages, [IMG]);
  const onDisk = await readJsonWhenReady(path.join(home, 'interactions', SESS, '1.json'));
  assert.deepStrictEqual(onDisk.promptImages, [IMG]);
  assert.strictEqual(onDisk.request.prompt, 'screenshot shows the preview panel', 'raw payload kept as is');

  const [reloaded] = store.sessionInteractions(`cli-${SESS}`, SESS).filter(i => i.id === 'hook-1');
  assert.deepStrictEqual(reloaded.promptImages, [IMG]);
});

test('an image record landing after the hook is stamped on it and broadcast', async (t) => {
  const home = tmpDir();
  const transcript = path.join(tmpDir(), `${SESS}.jsonl`);
  fs.writeFileSync(transcript, jsonl([promptRecord]));

  const store = freshStore(home);
  t.after(() => store.forgetSession(`cli-${SESS}`, SESS));
  const sent = [];
  store.registerSession(`cli-${SESS}`, SESS);
  store.attachTraceIndex(SESS, transcript, { broadcast: m => sent.push(m) });

  const hook = promptHook('hook-2');
  store.add(hook);
  store.save(hook.id);
  assert.strictEqual(hook.promptImages, undefined);
  // The image record lands after the hook was written. The store's writes are
  // un-awaited fs.writeFile calls with no ordering between them, so wait for
  // this first one before the re-write starts — two in flight on one file can
  // land in either order.
  const file = path.join(home, 'interactions', SESS, '1.json');
  const first = await readJsonWhenReady(file, j => j.id === 'hook-2');
  assert.strictEqual(first.promptImages, undefined);

  fs.appendFileSync(transcript, jsonl([imageMetaRecord]));
  store.rescanTrace(SESS);

  assert.deepStrictEqual(hook.promptImages, [IMG]);
  assert.deepStrictEqual(sent, [{ type: 'interaction:enriched', interactionId: 'hook-2', promptImages: [IMG] }]);
  // The first save wrote the file without the image; wait for the re-write.
  const onDisk = await readJsonWhenReady(file, j => j.promptImages);
  assert.deepStrictEqual(onDisk.promptImages, [IMG]);

  // A rescan of the same lines changes nothing.
  store.rescanTrace(SESS);
  assert.strictEqual(sent.length, 1);
});
