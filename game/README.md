# game/ — the LIFEBOAT model

`model.mjs` is the single source of truth for the whole game: the rule set, the toroidal
automaton, the census, the paytable bands and the counter-based round sampler. The page
(`src/app.js`) imports it; the harness (`jam-candidates/tools/verify-candidate.mjs`) loads it;
`contracts/LifeboatGame.sol` re-implements the same arithmetic and is checked against it by
`tests/contract.test.mjs`. Nothing is transcribed.

`model.mjs` is byte-identical to the verified `jam-candidates/lifeboat/model.mjs`.

## The mechanic

A 4×5 toroidal deck of 20 berths. One verified random word lights the berths (one bit each).
The deck then runs a Life-like cellular automaton for a fixed **14 generations**. The payout is a
banded function of the **live population of the final frame** — the *census* — under the rule the
player locked before the wager.

- Not "watch it spread": the scored statistic is the census after N generations, not how far one
  seed reaches.
- The player picks one of three B/S rules **before** the word is drawn. The same starting deck
  evolves differently under each, so the choice is load-bearing.

## VRF mapping — what the word maps to, and how many bits are consumed

```
word (32 bytes / 256 bits, uniform)
  w20 = (u32(word[0:4]) ^ u32(word[4:8]) ^ u32(word[8:12]) ^ u32(word[12:16])) & 0xFFFFF
```

- Only the **first 16 bytes (128 bits)** of the word are read, as four big-endian u32 lanes.
- The four lanes are XORed into one u32; the XOR of independent uniform lanes is uniform.
- The result is masked to **20 bits**. Those 20 bits **are** the initial deck, one bit per berth,
  row-major (berth `r*5 + c` is bit `r*5 + c`).

**Bits consumed: 20.** The board is `ROWS*COLS = 20` cells, so exactly one word bit addresses one
berth. Because the folded value is uniform over exactly `2^20`, the reachable board space is
`2^20 = 1,048,576` decks, fully enumerable per rule — which is why the RTP is exact, not simulated.

## The rule set

| id | label | birth | survive | character | exact RTP |
|---:|---|---:|---:|---|---:|
| 0 | B25/S014 (default) | `0b000100100` | `0b000010011` | isolated berths survive — the deck drifts | **9574.2035 bps** |
| 1 | B25/S23 | `0b000100100` | `0b000001100` | the same births, no lonely survivors — it pulses | 9575.7103 bps |
| 2 | B24/S23 | `0b000010100` | `0b000001100` | one easier birth — booms then collapses | 9594.7456 bps |

`DEFAULT_RULE = 0`. Rule 0 pays the least of the three, so the declared RTP is the floor across
every choice the player can make. The three are deliberately within **20.54 bps** of each other on
one shared table: locking a rule moves the *shape* of the census, not the expected return.

## Paytable (one table, all three rules)

| survivors | return multiple | exact bps |
|---|---|---|
| 0–5 | 0 (the colony is lost) | 0 |
| 6–7 | 1.2x | 12000 |
| 8–12 | 2x | 20000 |
| 13–20 | 16x | 160000 |

Per-rule probabilities (from the exact 2^20 enumeration):

| survivors | rule 0 | rule 1 | rule 2 |
|---|---:|---:|---:|
| 0–5 | 52.6% | 53.7% | 54.4% |
| 6–7 | 20.3% | 14.2% | 5.3% |
| 8–12 | 25.9% | 31.1% | 39.7% |
| 13–20 | 1.2% | 1.0% | 0.6% |

## RTP class

**EXACT 9574 bps** (`EXPECTED_RTP_BPS = 9574`; exact value 9574.2035 = 95.742035%), from a full
enumeration of `2^20` decks under rule 0. The enumeration is not a simulation: the board space is
finite, uniform and complete, so the figure is a rational with denominator `2^20`. House edge
≈ 4.26%; the 16x top tier is reachable on 0.64%–1.22% of decks depending on the rule.

`outcome(word)` is the default-rule entry point and is a pure function of the word;
`outcomeWithRule(word, ruleId)` is the explicit-rule entry point.

## Exports

`SLUG`, `ROWS`, `COLS`, `CELLS`, `ROWMASK`, `GENERATIONS`, `MIN_STAT`, `MAX_STAT`, `RULES`,
`DEFAULT_RULE`, `BANDS`, `EXPECTED_RTP_BPS`, `RULE_RTP_BPS`, `tableFor`, `step`, `population`,
`census`, `wordTo20`, `evolution`, `bandOf`, `outcome`, `outcomeWithRule`, `makeRng`.

Run the model tests with `npm test`; the exact per-rule enumeration with `node tools/tune.mjs`.
