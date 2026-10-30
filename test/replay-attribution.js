#!/usr/bin/env node
// Replays recorded sessions through src/turn-attribution.js and compares the
// owner it gives each LLM turn when its request arrives with the one the
// server stamped from Claude's transcripts afterwards (the stored `subagent`).
//
//   node test/replay-attribution.js [interactions-dir] [--sessions N] [--feedback] [-v]
//
// Events run in time order: a request is attributed at its timestamp, its
// response is noted when it finished (timestamp + duration), and SubagentStart /
// PostToolUse(Agent) hooks name the agent a call ran. Without --feedback a
// response is noted under the owner the replay guessed (nothing confirmed —
// the worst case); with it, under the stored owner, as once the transcript
// resolution lands. Read only: the recorded files are never written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TurnAttributor } = require('../src/turn-attribution');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const dir = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--sessions')
  || path.join(process.env.VISTACLAIR_HOME || path.join(os.homedir(), 'vistaclair'), 'interactions');
const maxSessions = Number(opt('--sessions', 40));
const feedback = flag('--feedback');
const verbose = flag('-v');

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(d) ? d[0] : d;
  } catch { return null; }
}

function responseContent(d) {
  const body = d.response?.body;
  if (Array.isArray(body?.content)) return body.content;
  const content = [];
  const json = new Map();
  for (const e of d.response?.sseEvents || []) {
    const idx = e.data?.index;
    if (e.eventType === 'content_block_start' && e.data?.content_block) {
      content[idx] = { ...e.data.content_block };
      if (e.data.content_block.type === 'tool_use') json.set(idx, '');
    } else if (e.eventType === 'content_block_delta') {
      const delta = e.data?.delta;
      if (delta?.type === 'text_delta' && content[idx]) content[idx].text = (content[idx].text || '') + (delta.text || '');
      else if (delta?.type === 'input_json_delta' && json.has(idx)) json.set(idx, json.get(idx) + (delta.partial_json || ''));
    } else if (e.eventType === 'content_block_stop' && json.has(idx) && content[idx]) {
      try { content[idx].input = JSON.parse(json.get(idx)); } catch {}
    }
  }
  return content.filter(Boolean);
}

function replaySession(sessDir) {
  const files = fs.readdirSync(sessDir).filter(f => /^\d+\.json$/.test(f));
  const events = [];
  const turns = [];
  // Claude Code runs a tool as soon as its tool_use block is complete, before
  // the response ends — the proxy notes the block then (content_block_stop).
  // The recording has no per-event times; the tool's PreToolUse hook bounds it.
  const preToolAt = new Map();
  for (const f of files) {
    const d = load(path.join(sessDir, f));
    if (!d || d.isMcp) continue;
    const ts = d.request?.timestamp || 0;
    if (d.isHook) {
      events.push({ at: ts, kind: 'hook', d });
      if (/PreToolUse/.test(d.hookEvent || '') && d.toolUseId && !preToolAt.has(d.toolUseId)) preToolAt.set(d.toolUseId, ts);
      continue;
    }
    if ((d.request?.endpoint || '/v1/messages') !== '/v1/messages') continue;
    turns.push(d);
  }
  for (const d of turns) {
    const ts = d.request?.timestamp || 0;
    const end = ts + (d.response?.timing?.duration || 0);
    const content = responseContent(d);
    events.push({ at: ts, kind: 'request', d });
    for (const b of content) {
      if (b.type === 'tool_use' && b.id) events.push({ at: Math.min(end, preToolAt.get(b.id) ?? end), kind: 'block', d, content: [b] });
    }
    events.push({ at: end, kind: 'response', d, content });
  }
  const order = { hook: 0, block: 1, response: 1, request: 2 };
  events.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);

  const att = new TurnAttributor();
  const guessed = new Map();
  const counts = { turns: 0, sub: 0, exact: 0, pending: 0, wrong: 0 };
  const misses = [];
  for (const { kind, d, content } of events) {
    if (kind === 'hook') {
      if (d.hookEvent === 'SubagentStart' && d.hookAgentId) att.noteSpawn(d.subagent?.toolUseId, d.hookAgentId);
      else if (/PostToolUse/.test(d.hookEvent || '') && d.toolName === 'Agent') att.noteSpawn(d.toolUseId, d.request?.tool_response?.agentId);
      continue;
    }
    const truth = d.subagent?.agentId || 'main';
    if (kind === 'request') {
      const sub = att.attribute(d.request?.messages);
      guessed.set(d.id, sub);
      const got = sub?.agentId || 'main';
      counts.turns++;
      if (truth !== 'main') counts.sub++;
      if (got === truth) counts.exact++;
      else if (got.startsWith('pending-') && got.slice(8) === d.subagent?.toolUseId) counts.pending++;
      else { counts.wrong++; misses.push(`${path.basename(sessDir)} ${d.id}: got ${got}, stored ${truth}`); }
    } else {
      const sub = feedback && kind === 'response' ? (d.subagent || null) : guessed.get(d.id);
      att.noteResponse(sub?.agentId || 'main', content, sub);
      // The confirmed owner of a guessed agent names the call that ran it.
      if (feedback && kind === 'response' && d.subagent?.toolUseId) att.noteSpawn(d.subagent.toolUseId, d.subagent.agentId);
    }
  }
  return { counts, misses };
}

const sessions = fs.readdirSync(dir)
  .map(name => path.join(dir, name))
  .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  .slice(0, maxSessions);

const total = { turns: 0, sub: 0, exact: 0, pending: 0, wrong: 0 };
for (const s of sessions) {
  const { counts, misses } = replaySession(s);
  for (const k of Object.keys(total)) total[k] += counts[k];
  if (verbose || misses.length) {
    console.log(`${path.basename(s)}: ${counts.turns} turns, ${counts.exact} exact, ${counts.pending} pending-key, ${counts.wrong} wrong`);
  }
  for (const m of misses.slice(0, 10)) console.log('  ' + m);
}
console.log(`${sessions.length} sessions (${feedback ? 'with' : 'without'} resolution feedback): ${total.turns} turns (${total.sub} subagent), `
  + `${total.exact} exact, ${total.pending} on the pending-<call> key of the right agent, ${total.wrong} wrong`);
process.exitCode = total.wrong ? 1 : 0;
