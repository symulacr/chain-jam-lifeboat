# lifeboat — RTP proof

## Declaration

| | |
|---|---|
| `EXPECTED_RTP_BPS` | **9574** |
| exact value | **9574.2035 bps** (95.742035%) under **rule 0 (B25/S014)** |
| why this number | rule 0 is the **lowest** of the three rules, and `outcome(word)` uses it. The declaration is therefore the floor across every rule the player can lock |
| method | **EXACT enumeration** of the deck space, **per rule** |
| window | all three rules inside the jam's accepted `[9300, 9800]` |
| house edge | ~4.26% |
| top tier | 16x at 0.64%–1.22% depending on the rule |

Per-rule exact figures, each from its own full enumeration of `2^20` decks:

| rule | exact RTP (bps) | top-tier probability | body variance (scaled 1e18) |
|---|---|---|---|
| 0 — B25/S014 (default) | **9574.2035** | 12840/2^20 = 1.2245% | 1.327996826171875000e18 |
| 1 — B25/S23 | 9575.7103 | 10880/2^20 = 1.0376% | 1.447100067138671875e18 |
| 2 — B24/S23 | 9594.7456 | 6740/2^20 = 0.6428% | 1.662549591064453125e18 |

**Spread across the three rules: 20.5421 bps.** That is the point of the design, not an
accident: the rule choice must move the *shape* of the census, not the expected return. If
one rule paid materially better, the "decision axis" would collapse into "press the
highest-RTP button" and the novelty claim would be hollow.

## Why this is exact, not simulated

`outcomeWithRule(word, rule)` folds the 32-byte word to 20 bits:

```
w20 = (u32(word[0:4]) ^ u32(word[4:8]) ^ u32(word[8:12]) ^ u32(word[12:16])) & 0xFFFFF
```

The XOR of independent uniform lanes is uniform, so `w20` is uniform over exactly
`2^20 = 1,048,576` values. Those 20 bits **are** the initial deck — one bit per berth,
row-major, 4 rows × 5 columns, toroidal. The automaton is a pure function of the deck and
the rule, so the whole outcome depends on nothing else and every deck is reachable.
Enumerating all 2^20 decks for each rule gives the exact distribution.

```
             SUM_v count(v) * bps(v)
rtp_bps  =   ----------------------        with bps: 0-5 -> 0, 6-7 -> 12000,
                       2^20                          8-12 -> 20000, 13-20 -> 160000
```

Worked, for the default rule: `10039280000 / 2^20 = 9574.2035 bps`.

## Exact histograms (`tools/tune.mjs`)

Rule 0 — B25/S014 — the counted one (`outcome(word)` uses this rule):

```
survivors  count      prob%      mult    contribution bps
        0   250156   23.85674       0              0.000
        1   162680   15.51437       0              0.000
        2    11080    1.05667       0              0.000
        3    56220    5.36156       0              0.000
        4    55200    5.26428       0              0.000
        5    15960    1.52206       0              0.000
        6   152990   14.59026     1.2           1750.832
        7    60000    5.72205     1.2            686.646
        8   139640   13.31711       2           2663.422
        9    46480    4.43268       2            886.536
       10    49240    4.69589       2            939.178
       11     1800    0.17166       2             34.332
       12    34290    3.27015       2            654.030
       14    11600    1.10626      16           1770.020
       16     1240    0.11826      16            189.209
total 1,048,576 / 1,048,576      EXACT = 9574.2035 bps -> 9574
```

Note `survivors = 13` never occurs under rule 0 (the values jump 12 → 14). The band
`13–20` is still reachable and pays: 14 and 16 both land in it, together 1.22% of decks.

Rule 2 — B24/S23 — reaches 13 (0.589%) and 15/16 (0.023% each); rule 1 reaches 13 (0.061%),
14 (0.755%) and 18 (0.198%).

## Independent cross-checks

| check | who | result |
|---|---|---|
| all three rules re-enumerated with a second implementation | `tests/model.test.mjs` recomputes each rule's exact RTP from its own histogram and asserts the declared per-rule figures and the floor | PASS |
| the shipped row-lookup automaton vs an independently written naive Moore-neighbour counter | same test file, 700+ boards + all 14 generations | PASS |
| CSPRNG re-derivation, 2,000,000 rounds of `crypto.randomBytes` the candidate does not control | harness check 11 (default rule) | see `reports/verification.txt` |
| candidate's sampler vs an independent CSPRNG over 2,000,000 rounds from round 5,000,000 | harness check 12 | see `reports/verification.txt` |
| key-space collision sweep, seven magnitude windows up to 2^52 | harness check 13 | see `reports/verification.txt` |

## Which rules were rejected, and why

All measured on this exact 20-berth torus at K = 14, by full enumeration:

| rule | P(extinct) | verdict |
|---|---|---|
| B3/S23 (classic) | 82.9% | rejected — degenerate, one outcome on 5 in 6 decks |
| B36/S23 (HighLife) | 72.6% | rejected — same problem |
| B3/S12345 | 0.8% | rejected — 91% of decks land on 10, 11 or 12 |
| B3/S1234 | 21.4% | rejected — 37.9% land on exactly 10 |
| B34/S34 | 61.7% | rejected |
| B35/S236 | 43.2% | near miss (broad) but no partner triple keeps the spread tight |
| B36/S235 | 36.3% | near miss (broad) |
| B368/S238 | 60.2% | rejected — 9.8% land on exactly 20 |
| **B25/S014, B25/S23, B24/S23** | 23.9 / 28.7 / 36.8% | **kept** |

The triple was chosen by searching every 3-subset of ~20 measured rules against every
5-tier table in a bounded grid, minimising the shared-table RTP spread subject to all three
landing in `[9350, 9780]` and the top tier staying reachable (≥ 0.6%). This triple is the
minimum found at 20.5 bps; the next-best candidates sit at 81–198 bps. A 20-cell torus is
too small for the structures that keep the famous rules alive, so this is a consequence of
the deck size, not a preference.

## Defect history — the C1 bug this build must not repeat

`research/wave5-contradictions.md` C1: Wave 3 declared 96.816% RTP when the true figure was
91.78%, because the round **sampler** was `seed0 + round * 2654435761`, which passes 2^53 at
round ~3,393,263 and collapses the low bits. `tune.mjs` then proved the paytable with the
same broken sampler.

What this build does instead:

- `makeRng(seed0, round)` splits `round` into `lo = round >>> 0` and `hi = floor(round/2^32)`
  and mixes both with `Math.imul` / `^` / `+` / `>>> 0` only. No float accumulates.
- Collision-tested over 700,000 round indices across seven windows — zero duplicates. The sampler is
  injective within each 2^32-round window; collision-freedom up to 2^52 is NOT proven (a test result,
  not a proof). See `docs/adversarial.md`.
- The declared RTP does not come from the sampler at all: it is a rational with denominator
  2^20, computed by enumerating the deck space. Different kind of claim, separately checked.

## What is exact and what is not

- **Exact**: the paytable (integer bps), the deck space (2^20), the census for every deck
  under every rule, each rule's RTP, each rule's top-tier probability and body variance.
- **Not exact**: nothing about the *outcome function*. The only approximate quantities are
  the integers the harness re-measures on a sample (`reports/verification.txt`), which is
  what that sample is for.
- **Not addressed here**: `GENERATIONS = 14` is a fixed constant, not derived. A different K
  would need a new enumeration and a new table. No sensitivity sweep over K is included.
