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
import { isSettledRow, keyOf, pickSettledRow, words } from '../src/selection.mjs';

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

console.log(`\n${pass} passed`);
