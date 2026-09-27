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
 * The browser-level counterparts (computed styles, elementFromPoint sweep, real clicks)
 * live in tools/browser-verify.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
