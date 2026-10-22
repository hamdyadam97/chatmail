'use strict';
// S5 — Performance & sizes (docs/phase1/02 §2.5 item 4 and 07 §7.2 "الأداء"):
// commit generation time at 100 members, application message size at 50,
// serialized group state size per member, key package size.
// Numbers print as "PERF <metric>=<value>" for the report.
const test = require('node:test');
const assert = require('node:assert');
const { device, u8, memberIdentities } = require('./helpers');

// If the MLS rules merge welcomes into a single message, everyone uses [0];
// otherwise each joiner takes their own welcome by position.
function welcomeFor(welcomes, i, memberCount) {
  return welcomes.length === memberCount ? welcomes[i] : welcomes[0];
}

function ms(t0, t1) {
  return Number(t1 - t0) / 1e6;
}

test('S5: performance numbers', { timeout: 300000 }, () => {
  // Key package size.
  const probe = device('probe|dev1', 1);
  const kpSize = probe.key_package().length;
  console.log(`PERF keypackage_bytes=${kpSize}`);

  // 50-member group: application message size + per-member serialized state.
  const N50 = 50;
  const ids50 = memberIdentities(N50, 'f');
  const members50 = ids50.map((id, i) => device(id, 2000 + i));
  const t50a = process.hrtime.bigint();
  const out50 = members50[0].create_group(u8('g-s5-50'), members50.slice(1).map((m) => m.key_package()));
  const t50b = process.hrtime.bigint();
  const create50ms = ms(t50a, t50b);
  const commit50 = out50[0].length;
  console.log(`PERF group50_create_ms=${create50ms.toFixed(1)} commit_size_50=${commit50}`);
  members50.slice(1).forEach((m, i) => {
    m.join_from_welcome(welcomeFor(out50.slice(1), i, members50.slice(1).length));
  });

  const ct50 = members50[0].encrypt(u8('g-s5-50'), u8('performance probe message at fifty members'));
  const appMsg50 = ct50.length;
  // State blob includes the current snapshot + retained prior epochs + pending
  // key packages, as the browser's IndexedDB record will.
  const state50 = members50[1].export_state(u8('g-s5-50')).length;
  console.log(`PERF appmsg_bytes_50=${appMsg50} state_bytes_50=${state50}`);

  // 100-member group: creation + a commit issued at 100 members (add one more).
  const N100 = 100;
  const ids100 = memberIdentities(N100, 'h');
  const members100 = ids100.map((id, i) => device(id, 3000 + i));
  const t100a = process.hrtime.bigint();
  const out100 = members100[0].create_group(u8('g-s5-100'), members100.slice(1).map((m) => m.key_package()));
  const t100b = process.hrtime.bigint();
  console.log(`PERF group100_create_ms=${ms(t100a, t100b).toFixed(1)}`);
  members100.slice(1).forEach((m, i) => {
    m.join_from_welcome(welcomeFor(out100.slice(1), i, members100.slice(1).length));
  });

  const extra = device('h100|dev1', 4000);
  const t0 = process.hrtime.bigint();
  members100[0].add_member(u8('g-s5-100'), extra.key_package());
  const t1 = process.hrtime.bigint();
  const commit100ms = ms(t0, t1);
  console.log(`PERF commit_ms_at_100=${commit100ms.toFixed(1)}`);
  const state100 = members100[0].export_state(u8('g-s5-100')).length;
  console.log(`PERF state_bytes_100=${state100}`);

  // Sanity assertions so the perf test still gates correctness.
  assert.ok(out100.length >= 2, 'creation commit produced commit + welcome(s)');
  console.log(`PERF welcomes_at_creation=${out100.length - 1}`);
  assert.ok(appMsg50 > 0 && state50 > 0 && commit100ms > 0);
});
