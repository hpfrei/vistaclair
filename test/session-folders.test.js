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
