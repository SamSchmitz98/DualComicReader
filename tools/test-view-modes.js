// Single-page mode, dimming, the help card, and standing aside while the
// reader is zoomed. The last one matters most: our CSS pins each canvas's
// transform with !important, so a reader that zooms by scaling that transform
// would have its zoom blocked outright, not merely laid out badly.
//
//   node tools/test-view-modes.js

const path = require('path');

let page = 96;
const TOTAL = 238;
const listeners = {};
const body = { kids: [] };

const classList = (sink) => ({
  add(c) { if (sink) sink.add(c); },
  remove(c) { if (sink) sink.delete(c); },
  toggle(c, on) { if (sink) { if (on) sink.add(c); else sink.delete(c); } },
  contains: (c) => (sink ? sink.has(c) : false),
});
const rootClasses = new Set();
const rootStyle = {};
const el = (extra) => Object.assign({
  style: { setProperty() {}, removeProperty() {} }, classList: classList(),
  appendChild() {}, remove() {}, textContent: '', id: '',
}, extra);

// Three canvases, so a scale can be put on one of them.
const canvases = [0, 1, 2].map((i) => el({
  width: 1276, height: 1957,
  style: { transform: 'translateX(' + ((i - 1) * 851) + 'px)', zIndex: '',
           setProperty() {}, removeProperty() {} },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 851, height: 1305 }),
}));
const host = el({ id: 'host' });
const thumbs = Array.from({ length: TOTAL }, (_, i) => el({
  alt: 'Page ' + (i + 1), naturalWidth: 163, naturalHeight: 250,
  closest: () => null, dispatchEvent() { return true; },
}));
const counter = { get textContent() { return 'Page ' + page + ' / ' + TOTAL; } };

global.window = global;
global.innerWidth = 2130; global.innerHeight = 1305; global.devicePixelRatio = 1.5;
global.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
global.dispatchEvent = () => true;      // the script pokes the reader with a resize
global.Event = class { constructor(t) { this.type = t; } };
global.document = {
  readyState: 'complete', head: el(), activeElement: null,
  body: el({ appendChild(n) { body.kids.push(n); } }),
  documentElement: el({ clientWidth: 2130, clientHeight: 1305, 
    classList: classList(rootClasses),
    requestFullscreen() {
      if (global.fullscreenAllowed === false) return Promise.reject(new Error('gesture required'));
      global.document.fullscreenElement = this;
      return Promise.resolve();
    },
    style: {
      setProperty(k, v) { rootStyle[k] = String(v); },
      removeProperty(k) { delete rootStyle[k]; },
    },
  }),
  addEventListener() {},
  fullscreenElement: null,
  exitFullscreen() { this.fullscreenElement = null; return Promise.resolve(); },
  querySelector: (sel) => {
    if (sel.includes('dc-comic-reader')) return host;
    if (sel === '#dcui2p-help') return body.kids.find((n) => n.id === 'dcui2p-help' && !n.gone) || null;
    if (sel === '#dcui2p-backdrop') return body.kids.find((n) => n.id === 'dcui2p-backdrop' && !n.gone) || null;
    if (sel.includes('issue-page-reader-container')) return el({ parentElement: el() });
    return null;
  },
  querySelectorAll: (sel) => sel.includes('page-count') ? [counter]
    : sel.includes('page-browser') ? thumbs
    : sel === 'canvas' ? canvases : [],
  createElement: () => el({ remove() { this.gone = true; } }),
};
host.querySelectorAll = () => canvases;
global.location = { pathname: '/comics/book/x/y/c/reader' };
Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
const disk = { 'dcui2p:jumpWorks': 'true' };
global.localStorage = { getItem: (k) => (k in disk ? disk[k] : null), setItem: (k, v) => { disk[k] = v; } };
global.requestAnimationFrame = (f) => setTimeout(f, 0);
global.MutationObserver = class { observe() {} takeRecords() { return []; } };
global.getComputedStyle = () => ({ transform: 'none', visibility: 'visible', width: '2130px',
  left: '0px', overflow: 'hidden', backgroundColor: 'rgb(0,0,0)' });
global.MouseEvent = class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
global.KeyboardEvent = global.MouseEvent;

const quiet = console.log; console.log = () => {}; console.warn = () => {};
require(path.join(__dirname, '..', 'dcui-two-page.user.js'));
console.log = quiet;

const api = global.dcui2p;
const state = api.state;
const results = [];
const check = (name, ok) => { results.push(ok); console.log((ok ? 'ok    ' : 'FAIL  ') + name); };
const key = (k) => listeners.keydown[0]({ isTrusted: true, key: k, code: 'Key' + k.toUpperCase(),
  type: 'keydown', target: {}, preventDefault() {}, stopImmediatePropagation() {} });
const helpShown = () => !!body.kids.find((n) => n.id === 'dcui2p-help' && !n.gone);
const helpTextNow = () => { api.help(true); const t = body.kids.filter((n) => n.id === 'dcui2p-help' && !n.gone).pop().textContent; api.help(false); return t; };
const settle = () => new Promise((r) => setTimeout(r, 40));

(async () => {
  api.apply();
  await settle();
  check('starts as a spread', state.last.showPair === true);

  const before = rootStyle['--dcui2p-dim'];
  key('b');
  check('B dims the reader', rootStyle['--dcui2p-dim'] !== before && parseFloat(rootStyle['--dcui2p-dim']) < 1);
  key('b'); key('b'); key('b');
  check('B cycles back to full brightness', parseFloat(rootStyle['--dcui2p-dim']) === 1);

  key('h');
  check('H shows the help card', helpShown() === true);
  const card = body.kids.find((n) => n.id === 'dcui2p-help').textContent;
  check('...listing the keys and the controller',
    /dim the screen/.test(card) && /controller/.test(card) && /full screen/.test(card));
  key('h');
  check('H puts it away', helpShown() === false);

  // Double-clicking a panel parks every canvas at translate(0,0) and drops the
  // ones it is not showing to opacity 0. Offsets then say nothing about which
  // canvas holds which page, so the stacking order has to carry it - 3, 2, 1
  // being current, next, previous. Without that the roles go out in DOM order,
  // and the page the reader wanted shown can be the one we hide.
  canvases.forEach((c, i) => {
    c.style.transform = 'translate(0px, 0px)';
    c.style.zIndex = String(3 - i);            // cur, next, prev
  });
  api.apply();
  await settle();
  const roles = api.canvases().map((c) => c.role).join(',');
  check('collapsed offsets fall back to the stacking order, not DOM order',
    roles === 'cur,next,prev');
  canvases.forEach((c, i) => { c.style.transform = 'translate(' + ((i - 1) * 851) + 'px, 0px)'; });
  api.apply();
  await settle();

  // Panel zoom. Double-clicking a panel takes the reader out of carousel mode
  // and it redraws the panel into EVERY canvas, so leaving our layout in place
  // shows two zoomed panels, one from each page. We have to stand aside - but
  // not so eagerly that a momentary collapse during a page turn flickers.
  canvases.forEach((c) => { c.style.transform = 'translate(0px, 0px)'; });
  api.apply();
  await settle();
  check('a momentary collapse does not suspend', state.suspended === false);

  await new Promise((r) => setTimeout(r, 300));
  api.apply();
  await settle();
  check('a sustained collapse stands aside for panel zoom',
    state.suspended === true && state.suspendedBy === 'panel zoom');
  check('...handing the reader back its full width', !rootClasses.has('dcui2p-on'));

  canvases.forEach((c, i) => { c.style.transform = 'translate(' + ((i - 1) * 851) + 'px, 0px)'; });
  api.apply();
  await settle();
  check('leaving panel zoom resumes the spread',
    state.suspended === false && rootClasses.has('dcui2p-on'));

  api.suspend();
  await settle();
  check('a manual suspend also stands aside', state.suspended === true && state.suspendedBy === 'manual');
  api.apply();
  await settle();
  check('...and is NOT undone by the panel-zoom check', state.suspended === true);
  api.resume();
  await settle();
  check('resume() brings it back', state.suspended === false && rootClasses.has('dcui2p-on'));

  // Fullscreen. The browser only allows it from a real user gesture, so the
  // refusal path has to be as well behaved as the happy one.
  global.fullscreenAllowed = true;
  key('f');
  await settle();
  check('F goes full screen', global.document.fullscreenElement !== null);
  check('...and the help card says so', /full screen             \[on\]/.test(helpTextNow()));
  key('f');
  await settle();
  check('F again leaves full screen', global.document.fullscreenElement === null);

  global.fullscreenAllowed = false;
  let threw = false;
  try { key('f'); await settle(); } catch (e) { threw = true; }
  check('a refused request does not throw, it warns', threw === false &&
    global.document.fullscreenElement === null);
  global.fullscreenAllowed = true;

  const failed = results.filter((r) => !r).length;
  console.log(failed ? '\n' + failed + ' check(s) failed' : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
