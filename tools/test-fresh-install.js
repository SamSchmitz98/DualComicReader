// Regression test for the failure a *shared* copy hits and the author never
// sees: a brand-new install, empty storage, no userscript APIs.
//
// The original bug: arrow keys were only intercepted once the thumbnail jump
// was known to work, and it could only become known by attempting it - so a
// fresh install sat in pass-through forever (one page per press, no fade)
// while the author's copy, with a remembered success, worked perfectly.
//
//   node tools/test-fresh-install.js

const path = require('path');

let page = 96;
const TOTAL = 238;
const clicked = [];
const listeners = {};

const classList = () => ({ add() {}, remove() {}, toggle() {}, contains: () => false });
const el = (extra) => Object.assign({
  style: { setProperty() {}, removeProperty() {} }, classList: classList(),
  appendChild() {}, remove() {}, textContent: '', id: '',
}, extra);

// Thumbnails: alt text is accurate here, so a click on "Page N" goes to N.
const thumbs = Array.from({ length: TOTAL }, (_, i) => el({
  alt: 'Page ' + (i + 1), naturalWidth: 163, naturalHeight: 250, parentElement: null,
  closest: () => null,
  dispatchEvent(ev) { if (ev.type === 'click') { clicked.push(i + 1); page = i + 1; } return true; },
}));
const counter = { get textContent() { return 'Page ' + page + ' / ' + TOTAL; } };

global.window = global;
global.addEventListener = (type, fn) => { (listeners['window:' + type] = listeners['window:' + type] || []).push(fn); };
global.document = {
  readyState: 'complete', head: el(), body: el(), documentElement: el(), activeElement: null,
  addEventListener: (type, fn) => { (listeners['document:' + type] = listeners['document:' + type] || []).push(fn); },
  querySelector: () => null,
  querySelectorAll: (sel) => sel.includes('page-count') ? [counter] : sel.includes('page-browser') ? thumbs : [],
  createElement: () => el(),
};
global.location = { pathname: '/comics/book/x/y/c/reader' };
Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
const disk = {};
global.localStorage = { getItem: (k) => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = v; } };
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.MutationObserver = class { observe() {} };
global.MouseEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.KeyboardEvent = global.MouseEvent;

const quiet = console.log; console.log = () => {}; console.warn = () => {};
require(path.join(__dirname, '..', 'dcui-two-page.user.js'));
console.log = quiet;

const results = [];
const check = (name, ok) => { results.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name); };

function press(key) {
  const ev = { isTrusted: true, key, code: key, type: 'keydown', target: {},
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  listeners['window:keydown'][0](ev);
  return ev;
}

(async () => {
  const s = global.dcui2p.state;
  check('fresh install: jump is untested, not assumed broken', s.jumpWorks === null);
  check('fresh install: arrow keys are NOT handed to the reader', s.passThrough === false);

  const ev = press('ArrowRight');
  check('first arrow press is intercepted', ev.prevented && ev.stopped);

  await new Promise((r) => setTimeout(r, 2500));
  check('it clicked the thumbnail for the next row leader (98)', clicked[0] === 98);
  check('the reader is now on page 98', page === 98);
  check('success is remembered for next session', disk['dcui2p:jumpWorks'] === 'true');

  // The keyup belonging to a key we took must be taken too.
  const up = { isTrusted: true, key: 'ArrowRight', code: 'ArrowRight', type: 'keyup',
    prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  listeners['window:keyup'][0](up);
  check('the matching keyup is swallowed as well', up.prevented);

  const failed = results.filter((r) => !r).length;
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
