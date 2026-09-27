#!/usr/bin/env node
/**
 * lifeboat model tests.
 *
 *   node tests/model.test.mjs      (or `npm test`)
 *
 * Ported verbatim from the verified jam-candidates/lifeboat/tests/model.test.mjs. The only change
 * is the model import path (`../model.mjs` -> `../game/model.mjs`); every assertion is unchanged.
 *
 * The automaton is checked against an INDEPENDENT naive implementation that counts
 * Moore neighbours directly on (row, col) with explicit torus wrapping, so the shipped
 * row-lookup table is not trusted on its own word. The RTP test re-derives the
 * declaration by enumerating all 2^20 decks for every rule.
 */
import assert from 'node:assert/strict';
import {
  BANDS, CELLS, COLS, DEFAULT_RULE, EXPECTED_RTP_BPS, GENERATIONS, MAX_STAT, ROWS, RULES,
  RULE_RTP_BPS, bandOf, census, evolution, makeRng, outcome, outcomeWithRule, population,
  step, wordTo20,
} from '../game/model.mjs';

let pass = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};
const word = b => '0x' + b.toString(16).padStart(8, '0').padEnd(64, '0');

/** Independent naive automaton: no lookup table, explicit torus arithmetic. */
function naiveStep(board, ruleId) {
  const r = RULES[ruleId];
  let out = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          const yy = (y + dy + ROWS) % ROWS;
          const xx = (x + dx + COLS) % COLS;
          if ((board >> (yy * COLS + xx)) & 1) n++;
        }
      }
      const alive = (board >> (y * COLS + x)) & 1;
      const on = alive ? (r.survive >> n) & 1 : (r.birth >> n) & 1;
      if (on) out |= 1 << (y * COLS + x);
    }
  }
  return out;
}

console.log('lifeboat model tests');

test('BANDS tile 0..MAX_STAT with no gap or overlap', () => {
  let cursor = BANDS[0].min;
  assert.equal(cursor, 0);
  for (const b of BANDS) {
    assert.equal(b.min, cursor, `gap/overlap at ${cursor}`);
    assert.ok(b.max >= b.min);
    cursor = b.max + 1;
  }
  assert.equal(cursor, MAX_STAT + 1);
});

test('multipliers are monotonic non-decreasing', () => {
  for (let i = 1; i < BANDS.length; i++) assert.ok(BANDS[i].mult >= BANDS[i - 1].mult);
});

test('bandOf boundaries: 5->0, 6->1.2, 7->1.2, 8->2, 12->2, 13->16, 20->16', () => {
  assert.equal(bandOf(5), 0);
  assert.equal(bandOf(6), 1.2);
  assert.equal(bandOf(7), 1.2);
  assert.equal(bandOf(8), 2);
  assert.equal(bandOf(12), 2);
  assert.equal(bandOf(13), 16);
  assert.equal(bandOf(20), 16);
  assert.equal(bandOf(-1), 0);
  assert.equal(bandOf(99), 0);
});

test('rule masks decode to the labels they claim', () => {
  const bits = m => { const a = []; for (let i = 0; i < 9; i++) if ((m >> i) & 1) a.push(i); return a.join(''); };
  assert.equal(`B${bits(RULES[0].birth)}/S${bits(RULES[0].survive)}`, 'B25/S014');
  assert.equal(`B${bits(RULES[1].birth)}/S${bits(RULES[1].survive)}`, 'B25/S23');
  assert.equal(`B${bits(RULES[2].birth)}/S${bits(RULES[2].survive)}`, 'B24/S23');
  assert.equal(RULES[DEFAULT_RULE].label, RULES[0].label);
});

test('the row-table step matches a naive independent automaton', () => {
  let checked = 0;
  for (let board = 0; board < (1 << 20); board += 4099) {
    for (const r of RULES) {
      assert.equal(step(board, r.id), naiveStep(board, r.id), `board ${board} rule ${r.id}`);
      checked++;
    }
  }
  // plus the fully-lit and fully-dark and single-bit decks
  for (const board of [0, 0xfffff, 1, 1 << 19, 0x8421]) {
    for (const r of RULES) assert.equal(step(board, r.id), naiveStep(board, r.id));
    checked += RULES.length;
  }
  assert.ok(checked > 700);
});

test('census over GENERATIONS also matches the naive automaton', () => {
  let checked = 0;
  for (let board = 0; board < (1 << 20); board += 40009) {
    for (const r of RULES) {
      let b = board;
      for (let g = 0; g < GENERATIONS; g++) b = naiveStep(b, r.id);
      assert.equal(census(board, r.id), population(b), `board ${board} rule ${r.id}`);
      checked++;
    }
  }
  assert.ok(checked > 60);
});

test('worked examples, rule 0 (B25/S014)', () => {
  assert.equal(census(0x0, 0), 0);
  assert.equal(census(0x1, 0), 1);
  assert.equal(census(0x5, 0), 7);
  assert.equal(census(0x21, 0), 8);
  assert.equal(census(0xfb, 0), 14);
  const band = b => ({ stat: outcome(word(b)).stat, mult: outcome(word(b)).mult });
  assert.deepEqual(band(0x5), { stat: 7, mult: 1.2 });
  assert.deepEqual(band(0x21), { stat: 8, mult: 2 });
  assert.deepEqual(band(0xfb), { stat: 14, mult: 16 });
  assert.deepEqual(band(0x0), { stat: 0, mult: 0 });
});

test('a fully-lit deck dies under every rule inside 14 generations', () => {
  for (const r of RULES) assert.equal(census(0xfffff, r.id), 0, `rule ${r.id}`);
});

test('the same deck really does evolve differently under each rule', () => {
  let differ = 0;
  for (let board = 0; board < (1 << 20); board += 7919) {
    const a = census(board, 0);
    const b = census(board, 1);
    const c = census(board, 2);
    if (!(a === b && b === c)) differ++;
  }
  assert.ok(differ > 100, 'the rule choice must be load-bearing');
});

test('outcome uses the default rule; outcomeWithRule is explicit', () => {
  for (const b of [0, 3, 0xaaa, 0x13579, 0xfffff]) {
    assert.deepEqual(outcome(word(b)), outcomeWithRule(word(b), DEFAULT_RULE));
    assert.equal(outcomeWithRule(word(b), 2).stat, census(wordTo20(word(b)), 2));
  }
});

test('evolution returns GENERATIONS+1 frames and lands on the census', () => {
  const frames = evolution(0xaaa, 0);
  assert.equal(frames.length, GENERATIONS + 1);
  assert.equal(frames[0], 0xaaa);
  assert.equal(population(frames[frames.length - 1]), census(0xaaa, 0));
  assert.equal(census(0xaaa, 0), 7);
});

test('every rule RTP lands in [9300,9800] and the declaration is the floor', () => {
  const BPS = v => Math.round(bandOf(v) * 10000);
  const exact = RULES.map(r => {
    const hist = new Int32Array(CELLS + 1);
    for (let b = 0; b < (1 << 20); b++) hist[census(b, r.id)]++;
    let num = 0n;
    for (let v = 0; v <= CELLS; v++) num += BigInt(hist[v]) * BigInt(BPS(v));
    return Number(num) / (1 << 20);
  });
  exact.forEach((x, i) => {
    assert.ok(x >= 9300 && x <= 9800, `rule ${i} rtp ${x} out of window`);
    assert.equal(Math.round(x), Math.round(RULE_RTP_BPS[i]), `rule ${i} declared ${RULE_RTP_BPS[i]} vs exact ${x}`);
  });
  assert.equal(Math.round(Math.min(...exact)), EXPECTED_RTP_BPS);
  assert.equal(Math.round(exact[DEFAULT_RULE]), EXPECTED_RTP_BPS);
  assert.ok(Math.max(...exact) - Math.min(...exact) < 25, 'rules must be RTP-neutral within 25 bps');
});

test('makeRng returns 32-byte hex and is deterministic', () => {
  const seed = '0x' + 'cd'.repeat(32);
  const a = makeRng(seed, 1);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, makeRng(seed, 1));
  assert.notEqual(a, makeRng(seed, 2));
});

test('makeRng does not collide at high round indices', () => {
  const seed = '0x' + '2e'.repeat(32);
  for (const start of [1, 1_000_000, 4_503_599_627_370_496]) {
    const seen = new Set();
    for (let r = start; r < start + 20000; r++) seen.add(makeRng(seed, r));
    assert.equal(seen.size, 20000, `collisions at ${start}`);
  }
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
