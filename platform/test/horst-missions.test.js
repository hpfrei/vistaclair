// The mission review ritual after phase 8F removed the work stack.
//
// The review used to be a P2 work item whose __mission_review__ step ran in
// horst-cognition. It is one AI call plus judgment, so it now runs from
// horst-missions itself, off the heartbeat's sweep. Two things had to survive
// that move and are pinned here: a follow-up must reach the OWNER (a
// governance request at their dial) rather than a queue nothing drained, and a
// review must not be able to run twice for one mission.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const missions = require('../src/apps/agent/horst-missions');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-missions-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// `update` deliberately will not move the review clock — the cadence is the
// knob the owner has. Reaching into the store is how a review is forced.
function backdate(id) {
  const file = path.join(dir, 'missions.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  d.items.find((x) => x.id === id).nextReviewAt = Date.now() - 1000;
  fs.writeFileSync(file, JSON.stringify(d));
}

// Everything past the store is injected, so the ritual runs with no AI, no
// governance store and no platform boot.
function wire({ json, onRequest, hold } = {}) {
  const requests = [];
  const notices = [];
  missions.init({
    dir,
    broadcaster: { broadcast() {} },
    appsDir: dir,
    fmtDirectives: () => 'None.',
    notify: (text) => notices.push(text),
    addObservation: () => {},
    governance: {
      requestAction: async (kind, payload, meta) => {
        requests.push({ kind, payload, meta });
        return onRequest ? onRequest(kind, payload, meta) : { mode: 'proposed' };
      },
    },
    aiPrompt: async () => {
      if (hold) await hold;
      return { json };
    },
  });
  return { requests, notices };
}

test('a due review runs from the sweep, logs progress and puts its follow-ups in front of the owner', async () => {
  const { requests, notices } = wire({
    json: {
      assessment: 'Two months in, nothing has moved.',
      progressNote: 'no movement since May',
      health: 'stalled',
      tasks: [{ title: 'Draft the outline', why: 'unblocks everything else' }],
      questions: ['Do you still want this?'],
    },
  });
  const m = missions.create({ title: 'Write the book', goal: 'Finish a draft', origin: 'user', status: 'active' });
  backdate(m.id);

  const due = missions.sweepReviews();
  assert.ok(due.some((x) => x.id === m.id), 'the sweep is still what decides a review is due');
  const res = await missions.runReview(m);

  assert.equal(res.health, 'stalled');
  assert.deepEqual(res.proposed, ['Draft the outline']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].kind, 'todo.create', 'a follow-up is a todo the owner decides on, not a work item');
  assert.equal(requests[0].meta.checkFirst, true, 'governance may suppress one it already answered — the dedup the stack used to do');
  assert.match(requests[0].meta.dedupeKey, new RegExp(`^mission:${m.id}:`));

  assert.match(missions.get(m.id).progress[0].note, /review \(stalled\)/);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Mission review — Write the book/);
  assert.match(notices[0], /waiting in Approvals/);
  assert.match(notices[0], /❓ Do you still want this\?/, 'a doubt is said out loud, never swallowed');
});

test('a suppressed follow-up is not reported as one', async () => {
  const { requests } = wire({
    json: { assessment: 'fine', health: 'on-track', tasks: [{ title: 'Already asked' }] },
    onRequest: () => ({ mode: 'suppressed', reason: 'decided before' }),
  });
  const m = missions.create({ title: 'Tidy up', goal: 'Keep it tidy', origin: 'horst', status: 'active' });
  const res = await missions.runReview(m);
  assert.equal(requests.length, 1);
  assert.deepEqual(res.proposed, [], 'nothing new reached the owner, so nothing is claimed');
});

test('one mission cannot be reviewed twice at once, and a review only runs on an active mission', async () => {
  let release;
  const hold = new Promise((r) => { release = r; });
  wire({ json: { assessment: 'ok', health: 'on-track', tasks: [] }, hold });
  const m = missions.create({ title: 'Concurrent', goal: 'g', origin: 'seed', status: 'active' });

  const first = missions.runReview(m);
  const second = await missions.runReview(m); // the heartbeat fired again mid-review
  assert.deepEqual(second, { skipped: 'already running' });
  release();
  assert.equal((await first).health, 'on-track');

  missions.setStatus(m.id, 'paused');
  assert.deepEqual(await missions.runReview(m), { skipped: 'mission is paused' });
  assert.deepEqual(await missions.runReview('mi-nope'), { skipped: 'mission gone' });
});
