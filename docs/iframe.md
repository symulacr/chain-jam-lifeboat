# lifeboat — iframe safety

Target runtime: `sandbox="allow-scripts allow-same-origin"`, per
`research/wave5-agent3-beyond-wine.md` §6.1. The page must run inside `*.chain.wtf`.

## The avoid-list, and what the page does instead

| capability | status in the sandbox | this page |
|---|---|---|
| service worker | unreliable in sandboxed frames | **not used** — nothing is cached locally |
| `localStorage` / `sessionStorage` / `IndexedDB` / Cache API | partitioned, can throw | **not used** — all state is module-scope and resets on mount |
| `document.cookie` | may be blocked | **not read or written** |
| `window.open`, `alert` / `confirm` / `prompt`, `top.location`, `target="_blank"` | blocked or suppressed | **none** — every result renders in-page in the result panel |
| downloads, clipboard, pointer lock, fullscreen, Web Share | blocked / needs activation | not used |
| `fetch` / `XMLHttpRequest` / `WebSocket` | allowed but unnecessary | **none in the page** |
| `vh` / `vw` units | not blocked but semantically wrong — the host grows the iframe to content height | **zero `vh`/`vw`**; the deck is fixed-pixel tiles |
| WebAudio | allowed, starts suspended | **no audio at all** |
| `X-Frame-Options` / CSP `frame-ancestors` | setting them forfeits the gallery preview | **no header, no meta, no `frame-ancestors`**; `public/_headers` and `public/vercel.json` explicitly omit them and set CORS only on `/game.manifest.json` |
| root-relative asset paths | 404 under a sub-path | **none** — `./src/styles.css`, `./src/app.js`, `./game/model.mjs`, `og-image.png` are all relative |
| third-party script | only the widget is permitted | **one**: the literal `<script async src="https://jam.chain.wtf/widget.js"></script>` |

## Content sizing

`observeGameContentSize(hostApi)` runs once the bridge resolves, driving `reportContentSize({ minHeight })`
through `ResizeObserver` + `requestAnimationFrame`. The desk is a fixed max-width column, so its
height follows content, not the viewport. `capabilities.resize: true` in the manifest declares it.

## Query parameters

The page never reads `location.search`, `location.hash` or `URLSearchParams`, so the gallery's
appended `?ref=chainjam` is inherently tolerated (the harness reports this in check 7).

## Host lifecycle (and the measured "no host" behaviour)

`connectGameToHost({ setState })` on boot; `setState` mirrors `snapshot.wallet.status` into the BET
button and scans `snapshot.sessions.items` for a settled `raw.gameState` to replay; betting is
enabled only once the host has answered AND the wallet is `ready`; `connection.destroy()` on
`beforeunload`.

**Measured, not assumed**: with no host, penpal's `connection.promise` neither resolves nor rejects.
An `await` there left the page with an unlit deck. The boot path therefore does not await it; a
400 ms grace timer (`setTimeout(startStandalone, 400)`) lights a standalone round if no host has
answered. The Wave-7 audit confirms this grace timer is present in the page
(`research/wave7-audit-novelty-licensing-security.md` §3.6).

## Rule chips while a round is running

The chips carry `aria-disabled="true"` and ignore clicks while `busy`, so the rule cannot be changed
mid-reveal even in the page. The authoritative lock is on chain (`docs/chain-integration.md`,
`docs/vrf.md`).

## Settlement watchdog

Unlike `flood-exe`/`ordered-runs`/`handicap` (which run a 90 s settlement watchdog), LIFEBOAT has no
watchdog. This is low risk because it does not hold a blocking `busy` across `openSession →
settlement`: `busy` is set only while replaying an already-settled row, so a missing settlement
leaves the demo usable rather than frozen
(`research/wave7-audit-novelty-licensing-security.md` §3.5, §3.9 S4). Recorded, not hidden.

## Hosting config (Vercel) — the `$comment` fix (Wave 3, 2026-09-27)

`public/vercel.json` originally carried a `$comment` key documenting the reasoning behind the
headers. Vercel validates `vercel.json` with `additionalProperties: false` and rejected it outright,
which made the production deploy **fail**:

    Error: Invalid vercel.json - should NOT have additional property `$comment`. Please remove it.

The `$comment` key was removed; `public/vercel.json` now contains `headers` only. The prose rationale
lives where it is actually read: `public/_headers` (Netlify/Cloudflare Pages) keeps the full comment,
and this file keeps the framing/CORS reasoning. The framing rules are unchanged — no
`X-Frame-Options`, no `frame-ancestors`, CORS on `/game.manifest.json` only. Verbatim:
`docs/verification.txt` §8.6; `research/public-deploy-top3.md`.
