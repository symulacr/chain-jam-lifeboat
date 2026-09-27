// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ICasinoGameV2, SessionContext, SessionPhase, StepResult} from "./ICasinoGameV2.sol";

/**
 * LIFEBOAT — a cellular-automaton census on a 20-berth toroidal deck.
 *
 * One wager, one VRF word, one census. The word lights 20 berths (one bit each). The
 * deck then runs a Life-like automaton for GENERATIONS generations and the payout is a
 * banded function of the LIVE POPULATION of the final frame.
 *
 *   survivors  0- 5  ->   0x     (the colony is lost)
 *   survivors  6- 7  -> 1.2x
 *   survivors  8-12  ->   2x
 *   survivors 13-20  ->  16x
 *
 *   Hit rate 46.3-47.4% depending on the rule, house edge ~4.0%, top 16x at 1-in-82
 *   to 1-in-156 depending on the rule.
 *
 * THE DECISION AXIS. The player locks one of three LIFE RULES before the wager. The same
 * board evolves differently under each, so the choice is real. It is locked at
 * onSessionStart (the rule is written into newGameState, which the casino persists and
 * hands back to onRandomness), i.e. BEFORE the randomness is drawn and settled. All
 * three rules pay the same expected return within 21 bps on purpose (tools/tune.mjs), so
 * this is a choice about the SHAPE of the census, not a hidden best-paying button.
 *
 * PURE FUNCTION OF (word, locked rule). The contract replays the SAME torus and the SAME
 * neighbour counting as model.mjs (step/census), so any word can be replayed by hand in
 * JS and on-chain and give the identical census. See rtp-proof.md.
 *
 * RTP 9574.2035 bps EXACT under the default rule — the board space is exactly 2^20 and
 * was enumerated in full for every rule. Not a simulation.
 */
contract LifeboatGame is ICasinoGameV2 {
  uint256 private constant ROWS = 4;
  uint256 private constant COLS = 5;
  uint256 private constant CELLS = ROWS * COLS; // 20
  uint256 private constant GENERATIONS = 14;
  uint256 private constant MAX_MULT_BPS = 160000; // 16x
  uint256 private constant RULES = 3;
  /// @dev Declared RTP: the EXACT figure for rule 0, which is the lowest of the three,
  ///      so the declaration is the floor across every choice the player can make.
  ///      rule 0 B25/S014 = 9574.2035, rule 1 B25/S23 = 9575.7103, rule 2 B24/S23 = 9594.7456.
  uint256 private constant EXPECTED_RTP_BPS = 9574;

  error LifeboatGame__BadRule();
  error LifeboatGame__NoPlayerAction();

  // ------------------------------------------------------------------ rules
  /// @dev B/S masks over neighbour counts 0..8 (bit n set = that count triggers).
  ///      Bit-verified against the notation in tools/tune.mjs / verify-rules.
  function _masks(uint256 rule) private pure returns (uint256 birth, uint256 survive) {
    if (rule == 0) return (0x24, 0x13); // B25/S014
    if (rule == 1) return (0x24, 0x0c); // B25/S23
    if (rule == 2) return (0x14, 0x0c); // B24/S23
    revert LifeboatGame__BadRule();
  }

  /// @dev Reads the rule from the ONE-BYTE hint carried in `gameData` (the openSession
  ///      hint). `gameData` is a single raw byte, so byte 0 IS the rule.
  function _ruleFrom(bytes memory gameData) private pure returns (uint256) {
    if (gameData.length == 0) return 0;
    uint256 r = uint256(uint8(gameData[0]));
    if (r >= RULES) revert LifeboatGame__BadRule();
    return r;
  }

  /// @dev The rule the player COMMITTED, read back from the gameState written at
  ///      onSessionStart. onSessionStart stores `abi.encode(uint256(rule))` — a full 32-byte
  ///      big-endian word whose byte 0 is always 0x00 — so it MUST be read with abi.decode,
  ///      not `gameData[0]`. (Reading it as `uint8(gameState[0])` returned 0 for every rule,
  ///      silently discarding the player's choice: the F1 defect. `gameData` remains the
  ///      fallback for a context that has not passed through onSessionStart, exactly like
  ///      HandicapGame._committedPick, so behaviour cannot regress.)
  function _committedRule(SessionContext calldata ctx) private pure returns (uint256) {
    bytes calldata gs = ctx.gameState;
    if (gs.length == 32) {
      uint256 r = abi.decode(gs, (uint256));
      if (r < RULES) return r;
    }
    return _ruleFrom(ctx.gameData);
  }

  // ------------------------------------------------------------------ automaton
  /// @dev One generation. Row-major torus; row r is bits [r*5, r*5+5). Moore
  ///      neighbourhood with horizontal wrap inside the row and vertical wrap over the
  ///      four rows. Identical to step() in model.mjs.
  function _step(uint256 board, uint256 birth, uint256 survive) private pure returns (uint256 out) {
    for (uint256 r = 0; r < ROWS; r++) {
      uint256 me = (board >> (r * 5)) & 0x1f;
      uint256 north = (board >> (((r + ROWS - 1) % ROWS) * 5)) & 0x1f;
      uint256 south = (board >> (((r + 1) % ROWS) * 5)) & 0x1f;
      uint256 next;
      for (uint256 c = 0; c < COLS; c++) {
        uint256 left = (c + COLS - 1) % COLS;
        uint256 right = (c + 1) % COLS;
        uint256 n =
          ((me >> left) & 1) + ((me >> right) & 1) +
          ((north >> left) & 1) + ((north >> c) & 1) + ((north >> right) & 1) +
          ((south >> left) & 1) + ((south >> c) & 1) + ((south >> right) & 1);
        bool alive = ((me >> c) & 1) == 1;
        if (alive ? ((survive >> n) & 1) == 1 : ((birth >> n) & 1) == 1) {
          next |= uint256(1) << c;
        }
      }
      out |= next << (r * 5);
    }
  }

  function _population(uint256 board) private pure returns (uint256 k) {
    for (uint256 i = 0; i < CELLS; i++) k += (board >> i) & 1;
  }

  /// @dev Run GENERATIONS generations and count the survivors.
  function _census(uint256 board, uint256 rule) private pure returns (uint256) {
    (uint256 birth, uint256 survive) = _masks(rule);
    for (uint256 g = 0; g < GENERATIONS; g++) board = _step(board, birth, survive);
    return _population(board);
  }

  /// @dev Word -> 20 bits: XOR of the four big-endian u32 lanes, low 20 bits.
  ///      Identical to wordTo20() in model.mjs. The 20 bits ARE the initial deck.
  function _fold20(bytes32 randomness) private pure returns (uint256) {
    uint256 u0 = uint32(bytes4(randomness));
    uint256 u1 = uint32(bytes4(randomness << 32));
    uint256 u2 = uint32(bytes4(randomness << 64));
    uint256 u3 = uint32(bytes4(randomness << 96));
    return (u0 ^ u1 ^ u2 ^ u3) & 0xfffff;
  }

  // ------------------------------------------------------------------ paytable
  /// @dev THE single source of truth for the return multiple, in bps. Mirrors BANDS.
  function _multBps(uint256 survivors) internal pure returns (uint256) {
    if (survivors >= 13) return 160000; // 16x
    if (survivors >= 8) return 20000; // 2x
    if (survivors >= 6) return 12000; // 1.2x
    return 0; // 5 or fewer
  }

  function _payout(uint256 wager, uint256 survivors) internal pure returns (uint256) {
    return (wager * _multBps(survivors)) / 10000;
  }

  // ------------------------------------------------------------------ interface
  function quoteCaps(
    uint256 wager,
    bytes calldata
  ) external pure returns (uint256 maxEscrowStake, uint256 maxReservedProfit) {
    maxEscrowStake = wager;
    maxReservedProfit = (wager * MAX_MULT_BPS) / 10000 - wager;
  }

  /// @dev Quoted for the rule named in gameData, from exact enumerations (2^20 boards
  ///      per rule). The three rules differ materially in top-tier probability
  ///      (0.64% / 1.04% / 1.22%), so quoting rule 0 for a rule-2 bet would understate
  ///      the tail. See rtp-proof.md.
  function quoteRiskParams(
    uint256 wager,
    bytes calldata gameData
  )
    external
    pure
    returns (uint256 maxPayout, uint256 probabilityWad, uint256 expectedPayout, uint256 bodyVarianceScaled)
  {
    uint256 rule = _ruleFrom(gameData);
    maxPayout = (wager * MAX_MULT_BPS) / 10000;
    if (rule == 0) {
      probabilityWad = 12245178222656250; // 12840 / 2^20
      expectedPayout = (wager * 9574) / 10000;
      bodyVarianceScaled = wager * wager * 1327996826171875000;
    } else if (rule == 1) {
      probabilityWad = 10375976562500000; // 10880 / 2^20
      expectedPayout = (wager * 9576) / 10000;
      bodyVarianceScaled = wager * wager * 1447100067138671875;
    } else {
      probabilityWad = 6427764892578125; // 6740 / 2^20
      expectedPayout = (wager * 9595) / 10000;
      bodyVarianceScaled = wager * wager * 1662549591064453125;
    }
  }

  function onSessionStart(SessionContext calldata ctx) external pure returns (StepResult memory r) {
    uint256 wager = ctx.escrowedStake;
    uint256 rule = _ruleFrom(ctx.gameData);
    // The locked rule is committed to gameState HERE, before the word exists. The
    // settling step reads it back from ctx.gameState, not from gameData.
    r.newGameState = abi.encode(rule);
    r.escrowDelta = 0;
    r.reservedProfitDelta = int256((wager * MAX_MULT_BPS) / 10000 - wager);
    r.nextPhase = SessionPhase.WAITING_RANDOMNESS;
    r.requestRandomnessNow = true;
    r.payout = 0;
  }

  function onPlayerAction(SessionContext calldata, bytes calldata) external pure returns (StepResult memory) {
    revert LifeboatGame__NoPlayerAction();
  }

  function onRandomness(SessionContext calldata ctx, bytes32 randomness) external pure returns (StepResult memory r) {
    uint256 rule = _committedRule(ctx);
    uint256 board = _fold20(randomness);
    uint256 survivors = _census(board, rule);
    uint256 payout = _payout(ctx.wagerBase, survivors);

    // Everything the frontend needs to redraw the exact deck the contract evolved.
    r.newGameState = abi.encode(rule, board, survivors, payout);
    r.escrowDelta = 0;
    r.reservedProfitDelta = 0; // never release the reserve on the settling step
    r.nextPhase = SessionPhase.SETTLED;
    r.requestRandomnessNow = false;
    r.payout = payout;
  }

  function quoteForfeitPayout(SessionContext calldata) external pure returns (uint256) {
    return 0; // instant game: nothing is cashable mid-round
  }
}
