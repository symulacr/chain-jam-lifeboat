# LIFEBOAT

A cellular-automaton census dealt by one verified random word.

A 4×5 toroidal deck of 20 berths. One verified random word lights the berths (one bit each). The
player **locks one of three life rules before the wager**; the deck then runs a Life-like automaton
for a fixed **14 generations**, and the payout is a banded function of the **live population of the
final frame** — the census — under the rule that was locked.

The pitch, stated precisely: this is *not* "watch it spread" (the one-shot-spread family is
crowded). What is new is that the *census after N generations* is the scored statistic, and the
player chooses the *rule* of the reveal before the word exists. No approved entry lets a player
choose the rule of the reveal.

## Quick start

```sh
npm run build     # assemble dist/ — no bundler, no runtime dependency
npm test          # model tests (exact 2^20 RTP) + contract tests (source + model parity)
npm run check     # node --check on every .js/.mjs in the project
npm run serve     # static server on http://127.0.0.1:8901/  (serves dist/)
```

There is **nothing to install**: `package.json` has no `dependencies` and no `devDependencies`.
Node ≥ 18 is required (the project is ESM; `node --test`-free custom runners, global `fetch`/`WebSocket`
only in the optional browser harness).

The page needs `http(s)` — it imports ES modules, and browsers refuse module imports over `file://`.

## Layout

```
index.html            the servable page
game/model.mjs        THE deterministic model (single source of truth) + game/README.md
src/app.js            the frontend app (imports ../game/model.mjs and ./sdk/guest.mjs)
src/styles.css        the chrome
src/sdk/guest.mjs     vendored SDK bridge, byte-identical to jam-candidates/shared/guest.mjs
contracts/            LifeboatGame.sol (ICasinoGameV2) + ICasinoGameV2.sol
public/               game.manifest.json, og-image.png, _headers, vercel.json
tests/                model.test.mjs, contract.test.mjs
docs/                 architecture, rtp, rtp-proof, vrf, chain-integration, standalone, iframe,
                      testnet, security, verification.txt
scripts/              build.mjs, check.mjs, serve.mjs
tools/                tune.mjs (exact enumeration), browser-verify.mjs
dist/                 build output (gitignored)
```

## The maths, in one place

- **VRF mapping.** Only the first 16 bytes of the word are read, as four big-endian u32 lanes; they
  are XORed and masked to **20 bits**, which are the entire initial deck (one bit per berth).
  **Bits consumed: 20.** See `game/README.md` and `docs/vrf.md`.
- **Rules.** `B25/S014` (default), `B25/S23`, `B24/S23`. The default is the lowest-paying of the
  three, so the declared RTP is a floor across every choice.
- **Paytable** (one table for all three rules):

  | survivors | return |
  |---|---|
  | 0–5 | 0 |
  | 6–7 | 1.2x |
  | 8–12 | 2x |
  | 13–20 | 16x |

## RTP — EXACT 9574 bps

`EXPECTED_RTP_BPS = 9574` (exact 9574.2035 = 95.742035%), from a **full enumeration of the 2^20 deck
space** under the default rule. This is exact, not a simulation: the folded word is uniform over
exactly `2^20` decks and every deck is reachable once.

| rule | exact RTP |
|---|---:|
| 0 B25/S014 (default, declared) | 9574.2035 |
| 1 B25/S23 | 9575.7103 |
| 2 B24/S23 | 9594.7456 |

Spread: 20.5421 bps — deliberately, so locking a rule changes the *shape* of the census, not the
expected return. All three inside the jam's `[9300, 9800]`. House edge ≈ 4.26%; the 16x top tier is
reachable on 0.64%–1.22% of decks. Derivation and cross-checks: `docs/rtp-proof.md`, `docs/rtp.md`.

## The contract — where the money is decided

`contracts/LifeboatGame.sol` is an `ICasinoGameV2` implementation with no constructor and all six
handlers `external pure`. The rule is committed into `newGameState` at `onSessionStart` (before the
randomness exists) and read back from `ctx.gameState` at `onRandomness`. The payout is
`wager * _multBps(census) / 10000`, the reserve is `16·w − w = 15·w` so `escrow + reserve = maxPayout`
exactly, and the settling step returns `reservedProfitDelta = 0`. **The browser only renders what the
contract returns — it cannot change a payout.** See `docs/architecture.md` and
`docs/chain-integration.md`.

The contract compiles standalone (`solc 0.8.36 --optimize`, `LifeboatGame.bin` = 2859 bytes), and
`tests/contract.test.mjs` runs an executed JS↔Solidity parity check (a transliteration of the
contract's fold/automaton/paytable against the model) — it does not need a chain.

## Where this lives

| | |
|---|---|
| repository | **https://github.com/symulacr/chain-jam-lifeboat** |
| branch | `master` |
| jam status | **approved**, submitted 2026-09-27, live in the jam gallery |
| public build | https://chain-jam-lifeboat.vercel.app |

Pushed and current on `master`. Paths like `research/…`, `jam-candidates/…` and `vendor/…` cited
in the docs below are relative to the parent monorepo, not to this repository; a clean clone of
this repo builds and tests on its own.

## Public deployment notes

- `dist/` is a static tree: `index.html`, `game/`, `src/`, and the contents of `public/` at the
  root. Serve it as-is; no rewrite rules are needed or desired.
- `public/_headers` (Netlify/Cloudflare Pages) and `public/vercel.json` (Vercel) set CORS on
  `/game.manifest.json` only. **Do not add `X-Frame-Options`** and do not add a catch-all
  `/* /index.html 200` rewrite (it would shadow the manifest and the `.mjs` siblings).
- The page must remain embeddable inside `*.chain.wtf`; there is no framing blocker.
- The public production URL for this entry is **https://chain-jam-lifeboat.vercel.app** (Vercel,
  deployment `dpl_8tn14CMSZ7waPE9oZKrrjug18qD1`), verified externally: `index.html` as `text/html`,
  the `.mjs` assets as a JavaScript MIME, `game.manifest.json` as `application/json` with CORS, no
  framing header, widget tag present. See `research/public-deploy-top3.md`.
- Production-chain deployment and the production Chain.wtf host remain `EXTERNAL BLOCKED` — there is
  no public testnet path for an entrant. See `docs/testnet.md`, `EXTERNAL-CHAINWTF-LIMITATION.md`.

## Limitations (honest)

- **On-chain execution is proven on the local simulator** (chain id 31337): `LifeboatGame` is
  deployed (tx `0xd238c250a415707933b30b9ce4922c63972a8bc0f2cd800e5de762bf2e07a6e1`, block 19,
  gasUsed 566101) and settled **21 sessions with 21 unique VRF fulfilments**, 0 stuck, 0 parity
  failures, with every payout re-derived from the randomness the chain emitted and the 16x max-payout
  path eth-called within cap. See `docs/chain-integration.md`, `docs/verification.txt`.
- **Host-embed settlement has been observed end-to-end** in the SDK's own production-faithful host
  harness (`vendor/casino-sdk/simulator`): the guest mounted, a wager was placed **through the
  bridge**, and the settled reveal was read from the guest's own DOM (session 61; sessions 20 → 21).
  That is the documented dev environment, **not** the live production chain.wtf host, which stays
  `EXTERNAL BLOCKED`. See `docs/verification.txt` §8 (the run record) and `research/host-embed-report.json` in the parent monorepo.
- **`ctx.gameState` round-tripping is only partially observed**: every probe round opened with
  `gameData '0x'` (rule 0), the same default `_ruleFrom('')` returns, so a failed
  non-default-rule round-trip is indistinguishable. Recorded, not hidden.
- **`GENERATIONS = 14` is a fixed chosen constant**, not derived. A different K would need a new
  enumeration and a new paytable; no sensitivity sweep over K is included.
- **The page is verified standalone both locally and from the public host**: the built `dist/` was
  driven over the DevTools Protocol on localhost, and the deployed public URL was driven in a real
  headless browser (it resolved a demo round and rendered the Chain Jam widget badge). See
  `docs/standalone.md` and `research/public-deploy-top3.md`.
- `solcjs` specifically was not available; the svm `solc` driver was used (same compiler, same flags).

## License

MIT — see `LICENSE`, matching the SPDX identifier in the contract.
