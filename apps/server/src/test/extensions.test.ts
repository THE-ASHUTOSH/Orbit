/**
 * Extension ids.
 *
 * The id is what the chrome-extension:// URL is addressed to, so getting the
 * derivation wrong means the extensions panel opens a page that does not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionId } from '../browser/extensions.js';

test('extensions: an id is 32 characters of Chromium\'s a-p alphabet', () => {
  const id = extensionId('/data/extensions/example');
  assert.match(id, /^[a-p]{32}$/);
});

test('extensions: the id follows the load path, and the manifest key wins when present', () => {
  const a = extensionId('/data/extensions/example');
  assert.equal(a, extensionId('/data/extensions/example'), 'same path must give the same id');
  assert.notEqual(a, extensionId('/data/extensions/other'));
  // A packed extension carries its public key, and Chromium hashes that instead.
  assert.notEqual(a, extensionId('/data/extensions/example', Buffer.from('pubkey').toString('base64')));
});
