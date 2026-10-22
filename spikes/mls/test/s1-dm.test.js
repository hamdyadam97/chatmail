'use strict';
// S1 — Identity & DM: per-device signature identity + key material,
// 2-member MLS group, application message roundtrip both directions.
const test = require('node:test');
const assert = require('node:assert');
const { device, u8, txt, DumbServer } = require('./helpers');

test('S1: 2-member group, DM roundtrip, server sees only opaque payloads', () => {
  const server = new DumbServer();
  const gid = u8('g-s1');

  const alice = device('alice|dev1', 1);
  const bob = device('bob|dev1', 2);

  const kpA = alice.key_package();
  const kpB = bob.key_package();
  assert.ok(kpA.length > 100 && kpB.length > 100, 'key packages are serialized');
  assert.notDeepStrictEqual(kpA, kpB, 'distinct devices -> distinct key packages');

  // Alice creates the group and adds Bob in one commit.
  const out = alice.create_group(gid, [kpB]);
  assert.strictEqual(out.length, 2, '[commit, welcome]');
  const [commit, welcome] = out;

  // Bob joins via Welcome (an added member does NOT process the add-commit).
  const joined = bob.join_from_welcome(welcome);
  assert.strictEqual(txt(joined), 'g-s1');
  assert.strictEqual(Number(alice.epoch(gid)), 1);
  assert.strictEqual(Number(bob.epoch(gid)), 1);

  // Alice -> Bob (only the ciphertext crosses the wire; Bob already holds the
  // group state via the Welcome, he never processes the add-commit).
  const ct1 = alice.encrypt(gid, u8('hello bob'));
  server.post('bob', ct1);
  const queue = server.fetchAll('bob');
  const r1 = bob.process(gid, queue[queue.length - 1]);
  assert.strictEqual(r1.type, 'application');
  assert.strictEqual(txt(r1.plaintext), 'hello bob');
  assert.strictEqual(Number(r1.epoch), 1);

  // Ciphertext must not equal plaintext (nothing plaintext crosses the wire).
  assert.notDeepStrictEqual(Buffer.from(ct1), Buffer.from(u8('hello bob')));

  // Bob -> Alice
  const ct2 = bob.encrypt(gid, u8('hi alice'));
  const r2 = alice.process(gid, ct2);
  assert.strictEqual(txt(r2.plaintext), 'hi alice');
  assert.strictEqual(Number(r2.sender_index), 1);

  console.log(`S1 sizes: keypackage=${kpA.length}B commit=${commit.length}B welcome=${welcome.length}B appmsg=${ct1.length}B`);
});
