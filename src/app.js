/**
 * LIFEBOAT — frontend app.
 *
 * Extracted verbatim from the inline `<script type="module">` of the verified
 * jam-candidates/lifeboat/index.html. The ONLY change is the model import path:
 * `./model.mjs` -> `../game/model.mjs` (the project layout moved the model under game/).
 * The bridge import `./sdk/guest.mjs` is unchanged (this file lives in src/, beside src/sdk/).
 *
 * Behaviour is intentionally identical to the verified page: the demo deals from
 * crypto.getRandomValues, a host (if present) drives openSession/settlement, and every
 * reveal ends in the ONE render path. The maths lives in game/model.mjs and imports below.
 */
import {
  BANDS, CELLS, COLS, DEFAULT_RULE, EXPECTED_RTP_BPS, GENERATIONS, ROWS, RULES, RULE_RTP_BPS,
  bandOf, census, evolution, outcome, outcomeWithRule, wordTo20,
} from '../game/model.mjs';
import { computeMaxWager, connectGameToHost, observeGameContentSize } from './sdk/guest.mjs';
import { isSettledRow, keyOf, pickSettledRow } from './selection.mjs';

const el = id => document.getElementById(id);
const berths = [];
{
  const deck = el('deck');
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement('div');
    row.className = 'drow';
    for (let c = 0; c < COLS; c++) {
      const b = document.createElement('div');
      b.className = 'berth';
      const i = r * COLS + c;
      b.dataset.cell = String(i);
      b.title = `berth ${i}`;
      row.appendChild(b);
      berths.push(b);
    }
    deck.appendChild(row);
  }
}

let board = 0;
let lockedRule = DEFAULT_RULE;
let chosenRule = DEFAULT_RULE;
let stat = 0;
let payout = 0n;
let busy = false;
let timers = [];
let hostApi = null;
let snapshot = null;
let currentSessionId = null;
const renderedKeys = new Set(); // session keys already revealed; see selection.mjs (a SET, not one key)
let pendingKey = null; // sessionKey this page opened; the reveal must show THIS round, not history
let isDemoRound = true; // a reveal with no stake. Drives the "this demo pays nothing" wording.

// ------------------------------------------------------------------ wager helpers
// The host works in token base units; the field is human input. Mirrors the bundled
// examples: parseUnits(input, snapshot.token.decimals) for openSession, computeMaxWager
// for the ceiling (the paytable's highest band, 16x, is the worst-case reserved profit).
const MAX_MULT = Math.max(...BANDS.map(b => b.mult));
const tokenDecimals = () => {
  const d = snapshot && snapshot.token && snapshot.token.decimals;
  return Number.isInteger(d) && d >= 0 && d <= 36 ? d : 18;
};
const tokenSymbol = () => (snapshot && snapshot.token && snapshot.token.symbol) || 'CHIPS';

/** "12.5" -> base units at `decimals`, or null when the input is not a plain decimal. */
function parseAmount(raw, decimals) {
  const s = String(raw).trim();
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  try { return BigInt(whole + (frac + '0'.repeat(decimals)).slice(0, decimals)); } catch (err) { return null; }
}
/** base units -> "12.5", trimming trailing zeros. */
function formatAmount(base, decimals) {
  const d = 10n ** BigInt(decimals);
  const whole = base / d;
  const frac = base % d;
  if (frac === 0n) return whole.toString();
  return whole.toString() + '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
}
const minWagerBase = () => {
  const raw = snapshot && snapshot.casino && snapshot.casino.minBetAmount;
  try { return raw != null ? BigInt(raw) : null; } catch (err) { return null; }
};
const maxWagerBase = () => {
  const lim = computeMaxWager(snapshot, { maxMultiplierX: MAX_MULT });
  return lim.kind === 'limit' && typeof lim.maxWager === 'bigint' ? lim.maxWager : null;
};

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function drawDeck(final) {
  for (let i = 0; i < CELLS; i++) {
    berths[i].classList.toggle('live', ((board >> i) & 1) === 1);
    berths[i].classList.toggle('final', Boolean(final));
  }
}

function markPaytable(pop) {
  const rows = el('pay').querySelectorAll('tbody tr');
  let r = 0;
  for (const b of BANDS) {
    rows[r].classList.toggle('on', pop >= b.min && pop <= b.max);
    r++;
  }
}

// ---------------------------------------------------------------- render path
// The ONE reveal path. Demo, embedded settlement and any replay all end here.
// The chips are built ONCE and then re-styled; rebuilding them on every selection used to
// destroy keyboard focus. They are a real radio group: role=radio, tabbable, activated by
// Enter/Space and by the arrow keys, with aria-checked kept in sync.
function renderRuleChips() {
  const wrap = el('rules');
  if (!wrap.children.length) buildRuleChips();
  updateRuleChips();
}

function buildRuleChips() {
  const wrap = el('rules');
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'rule to lock for the next round');
  wrap.textContent = '';
  for (const r of RULES) {
    const d = document.createElement('div');
    d.className = 'rule';
    d.dataset.rule = String(r.id);
    d.setAttribute('role', 'radio');
    d.tabIndex = 0;
    const rtp = `Exact RTP ${(RULE_RTP_BPS[r.id] / 100).toFixed(2)}%`;
    d.innerHTML = `<span><span class="lab">${r.label}</span> &mdash; <span class="note">${r.note}</span></span><span>${rtp}</span>`;
    d.addEventListener('click', () => selectRule(r.id));
    d.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        selectRule(r.id);
      } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        const next = (r.id + 1) % RULES.length;
        focusRule(next); selectRule(next);
      } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const prev = (r.id + RULES.length - 1) % RULES.length;
        focusRule(prev); selectRule(prev);
      }
    });
    wrap.appendChild(d);
  }
}

function focusRule(id) {
  const d = el('rules').querySelector(`.rule[data-rule="${id}"]`);
  if (d) d.focus();
}

function selectRule(id) {
  if (busy) return;
  chosenRule = id;
  updateRuleChips();
  el('notice').textContent = 'Rule ' + RULES[id].label + ' will be locked when the round starts.';
}

function updateRuleChips() {
  for (const d of el('rules').children) {
    const on = Number(d.dataset.rule) === chosenRule;
    d.classList.toggle('on', on);
    d.setAttribute('aria-checked', String(on));
    if (busy) d.setAttribute('aria-disabled', 'true');
    else d.removeAttribute('aria-disabled');
  }
}

function paintHeadline() {
  const headline = el('headline');
  const mult = bandOf(stat);
  if (busy) {
    headline.className = 'headline';
    headline.textContent = `Evolving under ${lockedRuleLabel()} \u2014 the census lands on frame ${GENERATIONS}.`;
    return;
  }
  if (stat >= 8) {
    headline.className = 'headline win';
    // A demo round stakes nothing, so the headline must NOT say "Paid" while the Result cell
    // reads 0. It names the band and states the demo pays nothing; a hosted round shows the
    // real returned amount, matching the Result cell.
    headline.textContent = isDemoRound
      ? `Census: ${stat} live berths under ${lockedRuleLabel()}. A real ${mult}x wager would pay; this demo pays nothing.`
      : `Census: ${stat} live berths under ${lockedRuleLabel()}. Paid ${mult}x \u2014 ${formatAmount(payout, tokenDecimals())} ${tokenSymbol()}.`;
  } else {
    headline.className = 'headline lose';
    headline.textContent = isDemoRound
      ? `Census: ${stat} live berths under ${lockedRuleLabel()}. The colony is lost \u2014 this demo pays nothing.`
      : `Census: ${stat} live berths under ${lockedRuleLabel()}. The colony is lost.`;
  }
}
const lockedRuleLabel = () => (RULES[lockedRule] || RULES[0]).label;

function paint(final) {
  drawDeck(final);
  el('k-pop').textContent = String(stat);
  const mult = bandOf(stat);
  el('k-mult').textContent = mult > 0 ? mult + 'x' : '\u2014';
  el('k-rule').textContent = lockedRuleLabel();
  el('k-pay').textContent = payout > 0n ? formatAmount(payout, tokenDecimals()) : '0';
  el('k-pay-note').textContent = isDemoRound ? 'demo \u2014 no money is paid' : tokenSymbol();
  el('result-title').textContent = isDemoRound ? 'Result (demo)' : 'Result';
  markPaytable(stat);
  paintHeadline();
  renderRuleChips();
}

{
  const tb = el('pay').querySelector('tbody');
  for (const b of BANDS) {
    const tr = document.createElement('tr');
    const label = b.max >= CELLS ? `${b.min}+` : (b.min === b.max ? String(b.min) : `${b.min}\u2013${b.max}`);
    tr.innerHTML = `<td>${label}</td><td>${b.mult > 0 ? b.mult + 'x' : '\u2014'}</td>`;
    tb.appendChild(tr);
  }
}

// ---------------------------------------------------------------- reveal
function reveal(word, ruleId, amount, sessionId) {
  clearTimers();
  currentSessionId = sessionId ?? null;
  lockedRule = ruleId;
  busy = true;
  const start = wordTo20(word);
  board = start;
  stat = 0;
  payout = 0n;
  el('k-gen').textContent = '0';
  paint(false);

  const frames = evolution(start, ruleId);
  let g = 1;
  const tick = () => {
    board = frames[g];
    stat = 0;
    for (let i = 0; i < CELLS; i++) stat += (board >> i) & 1;
    el('k-gen').textContent = String(g);
    drawDeck(g === frames.length - 1);
    if (g >= frames.length - 1) {
      busy = false;
      stat = census(start, ruleId);
      payout = amount;
      paint(true);
      if (hostApi && currentSessionId !== null) {
        void hostApi.revealOutcome({ sessionId: String(currentSessionId) }).catch(() => {});
      }
      return;
    }
    g++;
    timers.push(setTimeout(tick, 88));
  };
  timers.push(setTimeout(tick, 110));
}

// ---------------------------------------------------------------- demo / embed
function freshWord() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function onDemo() {
  if (busy) return;
  const word = freshWord();
  const statUnderDefault = outcome(word).stat;
  const under = chosenRule === DEFAULT_RULE
    ? { stat: statUnderDefault, ruleId: DEFAULT_RULE }
    : outcomeWithRule(word, chosenRule);
  isDemoRound = true;
  el('notice').textContent =
    `Demo round \u2014 no wallet, no money. Rule ${RULES[chosenRule].label} locked before the word. ` +
    `Word ${word.slice(0, 18)}\u2026`;
  reveal(word, under.ruleId, 0n, null);
}

// ---------------------------------------------------------------- bridge
/**
 * BET inside the Chain.wtf host. The entered wager IS the bet: it is parsed from the field
 * with the host token's decimals and validated against the host's own limits before any
 * session is opened, then handed to `openSession({ wager })` in BASE UNITS — the shape the
 * bundled SDK examples use and the shape `02-handicap`/`03-flood-exe` use. Previously the
 * field was decorative: this handler sent `casino.minBetAmount` and never read the input.
 */
async function onBet() {
  if (!hostApi || !snapshot || busy) return;
  const decimals = tokenDecimals();
  const sym = tokenSymbol();
  const raw = String(el('wager').value || '').trim();
  const amount = parseAmount(raw, decimals);
  if (amount === null) {
    el('notice').textContent = `Enter a wager as a number of ${sym} (for example 10).`;
    return;
  }
  if (amount <= 0n) {
    el('notice').textContent = `Enter a wager greater than zero ${sym}.`;
    return;
  }
  const min = minWagerBase();
  if (min !== null && amount < min) {
    el('notice').textContent = `Wager is below the host minimum of ${formatAmount(min, decimals)} ${sym}.`;
    return;
  }
  const max = maxWagerBase();
  if (max !== null && amount > max) {
    el('notice').textContent = `Wager is over the host limit right now (max ${formatAmount(max, decimals)} ${sym}).`;
    return;
  }
  busy = true;
  el('notice').textContent = 'Asking the host for a session\u2026';
  try {
    // The rule travels in gameData and is committed on-chain at onSessionStart,
    // i.e. before the randomness for this session exists.
    const gameData = '0x' + chosenRule.toString(16).padStart(2, '0');
    const { sessionKey } = await hostApi.openSession({ wager: amount.toString(), gameData });
    pendingKey = String(sessionKey);
    el('notice').textContent =
      `Session ${String(sessionKey).slice(0, 20)}\u2026 opened with ${RULES[chosenRule].label} locked, ` +
      `staking ${formatAmount(amount, decimals)} ${sym}.`;
    currentSessionId = null;
  } catch (err) {
    el('notice').textContent = 'The host refused the wager: ' + String(err && err.message).slice(0, 160);
  } finally {
    busy = false;
    updateRuleChips();
  }
}

function pollSnapshot() {
  const items = snapshot && snapshot.sessions && Array.isArray(snapshot.sessions.items)
    ? snapshot.sessions.items : [];
  // Pick ONE settled row to render (see selection.mjs). `busy` is passed so a reveal in flight is
  // never interrupted; the set of already-shown keys means a backlog of newly settled rounds is then
  // drained oldest-first, one per snapshot — each round exactly once, until the drain rests.
  const picked = pickSettledRow(items, pendingKey, renderedKeys, busy);
  if (!picked) return;
  const { row, key, parsed } = picked;
  renderedKeys.add(key);
  // Bound the set: forget keys that have left the feed window (a row no longer in the feed can never
  // be revealed again), so a long session cannot grow the set without limit.
  if (renderedKeys.size > 64) {
    const live = new Set();
    for (const r of items) if (isSettledRow(r)) live.add(keyOf(r));
    for (const k of renderedKeys) if (!live.has(k)) renderedKeys.delete(k);
  }
  if (pendingKey !== null && key === pendingKey) pendingKey = null;
  currentSessionId = row.sessionId ?? null;
  // Replay the contract's board through the model's own automaton so the page shows
  // exactly the frames the contract counted, then land on the contract's census.
  const start = parsed.board;
  clearTimers();
  lockedRule = parsed.rule;
  isDemoRound = false; // this replay is a real on-chain session, not the free demo
  busy = true;
  board = start;
  stat = 0;
  el('k-gen').textContent = '0';
  paint(false);
  const frames = evolution(start, parsed.rule);
  let g = 1;
  const tick = () => {
    board = frames[g];
    stat = 0;
    for (let i = 0; i < CELLS; i++) stat += (board >> i) & 1;
    el('k-gen').textContent = String(g);
    drawDeck(g === frames.length - 1);
    if (g >= frames.length - 1) {
      busy = false;
      stat = parsed.pop;
      payout = parsed.payout;
      paint(true);
      if (hostApi && currentSessionId !== null) {
        void hostApi.revealOutcome({ sessionId: String(currentSessionId) }).catch(() => {});
      }
      el('notice').textContent = 'Round settled on-chain.';
      return;
    }
    g++;
    timers.push(setTimeout(tick, 88));
  };
  timers.push(setTimeout(tick, 60));
}

function setSnapshot(next) {
  snapshot = next;
  const walletReady = snapshot && snapshot.wallet && snapshot.wallet.status === 'ready';
  el('bet').disabled = !(hostApi && walletReady);
  setHostUI();
  pollSnapshot();
}

/**
 * Embed path.
 *
 * MEASURED BEHAVIOUR, not an assumption: with no host on the other side penpal's
 * `connection.promise` NEVER settles — it does not reject. An `await` there leaves the
 * page dead with an unlit deck (caught in the browser during the build). So the connection
 * is not awaited: its .then/.catch only upgrade the page once a host really answers, and a
 * short grace timer lights a standalone round if none has.
 */
let connection = null;
let hostAnswered = false;
let bootTimer = 0;

// ---------------------------------------------------------------- UI mode
// The wager field is a real bet only inside the host. Standalone it is disabled and labelled,
// so no one can mistake the free demo for a wager. The disabled BET says WHY it is inert via
// its `title`/`aria-describedby` (index.html) rather than only via the notice.
function setStandaloneUI() {
  el('wager').disabled = true;
  el('wager').title = 'Demo mode \u2014 no money is wagered on this standalone page.';
  el('wager-note').textContent = 'demo \u2014 no money; the wager field is unused here.';
}
function setHostUI() {
  el('wager').disabled = false;
  el('wager').title = 'Amount to wager, in the host token.';
  el('wager-note').textContent = `Wager in ${tokenSymbol()}; validated against the host limits.`;
}

/** The first-run state: an unplayed deck and the instruction intact, before any auto-round. */
function renderIdle() {
  isDemoRound = true;
  el('k-gen').textContent = '0';
  el('k-pop').textContent = '\u2014';
  el('k-mult').textContent = '\u2014';
  el('k-rule').textContent = '\u2014';
  el('k-pay').textContent = '\u2014';
  el('k-pay-note').textContent = '';
  el('result-title').textContent = 'Result';
  el('headline').className = 'headline';
  el('headline').textContent = 'Pick a rule, then press DEMO. Nothing is wagered here.';
  drawDeck(false);
  markPaytable(-1);
}

function enterStandalone(message) {
  hostAnswered = true;
  clearTimeout(bootTimer);
  setStandaloneUI();
  renderIdle();
  el('notice').textContent = message;
}

// The boot grace timer. It no longer DEALS a round (that auto-play overwrote the first-run
// instruction ~0.4 s after load, before it could be read); it only settles the page into the
// idle standalone state once it is clear no host is answering.
function startStandalone() {
  if (hostAnswered || hostApi) return;
  enterStandalone('No host answered \u2014 standalone demo. Pick a rule, then press DEMO.');
}

function boot() {
  renderRuleChips();
  renderIdle();
  setStandaloneUI();
  // Both controls must be wired. They previously were NOT: `onDemo` and `onBet` were defined and
  // never bound, so the page could only ever auto-play the single boot round and a hosted wager was
  // impossible. Found by driving the page in a real browser, not by reading it.
  el('demo').addEventListener('click', onDemo);
  el('bet').addEventListener('click', onBet);
  // Keep the field numeric as it is typed (host mode only; standalone it is disabled anyway).
  el('wager').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^0-9.]/g, ''); });
  try {
    connection = connectGameToHost({ setState: setSnapshot });
    void connection.promise
      .then(api => {
        hostAnswered = true;
        clearTimeout(bootTimer);
        hostApi = api;
        observeGameContentSize(hostApi);
        setSnapshot(snapshot);
        el('notice').textContent = 'Connected to the Chain.wtf host. Pick a rule, set a wager, then BET.';
      })
      .catch(() => {
        enterStandalone('No host answered \u2014 standalone demo. Pick a rule, then press DEMO.');
      });
  } catch (err) {
    enterStandalone('Bridge unavailable \u2014 standalone demo. Pick a rule, then press DEMO.');
  }
  bootTimer = setTimeout(startStandalone, 400);
  window.addEventListener('beforeunload', () => {
    try { if (connection) connection.destroy(); } catch (err) { /* host may be gone */ }
  });
}

boot();

window.__lifeboat = { outcome, outcomeWithRule, census, bandOf };
