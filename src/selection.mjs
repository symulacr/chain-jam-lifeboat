/**
 * LIFEBOAT — pure session-selection logic, extracted from app.js so it can be unit-tested in Node
 * without a DOM.
 *
 * WHY: the original `pollSnapshot` looped over EVERY unrendered settled row and started a reveal for
 * each; each reveal called `clearTimers()`, so the LAST one processed won — in the newest-first feed
 * that is the OLDEST settled row. The page therefore replayed a stale census instead of the round
 * just played (the log <-> UI parity drift). The selection is now a pure function covered by
 * tests/selection.test.mjs.
 *
 * The caller passes the SET of session keys already shown — not a single "last" key. A single
 * last-key is NOT enough to drain a backlog: excluding only the most recent key makes "oldest
 * unrendered" ping-pong between the two oldest rows forever — it re-renders them, skips every row
 * between them, and never returns null. Re-derived independently in the final audit (a backlog of 4
 * rendered only 3 distinct rows; a backlog of 5 dropped two). With the set, every snapshot advances
 * strictly, so a backlog drains in a bounded number of snapshots and then rests (returns null).
 */

/** Decode a settled lifeboat `gameState` blob: (rule, board, pop, payout) as four 32-byte words. */
export function words(hex) {
  const s = String(hex).replace(/^0x/, '');
  if (s.length < 256) return null;
  return {
    rule: Number(BigInt('0x' + s.slice(0, 64))),
    board: Number(BigInt('0x' + s.slice(64, 128)) & 0xfffffn),
    pop: Number(BigInt('0x' + s.slice(128, 192))),
    payout: BigInt('0x' + s.slice(192, 256)),
  };
}

/** A row is renderable when it carries a parseable settled gameState. */
export function isSettledRow(row) {
  const raw = row && row.raw ? row.raw : null;
  if (!raw || typeof raw.gameState !== 'string' || raw.gameState === '0x') return false;
  return words(raw.gameState) !== null;
}

/** The key that identifies a session row. */
export const keyOf = (row) => String((row && (row.sessionKey ?? row.sessionId)) ?? '');

/**
 * Normalise the rendered-keys argument to a Set. A bare string is rejected rather than silently
 * accepted: passing a single key is exactly the bug this module fixes, so it must fail loudly
 * instead of reintroducing the non-terminating drain.
 */
function shownSet(renderedKeys) {
  if (renderedKeys instanceof Set) return renderedKeys;
  if (Array.isArray(renderedKeys)) return new Set(renderedKeys.map(String));
  if (renderedKeys === null || renderedKeys === undefined) return new Set();
  throw new TypeError('renderedKeys must be a Set, an array of keys, or null');
}

/**
 * Pick ONE settled row to render this snapshot.
 *
 * Order of preference:
 *   1. never start a reveal while one is animating (`busy`) — that interruption is what made the
 *      original loop's "last one wins" race possible;
 *   2. the session THIS page opened (`pendingKey`), if it has settled and is not yet shown;
 *   3. on a fresh page (nothing shown yet), the newest settled row (the feed is newest-first);
 *   4. otherwise the OLDEST not-yet-shown settled row, so successive snapshots DRAIN any backlog
 *      oldest-first instead of silently dropping all but the newest.
 *
 * `renderedKeys` is the set of keys already shown; the caller adds `result.key` to it after each
 * reveal. Because the set grows monotonically, the drain terminates (returns null) once every settled
 * row has been shown. Returns { row, key, parsed } or null when there is nothing (new) to show.
 */
export function pickSettledRow(items, pendingKey, renderedKeys, busy = false) {
  if (busy) return null;
  const settled = (Array.isArray(items) ? items : []).filter(isSettledRow);
  if (settled.length === 0) return null;
  const shown = shownSet(renderedKeys);
  const unrendered = settled.filter((r) => !shown.has(keyOf(r)));
  if (unrendered.length === 0) return null;

  let row = null;
  if (pendingKey !== null && pendingKey !== undefined) {
    row = unrendered.find((r) => keyOf(r) === String(pendingKey)) || null;
  }
  if (!row) row = shown.size === 0 ? settled[0] : unrendered[unrendered.length - 1];

  return { row, key: keyOf(row), parsed: words(row.raw.gameState) };
}
