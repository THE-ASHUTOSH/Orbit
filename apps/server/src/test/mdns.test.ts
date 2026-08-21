import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAResponse, parseQuestions } from '../mdns.js';

/** Encode a DNS question the way a resolver on the LAN would. */
function query(name: string, type = 1, unicast = false): Buffer {
  const labels = name.split('.');
  const size = 12 + labels.reduce((n, l) => n + 1 + l.length, 0) + 1 + 4;
  const buf = Buffer.alloc(size);
  buf.writeUInt16BE(0x1234, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.writeUInt16BE(1, 4);
  let off = 12;
  for (const l of labels) {
    buf.writeUInt8(l.length, off);
    buf.write(l, off + 1);
    off += 1 + l.length;
  }
  buf.writeUInt8(0, off++);
  buf.writeUInt16BE(type, off);
  buf.writeUInt16BE(unicast ? 0x8001 : 1, off + 2);
  return buf;
}

test('mdns: parses an A query for a .local name', () => {
  const parsed = parseQuestions(query('shared-browser.local'));
  assert.ok(parsed);
  assert.equal(parsed.id, 0x1234);
  assert.deepEqual(parsed.questions, [{ name: 'shared-browser.local', type: 1, unicast: false }]);
});

test('mdns: honours the unicast-response bit', () => {
  const parsed = parseQuestions(query('shared-browser.local', 1, true));
  assert.equal(parsed?.questions[0]?.unicast, true);
});

test('mdns: ignores responses so we never answer ourselves', () => {
  const response = query('shared-browser.local');
  response.writeUInt16BE(0x8400, 2);
  assert.equal(parseQuestions(response), null);
});

test('mdns: builds a well-formed A record with the cache-flush bit', () => {
  const buf = buildAResponse(0x1234, 'shared-browser.local', '192.168.1.100');
  assert.equal(buf.readUInt16BE(0), 0x1234);
  assert.equal(buf.readUInt16BE(2), 0x8400, 'response + authoritative');
  assert.equal(buf.readUInt16BE(4), 0, 'no questions echoed');
  assert.equal(buf.readUInt16BE(6), 1, 'one answer');
  // name(1+14 +1+5 +1) then type/class/ttl/rdlength/rdata
  const nameLen = 1 + 14 + 1 + 5 + 1;
  let off = 12 + nameLen;
  assert.equal(buf.readUInt16BE(off), 1, 'type A');
  assert.equal(buf.readUInt16BE(off + 2), 0x8001, 'IN + cache flush');
  assert.equal(buf.readUInt16BE(off + 8), 4, 'rdlength');
  assert.deepEqual([...buf.subarray(off + 10)], [192, 168, 1, 100]);
});

test('mdns: truncated packets do not throw', () => {
  assert.equal(parseQuestions(Buffer.alloc(4)), null);
  assert.equal(parseQuestions(Buffer.from([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5])), null);
});
