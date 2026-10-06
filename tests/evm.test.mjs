#!/usr/bin/env node
/**
 * lifeboat EVM-level regression test — the commit/read round-trip on a REAL EVM.
 *
 *   node tests/evm.test.mjs        (wired into `npm test`)
 *
 * WHY THIS EXISTS (regression for F1): the JS "executed parity" test in contract.test.mjs is a
 * transliteration and never runs the Solidity, so it could not catch the F1 defect where
 * onRandomness read the committed rule through `uint8(gameState[0])` — byte 0 of
 * `abi.encode(uint256(rule))` is always 0x00, so every round silently played rule 0 and the
 * advertised three-rule choice was inert. This test compiles the SHIPPED contract, deploys it on a
 * throwaway anvil, and drives the exact host lifecycle (onSessionStart -> onRandomness) for all
 * three rules, asserting the committed rule round-trips and the census the contract returns equals
 * the model's census under the SELECTED rule (not the default rule).
 *
 * It REQUIRES `solc`, `anvil` and `cast` on PATH. When any is absent this file FAILS with a
 * non-zero exit rather than skipping: a green run that never deployed the contract is
 * indistinguishable from a real one, which is exactly the property this file exists to destroy.
 *
 * Scratch only: a private anvil on a non-harness port. No file under the repo is written. The
 * deploy key is read from anvil's OWN startup output (its well-known development accounts), so no
 * private key is hardcoded anywhere in this repository.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { census, wordTo20 } from '../game/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.LIFEBOAT_EVM_PORT || 8994);
const CHAIN_ID = 31342;
const RPC = `http://127.0.0.1:${PORT}`;
const CTX_SIG = '(uint256,address,address,uint256,uint256,uint256,uint32,bytes,bytes)';
// board 3: rule 0 -> 0 survivors, rule 2 -> 8 (the F1 reproducer). The board sits in the top 4 bytes.
const WORD = '0x0000000300000000000000000000000000000000000000000000000000000000';

// The toolchain gate FAILS, it never skips. This file compiles the shipped contract, deploys it and
// settles real rounds; if it does not run then the money path was not exercised, and reporting that
// as a pass is the defect (it hid a green CI run of nothing). Each missing binary is named with the
// one command that installs it so the failure is actionable on the machine it happens on.
const INSTALL_HINT = {
  solc: 'npm install -g solc@0.8.34   (or https://docs.soliditylang.org/en/latest/installing-solidity.html)',
  anvil: 'curl -L https://foundry.paradigm.xyz | bash && foundryup   (adds ~/.foundry/bin to PATH)',
  cast: 'same Foundry install as anvil — cast ships in the same tarball',
};
const missing = ['solc', 'anvil', 'cast'].filter((b) => spawnSync(b, ['--version'], { encoding: 'utf8' }).error);
if (missing.length) {
  console.error('lifeboat EVM test — TOOLCHAIN MISSING');
  console.error('  This suite is REQUIRED: it compiles contracts/LifeboatGame.sol, deploys it to an');
  console.error('  anvil and settles real rounds. Without it the money path never executed, so this');
  console.error('  run is a failure, not a skip.');
  for (const b of missing) console.error(`  missing: ${b}\n    install: ${INSTALL_HINT[b]}`);
  process.exit(1);
}

let pass = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { console.log(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};
const testAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { console.log(`  FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};
const sh = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
};
const words = (hex) => {
  const s = String(hex).replace(/^0x/, '');
  // A struct return is ABI-wrapped: w0 = 0x20 (offset to the tuple), w1 = offset to the dynamic
  // `bytes newGameState` inside the tuple, w2..w6 = the five static StepResult fields, then
  // [len][rule][board][pop][payout]. So `rule` is w8 @512, `board` w9 @576, `pop` w10 @640,
  // `payout` w11 @704. onSessionStart returns a 1-word newGameState, so later fields default to 0.
  const at = (i) => { const t = s.slice(i, i + 64); return t.length === 64 ? BigInt('0x' + t) : 0n; };
  return { rule: Number(at(512)), board: Number(at(576)), pop: Number(at(640)), payout: at(704) };
};
const ethCall = async (to, data) => {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};
const ctxRaw = (gameData, gameState) =>
  `(1,0x0000000000000000000000000000000000000001,0x0000000000000000000000000000000000000002,` +
  `1000000000000000000,1000000000000000000,0,0,${gameData},${gameState})`;
const ctx = (rule, gameState) => ctxRaw('0x0' + rule, gameState);

console.log('lifeboat EVM test (compile + deploy + host lifecycle)');

// ---------------------------------------------------------------- compile
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-evm-'));
const c = sh('solc', ['--via-ir', '--optimize', '--bin', '-o', out, path.join(ROOT, 'contracts', 'LifeboatGame.sol')]);
assert(c.status === 0, `solc compiles LifeboatGame.sol: ${c.stderr}`);
const bin = fs.readFileSync(path.join(out, 'LifeboatGame.bin'), 'utf8').trim();
assert(/^[0-9a-fA-F]+$/.test(bin) && bin.length > 100, 'compiled bytecode present');

// ---------------------------------------------------------------- anvil + deploy
// Anvil prints its development accounts and private keys on boot. Read account 0's key from that
// output instead of hardcoding it, so this file carries no key material.
const anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', String(CHAIN_ID)], { stdio: ['ignore', 'pipe', 'ignore'] });
let bootLog = '';
anvil.stdout.on('data', (d) => { bootLog += d.toString(); });
const ready = async () => {
  for (let i = 0; i < 100; i++) {
    try { await ethCall('0x0000000000000000000000000000000000000000', '0x'); return true; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return false;
};
const anvilKey = async () => {
  for (let i = 0; i < 100; i++) {
    const m = bootLog.match(/\b0x[0-9a-fA-F]{64}\b/);
    if (m) return m[0];
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
};

try {
  assert(await ready(), 'anvil becomes ready');
  const key = await anvilKey();
  assert(key, 'anvil printed its development private key');
  const send = sh('cast', ['send', '--json', '--rpc-url', RPC, '--private-key', key, '--create', bin]);
  const receipt = JSON.parse(send.stdout);
  const addr = receipt.contractAddress || (receipt.receipt && receipt.receipt.contractAddress);
  assert(addr && /^0x[0-9a-fA-F]{40}$/.test(addr), `contract deployed (${addr})`);
  console.log(`  [info] LifeboatGame deployed at ${addr}`);

  for (const rule of [0, 1, 2]) {
    // onSessionStart commits abi.encode(uint256(rule)); read it back.
    const startData = sh('cast', ['calldata', `onSessionStart(${CTX_SIG})`, ctx(rule, '0x')]).stdout.trim();
    const started = words(await ethCall(addr, startData));
    // onRandomness must use the COMMITTED rule (gameState = abi.encode(uint256(rule))).
    const committed = '0x' + BigInt(rule).toString(16).padStart(64, '0');
    const randSig = `onRandomness(${CTX_SIG},bytes32)`;
    const randData = sh('cast', ['calldata', randSig, ctx(rule, committed), WORD]).stdout.trim();
    const settled = words(await ethCall(addr, randData));

    const expectedBoard = wordTo20(WORD);
    const expectedPop = census(expectedBoard, rule);
    test(`rule ${rule}: committed rule round-trips through gameState`, () => {
      assert.equal(started.rule, rule, `onSessionStart committed rule ${started.rule}, expected ${rule}`);
    });
    test(`rule ${rule}: onRandomness honours the committed rule (pop == model census)`, () => {
      assert.equal(settled.rule, rule, `settled under rule ${settled.rule}, expected ${rule}`);
      assert.equal(settled.board, expectedBoard, `board ${settled.board} != ${expectedBoard}`);
      assert.equal(settled.pop, expectedPop, `pop ${settled.pop} != model census ${expectedPop} under rule ${rule}`);
    });
  }

  // The F1 differential across the FULL rule space: with the OLD byte-0 reader every rule returned
  // rule 0's census, so all three agreed. Assert the choice is REAL — the rules do not collapse to a
  // single census on this board — and that at least one pair genuinely diverges.
  test('F1 regression: the full rule space 0..2 does not collapse to one census', () => {
    const board = wordTo20(WORD);
    const pops = [0, 1, 2].map((r) => census(board, r));
    assert.ok(new Set(pops).size >= 2, `rules must not all agree on board ${board} (got ${pops})`);
    assert.ok(pops.some((p, i) => pops.some((q, j) => i !== j && p !== q)), 'need a divergent pair');
  });

  // ---- boundary cases on the committed-rule reader --------------------------------------------
  const randSig = `onRandomness(${CTX_SIG},bytes32)`;
  const enc = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const callRand = async (gameDataHex, gameStateHex) => words(await ethCall(
    addr, sh('cast', ['calldata', randSig, ctxRaw(gameDataHex, gameStateHex), WORD]).stdout.trim()));
  const tryCall = async (sig, arg) => {
    try { return { ok: true, out: await ethCall(addr, sh('cast', ['calldata', sig, arg]).stdout.trim()) }; }
    catch (err) { return { ok: false, err: String(err.message) }; }
  };

  await testAsync('boundary: gameState=abi.encode(3) (out of range) falls back to gameData, no revert', async () => {
    const r = await callRand('0x02', enc(3));
    assert.equal(r.rule, 2, `expected fallback to gameData rule 2, got ${r.rule}`);
  });
  await testAsync('boundary: gameState=0x02 (1 byte) falls back to gameData', async () => {
    assert.equal((await callRand('0x02', '0x02')).rule, 2);
  });
  await testAsync('boundary: gameState=0x (empty) falls back to gameData', async () => {
    assert.equal((await callRand('0x02', '0x')).rule, 2);
  });
  await testAsync('boundary: gameState of 64 bytes falls back to gameData', async () => {
    assert.equal((await callRand('0x02', '0x' + '11'.repeat(64))).rule, 2);
  });
  await testAsync('boundary: the COMMITTED rule wins over gameData for every rule 0..2', async () => {
    for (const r of [0, 1, 2]) {
      const got = await callRand('0x00', enc(r)); // gameData says 0, gameState says r
      assert.equal(got.rule, r, `committed ${r} but settled ${got.rule}`);
    }
  });
  await testAsync('boundary: an invalid rule in gameData REVERTS onSessionStart', async () => {
    const res = await tryCall(`onSessionStart(${CTX_SIG})`, ctxRaw('0x03', '0x'));
    assert.equal(res.ok, false, 'onSessionStart with gameData=0x03 must revert');
    assert.match(res.err, /0x[0-9a-fA-F]{8,}/, 'revert must carry a selector');
  });
} finally {
  anvil.kill('SIGKILL');
  fs.rmSync(out, { recursive: true, force: true });
}

console.log(`\n${pass} passed (EVM)`);
