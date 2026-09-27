#!/usr/bin/env node
/**
 * lifeboat — exact paytable derivation, per rule.
 *
 *   node tools/tune.mjs
 *
 * Ported from the verified jam-candidates/lifeboat/tools/tune.mjs; the ONLY change is the model
 * import path (`../model.mjs` -> `../game/model.mjs`). The arithmetic is untouched.
 *
 * `outcome(word)` depends only on the word's folded 20 bits, and the VRF word is
 * uniform, so the board space is EXACTLY 2^20 per rule and can be enumerated in full.
 * This script does that for all three rules, prints the exact censuses, and derives the
 * exact RTP of the shipped BANDS in integer bps:
 *
 *     rtp_bps = SUM_v count(v) * bps(v) / 2^20
 *
 * It does NOT trust model.mjs's declared constant: it recomputes and prints both.
 */
import {
  BANDS, CELLS, EXPECTED_RTP_BPS, GENERATIONS, RULES, bandOf, census, outcome, wordTo20,
} from '../game/model.mjs';

const BITS = 20;
const SPACE = 2 ** BITS;
const BPS = new Map([[0, 0], [1.2, 12000], [2, 20000], [16, 160000]]);

const results = [];
for (const rule of RULES) {
  const hist = new Int32Array(CELLS + 1);
  const t0 = process.hrtime.bigint();
  for (let board = 0; board < SPACE; board++) hist[census(board, rule.id)]++;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  let numerator = 0;
  let total = 0;
  for (let v = 0; v <= CELLS; v++) {
    numerator += hist[v] * BPS.get(bandOf(v));
    total += hist[v];
  }
  const exact = numerator / SPACE;
  results.push({ rule, hist, exact, ms, total, numerator });

  console.log(`\n${rule.label}  (rule ${rule.id}) — ${rule.note}`);
  console.log(`  2^${BITS} boards in ${ms.toFixed(0)} ms; histogram total ${total.toLocaleString()}`);
  console.log('  survivors  count      prob%      mult    contribution bps');
  for (let v = 0; v <= CELLS; v++) {
    if (!hist[v]) continue;
    const p = hist[v] / SPACE;
    console.log(
      `  ${String(v).padStart(9)}  ${String(hist[v]).padStart(7)}  ${(p * 100).toFixed(5).padStart(9)}   ${String(bandOf(v)).padStart(5)}   ${(p * bandOf(v) * 10000).toFixed(3).padStart(16)}`,
    );
  }
  console.log(`  exact: ${numerator} / 2^20 = ${exact.toFixed(4)} bps -> round ${Math.round(exact)}`);
}

const rtp = results.map(r => r.exact);
const min = Math.min(...rtp);
const max = Math.max(...rtp);
const argmin = results[rtp.indexOf(min)];
console.log(`\n--- summary ---`);
for (const r of results) console.log(`  ${r.rule.label.padEnd(10)} rule ${r.rule.id}  exact ${r.exact.toFixed(4)} bps  (${Math.round(r.exact)})`);
console.log(`  spread across rules: ${(max - min).toFixed(4)} bps`);
console.log(`  lowest rule: ${argmin.rule.label} (rule ${argmin.rule.id})`);
console.log(`  model.mjs declares EXPECTED_RTP_BPS = ${EXPECTED_RTP_BPS}`);
console.log(`  declared matches the default rule's exact value: ${Math.round(argmin.exact) === EXPECTED_RTP_BPS ? 'YES' : 'NO  <-- FIX model.mjs'}`);
console.log(`  in jam window [9300,9800]: ${rtp.every(x => x >= 9300 && x <= 9800) ? 'YES (all three)' : 'NO'}`);
console.log(`  declared is the floor across all choices: ${Math.round(min) === EXPECTED_RTP_BPS ? 'YES' : 'NO'}`);

console.log(`\n--- risk constants for LifeboatGame.sol (exact, per rule, same histograms) ---`);
for (const r of results) {
  const BPS2 = v => Math.round(bandOf(v) * 10000);
  const topBps = BPS2(20);
  let topCount = 0;
  for (let v = 0; v <= CELLS; v++) if (BPS2(v) === topBps) topCount += r.hist[v];
  const probWad = (BigInt(topCount) * 10n ** 18n) / BigInt(SPACE);
  let bodyNum = 0n;
  for (let v = 0; v <= CELLS; v++) {
    if (BPS2(v) === topBps) continue;
    bodyNum += BigInt(r.hist[v]) * BigInt(BPS2(v)) * BigInt(BPS2(v));
  }
  const bodyVarScaled = (bodyNum * 10n ** 18n) / (BigInt(SPACE) * 10000n * 10000n);
  console.log(`  rule ${r.rule.id} ${r.rule.label.padEnd(9)} TOP_TIER_PROB_WAD = ${probWad}  BODY_VAR_SCALED = ${bodyVarScaled}  RTP_BPS = ${Math.round(r.exact)}`);
}
console.log(`  MAX_MULT_BPS = 160000 (16x) — rule independent`);
console.log(`  EXPECTED_RTP_BPS (declared, = rule 0, the floor) = ${Math.round(results[0].exact)}`);
// Independent spot-check: the enumeration above walks boards directly; make sure the
// word -> board -> census path used by the harness agrees with it.
let checked = 0;
let mismatches = 0;
for (let w = 0; w < SPACE; w += 4099) {
  const hex = '0x' + w.toString(16).padStart(8, '0').padEnd(64, '0');
  const viaWord = outcome(hex).stat;
  const direct = census(wordTo20(hex), 0);
  checked++;
  if (viaWord !== direct) mismatches++;
}
console.log(`\nword->board->census spot check: ${checked} words, ${mismatches} mismatches`);
console.log(`generations K = ${GENERATIONS}; bands: ${BANDS.map(b => `${b.min}-${b.max}@${b.mult}`).join('  ')}`);
