// agy-trace: decoding Cloud Code v1internal calls into Anthropic-shaped
// Inspector bodies (docs/agy-inspector.md), and the gemini.js opt-in options
// leaving the :3456 Gemini route unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.VISTACLAIR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-trace-'));

const { decodeAgyRequest, isSideCall, AgyResponseDecoder, AgyExchange, classifyPath } = require('../src/agy-trace');
const InteractionStore = require('../src/store');
const GeminiProvider = require('../src/providers/gemini');

const FIX = path.join(__dirname, 'fixtures', 'agy');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const sseLines = (txt) => txt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));

test('decodeAgyRequest: envelope → Anthropic body', () => {
  const dec = decodeAgyRequest(JSON.parse(fixture('stream-request.json')));
  assert.deepStrictEqual(dec.body, {
    model: 'gemini-3.8-flash-low',
    system: [
      { type: 'text', text: 'You are Antigravity, a coding agent.' },
      { type: 'text', text: 'Workspace: /work' },
    ],
    tools: [
      { name: 'read_file', description: 'Read a file.', input_schema: { type: 'OBJECT', properties: { AbsolutePath: { type: 'STRING' } }, required: ['AbsolutePath'] } },
      { name: 'run_command', description: 'Run a shell command.', input_schema: { type: 'OBJECT', properties: { CommandLine: { type: 'STRING' } } } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read note.txt and tell me what it says.' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'The user wants the file content. I will read it.' },
        { type: 'tool_use', id: 'read_file-1-1', name: 'read_file', input: { AbsolutePath: '/work/note.txt' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_file-1-1', content: 'hello from note' }] },
    ],
    max_tokens: 65536,
  });
  assert.strictEqual(dec.conversationId, 'daf70115-49b0-476a-ac2d-31b44d303f63');
  assert.strictEqual(dec.requestType, 'agent');
  // The rest of the envelope is kept, the decoded parts are not.
  assert.deepStrictEqual(Object.keys(dec.extras).sort(), ['model', 'project', 'request', 'requestId', 'requestType', 'userAgent']);
  assert.deepStrictEqual(Object.keys(dec.extras.request).sort(), ['generationConfig', 'labels', 'sessionId']);
});

test('decodeAgyRequest: large inline images become hash placeholders, ids are kept', () => {
  const big = Buffer.alloc(5000, 7).toString('base64');
  const dec = decodeAgyRequest({ model: 'm', request: { contents: [
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: big } }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
    { role: 'model', parts: [{ functionCall: { id: 'call-9', name: 'x', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-9', name: 'x', response: { error: 'boom' } } }] },
  ] } });
  const [img, small] = dec.body.messages[0].content;
  assert.match(img.placeholder, /^image\/jpeg, 5000 bytes, sha256:[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(dec.body).includes(big.slice(0, 100)));
  assert.deepStrictEqual(small, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.strictEqual(dec.body.messages[1].content[0].id, 'call-9');
  assert.deepStrictEqual(dec.body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'call-9', content: '{"error":"boom"}', is_error: true });
});

test('AgyResponseDecoder: SSE → thinking + text, usage with cache tokens', () => {
  const d = new AgyResponseDecoder({ sse: true });
  const txt = fixture('stream-response.sse');
  const events = [];
  // Odd splits: the decoder must not depend on chunk boundaries.
  for (let i = 0; i < txt.length; i += 37) events.push(...d.push(txt.slice(i, i + 37)));
  events.push(...d.end());
  const body = InteractionStore._reconstructBodyFromSSE(events);
  assert.deepStrictEqual(body.content, [
    { type: 'thinking', thinking: 'The file says hello.' },
    { type: 'text', text: 'It says: hello from note' },
  ]);
  assert.deepStrictEqual(d.usage(), { input_tokens: 9430 - 7281, output_tokens: 9449 - 9430, cache_read_input_tokens: 7281 });
  assert.deepStrictEqual(d.meta, { traceId: '58e4ba589c56e021', responseId: 'kjIEa87cLJahkdUP5fHTcQ', modelVersion: 'gemini-3.8-flash-n' });
  assert.strictEqual(events.filter(e => e.eventType === 'message_stop').length, 1);
});

test('AgyResponseDecoder: thought + functionCall → thinking + tool_use; plain JSON body', () => {
  const d = new AgyResponseDecoder({ sse: true });
  const ev = [...d.push(fixture('stream-response-tool.sse')), ...d.end()];
  const body = InteractionStore._reconstructBodyFromSSE(ev);
  assert.deepStrictEqual(body.content.map(b => b.type), ['thinking', 'tool_use']);
  assert.deepStrictEqual(body.content[1].input, { CommandLine: 'ls' });
  assert.deepStrictEqual(d.lastToolUse, { name: 'run_command', input: { CommandLine: 'ls' } });
  assert.deepStrictEqual(d.usage(), { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0 });

  // generateContent (no SSE): one JSON object
  const j = new AgyResponseDecoder({ sse: false });
  j.push(JSON.stringify(sseLines(fixture('stream-response.sse'))[2]));
  const body2 = InteractionStore._reconstructBodyFromSSE(j.end());
  assert.deepStrictEqual(body2.content, [{ type: 'text', text: 'hello from note' }]);
});

test('classifyPath', () => {
  assert.strictEqual(classifyPath('/v1internal:streamGenerateContent?alt=sse'), 'trace');
  assert.strictEqual(classifyPath('/v1internal:generateContent'), 'trace');
  assert.strictEqual(classifyPath('/v1internal:loadCodeAssist'), 'hook');
  assert.strictEqual(classifyPath('/v1internal:retrieveUserQuotaSummary'), 'hook');
  assert.strictEqual(classifyPath('/v1internal:fetchUserInfo'), null);
});

test('gemini.js default path (the :3456 route) is unchanged: thoughts dropped, no cache tokens', () => {
  const p = new GeminiProvider();
  const ss = p.createStreamState();
  ss.messageId = 'm';
  const out = [];
  for (const l of sseLines(fixture('stream-response.sse'))) out.push(...p.translateSSEChunk(JSON.stringify(l.response), ss));
  out.push(...p.finalizeStream(ss));
  assert.deepStrictEqual(out, [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"gemini-3.8-flash-n","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It says: "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from note"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":9430,"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  assert.strictEqual(p.finalizeStream(ss).length, 0);
});

// One Cloud Code call through the tee sink, with the recorded fixture shapes.
function runExchange(envelope, { path: p = '/v1internal:streamGenerateContent?alt=sse', sse = fixture('stream-response.sse'), lanes } = {}) {
  const store = { added: [], add(i) { this.added.push(i); }, save() {} };
  const ctx = { store, broadcaster: { broadcast() {} }, instanceId: 'w1', host: 'cloudcode-pa.googleapis.com', lanes: lanes || { main: null, pendingType: null, types: new Map() } };
  const ex = new AgyExchange(ctx, { path: p, headers: { 'content-type': 'application/json' } });
  ex.requestBody(Buffer.from(JSON.stringify(envelope)));
  ex.requestEnd();
  ex.responseHead(200, { 'content-type': 'text/event-stream' });
  ex.responseBody(Buffer.from(sse));
  ex.responseEnd();
  return { it: store.added[0], ctx };
}

test('the requested model stays the call\'s model; Google\'s modelVersion is kept apart as servedAs', () => {
  const env = JSON.parse(fixture('stream-request.json'));
  const { it } = runExchange(env);
  assert.strictEqual(it.request.model, 'gemini-3.8-flash-low');
  assert.strictEqual(it.response.body.model, 'gemini-3.8-flash-low');       // was: the modelVersion
  assert.strictEqual(it.response.meta.modelVersion, 'gemini-3.8-flash-n');
  assert.strictEqual(it.agy.servedAs, 'gemini-3.8-flash-n');
  assert.strictEqual(it.agy.requestType, 'agent');
  assert.ok(!it.agy.side && !it.subagent);
});

test('side calls: a non-agent requestType, a non-streaming call or a toolless request is its own lane and never the main lane', () => {
  const env = JSON.parse(fixture('stream-request.json'));
  assert.strictEqual(isSideCall(decodeAgyRequest(env), true), false);
  assert.strictEqual(isSideCall(decodeAgyRequest(env), false), true);
  assert.strictEqual(isSideCall(decodeAgyRequest({ ...env, requestType: 'image_gen' }), true), false);

  // A flash-lite helper call (e.g. the per-tool safety monitor) arriving first.
  const side = { model: 'gemini-3.5-flash-lite', requestId: 'monitor/aaaaaaaa-0000-4000-8000-000000000000/1', request: { contents: [{ role: 'user', parts: [{ text: 'Trajectory…' }] }] } };
  assert.strictEqual(isSideCall(decodeAgyRequest(side), true), true);
  const lanes = { main: null, pendingType: null, types: new Map() };
  const s = runExchange(side, { lanes }).it;
  assert.strictEqual(s.request.model, 'gemini-3.5-flash-lite');
  assert.strictEqual(s.agy.side, true);
  assert.strictEqual(s.subagent.agentType, 'agy-side-call');
  assert.strictEqual(lanes.main, null);
  const a = runExchange(env, { lanes }).it;                    // the agent turn is still the main lane
  assert.ok(!a.subagent);
  assert.strictEqual(lanes.main, 'daf70115-49b0-476a-ac2d-31b44d303f63');
});
