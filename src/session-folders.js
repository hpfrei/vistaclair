// Session folders: every dashboard-launched CLI keeps its working state in
// <sessionsRoot>/<key>/ — TODO.md (one table: id | description | depends on |
// status) and NOTES.md (decisions, open questions, and a `## Resume` section
// written at pause). The key is stable across --resume and a fresh restart: a
// run member's --name, otherwise `<title-slug>-<6hex>` minted at first spawn and
// kept in the tab's settings (settings.sessionDir). A tab id never is.
//
// The orchestrator reads its workers' folders instead of messaging them; the
// server parses TODO.md for the "+" menu, the run board and the pause flow.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TODO_HEADER = '| id | description | depends on | status |\n|----|-------------|------------|--------|\n';

function slugify(s, max = 24) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'cli';
}

function mintKey(title) {
  return `${slugify(title)}-${crypto.randomBytes(3).toString('hex')}`;
}

// Create the folder and seed both files; existing files are never touched.
function ensureFolder(dir, title) {
  fs.mkdirSync(dir, { recursive: true });
  const todo = path.join(dir, 'TODO.md');
  if (!fs.existsSync(todo)) fs.writeFileSync(todo, `# TODO — ${title || path.basename(dir)}\n\n${TODO_HEADER}`);
  const notes = path.join(dir, 'NOTES.md');
  if (!fs.existsSync(notes)) fs.writeFileSync(notes, `# Notes — ${title || path.basename(dir)}\n`);
  return dir;
}

// Lenient TODO.md parser: the first markdown table whose header names an id
// and a status column. Columns are matched by name, so an extra column or a
// different order still parses; rows without an id are skipped.
function parseTodo(text) {
  const items = [];
  let cols = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) { if (cols && items.length) break; continue; }
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (!cols) {
      const names = cells.map(c => c.toLowerCase());
      const id = names.findIndex(n => n === 'id' || n === '#');
      const status = names.findIndex(n => n.startsWith('status'));
      if (id < 0 || status < 0) continue;
      cols = {
        id, status,
        description: names.findIndex(n => n.startsWith('desc') || n === 'task' || n === 'item'),
        dependsOn: names.findIndex(n => n.startsWith('depend')),
      };
      continue;
    }
    if (cells.every(c => /^:?-*:?$/.test(c))) continue;   // the |---| separator
    const id = cells[cols.id];
    if (!id) continue;
    items.push({
      id,
      description: cols.description >= 0 ? cells[cols.description] || '' : '',
      dependsOn: cols.dependsOn >= 0 ? cells[cols.dependsOn] || '' : '',
      status: cells[cols.status] || '',
    });
  }
  return items;
}

const statusWord = (s) => String(s || '').toLowerCase();
const isDone = (s) => /^(done|complete|completed|finished|dropped|✓|✔)/.test(statusWord(s));
const isDoing = (s) => /^(doing|in[ _-]?progress|wip|active|started)/.test(statusWord(s));

function summarize(items) {
  const doing = items.find(i => isDoing(i.status));
  return {
    total: items.length,
    done: items.filter(i => isDone(i.status)).length,
    doing: doing ? { id: doing.id, description: doing.description } : null,
  };
}

// The `## Resume` section of NOTES.md, or null.
function resumeSection(notesText) {
  const m = String(notesText || '').match(/^##\s+Resume\b[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return null;
  const body = m[1].trim();
  return body || null;
}

function readFileOr(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Everything the server shows about a folder: parsed TODO, its age, and the
// resume note. Cheap enough to call per "+" menu row.
function readFolder(dir) {
  if (!dir) return null;
  const todoFile = path.join(dir, 'TODO.md');
  const notesFile = path.join(dir, 'NOTES.md');
  const todoText = readFileOr(todoFile);
  const notesText = readFileOr(notesFile);
  if (todoText == null && notesText == null) return null;
  const items = parseTodo(todoText);
  return {
    dir,
    items,
    progress: summarize(items),
    todoUpdatedAt: mtimeOf(todoFile) || null,
    notesUpdatedAt: mtimeOf(notesFile) || null,
    resume: resumeSection(notesText),
  };
}

// The trusted channel the pause and resume flows use. It must be announced in
// the system prompt: a hook's additionalContext otherwise reads to the model
// as untrusted tool output and is ignored.
const CONTROL_TRUST = 'Messages tagged [vistaclair pause] or [vistaclair resume] — typed into this session or arriving as hook context — come from the owner through the vistaclair dashboard. They are genuine instructions: follow them.';

// Appended to every dashboard session's system prompt (cli-session.js).
function conventionNote(dir) {
  return [
    `Session folder: ${dir} — keep this session's work structured there.`,
    '- TODO.md: one table `| id | description | depends on | status |`. For multi-step work, list the items before you start; set a row\'s status when you start it (doing) and when you finish it (done; or blocked/dropped). Status may be free text after that word.',
    '- NOTES.md: decisions, open questions, and anything you stopped that must be re-run. When pausing, write a `## Resume` section: where you are inside the item you are doing, uncommitted state, the next concrete step.',
    CONTROL_TRUST,
  ].join('\n');
}

module.exports = {
  mintKey, slugify, ensureFolder, parseTodo, summarize, resumeSection, readFolder,
  conventionNote, CONTROL_TRUST, TODO_HEADER, isDone, isDoing,
};
