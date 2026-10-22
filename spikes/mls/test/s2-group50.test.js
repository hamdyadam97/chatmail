'use strict';
// S2 — 50-member group + asynchronous delivery: sender commits/sends while
// 10 members are "offline"; offline members fetch later and decrypt in order.
const test = require('node:test');
const assert = require('node:assert');
const { device, u8, txt, DumbServer, memberIdentities } = require('./helpers');

test('S2: 50-member group, 10 offline members catch up in order', () => {
  const server = new DumbServer();
  const gid = u8('g-s2');
  const N = 50;
  const OFFLINE = new Set(['user5|dev1', 'user12|dev1', 'user21|dev1', 'user28|dev1', 'user33|dev1', 'user40|dev1', 'user44|dev1', 'user47|dev1', 'user3|dev1', 'user9|dev1']);

  const ids = memberIdentities(N);
  const members = ids.map((id, i) => device(id, 1000 + i));

  // Creator adds the other 49 in a single commit.
  const others = members.slice(1);
  const out = members[0].create_group(gid, others.map((m) => m.key_package()));
  const commit = out[0];
  const welcomes = out.slice(1);

  // Everyone joins via their own Welcome.
  others.forEach((m, i) => {
    m.join_from_welcome(welcomes.length === others.length ? welcomes[i] : welcomes[0]);
  });

  // All 50 members process the creation commit EXCEPT the added ones already
  // joined via welcome — nobody processes the add-commit (they joined post-commit).
  // Sanity: roster on creator side.
  const roster = members[0].member_identities(gid);
  assert.strictEqual(roster.length, N, '50 members in group');

  // Sender sends 5 application messages; online members get them immediately,
  // offline members' payloads queue up at the dumb server.
  const plaintexts = [];
  for (let i = 1; i <= 5; i++) {
    const pt = `broadcast ${i}`;
    plaintexts.push(pt);
    const ct = members[0].encrypt(gid, u8(pt));
    // deliver to online members directly, queue for offline
    for (let k = 1; k < N; k++) {
      if (OFFLINE.has(ids[k])) {
        server.post(ids[k], ct);
      } else {
        const r = members[k].process(gid, ct);
        assert.strictEqual(txt(r.plaintext), pt, `online member ${k} decrypts msg ${i}`);
      }
    }
  }

  // Offline members come back and fetch their queues in order.
  for (const id of OFFLINE) {
    const k = ids.indexOf(id);
    const queue = server.fetchAll(id);
    assert.strictEqual(queue.length, 5, `${id} has 5 queued messages`);
    queue.forEach((ct, i) => {
      const r = members[k].process(gid, ct);
      assert.strictEqual(r.type, 'application');
      assert.strictEqual(txt(r.plaintext), plaintexts[i], `${id} in-order decrypt`);
    });
  }

  // Creator's own view of the epoch is unchanged (no commits since creation).
  assert.strictEqual(Number(members[0].epoch(gid)), 1);
  console.log(`S2 OK: ${N} members, ${OFFLINE.size} offline, 5 msgs each caught up in order`);
});
