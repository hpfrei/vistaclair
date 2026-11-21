#!/usr/bin/env node
// Change requests, from inside a change session.
//
//   node ../../platform/scripts/app-change.js request --to <app> \
//        --prompt-file .vistaclair/change-request-<app>.md \
//        (--tool <name> | --event <kind>) [--adds a,b] --reason "<one line>"
//   node ../../platform/scripts/app-change.js request --to platform \
//        --prompt-file .vistaclair/change-request-platform.md \
//        (--method <bridge.method> | --ctx <member.path>) [--capability <key>] \
//        [--adds a,b] --reason "<one line>"
//   node ../../platform/scripts/app-change.js done --id <id> --summary "<one line>"
//   node ../../platform/scripts/app-change.js status|wait|cancel --id <id>
//   node ../../platform/scripts/app-change.js depend --on <app> --tools a,b --why "<one line>"
//
// `depend` declares that this app calls another app's tools (expose: 'apps'):
// an approved dependency edge, shown in Setup → Tools & Access. A call with no
// edge is flagged as undeclared, or refused when the owner enforces edges. A
// change request that reaches done records the edge by itself.
//
// `--to platform` asks the PLATFORM for a capability it does not provide yet;
// the owner opens a session on the platform repository instead of on an app.
// Only an app change tab may ask; `done` is reported by the target session,
// which for a platform request is the pro tab the owner opened.
//
// Run `request` with run_in_background: true. The owner approves or denies in
// the dashboard; this process long-polls the platform until the request reaches
// a terminal state and prints the outcome, which reaches the session as a task
// notification. Losing this process is survivable: the platform delivers the
// outcome to the session's tab instead.
//
// Exit codes: 0 done, 2 denied, 3 ended or cancelled, 4 unusable (not in a
// change tab, bad arguments, the platform stayed unreachable), 5 done but
// unverified (the target reported done; the platform's check did not find it).
const http = require('http');
const fs = require('fs');

const POLL_MS = 60000;
const BACKOFF_MS = [5000, 10000, 20000, 30000];
const DEFAULT_MAX_HOURS = 8;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function fail(msg, code = 4) {
  console.error(msg);
  process.exit(code);
}

const env = {
  port: process.env.VISTACLAIR_DASHBOARD_PORT,
  token: process.env.VISTACLAIR_AUTH_TOKEN,
  instanceId: process.env.VISTACLAIR_INSTANCE_ID,
};

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      hostname: '127.0.0.1',
      port: parseInt(env.port, 10),
      path,
      method,
      headers: {
        'x-vistaclair-internal': env.token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
      timeout: POLL_MS + 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    r.on('timeout', () => r.destroy(new Error('request timed out')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'denied', 'ended', 'cancelled']);
const CODES = { done: 0, denied: 2, ended: 3, cancelled: 3 };
const UNVERIFIED_CODE = 5;

// `outcome` is absent on a server that predates it; `verified: false` is not.
function unverified(result) {
  return result.state === 'done' && (result.outcome === 'unverified' || result.verified === false);
}

function report(result) {
  const outcome = result.state === 'done' ? (unverified(result) ? 'unverified' : 'verified') : null;
  console.log(result.text || `Change request ${result.id}: ${outcome === 'unverified' ? 'done, but UNVERIFIED' : result.state}.`);
  console.log(JSON.stringify({ id: result.id, state: result.state, outcome, verified: result.verified, verifyDetail: result.verifyDetail || undefined }));
  if (outcome === 'unverified') process.exit(UNVERIFIED_CODE);
  process.exit(CODES[result.state] !== undefined ? CODES[result.state] : 4);
}

// Long-poll until the request is decided AND finished. Connection errors are a
// dashboard restart, not an answer: back off and keep asking until --max-hours.
async function pollUntilTerminal(id, maxHours) {
  const deadline = Date.now() + maxHours * 3600000;
  let attempt = 0;
  let lastNote = null;
  while (Date.now() < deadline) {
    let res;
    try {
      res = await req('GET', `/pro/apps/change-requests/${encodeURIComponent(id)}/wait?timeoutMs=${POLL_MS}`);
      attempt = 0;
    } catch {
      const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      await sleep(wait);
      continue;
    }
    if (res.status !== 200 || !res.json) {
      await sleep(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
      continue;
    }
    if (res.json.state === 'unknown') fail(`change request ${id} is unknown to the platform`, 4);
    if (TERMINAL.has(res.json.state)) report(res.json);
    // The target is busy: say what is happening once per change, so the session
    // is not left guessing why nothing started.
    if (res.json.note && res.json.note !== lastNote) { lastNote = res.json.note; console.log(res.json.note); }
  }
  fail(`change request ${id} was still open after ${maxHours}h — check the dashboard, or run: app-change.js status --id ${id}`, 4);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || args.help) {
    console.log('usage: app-change.js request --to <app> --prompt-file <file> (--tool <name>|--event <kind>) [--adds <p1,p2>] --reason <text> [--no-wait] [--max-hours 8]');
    console.log('       app-change.js request --to platform --prompt-file <file> (--method <bridge.method>|--ctx <member.path>) [--capability <key>] [--adds <p1,p2>] --reason <text>');
    console.log('       app-change.js done --id <id> --summary <text>');
    console.log('       app-change.js status|wait|cancel --id <id>');
    console.log('       app-change.js depend --on <app> --tools <t1,t2|*> --why <text>');
    process.exit(cmd ? 0 : 4);
  }
  if (!env.port || !env.token || !env.instanceId) {
    fail('app-change.js must run inside an app change session (VISTACLAIR_DASHBOARD_PORT / _AUTH_TOKEN / _INSTANCE_ID are not set).', 4);
  }

  if (cmd === 'request') {
    if (!args.to || args.to === true) fail('--to <app> (or --to platform) is required', 4);
    // The platform is asked for a bridge method or a ctx member; an app for a
    // tool or a bus kind. Naming the wrong one for the target is an argument
    // error, caught here rather than by the platform.
    const val = (k) => (args[k] && args[k] !== true ? String(args[k]) : null);
    const iface = args.to === 'platform'
      ? (val('method') ? { kind: 'method', name: val('method') }
        : (val('ctx') ? { kind: 'ctx', name: val('ctx') } : null))
      : (val('tool') ? { kind: 'tool', name: val('tool') }
        : (val('event') ? { kind: 'event', name: val('event') } : null));
    if (!iface) {
      fail(args.to === 'platform'
        ? 'name the platform interface you need: --method <bridge.method> or --ctx <member.path>'
        : 'name the interface you need: --tool <name> or --event <kind>', 4);
    }
    let prompt = '';
    if (args['prompt-file'] && args['prompt-file'] !== true) {
      try { prompt = fs.readFileSync(args['prompt-file'], 'utf8'); }
      catch (err) { fail(`cannot read --prompt-file: ${err.message}`, 4); }
    } else if (args.prompt && args.prompt !== true) {
      prompt = args.prompt;
    }
    if (!prompt.trim()) fail('--prompt-file <file> (or --prompt <text>) is required and must not be empty', 4);
    if (args.schema && args.schema !== true) iface.schema = args.schema;
    // What is missing. Names the parameters (or payload fields) the request
    // needs, so the platform can check a change to an interface that ALREADY
    // exists — without them, "the tool exists" is all it could ever prove.
    const adds = args.adds && args.adds !== true
      ? String(args.adds).split(',').map((x) => x.trim()).filter(Boolean)
      : [];

    const willWait = args['no-wait'] !== true;
    let res;
    try {
      res = await req('POST', '/pro/apps/change-requests', {
        instanceId: env.instanceId,
        to: args.to,
        adds,
        prompt,
        interface: iface,
        capability: val('capability'),
        reason: args.reason && args.reason !== true ? args.reason : '',
        wait: willWait,
      });
    } catch (err) {
      fail(`cannot reach the platform: ${err.message}`, 4);
    }
    if (res.status !== 200 || !res.json?.id) fail(res.json?.error || `request refused (HTTP ${res.status})`, 4);

    const id = res.json.id;
    const target = args.to === 'platform'
      ? `the platform${res.json.capability ? ` (capability "${res.json.capability}")` : ''}`
      : `"${args.to}"`;
    console.log(`Change request ${id} submitted: asking the owner to open a change session on ${target} for the ${iface.kind} "${iface.name}".`);
    if (res.json.targetBusy) {
      console.log(res.json.note || `${target} has a change session open — the owner is offered to inject this request into it, or queue it until it closes.`);
    }
    if (!willWait) {
      console.log(`Not waiting (--no-wait). The outcome will reach this tab when it arrives.`);
      process.exit(0);
    }
    console.log('Waiting for the owner and for the change to be reported...');
    const maxHours = parseFloat(args['max-hours']) || DEFAULT_MAX_HOURS;
    await pollUntilTerminal(id, maxHours);
    return;
  }

  if (cmd === 'done') {
    const id = args.id && args.id !== true ? args.id : 'latest';
    if (!args.summary || args.summary === true) fail('--summary "<one line: what is exported and how to call it>" is required', 4);
    let res;
    try {
      res = await req('POST', `/pro/apps/change-requests/${encodeURIComponent(id)}/done`, {
        instanceId: env.instanceId,
        summary: args.summary,
      });
    } catch (err) {
      fail(`cannot reach the platform: ${err.message}`, 4);
    }
    if (res.status !== 200) fail(res.json?.error || `refused (HTTP ${res.status})`, 4);
    if (res.json.to === 'platform') {
      // A platform change is checked against the source, not a running surface:
      // the control room still serves the old one until the owner restarts it.
      console.log(res.json.verified
        ? `Reported done. The platform re-read the capability module and its API-reference section and told the requesting session. It takes effect at the next control-room restart — the owner's call, never yours.`
        : `Reported done, but UNVERIFIED: the check did NOT find the change in the capability module or its API-reference section: ${res.json.verifyDetail || 'not found'}. Fix that here, then tell the owner. The requesting session was told the same.`);
    } else {
      console.log(res.json.verified
        ? `Reported done. The platform verified the interface is live and told the requesting session.`
        : `Reported done, but UNVERIFIED: the platform could NOT see the interface (${res.json.verifyDetail || 'not found'}) — restart this app, then tell the owner. The requesting session was told the same.`);
    }
    process.exit(0);
  }

  if (cmd === 'status' || cmd === 'wait') {
    const id = args.id && args.id !== true ? args.id : fail('--id <id> is required', 4);
    if (cmd === 'status') {
      const res = await req('GET', `/pro/apps/change-requests/${encodeURIComponent(id)}`);
      if (res.status !== 200 || !res.json) fail(`cannot read request ${id} (HTTP ${res.status})`, 4);
      if (res.json.state === 'unknown') fail(`change request ${id} is unknown to the platform`, 4);
      if (TERMINAL.has(res.json.state)) report(res.json);
      console.log(`Change request ${id} is ${res.json.state}.${res.json.note ? ` ${res.json.note}` : ''}`);
      process.exit(0);
    }
    await pollUntilTerminal(id, parseFloat(args['max-hours']) || DEFAULT_MAX_HOURS);
    return;
  }

  if (cmd === 'cancel') {
    const id = args.id && args.id !== true ? args.id : fail('--id <id> is required', 4);
    const res = await req('POST', `/pro/apps/change-requests/${encodeURIComponent(id)}/cancel`, { instanceId: env.instanceId });
    if (res.status !== 200) fail(res.json?.error || `refused (HTTP ${res.status})`, 4);
    console.log(`Change request ${id} cancelled.`);
    process.exit(0);
  }

  if (cmd === 'depend') {
    const val = (k) => (args[k] && args[k] !== true ? String(args[k]) : null);
    if (!val('on')) fail('--on <app> is required', 4);
    if (!val('tools')) fail('--tools <t1,t2> (or --tools "*") is required', 4);
    if (!val('why')) fail('--why "<one line: what this app uses them for>" is required', 4);
    let res;
    try {
      res = await req('POST', '/pro/apps/deps/depend', {
        instanceId: env.instanceId,
        on: val('on'),
        tools: val('tools').split(',').map((x) => x.trim()).filter(Boolean),
        why: val('why'),
      });
    } catch (err) {
      fail(`cannot reach the platform: ${err.message}`, 4);
    }
    if (res.status !== 200 || !res.json?.edge) fail(res.json?.error || `refused (HTTP ${res.status})`, 4);
    const e = res.json.edge;
    console.log(`Dependency recorded: ${e.consumer} → ${e.provider} (${e.tools.join(', ')}). Calls to these tools are declared; keep to the contract in .vistaclair/apps/${e.provider}.md.`);
    console.log(JSON.stringify({ id: e.id, consumer: e.consumer, provider: e.provider, tools: e.tools, status: e.status }));
    process.exit(0);
  }

  fail(`unknown command "${cmd}" — use request, done, status, wait, cancel or depend`, 4);
}

main().catch((err) => fail(`app-change.js failed: ${err.message}`, 4));
