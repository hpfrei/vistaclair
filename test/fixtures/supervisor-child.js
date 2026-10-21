// Stand-in for server.js under bin/supervisor.js (test/supervisor.test.js).
// Each start reads its behaviour from the control file FAKE_CTRL and appends a
// line to FAKE_SPAWNS, so a test can change behaviour between respawns.
const http = require('http');
const fs = require('fs');

const port = parseInt(process.env.DASHBOARD_PORT);
const mode = fs.readFileSync(process.env.FAKE_CTRL, 'utf8').trim();
fs.appendFileSync(process.env.FAKE_SPAWNS, JSON.stringify({
  pid: process.pid, mode, token: process.env.AUTH_TOKEN,
  supervised: process.env.VISTACLAIR_SUPERVISED, noOpen: process.env.NO_OPEN || null,
}) + '\n');

if (mode === 'crash') {
  console.error('BOOM: fake boot failure <script>');
  process.exit(3);
}
if (mode === 'hang-boot') {
  console.log('fake: hanging during boot');
  setInterval(() => {}, 1000);
  return;
}

let answering = true;
const srv = http.createServer((req, res) => {
  if (!answering) return; // hung: accept, never answer
  if (req.url === '/api/ping') return res.end(JSON.stringify({ ok: true, pid: process.pid }));
  if (req.url === '/restart') { res.end('{}'); srv.close(); return setTimeout(() => process.exit(75), 100); }
  res.end('fake dashboard');
});
srv.listen(port, () => {
  console.log(`fake: listening on ${port}`);
  if (mode === 'crash-after-healthy') setTimeout(() => { console.error('fake: crashing'); process.exit(1); }, 1500);
  if (mode === 'stop-answering') {
    process.on('SIGTERM', () => console.log('fake: ignoring SIGTERM'));
    setTimeout(() => { answering = false; }, 1000);
  }
});
