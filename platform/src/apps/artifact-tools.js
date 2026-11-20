// Artifact tools for orchestration agents — built-in tools of a broker holder
// session (an orchestrator's `app-tools` catalog or a worker's `apps` grant
// server), so an agent can read what an app tool handed it by reference and
// hand a file of its own to an app tool. docs/tool-jobs-artifacts.md "Artifacts".
//
// Exports `builtinTools`: [{ name, description, inputSchema, when(session),
// handler(args, session) → MCP result }]. mcp-broker.js registers them; the
// session is the broker session record, `session.holder` = { type, runId,
// address, instanceId, workerId?, orchestrator?, cwd? }. The run is the
// principal: any orchestrator or worker of the run reads what the run was
// granted. Files move only inside `holder.cwd`.

const artifacts = require('./app-artifacts');

const HOLDER_TYPES = new Set(['orchestrator', 'worker']);
const REF_NOTE = 'A vc-artifact:// uri passed in another tool\'s arguments grants that tool\'s app read access automatically.';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

function runOf(session) {
  const h = session && session.holder;
  return h && HOLDER_TYPES.has(h.type) && h.runId ? { type: 'run', runId: String(h.runId) } : null;
}

function readable(session, uri) {
  const run = runOf(session);
  if (!run) return { error: 'This session does not belong to an orchestration run.' };
  const rec = artifacts.get(uri);
  if (!rec || !artifacts.canRead(run, uri)) return { error: `Unknown artifact or no read access for this run: ${uri}` };
  return { run, rec };
}

function publicRecord(rec) {
  const { grants, pins, link, ...out } = rec;
  return out;
}

const builtinTools = [
  {
    name: 'artifact_info',
    description: `Describe a vc-artifact:// file reference an app tool returned: name, mime type, size, sha256, producer, creation time. ${REF_NOTE}`,
    inputSchema: { type: 'object', properties: { uri: { type: 'string', description: 'vc-artifact://art_… uri' } }, required: ['uri'] },
    when: (session) => !!runOf(session),
    handler: async (args, session) => {
      const r = readable(session, args && args.uri);
      return r.error ? fail(r.error) : text(publicRecord(r.rec));
    },
  },
  {
    name: 'artifact_fetch',
    description: `Copy a vc-artifact:// file into your working directory at a relative path. ${REF_NOTE}`,
    inputSchema: { type: 'object', properties: {
      uri: { type: 'string', description: 'vc-artifact://art_… uri' },
      dest: { type: 'string', description: 'Destination path relative to your working directory, e.g. "out/model.glb".' },
    }, required: ['uri', 'dest'] },
    when: (session) => !!runOf(session),
    handler: async (args, session) => {
      const cwd = session && session.holder && session.holder.cwd;
      if (!cwd) return fail('Your working directory is unknown to the platform, so nothing can be copied into it.');
      const r = readable(session, args && args.uri);
      if (r.error) return fail(r.error);
      try {
        const out = artifacts.copyTo(args.uri, cwd, String((args && args.dest) || ''), r.run);
        return text({ uri: r.rec.uri, path: out.path, size: out.size, mime: out.mime, sha256: out.sha256 });
      } catch (err) { return fail(err.message); }
    },
  },
  {
    name: 'artifact_put',
    description: `Make a vc-artifact:// reference from a file in your working directory, readable by your run, to pass to an app tool by uri. ${REF_NOTE}`,
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'File path relative to your working directory.' },
      mime: { type: 'string', description: 'MIME type (guessed from the extension when omitted).' },
      name: { type: 'string', description: 'Display name (default: the file name).' },
    }, required: ['path'] },
    when: (session) => !!runOf(session),
    handler: async (args, session) => {
      const run = runOf(session);
      if (!run) return fail('This session does not belong to an orchestration run.');
      const h = session.holder;
      if (!h.cwd) return fail('Your working directory is unknown to the platform, so no file can be read from it.');
      try {
        const rec = await artifacts.putFrom(h.cwd, String((args && args.path) || ''), { mime: args.mime, name: args.name }, {
          principal: run,
          producer: { run: run.runId, address: h.address || null, tool: 'artifact_put' },
        });
        return { content: [{ type: 'text', text: JSON.stringify(publicRecord(rec), null, 2) }, rec.link] };
      } catch (err) { return fail(err.message); }
    },
  },
];

module.exports = { builtinTools };
