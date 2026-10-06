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

// The rule ids the host is allowed to name come from the model itself, not from a literal here:
// RULES is the single source of truth for which ids exist, so adding a rule cannot leave this
// boundary accepting a row that the automaton would then throw on.
import { RULES } from '../game/model.mjs';

/** Decode a settled lifeboat `gameState` blob: (rule, board, pop, payout) as four 32-byte words. */
export function words(hex) {
  const s = String(hex).replace(/^0x/, '');
  if (s.length < 256) return null;
  try {
    return {
      rule: Number(BigInt('0x' + s.slice(0, 64))),
      board: Number(BigInt('0x' + s.slice(64, 128)) & 0xfffffn),
      pop: Number(BigInt('0x' + s.slice(128, 192))),
      payout: BigInt('0x' + s.slice(192, 256)),
    };
  } catch {
    // BigInt() raises SyntaxError on any non-hex digit, and this decode runs INSIDE
    // pickSettledRow's filter. An unguarded throw therefore took the WHOLE feed down: the valid row
    // sitting next to a malformed one was never rendered either, and the SyntaxError escaped
    // pollSnapshot with `busy` already latched. Decoding is total — an undecodable word is null.
    return null;
  }
}

/**
 * A row is renderable when it carries a parseable settled gameState AND a rule the model has.
 *
 * The rule range check is the boundary app.js does not have: it hands `parsed.rule` straight to
 * evolution() -> tableFor(), which throws `unknown rule N` for anything outside RULES. That throw
 * escapes pollSnapshot after `busy` was set true, and every interaction gate (selectRule, onDemo,
 * onBet, the next poll) returns early while busy — so one bad rule word wedges the page until a
 * reload. The contract only ever writes RULES[].id, so anything else is a hostile or malformed
 * host, and it is treated like every other malformed row: not renderable, nothing thrown.
 */
export function isSettledRow(row) {
  const raw = row && row.raw ? row.raw : null;
  if (!raw || typeof raw.gameState !== 'string' || raw.gameState === '0x') return false;
  const parsed = words(raw.gameState);
  if (parsed === null) return false;
  return parsed.rule >= 0 && parsed.rule < RULES.length;
}

/** The key that identifies a session row. */
export const keyOf = (row) => String((row && (row.sessionKey ?? row.sessionId)) ?? '');

/**
 * The id the host wants back in `revealOutcome({ sessionId })`. This is deliberately NOT keyOf:
 * the feed key prefers sessionKey (the id openSession returns, which is what pendingKey holds),
 * while revealOutcome is addressed by sessionId. Deriving the two in separate files is how they
 * drifted — a row carrying sessionKey but not sessionId produced a null id and the reveal was
 * never reported. Both identifiers now come from here, and a row with no sessionId reports none:
 * announcing a round against the wrong session id is worse than announcing nothing.
 */
export const sessionIdOf = (row) => (row && row.sessionId != null ? row.sessionId : null);

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
 * row has been shown. Returns { row, key, parsed, sessionId } or null when there is nothing (new) to
 * show. `sessionId` is the host reveal id for this row (see sessionIdOf); the caller must read it
 * from here rather than from `row`, so the feed key and the reveal id cannot drift apart again.
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

  return { row, key: keyOf(row), parsed: words(row.raw.gameState), sessionId: sessionIdOf(row) };
}
