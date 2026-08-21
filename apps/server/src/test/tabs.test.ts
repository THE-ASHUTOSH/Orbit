import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, resolveTabUrl } from '../browser/TabManager.js';

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

test('urls: a new tab falls back to the configured home page', () => {
  assert.equal(resolveTabUrl(undefined, 'https://www.google.com'), 'https://www.google.com/');
  assert.equal(resolveTabUrl(null, 'example.com'), 'https://example.com/', 'a bare home host is normalised');
  assert.equal(resolveTabUrl('https://other.test/x', 'https://www.google.com'), 'https://other.test/x', 'explicit wins');
  assert.equal(resolveTabUrl(undefined, 'about:blank'), 'about:blank', 'the offline default');
  assert.equal(resolveTabUrl(undefined, ''), 'about:blank', 'empty home is not a navigation');
  // A home page that is not a usable http(s) URL must not break tab creation.
  assert.equal(resolveTabUrl(undefined, 'file:///etc/passwd'), 'about:blank');
});
