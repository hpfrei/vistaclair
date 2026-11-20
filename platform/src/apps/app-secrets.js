// Per-app encrypted secrets (.secrets.enc via core's secretStore) — the
// `secrets` capability (secrets.get/set).

const path = require('path');
const { core } = require('./core-services');

function secretsPath(appDir) {
  return path.join(appDir, '.secrets.enc');
}

function readSecrets(appDir) {
  return core.secretStore.readSecretFile(secretsPath(appDir), require('./app-manager').APPS_DIR, { fallback: {} });
}

function writeSecrets(appDir, secrets) {
  core.secretStore.writeSecretFile(secretsPath(appDir), secrets, require('./app-manager').APPS_DIR);
}

// secrets.get: a key → its value (null when unset); no key → the list of names.
function get(appDir, key) {
  const secrets = readSecrets(appDir);
  return key ? (secrets[key] ?? null) : Object.keys(secrets);
}

// secrets.set: null/undefined value deletes the key.
function set(appDir, key, value) {
  if (!key) throw new Error('No key provided');
  const secrets = readSecrets(appDir);
  if (value === null || value === undefined) {
    delete secrets[key];
  } else {
    secrets[key] = value;
  }
  writeSecrets(appDir, secrets);
  return true;
}

module.exports = { secretsPath, readSecrets, writeSecrets, get, set };
