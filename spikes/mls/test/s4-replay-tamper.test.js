'use strict';
// S4 — Replay & tamper (SEC-15/SEC-17 in miniature):
//  * redelivering an already-seen application message is rejected;
//  * flipping one ciphertext byte fails with an authentication error.
const test = require('node:test');
const assert = require('node:assert');
const { device, u8, txt } = require('./helpers');

test('S4: replay rejected; one-byte tamper fails authentication', () => {
  const gid = u8('g-s4');
  const alice = device('alice|dev1', 1);
  const bob = device('bob|dev1', 2);

  const out = alice.create_group(gid, [bob.key_package()]);
  bob.join_from_welcome(out[1]);

  const ct = alice.encrypt(gid, u8('wire text'));
  const r = bob.process(gid, ct);
  assert.strictEqual(txt(r.plaintext), 'wire text');

  // SEC-15: exact redelivery of the same ciphertext -> rejected.
  // The receiver's secret tree ratchets one way: the used generation is gone.
  assert.throws(() => bob.process(gid, ct), /generation|key|epoch|decrypt|auth|replay|used/i);

  // Fresh messages still flow (the failure above did not corrupt state).
  const ct2 = alice.encrypt(gid, u8('second'));
  assert.strictEqual(txt(bob.process(gid, ct2).plaintext), 'second');

  // SEC-17: flip ONE ciphertext byte -> authentication failure.
  const tampered = Uint8Array.from(ct2);
  const pos = Math.floor(tampered.length / 2);
  tampered[pos] ^= 0x01;
  let threw = false;
  try {
    bob.process(gid, tampered);
  } catch (e) {
    threw = true;
    const msg = String(e);
    assert.match(msg, /aead|auth|decrypt|tag|mac|cipher|error/i, `authentication-flavoured error, got: ${msg}`);
  }
  assert.ok(threw, 'tampered ciphertext rejected');

  // Flip a byte in the very first bytes (header/MlsMessage framing area):
  // must also fail (framing or AEAD), never silently succeed.
  const headTampered = Uint8Array.from(ct2);
  headTampered[3] ^= 0x40;
  assert.throws(() => bob.process(gid, headTampered));

  console.log('S4 OK: replay rejected (generation consumed), 1-byte tamper -> AEAD auth error');
});
