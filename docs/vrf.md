# lifeboat — VRF mapping and the locked rule

## What the word maps to, and how many bits it consumes

The VRF word is a uniform 256-bit value. LIFEBOAT reads only its **first 128 bits** and folds them
to **20 bits**, which are the entire initial deck:

```
w20 = (u32(word[0:4]) ^ u32(word[4:8]) ^ u32(word[8:12]) ^ u32(word[12:16])) & 0xFFFFF
```

- **Lanes read:** four big-endian u32 words — bytes 0..3, 4..7, 8..11, 12..15.
- **Combination:** XOR. Each lane is uniform because the VRF word is uniform, and the XOR of
  independent uniform values is uniform, so `w20` is uniform over exactly `2^20` values.
- **Mask:** `& 0xFFFFF` keeps the low 20 bits.
- **Bits consumed: 20.** The board is 4 rows × 5 columns = 20 berths, so one folded bit addresses
  one berth. Bit `r*5 + c` (row-major) is berth `(r, c)`.
- **Bytes 16..31 of the word are unused.** The contract performs the same four-lane XOR over
  `bytes4(randomness)`, `bytes4(randomness << 32)`, `bytes4(randomness << 64)`, `bytes4(randomness << 96)`.

Because `w20` is uniform over exactly `2^20` and the automaton is deterministic, the reachable deck
space is exactly `2^20` per rule and every deck is reachable once. That is what makes the exact
enumeration in `docs/rtp-proof.md` legitimate rather than optimistic.

## The claim: for a fixed locked rule, the round is a pure function of the word

`outcome(word)` uses the default rule, so it is pure in the word alone. `outcomeWithRule(word,
ruleId)` is pure in `(word, rule)`, and the rule is fixed before the word exists.

## The decision axis

| | |
|---|---|
| what the player chooses | one of three Life-like rules, before the wager |
| when it is fixed | standalone: frozen when the round starts, stated in the UI. On chain: committed in `onSessionStart` into `newGameState`, before the randomness request |
| why it is real | the same 20-bit deck evolves differently under each rule; the test suite samples decks and asserts the censuses differ |
| why it is not trivial | all three rules pay the same expected return within **20.54 bps** on one shared table, so there is no "best-paying button" to press |
| closest approved entry | `CASCADE` — a one-shot spread. No approved entry lets the player choose the *rule* of the reveal |

`outcome(word)` is literally `outcomeWithRule(word, DEFAULT_RULE)`, same shape and same numbers, and
`tests/model.test.mjs` asserts that identity. The default is rule 0 because rule 0 is the
lowest-paying of the three, which makes the declared RTP a floor rather than a best case.

## The on-chain lock, precisely

The rule cannot be changed after the word is drawn because of where each handler reads it:

1. The page sends `gameData = '0x' + hex(ruleId)` to `openSession`.
2. `onSessionStart` reads it with `_ruleFrom(ctx.gameData)` and returns
   `newGameState = abi.encode(rule)`. This runs before the VRF request; `requestRandomnessNow = true`
   is returned from the same call.
3. `onRandomness` reads the rule with `_committedRule(ctx)`
   (`contracts/LifeboatGame.sol:76-83`), which `abi.decode`s the 32-byte committed word from
   `ctx.gameState` — the contract-written state the casino persists. It must NOT be `_ruleFrom`
   here: `onSessionStart` writes a full big-endian word whose byte 0 is always `0x00`, and
   `_ruleFrom` reads `gameData[0]` as the rule (see the F1 note in §The round sampler below).
4. `_committedRule` falls back to `_ruleFrom(ctx.gameData)` when `gameState` carries no usable
   committed rule — empty, not 32 bytes, or out of range. That is the case of a context that never
   passed through `onSessionStart`, and it exists so verified behaviour cannot regress: `gameData`
   then carries exactly the hint `onSessionStart` would have committed.

So even if a host resubmitted a different `gameData` *after* a valid session started, the settling
step ignores it — the committed word is the authority. `tests/evm.test.mjs` asserts that direction
on a deployed contract for all three rules, and four boundary cases where the fallback *does* fire.
**No test asserts that `onRandomness` contains no `gameData` reference, and none should**: the
fallback is deliberate, and the one negative regex in `tests/contract.test.mjs` (`:96-100`) runs
against the whole file, forbidding the `uint8(gameState[0])` reader that caused F1.

**Residual trust assumption**: the host persists `newGameState` and hands it back unchanged. This is
the same assumption the reference `FloodGame` makes. A live local-simulator settlement did run in
Wave 3 (20 rounds), but every probe round used the default rule, so the assumption is only exercised
for rule 0; a non-default-rule round-trip is still not observable (`docs/verification.txt` §7, §8.4).

## The round sampler (the C1 bug this build must not repeat)

`makeRng(seed0, round)` is counter-based: `round` is split into `lo = round >>> 0` and
`hi = floor(round / 2^32)`, four lanes are mixed with `Math.imul` / `^` / `+` / `>>> 0`, and eight
32-bit words are finalised with a murmur3-style `fmix32`. Nothing accumulates a float.

Contrast the Wave-3 defect (`research/wave5-contradictions.md` C1): `seed0 + round * 2654435761`
passes 2^53 at round ≈ 3,393,263, destroys the low bits, and shipped a false RTP declaration.
Harness evidence: 700,000 round indices across seven magnitude windows up to 2^52, zero duplicate
words. That sweep is a cross-check, not a proof: the sampler is a bijection of the round index within
each 2^32-round window, and collision-freedom across all windows up to 2^52 is NOT proven (see
`docs/adversarial.md`). The declared RTP does not come from the sampler at all — it is the exact `2^20`
enumeration.

## A wrong label that was caught and corrected

The first draft of `model.mjs` labelled its three rules `B36/S125`, `B36/S23`, `B35/S23` while
carrying masks `0b000100100`, `0b000100100` and `0b000010100`. Decoded properly those masks are
**B25/S014**, **B25/S23** and **B24/S23** — one bit position off from the labels. The measured
distributions were always correct for the masks; only the names were wrong. The labels were
corrected to the masks, a decoding test was added, and the famous rules were measured properly so
the rejection is on the record (classic B3/S23 is extinct on 82.9% of decks, HighLife B36/S23 on
72.6%). This is recorded because a mislabelled rule would have been an untrue claim in a money-path
document.
