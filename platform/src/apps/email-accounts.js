const path = require('path');

let appsDir = null;
let secretStore = null;
let accounts = {};

const PRESETS = {
  outlook: { imapHost: 'imap-mail.outlook.com', imapPort: 993, imapTls: true, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpTls: true },
  yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpTls: true },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpTls: true },
  protonmail: { imapHost: '127.0.0.1', imapPort: 1143, imapTls: false, smtpHost: '127.0.0.1', smtpPort: 1025, smtpTls: false },
  fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpTls: true },
  gmx: { imapHost: 'imap.gmx.com', imapPort: 993, imapTls: true, smtpHost: 'mail.gmx.com', smtpPort: 587, smtpTls: true },
  zoho: { imapHost: 'imap.zoho.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpTls: true },
  yandex: { imapHost: 'imap.yandex.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.yandex.com', smtpPort: 465, smtpTls: true },
  aol: { imapHost: 'imap.aol.com', imapPort: 993, imapTls: true, smtpHost: 'smtp.aol.com', smtpPort: 465, smtpTls: true },
};

function configPath() {
  return path.join(appsDir, '.email-accounts.enc');
}

function loadAccounts() {
  return secretStore.readSecretFile(configPath(), appsDir, { fallback: {} });
}

function saveAccounts() {
  secretStore.writeSecretFile(configPath(), accounts, appsDir);
}

function init(dir, store) {
  appsDir = dir;
  secretStore = store;
  accounts = loadAccounts();
}

function list() {
  return Object.values(accounts).map(a => ({
    email: a.email,
    type: a.type || 'imap',
    provider: a.provider || 'custom',
    username: a.username,
    imap: a.imap,
    smtp: a.smtp,
    addedAt: a.addedAt,
    lastTestedAt: a.lastTestedAt || null,
    lastTestOk: a.lastTestOk,
  }));
}

function getCredentials(email) {
  const acc = accounts[email];
  if (!acc) return null;
  return {
    email: acc.email,
    username: acc.username || acc.email,
    password: acc.password,
    imap: acc.imap,
    smtp: acc.smtp,
    provider: acc.provider || 'custom',
  };
}

function addAccount(account) {
  if (!account.email) return { ok: false, error: 'Email is required' };
  if (!account.password) return { ok: false, error: 'Password is required' };
  if (!account.imap?.host) return { ok: false, error: 'IMAP host is required' };

  accounts[account.email] = {
    email: account.email,
    type: account.type || 'imap',
    username: account.username || account.email,
    password: account.password,
    imap: {
      host: account.imap.host,
      port: account.imap.port || 993,
      tls: account.imap.tls !== false,
    },
    smtp: account.smtp ? {
      host: account.smtp.host,
      port: account.smtp.port || 587,
      tls: account.smtp.tls !== false,
    } : null,
    provider: account.provider || 'custom',
    addedAt: Date.now(),
    lastTestedAt: null,
    lastTestOk: null,
  };
  saveAccounts();
  return { ok: true };
}

function removeAccount(email) {
  if (!accounts[email]) return { ok: false, error: 'Account not found' };
  delete accounts[email];
  saveAccounts();
  return { ok: true };
}

function updateAccount(email, updates) {
  if (!accounts[email]) return { ok: false, error: 'Account not found' };
  const acc = accounts[email];
  if (updates.username !== undefined) acc.username = updates.username;
  if (updates.password !== undefined) acc.password = updates.password;
  if (updates.imap) acc.imap = { ...acc.imap, ...updates.imap };
  if (updates.smtp) acc.smtp = { ...acc.smtp, ...updates.smtp };
  if (updates.provider !== undefined) acc.provider = updates.provider;
  saveAccounts();
  return { ok: true };
}

async function testConnection(account) {
  let ImapFlow;
  try {
    ImapFlow = require('imapflow').ImapFlow;
  } catch {
    return { ok: false, error: 'imapflow not installed — run npm install in vistaclair-pro' };
  }

  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port || 993,
    secure: account.imap.tls !== false,
    auth: { user: account.username || account.email, pass: account.password },
    logger: false,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  try {
    await client.connect();
    await client.logout();
    if (accounts[account.email]) {
      accounts[account.email].lastTestedAt = Date.now();
      accounts[account.email].lastTestOk = true;
      saveAccounts();
    }
    return { ok: true };
  } catch (err) {
    if (accounts[account.email]) {
      accounts[account.email].lastTestedAt = Date.now();
      accounts[account.email].lastTestOk = false;
      saveAccounts();
    }
    return { ok: false, error: err.message || 'Connection failed' };
  }
}

function status() {
  const accs = Object.values(accounts);
  return {
    count: accs.length,
    accounts: accs.map(a => ({ email: a.email, provider: a.provider || 'custom' })),
  };
}

module.exports = { init, list, getCredentials, addAccount, removeAccount, updateAccount, testConnection, status, PRESETS };
