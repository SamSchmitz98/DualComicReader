// The layout must not run away.
//
// In a live session the script hit 60 layouts a second, sustained - one per
// animation frame. apply() writes to the DOM, a MutationObserver watches the
// reader and calls apply() when it changes, and the guard against reacting to
// our own writes was a flag set during them. That flag cannot work: observer
// callbacks are delivered asynchronously, so it is false again by the time one
// arrives.
//
// Two defences, and this measures the second:
//   - takeRecords() after our writes, discarding the records they produced;
//   - a hard ceiling on how often a layout may run, whatever provokes it.
//
// The ceiling is what fails on the pre-fix script (31/s against a limit of
// 25). The idle check passes either way here, because the live trigger was a
// fight with the site's framework over a class - since removed - which this
// harness does not reproduce.
//
//   node tools/test-churn.js

const path = require('path');

let page = 96;
const TOTAL = 238;
const listeners = {};

const classList = (sink, onWrite) => ({
  add(c) { if (sink && !sink.has(c)) { sink.add(c); if (onWrite) onWrite(); } },
  remove(c) { if (sink && sink.has(c)) { sink.delete(c); if (onWrite) onWrite(); } },
  toggle(c, on) { if (!sink) return; const had = sink.has(c);
    if (on && !had) { sink.add(c); if (onWrite) onWrite(); }
    if (!on && had) { sink.delete(c); if (onWrite) onWrite(); } },
  contains: (c) => (sink ? sink.has(c) : false),
});

// Writes queue a record and the callback is delivered LATER, as in a browser.
// takeRecords() drains the queue, and a delivery that finds it empty does not
// fire - which is the whole mechanism the script relies on to ignore its own
// writes, and the thing the first version of this test failed to model.
const observers = [];
const notify = () => observers.forEach((o) => o._push({}));

// How many full layouts have run: apply() sets this custom property once each.
let layouts = 0;

const el = (extra) => Object.assign({
  style: { setProperty() { notify(); }, removeProperty() { notify(); } },
  classList: classList(new Set(), notify),
  appendChild() {}, remove() {}, textContent: '', id: '',
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 851, height: 1305 }),
}, extra);

const canvases = [0, 1, 2].map((i) => {
  const own = new Set();
  return el({
    width: 1276, height: 1957,
    classList: classList(own, notify),
    style: { transform: 'translate(' + ((i - 1) * 851) + 'px, 0px)', zIndex: String(3 - i),
             setProperty() { notify(); }, removeProperty() { notify(); } },
  });
});
const host = el({});
host.querySelectorAll = () => canvases;
const thumbs = Array.from({ length: TOTAL }, (_, i) => el({
  alt: 'Page ' + (i + 1), naturalWidth: 163, naturalHeight: 250,
  closest: () => null, dispatchEvent() { return true; },
}));
const counter = { get textContent() { return 'Page ' + page + ' / ' + TOTAL; } };

global.window = global;
global.innerWidth = 2130; global.innerHeight = 1305; global.devicePixelRatio = 1.5;
global.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
global.dispatchEvent = () => true;
global.Event = class { constructor(t) { this.type = t; } };
global.document = {
  readyState: 'complete', head: el(), body: el(), activeElement: null,
  documentElement: el({
    clientWidth: 2130, clientHeight: 1305,
    classList: classList(new Set()),                 // outside the observed subtree
    style: {
      setProperty(k) { if (k === '--dcui2p-w') layouts++; },
      removeProperty() {},
    },
  }),
  addEventListener() {},
  querySelector: (sel) => sel.includes('dc-comic-reader') ? host
    : sel.includes('issue-page-reader-container') ? el({ parentElement: el() }) : null,
  querySelectorAll: (sel) => sel.includes('page-count') ? [counter]
    : sel.includes('page-browser') ? thumbs : sel === 'canvas' ? canvases : [],
  createElement: () => el(),
};
global.location = { pathname: '/comics/book/x/y/c/reader' };
Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
const disk = { 'dcui2p:jumpWorks': 'true' };
global.localStorage = { getItem: (k) => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = v; } };
global.requestAnimationFrame = (f) => setTimeout(f, 16);
global.getComputedStyle = () => ({ transform: 'none', visibility: 'visible', zIndex: '0',
  width: '2130px', left: '0px', overflow: 'hidden', backgroundColor: 'rgb(0,0,0)' });
global.MutationObserver = class {
  constructor(cb) { this.cb = cb; this.queue = []; this.scheduled = false; observers.push(this); }
  observe() {}
  takeRecords() { const q = this.queue; this.queue = []; return q; }
  _push(rec) {
    this.queue.push(rec);
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      const recs = this.takeRecords();
      if (recs.length) this.cb(recs, this);      // nothing queued, nothing delivered
    }, 0);
  }
};
global.MouseEvent = class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
global.KeyboardEvent = global.MouseEvent;

const quiet = console.log; console.log = () => {}; console.warn = () => {};
require(path.join(__dirname, '..', 'dcui-two-page.user.js'));
console.log = quiet;

const api = global.dcui2p;
const results = [];
const check = (name, ok) => { results.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name); };

(async () => {
  api.apply();                                    // one deliberate layout
  await new Promise((r) => setTimeout(r, 100));
  const before = layouts;
  await new Promise((r) => setTimeout(r, 1500));  // then leave it completely alone
  const idle = layouts - before;

  console.log('layouts in 1.5 idle seconds: ' + idle);
  check('the layout does not trigger itself', idle <= 2);

  // A page that genuinely will not sit still - the reader re-rendering, or a
  // framework rewriting an attribute we touch - must cost a trickle, not a core.
  const spin = setInterval(notify, 4);            // ~250 mutations a second
  const b2 = layouts;
  await new Promise((r) => setTimeout(r, 1000));
  clearInterval(spin);
  const busy = layouts - b2;
  console.log('layouts in 1s while the page mutates ~250x/s: ' + busy);
  check('a busy page cannot drive the layout past its ceiling', busy > 0 && busy <= 25);

  const failed = results.filter((r) => !r).length;
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
