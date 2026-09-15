// The credential join: which Claude credential a spawn uses, and whether a
// registry model can actually be called right now.
//
// These two questions used to be answered by separate code paths with opposite
// defaults, so the model pickers reported "no Anthropic model is usable" on a
// box where every headless spawn was in fact running fine on the subscription.
// The invariant below is the one that broke: anything reported `usable` must
// have a credential behind it, and a stored API key must not be what decides it.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// capabilities.js reads the CLI credential file from the real home dir, so the
// subscription cases drive it through a temporary HOME.
function withHome(creds, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-auth-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    if (creds !== null) {
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: creds }),
      );
    }
    delete require.cache[require.resolve('../src/capabilities')];
    return fn(require('../src/capabilities'), home);
  } finally {
    process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    delete require.cache[require.resolve('../src/capabilities')];
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const HOUR = 3600 * 1000;
const LIVE = {
  accessToken: 'at', refreshToken: 'rt',
  expiresAt: Date.now() + HOUR,
  refreshTokenExpiresAt: Date.now() + 30 * 24 * HOUR,
};
// The shape that used to read as "no subscription": the short-lived access
// token has lapsed but the CLI can still refresh it transparently.
const STALE_ACCESS = { ...LIVE, expiresAt: Date.now() - HOUR };
const DEAD = { ...LIVE, expiresAt: Date.now() - HOUR, refreshTokenExpiresAt: Date.now() - HOUR };

// A baseDir with no secrets store and no app-prefs: the default install.
function emptyBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vc-base-'));
}

test('an expired access token is still an active subscription while the refresh token lives', () => {
  withHome(LIVE, (caps) => assert.equal(caps.hasClaudeSubscription(), true));
  // The regression: keying on expiresAt made every Anthropic model blink out of
  // the pickers a few hours after login, and silently moved live sessions onto
  // the API key.
  withHome(STALE_ACCESS, (caps) => assert.equal(caps.hasClaudeSubscription(), true));
  withHome(DEAD, (caps) => assert.equal(caps.hasClaudeSubscription(), false));
  withHome(null, (caps) => assert.equal(caps.hasClaudeSubscription(), false));
});

test('a credential file with no refresh token falls back to the access token expiry', () => {
  withHome({ accessToken: 'at', expiresAt: Date.now() + HOUR }, (caps) =>
    assert.equal(caps.hasClaudeSubscription(), true));
  withHome({ accessToken: 'at', expiresAt: Date.now() - HOUR }, (caps) =>
    assert.equal(caps.hasClaudeSubscription(), false));
});

test('resolveAuth picks the subscription by default and reports which credential it chose', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    try {
      assert.deepEqual(caps.resolveAuth(base), { credential: 'subscription', key: '' });
      // An empty key is NOT "no credential" — it means "run on OAuth". Those two
      // states were once the same value, which is why the opt-in gate was inert.
      assert.equal(caps.resolveAuth(base).credential, 'subscription');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test('with no subscription and no key there is no credential at all', () => {
  withHome(null, (caps) => {
    const base = emptyBase();
    const prevEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      assert.deepEqual(caps.resolveAuth(base), { credential: null, key: '' });
    } finally {
      if (prevEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = prevEnvKey;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

test('the apikey preference falls back to the subscription rather than failing the call', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    const prevEnvKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      fs.mkdirSync(path.join(base, 'data'), { recursive: true });
      fs.writeFileSync(path.join(base, 'data', 'app-prefs.json'), JSON.stringify({ claudeAuth: 'apikey' }));
      const got = caps.resolveAuth(base);
      assert.equal(got.credential, 'subscription');
      assert.equal(got.key, '');
    } finally {
      if (prevEnvKey !== undefined) process.env.ANTHROPIC_API_KEY = prevEnvKey;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

test('the stored preference is honoured for interactive sessions too, not just headless', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    const prevEnvKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    try {
      fs.mkdirSync(path.join(base, 'data'), { recursive: true });
      fs.writeFileSync(path.join(base, 'data', 'app-prefs.json'), JSON.stringify({ claudeAuth: 'apikey' }));
      // Both spawn kinds now resolve through the same function; getInteractiveAuth
      // used to ignore the preference entirely and always pick the subscription.
      assert.equal(caps.getInteractiveAuth(base), 'sk-env');
      assert.equal(caps.resolveHeadlessAuth(base), 'sk-env');
    } finally {
      if (prevEnvKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevEnvKey;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

test('an Anthropic model with no stored key is usable on a subscription', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    try {
      const m = { name: 'claude-opus-5', providerKey: 'anthropic', lifecycle: 'current', apiKey: '' };
      // THE regression: `hasApiKey: false` here was read as "not configured",
      // which deleted every Anthropic model from every configuredOnly picker.
      assert.deepEqual(caps.resolveAvailability(base, m), {
        usable: true, reason: null, credential: 'subscription',
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test('a non-Anthropic model still needs its own key — the subscription does not cover it', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    try {
      const keyless = { name: 'gpt-5', providerKey: 'openai', lifecycle: 'current', apiKey: '' };
      assert.deepEqual(caps.resolveAvailability(base, keyless), {
        usable: false, reason: 'no-credential', credential: null,
      });
      const keyed = { ...keyless, apiKey: 'sk-openai' };
      assert.deepEqual(caps.resolveAvailability(base, keyed), {
        usable: true, reason: null, credential: 'api-key',
      });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

test('retirement outranks disabled, so a retired model never reports the wrong reason', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    try {
      // capabilities.js forces `disabled` on retired models, so checking
      // disabled first would label every retired entry 'disabled'.
      const retired = { name: 'claude-opus-4-1', providerKey: 'anthropic', lifecycle: 'retired', disabled: true };
      assert.equal(caps.resolveAvailability(base, retired).reason, 'retired');
      const disabled = { name: 'claude-opus-4-7', providerKey: 'anthropic', lifecycle: 'current', disabled: true };
      assert.equal(caps.resolveAvailability(base, disabled).reason, 'disabled');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

// A registry written into the temp base, so this asserts the join itself rather
// than whatever the developer's box happens to have configured.
function seedRegistry(base) {
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', 'models.json'), JSON.stringify({
    providers: {
      anthropic: { key: 'anthropic', label: 'Anthropic' },
      openai: { key: 'openai', label: 'OpenAI', apiKey: 'sk-openai' },
      google: { key: 'google', label: 'Google' },
    },
    models: [
      { name: 'claude-opus-5', providerKey: 'anthropic', modelId: 'claude-opus-5', lifecycle: 'current' },
      { name: 'claude-haiku-4-5', providerKey: 'anthropic', modelId: 'claude-haiku-4-5', lifecycle: 'current' },
      { name: 'claude-opus-4-7', providerKey: 'anthropic', modelId: 'claude-opus-4-7', lifecycle: 'current', disabled: true },
      { name: 'claude-opus-4-1', providerKey: 'anthropic', modelId: 'claude-opus-4-1', lifecycle: 'retired' },
      { name: 'gpt-5', providerKey: 'openai', modelId: 'gpt-5', lifecycle: 'current' },
      { name: 'gemini-3-pro', providerKey: 'google', modelId: 'gemini-3-pro', lifecycle: 'current' },
    ],
  }));
}

test('every model reported usable has a credential, and no unusable one does', () => {
  withHome(LIVE, (caps) => {
    const base = emptyBase();
    try {
      seedRegistry(base);
      const models = caps.listModelsWithAvailability(base);
      assert.ok(models.length > 0, 'the seeded registry should not be empty');
      for (const m of models) {
        if (m.usable) {
          assert.ok(m.credential, `${m.name} is usable but has no credential`);
          assert.equal(m.unusableReason, null, `${m.name} is usable but carries a reason`);
          assert.notEqual(m.lifecycle, 'retired', `${m.name} is usable but retired`);
          assert.ok(!m.disabled, `${m.name} is usable but disabled`);
        } else {
          assert.ok(m.unusableReason, `${m.name} is unusable without a reason`);
          assert.equal(m.credential, null, `${m.name} is unusable but carries a credential`);
        }
      }
      // With a live subscription, no Anthropic model may be excluded for want of
      // a credential — that exclusion is exactly what this change removed.
      const starved = models.filter((m) => m.providerKey === 'anthropic' && m.unusableReason === 'no-credential');
      assert.deepEqual(starved.map((m) => m.name), []);

      const byName = Object.fromEntries(models.map((m) => [m.name, m]));
      // Anthropic: no stored key anywhere, callable purely on the CLI login.
      assert.equal(byName['claude-opus-5'].usable, true);
      assert.equal(byName['claude-opus-5'].credential, 'subscription');
      assert.equal(byName['claude-opus-5'].hasApiKey, undefined); // storage fact is added by Pro's projection, not core
      assert.equal(byName['claude-opus-4-7'].unusableReason, 'disabled');
      assert.equal(byName['claude-opus-4-1'].unusableReason, 'retired');
      // The provider key covers its own models and nothing else.
      assert.equal(byName['gpt-5'].credential, 'api-key');
      assert.equal(byName['gemini-3-pro'].unusableReason, 'no-credential');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
