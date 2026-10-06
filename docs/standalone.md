# lifeboat — standalone run

## How to run the built page

```sh
npm run build                 # assemble dist/ (no bundler, no dependency)
npm run serve                 # static server on http://127.0.0.1:8901/
# open http://127.0.0.1:8901/
```

`npm run serve` serves `dist/` and sends `.mjs` as `text/javascript`, which is required for the ES
module imports (`./src/app.js`, `../game/model.mjs`, `./sdk/guest.mjs`).

`file://` will not work: the page imports ES modules, and browsers refuse module imports over an
opaque `file://` origin. That is inherent to the framework-free/no-bundler shape, not a bug. It must
be served over `http(s)`.

## What the built page was observed to do (this build)

Served `dist/` on port 8901 and driven it in a real headless Chrome via the DevTools Protocol
(`tools/browser-verify.mjs`, adapted from `jam-candidates/tools/verify-standalone.mjs`). The harness
patches `crypto.getRandomValues` before dealing, so the exact words the page uses are known and the
rendered census can be compared against `game/model.mjs` for those words.

| observation | expected | observed |
|---|---|---|
| page + modules load | 200 on `/`, `/src/app.js`, `/game/model.mjs`, `/src/sdk/guest.mjs`, `/src/styles.css`, `/og-image.png` | see `docs/verification.txt` |
| UI renders | 20 `.berth` tiles, 4 rule chips, paytable rows | see `docs/verification.txt` |
| rule chip works | clicking a chip marks it and updates `#notice` | see `docs/verification.txt` |
| DEMO deals | a round runs from gen 0 to gen 14 | see `docs/verification.txt` |
| round resolves | `#headline` names the census and the result | see `docs/verification.txt` |
| result readable | census text + `.berth.live` count agree with `#k-pop` | see `docs/verification.txt` |
| clicking again deals a new round | a different word → a new census | see `docs/verification.txt` |
| page computes the verified model | rendered census == `game/model.mjs` for the known word | see `docs/verification.txt` |

The exact settled strings and counts are recorded verbatim in `docs/verification.txt`.

## Asset status codes (standalone static server)

`index.html` 200, `src/styles.css` 200, `src/app.js` 200, `game/model.mjs` 200,
`src/sdk/guest.mjs` 200, `og-image.png` 200, `game.manifest.json` 200.

## First attempt failed, and why it is recorded

The original build's first browser check found the page **dead**: the deck rendered dark, 0
generations, empty notice. Cause: the boot path did `await connection.promise`, and with no host
penpal's promise **never settles** — it does not reject. The page never reached the
"no host, run standalone" line. Fixed by not awaiting the connection and starting a standalone round
on a 400 ms grace timer. The split preserves that fix (see the comment above `boot()` in
`src/app.js`); the run recorded here is the post-fix behaviour.

## Public production URL (Wave 3, 2026-09-27)

The standalone build is served publicly at:

    https://chain-jam-lifeboat.vercel.app

External probe (from this machine, not localhost):

| request | response |
|---|---|
| `GET /` | `200 text/html; charset=utf-8` |
| `GET /game/model.mjs` | `200 application/javascript; charset=utf-8` |
| `GET /src/app.js` | `200 application/javascript; charset=utf-8` |
| `GET /game.manifest.json` | `200 application/json; charset=utf-8` |
| manifest headers | `access-control-allow-origin: *`, `cache-control: public, max-age=300` |
| `X-Frame-Options` / CSP `frame-ancestors` | absent — the page stays iframe-embeddable |
| widget tag in body | `jam.chain.wtf/widget.js` present |

Observed standalone browser run at that URL (real headless Chrome, no host attached):
page loads, **DEMO** lit, the round resolved to
`Census: 0 live berths under B25/S014. The colony is lost.`, and the widget badge
`CHAIN JAM VOL.1` rendered. No cold-load hang: the never-settling `connection.promise` guard falls
through to the standalone demo on the real network.

Source: `research/public-deploy-top3.md`; verbatim probe/browser output in `docs/verification.txt` §8.6.

## UNPROVEN

- No *independent second* browser pass over the public URL by this agent in Wave 3; the evidence is
  the coordinator's run recorded in `research/public-deploy-top3.md`.
- Production Chain.wtf host embed remains `EXTERNAL BLOCKED`. The local SDK production-faithful
  harness embed **PASSED** (guest mounted, wager placed through the bridge, chain session 20 → 21;
  see `docs/verification.txt` §8), but the production host is not entrant-drivable.
