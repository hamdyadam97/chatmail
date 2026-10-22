'use strict';
// Shared helpers for the MLS spike scenario suite.
const { SpikeClient } = require('../pkg/node/mls_spike.js');

const enc = new TextEncoder();
const dec = new TextDecoder();

// Deterministic 32-byte Ed25519 seed for a device.
function seed(n) {
  const s = new Uint8Array(32);
  s[0] = n & 0xff;
  s[1] = (n >> 8) & 0xff;
  return s;
}

// A device = one independent MLS client (docs/phase1/03: each DEVICE is a client).
function device(identity, n) {
  return new SpikeClient(enc.encode(identity), seed(n));
}

function u8(s) {
  return enc.encode(s);
}

function txt(u) {
  return dec.decode(u);
}

// Dumb delivery service: per-member FIFO queues of opaque MLS payloads.
// It stores ciphertext/commits/welcomes only — never plaintext.
class DumbServer {
  constructor() {
    this.queues = new Map();
  }
  post(member, payload) {
    if (!this.queues.has(member)) this.queues.set(member, []);
    this.queues.get(member).push(Uint8Array.from(payload));
  }
  pending(member) {
    return (this.queues.get(member) || []).length;
  }
  fetchAll(member) {
    const q = this.queues.get(member) || [];
    this.queues.set(member, []);
    return q;
  }
}

function memberIdentities(count, prefix = 'user') {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}|dev1`);
}

module.exports = { SpikeClient, enc, dec, seed, device, u8, txt, DumbServer, memberIdentities };
