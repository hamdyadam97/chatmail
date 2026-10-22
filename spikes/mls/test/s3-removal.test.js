'use strict';
// S3 — Membership removal and late join (SEC-06/SEC-07 in miniature):
//  * remove a member via Commit -> the removed member FAILS to decrypt the
//    next epoch (cryptographic failure with their old secrets);
//  * add a new member via Welcome -> they decrypt only from their join epoch,
//    never pre-join history.
const test = require('node:test');
const assert = require('node:assert');
const { device, u8, txt } = require('./helpers');

test('S3: removed member cannot decrypt next epoch; new member sees no pre-join history', () => {
  const gid = u8('g-s3');

  const creator = device('creator|dev1', 1);
  const m1 = device('member1|dev1', 2);
  const m2 = device('member2|dev1', 3); // will be removed
  const m3 = device('member3|dev1', 4);

  const out = creator.create_group(gid, [m1.key_package(), m2.key_package(), m3.key_package()]);
  const commit = out[0];
  const welcomes = out.slice(1);
  const wFor = (i) => (welcomes.length === 3 ? welcomes[i] : welcomes[0]);
  m1.join_from_welcome(wFor(0));
  m2.join_from_welcome(wFor(1));
  m3.join_from_welcome(wFor(2));

  // Everyone (already in the group) processes the creation commit? No — they
  // joined via Welcome; only pre-existing members process commits. Skip.

  // Baseline message in epoch 1.
  const ct1 = creator.encrypt(gid, u8('epoch-one secret'));

  // Creator removes m2.
  const removalCommit = creator.remove_member(gid, u8('member2|dev1'));
  const epochAfterRemoval = Number(creator.epoch(gid));
  assert.strictEqual(epochAfterRemoval, 2, 'removal commit advances epoch');

  // Remaining members process the removal commit.
  for (const m of [m1, m3]) {
    const r = m.process(gid, removalCommit);
    assert.strictEqual(r.type, 'commit');
    assert.strictEqual(Number(r.epoch), 2);
  }

  // m2 may process the removal commit (clients learn of their own removal
  // this way) — it must not throw, but it gives m2 no power over epoch 2.
  m2.process(gid, removalCommit);

  // A post-removal message: remaining members decrypt fine.
  const ct2 = creator.encrypt(gid, u8('post-removal secret'));
  assert.strictEqual(txt(m1.process(gid, ct2).plaintext), 'post-removal secret');
  assert.strictEqual(txt(m3.process(gid, ct2).plaintext), 'post-removal secret');

  // SEC-06: removed member tries to decrypt the new epoch with OLD secrets ->
  // cryptographic failure (epoch/auth error), not an API refusal. This holds
  // whether or not m2 processed the removal commit above.
  assert.throws(() => m2.process(gid, ct2), /epoch|key|decrypt|auth/i);

  // SEC-07: add a new member; they must not read pre-join ciphertexts.
  const late = device('latecomer|dev1', 5);
  const addOut = creator.add_member(gid, late.key_package());
  const addCommit = addOut[0];
  const addWelcome = addOut[1];
  const joinGid = late.join_from_welcome(addWelcome);
  assert.strictEqual(txt(joinGid), 'g-s3');
  for (const m of [m1, m3]) {
    const r = m.process(gid, addCommit);
    assert.strictEqual(Number(r.epoch), 3);
  }

  // Pre-join ciphertext fails for the new member (epoch too old / key gone).
  assert.throws(() => late.process(gid, ct1), /epoch|key|decrypt|auth/i);
  assert.throws(() => late.process(gid, ct2), /epoch|key|decrypt|auth/i);

  // Post-join ciphertext decrypts only from their join epoch onwards.
  const ct3 = creator.encrypt(gid, u8('post-join for latecomer'));
  assert.strictEqual(txt(late.process(gid, ct3).plaintext), 'post-join for latecomer');

  console.log(`S3 OK: removal epoch=${epochAfterRemoval} final_epoch=${Number(creator.epoch(gid))}`);
});
