// Not every input can be intercepted: the reader's own buttons, its
// click-to-advance, and a controller streamed in through Moonlight or Steam
// Link, where something upstream turns a trigger into an input we never see
// (Chrome may not even be shown the pad). Each of those turns ONE page, which
// is half a move in a two-page view.
//
// So the script reacts to the result instead: a single page turn it did not
// cause gets carried on to where a spread move would have landed. A
// deliberate jump does not.
//
//   node tools/test-outside-turn.js

const path = require('path');

let page = 96;
const TOTAL = 238;
let clicked = [];
const listeners = {};

const classList = (sink) => ({
  add(c) { if (sink) sink.add(c); },
  remove(c) { if (sink) sink.delete(c); },
  toggle(c, on) { if (sink) { if (on) sink.add(c); else sink.delete(c); } },
  contains: (c) => (sink ? sink.has(c) : false),
});
const rootClasses = new Set();
const faded = () => rootClasses.has('dcui2p-turning');
const el = (extra) => Object.assign({
  style: { setProperty() {}, removeProperty() {} }, classList: classList(),
  appendChild() {}, remove() {}, textContent: '', id: '',
}, extra);

const thumbs = Array.from({ length: TOTAL }, (_, i) => el({
  alt: 'Page ' + (i + 1), naturalWidth: 163, naturalHeight: 250, parentElement: null,
  closest: () => null,
  dispatchEvent(ev) { if (ev.type === 'click') { clicked.push(i + 1); page = i + 1; } return true; },
}));
const counter = { get textContent() { return 'Page ' + page + ' / ' + TOTAL; } };

global.window = global;
global.addEventListener = () => {};
global.document = {
  readyState: 'complete', head: el(), body: el(), activeElement: null,
  documentElement: el({ classList: classList(rootClasses) }),
  addEventListener() {}, querySelector: () => null,
  querySelectorAll: (sel) => sel.includes('page-count') ? [counter] : sel.includes('page-browser') ? thumbs : [],
  createElement: () => el(),
};
global.location = { pathname: '/comics/book/x/y/c/reader' };
Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
const disk = { 'dcui2p:jumpWorks': 'true' };
global.localStorage = { getItem: (k) => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = v; } };
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.MutationObserver = class { observe() {} };
global.MouseEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.KeyboardEvent = global.MouseEvent;

const quiet = console.log; console.log = () => {}; console.warn = () => {};
require(path.join(__dirname, '..', 'dcui-two-page.user.js'));
console.log = quiet;

const api = global.dcui2p;
const state = api.state;
const results = [];
const check = (name, ok) => { results.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name); };

// Something outside the script moves the reader, then the script notices on
// its next poll - exactly how a real outside turn arrives.
async function outside(to, { settleMs = 60 } = {}) {
  clicked = [];
  page = to;
  await new Promise((r) => setTimeout(r, settleMs));
  api.state.__poke = Date.now();          // no-op; keeps the intent obvious
  await new Promise((r) => setTimeout(r, 900));
  for (let i = 0; i < 300 && state.navigating; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 60));
}

(async () => {
  // Settle the starting position so the tracker knows where we are.
  page = 96;
  await new Promise((r) => setTimeout(r, 700));

  await outside(97);
  check('a single turn onto a trailing page is carried on to the next spread',
    page === 98 && clicked.join() === '98');
  check('the screen is not left faded', faded() === false);

  page = 98;
  await new Promise((r) => setTimeout(r, 700));
  await outside(97);
  check('a single turn backwards carries on to the previous spread, 96',
    page === 96 && clicked.join() === '96');

  // Landing on a page that already leads a row needs nothing further.
  page = 96;
  await new Promise((r) => setTimeout(r, 700));
  await outside(98);
  check('a turn that already lands on a spread boundary is left alone',
    page === 98 && clicked.length === 0);

  // A deliberate jump is not a page turn and must be obeyed exactly.
  page = 96;
  await new Promise((r) => setTimeout(r, 700));
  await outside(137);
  check('picking page 137 in the page browser stays on 137',
    page === 137 && clicked.length === 0);

  page = 96;
  await new Promise((r) => setTimeout(r, 700));
  state.enabled = false;
  await outside(97);
  check('nothing is completed while the script is toggled off',
    page === 97 && clicked.length === 0);
  state.enabled = true;

  const failed = results.filter((r) => !r).length;
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
