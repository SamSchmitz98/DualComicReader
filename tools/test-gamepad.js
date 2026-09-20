// A controller streamed in (Moonlight/Sunshine, Steam Link) arrives as a real
// gamepad, and whatever maps it may ALSO be sending a keystroke or click the
// reader reacts to - turning one page underneath us. So a trigger press has to
// land on the right spread whether the stream turned a page or not, exactly
// like a swipe.
//
//   node tools/test-gamepad.js

const path = require('path');

let page = 96;
const TOTAL = 238;
let clicked = [];
const listeners = {};
const frames = [];

const classList = (sink) => ({
  add(c) { if (sink) sink.add(c); },
  remove(c) { if (sink) sink.delete(c); },
  toggle(c, on) { if (sink) { if (on) sink.add(c); else sink.delete(c); } },
  contains: (c) => (sink ? sink.has(c) : false),
});
const rootClasses = new Set();
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

// One virtual Xbox pad, all buttons up.
const pad = {
  index: 0, connected: true, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
  buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  axes: [0, 0, 0, 0],
};

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
Object.defineProperty(global, 'navigator', {
  value: { getGamepads: () => [pad] }, configurable: true,
});
const disk = { 'dcui2p:jumpWorks': 'true' };
global.localStorage = { getItem: (k) => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = v; } };
// Drive the pad loop by hand so a press can be held for an exact number of frames.
global.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
global.MutationObserver = class { observe() {} };
global.MouseEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
global.KeyboardEvent = global.MouseEvent;

const quiet = console.log; console.log = () => {}; console.warn = () => {};
require(path.join(__dirname, '..', 'dcui-two-page.user.js'));
console.log = quiet;

const state = global.dcui2p.state;
const results = [];
const check = (name, ok) => { results.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name); };
const pump = () => { const due = frames.splice(0, frames.length); due.forEach((f) => f()); };
const idle = async () => {
  for (let i = 0; i < 400 && (state.navigating || i < 3); i++) {
    pump();
    await new Promise((r) => setTimeout(r, 15));
  }
  pump();
};

// Press a button (or pull a trigger to `value`) for one poll, then release.
// `streamTurns` is a page the stream's own mapping turns underneath us.
async function press(i, { value = 1, streamTurns = 0 } = {}) {
  clicked = [];
  pad.buttons[i] = { pressed: value >= 1, value: value };
  pump();
  if (streamTurns) setTimeout(() => { page += streamTurns; }, 100);
  pad.buttons[i] = { pressed: false, value: 0 };
  await idle();
}

(async () => {
  page = 96;
  await press(7, { streamTurns: +1 });
  check('RT, stream also turns 96->97: lands on the next spread, 98', page === 98 && clicked.join() === '98');

  page = 96;
  await press(7, { streamTurns: 0 });
  check('RT, stream turns nothing: still lands on 98', page === 98 && clicked.join() === '98');

  page = 98;
  await press(6, { streamTurns: -1 });
  check('LT goes back a spread, to 96', page === 96 && clicked.join() === '96');

  page = 96;
  await press(5);
  check('RB works as well as RT', page === 98);

  page = 98;
  await press(14);
  check('d-pad left goes back', page === 96);

  // A trigger is analog: a light brush must not count as a press.
  page = 96;
  await press(7, { value: 0.2 });
  check('a trigger barely touched (0.2) is not a press', page === 96 && clicked.length === 0);

  // Buttons that are not bound to anything at all.
  page = 96;
  await press(11);
  check('an unbound button (right stick click) does nothing', page === 96 && clicked.length === 0);

  // The view-mode buttons must not page, and must not leak into later checks.
  const dimBefore = state.dim;
  await press(2);
  check('X dims instead of paging', state.dim !== dimBefore && page === 96 && clicked.length === 0);
  while (state.dim !== 0) await press(2);

  await press(3);
  check('Y toggles single-page mode instead of paging', state.single === true && page === 96);
  await press(3);
  check('...and Y again puts it back', state.single === false);

  await press(9);
  check('Menu raises the help card instead of paging', page === 96 && clicked.length === 0);
  await press(9);

  // Holding must not repeat: one press, one spread.
  page = 96;
  clicked = [];
  pad.buttons[7] = { pressed: true, value: 1 };
  pump(); pump(); pump();
  await idle();
  const afterHold = page;
  pad.buttons[7] = { pressed: false, value: 0 };
  await idle();
  check('holding the trigger moves one spread, not many', afterHold === 98 && page === 98);

  page = 96;
  state.gamepad = false;
  await press(7);
  check('nothing happens once the gamepad is switched off', page === 96 && clicked.length === 0);
  state.gamepad = true;

  const failed = results.filter((r) => !r).length;
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
