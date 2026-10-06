#!/usr/bin/env node
/**
 * lifeboat UI regression tests (Wave 3).
 *
 *   node tests/ui.test.mjs      (or `npm test`)
 *
 * Pure Node — no browser, no server. These are the STATIC guards for the presentational fixes
 * that Wave 1 proved with a real browser but that no model/contract test could see:
 *
 *   D6  the Chain Jam widget's fixed badge must never sit ON TOP of a control. Covering a fixed
 *       viewport overlay from normally-flowing content is a stacking-context problem, so the
 *       controls row and the rule-chip row must be lifted above the badge's z-index.
 *   L1  the disabled BET must be visually unmistakable and carry a `title`/`aria-describedby`
 *       saying WHY it is inert.
 *   L2  the wager field must be the amount actually bet in host mode (read, parsed with the
 *       host's token decimals, clamped to the host limits) and unmistakably a no-money demo in
 *       standalone — never silently decorative.
 *   L3  the rule chips must be a real keyboard radio group (role/tabindex/aria-checked + keys).
 *   L4  narrow viewports must stack instead of overflowing horizontally.
 *   L5  a demo must not say "Paid Nx" beside a zero payout.
 *   L6  nothing may auto-play a round on boot before the first-run instruction can be read.
 *
 * L7 is the exception to the "reads files as strings" rule below: src/app.js is a page module
 * (it runs boot() on import and paints into a live DOM), so L7 loads it against a minimal stub
 * DOM and drives its real render path. The rest of this file cannot catch a wrong win/lose gate;
 * L7 can, and did.
 *
 * The browser-level counterparts (computed styles, elementFromPoint sweep, real clicks)
 * live in tools/browser-verify.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bandOf } from '../game/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('index.html');
const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const app = read('src/app.js');

let pass = 0;
const test = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

/** Async sibling of `test`: loading src/app.js is a dynamic import, so it cannot be synchronous. */
const testAsync = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

/** Collect `selector { body }` blocks whose BODY contains `fragment`. */
function rules(fragment) {
  const out = [];
  const esc = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`([^{}]*)\\{([^{}]*${esc}[^{}]*)\\}`, 'g');
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

console.log('lifeboat UI regression tests');

// ---------------------------------------------------------------- D6 (widget badge)
test('D6: controls and rule-chip rows are lifted above the widget badge z-index', () => {
  const raised = rules('z-index: 2147483647');
  assert.ok(raised.length > 0, 'no rule sets z-index: 2147483647');
  const sel = raised.map(r => r.selector).join(', ');
  assert.match(sel, /\.controls/, '.controls is not raised above the widget badge');
  assert.match(sel, /\.rulesrow/, '.rulesrow is not raised above the widget badge');
  const badgeZ = 2147483000;
  for (const r of raised) {
    const z = /z-index:\s*(\d+)/.exec(r.body);
    assert.ok(z && Number(z[1]) > badgeZ, `z-index in "${r.selector}" must exceed the badge's ${badgeZ}`);
  }
  assert.ok(/position:\s*relative/.test(raised.map(r => r.body).join(' ')), 'raised rows need position: relative');
  assert.match(html, /class="row controls"/, 'index.html does not mark the control row .controls');
  assert.match(html, /class="row rulesrow"/, 'index.html does not mark the rules row .rulesrow');
  assert.match(html, /jam\.chain\.wtf\/widget\.js/, 'the Chain Jam widget tag must remain (submission requirement)');
});

// ---------------------------------------------------------------- L1 (disabled affordance)
test('L1: disabled buttons desaturate, dim, and use a not-allowed cursor', () => {
  const disabled = [];
  const re = /([^{}]*:disabled[^{}]*)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) disabled.push({ selector: m[1].trim(), body: m[2] });
  assert.ok(disabled.length > 0, 'no :disabled rule exists');
  const merged = disabled.map(r => r.body).join('\n');
  assert.match(merged, /opacity:\s*(\.\d+|[01])/, ':disabled does not set an opacity');
  assert.match(merged, /filter:\s*grayscale/, ':disabled does not desaturate');
  assert.match(merged, /cursor:\s*not-allowed/, ':disabled does not set cursor: not-allowed');
  assert.match(merged, /background:\s*var\(--panel-dark\)/, ':disabled does not reset the primary background');
  // the combined selector guarantees it beats `.btn.primary` (equal-specificity ordering is fragile)
  const combined = disabled.map(r => r.selector).join(', ');
  assert.match(combined, /\.btn\.primary:disabled|\.btn:disabled/, 'no disabled selector targets the primary button');
});

test('L1: the disabled BET explains itself with title + aria-describedby', () => {
  const bet = /<button[^>]*id="bet"[^>]*>/.exec(html);
  assert.ok(bet, 'no #bet button in index.html');
  assert.match(bet[0], /disabled/, '#bet must ship disabled (standalone)');
  assert.match(bet[0], /\btitle="[^"]+"/, '#bet needs a title explaining why it is inert');
  assert.match(bet[0], /aria-describedby="notice"/, '#bet should point at the notice for the reason');
  assert.match(app, /setStandaloneUI|setHostUI/, 'app must switch the control UI between host and standalone');
});

// ---------------------------------------------------------------- L2 (wager is real)
test('L2: host BET reads the field, parses the host decimals, and validates min/max', () => {
  assert.match(app, /import\s*\{[^}]*computeMaxWager[^}]*\}\s*from\s*'\.\/sdk\/guest\.mjs'/,
    'app must import computeMaxWager from the guest SDK');
  assert.match(app, /String\(el\('wager'\)\.value/, 'onBet must read the wager field');
  assert.match(app, /openSession\(\{\s*wager:\s*amount\.toString\(\)/, 'onBet must send the entered amount to openSession');
  assert.match(app, /parseAmount\(raw,\s*decimals\)/, 'the wager must be parsed with token decimals');
  assert.match(app, /minWagerBase\(\)/, 'the wager must be checked against the host minimum');
  assert.match(app, /maxWagerBase\(\)/, 'the wager must be checked against the host maximum');
  assert.doesNotMatch(app, /openSession\(\{[^}]*minBetAmount/, 'openSession must not silently substitute the min bet');
});

test('L2: standalone disables and labels the wager as a no-money demo', () => {
  assert.match(html, /id="wager-note"/, 'index.html needs a visible #wager-note');
  assert.match(app, /el\('wager'\)\.disabled\s*=\s*true/, 'standalone must disable the wager field');
  assert.match(app, /el\('wager-note'\)\.textContent/, 'standalone must label the wager as unused/demo');
  assert.match(app, /addEventListener\('input'[^)]*\)/, 'the field must sanitise/inspect input, not silently accept garbage');
});

// ---------------------------------------------------------------- L3 (keyboard radio group)
test('L3: rule chips are a keyboard radio group', () => {
  assert.match(app, /setAttribute\('role',\s*'radio'\)/, 'chips need role="radio"');
  assert.match(app, /d\.tabIndex\s*=\s*0/, 'chips must be tabbable');
  assert.match(app, /setAttribute\('aria-checked'/, 'chips need aria-checked');
  assert.match(app, /ev\.key === 'Enter'/, 'Enter must activate a chip');
  assert.match(app, /ev\.key === ' '/, 'Space must activate a chip');
  assert.match(app, /ev\.key === 'ArrowRight'/, 'arrow keys should move within the radio group');
  assert.match(html, /id="rules"[^>]*role="radiogroup"/, 'the chip container should be a radiogroup');
  // selection must NOT rebuild the chips (that destroyed keyboard focus)
  assert.doesNotMatch(app, /function selectRule[\s\S]*?buildRuleChips\(\);\s*\n\s*}/, 'selectRule must update, not rebuild, the chips');
});

// ---------------------------------------------------------------- L4 (responsive)
test('L4: a narrow media query stacks the layout instead of overflowing', () => {
  const mq = /@media\s*\(max-width:\s*700px\)\s*\{([\s\S]*)\}/.exec(css);
  assert.ok(mq, 'no max-width:700px media query');
  const body = mq[1];
  assert.match(body, /\.row\s*\{[^}]*flex-direction:\s*column/, 'rows must stack on narrow viewports');
  assert.match(body, /\.side\s*\{[^}]*min-width:\s*0/, '.side must release its fixed min-width');
});

// ---------------------------------------------------------------- L5 (demo wording)
test('L5: a demo never says "Paid" next to a zero payout', () => {
  assert.match(app, /isDemoRound/, 'the app must distinguish a demo round from a real one');
  assert.match(app, /this demo pays nothing/, 'demo wins must say the demo pays nothing');
  assert.match(app, /id="k-pay-note"|el\('k-pay-note'\)/, 'the payout cell must carry a unit/context label');
  // the old unconditional "Paid ${mult}x." wording must be gone
  assert.doesNotMatch(app, /headline\.textContent = `Census: \$\{stat\} live berths under \$\{lockedRuleLabel\(\)\}\. Paid \$\{mult\}x\.`/,
    'the unconditional "Paid Nx" demo headline must be removed');
});

// ---------------------------------------------------------------- L6 (readable first state)
test('L6: no round auto-plays on boot before the user acts', () => {
  const start = /function startStandalone\(\)\s*\{([\s\S]*?)\n\}/.exec(app);
  assert.ok(start, 'startStandalone not found');
  assert.doesNotMatch(start[1], /reveal\(/, 'startStandalone must not deal a round automatically');
  assert.match(app, /function renderIdle\(\)/, 'there must be an explicit idle first state');
  assert.match(app, /renderIdle\(\);\s*\n\s*setStandaloneUI\(\)/, 'boot must render the idle state up front');
});

// ---------------------------------------------------------------- L7 (the paying band IS a win)
// WHAT THIS PROVES: the win/lose class and the headline wording that src/app.js actually emits
// for a given census. The gate, the paytable lookup and the text all come from the shipped module —
// nothing here re-implements them, and the expected class is derived from the model's own bandOf,
// so a paytable change moves both sides together instead of pinning a stale literal.
// WHAT IT DOES NOT PROVE: anything visual. `headline win` / `headline lose` are read as strings;
// whether they differ on screen is still only checked by grepping src/styles.css above, and
// layout/geometry stays in tools/browser-verify.mjs. The stub DOM records what was written, nothing
// more. Getting here at all is the point: the L1..L6 guards are regexes over source text and are
// structurally unable to fail on a gate that is *behaviourally* wrong.
class StubEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.tabIndex = -1;
    this.title = '';
    const on = new Set();
    this.classList = {
      on,
      toggle: (name, force) => {
        const want = force === undefined ? !on.has(name) : force;
        if (want) on.add(name); else on.delete(name);
      },
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) {
    const l = this.listeners.get(type) || [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type) { this.listeners.delete(type); }
  // index.html ships #pay as table > tbody > tr; app.js reaches the tbody with querySelector and
  // the rows with querySelectorAll('tbody tr'), so the stub has to answer both or markPaytable dies.
  querySelector(sel) {
    if (sel === 'tbody') {
      if (!this.tbody) this.tbody = new StubEl('tbody');
      return this.tbody;
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel === 'tbody tr' && this.tbody) return this.tbody.children.slice();
    return [];
  }
}

/** Install just enough DOM/window for src/app.js to evaluate; returns the #headline element. */
function stubDom() {
  const byId = new Map();
  const document = {
    referrer: '',
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new StubEl('div'));
      return byId.get(id);
    },
    createElement: tag => new StubEl(tag),
  };
  // boot() calls connectGameToHost inside a try/catch and never awaits it, so penpal reaching for
  // window.parent is survivable; the boot timer then settles the page to its standalone idle state.
  const window = {
    origin: 'http://localhost',
    parent: { postMessage() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = document;
  globalThis.window = window;
  return document.getElementById('headline');
}

await testAsync('L7: a census that PAYS renders as a win, including the 6 and 7 bands', async () => {
  const headline = stubDom();
  const { paintHeadline } = await import(pathToFileURL(path.join(root, 'src/app.js')).href);
  assert.equal(typeof paintHeadline, 'function', 'src/app.js must export paintHeadline to be testable');

  // The two censuses that were broken: both sit in the 1.2x band, and both used to be told the
  // colony was lost. Asserted by name as well as by class so a future band change is a visible
  // edit here rather than a silently-passing test.
  for (const pop of [6, 7]) {
    paintHeadline(pop);
    assert.equal(bandOf(pop), 1.2, `census ${pop} is expected to sit in the 1.2x band`);
    assert.equal(headline.className, 'headline win',
      `census ${pop} pays ${bandOf(pop)}x, so it must not render as a loss`);
    assert.match(headline.textContent, /1\.2x/,
      `census ${pop} must name the band it actually pays`);
    assert.doesNotMatch(headline.textContent, /The colony is lost/,
      `census ${pop} is a paying round, so the headline must not call it a loss`);
  }

  // The rest of the paytable, checked against the model's own bands rather than fixed literals, so
  // the invariant ("styled by payout") is what is asserted: 5 is the top of the 0x band and must
  // still read as a loss, and the two bands above must stay wins.
  for (const pop of [0, 3, 5, 8, 12, 13, 20]) {
    paintHeadline(pop);
    const want = bandOf(pop) > 0 ? 'headline win' : 'headline lose';
    assert.equal(headline.className, want,
      `census ${pop} pays ${bandOf(pop)}x; the headline class must follow the payout, not a threshold`);
    if (bandOf(pop) === 0) {
      assert.match(headline.textContent, /The colony is lost/, `census ${pop} is a true 0x loss`);
    }
  }
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
