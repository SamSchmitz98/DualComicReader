// A mouse drag or touch swipe must move one SPREAD, whatever the reader itself
// does with the gesture. The reader's drag handling is a black box - it may
// turn one page, or none - so the script completes the move afterwards, from
// the page the swipe started on. This checks both cases, both directions, and
// the gestures that must not be mistaken for a swipe.
//
//   node tools/test-swipe.js

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

// Pointer targets: something on the reader surface, a button, the open page browser.
const surface = { closest: (sel) => (sel.includes('issue-page-reader-container') ? {} : null) };
const button = { closest: () => ({}) };

global.window = global;
global.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
global.document = {
  readyState: 'complete', head: el(), body: el(), activeElement: null,
  documentElement: el({ clientWidth: 1368, clientHeight: 614,  classList: classList(rootClasses) }),
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

const state = global.dcui2p.state;
const results = [];
const check = (name, ok) => { results.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name); };
const fire = (type, ev) => listeners[type].forEach((fn) => fn(ev));
const idle = async () => { await new Promise((r) => setTimeout(r, 60)); while (state.navigating) await new Promise((r) => setTimeout(r, 40)); };

// Drag from (x0,y0) to (x1,y1). `readerTurns` is what the reader's own drag
// handling does in response: +1, -1 or 0 pages, a moment after release.
async function drag({ from, to, target = surface, readerTurns = 0, ms = 0, via = [] }) {
  clicked = [];
  const base = { isTrusted: true, isPrimary: true, pointerType: 'mouse', button: 0, pointerId: 1, target };
  fire('pointerdown', Object.assign({ clientX: from[0], clientY: from[1] }, base));

  // Step the pointer there the way a real drag does, so the mid-drag fade has
  // something to react to.
  const path = via.length ? via : [[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], to];
  let darkDuringDrag = false;
  for (const [x, y] of path) {
    fire('pointermove', Object.assign({ clientX: x, clientY: y }, base));
    if (faded()) darkDuringDrag = true;
  }
  if (ms) await new Promise((r) => setTimeout(r, ms));

  fire('pointerup', Object.assign({ clientX: to[0], clientY: to[1] }, base));
  if (readerTurns) setTimeout(() => { page += readerTurns; }, 120);
  await idle();
  await new Promise((r) => setTimeout(r, 30));   // let the reveal frame run
  return { darkDuringDrag };
}

(async () => {
  page = 96;
  const first = await drag({ from: [900, 400], to: [600, 410], readerTurns: +1 });
  check('swipe left, reader turns 96->97 itself: script completes to 98', page === 98 && clicked.join() === '98');
  check('the screen fades out DURING the drag, not after it', first.darkDuringDrag === true);
  check('and it is revealed again once the move lands', faded() === false);

  page = 96;
  await drag({ from: [900, 400], to: [600, 410], readerTurns: 0 });
  check('swipe left, reader ignores the drag: script jumps 96->98', page === 98 && clicked.join() === '98');

  page = 98;
  await drag({ from: [600, 400], to: [900, 395], readerTurns: -1 });
  check('swipe right from 98, reader turns to 97: script lands on 96', page === 96 && clicked.join() === '96');

  page = 97;
  await drag({ from: [900, 400], to: [600, 400], readerTurns: +1 });
  check('swipe left from trailing page 97, reader lands on 98: nothing more to do', page === 98 && clicked.length === 0);

  page = 96;
  const short = await drag({ from: [900, 400], to: [870, 400] });
  check('a 30px drag is a click, not a swipe', page === 96 && clicked.length === 0);
  check('a click never fades the screen', short.darkDuringDrag === false && faded() === false);

  // Armed past the threshold, then dragged back and released short.
  const recalled = await drag({ from: [900, 400], to: [890, 400], via: [[800, 400], [890, 400]] });
  check('a drag taken back before release is not a swipe', page === 96 && clicked.length === 0);
  check('...and the fade it armed is released, not left stuck', recalled.darkDuringDrag === true && faded() === false);

  const vert = await drag({ from: [900, 300], to: [800, 600] });
  check('a mostly vertical drag is ignored', page === 96 && clicked.length === 0);
  check('a vertical drag never fades the screen', vert.darkDuringDrag === false && faded() === false);

  await drag({ from: [900, 400], to: [600, 400], ms: 1100 });
  check('a slow drag (a pan, or a hesitation) is ignored', page === 96 && clicked.length === 0);

  await drag({ from: [900, 400], to: [600, 400], target: button });
  check('a drag that starts on a button or an open modal is ignored', page === 96 && clicked.length === 0);

  state.enabled = false;
  const off = await drag({ from: [900, 400], to: [600, 400] });
  check('nothing happens while the script is toggled off', page === 96 && clicked.length === 0);
  check('...including no fade', off.darkDuringDrag === false && faded() === false);
  state.enabled = true;

  const failed = results.filter((r) => !r).length;
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
