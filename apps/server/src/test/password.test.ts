import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../auth/password.js';

test('password: hash verifies and is salted', () => {
  const a = hashPassword('correct horse battery');
  const b = hashPassword('correct horse battery');
  assert.notEqual(a, b, 'same password must not produce the same hash');
  assert.ok(verifyPassword('correct horse battery', a));
  assert.ok(verifyPassword('correct horse battery', b));
});

test('password: wrong password and tampering are rejected', () => {
  const stored = hashPassword('s3cret-value');
  assert.equal(verifyPassword('s3cret-valuE', stored), false);
  assert.equal(verifyPassword('', stored), false);
  const tampered = stored.slice(0, -4) + 'AAAA';
  assert.equal(verifyPassword('s3cret-value', tampered), false);
});

test('password: missing hash still burns work and returns false', () => {
  assert.equal(verifyPassword('anything', null), false);
  assert.equal(verifyPassword('anything', 'not-a-hash'), false);
});

test('password: unicode is normalised so the same typed password matches', () => {
  const composed = 'café-pass'; // e + combining acute
  const precomposed = 'café-pass';
  assert.ok(verifyPassword(precomposed, hashPassword(composed)));
});
