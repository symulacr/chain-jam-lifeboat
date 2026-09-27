# lifeboat — architecture

## What it is

LIFEBOAT is a cellular-automaton census dealt by one verified random word. One wager, one word,
one census. The page is framework-free and has no runtime dependency; the maths is one ES module
shared by the page, the tests and the harness; the money is decided by a Solidity contract that
re-implements the same arithmetic.

## Layout

```
top3/01-lifeboat/
  index.html                 servable page: loads ./src/styles.css and ./src/app.js,
                             preloads ./game/model.mjs, carries the literal widget tag
  game/
    model.mjs                THE deterministic model — the single source of truth
    README.md                the mechanic, the paytable, the VRF mapping, the RTP class
  src/
    app.js                   the frontend app; imports ../game/model.mjs and ./sdk/guest.mjs
    styles.css               the chrome (no external asset; no url(...) reference)
    sdk/guest.mjs            vendored SDK bridge, byte-identical to jam-candidates/shared/guest.mjs
  contracts/
    LifeboatGame.sol         ICasinoGameV2 implementation — WHERE THE MONEY IS DECIDED
    ICasinoGameV2.sol        the interface (shared shape)
  public/
    game.manifest.json       Chain manifest (full-iframe, openSession true, submitAction false)
    og-image.png             self-generated 1200x630
    _headers, vercel.json    host configs: CORS on the manifest only, NO X-Frame-Options
  tests/
    model.test.mjs           the model, incl. an independent naive automaton cross-check
    contract.test.mjs        contract source checks + executed JS<->Solidity algorithm parity
  docs/                      this file, rtp, vrf, chain-integration, standalone, iframe,
                             testnet, security, rtp-proof, verification.txt
  scripts/                   build.mjs, check.mjs, serve.mjs (no dependency)
  tools/                     tune.mjs (exact 2^20 enumeration), browser-verify.mjs
  dist/                      BUILD OUTPUT (gitignored), produced by `npm run build`
```

## The split (this is a restructure of a verified single file)

The verified candidate was one `index.html` with an inline `<style>` and one inline
`<script type="module">`. It is split with no behavioural change:

| source (verified) | destination | change |
|---|---|---|
| `<style>` block of `index.html` | `src/styles.css` | whitespace/indentation only |
| `<script type="module">` body | `src/app.js` | one import path: `./model.mjs` → `../game/model.mjs` |
| `model.mjs` | `game/model.mjs` | none — byte-identical |
| `shared/guest.mjs` | `src/sdk/guest.mjs` | none — byte-identical (sha256 checked at build) |
| `game.manifest.json` | `public/game.manifest.json` | none |
| `og-image.png` | `public/og-image.png` | none |
| `contracts/*.sol` | `contracts/*.sol` | none |
| `tests/model.test.mjs` | `tests/model.test.mjs` | one import path |
| `rtp-proof.md`, `reports/*` | `docs/*` | renamed, content kept |

The verifier `jam-candidates/tools/verify-candidate.mjs` requires `index.html` to reference
`model.mjs`, so the page carries `<link rel="modulepreload" href="./game/model.mjs">`. That is not
decoration: it preloads the exact module `src/app.js` imports, and it keeps the harness's "the page
must execute the model it verifies, never a transcribed copy" check true.

## Data flow — the page

```
word (32 bytes)                     <- host VRF, or crypto.getRandomValues in standalone demo
  -> wordTo20: XOR of four big-endian u32 lanes, & 0xFFFFF  [20 bits == the initial deck]
  -> evolution(board, rule) x 14      row-lookup table, four lookups per generation
  -> population(final frame)          the census (0..20)
  -> bandOf(census)                   the return multiple
```

The rule comes from outside the word and is fixed **before** the word exists. The page never
re-implements the automaton: it imports `evolution`, `census`, `RULES` and `bandOf` from
`game/model.mjs`, so the census the harness verifies is the census the page counts.

## Where the money is decided — the contract

**The browser cannot change a payout.** The money path lives entirely in
`contracts/LifeboatGame.sol`, which the host calls; the page only renders what the contract
returns.

```
host.openSession({ wager, gameData: '0x<rule>' })
  -> casino escrows; calls LifeboatGame.onSessionStart(ctx)
       reads rule from ctx.gameData, commits newGameState = abi.encode(rule),
       commits the full reserve wager*160000/10000 - wager, WAITING_RANDOMNESS,
       requestRandomnessNow = true                          <- rule is now FIXED, before any word
  -> VRF fulfilled; casino calls LifeboatGame.onRandomness(ctx, randomness)
       reads rule from ctx.gameState  (NOT gameData — it cannot be re-chosen here)
       board = fold(randomness); survivors = 14 generations then popcount
       payout = ctx.wagerBase * _multBps(survivors) / 10000
       newGameState = abi.encode(rule, board, survivors, payout); SETTLED, payout released
```

The page's role in that path is `pollSnapshot()`: it decodes the four ABI words the contract wrote
into `gameState`, replays `evolution(board, rule)` purely for the animation, and displays the
contract's `survivors` and `payout`. If a hostile page drew a different board, it would change only
what its own pixels show — the escrow, the payout and the settlement are contract values.

Three properties make this checkable by a reader:

1. `onSessionStart` commits the rule to `newGameState`, and `onRandomness` reads it back from
   `ctx.gameState`. `onRandomness` never reads the rule from `ctx.gameData`, so a host that
   re-sent a different `gameData` could not change the outcome after the word exists.
   (`tests/contract.test.mjs` asserts both directions, including that `onRandomness` contains no
   `gameData` reference.)
2. Every payout routes through one `_multBps`/`_payout` pair, and the reserve committed at start is
   exactly `escrowedStake + reservedProfit - escrowedStake` for the 16x top band; the settling step
   returns `reservedProfitDelta = 0`, so the cap and the payout cannot disagree. A payout can never
   exceed the escrow plus the reserved profit.
3. All six handlers are `external pure`: no storage, no external calls. The game holds no state
   that could be incremented twice and cannot reenter.

`tests/contract.test.mjs` also runs an executed JS↔Solidity parity check: a transliteration of the
contract's `_fold20`/`_step`/`_census`/`_multBps` (reading the contract's own masks and boundaries)
is compared against `model.mjs` on sampled boards and words for all three rules. That test is still a
JS transliteration, not a stepping of the compiled bytecode — but the compiled bytecode has since
been executed for real on the local simulator (chain id 31337): 20 settled rounds, each payout
re-derived from the chain-emitted randomness and matched, plus a max-payout eth-call within cap. See
`docs/chain-integration.md` ("Deployed and settled on the local simulator") and `docs/verification.txt`
§8.4.

## Data flow — the build

`npm run build` copies `index.html`, `game/` and `src/` (minus markdown) and the contents of
`public/` into `dist/`, with no bundler and no dependency. `dist/` is a static tree with the same
relative layout the page expects, so any static host (or `npm run serve`) can serve it. See
`docs/standalone.md` for the served observations and `docs/verification.txt` for the raw numbers.

## Cost of a round

- JS: 15 board states, four lookups each. The exact RTP enumeration (`tools/tune.mjs`) walks
  3 × 2^20 boards in about 130 ms per rule.
- Solidity: 14 generations × 4 rows × 5 columns of direct neighbour counting. No storage, no VRF
  call, no unbounded loop. The row-lookup table is deliberately not mirrored on chain — the
  contract counts neighbours directly so a reader can check the automaton by eye, and
  `tests/contract.test.mjs` proves the two forms agree.
