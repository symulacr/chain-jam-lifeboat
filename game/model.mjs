/**
 * LIFEBOAT — a cellular-automaton census dealt by one VRF word.
 *
 * THE ONE THING THAT MATTERS HERE (research/wave5-contradictions.md C1):
 *   `makeRng` is counter-based. Every step is 32-bit integer arithmetic
 *   (`Math.imul`, `>>> 0`, `^`, `+`). Nothing accumulates a float across rounds, so
 *   the round index cannot pass 2^53 and collapse onto duplicate seeds. The Wave-3
 *   `seed0 + round * 2654435761` sampler is exactly the bug this file must not repeat.
 *
 * OUTCOME IS A PURE FUNCTION OF THE WORD.
 *   The word is folded to 20 bits (XOR of the four big-endian u32 lanes; the XOR of
 *   independent uniform words is uniform, so the folded value is uniform over 2^20).
 *   Those 20 bits ARE the initial board, one bit per berth. Therefore the reachable
 *   board space is exactly 2^20, it is fully enumerable, and EXPECTED_RTP_BPS below is
 *   an EXACT enumeration, not a simulation. See rtp-proof.md and tools/tune.mjs.
 *
 * THE DECISION AXIS (the novelty claim, wave5-agent2-novelty.md §3b N1):
 *   The player locks a LIFE RULE before the wager. The same board evolves differently
 *   under each rule, so the choice is real. The three rules are tuned to pay the SAME
 *   expected return within 21 bps (see tools/tune.mjs), so the choice is not a
 *   hidden "pick the highest-RTP button" — it is a choice about the shape of the
 *   distribution, which is the whole point.
 *
 * PITCH DISCIPLINE: this is NOT "watch it spread". The payout is the CENSUS at
 *   generation K plus the rule the player locked.
 */

export const SLUG = 'lifeboat';

export const ROWS = 4;
export const COLS = 5;
export const CELLS = ROWS * COLS; // 20 berths
export const ROWMASK = (1 << COLS) - 1;
export const GENERATIONS = 14; // fixed and identical for every rule — fairness
export const MIN_STAT = 0;
export const MAX_STAT = CELLS;

/**
 * The three selectable rules, in standard B/S notation. A rule is a birth mask and a
 * survival mask over neighbour counts 0..8 (bit n set = that count triggers).
 * Index 0 is the DEFAULT: it is the lowest-paying of the three, so the declared RTP
 * is the floor across every choice the player can make.
 *
 * WHY THESE THREE. Every rule here was measured on this exact 20-berth torus at
 * K=14 by full enumeration (tools/tune.mjs). The two famous rules do NOT survive the
 * small torus: B3/S23 (classic) is extinct on 82.9% of all 2^20 boards and B36/S23
 * (HighLife) on 72.6%, which makes either a degenerate choice. The three below have
 * distinct, non-degenerate censuses AND land within 21 bps of each other under the
 * single shared paytable, so locking a rule is a real choice about the SHAPE of the
 * distribution, not a search for the best-paying button. See rtp-proof.md.
 */
export const RULES = [
  { id: 0, label: 'B25/S014', birth: 0b000100100, survive: 0b000010011, note: 'isolated berths survive — the deck drifts' },
  { id: 1, label: 'B25/S23', birth: 0b000100100, survive: 0b000001100, note: 'the same births, no lonely survivors — it pulses' },
  { id: 2, label: 'B24/S23', birth: 0b000010100, survive: 0b000001100, note: 'one easier birth — booms then collapses' },
];
export const DEFAULT_RULE = 0;

// ---------------------------------------------------------------- the automaton
// Row-major, toroidal. Bit i of the board is berth (floor(i/5), i%5).
// One generation is four table lookups: next[r] = T[cur[r]][cur[r-1]][cur[r+1]].
// The table is the exact Moore-neighbourhood transition for a 5-wide row, so it is
// the same function Solidity computes by direct neighbour counting.
const tables = new Array(RULES.length).fill(null);

function buildTable(birth, survive) {
  const T = new Uint8Array(32 * 32 * 32);
  for (let me = 0; me < 32; me++) {
    for (let north = 0; north < 32; north++) {
      for (let south = 0; south < 32; south++) {
        let out = 0;
        for (let c = 0; c < COLS; c++) {
          const left = (c + COLS - 1) % COLS;
          const right = (c + 1) % COLS;
          const n =
            ((me >> left) & 1) + ((me >> right) & 1) +
            ((north >> left) & 1) + ((north >> c) & 1) + ((north >> right) & 1) +
            ((south >> left) & 1) + ((south >> c) & 1) + ((south >> right) & 1);
          const alive = (me >> c) & 1;
          if (alive ? (survive >> n) & 1 : (birth >> n) & 1) out |= 1 << c;
        }
        T[(me << 10) | (north << 5) | south] = out;
      }
    }
  }
  return T;
}

export function tableFor(ruleId) {
  const r = RULES[ruleId];
  if (!r) throw new Error(`unknown rule ${ruleId}`);
  if (!tables[r.id]) tables[r.id] = buildTable(r.birth, r.survive);
  return tables[r.id];
}

/** One generation of the chosen rule over the whole torus. */
export function step(board, ruleId) {
  const T = tableFor(ruleId);
  const r0 = board & ROWMASK;
  const r1 = (board >>> 5) & ROWMASK;
  const r2 = (board >>> 10) & ROWMASK;
  const r3 = (board >>> 15) & ROWMASK;
  const n0 = T[(r0 << 10) | (r3 << 5) | r1];
  const n1 = T[(r1 << 10) | (r0 << 5) | r2];
  const n2 = T[(r2 << 10) | (r1 << 5) | r3];
  const n3 = T[(r3 << 10) | (r2 << 5) | r0];
  return (n0 | (n1 << 5) | (n2 << 10) | (n3 << 15)) >>> 0;
}

function popcount5(x) {
  let k = x - ((x >> 1) & 0x55555555);
  k = (k & 0x33333333) + ((k >> 2) & 0x33333333);
  k = (k + (k >> 4)) & 0x0f0f0f0f;
  return (Math.imul(k, 0x01010101) >> 24) & 0x3f;
}

/** Live population of a board (0..20). */
export function population(board) {
  return popcount5(board & 0xfffff);
}

/** Run GENERATIONS generations and return the live population of the final frame. */
export function census(board, ruleId) {
  let b = board >>> 0;
  for (let g = 0; g < GENERATIONS; g++) b = step(b, ruleId);
  return population(b);
}

/** The 20-bit board a word deals. */
export function wordTo20(word) {
  const s = String(word);
  let x = 0;
  for (let lane = 0; lane < 4; lane++) {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const c = s.charCodeAt(2 + lane * 8 + i);
      const d = c <= 57 ? c - 48 : (c | 32) - 87;
      v = (v * 16 + d) >>> 0;
    }
    x = (x ^ v) >>> 0;
  }
  return x & 0xfffff;
}

/** Every frame from generation 0 to GENERATIONS, for the reveal. Frame 0 is the deal. */
export function evolution(board, ruleId) {
  const frames = [board >>> 0];
  let b = board >>> 0;
  for (let g = 0; g < GENERATIONS; g++) {
    b = step(b, ruleId);
    frames.push(b);
  }
  return frames;
}

// ---------------------------------------------------------------- paytable
// Read off the EXACT 2^20 enumeration per rule in tools/tune.mjs:
//     berths 0..5 survivors      -> 0x    (the colony is lost)
//     berths 6..7 survivors      -> 1.2x
//     berths 8..12 survivors     -> 2x
//     berths 13..20 survivors    -> 16x
// The same table is used for all three rules on purpose: the three exact RTPs land
// within 21 bps of each other, so locking a rule is a real choice about the shape of
// the census, not a search for the best-paying button.
export const BANDS = [
  { min: 0, max: 5, mult: 0 },
  { min: 6, max: 7, mult: 1.2 },
  { min: 8, max: 12, mult: 2 },
  { min: 13, max: 20, mult: 16 },
];

// exact (rule 0, B25/S014) — see rtp-proof.md for the integer derivation
export const EXPECTED_RTP_BPS = 9574;
/** Exact per-rule RTP in bps, each from a full 2^20 enumeration. rule 0 is the floor. */
export const RULE_RTP_BPS = [9574.2035, 9575.7103, 9594.7456];

export function bandOf(stat) {
  for (let i = 0; i < BANDS.length; i++) {
    if (stat >= BANDS[i].min && stat <= BANDS[i].max) return BANDS[i].mult;
  }
  return 0;
}

/** The census under an explicitly locked rule. The rule is fixed before the word. */
export function outcomeWithRule(word, ruleId) {
  const stat = census(wordTo20(word), ruleId);
  return { stat, mult: bandOf(stat), ruleId };
}

/**
 * The harness-verified entry point: the DEFAULT rule only, so it is pure in the word.
 * It is literally outcomeWithRule(word, DEFAULT_RULE) — same shape, same numbers — so a
 * reviewer can check that identity directly.
 */
export function outcome(word) {
  return outcomeWithRule(word, DEFAULT_RULE);
}

// ---------------------------------------------------------------- sampler
function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Counter-based round sampler. `round` is folded into four independent 32-bit lanes and
 * nothing is accumulated, so no float precision is lost and the stream is exact for every
 * integer round; it is a bijection of the round index within each 2^32-round window.
 * Collision-freedom across ALL windows up to 2^52 is NOT proven here (no collision was found
 * in any swept window, but no proof is offered). See research/wave5-contradictions.md C1 and
 * docs/adversarial.md.
 */
export function makeRng(seed0, round) {
  const s = String(seed0).replace(/^0x/, '');
  const r = Number(round);
  const lo = r >>> 0;
  const hi = Math.floor(r / 4294967296) >>> 0;
  let a = (0x811c9dc5 ^ lo) >>> 0;
  let b = Math.imul(lo, 0x9e3779b1) >>> 0;
  let c = (Math.imul(lo, 0x85ebca6b) ^ hi) >>> 0;
  let d = (Math.imul(lo, 0xc2b2ae35) ^ Math.imul(hi + 1, 0x27d4eb2f)) >>> 0;
  for (let i = 0; i + 1 < s.length; i += 2) {
    const byte = parseInt(s.slice(i, i + 2), 16);
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b ^ (byte + i), 0x85ebca6b) >>> 0;
    c = (c + byte + Math.imul(c, 0x27d4eb2f)) >>> 0;
    d = Math.imul(d ^ (byte | (i << 3)), 0x9e3779b1) >>> 0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  let x = a;
  let y = b;
  let z = c;
  let w = d;
  for (let k = 0; k < 8; k++) {
    x = fmix32((x + 0x9e3779b9 + k) >>> 0);
    y = fmix32((Math.imul(y, 0x85ebca6b) ^ k) >>> 0);
    z = fmix32((z ^ Math.imul(k + 1, 0x27d4eb2f)) >>> 0);
    w = fmix32((w + x + y + z) >>> 0);
    dv.setUint32(k * 4, (x ^ y ^ z ^ w) >>> 0, false);
  }
  let hex = '';
  for (let i = 0; i < 32; i++) hex += out[i].toString(16).padStart(2, '0');
  return '0x' + hex;
}
