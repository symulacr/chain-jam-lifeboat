# lifeboat — testnet / real-chain status

**Status: `EXTERNAL BLOCKED` for the production chain. The local simulator is the only
entrant-accessible environment.**

## The finding

`research/wave-final-real-chain-plan.md` establishes, with citations, that **no public testnet path
exists for an entrant.** A Base Sepolia router address does appear in a simulator test file
(`simulator/src/randomness-verification.test.ts:30-31`, chain id 84532), but:

- it is **not** the SDK's vendored router build;
- it exposes no `requestRandomness` / `fulfillRandomness`;
- no public `CasinoGameFacet` diamond exists on any chain.

The SDK documentation is explicit:

- `GETTING_STARTED.md:4` — *"No Chain.wtf account, backend access, or testnet funds are needed"*;
- `GETTING_STARTED.md:178-179` — the whitelist, indexer and catalog are *"wired by the Chain.wtf
  maintainers"*.

So the local simulator on **chain id 31337** is the only entrant-accessible environment, and the
jam's own gate is *"Runs correctly in the local simulator"*.

## What that means for LIFEBOAT

- There is **no public testnet deployment for an entrant to use**, so LIFEBOAT is **not** deployed to
  any public chain. This is `EXTERNAL BLOCKED`, not skipped and not faked.
- The strongest permitted substitute is the **local simulator** (chain id 31337) with the real
  vendored VRF router and real ECVRF proofs — and LIFEBOAT **has now run on it for real**: deployed,
  wagered, VRF-fulfilled, settled and paid out. See `docs/chain-integration.md` ("Deployed and
  settled on the local simulator") and `docs/verification.txt` §8.4.
- LifeboatGame deployed at `0xa513e6e4b8f2a923d98304ec87f64353c4d5c853` (deploy tx
  `0xd238c250a415707933b30b9ce4922c63972a8bc0f2cd800e5de762bf2e07a6e1`, block 19, `gasUsed`
  566101); `sessionsSettled` 21, `uniqueVrfFulfilmentTxs` 21; 20 rounds settled with **0 stuck, 0
  parity failures**; the exact top payout (16x) was eth-called through `onRandomness` and matched the
  cap. Citations: `research/chain-evidence.json`, `docs/chain-proof.json`.

## Evidence chain

| claim | evidence |
|---|---|
| no public testnet path for an entrant | `research/wave-final-real-chain-plan.md`; `GETTING_STARTED.md:4`, `GETTING_STARTED.md:178-179` |
| the Base Sepolia address is not usable | `simulator/src/randomness-verification.test.ts:30-31` (address present, no `requestRandomness`/`fulfillRandomness`) |
| no public `CasinoGameFacet` diamond exists | `research/wave-final-real-chain-plan.md` |
| local simulator is chain id 31337 and is the only entrant path | jam gate: *"Runs correctly in the local simulator"* |

## Cell classification (per the final-candidates acceptance rule)

| cell | status |
|---|---|
| production-chain deployment | **EXTERNAL BLOCKED** (no public testnet path exists for an entrant) |
| real chain.wtf production host embed | **EXTERNAL BLOCKED** (the production host cannot be driven by an entrant) |
| local-simulator execution | **PASS** — deployed + settled on chain id 31337: 21 sessions settled, 20 rounds with 0 stuck / 0 parity failures, one real VRF fulfilment tx per session, max-payout eth-call within cap (`docs/chain-proof.json`, `research/chain-evidence.json`) |
| local in-host embed (SDK production-faithful harness) | **PASS** — guest mounted, wager placed through the bridge, chain session count 20 → 21, guest rendered the settle (`docs/verification.txt` §8) |
| public HTTPS hosting + standalone run | **PASS** — `https://chain-jam-lifeboat.vercel.app`, driven standalone in a real browser (`research/public-deploy-top3.md`) |
| everything else (RTP, model, build, browser run) | **PASS** with evidence in `docs/verification.txt` |

A cell is `EXTERNAL BLOCKED` only for the real production host and the production-chain deployment;
everything else is PASS with evidence or reported honestly as UNPROVEN. Nothing here is faked.
