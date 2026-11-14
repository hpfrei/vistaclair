// Session folders (src/session-folders.js): keys, the seeded TODO.md / NOTES.md,
// the lenient TODO parser and the resume note.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const folders = require('../src/session-folders');

test('keys: a slug plus 6 hex, never empty', () => {
  assert.match(folders.mintKey('My App: Fix login!'), /^my-app-fix-login-[0-9a-f]{6}$/);
  assert.match(folders.mintKey(''), /^cli-[0-9a-f]{6}$/);
  assert.notStrictEqual(folders.mintKey('x'), folders.mintKey('x'));
});

test('ensureFolder seeds both files once and never overwrites them', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-folders-')), 'demo-abc123');
  try {
    folders.ensureFolder(dir, 'Demo');
    const todo = fs.readFileSync(path.join(dir, 'TODO.md'), 'utf8');
    assert.ok(todo.includes(folders.TODO_HEADER));
    assert.deepStrictEqual(folders.parseTodo(todo), []);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'mine');
    folders.ensureFolder(dir, 'Demo');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'), 'mine');
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('parseTodo: columns by name, free-text status, junk tolerated', () => {
  const text = [
    '# TODO', '', 'Some prose | with a pipe', '',
    '| Status | ID | Description | Depends on | Owner |',
    '|:---|---|---|---|---|',
    '| done | 1 | Parse input | – | me |',
    '| doing — half the cases | 2 | Write tests | 1 | me |',
    '|  |  | a row without an id | | |',
    '| blocked on API key | 3 | Deploy | 1, 2 |',
    '',
    '| id | status |', '|--|--|', '| 9 | ignored: a second table |',
  ].join('\n');
  const items = folders.parseTodo(text);
  assert.deepStrictEqual(items.map(i => i.id), ['1', '2', '3']);
  assert.strictEqual(items[1].status, 'doing — half the cases');
  assert.strictEqual(items[2].dependsOn, '1, 2');
  assert.deepStrictEqual(folders.summarize(items), { total: 3, done: 1, doing: { id: '2', description: 'Write tests' } });
  assert.deepStrictEqual(folders.parseTodo('no table here'), []);
  assert.deepStrictEqual(folders.parseTodo('| a | b |\n|---|---|\n| 1 | 2 |'), [], 'a table without id/status columns is not a TODO');
});

test('resumeSection: the body of `## Resume` up to the next heading', () => {
  assert.strictEqual(folders.resumeSection('# N\n\n## Resume\n\nstep 3, half done\n\n## Decisions\n\nx'), 'step 3, half done');
  assert.strictEqual(folders.resumeSection('## Resume (paused 12:00)\nlast line'), 'last line');
  assert.strictEqual(folders.resumeSection('## Resume\n\n'), null, 'an empty section is no note');
  assert.strictEqual(folders.resumeSection('## Resumes\nx'), null);
});

test('readFolder: progress, ages and the note; null for a missing folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-folders-'));
  try {
    assert.strictEqual(folders.readFolder(path.join(dir, 'nope')), null);
    fs.writeFileSync(path.join(dir, 'TODO.md'), `${folders.TODO_HEADER}| 1 | a | – | done |\n| 2 | b | 1 | in progress |\n`);
    fs.writeFileSync(path.join(dir, 'NOTES.md'), '## Resume\nnext: b');
    const f = folders.readFolder(dir);
    assert.deepStrictEqual(f.progress, { total: 2, done: 1, doing: { id: '2', description: 'b' } });
    assert.strictEqual(f.resume, 'next: b');
    assert.ok(f.todoUpdatedAt > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the convention note names the folder and announces the trusted channel', () => {
  const note = folders.conventionNote('/x/sessions/demo-abc123');
  assert.ok(note.includes('/x/sessions/demo-abc123'));
  assert.ok(note.includes('| id | description | depends on | status |'));
  assert.ok(note.includes('## Resume'));
  assert.match(note, /keep each description short \(60 characters at most\) and put the detail in NOTES\.md/);
  assert.ok(note.includes(folders.CONTROL_TRUST));
});

test('the convention note: a changed requirement rewrites the TODO rows and replaces the NOTES decision', () => {
  const note = folders.conventionNote('/x/sessions/demo-abc123');
  assert.match(note, /When an instruction changes the requirements, rewrite the rows it affects \(add, reword, or mark them dropped\) before you act on it\./);
  assert.match(note, /A decision a new instruction overrides is replaced or struck, not left in place with the new one below it: NOTES\.md always describes the current spec, and a fresh restart works from it\./);
});

// ---- ARCHIVE.md: finished rows the orchestrator moved out of TODO.md ----

const FIXTURE = path.join(__dirname, 'fixtures', 'orch-archive');   // copied from a real run (7d1c23)

function tmpFolder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-archive-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('readFolder: ARCHIVE.md rows come back separately and count as done (11 of 16)', () => {
  const f = folders.readFolder(FIXTURE);
  assert.strictEqual(f.items.length, 5);
  assert.strictEqual(f.archived.length, 11);
  assert.deepStrictEqual(f.archived.slice(0, 2).map(r => r.id), ['t0', 't1a']);
  assert.match(f.archived[0].description, /^Bench A–H/);
  assert.ok(f.archived.every(r => folders.isDone(r.status)));
  assert.deepStrictEqual([f.progressAll.done, f.progressAll.total, f.progressAll.archived], [11 + f.progress.done, 16, 11]);
  assert.strictEqual(f.progressAll.doing?.id, f.progress.doing?.id);
});

test('readFolder: the model-facing view stays open-only (list_workers / RESTART seed read items and progress)', () => {
  const f = folders.readFolder(FIXTURE);
  assert.strictEqual(f.items.length, 5);
  assert.ok(!f.items.some(i => f.archived.some(a => a.id === i.id)));
  assert.strictEqual(f.progress.total, 5);
  assert.strictEqual(f.progress.archived, undefined);
});

test('readFolder: no ARCHIVE.md looks exactly as before', () => {
  const dir = tmpFolder({ 'TODO.md': '| id | description | depends on | status |\n|---|---|---|---|\n| 1 | a | | done |\n| 2 | b | | doing |\n' });
  try {
    const f = folders.readFolder(dir);
    assert.deepStrictEqual(f.archived, []);
    assert.strictEqual(f.progressAll, f.progress);
    assert.deepStrictEqual(f.progress, { total: 2, done: 1, doing: { id: '2', description: 'b' } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('parseArchive: no header, blank lines, a status that does not say done', () => {
  const rows = folders.parseArchive('# ARCHIVE — run x\n| a1 | first | | landed abc |\n\n| a2 | second | a1 | merged |\n\n\n| a3 | third | | done — x |\n');
  assert.deepStrictEqual(rows.map(r => r.id), ['a1', 'a2', 'a3']);
  assert.strictEqual(rows[1].dependsOn, 'a1');
  assert.strictEqual(rows[0].status, 'landed abc');
});

test('parseArchive: a header and separator row are skipped, columns follow the header; 3 cells = no depends on', () => {
  const withHeader = folders.parseArchive('| status | id | description |\n|---|---|---|\n| done | x | desc |\n');
  assert.deepStrictEqual(withHeader.map(r => [r.id, r.description, r.status]), [['x', 'desc', 'done']]);
  const three = folders.parseArchive('| b1 | thing | done |\n');
  assert.deepStrictEqual(three.map(r => [r.id, r.description, r.dependsOn, r.status]), [['b1', 'thing', '', 'done']]);
  assert.deepStrictEqual(folders.parseArchive(''), []);
  assert.deepStrictEqual(folders.parseArchive(null), []);
});

test('readFolder: a folder with only an ARCHIVE.md and TODO.md missing is still null without notes', () => {
  const dir = tmpFolder({ 'ARCHIVE.md': '| a | b | | done |\n' });
  try { assert.strictEqual(folders.readFolder(dir), null); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
