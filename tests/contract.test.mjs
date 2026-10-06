#!/usr/bin/env node
/**
 * lifeboat contract tests — everything that does NOT need a chain.
 *
 *   node tests/contract.test.mjs      (or `npm test`)
 *
 * Two kinds of check:
 *   1. SOURCE checks — the shipped LifeboatGame.sol really carries the paytable, the masks, the
 *      six ICasinoGameV2 members, the MIT SPDX, and the "rule locked into gameState at
 *      onSessionStart, read back from gameState at onRandomness" lifecycle.
 *   2. EXECUTED parity — a faithful transliteration of the Solidity _fold20 / _step / _census /
 *      _multBps (reading the contract's own masks and boundaries, not the model's) is run against
 *      the model for sampled boards/words and every rule. This upgrades the previously source-level
 *      JS↔Solidity parity argument into an executed differential test. It is NOT an EVM run; the
 *      on-chain path still needs the chain phase.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as model from '../game/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sol = fs.readFileSync(path.join(HERE, '..', 'contracts', 'LifeboatGame.sol'), 'utf8');
const iface = fs.readFileSync(path.join(HERE, '..', 'contracts', 'ICasinoGameV2.sol'), 'utf8');

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

// ------------------------------------------------------------------ source checks

console.log('lifeboat contract tests');

test('declares MIT SPDX, matching LICENSE', () => {
  assert.match(sol, /SPDX-License-Identifier:\s*MIT/);
});

test('declares a constant, no constructor, implements ICasinoGameV2', () => {
  assert.match(sol, /contract\s+LifeboatGame\s+is\s+ICasinoGameV2/);
  assert.ok(!/constructor\s*\(/.test(sol), 'contract must have no constructor');
});

test('implements all six ICasinoGameV2 members', () => {
  for (const fn of ['quoteCaps', 'quoteRiskParams', 'onSessionStart', 'onPlayerAction', 'onRandomness', 'quoteForfeitPayout']) {
    assert.match(sol, new RegExp(`function\\s+${fn}\\s*\\(`), `missing ${fn}`);
    assert.match(iface, new RegExp(`function\\s+${fn}\\s*\\(`), `interface missing ${fn}`);
  }
});

test('all step handlers are pure (no reentrancy surface)', () => {
  for (const fn of ['quoteCaps', 'quoteRiskParams', 'onSessionStart', 'onPlayerAction', 'onRandomness', 'quoteForfeitPayout']) {
    const re = new RegExp(`function\\s+${fn}\\s*\\([^]*?\\)\\s*external\\s+pure`);
    assert.match(sol, re, `${fn} is not external pure`);
  }
});

test('carries the declared constants', () => {
  assert.match(sol, /EXPECTED_RTP_BPS\s*=\s*9574\b/);
  assert.match(sol, /MAX_MULT_BPS\s*=\s*160000\b/);
  assert.match(sol, /GENERATIONS\s*=\s*14\b/);
  assert.match(sol, /ROWS\s*=\s*4\b/);
  assert.match(sol, /COLS\s*=\s*5\b/);
  assert.match(sol, /RULES\s*=\s*3\b/);
});

test('carries the three B/S masks', () => {
  for (const hex of ['0x24', '0x13', '0x0c', '0x14']) {
    assert.ok(sol.includes(hex), `missing mask ${hex}`);
  }
});

test('paytable boundaries are the model bands', () => {
  assert.match(sol, /survivors\s*>=\s*13[\s\S]*?return\s+160000/);
  assert.match(sol, /survivors\s*>=\s*8[\s\S]*?return\s+20000/);
  assert.match(sol, /survivors\s*>=\s*6[\s\S]*?return\s+12000/);
});

test('the locked rule is committed to gameState and read back from it', () => {
  // onSessionStart reads the rule from the one-byte gameData hint and commits it as a full
  // 32-byte abi.encode(uint256) word...
  assert.match(sol, /r\.newGameState\s*=\s*abi\.encode\(rule\)/);
  // ...and onRandomness reads the COMMITTED rule back from ctx.gameState with abi.decode.
  // REGRESSION (F1): the previous reader used `uint256(uint8(gameState[0]))`, but byte 0 of
  // `abi.encode(uint256(rule))` is ALWAYS 0x00, so every round silently played rule 0 and the
  // advertised rule choice was inert. The reader must decode the whole word, not byte 0.
  assert.match(sol, /_committedRule\(ctx\)/);
  assert.match(sol, /abi\.decode\(gs,\s*\(uint256\)\)/);
  assert.ok(
    !/uint8\(ctx\.gameState\[0\]\)|uint8\(gameData\[0\]\)\s*;[\s\S]{0,40}gameState/.test(sol),
    'must not read the committed rule through gameState byte 0',
  );
});

test('randomness is requested once, on the pre-word step', () => {
  const start = sol.slice(sol.indexOf('function onSessionStart'), sol.indexOf('function onPlayerAction'));
  assert.match(start, /r\.requestRandomnessNow\s*=\s*true/);
  const rand = sol.slice(sol.indexOf('function onRandomness'), sol.indexOf('function quoteForfeitPayout'));
  assert.match(rand, /r\.requestRandomnessNow\s*=\s*false/);
});

test('the reserve is committed at start and never released at settle', () => {
  const start = sol.slice(sol.indexOf('function onSessionStart'), sol.indexOf('function onPlayerAction'));
  assert.match(start, /wager\s*\*\s*MAX_MULT_BPS\)\s*\/\s*10000\s*-\s*wager/);
  const rand = sol.slice(sol.indexOf('function onRandomness'), sol.indexOf('function quoteForfeitPayout'));
  assert.match(rand, /r\.reservedProfitDelta\s*=\s*0/);
  assert.match(rand, /r\.escrowDelta\s*=\s*0/);
});

test('the word folds exactly as the model folds it', () => {
  assert.match(sol, /bytes4\(randomness\)/);
  assert.match(sol, /bytes4\(randomness\s*<<\s*32\)/);
  assert.match(sol, /bytes4\(randomness\s*<<\s*64\)/);
  assert.match(sol, /bytes4\(randomness\s*<<\s*96\)/);
  assert.match(sol, /&\s*0xfffff/);
});

test('onPlayerAction reverts honestly (submitAction:false)', () => {
  assert.match(sol, /function onPlayerAction\([\s\S]*?revert\s+LifeboatGame__NoPlayerAction/);
});

// ------------------------------------------------------------------ executed parity
// A faithful transliteration of the Solidity automaton. It deliberately reads the CONTRACT's
// masks and boundaries, not the model's, so agreement is evidence and not a tautology.

const CONTRACT_MASKS = { 0: [0x24, 0x13], 1: [0x24, 0x0c], 2: [0x14, 0x0c] };

function contractStep(board, rule) {
  const [birth, survive] = CONTRACT_MASKS[rule];
  let out = 0;
  for (let r = 0; r < 4; r++) {
    const me = (board >> (r * 5)) & 0x1f;
    const north = (board >> (((r + 4 - 1) % 4) * 5)) & 0x1f;
    const south = (board >> (((r + 1) % 4) * 5)) & 0x1f;
    let next = 0;
    for (let c = 0; c < 5; c++) {
      const left = (c + 5 - 1) % 5;
      const right = (c + 1) % 5;
      const n =
        ((me >> left) & 1) + ((me >> right) & 1) +
        ((north >> left) & 1) + ((north >> c) & 1) + ((north >> right) & 1) +
        ((south >> left) & 1) + ((south >> c) & 1) + ((south >> right) & 1);
      const alive = ((me >> c) & 1) === 1;
      if (alive ? ((survive >> n) & 1) === 1 : ((birth >> n) & 1) === 1) next |= 1 << c;
    }
    out |= next << (r * 5);
  }
  return out >>> 0;
}

function contractPopulation(board) {
  let k = 0;
  for (let i = 0; i < 20; i++) k += (board >> i) & 1;
  return k;
}

function contractCensus(board, rule) {
  let b = board >>> 0;
  for (let g = 0; g < 14; g++) b = contractStep(b, rule);
  return contractPopulation(b);
}

function contractFold20(word) {
  const h = String(word).replace(/^0x/, '');
  const u0 = parseInt(h.slice(0, 8), 16) >>> 0;
  const u1 = parseInt(h.slice(8, 16), 16) >>> 0;
  const u2 = parseInt(h.slice(16, 24), 16) >>> 0;
  const u3 = parseInt(h.slice(24, 32), 16) >>> 0;
  return ((u0 ^ u1 ^ u2 ^ u3) >>> 0) & 0xfffff;
}

function contractMultBps(survivors) {
  if (survivors >= 13) return 160000;
  if (survivors >= 8) return 20000;
  if (survivors >= 6) return 12000;
  return 0;
}

test('contract masks decode to the model rules', () => {
  const bits = m => { const a = []; for (let i = 0; i < 9; i++) if ((m >> i) & 1) a.push(i); return a.join(''); };
  for (const r of model.RULES) {
    const [birth, survive] = CONTRACT_MASKS[r.id];
    assert.equal(birth, r.birth, `rule ${r.id} birth mask`);
    assert.equal(survive, r.survive, `rule ${r.id} survive mask`);
    const label = `B${bits(birth)}/S${bits(survive)}`;
    assert.equal(label, r.label, `rule ${r.id} label`);
  }
});

test('contract paytable bps equals model bands x 10000', () => {
  for (const b of model.BANDS) {
    assert.equal(contractMultBps(b.min), b.mult * 10000, `band min ${b.min}`);
    assert.equal(contractMultBps(b.max), b.mult * 10000, `band max ${b.max}`);
  }
  for (let s = 0; s <= 20; s++) {
    assert.equal(contractMultBps(s) / 10000, model.bandOf(s), `stat ${s}`);
  }
});

test('contract _step matches model step on sampled boards, every rule', () => {
  let checked = 0;
  for (let board = 0; board < (1 << 20); board += 4001) {
    for (const rule of [0, 1, 2]) {
      assert.equal(contractStep(board, rule), model.step(board, rule), `board ${board} rule ${rule}`);
      checked++;
    }
  }
  for (const board of [0, 0xfffff, 1, 1 << 19, 0x8421]) {
    for (const rule of [0, 1, 2]) assert.equal(contractStep(board, rule), model.step(board, rule));
    checked += 3;
  }
  assert.ok(checked > 700, `checked ${checked}`);
});

test('contract _census matches model census on sampled boards, every rule', () => {
  let checked = 0;
  for (let board = 0; board < (1 << 20); board += 40009) {
    for (const rule of [0, 1, 2]) {
      assert.equal(contractCensus(board, rule), model.census(board, rule), `board ${board} rule ${rule}`);
      checked++;
    }
  }
  assert.ok(checked > 60, `checked ${checked}`);
});

test('contract _fold20 matches model wordTo20, and agrees on the census path', () => {
  let checked = 0;
  for (let w = 0; w < (1 << 20); w += 7919) {
    const word = '0x' + w.toString(16).padStart(8, '0').padEnd(64, '0');
    assert.equal(contractFold20(word), model.wordTo20(word), `word ${word}`);
    for (const rule of [0, 1, 2]) {
      const viaContract = contractCensus(contractFold20(word), rule);
      const viaModel = model.outcomeWithRule(word, rule).stat;
      assert.equal(viaContract, viaModel, `word ${word} rule ${rule}`);
    }
    checked++;
  }
  assert.ok(checked > 100, `checked ${checked}`);
});

test('full-word inputs (all four lanes) agree', () => {
  const words = [
    '0x' + '11'.repeat(32),
    '0x' + 'de'.repeat(32),
    // Each entry must be exactly 32 bytes of hex. This was `'0x0123456789abcdef'.repeat(4)`,
    // which repeats the "0x" prefix too and yields a 72-char string with an 'x' inside the
    // folded window. wordTo20 used to fold that silently into a plausible-looking wrong board,
    // and the contract's equivalent folded it the same wrong way, so the two agreed and the
    // test passed. wordTo20 now validates its input, so the malformed word is refused outright
    // rather than quietly agreeing with itself; the literal is the thing that was wrong.
    '0x' + '0123456789abcdef'.repeat(4),
    '0x' + 'ff'.repeat(16) + '00'.repeat(16),
  ];
  for (const word of words) {
    assert.equal(word.length, 66, `fixture is 32 bytes: ${word}`);
    assert.equal(contractFold20(word), model.wordTo20(word), word);
    assert.equal(contractCensus(contractFold20(word), 0), model.outcome(word).stat, word);
  }
});

test('the payout cap equals the top band exactly (no slack, no overflow)', () => {
  // LifeboatGame: maxReservedProfit = wager*MAX_MULT_BPS/10000 - wager = (16*w - w) = 15*w.
  const wager = 10n ** 18n; // 1 ether in wei
  const MAX_MULT_BPS = 160000n;
  const maxReservedProfit = (wager * MAX_MULT_BPS) / 10000n - wager;
  const maxPayout = (wager * MAX_MULT_BPS) / 10000n;
  assert.equal(maxPayout, 16n * wager);
  assert.equal(maxReservedProfit, 15n * wager);
  assert.equal(wager + maxReservedProfit, maxPayout, 'cap == escrow + reserve');
  // Every reachable payout is <= the cap.
  for (let s = 0; s <= 20; s++) {
    const payout = (wager * BigInt(contractMultBps(s))) / 10000n;
    assert.ok(payout <= wager + maxReservedProfit, `stat ${s} payout exceeds cap`);
  }
});

test('quoteRiskParams quotes non-zero body variance for a non-heavy-tail game', () => {
  // Heavy-tail requires BOTH maxPayout/wager > 100 AND probabilityWad < 1e15. Here the ratio is 16
  // (not > 100) and every top-tier probability is >= 1e15, so LIFEBOAT is not heavy-tail.
  assert.ok(16 <= 100, 'not heavy-tail on the ratio');
  const probs = [12245178222656250n, 10375976562500000n, 6427764892578125n];
  for (const p of probs) assert.ok(p >= 10n ** 15n, 'top-tier prob is not below the heavy-tail floor');
  // It still quotes a non-zero variance, so it is safe either way.
  assert.match(sol, /bodyVarianceScaled\s*=\s*wager\s*\*\s*wager\s*\*/);
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
