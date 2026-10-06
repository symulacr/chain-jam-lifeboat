#!/usr/bin/env node
/**
 * lifeboat session-selection tests — pure, no DOM, no chain.
 *
 *   node tests/selection.test.mjs      (or `npm test`)
 *
 * Covers the failure modes of the log<->UI parity fix: a single session, TWO sessions in flight in
 * either settle order, a reload where the in-memory pendingKey is lost, a cancelled pending round
 * that never settles, an already-rendered newest row, malformed rows — and, crucially, that a
 * BACKLOG of settled rows drains fully (each row exactly once) and then RESTS.
 *
 * The backlog test is the regression for the final audit's finding 2(d): a single `lastRenderedKey`
 * is not enough to drain a backlog, because excluding only the most recent key makes "oldest
 * unrendered" ping-pong between the two oldest rows — re-rendering them, skipping the rows between
 * them, and never terminating. The selection now takes a SET of already-shown keys.
 */
import assert from 'node:assert/strict';
import { RULES, tableFor } from '../game/model.mjs';
import { isSettledRow, keyOf, pickSettledRow, sessionIdOf, words } from '../src/selection.mjs';

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { console.log(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const gs = (rule, board, pop, payout) => '0x' + w(rule) + w(board) + w(pop) + w(payout);
const row = (key, state) => ({ sessionKey: key, raw: { gameState: state } });
const unsettled = (key) => ({ sessionKey: key, raw: { gameState: '0x' } });
const fresh = () => new Set();
const shown = (...keys) => new Set(keys);

console.log('lifeboat selection tests');

test('words decodes the four settled words', () => {
  const v = words(gs(2, 423807, 10, 20000000000000000000n));
  assert.equal(v.rule, 2);
  assert.equal(v.board, 423807);
  assert.equal(v.pop, 10);
  assert.equal(v.payout, 20000000000000000000n);
});

test('isSettledRow rejects empty / short / missing gameState', () => {
  assert.equal(isSettledRow(unsettled('a')), false);
  assert.equal(isSettledRow({ raw: { gameState: '0xdead' } }), false);
  assert.equal(isSettledRow({}), false);
  assert.equal(isSettledRow(row('a', gs(0, 1, 1, 0n))), true);
});

test('keyOf prefers sessionKey, falls back to sessionId', () => {
  assert.equal(keyOf({ sessionKey: 'k' }), 'k');
  assert.equal(keyOf({ sessionId: 'i' }), 'i');
  assert.equal(keyOf({}), '');
});

test('a single settled row is picked', () => {
  const p = pickSettledRow([row('a', gs(0, 1, 1, 0n))], null, fresh());
  assert.equal(p.key, 'a');
  assert.equal(p.parsed.pop, 1);
});

test('nothing new renders nothing (empty, unsettled, or already-rendered)', () => {
  assert.equal(pickSettledRow([], null, fresh()), null);
  assert.equal(pickSettledRow([unsettled('a')], null, fresh()), null);
  assert.equal(pickSettledRow([row('a', gs(0, 1, 1, 0n))], null, shown('a')), null);
});

test('reload (no pendingKey) renders the NEWEST settled row', () => {
  const p = pickSettledRow([row('new', gs(0, 5, 5, 0n)), row('old', gs(0, 4, 4, 0n))], null, fresh());
  assert.equal(p.key, 'new');
});

test('a pendingKey that has settled wins over a newer unrelated row', () => {
  const p = pickSettledRow([row('other', gs(0, 9, 9, 0n)), row('mine', gs(2, 3, 8, 2000000000000000000n))], 'mine', fresh());
  assert.equal(p.key, 'mine');
  assert.equal(p.parsed.rule, 2);
  assert.equal(p.parsed.pop, 8);
});

test('two in flight, older settles first: renders the older, no wedge; then the pending', () => {
  const first = pickSettledRow([unsettled('B'), row('A', gs(0, 6, 6, 0n))], 'B', fresh());
  assert.equal(first.key, 'A');
  const second = pickSettledRow([row('B', gs(1, 7, 7, 0n)), row('A', gs(0, 6, 6, 0n))], 'B', shown('A'));
  assert.equal(second.key, 'B');
  assert.equal(second.parsed.rule, 1);
});

test('cancelled pending never settles: no wedge, and a later settlement still renders', () => {
  assert.equal(pickSettledRow([row('old', gs(0, 4, 4, 0n))], 'CANCELLED', shown('old')), null);
  const p = pickSettledRow([row('new', gs(2, 8, 8, 0n)), row('old', gs(0, 4, 4, 0n))], 'CANCELLED', shown('old'));
  assert.equal(p.key, 'new');
});

test('malformed rows are ignored', () => {
  const p = pickSettledRow([{}, { raw: {} }, { raw: { gameState: 5 } }, row('ok', gs(0, 3, 3, 0n))], null, fresh());
  assert.equal(p.key, 'ok');
});

test('a reveal in flight is never interrupted (busy -> null)', () => {
  assert.equal(pickSettledRow([row('a', gs(0, 1, 1, 0n))], null, fresh(), true), null);
  assert.equal(pickSettledRow([row('a', gs(0, 1, 1, 0n))], 'a', fresh(), true), null);
});

test('two rounds settling in one snapshot are both revealed, over successive snapshots', () => {
  // both settled before the next snapshot; pending is the newer one
  const items = [row('B', gs(1, 7, 7, 0n)), row('A', gs(0, 6, 6, 0n))];
  const first = pickSettledRow(items, 'B', shown('old'));
  assert.equal(first.key, 'B');
  const second = pickSettledRow(items, 'B', shown('old', 'B'));
  assert.equal(second.key, 'A', 'the older round must still be revealed, not silently dropped');
});

test('a backlog drains oldest-first once a fresh page has shown the newest', () => {
  const items = [row('n', gs(0, 9, 9, 0n)), row('m', gs(0, 8, 8, 0n)), row('o', gs(0, 7, 7, 0n))];
  assert.equal(pickSettledRow(items, null, fresh()).key, 'n');        // fresh: newest
  assert.equal(pickSettledRow(items, null, shown('n')).key, 'o');     // then oldest unrendered
  assert.equal(pickSettledRow(items, null, shown('n', 'o')).key, 'm');
  assert.equal(pickSettledRow(items, null, shown('n', 'o', 'm')), null, 'drain rests');
});

test('a newly settled row is shown without re-rendering the older shown rows', () => {
  const shownSet = new Set();
  const feed1 = [row('a', gs(0, 1, 1, 0n))];
  let p = pickSettledRow(feed1, null, shownSet);
  assert.equal(p.key, 'a');
  shownSet.add(p.key);
  assert.equal(pickSettledRow(feed1, null, shownSet), null);

  const feed2 = [row('b', gs(0, 2, 2, 0n)), row('a', gs(0, 1, 1, 0n))];
  p = pickSettledRow(feed2, null, shownSet);
  assert.equal(p.key, 'b');
  shownSet.add(p.key);
  assert.equal(pickSettledRow(feed2, null, shownSet), null, 'never re-renders a or b');
});

test('REGRESSION 2(d): a backlog of N settled rows drains fully (each once) then rests', () => {
  for (let n = 1; n <= 8; n++) {
    const items = Array.from({ length: n }, (_, i) => row('s' + i, gs(0, i + 1, i + 1, 0n)));
    const want = items.map((r) => r.sessionKey);
    const shownSet = new Set();
    const seq = [];
    for (let guard = 0; guard <= n + 1; guard++) { // bounded: must terminate within n+1 snapshots
      const p = pickSettledRow(items, null, shownSet);
      if (!p) break;
      shownSet.add(p.key);
      seq.push(p.key);
    }
    assert.equal(seq.length, n, `n=${n}: rendered ${seq.length}/${n} rows (seq=${seq})`);
    assert.equal(new Set(seq).size, n, `n=${n}: duplicate renders (seq=${seq})`);
    assert.deepEqual([...seq].sort(), [...want].sort(), `n=${n}: every row rendered exactly once`);
    assert.equal(pickSettledRow(items, null, shownSet), null, `n=${n}: drain must rest (not loop)`);
  }
});

test('REGRESSION 2(d): the drain terminates even as new rows keep arriving', () => {
  // Simulate a live feed: each snapshot adds one newer row while the drain catches up. Every distinct
  // row must be shown exactly once and the loop must still terminate.
  const items = [];
  const shownSet = new Set();
  const seq = [];
  let snapshots = 0;
  while (items.length < 6 || seq.length < 6) {
    items.unshift(row('s' + items.length, gs(0, items.length + 1, items.length + 1, 0n)));
    for (let step = 0; step < 3; step++) { // up to 3 reveals per snapshot
      const p = pickSettledRow(items, null, shownSet);
      if (!p) break;
      shownSet.add(p.key);
      seq.push(p.key);
    }
    if (++snapshots > 50) break;
  }
  assert.equal(new Set(seq).size, seq.length, `duplicate renders: ${seq}`);
  assert.equal(new Set(seq).size, items.length, `showed ${new Set(seq).size} of ${items.length}`);
  assert.ok(snapshots <= 50, 'drain must terminate');
});

test('a single-key caller is REJECTED (cannot silently reintroduce the loop bug)', () => {
  assert.throws(() => pickSettledRow([row('a', gs(0, 1, 1, 0n))], null, 'a'), /renderedKeys must be a Set/);
});

test('an array of keys is accepted', () => {
  assert.equal(pickSettledRow([row('a', gs(0, 1, 1, 0n))], null, ['a']), null);
  assert.equal(pickSettledRow([row('a', gs(0, 1, 1, 0n))], null, []).key, 'a');
});

// ---------------------------------------------------------------- Wave 2: hostile feeds
// The three tests below are the hostile/malformed-host boundary. Each one had to fail against the
// pre-fix code, which is why they assert on what the PAGE does with a bad row, not on `words()`.

test('A: a non-hex gameState is contained to its own row — valid rows still render', () => {
  // words() called BigInt() unguarded, so the SyntaxError was raised INSIDE pickSettledRow's
  // .filter() and escaped into pollSnapshot with `busy` latched: one bad row blanked the whole feed
  // and only a reload recovered. Decoding must be total — null for anything undecodable.
  const nonHex = '0x' + 'zz'.repeat(128);
  assert.equal(words(nonHex), null, 'words() must return null for an undecodable blob, not throw');
  assert.equal(isSettledRow(row('bad', nonHex)), false);
  const halfHex = '0x' + w(1) + 'gg'.repeat(32) + w(3) + w(4);
  assert.equal(isSettledRow(row('half', halfHex)), false, 'a half-hex word is equally undecodable');

  const feed = [row('bad', nonHex), row('good', gs(1, 7, 7, 0n))];
  const p = pickSettledRow(feed, null, fresh());
  assert.equal(p.key, 'good', 'a valid row beside a malformed one must still render');
  assert.equal(p.parsed.rule, 1);
  // and the feed keeps moving: the malformed row must not wedge the NEXT snapshot either
  assert.equal(pickSettledRow(feed, null, shown('good')), null);
  const feed2 = [row('bad', nonHex), row('good', gs(1, 7, 7, 0n)), row('next', gs(0, 5, 5, 0n))];
  assert.equal(pickSettledRow(feed2, null, shown('good')).key, 'next');
});

test('B: a settled row encoding a rule outside RULES is not renderable', () => {
  // WHY this is a wedge and not a cosmetic mismatch: app.js hands parsed.rule straight to
  // evolution() -> tableFor(), which throws on an unknown id, AFTER it has latched busy = true.
  // Every interaction gate then returns early (selectRule/onDemo/onBet/poll), so the page is dead
  // until reload. The contract only writes RULES[].id, so anything else is a malformed host.
  assert.throws(() => tableFor(RULES.length), /unknown rule/, 'the model really does throw on a bad rule');
  const oor = (rule, k) => row(k, gs(rule, 0xaaa, 7, 0n));
  for (const rule of [RULES.length, RULES.length + 1, 9, 255]) {
    assert.equal(isSettledRow(oor(rule, 'oor')), false, `rule ${rule} is outside the model and must be rejected`);
  }
  // a hostile NEWEST row (the feed is newest-first) must not shadow the round the page owes the player
  const p = pickSettledRow([oor(9, 'oor9'), row('good', gs(2, 3, 8, 0n))], null, fresh());
  assert.equal(p.key, 'good');
  assert.equal(p.parsed.rule, 2);
  assert.equal(pickSettledRow([oor(9, 'oor9'), oor(10, 'oor10')], null, fresh()), null,
    'a feed of nothing but out-of-range rules renders nothing rather than throwing');
  for (const r of RULES) {
    assert.equal(isSettledRow(row('r' + r.id, gs(r.id, 1, 1, 0n))), true, `rule ${r.id} must stay renderable`);
  }
});

test('C: the picked row carries the host reveal id next to the feed key', () => {
  // keyOf (feed identity, sessionKey-first) and app.js's revealOutcome(sessionId) used to be derived
  // in two files from two different fields, so they could disagree. selection.mjs now owns both and
  // hands them to the caller together; the reveal id is never invented from the key, because
  // reporting a round against the wrong session id is worse than reporting none.
  const r = { sessionKey: 'K', sessionId: 7, raw: { gameState: gs(1, 7, 7, 0n) } };
  const p = pickSettledRow([r], null, fresh());
  assert.equal(p.key, 'K');
  assert.equal(p.sessionId, 7, 'app.js must read the picked id, not row.sessionId, to stay in step');
  assert.equal(sessionIdOf(r), 7);
  assert.equal(sessionIdOf({ sessionKey: 'K' }), null, 'no session id means no revealOutcome call');
  assert.equal(sessionIdOf(null), null);
  const keyOnly = pickSettledRow([{ sessionKey: 'K2', raw: { gameState: gs(0, 1, 1, 0n) } }], null, fresh());
  assert.equal(keyOnly.key, 'K2', 'a key-only row is still renderable');
  assert.equal(keyOnly.sessionId, null);
});

console.log(`\n${pass} passed`);
