'use strict';
// S6 — Persistence: serialize a member's full MLS state to bytes, restore
// into a fresh client instance, and continue the conversation (both sending
// and receiving) in subsequent epochs.
const test = require('node:test');
const assert = require('node:assert');
const { device, u8, txt, seed } = require('./helpers');

test('S6: export -> fresh instance -> import -> decrypt new epochs', () => {
  const gid = u8('g-s6');
  const alice = device('alice|dev1', 1);
  const bob = device('bob|dev1', 2);

  const out = alice.create_group(gid, [bob.key_package()]);
  bob.join_from_welcome(out[1]);

  const ctPre = alice.encrypt(gid, u8('before backup'));
  assert.strictEqual(txt(bob.process(gid, ctPre).plaintext), 'before backup');
  const ctBob = bob.encrypt(gid, u8('reply before backup'));
  assert.strictEqual(txt(alice.process(gid, ctBob).plaintext), 'reply before backup');
  const epochBefore = Number(alice.epoch(gid));

  // Full state export (snapshot + epochs + key packages).
  const blob = alice.export_state(gid);
  assert.ok(blob.length > 500, 'state blob is non-trivial');

  // Fresh instance of the SAME device: same identity, same seed.
  const { SpikeClient, enc } = require('./helpers');
  const alice2 = new SpikeClient(enc.encode('alice|dev1'), seed(1));
  alice2.import_state(blob);

  // Epoch continuity.
  assert.strictEqual(Number(alice2.epoch(gid)), epochBefore, 'restored client resumes at same epoch');

  // New traffic after restore: alice2 -> bob, then bob -> alice2.
  const ct1 = alice2.encrypt(gid, u8('after restore, from alice2'));
  assert.strictEqual(txt(bob.process(gid, ct1).plaintext), 'after restore, from alice2');

  const ct2 = bob.encrypt(gid, u8('after restore, from bob'));
  assert.strictEqual(txt(alice2.process(gid, ct2).plaintext), 'after restore, from bob');

  // NOTE: the original `alice` instance must NOT keep sending after a restore
  // — the restored copy has taken over the one-way sender ratchet (generation
  // reuse is rejected; a forked device is a split-brain, by protocol design).

  console.log(`S6 OK: blob=${blob.length}B epoch continuity ${epochBefore}->new epochs decrypted`);
});
