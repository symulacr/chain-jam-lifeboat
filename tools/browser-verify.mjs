#!/usr/bin/env node
/**
 * Standalone acceptance check for LIFEBOAT's built dist/.
 *
 *   npm run build && npm run serve      # in one shell
 *   BASE_URL=http://127.0.0.1:8901/ node tools/browser-verify.mjs
 *
 * Adapted from jam-candidates/tools/verify-standalone.mjs (which drives the DevTools Protocol
 * directly, because `chrome --dump-dom` hangs on these timer-driven pages). It uses the real
 * headless Chrome at /home/eya/.agent-browser/browsers/chrome-154.0.8037.57/chrome and CDP port
 * 9412 (a free port), with its own profile, so it disturbs no other session.
 *
 * WHAT IT PROVES (Wave-1 findings → Wave-3 fixes)
 *   1. the page and its modules load; the UI renders (20 berths, 3 rule chips, the 4-row paytable)
 *   2. the FIRST state is the instruction, NOT an auto-played round (L6)
 *   3. the disabled BET is visually unmistakable and explains itself (L1)
 *   4. the rule chips are a keyboard radio group: Tab reaches them, Enter selects (L3)
 *   5. DEMO deals a round under the chosen rule and it RESOLVES, matching game/model.mjs
 *   6. a demo win says the demo pays nothing next to the 0 payout — no "Paid 2x" contradiction (L5)
 *   7. at every phone/desktop viewport, a control centre is NEVER the Chain Jam badge (D6),
 *      and no horizontal overflow remains (L4)
 *   8. clicking DEMO again deals a NEW round; no `undefined`/`NaN` in the settled text
 *
 * Exit 0 = every assertion held.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as model from '../game/model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, 'browser-report.json');
const CHROME = '/home/eya/.agent-browser/browsers/chrome-154.0.8037.57/chrome';
const PORT = Number(process.env.CDP_PORT ?? 9412);
const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:8901/';
const PROFILE = '/tmp/lb-cdp-profile';

if (!fs.existsSync(CHROME)) {
  console.error(`chrome not found at ${CHROME}`);
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: String(detail ?? '') });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Preset the words the page will "randomly" draw, so the harness knows them exactly AND can force
// a winning round (to exercise the win wording and the paytable highlight). Since wave 3 the page
// no longer auto-plays on boot, so the FIRST draw is the first DEMO click — under the clicked rule.
const wordOf = b => '0x' + BigInt(b).toString(16).padStart(8, '0').padEnd(64, '0');
function firstWhere(pred, cap = 500000) {
  for (let b = 0; b < cap; b++) if (pred(b)) return wordOf(b);
  return null;
}
const w2a = firstWhere(b => { const s = model.outcomeWithRule(wordOf(b), 2).stat; return s >= 8 && s <= 12; }); // 2x under rule 2
const w2b = firstWhere(b => model.outcomeWithRule(wordOf(b), 2).stat >= 8 && wordOf(b) !== w2a);              // any win, different word
const w2c = firstWhere(b => model.outcomeWithRule(wordOf(b), 2).stat <= 5 && wordOf(b) !== w2b);               // a loss, different word
const preset = [w2a, w2b, w2c].filter(Boolean);
if (preset.length < 3) {
  console.error('could not presolve enough words');
  process.exit(2);
}

// The patch runs before any page script: crypto.getRandomValues returns the preset words in order
// and records them, so the harness knows the exact word each round was dealt.
const PATCH = `(() => {
  window.__words = [];
  const preset = ${JSON.stringify(preset)};
  let c = 0;
  const fill = (a) => {
    const hex = preset[Math.min(c, preset.length - 1)];
    c += 1;
    const bytes = hex.replace(/^0x/, '');
    for (let i = 0; i < a.length; i++) a[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16) || 0;
    window.__words.push(hex);
    return a;
  };
  Object.defineProperty(Crypto.prototype, 'getRandomValues', { value: fill, writable: true, configurable: true });
})();`;

function startChrome() {
  return spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools did not come up');
}

// Minimal CDP client over the built-in global WebSocket (Node >= 22).
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    });
    ws.addEventListener('error', e => reject(new Error('ws error: ' + (e.message ?? ''))));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        id += 1;
        const myId = id;
        return new Promise((res, rej) => {
          pending.set(myId, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: myId, method, params }));
        });
      },
      close() { ws.close(); },
    }));
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval exception');
  return r.result?.value;
}
async function realClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

const READ_STATE = `(() => {
  const g = id => document.getElementById(id);
  return {
    notice: g('notice').textContent,
    headline: g('headline').textContent,
    kpop: g('k-pop').textContent,
    kmult: g('k-mult').textContent,
    krule: g('k-rule').textContent,
    kgen: g('k-gen').textContent,
    kpay: g('k-pay').textContent,
    kpayNote: g('k-pay-note').textContent,
    live: document.querySelectorAll('.berth.live').length,
    berths: document.querySelectorAll('.berth').length,
    drow: document.querySelectorAll('.drow').length,
    chips: [...document.querySelectorAll('.rule')].map(d => ({ rule: d.dataset.rule, on: d.classList.contains('on'), role: d.getAttribute('role'), tabIndex: d.tabIndex, ariaChecked: d.getAttribute('aria-checked'), text: d.textContent.trim().slice(0, 46) })),
    payRows: document.querySelectorAll('table.pay tbody tr').length,
    payOn: [...document.querySelectorAll('table.pay tbody tr.on')].map(tr => tr.textContent.replace(/\\s+/g, ' ').trim()),
    words: window.__words || [],
    lib: typeof window.__lifeboat,
    bodyText: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
  };
})()`;

const readState = cdp => ev(cdp, READ_STATE);
const clickDemo = cdp => ev(cdp, `(() => { document.getElementById('demo').click(); return 'clicked'; })()`);

async function waitFor(cdp, predicate, timeoutMs = 9000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await readState(cdp);
    if (predicate(last)) return last;
    await sleep(120);
  }
  return last;
}

const settled = s => s && s.kgen === '14' && /^Census:/.test(s.headline);

const chrome = startChrome();
let cdp = null;
try {
  const wsUrl = await waitForDevtools();
  cdp = await connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });

  console.log(`\nLIFEBOAT browser check — ${BASE_URL}`);
  await cdp.send('Page.navigate', { url: BASE_URL });
  await sleep(1600); // boot grace timer (400ms) + a margin; no round should have been dealt

  // 1. page + UI + the first state is the INSTRUCTION (L6)
  const boot = await readState(cdp);
  check('page renders 20 berths', boot.berths === 20, `berths=${boot.berths}`);
  check('deck has 4 rows', boot.drow === 4, `rows=${boot.drow}`);
  check('three rule chips render', boot.chips.length === 3, boot.chips.map(c => `${c.rule}:${c.on ? 'on' : '-'}`).join(' '));
  check('paytable has 4 rows', boot.payRows === 4, `rows=${boot.payRows}`);
  check('model library is exposed', boot.lib === 'object', `window.__lifeboat is ${boot.lib}`);
  check('FIRST state is the instruction, not a played round', /Pick a rule, then press DEMO/.test(boot.headline), `headline="${boot.headline}"`);
  check('no round auto-played on boot (no word drawn, gen 0)', boot.words.length === 0 && boot.kgen === '0', `words=${boot.words.length} gen=${boot.kgen}`);
  check('no berths are lit before the player acts', boot.live === 0, `live=${boot.live}`);
  check('notice names the standalone demo', /No host answered/.test(boot.notice), `"${boot.notice}"`);

  // 2. the disabled BET is unmistakable and explains itself (L1)
  const affordance = await ev(cdp, `(() => {
    const st = e => { const c = getComputedStyle(e); return { cursor:c.cursor, opacity:c.opacity, filter:c.filter, background:c.backgroundColor }; };
    const bet = document.getElementById('bet'), demo = document.getElementById('demo');
    return { betDisabled: bet.disabled, betTitle: bet.getAttribute('title'), betAria: bet.getAttribute('aria-describedby'), bet: st(bet), demo: st(demo) };
  })()`);
  const differs = ['cursor', 'opacity', 'filter', 'background'].filter(k => affordance.bet[k] !== affordance.demo[k]);
  check('disabled BET differs from an enabled button in >=2 style axes', differs.length >= 2, `differs on ${differs.join(', ')}: ${JSON.stringify(affordance.bet)} vs ${JSON.stringify(affordance.demo)}`);
  check('disabled BET carries a title and aria-describedby', !!affordance.betTitle && !!affordance.betAria, `title="${affordance.betTitle}" aria-describedby="${affordance.betAria}"`);
  check('standalone wager field is disabled and labelled a demo', await ev(cdp, `document.getElementById('wager').disabled === true && /demo/i.test(document.getElementById('wager-note').textContent)`), await ev(cdp, `document.getElementById('wager-note').textContent`));

  // 3. chips are a keyboard radio group: Tab reaches them, Enter selects (L3)
  const roleOk = boot.chips.every(c => c.role === 'radio' && c.tabIndex === 0 && c.ariaChecked !== null);
  check('rule chips expose role=radio, tabindex=0, aria-checked', roleOk, JSON.stringify(boot.chips.map(c => `${c.role}/${c.tabIndex}/${c.ariaChecked}`)));
  const chipReach = await ev(cdp, `(() => {
    const d = document.querySelector('.rule[data-rule="2"]');
    d.focus();
    return document.activeElement === d;
  })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(150);
  const afterEnter = await readState(cdp);
  check('a chip is focusable and Enter selects it', chipReach && afterEnter.chips.find(c => c.rule === '2').on === true && /B24\/S23 will be locked/.test(afterEnter.notice), `focus=${chipReach} on=${afterEnter.chips.map(c => c.rule + ':' + c.on).join(' ')}`);

  // 4. DEMO deals a round under rule 2 and it RESOLVES to a readable result
  const beforeWords = afterEnter.words.length;
  await clickDemo(cdp);
  const r2 = await waitFor(cdp, settled);
  const word2 = r2.words[r2.words.length - 1];
  const expected2 = word2 ? model.outcomeWithRule(word2, 2).stat : null;
  check('DEMO deals (a new word was drawn)', r2.words.length > beforeWords, `words ${beforeWords} -> ${r2.words.length}`);
  check('round RESOLVES (gen 14, headline names the census)', settled(r2), `gen=${r2.kgen} headline="${r2.headline}"`);
  check('rule 2 census equals game/model.mjs for the dealt word',
    word2 !== undefined && Number(r2.kpop) === expected2,
    `word=${String(word2).slice(0, 20)}… model=${expected2} rendered=${r2.kpop}`);
  check('lit berths equal the rendered census', r2.live === Number(r2.kpop), `live=${r2.live} pop=${r2.kpop}`);
  check('locked rule is shown', r2.krule === 'B24/S23', `k-rule=${r2.krule}`);
  check('demo win says the demo pays nothing (L5)', /pays nothing/.test(r2.headline) && !/Paid \\d/.test(r2.headline), `headline="${r2.headline}"`);
  check('payout cell reads 0 and is labelled a demo', r2.kpay === '0' && /demo/i.test(r2.kpayNote), `k-pay="${r2.kpay}" note="${r2.kpayNote}"`);
  check('paytable highlights the 8-12 band', r2.payOn.length === 1 && /8.*12/.test(r2.payOn[0]) && /2x/.test(r2.payOn[0]), `on=${JSON.stringify(r2.payOn)}`);
  check('no undefined/NaN in the settled text', !/undefined|NaN/.test(r2.bodyText), r2.bodyText.slice(0, 90));

  // 5. clicking again deals a NEW round
  await clickDemo(cdp);
  await waitFor(cdp, s => s.kgen !== '14' || s.words.length > r2.words.length, 3000);
  const r3 = await waitFor(cdp, s => settled(s) && s.words.length > r2.words.length);
  const word3 = r3.words[r3.words.length - 1];
  const expected3 = word3 ? model.outcomeWithRule(word3, 2).stat : null;
  check('clicking again re-deals (gen left 14 and a new word was drawn)', r3.words.length > r2.words.length, `words ${r2.words.length} -> ${r3.words.length}`);
  check('the new round is a different word', word2 !== undefined && word3 !== undefined && word2 !== word3, `${String(word2).slice(0, 14)}… vs ${String(word3).slice(0, 14)}…`);
  check('the new round RESOLVES and matches the model', settled(r3) && word3 !== undefined && Number(r3.kpop) === expected3, `gen=${r3.kgen} model=${expected3} rendered=${r3.kpop}`);

  // 6. D6: no control centre is ever the Chain Jam badge; no horizontal overflow (L4)
  const viewports = [[320, 568], [360, 640], [390, 700], [390, 844], [768, 1024], [1280, 800]];
  const badgeHits = [];
  const overflows = [];
  for (const [w, h] of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const overflow = await ev(cdp, `({ innerW: window.innerWidth, scrollW: document.documentElement.scrollWidth })`);
    if (overflow.scrollW > overflow.innerW + 1) overflows.push(`${w}x${h}: ${overflow.scrollW} > ${overflow.innerW}`);
    const ids = ['wager', 'bet', 'demo'];
    const nChips = await ev(cdp, `document.querySelectorAll('.rule').length`);
    for (let i = 0; i < nChips; i++) ids.push('chip' + i);
    for (const anchor of ['center', 'end']) {
      for (const id of ids) {
        const r = await ev(cdp, `(() => {
          const el = ${JSON.stringify(id)}.startsWith('chip')
            ? document.querySelectorAll('.rule')[Number(${JSON.stringify(id)}.slice(4))]
            : document.getElementById(${JSON.stringify(id)});
          if (!el) return { missing: true };
          el.scrollIntoView({ block: ${JSON.stringify(anchor)}, inline: 'nearest' });
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
          return { hit: hit ? (hit.tagName + (hit.id ? '#' + hit.id : '')) : null, hitIsBadge: !!(hit && hit.id === 'chain-jam-badge') };
        })()`);
        if (r && r.hitIsBadge) badgeHits.push(`${w}x${h}/${id}/${anchor}`);
      }
    }
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const badgePresent = await ev(cdp, `!!document.getElementById('chain-jam-badge')`);
  check('no control centre is the Chain Jam badge (D6)', badgeHits.length === 0, badgePresent ? (badgeHits.length ? badgeHits.join(', ') : 'checked 6 viewports x 2 scroll anchors x 6 controls') : 'widget badge absent in this run (network) — sweep vacuous');
  check('no horizontal overflow at phone widths (L4)', overflows.length === 0, overflows.length ? overflows.join('; ') : 'scrollWidth <= innerWidth at every viewport');

  // 7. module load status codes
  const statuses = {};
  for (const rel of ['', 'src/styles.css', 'src/app.js', 'game/model.mjs', 'src/sdk/guest.mjs', 'og-image.png', 'game.manifest.json']) {
    try {
      const res = await fetch(new URL(rel, BASE_URL).href);
      statuses[rel || '/'] = res.status;
    } catch (err) {
      statuses[rel || '/'] = 'ERR ' + err.message;
    }
  }
  check('all assets serve 200', Object.values(statuses).every(s => s === 200), JSON.stringify(statuses));

  console.log('\n  settled round 1 (DEMO, rule 2): ' + JSON.stringify({ word: word2, census: r2.kpop, mult: r2.kmult, headline: r2.headline }));
  console.log('  settled round 2 (DEMO, rule 2): ' + JSON.stringify({ word: word3, census: r3.kpop, mult: r3.kmult, headline: r3.headline }));
} catch (err) {
  check('harness ran without throwing', false, err.message);
} finally {
  if (cdp) cdp.close();
  chrome.kill('SIGKILL');
}

const failed = results.filter(r => !r.ok);
fs.writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), baseUrl: BASE_URL, results }, null, 2));
console.log(`\n${'='.repeat(70)}`);
console.log(`${results.length - failed.length}/${results.length} assertions passed`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`report: ${REPORT}`);
process.exit(failed.length ? 1 : 0);
