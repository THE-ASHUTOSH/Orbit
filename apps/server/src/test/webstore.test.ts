/**
 * Unwrapping a .crx.
 *
 * A wrong header length silently hands a corrupt zip to unzip, so the offsets
 * are worth pinning: CRX3 puts the header length in one field, CRX2 splits it
 * across two, and the store decides which one it sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crxToZip, parseStoreId } from '../browser/extensions.js';

const ZIP = Buffer.from('PKthe-actual-archive');

function crx3(header: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write('Cr24', 0);
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, ZIP]);
}

function crx2(key: Buffer, signature: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.write('Cr24', 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(key.length, 8);
  head.writeUInt32LE(signature.length, 12);
  return Buffer.concat([head, key, signature, ZIP]);
}

test('crx: a CRX3 wrapper is stripped exactly at the header length', () => {
  assert.deepEqual(crxToZip(crx3(Buffer.alloc(37, 7))), ZIP);
});

test('crx: a CRX2 wrapper is stripped past both the key and the signature', () => {
  assert.deepEqual(crxToZip(crx2(Buffer.alloc(11, 1), Buffer.alloc(23, 2))), ZIP);
});

test('crx: a plain zip passes through, and anything else is refused', () => {
  assert.deepEqual(crxToZip(ZIP), ZIP);
  assert.throws(() => crxToZip(Buffer.from('not an extension at all')), /not_a_crx/);
  const future = crx3(Buffer.alloc(4));
  future.writeUInt32LE(9, 4);
  assert.throws(() => crxToZip(future), /unsupported_crx_version_9/);
});

test('crx: a truncated header is refused rather than producing a short zip', () => {
  const bad = crx3(Buffer.alloc(4));
  bad.writeUInt32LE(9999, 8);
  assert.throws(() => crxToZip(bad), /bad_crx3_header/);
});

test('store ids: a bare id or a store URL, and nothing else', () => {
  const id = 'ddkjiahejlhfcafbddmgiahcphecmpfh';
  assert.equal(parseStoreId(id), id);
  assert.equal(parseStoreId(`  ${id}\n`), id);
  assert.equal(parseStoreId(`https://chromewebstore.google.com/detail/ublock-origin-lite/${id}`), id);
  assert.equal(parseStoreId('https://example.com/not-an-extension'), null);
  // Web Store ids only use a-p; hex-looking ids are not store ids.
  assert.equal(parseStoreId('0123456789abcdef0123456789abcdef'), null);
});
