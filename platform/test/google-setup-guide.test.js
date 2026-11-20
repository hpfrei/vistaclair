'use strict';
// The Setup → Google step-by-step guide follows the Google Auth Platform
// console and every external link opens in a new tab.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'apps.js'), 'utf8');
const start = src.indexOf('<!-- GOOGLE TAB -->');
const end = src.indexOf('<!-- EMAIL TAB -->');
const pane = src.slice(start, end);

test('google pane is found', () => {
  assert.ok(start > 0 && end > start, 'pane markers present');
  assert.ok(pane.includes('id="setupPane-google"'));
});

test('guide uses the Google Auth Platform pages', () => {
  for (const p of ['/auth/branding', '/auth/audience', '/auth/clients', '/auth/scopes',
    '/apis/library/gmail.googleapis.com', '/apis/library/calendar-json.googleapis.com']) {
    assert.ok(pane.includes('https://console.cloud.google.com' + p), p);
  }
  assert.ok(!pane.includes('/apis/credentials/consent'), 'old consent-screen URL is gone');
});

test('every https anchor opens in a new tab with noopener', () => {
  const anchors = pane.match(/<a\s[^>]*href="https:\/\/[^>]*>/g) || [];
  assert.ok(anchors.length >= 10, 'anchors found: ' + anchors.length);
  for (const a of anchors) {
    assert.match(a, /target="_blank"/, a);
    assert.match(a, /rel="[^"]*noopener/, a);
  }
});
