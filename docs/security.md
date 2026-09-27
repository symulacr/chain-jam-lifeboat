# lifeboat — security review

Adversarial review of the money path and the shipped surface. Sources: the verified candidate's own
reports (`reports/` in `jam-candidates/lifeboat/`), the Wave-7 audit
(`research/wave7-audit-novelty-licensing-security.md`, in which LIFEBOAT is the PASSABLE/PASSABLE
row), and the checks in `tests/contract.test.mjs`.

## Headline

| property | result |
|---|---|
| reentrancy | **none** — all six handlers are `external pure`: no storage, no external calls |
| payout cap | **exact at 16x**, no slack, no overflow below realistic wagers |
| heavy-tail | **no** — `maxPayout/wager = 16 ≤ 100` and every `probabilityWad > 1e15`; quotes non-zero body variance anyway |
| double-pay | **impossible at game level** — the game is stateless and a pure function of the word |
| rule-lock pattern | **correct** — `onRandomness` reads the locked rule from `ctx.gameState`, not `gameData` |
| browser cannot change a payout | **yes** — see `docs/architecture.md` "Where the money is decided" |

## Reentrancy — none

`contracts/ICasinoGameV2.sol` declares the step handlers `external view`; `LifeboatGame.sol` is
stricter and implements all six as `external pure`, so every handler compiles to a staticcall-style
read with no state access and no external call. A game that cannot call out cannot reenter. The
host's value-moving entrypoints are `nonReentrant` and use checks-effects-interactions
(`vendor/casino-sdk/docs/CONTRACT_CONSTRAINTS.md`, "Reentrancy"). `tests/contract.test.mjs` asserts
all six are `external pure`.

## Payout cap — exact, no slack

`quoteCaps` returns `maxEscrowStake = wager` and `maxReservedProfit = wager*160000/10000 - wager =
15·w`. `onSessionStart` commits the full `15·w` reserve. The largest payout is the 16x band:
`w·160000/10000 = 16·w`. So `escrowedStake + reservedProfit = w + 15·w = 16·w = maxPayout` exactly,
to the wei. `onRandomness` returns `reservedProfitDelta = 0` and `escrowDelta = 0`, so the reserve is
never released early and the cap and the payout cannot disagree. All payout math is floor-divided,
so any fractional wei favours the house (never the player). `tests/contract.test.mjs` checks this
identity for every reachable census.

## Heavy-tail rule — not heavy-tail, and safe either way

The rule (from `CONTRACT_CONSTRAINTS.md`): heavy-tail ⇔ `maxPayout/wager > 100` **and**
`probabilityWad < 1e15`; whitelisting a heavy-tail game reverts unless it quotes a non-zero
`bodyVarianceScaled`.

For LIFEBOAT: `maxPayout/wager = 16` (not > 100), and the three top-tier probabilities are
`1.2245e16`, `1.0376e16`, `6.4278e15` (all > 1e15). So it is **not** heavy-tail on either branch.
It nevertheless quotes a non-zero `bodyVarianceScaled` for every rule, so no whitelist path reverts.
The declared top-tier WAD values were independently reproduced by enumeration
(`research/wave7-audit-novelty-licensing-security.md` §3.3).

## Duplicate settlement / double payout

The game is `pure` and carries no storage: the payout is a deterministic function of
`(randomness, ctx.gameState)`. There is nothing in the game that can be incremented twice.
Double settlement is prevented host-side by the facet's `nonReentrant` + finalize-before-transfer
ordering; `onRandomness` is idempotent for a given word. The UI adds a second guard: the page keeps a
set of rendered session keys so a re-delivered snapshot row cannot re-reveal or re-pay
(`src/app.js` `pollSnapshot` + `src/selection.mjs`). **At the game level this is proven.** The host-level guarantee
(`nonReentrant` + finalize-before-transfer) is documented by the SDK, not adversarially re-run; the
local simulator settled 20 rounds with no double-pay, but the production facet's ordering remains
UNPROVEN live.

## The rule lock — the correct pattern

`onSessionStart` reads the rule from `ctx.gameData` and commits `newGameState = abi.encode(rule)`
*before* the VRF request; `onRandomness` reads the rule back from `ctx.gameState`, never from
`ctx.gameData`. A host that replayed a session with mutated `gameData` could not change the outcome
after the word exists. The Wave-7 audit (§3.9 S2) singles this out as the correct pattern and
contrasts it with `HandicapGame.sol:171`, which reads its committed pick from `gameData`.
`tests/contract.test.mjs` asserts both directions and that `onRandomness` contains no `gameData`
reference. Residual trust: the host must persist and return `newGameState` unchanged — the same
assumption the reference `FloodGame` makes, not observable without a live settlement.

## Overflow / rounding

- `wager * MAX_MULT_BPS` overflows only above `wager ≈ 1.15e75` wei.
- `wager * wager * BODY_VAR_SCALED` overflows only above `wager ≈ 2.0e29` wei (≈ 2.0e11 ether).
- The `int256(...)` reserve cast cannot overflow until roughly `wager ≈ 2.3e74`.
- All payout math is floor-divided, favouring the house.

No realistic overflow. The game does **not** clamp the wager itself; that is the host's
min/max-bet job. The page bets `snapshot.casino?.minBetAmount ?? '10'`, and a host rejection is
caught and shown in `#notice`.

## VRF failure / timeout

`onSessionStart` requests randomness once (`requestRandomnessNow = true`,
`WAITING_RANDOMNESS`) and the contract has no timeout logic of its own — correct per the facet
model: on randomness timeout the host calls `cancelStuckRandomness`, which refunds only the stake.
LIFEBOAT declares `cancelStuckRandomness: true`. This path is **UNPROVEN live**: it is only reached
on a randomness timeout, and the local simulator run saw 0 stuck rounds (20/20 settled), so the
cancel path itself was never exercised.

## UI / iframe / hosting robustness

- Grace timer present for the measured "no host" case (`connection.promise` never settles); the page
  does not await it. See `docs/iframe.md`.
- No root-relative asset paths; no `X-Frame-Options` / `frame-ancestors`; no service worker, no
  storage, no cookie, no `window.open`, no `vh`/`vw`.
- One third-party script only: the literal widget tag.
- `?ref=chainjam` tolerated (the page never reads the query string).
- No settlement watchdog (unlike flood-exe/ordered-runs/handicap). Low risk: no blocking `busy` is
  held across settlement, so a missing settlement leaves the demo usable rather than frozen
  (Wave-7 §3.5, §3.9 S4). Recorded, not hidden.

## Findings (ranked)

| # | sev | finding | status |
|---|---|---|---|
| S3 | LOW | the game does not clamp the wager; the host owns min/max. The page does not pre-clamp and relies on the host rejection catch. | accepted; host responsibility |
| S4 | LOW | no settlement watchdog; a stuck "waiting for the word" notice is possible if a host connects then goes quiet. | accepted; no hard hang |
| — | INFO | `vercel.json` carried a non-schema top-level `"$comment"` key. **CONFIRMED (Wave 3): Vercel rejects it** — `Error: Invalid vercel.json - should NOT have additional property \`$comment\`. Please remove it.` — and the deploy failed until it was removed. Fixed: `public/vercel.json` now holds `headers` only; the rationale moved to `public/_headers`. See `docs/verification.txt` §8.6. | fixed |

No high or medium severity finding. No automatic-licensing fail: the shipped surface carries no
third-party asset, no third-party font/audio, and no Microsoft string; the third-party strings the
Wave-7 audit flagged (Wine-family provenance) were confined to the old README and have been removed
in this project's README.

## What is proven vs unproven here

**Proven (evidence in `docs/verification.txt`, incl. Wave-3 §8)**: RTP is exact (the 2^20 enumeration
is reproduced by the independent brute-force tool); the shipped automaton matches an independent
naive counter and a contract-style transliteration; the paytable is band-for-band equal between model
and contract; the payout cap identity holds; the rule-lock pattern is present and correct; the built
page plays a settled round with no host and renders the model's own census; **the compiled contract
ran on the local simulator** — deployed, 20 rounds settled with 0 stuck / 0 parity failures, a real
VRF fulfilment per session, and the max-payout path eth-called within cap (`docs/chain-proof.json`);
the **local in-host embed** settled through the bridge (`docs/host-embed.json`); the build runs
**standalone on the public HTTPS URL** (`research/public-deploy-top3.md`).

**Unproven**: the production-chain deployment and the production chain.wtf host (EXTERNAL BLOCKED —
`docs/testnet.md`); `ctx.gameState` round-tripping for a NON-default rule (every probe round used
`gameData '0x'`); the production host's persistence; the `cancelStuckRandomness` timeout path (never
reached in a 0-stuck run).
