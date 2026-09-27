# lifeboat — chain integration

## Manifest

`public/game.manifest.json`:

| field | value | why |
|---|---|---|
| `schemaVersion` / `apiVersion` | 1 / 1 | validator requirement |
| `gameId` | `lifeboat` | |
| `presentation.mode` | `full-iframe` | every live manifest probed uses this |
| `presentation.hostPanels` | all `false` | the game owns the whole frame |
| `capabilities.openSession` | `true` | validator requirement |
| `capabilities.submitAction` | **`false`** | the only pre-wager input is `gameData`, not a mid-round action |
| `capabilities.forfeitExpiredSession` | `false` | instant game, nothing cashable mid-round |
| `capabilities.cancelStuckRandomness` | `true` | a stuck VRF request must be cancellable |
| `capabilities.resize` | `true` | `observeGameContentSize` is wired |
| `assets` | absent | no root-relative paths to 404 under a sub-path |

## Contract surface

`contracts/LifeboatGame.sol` implements all six `ICasinoGameV2` members, each `external pure`.

| member | implementation |
|---|---|
| `quoteCaps` | `maxEscrowStake = wager`, `maxReservedProfit = wager*160000/10000 - wager` |
| `quoteRiskParams` | **rule-aware**: decodes the rule from `gameData` and quotes that rule's exact top-tier probability, expected payout and body variance |
| `onSessionStart` | reads the rule from `ctx.gameData`, commits it into `newGameState = abi.encode(rule)`, commits the full reserve, `WAITING_RANDOMNESS`, `requestRandomnessNow = true` |
| `onPlayerAction` | `revert LifeboatGame__NoPlayerAction()` — declared honestly via `submitAction: false` |
| `onRandomness` | reads the rule back from `ctx.gameState`, folds the word, runs 14 generations, settles with `reservedProfitDelta = 0`, `escrowDelta = 0` |
| `quoteForfeitPayout` | `0` — instant game |

## Session states

`SessionPhase { NONE, WAITING_RANDOMNESS, WAITING_PLAYER_ACTION, SETTLED, FORFEITED, CANCELLED }`.
LIFEBOAT only visits three: `onSessionStart` hands back `WAITING_RANDOMNESS` with a randomness
request; `onRandomness` hands back `SETTLED`; a VRF timeout would be handled host-side by
`cancelStuckRandomness` (declared `true`), which refunds only the stake. LIFEBOAT never enters
`WAITING_PLAYER_ACTION` — it has no mid-round input.

## How the rule is locked before the word

1. The page sends `gameData = '0x' + hex(ruleId)` to `openSession`.
2. `onSessionStart` reads it and returns `newGameState = abi.encode(rule)`. This runs **before** the
   VRF request; `requestRandomnessNow = true` is returned from the same call.
3. `onRandomness` reads the rule from `ctx.gameState` — the contract-written state the casino
   persists — **not** from `ctx.gameData`. So even if the host resubmitted a different `gameData`,
   the settling step would ignore it. (This is the pattern the Wave-7 audit singles out as correct:
   `research/wave7-audit-novelty-licensing-security.md` §3.9 S2 contrasts it favourably with
   `HandicapGame.sol:171`, which reads the committed pick from `gameData` instead.)

**Residual trust assumption**: the host persists `newGameState` and hands it back unchanged in the
next `ctx`. This is the same assumption the reference `FloodGame` makes. It is **not observable**
without a live settlement, so it is not verified end-to-end here.

## Rule-aware risk quoting

The three rules have materially different tails, so quoting one table for all three would misstate
VaR:

| rule | `probabilityWad` | `expectedPayout` | `bodyVarianceScaled` (× wager²) |
|---|---|---|---|
| 0 | 12245178222656250 (1.2245%) | `wager * 9574 / 10000` | 1.327996826171875000e18 |
| 1 | 10375976562500000 (1.0376%) | `wager * 9576 / 10000` | 1.447100067138671875e18 |
| 2 | 6427764892578125 (0.6428%) | `wager * 9595 / 10000` | 1.662549591064453125e18 |

`MAX_MULT_BPS = 160000` is rule independent. All six numbers come from the exact enumerations in
`tools/tune.mjs`. `maxPayout/wager = 16 ≤ 100` and every `probabilityWad > 1e15`, so LIFEBOAT is not
heavy-tail; it quotes a non-zero body variance regardless, so no whitelist path reverts.

## Danger path

```
host.openSession({ wager, gameData: 0xR })
  -> casino escrows, calls onSessionStart -> rule R committed to gameState, WAITING_RANDOMNESS
  -> VRF fulfilled, casino calls onRandomness(ctx, randomness)
  -> board = fold(randomness); survivors = 14 generations then popcount
  -> payout = wagerBase * _multBps(survivors) / 10000
  -> newGameState = abi.encode(rule, board, survivors, payout) ; SETTLED
```

Four ABI words. The page decodes them (`src/app.js` `words()`), replays `evolution(board, rule)`
for the animation, lands on the contract's `survivors`/`payout`, and calls
`revealOutcome({ sessionId })` when the reveal lands.

## The payout cap (exact, no slack)

`maxPayout = wager * 160000 / 10000 = 16·w`. `onSessionStart` reserves `16·w − w = 15·w`, so
`escrowedStake + reservedProfit = w + 15·w = 16·w = maxPayout`. The settling step returns
`reservedProfitDelta = 0` and `escrowDelta = 0`, so the reserve is never released early and the cap
equals the largest possible payout to the wei. Integer floor division can only round down.
`tests/contract.test.mjs` asserts this identity for every reachable census.

## Deployed and settled on the local simulator (Wave 3, 2026-09-27)

LIFEBOAT is deployed and settled on the prescribed local Chain casino stack. It is **not** on the
production chain (that remains `EXTERNAL BLOCKED` — see `docs/testnet.md`), but every step of the
lifecycle above has now run for real: deploy, wager, `openSession`, VRF fulfilment, `onRandomness`,
settlement and payout.

| fact | value |
|---|---|
| chain id | 31337 (local simulator: `LocalCasinoHost` + `LocalCasinoVault`) |
| casino host | `0xe7f1725e7734ce288f8367e1bb143e90bb3f0512` |
| casino vault | `0xCafac3dD18aC6c6e92c921884f9E4176737C052c` |
| VRF router | `0x057ef64e23666f000b34ae31332854acbd1c8544` |
| LifeboatGame | `0xa513e6e4b8f2a923d98304ec87f64353c4d5c853` |
| deploy tx | `0xd238c250a415707933b30b9ce4922c63972a8bc0f2cd800e5de762bf2e07a6e1` |
| deploy block | 19 |
| deploy `gasUsed` | 566101 |
| `sessionsSettled` | 21 |
| `uniqueVrfFulfilmentTxs` | 21 |

Settlement proof over 20 rounds (`docs/chain-proof.json`): **0 stuck, 0 parity failures**, tiers
`{"0x":12,"2x":4,"1.2x":4}`, three distinct VRF fulfilment txs and request ids recorded, and the
first three rounds' open/settle txs and blocks. Every settled payout was re-derived from the
chain-emitted randomness via `model.outcome(randomness)` and matched the on-chain payout.

The **max-payout path** was also eth-called (static, no funds move): an offline-found top-band word
`0x9fff7a99…fa8ab804` was passed to `onRandomness`; it returned `stat = 14`, `mult = 16x`,
`payoutWei = 16000000000000000000`, `nextPhase = 3` (SETTLED), `withinCap = true`, i.e. the payout
equals the cap `escrow + reserve = 16·w` exactly.

Citations: `research/chain-evidence.json` (deploy tx/block/gas, sessionsSettled, unique fulfilment
txs); `docs/chain-proof.json` (20-round proof + `topPath`); `docs/verification.txt` §8.4 (verbatim).

## Not verified

- **Production-chain deployment and the production host.** LIFEBOAT is deployed only on the local
  simulator (above); the production chain.wtf host cannot be driven by an entrant. `EXTERNAL BLOCKED`
  in `docs/testnet.md` and `EXTERNAL-CHAINWTF-LIMITATION.md`.
- **A NON-default-rule read-back of `ctx.gameState`.** The 20 settled probe rounds all opened with
  `gameData '0x'` (rule 0), and `_ruleFrom('')` also returns 0
  (`contracts/LifeboatGame.sol:60-65`), so the probe cannot distinguish a correct round-trip of a
  non-default rule from a fall-through. The production host's persistence remains unobserved.
- The JS↔Solidity parity is *also* executed as a JS transliteration
  (`tests/contract.test.mjs`); the compiled bytecode **is** now run against the model on the local
  simulator (the settlement parity above), but not by directly stepping the bytecode in the unit
  tests.
- `GENERATIONS = 14` is a fixed chosen constant, not derived.
