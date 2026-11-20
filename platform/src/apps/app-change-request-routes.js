// Routes of the cross-app change requests (src/apps/app-change-requests.js),
// called by scripts/app-change.js from inside an app change tab.
//
// Callers after core's auth: the owner (cookie / owner token) has no
// req.vcSession and names the instance in the body; a session carries its
// per-session token and core's gate sets req.vcSession = { instanceId, scopes }.
// A session acts only as itself, and on an existing request only from its side:
//   status, wait   the sender or the target
//   cancel         the sender
//   done           the target
// anyone else gets 403 (docs/change-requests.md "Who may act").
const changeRequests = require('./app-change-requests');
const appDeps = require('./app-deps');

// Who is calling. A session caller (core's gate set req.vcSession from its
// token) acts only as itself: its instance id is the token's, and a different
// one in the body is refused. An owner caller (no req.vcSession) names the
// instance in the body, as before. → the instance id, or null after a 403.
function actor(req, res) {
  const named = (req.body || {}).instanceId;
  if (!req.vcSession) return named;
  if (named !== undefined && named !== null && named !== req.vcSession.instanceId) {
    res.status(403).json({ error: 'this session may only act as itself' });
    return null;
  }
  return req.vcSession.instanceId;
}

// A session caller touches an existing request only from the side the action
// belongs to (`sides`: 'sender' and/or 'target'); anyone else gets 403. An
// owner caller is not restricted, an unknown id falls through to the module.
function allowed(req, res, id, sides, verb) {
  if (!req.vcSession) return true;
  const rec = changeRequests._internals.byId(id);
  if (!rec) return true;
  const party = changeRequests.partyOf(req.vcSession.instanceId, rec);
  if (sides.some((side) => party[side])) return true;
  res.status(403).json({ error: `this session is not the ${sides.join(' or ')} of change request ${id}, so it may not ${verb} it` });
  return false;
}

function mountApi(router, express) {
  const crJson = express.json({ limit: '256kb' });

  router.post('/pro/apps/change-requests', crJson, (req, res) => {
    const b = req.body || {};
    const instanceId = actor(req, res);
    if (instanceId === null) return;
    const result = changeRequests.request({
      instanceId,
      to: b.to,
      prompt: b.prompt,
      interface: b.interface,
      capability: b.capability,
      adds: b.adds,
      reason: b.reason,
      wait: b.wait !== false,
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // The connection closing is passed on: a poll whose script died must not be
  // counted as having received the outcome.
  router.get('/pro/apps/change-requests/:id/wait', async (req, res) => {
    if (!allowed(req, res, req.params.id, ['sender', 'target'], 'wait on')) return;
    try {
      const result = await changeRequests.wait(req.params.id, req.query.timeoutMs, {
        onClose: (fn) => res.on('close', () => { if (!res.writableEnded) fn(); }),
      });
      if (!res.writableEnded && !res.destroyed) res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/pro/apps/change-requests/:id', (req, res) => {
    if (!allowed(req, res, req.params.id, ['sender', 'target'], 'read')) return;
    res.json(changeRequests.status(req.params.id));
  });

  router.post('/pro/apps/change-requests/:id/done', crJson, (req, res) => {
    const instanceId = actor(req, res);
    if (instanceId === null) return;
    if (req.params.id !== 'latest' && !allowed(req, res, req.params.id, ['target'], 'report done on')) return;
    const result = changeRequests.done({
      instanceId,
      id: req.params.id === 'latest' ? null : req.params.id,
      summary: (req.body || {}).summary,
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  router.post('/pro/apps/change-requests/:id/cancel', crJson, (req, res) => {
    if (actor(req, res) === null) return;
    if (!allowed(req, res, req.params.id, ['sender'], 'cancel')) return;
    const result = changeRequests.cancel(req.params.id, 'session');
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // `app-change.js depend`: the calling app declares a dependency on another
  // app's tools (src/apps/app-deps.js), identified like `request`.
  router.post('/pro/apps/deps/depend', crJson, (req, res) => {
    const b = req.body || {};
    const instanceId = actor(req, res);
    if (instanceId === null) return;
    const result = appDeps.depend({ instanceId, on: b.on, tools: b.tools, why: b.why });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });
}

module.exports = { mountApi };
