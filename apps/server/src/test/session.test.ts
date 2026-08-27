import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCookieValue, parseCookies, readCookieValue, serializeCookie } from '../auth/session.js';
import { __test } from '../browser/sessionCookies.js';

test('session: signed cookie round-trips', () => {
  const value = makeCookieValue('sess_ABC123');
  assert.equal(readCookieValue(value), 'sess_ABC123');
});

test('session: tampering with the id or the signature is rejected', () => {
  const value = makeCookieValue('sess_ABC123');
  const [idPart, mac] = value.split('.');
  assert.equal(readCookieValue(`sess_EVIL.${mac}`), null, 'swapped session id');
  assert.equal(readCookieValue(`${idPart}.deadbeef`), null, 'forged signature');
  assert.equal(readCookieValue('no-dot'), null);
  assert.equal(readCookieValue(undefined), null);
});

test('session: cookie attributes are safe by default', () => {
  const cookie = serializeCookie('sess_ABC123');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(serializeCookie(null), /Max-Age=0/);
});

test('session: cookie header parsing', () => {
  const jar = parseCookies('a=1; cb_session=sess_X.mac; other=%20spaced%20');
  assert.equal(jar.cb_session, 'sess_X.mac');
  assert.equal(jar.other, ' spaced ');
});

// --- session-cookie stash ---------------------------------------------------

test('session cookies: the stash round-trips, and a wrong key is refused', () => {
  /**
   * Cookie values are credentials. Chromium keeps its own copies encrypted, so
   * writing ours next door in plaintext would be a downgrade - this is the seal
   * that avoids it.
   */
  const cookies = [
    { name: 'sid', value: 'super-secret', domain: '.example.com', path: '/', secure: true, httpOnly: true },
  ];
  const blob = __test.seal(cookies as never);
  assert.ok(!blob.includes('super-secret'), 'the value is not readable in the stored blob');
  assert.deepEqual(__test.open(blob), cookies);

  // Tampering with any part of it fails the authentication tag rather than
  // returning something plausible.
  const [iv, tag, body] = blob.split('.');
  const flipped = Buffer.from(body!, 'base64');
  flipped[0] = flipped[0]! ^ 0xff;
  assert.throws(() => __test.open([iv, tag, flipped.toString('base64')].join('.')));
  assert.deepEqual(__test.open('not-a-blob'), [], 'garbage is empty, not a crash');
});
