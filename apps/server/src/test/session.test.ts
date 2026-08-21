import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCookieValue, parseCookies, readCookieValue, serializeCookie } from '../auth/session.js';

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
