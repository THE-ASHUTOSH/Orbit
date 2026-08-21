import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../browser/TabManager.js';

test('urls: bare hostnames become https', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  example.com/path?q=1 '), 'https://example.com/path?q=1');
  assert.equal(normalizeUrl('http://192.168.1.10:8080/x'), 'http://192.168.1.10:8080/x');
});

test('urls: plain text becomes a search, not a broken navigation', () => {
  const searched = normalizeUrl('how tall is everest');
  assert.match(searched!, /^https:\/\/duckduckgo\.com\/\?q=how\+tall\+is\+everest|%20/);
});

test('urls: dangerous schemes are refused', () => {
  for (const bad of [
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com',
    'filesystem:https://example.com/temporary/x',
    'chrome-extension://abc/page.html',
  ]) {
    assert.equal(normalizeUrl(bad), null, `${bad} must be blocked`);
  }
});

test('urls: about:blank is the one non-http exception', () => {
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
});

test('urls: empty input is rejected', () => {
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('   '), null);
});
