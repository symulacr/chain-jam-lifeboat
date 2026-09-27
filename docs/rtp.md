# lifeboat — RTP class and contract parity

## Class: EXACT

LIFEBOAT's RTP is **EXACT**, not Monte Carlo. The word folds to 20 bits, those 20 bits are the
entire initial deck, and the automaton is a pure function of `(deck, rule)`. The reachable deck
space is therefore exactly `2^20 = 1,048,576` per rule and is enumerated in full. The figure is a
rational with denominator `2^20`, not a confidence interval.

## Declared

`EXPECTED_RTP_BPS = 9574`; exact **9574.2035 bps** under rule 0 (B25/S014), which is the lowest of
the three rules, so the declaration is the floor across every choice. Full derivation in
`docs/rtp-proof.md`.

| rule | exact RTP | declared? |
|---|---|---|
| 0 B25/S014 (default) | 9574.2035 | **declared** |
| 1 B25/S23 | 9575.7103 | in window, listed |
| 2 B24/S23 | 9594.7456 | in window, listed |

Spread: **20.5421 bps**. All three inside the jam's accepted `[9300, 9800]`. House edge ≈ 4.26%.

## Contract parity, band for band

| `game/model.mjs` band | model `mult` | `LifeboatGame.sol` | contract bps |
|---|---|---|---|
| `0–5` | `0` | `_multBps` fallthrough `return 0` | 0 |
| `6–7` | `1.2` | `if (survivors >= 6) return 12000;` | 12000 |
| `8–12` | `2` | `if (survivors >= 8) return 20000;` | 20000 |
| `13–20` | `16` | `if (survivors >= 13) return 160000;` | 160000 |

`_payout(wager, survivors) = wager * _multBps(survivors) / 10000`. The contract writes the tiers as
descending `>=` guards rather than ascending ranges — same table, same boundaries, same result.
`tests/contract.test.mjs` asserts `_multBps(s) / 10000 === bandOf(s)` for every `s` in `0..20`.

## Parity of the *derivation*, not just the paytable

Given one word and one rule, the contract and the model must agree on the final census.

| step | `game/model.mjs` | `LifeboatGame.sol` | identical? |
|---|---|---|---|
| fold | XOR of four big-endian u32 lanes, `& 0xFFFFF` | `uint32(bytes4(r))`, `r << 32/64/96`, same XOR, same mask | yes |
| layout | row-major, bit `r*5+c` | row-major, `(board >> (r*5)) & 0x1f` per row | yes |
| wrap | horizontal inside the row (`(c+4)%5`, `(c+1)%5`), vertical over 4 rows (`(r+3)%4`, `(r+1)%4`) | same expressions | yes |
| neighbour count | Moore: 2 in-row + 3 north + 3 south | same eight terms | yes |
| transition | `alive ? S[n] : B[n]` | `alive ? ((survive >> n) & 1) : ((birth >> n) & 1)` | yes |
| rules | `birth`/`survive` masks per `RULES` | `0x24/0x13`, `0x24/0x0c`, `0x14/0x0c` | yes |
| generations | `GENERATIONS = 14` | `GENERATIONS = 14` | yes |
| statistic | `population(board & 0xfffff)` | `_population` over 20 bits | yes |

**This parity is now EXECUTED, not only argued.** `tests/contract.test.mjs` transliterates the
contract's `_fold20`/`_step`/`_census`/`_multBps` — reading the contract's own masks and boundaries,
not the model's — and compares it against the model on sampled boards and words for all three rules.
The remaining gap for this *unit test* is that it is a JS transliteration, not the compiled EVM
bytecode executing step by step. That gap has since been closed for the settlement path: the
compiled bytecode ran on the local simulator (chain id 31337) and settled 20 rounds with 0 parity
failures (`docs/chain-integration.md`, `docs/verification.txt` §8.4).

Mask decode check (also asserted in the test suite):

| rule | mask bits | B | S |
|---|---|---|---|
| 0 | `0x24` / `0x13` | bits 2,5 → **B25** | bits 0,1,4 → **S014** |
| 1 | `0x24` / `0x0c` | bits 2,5 → **B25** | bits 2,3 → **S23** |
| 2 | `0x14` / `0x0c` | bits 2,4 → **B24** | bits 2,3 → **S23** |

## Risk constants (exact, per rule, from the same enumerations)

| rule | top-tier count | `probabilityWad` | `expectedPayout` | `bodyVarianceScaled` (× wager²) |
|---|---:|---:|---|---|
| 0 | 12840 / 2^20 | 12245178222656250 (1.2245%) | `wager * 9574 / 10000` | 1.327996826171875000e18 |
| 1 | 10880 / 2^20 | 10375976562500000 (1.0376%) | `wager * 9576 / 10000` | 1.447100067138671875e18 |
| 2 | 6740 / 2^20 | 6427764892578125 (0.6428%) | `wager * 9595 / 10000` | 1.662549591064453125e18 |

`MAX_MULT_BPS = 160000` is rule independent. `maxPayout/wager = 16` (≤ 100) and `probabilityWad`
stays above `1e15`, so LIFEBOAT is **not** heavy-tail; it still quotes a non-zero body variance.
See `docs/chain-integration.md` for the full risk-parameter table.

## Compilation (recorded from the verified build)

```sh
cd contracts
solc --overwrite --optimize --bin LifeboatGame.sol -o /tmp/lb-out
```

`Compiler run successful.`, no warnings. `LifeboatGame.bin` = 5718 hex chars = **2859 bytes**
(`solc 0.8.36 --optimize`). The brief names `solcjs --bin`; `solcjs` was not installed, so the
svm-managed `solc` driver was used — same compiler, same flags. **UNPROVEN**: `solcjs` specifically.
