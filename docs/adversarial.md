# lifeboat — Wave 4A adversarial closeout

Hostile, independent closeout of the claims made by `top3/01-lifeboat/`. This reviewer did not
build the project. The brief was to **break** the claims, not confirm them; a claim that survives a
genuine attempt is a result, and anything not tested is marked `UNTESTED`.

Environment: WSL2 Ubuntu-24.04, node `v26.10.0`, `solc 0.8.34+commit.80d5c536.Linux.g++`.
All scratch computation was run through `node --input-type=module` on stdin — no helper file was
written inside or outside the project. The only files written outside the project are the two the
brief itself mandates/carries: `/tmp/clean-01-lifeboat` (the clean checkout) and `/tmp/w4a-lb-out`
(a throwaway `solc` output directory). Nothing under a sibling project, `jam-candidates/**`,
`research/**`, or any root file was read or written.

Protected files (`game/model.mjs`, `contracts/*.sol`, `src/**`, `index.html`, `public/**`,
`tests/**`, `package.json`, `LICENSE`) were not edited. `dist/` was not rebuilt in place.

## Verdict summary

| # | attack | verdict |
|---|---|---|
| 1 | independent exact RTP enumeration | **NOT FALSIFIED** — 9574.2035 reproduced exactly; **one published histogram row-set corrected** |
| 2 | model↔contract parity | **NOT FALSIFIED** — 0 mismatches over the full 2^20 × 3 board space |
| 3 | payout cap structure | **NOT FALSIFIED** (one host-level assumption stated) |
| 4 | framing / manifest / hygiene (shipped `dist/`) | **NOT FALSIFIED** |
| 5 | doc-truth hunt | **2 WRONG claims corrected, 1 WRONG claim reported but out of edit scope, 1 IMPRECISE corrected, several UNTESTED** |
| 6 | clean-checkout build/test/check | **NOT FALSIFIED** — green with **no install** |
| 7 | secret scan | **NOT FALSIFIED** — no secret of any kind |

---

## Attack 1 — independently re-derive the exact RTP, from scratch

**Method.** I wrote a fresh automaton from the definition, with no import of the project's model,
tests, or `tools/tune.mjs`. Two independent implementations:

- a **row-lookup** automaton whose 32×32×32 transition table I built myself by explicit
  `(row, col)` torus neighbour counting, and
- a **fully naive** step that counts the eight Moore neighbours directly with `(y±1, x±1)` wrap,
  no table at all.

I then enumerated **all 2^20 boards** for each rule and summed `count(v) * multBps(v) / 2^20`, using
a paytable transcribed from the contract's own guards.

**Raw result** (`node` stdin, my own code):

```
[table vs naive]  boards sampled=3156  step-mismatches=0
rule 0 hist (0..20): 250156,162680,11080,56220,55200,15960,152990,60000,139640,46480,49240,1800,34290,0,11600,0,1240,0,0,0,0
  reachable stats = [0..12 (except none missing), 14, 16]
  EXACT RTP = 10039280000/2^20 = 9574.203491210938 -> 9574
rule 1  EXACT RTP = 10040860000/2^20 = 9575.71029663086  -> 9576
rule 2  EXACT RTP = 10060820000/2^20 = 9594.745635986328 -> 9595
exact RTPs: 9574.2035, 9575.7103, 9594.7456 ; spread 20.5421 bps
declared 9574 matches rule0 exact: true ; default(rule0) is the floor: true
top-tier prob rule0 = 1.2245%
```

A second, fully naive enumeration over the whole space confirmed it independently:

```
FULL NAIVE rule0 hist: 250156,162680,11080,56220,55200,15960,152990,60000,139640,46480,49240,1800,34290,0,11600,0,1240,0,0,0,0
MODEL rule0 hist:      250156,162680,11080,56220,55200,15960,152990,60000,139640,46480,49240,1800,34290,0,11600,0,1240,0,0,0,0
step-level mismatches over ALL 2^20 boards x 3 rules: 0
census-rule0 mismatches over ALL 2^20 boards: 0
```

`EXPECTED_RTP_BPS = 9574`, the exact `9574.2035`, and the per-rule `RULE_RTP_BPS =
[9574.2035, 9575.7103, 9594.7456]` are all reproduced. **Verdict: NOT FALSIFIED.**

**Band-boundary check.** I enumerated which census values are reachable, then built a word whose
fold lands exactly on each band-boundary board and checked the contract transliteration against the
model:

```
boundary stat 0 : rule0 board 0x0   contract 0/0bps      model 0/0bps      agree=true
boundary stat 5 : rule1 board 0x1f  contract 5/0bps      model 5/0bps      agree=true
boundary stat 6 : rule0 board 0xb   contract 6/12000bps  model 6/12000bps  agree=true
boundary stat 7 : rule0 board 0x5   contract 7/12000bps  model 7/12000bps  agree=true
boundary stat 8 : rule2 board 0x3   contract 8/20000bps  model 8/20000bps  agree=true
boundary stat 12: rule2 board 0xb   contract 12/20000bps model 12/20000bps agree=true
boundary stat 13: rule2 board 0x7   contract 13/160000bps model 13/160000bps agree=true
boundary stat 20: NOT REACHABLE by any rule
```

Every reachable band edge agrees between model and contract. `survivors = 20` is **unreachable**
under all three rules yet both sides still price it identically (`16x`), so the unreachable edge is
harmless. `survivors = 13` is unreachable under rule 0 (matching `docs/rtp-proof.md`) but reachable
under rules 1 and 2.

### Correction 1 — the published rule-0 histogram was wrong (presentation only; RTP unaffected)

`docs/rtp-proof.md` printed these three rows, which disagree with the actual enumeration:

| survivors | doc said | actual | doc prob% | actual prob% |
|---|---:|---:|---:|---:|
| 0 | 250326 | **250156** | 23.87289 | **23.85674** |
| 1 | 162380 | **162680** | 15.48584 | **15.51437** |
| 2 | 12000 | **11080** | 1.14441 | **1.05667** |

The doc's own rows summed to **1,049,366** while it claimed a `1,048,576 / 1,048,576` total — an
arithmetic impossibility in a money-path document. My two independent enumerations and the shipped
`model.census` all produce **1,048,576** exactly for those rows (verified three ways). The affected
states all pay `0`, so the **RTP is identical**; only the printed table was false. Fixed in
`docs/rtp-proof.md` (counts and percentages replaced with the enumerated values).

---

## Attack 2 — model↔contract parity, attacked at the source

**Method.** `tests/contract.test.mjs` is a JS transliteration and could share a bug with the model.
I bypassed it entirely: I **parsed the masks, `MAX_MULT_BPS`, `EXPECTED_RTP_BPS`, `GENERATIONS`,
the `_multBps` guards and the fold mask directly out of `contracts/LifeboatGame.sol` with regexes**,
then wrote my own transliteration driven only by those parsed constants, and compared it to the
model over the **entire** board space.

**Raw result:**

```
parsed contract masks: {"0":[36,19],"1":[36,12],"2":[20,12]}
parsed: GEN=14 MAX_MULT_BPS=160000 EXPECTED_RTP_BPS=9574 guards=[[13,160000],[8,20000],[6,12000]]
_fold20 contains & 0xfffff: true
[FULL 2^20 x3] contract _step  vs model.step   mismatches: 0
[FULL 2^20 x3] contract _census vs model.census mismatches: 0
rule 0: contract B25/S014 model B25/S014 match=true
rule 1: contract B25/S23  model B25/S23  match=true
rule 2: contract B24/S23  model B24/S23  match=true
paytable mismatches over stats 0..20: 0
fold parity over 200005 words: mismatches=0; word->census path mismatches=0
```

I tried to construct a word where the contract pays differently from the model by reasoning about
the fold, the generations and the band boundaries. The fold is a four-lane big-endian XOR masked to
20 bits on both sides; the automaton is the same four-lookup row table on the model side and the
same direct neighbour count on the contract side; the paytable guards (`>=13 / >=8 / >=6`) are an
order-preserving restatement of the ascending bands. Over all 3 × 2^20 boards the two agree at the
`_step` level, the `_census` level, and the payout level. **I could not falsify parity. NOT
FALSIFIED.** The one residual gap is unchanged from the project's own disclosure: this compares a
transliteration, not the compiled EVM bytecode stepping board by board (the bytecode *was* run on
the local simulator for settlement, per `docs/verification.txt` §8.4, but I did not rerun the chain).

---

## Attack 3 — is `maxPayout <= escrowedStake + reservedProfit` structural?

**Method.** Parsed `MAX_MULT_BPS` and the guards from the `.sol`, then checked the identity over a
spread of wagers (including `0`, odd values, `1e18`, `1e30`, `1e40`) against every one of the 21
reachable census values, and checked for a negative/oversized reserve.

**Raw result:**

```
MAX_MULT_BPS = 160000
cap-identity/fit failures across wagers x 21 stats: 0
negative reserves observed: 0
largest reachable payout seen: 1.6e41 (at w=1e40, i.e. exactly 16x)
at w=1e18: escrow=1e18 reserve=15e18 escrow+reserve=16e18 maxPayout=16e18
any multBps > MAX? false
multBps table 0..20: 0,0,0,0,0,0,12000,12000,20000,20000,20000,20000,20000,160000,(...),160000
wager*160000 overflows uint256 above wager ~ 1.157e73
```

`quoteCaps.maxReservedProfit = w*160000/10000 - w = 15·w`; `onSessionStart` commits exactly that;
`onRandomness` returns `reservedProfitDelta = 0`/`escrowDelta = 0` and pays at most
`w*160000/10000 = 16·w = w + 15·w`. Floor division only rounds down, so every reachable payout is
`<= escrow + reserve`, and no band can produce a negative reserve (`floor(16w) >= w` for all
`w >= 0`). **NOT FALSIFIED** — structurally true, not merely observed once.

**Stated assumption (not a falsification).** The cap identity uses
`ctx.escrowedStake` at `onSessionStart` but `ctx.wagerBase` at `onRandomness`. It is exact when the
host sets `ctx.wagerBase == ctx.escrowedStake` (the documented single-wager model). A host that set
`wagerBase > escrowedStake` could pay more than the committed reserve; that is a host-level trust
assumption shared with the platform, and it is `UNTESTED` here (would need a live host). The docs do
not hide it: `docs/security.md` records that the game does not clamp the wager and that min/max is
the host's job.

---

## Attack 4 — framing / manifest / hygiene, on the shipped `dist/` only

**Method.** Scanned the nine shipped files in `dist/` with `grep` and a Node module import. I did
not rebuild `dist/` in place; the untouched shipped tree was used. I also probed the live public
host read-only.

**Raw result:**

```
=== files in dist (9) === _headers game.manifest.json game/model.mjs index.html og-image.png
                           src/app.js src/sdk/guest.mjs src/styles.css vercel.json
framing headers / CSP  -> matches only inside a `# ...` COMMENT in dist/_headers
                          ("DO NOT add X-Frame-Options ..."); no directive line
root-relative asset path (src=/ or href=/)  -> NONE
storage/cookie/window.open/service worker   -> NONE
vh / vw units                               -> NONE
script tags                                 -> 1 external (jam.chain.wtf/widget.js) + 1 first-party (./src/app.js)
localhost / 127.0.0.1 / /home / C:\          -> NONE
import specifiers starting with "/"          -> NONE
fetch(/XHR/WebSocket                          -> NONE
url(...) / @import in styles.css             -> NONE
http(s) URLs in dist                          -> widget.js (required) + a GitHub issue URL inside a guest.mjs comment
dist/game/model.mjs importable via node      -> YES; exports complete; SLUG=lifeboat, EXPECTED_RTP_BPS=9574
dist host configs (directives):
  _headers     -> /game.manifest.json : Access-Control-Allow-Origin: * ; Cache-Control: public, max-age=300
  vercel.json  -> headers[source=/game.manifest.json]{ ACAO:* , Cache-Control } only
sha256 dist/game/model.mjs            = c7a1ffe1...a772  (== source game/model.mjs)
sha256 dist/src/sdk/guest.mjs         = 46263af1...75fe  (== required vendored-bridge digest)
sha256 dist/src/app.js/index.html/css = byte-identical to src
diff -r dist /tmp/clean-01-lifeboat/dist -> IDENTICAL
```

Live public host (`https://chain-jam-lifeboat.vercel.app`, read-only HEAD):

```
/                 200 content-type: text/html; charset=utf-8   (no X-Frame-Options, no CSP)
/game/model.mjs   200 content-type: application/javascript; charset=utf-8
/game.manifest.json 200 content-type: application/json; charset=utf-8
                      access-control-allow-origin: *
```

`.mjs` is importable both by Node and by MIME on the deployed host. **NOT FALSIFIED.** Two notes,
neither a defect: (a) the literal string `X-Frame-Options` appears in `dist/_headers` but only on a
`#` comment line, so it is not a directive — a grep-only framing scanner could false-positive on it
but a directive parser will not; (b) the deployed Vercel responses carry `access-control-allow-origin: *`
on every path, whereas the shipped config files set CORS on `/game.manifest.json` only. The
*config* claim is accurate; the platform adds broader CORS at runtime. Extra CORS is permissive,
not a framing blocker.

---

## Attack 5 — doc-truth hunt

I recomputed every enumeration-derived number I could rather than reading it. At least six claims
were tested:

| claim (source) | independent result | verdict |
|---|---|---|
| rule RTPs 9574.2035 / 9575.7103 / 9594.7456 (README, rtp.md, rtp-proof.md) | reproduced exactly | **TRUE** |
| spread 20.5421 bps | 20.5421 | **TRUE** |
| top tier 0.64%–1.22% (README, rtp-proof.md) | rule0 1.2245%, rule2 0.6428% | **TRUE** |
| "survivors = 13 never occurs under rule 0" (rtp-proof.md) | `hist[13] = 0` | **TRUE** |
| rule 2 reaches 13 (0.589%), 15/16 (0.023%); rule 1 reaches 13 (0.061%), 14 (0.755%), 18 (0.198%) | 0.58937 / 0.02289 / 0.02289 ; 0.06104 / 0.75531 / 0.19836 | **TRUE** |
| top-tier WAD + body variance per rule (rtp.md, chain-integration.md, `.sol`) | reproduced bit-for-bit (12245178222656250 / 1327996826171875000, …) | **TRUE** |
| rejected-rules P(extinct) table: 82.9 / 72.6 / 0.8 / 21.4 / 61.7 / 43.2 / 36.3 / 60.2 % (rtp-proof.md) | 82.94 / 72.58 / 0.76 / 21.44 / 61.73 / 43.23 / 36.29 / 60.24 % | **TRUE** (rounding) |
| "B3/S12345 → 91% land on 10/11/12"; "B368/S238 → 9.8% on 20"; "B3/S1234 → 37.9% exactly 10" | 90.9% ; 9.8% ; 37.9% | **TRUE** |
| kept-rule P(extinct) 23.9 / 28.7 / 36.8% | 23.86 / 28.66 / 36.77% | **TRUE** |
| `LifeboatGame.bin` = 2859 bytes (README, rtp.md) | `solc --optimize` → 5718 hex chars = **2859 bytes** | **TRUE** (see caveat below) |
| `package.json` no runtime/dev deps (README) | all four dep fields `null` | **TRUE** |
| `src/sdk/guest.mjs` byte-identical, sha256 `46263af1…` | sha256 matches the required digest | **TRUE** |
| page never reads the query string (iframe.md) | no `location.search`/`URLSearchParams` anywhere | **TRUE** |
| `dist/` = 9 files (README) | 9 files | **TRUE** |
| house edge "≈ 4.0%" (README, rtp.md, rtp-proof.md) | exact edge `(10000-9574.2035)/100 = 4.257965%` | **IMPRECISE — corrected** |
| per-rule survivor-band probabilities in `game/README.md` | rule-0 and rule-1 columns are **swapped** | **WRONG — reported, NOT editable here** |

### Correction 2 — house edge mis-stated as ≈ 4.0%

`(10000 − 9574.2035)/100 = 4.257965%`. "≈ 4.0%" is off by 0.26 pp (~6% relative) and is wrong at
one-decimal precision (it rounds to 4.3%). Corrected to **"≈ 4.26%"** in `README.md`,
`docs/rtp.md`, and `docs/rtp-proof.md`. (`game/README.md` carries the same string but is outside
this task's edit grant — see the follow-ups.)

### Finding (NOT fixed — out of edit scope) — `game/README.md` per-rule probability columns are swapped

`game/README.md` publishes:

```
| survivors | rule 0 | rule 1 | rule 2 |
| 0–5  | 53.7% | 52.6% | 54.4% |
| 6–7  | 14.1% | 20.3% | 5.3%  |
| 8–12 | 31.0% | 25.9% | 39.7% |
| 13–20| 1.1%  | 1.2%  | 0.6%  |
```

My enumeration gives:

```
rule 0 MEASURED: 0-5 52.6% | 6-7 20.3% | 8-12 25.9% | 13-20 1.2%
rule 1 MEASURED: 0-5 53.7% | 6-7 14.2% | 8-12 31.1% | 13-20 1.0%
rule 2 MEASURED: 0-5 54.4% | 6-7 5.3%  | 8-12 39.7% | 13-20 0.6%
```

The "rule 0" column is actually rule 1's distribution and vice versa; the rule-2 column is correct.
This is a proven factual error but `game/README.md` is neither `README.md` nor under `docs/`, so it
was **left untouched** and is reported here for the owner to fix (swap the two columns).

### UNTESTED / unverifiable doc claims

- **"solc 0.8.36"** (README, rtp.md): the compiler available here is **0.8.34**, and it produces the
  exact stated 2859-byte artifact. `docs/verification.txt` itself flags the 0.8.36 vs 0.8.34
  discrepancy. The **byte-size** claim is verified; the **specific compiler version** is `UNTESTED`.
- **On-chain facts** (deploy tx `0xd238c2…`, block 19, gasUsed 566101, 21 sessions, 21 unique
  fulfilments): cross-checked only for internal consistency across `docs/chain-proof.json`,
  `docs/verification.txt`; the chain/host was not queried (forbidden). The
  external `research/chain-evidence.json` and `research/host-embed-report.json` were not read.
  `UNTESTED` against the live chain.
- **Model/bridge byte-identity to `jam-candidates/**`**: the sha256 values match the digests the
  project publishes, but I did not read the protected sibling tree, so the cross-repo identity is
  `UNTESTED` (only the digest claim is confirmed).
- **Monte-Carlo harness checks** (`docs/verification.txt` §3/§8.2 check 11/12/13: 9558/9563/9590 bps,
  700k key indices): produced by the shared coordinator-owned harness, not rerun here. `UNTESTED`.
- **`GENERATIONS = 14` sensitivity**: explicitly declared as chosen, not derived, by the docs;
  untested by design. `UNTESTED`.

---

## Attack 6 — clean-checkout repo readiness

**Method.** Copied the project to `/tmp/clean-01-lifeboat` excluding `dist/`, `node_modules/`,
`.git/`, then ran the three npm scripts **with no install step**. Verbatim output is appended to
`docs/verification.txt` (Wave 4 section) and reproduced in full there.

**Result.** `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` are all
`null`. With no install:

```
built dist/ — 9 files ... dist total : 73,013 B raw / 27,390 B gzip
npm test  -> model tests 14 passed ; contract tests 20 passed
npm run check -> 10/10 JS files parse
```

The freshly built `dist/` is byte-identical to the shipped `dist/` (`diff -r` clean). **NOT
FALSIFIED** — the repo builds, tests and checks from a clean checkout with zero dependencies.
(One honest note: `npm run serve` and the browser harness were **not** run here to avoid racing the
coordinator's shared server on port 8901; the static-tree reasoning and the live public-host probe
cover what serve would show.)

---

## Attack 7 — secret scan over every file

**Method.** Walked every file in the project **and** the clean-checkout tree (92 file paths
including the duplicate copy on both trees), scanned every 64-hex token and the usual secret
patterns (PEM private keys, `private key`/`mnemonic`/`seed phrase`, `sk-…`, `ghp_…`,
`github_pat_…`, `AKIA…`, `AIza…`, `xox…-…`, JWT, `password=`/`secret=`, `api_key`).

**Raw result:**

```
files scanned: 92
suspicious patterns: NONE
64-hex tokens found: all 0x-prefixed 32-byte values, all classified:
  tx hashes        : 0xd238c250…(deploy), 0x7ea1def1…,0xcd565594…,0xc4ab45d8… (VRF fulfilments),
                     0xc69bc61f…,0xe2b121a4…,0x2a2bc4ab… (settle txs)
  VRF request ids  : 0xec409d41…,0xef52d5b6…,0x81117bea…
  VRF randomness   : 0x0db124f0…,0x6d5f1ddb…,0x4e29888f… (public VRF outputs)
  test vectors     : 0x9fff7a99…(top-band word), 0x000000fb…/0x00000003…/0x00000005…(demo words)
  sha256 digests   : c7a1ffe1…(model.mjs), 46263af1…(guest.mjs)
40-hex addresses (public): 5 real addresses + the same 64-hex values truncated by the regex
```

No private key, no seed phrase, no API key, no bearer token, no credential of any kind. Every
64-hex value is a public tx hash, a public VRF value, a published test vector, or a sha256 digest.
**NOT FALSIFIED.**

---

## Corrections made to this project (all inside `README.md` / `docs/`)

1. `docs/rtp-proof.md` — rule-0 histogram rows for survivors `0/1/2` corrected
   (`250326→250156`, `162380→162680`, `12000→11080`) with their percentages, so the printed table
   now sums to the `2^20` total it claims. RTP unchanged (those states pay 0).
2. `README.md`, `docs/rtp.md`, `docs/rtp-proof.md` — "house edge ≈ 4.0%" → "≈ 4.26%"
   (exact `4.257965%`).

## Findings reported but not fixed (outside this task's edit grant)

- `game/README.md` — the `rule 0` / `rule 1` columns of the per-rule survivor-band table are
  swapped (proven above). Not editable here (only root `README.md` and `docs/**` are).
  **RESOLVED (coordinator, 2026-09-27):** corrected from the coordinator's own 2^20 enumeration to
  `0–5 52.6/53.7/54.4% · 6–7 20.3/14.2/5.3% · 8–12 25.9/31.1/39.7% · 13–20 1.2/1.0/0.6%`, and the
  house edge in the same file `≈4.0%` → `≈4.26%`.
- `README.md` / `docs/rtp.md` — the `solc 0.8.36` attribution is unverifiable in this environment
  (only `0.8.34` is present); the 2859-byte artifact size *is* reproduced. Left as-is pending a
  definitive compiler record.

## Coordinator correction (2026-09-27) — `makeRng` comment wording

The model's `makeRng` doc comment (and `docs/vrf.md` / `docs/rtp-proof.md`) claimed the seeder was
collision-free "up to 2^52 (and beyond)". That is **not proven** (no collision was found in any
swept window, including the 2^32 boundaries, but no proof is offered). The wording was corrected to
the provable statement — exact for every integer round, a bijection of the round index within each
2^32-round window — comment-only, identically in `game/model.mjs` and
`jam-candidates/lifeboat/model.mjs` (byte-identity preserved; no code line changed; no verified RTP
affected). `docs/verification.txt` §1 carries the new sha256.

## Overall

Across seven attacks, two proven doc inaccuracies were corrected, one additional doc error was
proven and reported (out of scope), and the core money-path claims — exact RTP, model↔contract
parity, the payout cap, shipped-surface hygiene, and clean-checkout readiness — survived genuine
attempts to falsify them. Nothing in the money path (model, contract, paytable, cap, framing) was
falsified.
