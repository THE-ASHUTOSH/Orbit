/**
 * Tiny mDNS responder: answers A queries for "<hostname>.local" with this
 * machine's LAN address, so users can type http://shared-browser.local:3030
 * instead of memorising an IP.
 *
 * Hand-rolled on node:dgram because the alternative (bonjour/mdns packages)
 * advertise *services* - which shows the app in service browsers but does not
 * make the hostname resolve, which is the thing users actually want. This is one
 * question type and one record type; the whole responder is under 100 lines.
 *
 * Purely additive: if multicast is blocked (many corporate/guest networks) the
 * IP address keeps working and nothing else changes.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { log } from './log.js';

const MDNS_PORT = 5353;
const MDNS_GROUP = '224.0.0.251';
const TYPE_A = 1;
const CLASS_IN = 1;
const TTL = 120;

/** First non-internal IPv4 - the address other machines on the LAN can reach. */
export function lanAddress(): string | null {
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

interface Question {
  name: string;
  type: number;
  /** Unicast-response bit (QU) from the class field. */
  unicast: boolean;
}

export function parseQuestions(msg: Buffer): { id: number; questions: Question[] } | null {
  if (msg.length < 12) return null;
  const flags = msg.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return null; // a response, not a query
  const qdcount = msg.readUInt16BE(4);
  const questions: Question[] = [];
  let off = 12;
  for (let q = 0; q < qdcount; q++) {
    const labels: string[] = [];
    let guard = 0;
    while (off < msg.length && guard++ < 64) {
      const len = msg[off]!;
      if (len === 0) {
        off += 1;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        off += 2; // compression pointer; questions rarely use it
        break;
      }
      labels.push(msg.subarray(off + 1, off + 1 + len).toString('utf8'));
      off += 1 + len;
    }
    if (off + 4 > msg.length) return null;
    const type = msg.readUInt16BE(off);
    const klass = msg.readUInt16BE(off + 2);
    off += 4;
    questions.push({ name: labels.join('.'), type, unicast: (klass & 0x8000) !== 0 });
  }
  return { id: msg.readUInt16BE(0), questions };
}

export function buildAResponse(id: number, name: string, ip: string): Buffer {
  const labels = name.split('.').filter(Boolean);
  const nameLen = labels.reduce((n, l) => n + 1 + Buffer.byteLength(l), 0) + 1;
  const buf = Buffer.alloc(12 + nameLen + 10 + 4);
  buf.writeUInt16BE(id, 0);
  buf.writeUInt16BE(0x8400, 2); // response + authoritative
  buf.writeUInt16BE(0, 4); // qdcount
  buf.writeUInt16BE(1, 6); // ancount
  let off = 12;
  for (const label of labels) {
    const len = Buffer.byteLength(label);
    buf.writeUInt8(len, off);
    buf.write(label, off + 1, 'utf8');
    off += 1 + len;
  }
  buf.writeUInt8(0, off);
  off += 1;
  buf.writeUInt16BE(TYPE_A, off);
  // Cache-flush bit: our answer supersedes anything else claiming this name.
  buf.writeUInt16BE(CLASS_IN | 0x8000, off + 2);
  buf.writeUInt32BE(TTL, off + 4);
  buf.writeUInt16BE(4, off + 8);
  off += 10;
  for (const part of ip.split('.')) buf.writeUInt8(Number(part), off++);
  return buf;
}

export class MdnsResponder {
  private socket: dgram.Socket | null = null;

  constructor(
    private readonly hostname: string,
    private readonly ip: string,
  ) {}

  start(): void {
    const fqdn = `${this.hostname}.local`.toLowerCase();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      log.warn('mdns disabled', { err, hint: 'IP access is unaffected' });
      this.stop();
    });

    socket.on('message', (msg, rinfo) => {
      const parsed = parseQuestions(msg);
      if (!parsed) return;
      for (const q of parsed.questions) {
        if (q.type !== TYPE_A || q.name.toLowerCase() !== fqdn) continue;
        const response = buildAResponse(parsed.id, fqdn, this.ip);
        const [port, addr] = q.unicast ? [rinfo.port, rinfo.address] : [MDNS_PORT, MDNS_GROUP];
        socket.send(response, port, addr, (err) => {
          if (err) log.debug('mdns reply failed', { err });
        });
      }
    });

    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_GROUP);
        socket.setMulticastTTL(255);
        log.info('mdns responder active', { hostname: fqdn, ip: this.ip });
      } catch (err) {
        log.warn('mdns membership failed', { err });
      }
    });
  }

  stop(): void {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }
}
