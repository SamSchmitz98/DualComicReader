// ==UserScript==
// @name         DCUI Two-Page View
// @namespace    https://github.com/SamSchmitz98/DualComicReader
// @version      1.4.0
// @description  Shows two portrait pages side by side in the DC Universe Infinite web reader, like an open print comic. Layout only - no downloading, extracting or re-hosting of artwork.
// @author       SamSchmitz98
// @match        https://www.dcuniverseinfinite.com/comics/book/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @noframes
// @updateURL    https://raw.githubusercontent.com/SamSchmitz98/DualComicReader/main/dcui-two-page.user.js
// @downloadURL  https://raw.githubusercontent.com/SamSchmitz98/DualComicReader/main/dcui-two-page.user.js
// ==/UserScript==

/*
 * HOW THIS WORKS (the short version)
 *
 * The DCUI reader is a three-slide carousel of <canvas> elements inside
 * .dc-comic-reader. The three canvases hold the previous, current and next
 * page, and they are positioned at translateX(0) and translateX(+/- W) where
 * W is the width of their container.
 *
 * Two facts make a spread view easy:
 *
 *   1. The reader sizes its canvases from its CONTAINER (not the window) and
 *      re-fits the page art with a `contain` scale whenever a resize fires.
 *   2. The page-browser modal already holds a thumbnail <img> per page, with
 *      alt="Page N" and real natural dimensions - a complete manifest of the
 *      issue, including which pages are double-page spreads.
 *
 * So: set the container to exactly the width the art wants to be
 * (viewportHeight * pageAspect), and the art fills its canvas edge to edge
 * while the "next" canvas lands flush against the current one's right edge.
 * The spread assembles itself. We only centre the result and hide the
 * "previous" canvas.
 *
 * Nothing here reads pixels off a canvas, clones artwork, or issues a network
 * request. See FINDINGS.md for how this was established.
 *
 * DEBUGGING: press D for an on-screen HUD and console logging. From the
 * browser console, `dcui2p` exposes the live state plus `probeNav()`, which
 * tries every navigation hook and reports which one actually turns a page.
 */

(function () {
  'use strict';

  // This one file is loaded two ways: by a userscript manager, or as the
  // content script of the unpacked extension (manifest.json, MAIN world). No
  // GM_* API is assumed anywhere - each use is guarded and falls back to a
  // plain-web equivalent. If someone has both installed, run once: the flag
  // lives on the page's real global, which both injection routes can see.
  const pageGlobal = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (pageGlobal.__dcui2pLoaded) return;
  pageGlobal.__dcui2pLoaded = true;

  const SEL = {
    host: '.dc-comic-reader',
    outer: '#issue-page-reader-container',
    thumbs: '.reader-modal__page-browser img',
    pageCount: '.page-count',
  };

  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.4.0';

  const DEFAULT_ASPECT = 0.652;   // standard US comic page, used until the manifest loads
  const MIN_BOX = 260;            // below this a pair is unreadable; fall back to single page
  const NAV_TIMEOUT = 1600;       // ms to wait for the reader to actually turn a page
  const PROBE_TIMEOUT = 700;      // ms per strategy when probing for a working nav hook
  const JUMP_TIMEOUT = 2600;      // ms to reach the target page after a thumbnail click
  const FADE_MS = 80;             // fade out/in across a page turn; drives CSS and the wait
  const FADE_MAX_MS = 1800;       // never hold the screen faded out longer than this (a two-page jump takes ~1.3s)
  const SETTLE_QUIET = 620;       // ms of no page change that counts as "arrived"
  // Standard-gamepad button indices (Xbox layout): the triggers, shoulders,
  // d-pad and face buttons all move a spread, so whichever one falls under a
  // thumb works without configuring anything.
  const PAD_NEXT = [7, 5, 15, 0];  // RT, RB, d-pad right, A
  const PAD_PREV = [6, 4, 14, 1];  // LT, LB, d-pad left, B
  const PAD_DIM = 2;               // X
  const PAD_SINGLE = 3;            // Y
  const PAD_HELP = 9;              // Menu / Start
  const DIM_LEVELS = [1, 0.85, 0.7, 0.55];
  const HELP_SECONDS = 14;         // the card puts itself away again
  const PAD_AXIS = 0.6;            // stick deflection that counts as a press
  const PAD_ANALOG = 0.5;          // trigger pull that counts as a press

  const SWIPE_ARM_PX = 45;        // fade out here, before the gesture is over
  const SWIPE_MIN_PX = 60;        // shorter than this is a click, not a swipe
  const SWIPE_MAX_MS = 900;       // slower than this is a pan or a hesitation, not a swipe
  const SWIPE_RATIO = 2;          // must be at least this much more horizontal than vertical
  const ARRIVAL_QUIET = 320;      // after the counter hits the target: time for the neighbour canvas to redraw

  // ---------------------------------------------------------------- state

  const state = {
    enabled: true,
    parity: 0,          // 0 = pages pair as [1],[2,3],[4,5]; 1 = shifted by one
    debug: false,
    manifest: [],       // manifest[pageNumber] = aspect ratio (width / height)
    total: 0,
    boxW: 0,
    navigating: false,
    navStrategy: null,  // name of the last navigation hook known to work
    last: {},           // most recent layout decision, for the HUD
    rows: [],           // [[1], [2,3], [4], [5,6], ...] - the whole issue in rows
    rowOf: [],          // rowOf[pageNumber] = index into rows
    rowsKey: '',        // signature of the inputs the rows were built from
    stock: null,        // snapshot of the untouched reader, to verify T restores it
    tornDown: false,    // teardown is idempotent; this is the latch
    smooth: true,       // fade across page turns instead of watching them
    jumpWorks: null,    // can we navigate by clicking a page-browser thumbnail?
    jumpOffset: 0,      // measured gap between a thumbnail's alt text and where it lands
    dim: 0,             // index into DIM_LEVELS
    single: false,      // show one page at a time instead of a spread
    suspended: false,   // stand aside without switching off - see suspend()
    suspendedBy: '',
    gamepad: true,      // read controllers; set false from the console to stop
    padName: '',        // what is connected, for the HUD
    padLast: '',        // last control pressed, so a button can be identified
    history: [],        // every page change, recorded whether or not debug is on
    navReason: '',      // what the script is currently doing, to attribute changes
    // Set when a jump has been tried and did nothing: the arrow keys are then
    // left to the reader for the rest of the session. Pairing does not depend
    // on navigation (see pairDecision), so this degrades to one page per
    // press rather than breaking anything.
    passThrough: false,
    manifestDecoded: 0, // thumbnails that have decoded (and so have real dimensions)
    manifestExpected: 0,
    stats: { applies: 0, mutations: 0, resizes: 0, canvases: 0, rate: '0/s 0/s', since: Date.now() },
  };

  // Our own resize dispatch makes the reader redraw, which mutates the DOM,
  // which schedules another apply. That is meant to settle immediately - but
  // if it ever does not, it would show up as a TV-melting feedback loop rather
  // than an error. Sample the rates so the HUD can show it plainly.
  setInterval(() => {
    const s = state.stats;
    const secs = Math.max(1, (Date.now() - s.since) / 1000);
    s.rate = Math.round(s.applies / secs) + '/s apply, ' + Math.round(s.mutations / secs) + '/s mut';
    if (s.applies / secs > 20) {
      warn('layout churn: ' + s.rate + ' - something is feeding back');
    }
    s.applies = 0; s.mutations = 0; s.since = Date.now();
  }, 2000);

  // GM_* is not available in every engine/grant combination, so fall back to
  // localStorage. Per-site by construction: localStorage is already origin-scoped.
  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined ? fallback : v;
        }
        const raw = localStorage.getItem('dcui2p:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else localStorage.setItem('dcui2p:' + key, JSON.stringify(value));
      } catch (_) { /* private mode, blocked storage - not worth failing over */ }
    },
  };

  // ------------------------------------------------------------- utilities

  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const onReaderPage = () => /\/c\/reader(\/|$)/.test(location.pathname);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Sandboxing userscript engines hand the script a wrapped `window`, and
  // UIEvent constructors refuse it for the `view` property ("Failed to convert
  // value to 'Window'"). unsafeWindow is the page's real Window; if neither is
  // acceptable, build the event without a `view` at all - handlers rarely care.
  const REAL_WINDOW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  function makeEvent(Ctor, type, init) {
    try {
      return new Ctor(type, Object.assign({ view: REAL_WINDOW }, init));
    } catch (_) {
      return new Ctor(type, init);
    }
  }

  function currentPage() {
    // The chrome renders "Page 104 / 238" in more than one place (mobile,
    // tablet and desktop control groups all have a .page-count). Any of them
    // will do; take the first that parses.
    for (const el of qa(SEL.pageCount)) {
      const m = /Page\s+(\d+)\s*\/\s*(\d+)/.exec(el.textContent || '');
      if (m) {
        state.total = +m[2];
        return +m[1];
      }
    }
    return 0;
  }

  function readManifest() {
    const thumbs = qa(SEL.thumbs);
    if (!thumbs.length) return false;
    const manifest = [];
    let decoded = 0;
    let undecoded = 0;
    for (const img of thumbs) {
      const m = /Page\s+(\d+)/i.exec(img.alt || '');
      if (!m) continue;
      // naturalWidth/Height is metadata about an image the reader already put
      // in the DOM. Reading it is not extraction and costs no request.
      if (img.naturalHeight > 0) {
        manifest[+m[1]] = img.naturalWidth / img.naturalHeight;
        decoded++;
      } else {
        undecoded++;
      }
    }
    state.manifestDecoded = decoded;
    state.manifestExpected = thumbs.length;

    if (!decoded) {
      log('manifest: found ' + thumbs.length + ' thumbnails but none decoded yet');
      return false;
    }
    state.manifest = manifest;
    if (!state.total) state.total = thumbs.length;
    buildRows();
    log('manifest: ' + decoded + '/' + thumbs.length + ' pages read' +
        (undecoded ? ' (' + undecoded + ' still decoding)' : '') +
        ', spreads at ' + (spreadPages().join(', ') || 'none') +
        ', laid out in ' + state.rows.length + ' rows');
    return undecoded === 0;
  }

  // A thumbnail that has not decoded yet reports naturalHeight 0, so its page
  // silently defaults to portrait - and if that page is a spread, it gets
  // paired when it should stand alone. One read at startup is therefore not
  // enough: keep re-reading until every thumbnail has decoded.
  let manifestPoll = 0;
  function pollManifest() {
    clearInterval(manifestPoll);
    let tries = 0;
    manifestPoll = setInterval(() => {
      if (readManifest() || ++tries > 30) {      // ~22s worst case
        clearInterval(manifestPoll);
        if (state.manifestDecoded === state.manifestExpected) {
          log('manifest: complete, ' + spreadPages().length + ' spreads');
          apply();
        } else {
          warn('manifest: gave up with ' + state.manifestDecoded + '/' + state.manifestExpected +
               ' decoded - pages that never decoded are assumed portrait');
        }
      }
    }, 750);
  }

  const aspectOf = (page) => state.manifest[page] || DEFAULT_ASPECT;

  // A double-page spread is delivered as one wide image: ~1.30 where a single
  // page is ~0.65. Anything wider than tall gets a full-width row to itself.
  const isSpread = (page) => aspectOf(page) > 1;

  const spreadPages = () => state.manifest.reduce((acc, a, i) => (a > 1 ? acc.concat(i) : acc), []);

  // ---------------------------------------------------------- the row model
  //
  // Pairing cannot be done with odd/even arithmetic, because a spread consumes
  // a whole row and shifts the rhythm of every page after it. The test issue
  // has four spreads and the first is page 3, so parity would be wrong for
  // almost the entire book.
  //
  // Instead, walk the manifest once and lay the whole issue out in rows:
  // the cover alone, then pairs, with each spread taking a row to itself.
  // Everything else - what to show, where a page sits, where the arrows go -
  // is a lookup against that. `P` shifts the starting offset, which is all it
  // should ever need to do.

  function buildRows() {
    const total = state.total || Math.max(0, state.manifest.length - 1);
    state.rows = [];
    state.rowOf = [];
    if (!total) return;

    let page = 1;
    // Offset 0: the cover stands alone, so pairs start at page 2.
    // Offset 1: pair from page 1, for books whose numbering does not line up.
    if (state.parity === 0 && !isSpread(1)) {
      state.rows.push([1]);
      page = 2;
    }
    while (page <= total) {
      if (isSpread(page) || page === total || isSpread(page + 1)) {
        state.rows.push([page]);
        page += 1;
      } else {
        state.rows.push([page, page + 1]);
        page += 2;
      }
    }
    state.rows.forEach((pages, i) => pages.forEach((n) => { state.rowOf[n] = i; }));
    state.rowsKey = rowsKey();
  }

  const rowsKey = () => state.total + ':' + state.parity + ':' + state.manifest.length;

  function ensureRows() {
    if (state.rowsKey !== rowsKey() || !state.rows.length) buildRows();
  }

  function rowFor(page) {
    ensureRows();
    const idx = state.rowOf[page];
    return idx === undefined ? null : state.rows[idx];
  }

  // True when `page` should be shown alongside page+1. Returns the reason too,
  // so the HUD can explain itself.
  // Which two canvases make up the spread, and which goes on the left.
  //
  // The carousel always holds the previous, current and next page, so when the
  // current page is the RIGHT half of its row we do not need to navigate
  // anywhere - the page that belongs beside it is already drawn in the `prev`
  // canvas. Pairing is therefore a display decision, not a navigation one,
  // which matters because this reader cannot be navigated synthetically at
  // all (see FINDINGS.md).
  function pairDecision(page) {
    if (!state.enabled) return { pair: false, why: 'script disabled' };
    if (page < 1) return { pair: false, why: 'no page number' };

    if (state.single) return { pair: false, why: 'single-page mode (Z)' };

    const row = rowFor(page);
    if (!row) return { pair: false, why: 'page not in the row model yet' };

    if (row.length === 2) {
      return row[0] === page
        ? { pair: true, left: 'cur', right: 'next', why: 'showing [' + row.join(', ') + ']' }
        : { pair: true, left: 'prev', right: 'cur', why: 'showing [' + row.join(', ') + '] from the previous canvas' };
    }
    if (isSpread(page)) return { pair: false, why: 'spread, full width' };
    if (state.total && page >= state.total) return { pair: false, why: 'last page' };
    if (page === 1) return { pair: false, why: 'cover stands alone' };
    return { pair: false, why: 'alone (its neighbour is a spread)' };
  }

  // Where an arrow press should land: the first page of the next or previous
  // row. Stepping back from the right half of a pair aligns to its left page
  // first, which is what you want if you arrived mid-row.
  function targetPage(page, dir) {
    // One page at a time when that is what is on screen.
    if (state.single) {
      const next = page + dir;
      return next >= 1 && (!state.total || next <= state.total) ? next : page;
    }
    ensureRows();
    const idx = state.rowOf[page];
    if (idx === undefined) {
      const fallback = page + (dir > 0 ? 1 : -1);
      return Math.max(1, state.total ? Math.min(fallback, state.total) : fallback);
    }
    if (dir > 0) {
      const next = state.rows[idx + 1];
      return next ? next[0] : page;
    }
    // Backwards always means the previous spread. A page that trails its row
    // is already displayed as that row (see pairDecision), so "go to the
    // start of this row" would look like nothing happened.
    const prev = state.rows[idx - 1];
    return prev ? prev[0] : 1;
  }

  // ------------------------------------------------------------------ debug

  const logLines = [];

  function log(...args) {
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    logLines.push(new Date().toLocaleTimeString() + '  ' + text);
    if (logLines.length > 8) logLines.shift();
    if (state.debug) console.log('%c[dcui2p]', 'color:#0a0;font-weight:bold', ...args);
    updateHud();
  }

  function warn(...args) {
    logLines.push(new Date().toLocaleTimeString() + '  !! ' + args.join(' '));
    if (logLines.length > 8) logLines.shift();
    console.warn('[dcui2p]', ...args);
    updateHud();
  }

  function hudElement() {
    let el = q('#dcui2p-hud');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dcui2p-hud';
      document.body.appendChild(el);
    }
    return el;
  }

  function updateHud() {
    if (!state.debug) {
      const existing = q('#dcui2p-hud');
      if (existing) existing.remove();
      return;
    }
    const host = q(SEL.host);
    const page = currentPage();
    const L = state.last;
    const roles = host ? classify(host) : new Map();

    const canvasLines = host ? qa('canvas', host).map((c, i) => {
      const role = roles.get(c) || '?';
      const rect = c.getBoundingClientRect();
      const shown = getComputedStyle(c).visibility !== 'hidden';
      return '  [' + i + '] ' + role.padEnd(4) +
             ' slot=' + String(Math.round(slotOf(c))).padStart(6) +
             ' buf=' + c.width + 'x' + c.height +
             ' x=' + Math.round(rect.left) +
             (shown ? '' : ' HIDDEN');
    }) : ['  (no reader container)'];

    // What the viewer is actually looking at, which is the thing worth
    // sanity-checking at a glance.
    const visible = page ? describeVisible(page) : 'nothing';

    hudElement().textContent = [
      'DCUI 2-PAGE v' + VERSION + '  ' + (state.enabled ? 'ON' : 'OFF') +
        '   [T]oggle [P]arity [S]mooth [D]ebug',
      'touch: triple-tap this corner to show/hide',
      'input      ' + (navigator.maxTouchPoints > 0 ? 'touch (' + navigator.maxTouchPoints + ' points)' : 'no touch') +
        '   dpr ' + (window.devicePixelRatio || 1) +
        '   ' + (typeof GM_info !== 'undefined' ? 'userscript' : 'extension'),
      '',
      'VISIBLE: ' + visible,
      '',
      'page       ' + (page || '?') + ' / ' + (state.total || '?') +
        '   aspect ' + aspectOf(page).toFixed(3) + (isSpread(page) ? ' SPREAD' : ''),
      'next page  ' + (page + 1) + '   aspect ' + aspectOf(page + 1).toFixed(3) +
        (isSpread(page + 1) ? ' SPREAD' : ''),
      'pairing    ' + (L.showPair ? 'YES' : 'no') + '  (' + (L.why || '-') + ')',
      'view       ' + (state.single ? 'ONE PAGE (Z)' : 'spread') +
        '   dim ' + Math.round(DIM_LEVELS[state.dim] * 100) + '%' +
        (state.suspended ? '   SUSPENDED (' + state.suspendedBy + ')' : ''),
      'offset     ' + state.parity + '  (' +
        (state.parity === 0 ? 'cover alone: [1] [2,3] [4,5]' : 'pairs from page 1: [1,2] [3,4]') +
        ')  press P to flip',
      'row        ' + (state.rowOf[page] === undefined ? '?' : (state.rowOf[page] + 1)) +
        ' / ' + (state.rows.length || '?') + '   [' + (rowFor(page) || []).join(', ') + ']' +
        '   <- ' + targetPage(page, -1) + ' | ' + targetPage(page, 1) + ' ->',
      '',
      'box        ' + (L.boxW || '?') + 'px   left=' + (L.left || 0) + 'px   span=' + (L.spanW || '?') + 'px',
      'viewport   ' + window.innerWidth + 'x' + window.innerHeight +
        '   ideal box=' + Math.round(window.innerHeight * aspectOf(page)) + 'px',
      'manifest   ' + state.manifestDecoded + '/' + (state.manifestExpected || '?') + ' decoded, ' +
        spreadPages().length + ' spreads' +
        (state.manifestDecoded < state.manifestExpected ? '  (still loading)' : ''),
      'pad        ' + (state.padName || 'none connected') +
        (state.padLast ? '   last: ' + state.padLast : ''),
      'nav hook   ' + (state.passThrough ? 'NONE - keys passed to reader, one page per press' : 'jump:thumbnail') +
        '   jump ' + (state.jumpWorks === null ? 'untested' : state.jumpWorks ? 'YES' : 'no') +
        (state.jumpOffset ? '(' + (state.jumpOffset > 0 ? '+' : '') + state.jumpOffset + ')' : '') +
        '   fade ' + (state.smooth ? 'on' : 'off'),
      'churn      ' + state.stats.rate + '   resizes sent ' + state.stats.resizes +
        '   canvases ' + state.stats.canvases,
      '',
      'canvases:',
      ...canvasLines,
      '',
      'page changes:',
      ...(state.history.length
        ? state.history.slice(-5).map((h) => '  ' + h.at + '  ' + (h.from || '-') + ' -> ' + h.to +
            '  ' + h.cause + (h.leads ? '' : '  MID-ROW'))
        : ['  (none yet)']),
      '',
      'log:',
      ...logLines.map((l) => '  ' + l),
    ].join('\n');
  }

  // --------------------------------------------------------- change tracking

  function describeVisible(page) {
    if (!page) return 'nothing';
    if (isSpread(page)) return 'page ' + page + ' (spread, full width)';
    const d = pairDecision(page);
    const row = rowFor(page);
    if (d.pair && row) {
      return 'pages ' + row[0] + ' + ' + row[1] +
             (d.left === 'prev' ? ' (current page on the right)' : '');
    }
    return 'page ' + page + ' alone';
  }

  // Record every page change, including ones we did not cause, so that when
  // something unexpected shows up there is a history to look at rather than a
  // request to reproduce it with debug switched on.
  let lastSeenPage = 0;
  function trackPage() {
    const page = currentPage();
    if (!page || page === lastSeenPage) return;
    const from = lastSeenPage;
    lastSeenPage = page;

    const row = rowFor(page);
    const entry = {
      at: new Date().toLocaleTimeString(),
      from: from, to: page,
      cause: state.navigating ? (state.navReason || 'script') : 'reader or user',
      row: row ? '[' + row.join(', ') + ']' : '[?]',
      leads: !!row && row[0] === page,
      shows: describeVisible(page),
    };
    state.history.push(entry);
    if (state.history.length > 60) state.history.shift();

    if (!state.navigating) completeOutsideTurn(from);

    if (state.debug) {
      console.log('%c[dcui2p] page ' + (from || '-') + ' -> ' + page + '%c  via ' + entry.cause +
        '   row ' + entry.row + (entry.leads ? '' : '  <-- MID-ROW') + '   showing ' + entry.shows,
        'color:#0a0;font-weight:bold', 'color:inherit');
    }
  }

  // Finish a page turn that something else started.
  //
  // Arrow keys, swipes and gamepads are all intercepted, but plenty of input
  // cannot be: the reader's own on-screen buttons, click-to-advance, and - the
  // case this was written for - a controller streamed in through Moonlight or
  // Steam Link, where something upstream turns a trigger into a keystroke or
  // click that never looks like anything we recognise. Chrome may not even see
  // the pad.
  //
  // Whatever the input was, it turned ONE page, which is half a move here. So
  // rather than trying to identify every possible source, react to the result:
  // when the page moves a single step and we did not do it, carry on to where
  // a spread move from the starting page would have landed.
  //
  // Only single steps. A deliberate jump - picking a page in the browser - is
  // left exactly where it was asked to go.
  let completing = false;

  async function completeOutsideTurn(from) {
    if (completing || !from) return;
    if (state.single) return;        // a single page per turn is already right
    if (!state.enabled || state.navigating || state.passThrough || state.jumpWorks === false) return;
    completing = true;

    // Fade immediately: the reader animates its own turn, and on a canvas that
    // animation is drawn into the bitmap where CSS cannot hold it still.
    if (state.smooth) setTurning(true);
    let handed = false;

    try {
      // Let the reader finish. Deciding now would risk reading a page it is
      // only passing through.
      const settled = await settledPage(1400, 220);
      if (state.navigating) return;
      if (Math.abs(settled - from) !== 1) return;     // a jump, not a page turn

      ensureRows();
      const dir = settled > from ? 1 : -1;
      const target = targetPage(from, dir);
      if (!target || target === settled) return;      // already where a spread move lands
      if (!thumbFor(target - state.jumpOffset)) return;

      state.navigating = true;
      handed = true;
      state.navReason = 'completing an outside turn to ' + target;
      try {
        log('outside: something turned ' + from + ' -> ' + settled +
            '; completing the spread to ' + target);
        await goToPage(target, 'complete');
      } finally {
        state.navigating = false;
        apply();
        requestAnimationFrame(() => setTurning(false));
      }
    } finally {
      completing = false;
      if (!handed) setTurning(false);                 // nothing to do - give the screen back
    }
  }

  // One copyable block describing what is on screen and how it got there.
  function report() {
    ensureRows();
    const page = currentPage();
    const idx = state.rowOf[page];
    const first = Math.max(0, (idx === undefined ? 0 : idx) - 3);
    const near = state.rows.slice(first, first + 7)
      .map((r, i) => (first + i === idx ? '  > ' : '    ') + '[' + r.join(', ') + ']');

    const lines = [
      'dcui2p v' + VERSION + ' report',
      '',
      'showing:   ' + describeVisible(page),
      'page:      ' + page + ' / ' + state.total +
        '   row ' + (idx === undefined ? '?' : idx + 1) + ' / ' + state.rows.length,
      'settings:  enabled=' + state.enabled + '  offset=' + state.parity +
        (state.parity === 0 ? ' (cover alone)' : ' (pairs from page 1)') +
        '  smooth=' + state.smooth + '  single=' + state.single +
        '  dim=' + Math.round(DIM_LEVELS[state.dim] * 100) + '%' +
        (state.suspended ? '  SUSPENDED(' + state.suspendedBy + ')' : ''),
      'gamepad:   ' + (state.padName || 'none connected') +
        (state.padLast ? '   last control: ' + state.padLast : ''),
      'nav:       hook=' + (state.passThrough ? 'none (reader has the keys)' : 'jump:thumbnail') +
        '  jumpWorks=' + state.jumpWorks +
        '  jumpOffset=' + state.jumpOffset + '  passThrough=' + state.passThrough,
      'manifest:  ' + state.manifestDecoded + '/' + state.manifestExpected +
        ' decoded, spreads at ' + (spreadPages().join(', ') || 'none'),
      'layout:    viewport ' + window.innerWidth + 'x' + window.innerHeight +
        '  box=' + state.boxW + 'px  left=' + (state.last.left || 0) + 'px',
      '',
      'rows around here:',
      ...near,
      '',
      'recent page changes (newest last):',
      ...state.history.slice(-20).map((h) =>
        '    ' + h.at + '  ' + (h.from || '-') + ' -> ' + h.to +
        '  via ' + h.cause + '  row ' + h.row + (h.leads ? '' : '  MID-ROW')),
    ];

    const text = lines.join('\n');
    console.log(text);
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
        console.log('%c[dcui2p] report copied to the clipboard', 'color:#0a0;font-weight:bold');
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        // Extension route: no GM API. May be refused without page focus.
        navigator.clipboard.writeText(text).then(
          () => console.log('%c[dcui2p] report copied to the clipboard', 'color:#0a0;font-weight:bold'),
          () => { /* not focused - the text is in the console above */ });
      }
    } catch (_) { /* clipboard is a convenience, not a requirement */ }
    return text;
  }

  // ----------------------------------------------------------------- styles

  const CSS = [
    'html.dcui2p-on ' + SEL.host + ' {',
    '  filter: brightness(var(--dcui2p-dim, 1));',
    '  left: var(--dcui2p-left, 0px) !important;',
    '  width: var(--dcui2p-w, 100vw) !important;',
    '  overflow: visible !important;',
    '  background: transparent !important;',
    '}',
    // The reader's container no longer covers the screen, so supply the black
    // field ourselves. z-index sits just under the reader's own 1000.
    'html.dcui2p-on #dcui2p-backdrop {',
    '  position: fixed; inset: 0; background: #000; z-index: 999; pointer-events: none;',
    '}',
    // We place the canvases deterministically rather than trusting the widget
    // to have recomputed its slide offsets for the new container width. This
    // costs the page-turn animation, which is a fair trade for never being
    // mispositioned.
    'html.dcui2p-on ' + SEL.host + ' canvas.dcui2p-left  {',
    '  transform: translateX(0) !important; left: 0 !important; opacity: 1 !important;',
    '}',
    'html.dcui2p-on ' + SEL.host + ' canvas.dcui2p-right {',
    '  transform: translateX(var(--dcui2p-w, 0px)) !important; left: 0 !important; opacity: 1 !important;',
    '}',
    'html.dcui2p-on ' + SEL.host + ' canvas.dcui2p-off   { visibility: hidden !important; }',
    // A page turn is a content swap we cannot animate, so fade over it: the
    // pages appear to change together rather than one visibly following the
    // other. The backdrop behind is already black, so this reads as a blink.
    'html.dcui2p-on.dcui2p-smooth ' + SEL.host + ' { transition: opacity ' + FADE_MS + 'ms ease; }',
    'html.dcui2p-on.dcui2p-smooth.dcui2p-turning ' + SEL.host + ' { opacity: 0 !important; }',
    // Debug view: show the hidden canvases faintly and outline every slot, so
    // it is obvious which canvas the script thinks is which.
    'html.dcui2p-debug ' + SEL.host + ' canvas.dcui2p-left  { outline: 2px solid #0f0 !important; outline-offset: -2px; }',
    'html.dcui2p-debug ' + SEL.host + ' canvas.dcui2p-right { outline: 2px solid #0ff !important; outline-offset: -2px; }',
    'html.dcui2p-debug ' + SEL.host + ' canvas.dcui2p-off   {',
    '  visibility: visible !important; opacity: 0.15 !important;',
    '  outline: 2px dashed #f44 !important; outline-offset: -2px;',
    '}',
    '#dcui2p-help {',
    '  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);',
    '  z-index: 2147483646; background: rgba(0,0,0,0.92); color: #fff;',
    '  border: 1px solid rgba(255,255,255,0.35); border-radius: 10px;',
    '  font: 15px/1.7 ui-monospace, Consolas, "Courier New", monospace;',
    '  padding: 20px 26px; white-space: pre; pointer-events: none;',
    '  box-shadow: 0 8px 40px rgba(0,0,0,0.8);',
    '}',
    '#dcui2p-hud {',
    '  position: fixed; top: 8px; left: 8px; z-index: 2147483647;',
    '  background: rgba(0,0,0,0.85); color: #0f0; border: 1px solid #0f0; border-radius: 4px;',
    '  font: 11px/1.45 ui-monospace, Consolas, "Courier New", monospace;',
    '  padding: 8px 10px; white-space: pre; pointer-events: none;',
    '  max-width: 46ch; text-shadow: 0 0 2px #000;',
    '}',
  ].join('\n');

  function installStyles() {
    if (q('#dcui2p-style')) return;
    const style = document.createElement('style');
    style.id = 'dcui2p-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function backdrop(on) {
    let el = q('#dcui2p-backdrop');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'dcui2p-backdrop';
      document.body.appendChild(el);
    } else if (!on && el) {
      el.remove();
    }
  }

  // ----------------------------------------------------------------- layout

  // Horizontal offset of a canvas within the carousel.
  //
  // Prefer the widget's own `transformX` expando, then the INLINE transform
  // (the widget's target offset, stable during a turn), and only then the
  // computed transform. The widget may write any of translateX / translate /
  // translate3d / matrix, so parse all of them - getting this wrong collapses
  // every canvas into the same slot and the spread silently becomes one page.
  function slotOf(canvas) {
    if (typeof canvas.transformX === 'number') return canvas.transformX;

    for (const source of [canvas.style.transform, getComputedStyle(canvas).transform]) {
      if (!source || source === 'none') continue;
      const translate = /translate(?:X|3d)?\(\s*(-?[\d.]+)/.exec(source);
      if (translate) return parseFloat(translate[1]);
      // matrix(a,b,c,d,tx,ty) -> 5th value; matrix3d(...) -> 13th.
      const matrix3d = /matrix3d\(((?:\s*-?[\d.e+-]+\s*,){12}\s*(-?[\d.e+-]+))/.exec(source);
      if (matrix3d) return parseFloat(matrix3d[2]);
      const matrix = /matrix\(\s*(?:[^,]+,\s*){4}(-?[\d.e+-]+)/.exec(source);
      if (matrix) return parseFloat(matrix[1]);
    }
    return 0;
  }

  // Stacking order, the other way the widget marks its slots. Observed
  // constant since the first probe: 3 = current, 2 = next, 1 = previous.
  function zOf(canvas) {
    const z = parseInt(canvas.style.zIndex || getComputedStyle(canvas).zIndex, 10);
    return isNaN(z) ? 0 : z;
  }

  // Do the canvases still sit at three different offsets? Double-clicking a
  // panel parks all of them at translate(0,0), at which point the transform
  // says nothing about which page a canvas holds.
  function slotsCollapsed(host) {
    const cs = qa('canvas', host);
    return cs.length >= 2 && new Set(cs.map(slotOf)).size < 2;
  }

  // Classify the carousel by ORDER rather than by exact offsets. Sorted left to
  // right the three canvases are always [prev, current, next], which stays
  // correct even mid-animation when none of them sits at exactly 0.
  function classify(host) {
    // ...but not when they are all at the same offset. Fall back to the
    // stacking order, which still distinguishes them. Without this the roles
    // are handed out in DOM order, which is to say at random.
    if (slotsCollapsed(host)) {
      const byZ = qa('canvas', host)
        .map((el) => ({ el: el, z: zOf(el) }))
        .sort((a, b) => b.z - a.z);
      const collapsed = new Map();
      byZ.forEach((c, i) => collapsed.set(c.el, i === 0 ? 'cur' : i === 1 ? 'next' : 'prev'));
      return collapsed;
    }

    const slots = qa('canvas', host)
      .map((el) => ({ el: el, slot: slotOf(el) }))
      .sort((a, b) => a.slot - b.slot);

    const roles = new Map();
    if (slots.length >= 3) {
      roles.set(slots[0].el, 'prev');
      roles.set(slots[1].el, 'cur');
      for (let i = 2; i < slots.length; i++) roles.set(slots[i].el, 'next');
    } else if (slots.length === 2) {
      const first = Math.abs(slots[0].slot) <= Math.abs(slots[1].slot) ? 0 : 1;
      roles.set(slots[first].el, 'cur');
      roles.set(slots[1 - first].el, first === 0 ? 'next' : 'prev');
    } else if (slots.length === 1) {
      roles.set(slots[0].el, 'cur');
    }
    return roles;
  }

  let turnWatchdog = 0;
  function setTurning(on) {
    clearTimeout(turnWatchdog);
    const want = !!on && state.smooth;
    document.documentElement.classList.toggle('dcui2p-turning', want);
    if (want) {
      // Never leave the screen faded out. A navigation that stalls - or one
      // that grinds through every fallback strategy - would otherwise show a
      // blank reader for seconds at a time.
      turnWatchdog = setTimeout(() => {
        document.documentElement.classList.remove('dcui2p-turning');
        log('fade: released by watchdog, navigation is taking too long');
      }, FADE_MAX_MS);
    }
  }

  let applying = false;

  function apply() {
    if (applying) return;
    const host = q(SEL.host);
    if (!host) return;

    // We assume a fixed pool of three canvases. If the reader ever adds or
    // drops one, the classification changes meaning and we want to know.
    const count = qa('canvas', host).length;
    if (count !== state.stats.canvases) {
      log('canvas pool: ' + state.stats.canvases + ' -> ' + count);
      state.stats.canvases = count;
    }

    // Do NOT call teardown() from here. teardown dispatches a resize to make
    // the reader redraw, that resize schedules another apply, and this branch
    // would call teardown again - unbounded mutual recursion. Teardown is
    // driven by the T hotkey and by navigation, never by the observer.
    if (!state.enabled) return;

    // Zoomed in on a panel? Stand aside until they zoom back out.
    if (readerZoomed()) { suspend('zoom'); return; }
    if (state.suspended) {
      if (state.suspendedBy !== 'zoom') return;
      state.suspended = false;
      state.suspendedBy = '';
      log('resumed: the reader is no longer zoomed');
    }

    state.tornDown = false;

    // Capture the untouched reader on the very first apply, before this
    // function modifies anything. Doing it during boot was unreliable: the
    // resize listener is bound earlier, so a resize could apply the layout
    // first and the "stock" baseline would record our own changes.
    if (!state.stock) state.stock = snapshot();

    if (!state.manifest.length) readManifest();

    // No freeze during navigation. Slots are reassigned on every change so the
    // display always shows the row the reader is on - including the page it
    // passes through mid-jump, which trails the same row and so looks
    // identical. Counted here, past the cheap early returns, so the churn
    // detector measures real layouts.
    state.stats.applies++;

    const page = currentPage();
    if (!page) return;
    ensureRows();

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const decision = pairDecision(page);

    // The box the reader will fit the page into. Capped at half the viewport
    // when pairing so two of them always fit, and at the full viewport when a
    // spread or a lone page has the screen to itself.
    const pageForAspect = decision.pair && decision.left === 'prev' ? page - 1 : page;
    let boxW = Math.round(Math.min(vh * aspectOf(pageForAspect), decision.pair ? Math.floor(vw / 2) : vw));
    const showPair = decision.pair && boxW >= MIN_BOX;
    if (decision.pair && !showPair) boxW = Math.round(Math.min(vh * aspectOf(page), vw));

    const spanW = showPair ? boxW * 2 : boxW;
    const left = Math.round((vw - spanW) / 2);

    const changed = state.last.page !== page || state.last.boxW !== boxW ||
                    state.last.showPair !== showPair;
    state.last = {
      page: page, boxW: boxW, left: left, spanW: spanW, showPair: showPair,
      why: showPair ? decision.why : (decision.pair ? 'too narrow for a pair' : decision.why),
    };
    if (changed) {
      log('layout: page ' + page + (showPair ? ' + ' + (page + 1) : '') +
          '  box=' + boxW + 'px left=' + left + 'px  (' + state.last.why + ')');
    }

    applying = true;
    try {
      const root = document.documentElement;
      root.classList.add('dcui2p-on');
      root.classList.toggle('dcui2p-debug', state.debug);
      root.classList.toggle('dcui2p-smooth', state.smooth);
      applyDim();
      root.style.setProperty('--dcui2p-w', boxW + 'px');
      root.style.setProperty('--dcui2p-left', left + 'px');
      backdrop(true);

      // Map carousel roles (prev/cur/next) onto the two visible slots. Which
      // role lands on the left depends on whether the current page leads its
      // row or trails it - see pairDecision.
      const roles = classify(host);
      const byRole = {};
      for (const [el, role] of roles) if (!byRole[role]) byRole[role] = el;

      const leftEl = showPair ? byRole[decision.left] : byRole.cur;
      const rightEl = showPair ? byRole[decision.right] : null;

      for (const canvas of qa('canvas', host)) {
        canvas.classList.toggle('dcui2p-left', canvas === leftEl);
        canvas.classList.toggle('dcui2p-right', canvas === rightEl);
        // Anything not in a slot is parked off-screen by the carousel and
        // would otherwise poke out beside the centred container.
        canvas.classList.toggle('dcui2p-off', canvas !== leftEl && canvas !== rightEl);
      }
    } finally {
      applying = false;
    }

    // Only poke the reader when the box actually changed - each resize makes
    // it rebuild and repaint all three canvases.
    if (boxW !== state.boxW) {
      log('resize: box ' + state.boxW + 'px -> ' + boxW + 'px, asking the reader to redraw');
      state.boxW = boxW;
      state.stats.resizes++;
      window.dispatchEvent(new Event('resize'));
    }

    updateHud();
  }

  // The brief requires that toggling off leaves the reader's stock behaviour
  // intact. Nothing else checks that, so snapshot the untouched reader before
  // we first modify it and diff against it after a teardown.
  function snapshot() {
    const host = q(SEL.host);
    if (!host) return null;
    const cs = getComputedStyle(host);
    return {
      width: cs.width, left: cs.left, overflow: cs.overflow, background: cs.backgroundColor,
      canvasCount: qa('canvas', host).length,
      canvasSizes: qa('canvas', host).map((c) => c.width + 'x' + c.height).sort().join(','),
      canvasClasses: qa('canvas', host).map((c) => c.className).join('|'),
      rootClass: document.documentElement.className,
      backdrop: !!q('#dcui2p-backdrop'),
    };
  }

  // Compare geometry against what stock *would be now* rather than against
  // the snapshot's raw numbers: the window may have been resized since, and a
  // container that correctly fills a resized viewport is not a failure to
  // restore. Only the structural leftovers are compared literally.
  function verifyRestore() {
    const host = q(SEL.host);
    if (!host) return log('restore check: reader is gone');

    const cs = getComputedStyle(host);
    const px = (v) => Math.round(parseFloat(v) || 0);
    const dpr = window.devicePixelRatio || 1;
    const diffs = [];

    if (Math.abs(px(cs.width) - window.innerWidth) > 2) {
      diffs.push('container is ' + cs.width + ', expected the full viewport (' + window.innerWidth + 'px)');
    }
    if (px(cs.left) !== 0) diffs.push('container left is ' + cs.left + ', expected 0');
    if (state.stock && cs.overflow !== state.stock.overflow) {
      diffs.push('overflow is ' + cs.overflow + ', was ' + state.stock.overflow);
    }
    if (/dcui2p/.test(document.documentElement.className)) {
      diffs.push('root still carries our classes: ' + document.documentElement.className);
    }
    if (q('#dcui2p-backdrop')) diffs.push('our backdrop is still in the DOM');

    const canvases = qa('canvas', host);
    const tagged = canvases.filter((c) => /dcui2p/.test(c.className));   // left/right/off
    if (tagged.length) diffs.push(tagged.length + ' canvas(es) still carry our classes');
    const styled = canvases.filter((c) => c.style.transform && /!important/.test(c.getAttribute('style') || ''));
    if (styled.length) diffs.push(styled.length + ' canvas(es) still have forced transforms');

    const widths = [...new Set(canvases.map((c) => c.width))];
    const expected = Math.round(window.innerWidth * dpr);
    if (widths.length !== 1 || Math.abs(widths[0] - expected) > 4) {
      diffs.push('canvas buffers are ' + widths.join('/') + 'px wide, expected ~' + expected +
                 ' (the reader may not have redrawn yet)');
    }

    if (!diffs.length) log('restore check: OK, the reader is back to stock');
    else warn('restore check: ' + diffs.length + ' issue(s) - ' + diffs.join('; '));
    return diffs;
  }

  function teardown() {
    // Idempotent: the resize we dispatch below makes the reader redraw, which
    // the observer sees, so without this a single T press can re-enter here.
    if (state.tornDown) return;
    state.tornDown = true;
    applying = true;
    try {
      const root = document.documentElement;
      root.classList.remove('dcui2p-on', 'dcui2p-debug', 'dcui2p-smooth', 'dcui2p-turning');
      root.style.removeProperty('--dcui2p-w');
      root.style.removeProperty('--dcui2p-left');
      root.style.removeProperty('--dcui2p-dim');
      backdrop(false);
      toggleHelp(false);
      for (const canvas of qa('canvas', q(SEL.host) || document)) {
        canvas.classList.remove('dcui2p-left', 'dcui2p-right', 'dcui2p-off');
      }
    } finally {
      applying = false;
    }
    state.boxW = 0;
    state.last = {};
    // Let the reader measure its restored full-width container and redraw.
    window.dispatchEvent(new Event('resize'));
    updateHud();
    // Give the reader a moment to finish redrawing before judging it.
    setTimeout(verifyRestore, 700);
  }

  // ------------------------------------------------------------- navigation

  // Every plausible way to ask the reader to turn a page, in preference order.
  // We do not know which one the widget honours, so `navOnce` tries them until
  // the page counter moves, then remembers the winner.

  function keyEventInit(dir, type) {
    const key = dir > 0 ? 'ArrowRight' : 'ArrowLeft';
    const code = dir > 0 ? 39 : 37;
    return [type, {
      key: key, code: key, keyCode: code, which: code,
      bubbles: true, cancelable: true, composed: true,
    }];
  }

  // keydown ONLY. The reader navigates on keyup as well, so sending both turned
  // one dispatch into two page turns - and because the poller sometimes caught
  // the intermediate page, we would dispatch again and overshoot by one. That
  // stray turn arrived after we had declared success, so it looked like the
  // reader moving on its own.
  function dispatchKey(target, dir) {
    if (!target) return;
    const [type, init] = keyEventInit(dir, 'keydown');
    target.dispatchEvent(makeEvent(KeyboardEvent, type, init));
  }

  function edgePoint(dir) {
    const host = q(SEL.host);
    const rect = host ? host.getBoundingClientRect() : { top: 0, height: window.innerHeight };
    const y = Math.round(rect.top + rect.height / 2);
    // Aim outside our narrowed container but still over the reader surface.
    const x = dir > 0 ? Math.round(window.innerWidth * 0.92) : Math.round(window.innerWidth * 0.08);
    return { x: x, y: y };
  }

  function dispatchClick(dir) {
    const p = edgePoint(dir);
    const target = document.elementFromPoint(p.x, p.y) || document.body;
    const init = { bubbles: true, cancelable: true, composed: true,
                   clientX: p.x, clientY: p.y, button: 0, buttons: 1 };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const pointer = type.startsWith('pointer');
      if (pointer && typeof PointerEvent === 'undefined') continue;
      target.dispatchEvent(makeEvent(pointer ? PointerEvent : MouseEvent, type, pointer
        ? Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)
        : init));
    }
    return target;
  }

  async function dispatchSwipe(dir) {
    const host = q(SEL.host) || document.body;
    const rect = host.getBoundingClientRect();
    const y = Math.round(rect.top + rect.height / 2);
    const from = dir > 0 ? Math.round(window.innerWidth * 0.75) : Math.round(window.innerWidth * 0.25);
    const to = dir > 0 ? Math.round(window.innerWidth * 0.20) : Math.round(window.innerWidth * 0.80);
    const target = document.elementFromPoint(from, y) || host;

    const touch = (x) => new Touch({ identifier: 1, target: target, clientX: x, clientY: y,
                                     pageX: x, pageY: y, screenX: x, screenY: y });
    const fire = (type, x) => {
      if (typeof Touch === 'undefined' || typeof TouchEvent === 'undefined') return;
      const t = [touch(x)];
      target.dispatchEvent(makeEvent(TouchEvent, type, {
        bubbles: true, cancelable: true, composed: true,
        touches: type === 'touchend' ? [] : t, targetTouches: type === 'touchend' ? [] : t,
        changedTouches: t,
      }));
    };
    fire('touchstart', from);
    for (let i = 1; i <= 5; i++) { fire('touchmove', Math.round(from + (to - from) * i / 5)); await sleep(16); }
    fire('touchend', to);
  }

  const STRATEGIES = [
    { name: 'key:focused', run: (dir) => dispatchKey(document.activeElement || document.body, dir) },
    { name: 'key:document', run: (dir) => dispatchKey(document, dir) },
    { name: 'key:window', run: (dir) => dispatchKey(window, dir) },
    { name: 'key:reader', run: (dir) => dispatchKey(q(SEL.host) || document.body, dir) },
    { name: 'click:edge', run: (dir) => dispatchClick(dir) },
    { name: 'touch:swipe', run: (dir) => dispatchSwipe(dir) },
  ];

  // Wait for a specific page. Needed for jumps: the reader animates through
  // the pages in between, so watching for "the counter changed" reports a page
  // it merely passed through and makes a working jump look like a failure.
  function waitForCounter(target, timeout) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (currentPage() === target) return resolve(true);
        if (Date.now() - started > timeout) return resolve(false);
        setTimeout(tick, 30);
      };
      tick();
    });
  }

  // Wait until the page counter stops moving, and report where it came to
  // rest. Watching for a particular page is not enough: the reader animates
  // through the pages in between, so we would call a move finished while it
  // is still travelling, and whatever it did next would look like the reader
  // acting on its own. Settling is the only honest signal.
  function settledPage(timeout = NAV_TIMEOUT, quiet = SETTLE_QUIET) {
    return new Promise((resolve) => {
      const started = Date.now();
      let last = currentPage();
      let stableSince = Date.now();
      const tick = () => {
        const now = currentPage();
        if (now && now !== last) { last = now; stableSince = Date.now(); }
        if (Date.now() - stableSince >= quiet) return resolve(last);
        if (Date.now() - started > timeout) return resolve(last);
        setTimeout(tick, 30);
      };
      setTimeout(tick, 30);
    });
  }

  function waitForPageChange(from, timeout = NAV_TIMEOUT) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const now = currentPage();
        if (now && now !== from) return resolve({ page: now, ms: Date.now() - started });
        if (Date.now() - started > timeout) return resolve(null);
        setTimeout(tick, 30);
      };
      setTimeout(tick, 30);
    });
  }

  // Turn one page. Tries the remembered hook first, then the rest.
  async function navOnce(dir) {
    const before = currentPage();
    const ordered = state.navStrategy
      ? STRATEGIES.slice().sort((a, b) => (b.name === state.navStrategy) - (a.name === state.navStrategy))
      : STRATEGIES;

    for (const strategy of ordered) {
      log('nav: trying ' + strategy.name + ' (' + (dir > 0 ? 'forward' : 'back') + ') from page ' + before);
      try {
        await strategy.run(dir);
      } catch (e) {
        warn('nav: ' + strategy.name + ' threw ' + e.message);
        continue;
      }
      const result = await waitForPageChange(before, state.navStrategy === strategy.name ? NAV_TIMEOUT : PROBE_TIMEOUT);
      if (result) {
        if (state.navStrategy !== strategy.name) {
          state.navStrategy = strategy.name;
          store.set('navStrategy', strategy.name);
          log('nav: ' + strategy.name + ' WORKS - remembering it');
        }
        // Report where it came to REST, not the first page it moved to. If
        // something else also turned a page - the reader reacting to the same
        // keypress, say - the caller needs to know the true position, or it
        // will dispatch again and overshoot.
        const settled = await settledPage(NAV_TIMEOUT + SETTLE_QUIET);

        // Adopt a strategy only if it moved the way we asked. click:edge and
        // touch:swipe can navigate backwards when asked to go forwards, and
        // remembering one of those makes every later move wrong.
        const moved = settled - before;
        if ((dir > 0 && moved <= 0) || (dir < 0 && moved >= 0)) {
          warn('nav: ' + strategy.name + ' moved the WRONG WAY (' + before + ' -> ' + settled +
               ', asked to go ' + (dir > 0 ? 'forward' : 'back') + ') - not adopting it');
          if (state.navStrategy === strategy.name) {
            state.navStrategy = null;
            store.set('navStrategy', null);
          }
          return settled;
        }

        if (settled !== result.page) {
          log('nav: page ' + before + ' -> ' + result.page + ' -> settled at ' + settled +
              ' (more than one turn happened)');
        } else {
          log('nav: page ' + before + ' -> ' + settled + ' in ' + result.ms + 'ms');
        }
        return settled;
      }
      log('nav: ' + strategy.name + ' did nothing');
    }

    // Intercepting the arrow keys while having no way to navigate ourselves
    // leaves the reader unable to turn a page at all, which is far worse than
    // pairing being imperfect. Hand the keys back; the layout still works,
    // you just move one page per press.
    state.passThrough = true;
    warn('no navigation hook worked - handing the arrow keys back to the reader. ' +
         'Pages will turn one at a time. Run dcui2p.probeNav() for detail, then ' +
         'dcui2p.state.passThrough = false to try again.');
    return 0;
  }

  // Jumping straight to a page is the real smoothness fix: a pair advance
  // becomes ONE transition instead of two, so both pages change together
  // instead of the reader visibly shuffling through the page between them.
  //
  // The page-browser thumbnails sit in the DOM even while the modal is closed,
  // and their click handlers are bound regardless of visibility - so a click
  // dispatched straight at the target page's thumbnail navigates without the
  // modal ever being shown.
  function thumbFor(page) {
    for (const img of qa(SEL.thumbs)) {
      const m = /Page\s+(\d+)/i.exec(img.alt || '');
      if (m && +m[1] === page) return img;
    }
    return null;
  }

  async function jumpToPage(target) {
    if (state.jumpWorks === false) return 0;

    // A clean probe shows the thumbnails are accurate: clicking alt="Page 96"
    // lands on 96. The offset below therefore stays 0 in practice. It is kept
    // as a safety net - if a click ever lands somewhere other than asked, the
    // difference is measured and applied for the rest of the session - because
    // it costs nothing and an index shift on DCUI's side would otherwise break
    // navigation outright.
    const wanted = target - state.jumpOffset;
    const img = thumbFor(wanted);
    if (!img) return 0;

    // The clickable element may be the image or a wrapper around it.
    const candidates = [img, img.closest('button'), img.closest('[role=button]'),
                        img.parentElement, img.parentElement && img.parentElement.parentElement]
      .filter((el, i, all) => el && all.indexOf(el) === i);

    for (const el of candidates) {
      const before = currentPage();
      el.dispatchEvent(makeEvent(MouseEvent, 'click',
        { bubbles: true, cancelable: true, composed: true, button: 0 }));
      // The reader animates page by page, so first wait for the counter to
      // reach the target, then fade while its neighbour canvas is redrawn -
      // that redraw is the only moment the display can show a stale page.
      // If the counter overshoots (a miscalibrated offset), the settle after
      // arrival catches it and we fall through to recalibrate.
      let landed = null;
      if (await waitForCounter(target, JUMP_TIMEOUT)) {
        if (state.smooth) setTurning(true);
        const rest = await settledPage(FADE_MAX_MS, ARRIVAL_QUIET);
        if (rest === target) landed = { page: target };
      }

      if (!landed) {
        const now = await settledPage(JUMP_TIMEOUT, SETTLE_QUIET);
        if (now !== before) {
          // It navigated, just not where we asked. Calibrate against the
          // thumbnail we actually clicked and let the caller correct this one.
          const offset = now - wanted;
          if (Math.abs(offset) > 3) {
            state.jumpWorks = false;
            warn('jump: clicking the page-' + wanted + ' thumbnail landed on ' + now +
                 ' - too far off to trust, stepping from now on');
          } else if (offset !== state.jumpOffset) {
            state.jumpOffset = offset;
            store.set('jumpOffset', offset);
            log('jump: calibrated - clicking the page-' + wanted + ' thumbnail lands on ' + now +
                ', so thumbnails run ' + (offset > 0 ? '+' : '') + offset + ' from their alt text');
          } else {
            warn('jump: click moved to ' + now + ', wanted ' + target + ' (offset ' + offset + ' did not hold)');
          }
          return now;
        }
        continue;     // nothing happened - try the next candidate element
      }

      if (state.jumpWorks !== true) {
        state.jumpWorks = true;
        store.set('jumpWorks', true);
        log('jump: clicking a page thumbnail works - one move per turn');
      }
      // A click might also have opened the browser modal; close it if so.
      const modal = q('.reader-modal__page-browser');
      if (modal && modal.getBoundingClientRect().width > 0) {
        document.body.dispatchEvent(makeEvent(KeyboardEvent, 'keydown',
          { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        log('jump: closed the page browser it opened');
      }
      log('jump: reached page ' + target);
      return target;
    }

    state.jumpWorks = false;
    log('jump: thumbnails are not clickable, stepping instead');
    return 0;
  }

  // Walk to the page the row model says an arrow press should land on. Prefer
  // a single jump; fall back to stepping one page at a time, driven by the
  // target rather than a step count so it stays correct across spreads and
  // when starting mid-row.
  async function goToPage(target, why) {
    let page = currentPage();
    if (!page || page === target) return page;

    state.navReason = (why || 'goto') + ' to ' + target;
    log((why || 'goto') + ': page ' + page + ' -> ' + target);

    // The thumbnail jump is the ONLY synthetic input this reader honours
    // (probeNav: every keyboard, mouse and touch strategy does nothing - the
    // canvas widget ignores them; the thumbnail's click handler is Vue's and
    // does not care). So there is no stepping fallback: if the jump fails
    // there is nothing else to try, and the arrow keys go back to the reader.
    if (state.jumpWorks === false) {
      state.passThrough = true;
      warn('cannot navigate: the thumbnail jump failed earlier this session. Run dcui2p.probeNav().');
      return page;
    }

    // Fade out before moving and stay dark until the destination has landed.
    // The display is already correct at every intermediate state, so this is
    // purely cosmetic - but a single fade reads as a page turn, where content
    // swapping in place reads as a glitch.
    if (state.smooth) { setTurning(true); await sleep(FADE_MS); }

    const before = page;
    const offsetBefore = state.jumpOffset;
    let landed = await jumpToPage(target);
    if (landed === target) return target;

    // A miss that changed the calibration is worth exactly one more try: the
    // new offset should land it, and the screen is still faded out.
    if (landed && state.jumpOffset !== offsetBefore) {
      log('jump: retrying once with offset ' + state.jumpOffset);
      landed = await jumpToPage(target);
      if (landed === target) return target;
    }

    page = currentPage();
    if (page === target) return page;
    if (page === before) {
      // Nothing moved at all. Do not keep swallowing arrow keys.
      state.passThrough = true;
      warn('jump did nothing - handing the arrow keys back to the reader for this session');
    } else {
      warn('stopped at page ' + page + ', wanted ' + target + ' (the display still shows the right row)');
    }
    return page;
  }

  async function step(dir) {
    if (state.navigating) return;
    state.navigating = true;
    try {
      const start = currentPage();
      if (!start) return;
      const target = targetPage(start, dir);
      if (target === start) {
        log('step: already at the ' + (dir > 0 ? 'last' : 'first') + ' row');
        return;
      }
      await goToPage(target, 'step ' + (dir > 0 ? 'forward' : 'back'));
      // No correction pass: a jump lands exactly once calibrated, and even if
      // it did not, a page that trails its row is displayed as that row.
    } finally {
      state.navigating = false;
      apply();
      // Next frame, so the reveal happens after the new layout is painted.
      requestAnimationFrame(() => setTurning(false));
    }
  }

  // Console helper: try every strategy in turn and report which moved the page.
  // Restores the starting page afterwards where it can.
  async function probeNav() {
    const results = [];
    const startPage = currentPage();
    console.log('%c[dcui2p] probing navigation from page ' + startPage, 'color:#0a0;font-weight:bold');

    for (const strategy of STRATEGIES) {
      const before = currentPage();
      let error = null;
      try { await strategy.run(1); } catch (e) { error = e.message; }
      const result = error ? null : await waitForPageChange(before, PROBE_TIMEOUT);
      results.push({ strategy: strategy.name, worked: !!result,
                     moved: result ? before + ' -> ' + result.page : '-',
                     ms: result ? result.ms : '-', error: error || '' });
      if (result) {
        // Put the page back so the probe is non-destructive.
        const back = currentPage();
        try { await strategy.run(-1); } catch (_) {}
        await waitForPageChange(back, PROBE_TIMEOUT);
      }
      await sleep(150);
    }

    // The thumbnail jump is not a direction-based strategy, so it needs its
    // own test - and it was never covered by this probe before.
    const from = currentPage();
    const jumpTarget = (state.total && from + 2 <= state.total) ? from + 2 : from - 2;
    if (jumpTarget >= 1) {
      state.jumpWorks = null;
      let landed = 0;
      try { landed = await jumpToPage(jumpTarget); } catch (e) { /* reported below */ }
      const now = currentPage();
      results.push({ strategy: 'jump:thumbnail', worked: now !== from,
                     moved: now === from ? '-' : from + ' -> ' + now, ms: '-',
                     error: now !== from && landed !== jumpTarget ? 'moved, but not to ' + jumpTarget : '' });
      if (now !== from) { try { await jumpToPage(from); } catch (_) {} }
    }

    console.table(results);
    const winner = results.find((r) => r.worked);
    if (winner) {
      state.passThrough = false;
      console.log('%c[dcui2p] a hook works - resuming paired navigation', 'color:#0a0;font-weight:bold');
    } else {
      state.passThrough = true;
      console.log('%c[dcui2p] nothing works - the arrow keys stay with the reader, ' +
                  'one page per press. Pairing still works.', 'color:#0a0;font-weight:bold');
    }
    if (winner && winner.strategy !== 'jump:thumbnail') {
      state.navStrategy = winner.strategy;
      store.set('navStrategy', winner.strategy);
      console.log('%c[dcui2p] using ' + winner.strategy, 'color:#0a0;font-weight:bold');
    }
    if (currentPage() !== startPage) console.warn('[dcui2p] ended on page ' + currentPage() + ', started on ' + startPage);
    return results;
  }

  // ------------------------------------------------------------------ swipes
  //
  // A mouse drag or touch swipe is handled by the reader itself, which turns
  // ONE page - half a move in a two-page layout, and from the left-hand page
  // of a pair it looks like nothing happened at all.
  //
  // We do not fight the reader for the gesture. Its drag handling cannot be
  // driven or reliably suppressed from outside, and swallowing its events
  // would also swallow the clicks that reveal its controls. Instead we watch
  // the same gesture, let the reader do whatever it does with it - turn a page
  // or not - and then complete the move: jump to the row the swipe was asking
  // for, measured from the page the swipe STARTED on. That is correct whether
  // the reader turned one page or none.
  let gesture = null;

  function onPointerDown(e) {
    // A previous gesture that never got its pointerup (pointer left the
    // window, say) must not leave the screen faded out.
    if (gesture && gesture.armed) setTurning(false);
    gesture = null;
    if (!e.isTrusted || e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!state.enabled || !onReaderPage()) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest(SEL.outer)) return;
    // Buttons, links and open modals (settings, the page browser) keep their
    // own gestures - scrolling the thumbnail grid must not turn the page.
    if (t.closest('button, a, input, select, textarea, .reader-modal')) return;
    gesture = { x: e.clientX, y: e.clientY, at: Date.now(), page: currentPage(),
                id: e.pointerId, armed: false };
  }

  // Fade out mid-drag, as soon as the gesture is clearly a horizontal swipe,
  // rather than waiting for the release. The reader reacts to a drag while it
  // is still happening, and a canvas reader draws that reaction INTO the
  // bitmap - pages sliding under the pointer - which no amount of CSS pinning
  // can hold still. Covering the gesture from here is the only way to hide it.
  //
  // Armed slightly before the swipe threshold so the fade is complete by the
  // time the reader commits. If the drag then turns out not to be a swipe, the
  // fade is released on the spot.
  function onPointerMove(e) {
    const g = gesture;
    if (!g || !e.isTrusted || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const swiping = Math.abs(dx) >= SWIPE_ARM_PX &&
                    Math.abs(dx) >= SWIPE_RATIO * Math.abs(dy) &&
                    Date.now() - g.at <= SWIPE_MAX_MS;
    if (swiping) {
      g.armed = true;
      // Re-arming on each move also keeps the fade watchdog from releasing
      // the screen part-way through a long drag.
      if (state.smooth) setTurning(true);
    } else if (g.armed) {
      g.armed = false;
      setTurning(false);
    }
  }

  function onPointerUp(e) {
    const g = gesture;
    gesture = null;
    if (!g || !e.isTrusted || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const ms = Date.now() - g.at;
    const isSwipe = Math.abs(dx) >= SWIPE_MIN_PX &&
                    Math.abs(dx) >= SWIPE_RATIO * Math.abs(dy) &&
                    ms <= SWIPE_MAX_MS;
    if (!isSwipe) {
      if (g.armed) setTurning(false);
      return;
    }
    // Swiping left pulls the next page in, as in the stock reader.
    completeSwipe(dx < 0 ? 1 : -1, g.page,
      { dx: Math.round(dx), dy: Math.round(dy), ms: ms, type: e.pointerType, armed: g.armed });
  }

  function onPointerCancel() {
    if (gesture && gesture.armed) setTurning(false);
    gesture = null;
  }

  async function completeSwipe(dir, startPage, info) {
    if (!startPage || state.navigating || state.passThrough || state.jumpWorks === false) return;
    const target = targetPage(startPage, dir);
    if (!target || target === startPage) return;
    if (!thumbFor(target - state.jumpOffset)) return;      // nothing to click yet

    state.navigating = true;
    state.navReason = 'swipe ' + (dir > 0 ? 'forward' : 'back') + ' to ' + target;
    const darkFrom = Date.now() - (info.armed ? info.ms : 0);
    try {
      if (state.smooth) setTurning(true);

      // Let the reader finish its own reaction first. A jump issued while it
      // is mid-turn gets that turn added on top and lands one page out - the
      // same failure as the leaked keyup.
      const own = await waitForPageChange(startPage, 650);
      const rested = own ? await settledPage(900, 180) : startPage;
      log('swipe: ' + info.type + ' dx=' + info.dx + ' dy=' + info.dy + ' ' + info.ms + 'ms -> ' +
          (dir > 0 ? 'forward' : 'back') + '; reader ' +
          (own ? 'turned ' + startPage + ' -> ' + rested : 'did not turn') + '; target ' + target);

      await goToPage(target, 'swipe ' + (dir > 0 ? 'forward' : 'back'));
      // The fade covers the drag as well as the move, so this is the whole
      // time the screen is dark - the number to tune SWIPE_ARM_PX against.
      if (state.smooth) log('swipe: screen dark for ' + (Date.now() - darkFrom) + 'ms');
    } finally {
      state.navigating = false;
      apply();
      requestAnimationFrame(() => setTurning(false));
    }
  }

  // --------------------------------------------------------------- view modes

  function applyDim() {
    document.documentElement.style.setProperty('--dcui2p-dim', DIM_LEVELS[state.dim]);
  }

  function cycleDim() {
    state.dim = (state.dim + 1) % DIM_LEVELS.length;
    store.set('dim', state.dim);
    applyDim();
    log('dim: ' + Math.round(DIM_LEVELS[state.dim] * 100) + '%');
    updateHud();
  }

  function toggleSingle() {
    state.single = !state.single;
    store.set('single', state.single);
    log('single page ' + (state.single ? 'ON - one page at a time' : 'OFF - back to spreads'));
    apply();
  }

  function helpText() {
    const pct = Math.round(DIM_LEVELS[state.dim] * 100) + '%';
    return [
      'DCUI Two-Page View  v' + VERSION,
      '',
      '  \u2190  \u2192      previous / next spread',
      '  drag       swipe left or right',
      '',
      '  Z          one page at a time      ' + (state.single ? '[on]' : '[off]'),
      '  B          dim the screen          [' + pct + ']',
      '  P          pairing offset          ' + (state.parity ? '[from page 1]' : '[cover alone]'),
      '  S          fade between pages      ' + (state.smooth ? '[on]' : '[off]'),
      '  T          turn the script off',
      '  H          this card',
      '  D          debug overlay',
      '',
      '  controller',
      '    triggers, bumpers, d-pad, stick   spreads',
      '    X  dim      Y  one page      Menu  this card',
    ].join('\n');
  }

  let helpTimer = 0;

  function toggleHelp(force) {
    const want = force === undefined ? !q('#dcui2p-help') : !!force;
    clearTimeout(helpTimer);
    let el = q('#dcui2p-help');
    if (!want) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'dcui2p-help';
      document.body.appendChild(el);
    }
    el.textContent = helpText();
    // It is a reminder, not a panel - it should not sit on the comic.
    helpTimer = setTimeout(() => toggleHelp(false), HELP_SECONDS * 1000);
  }

  // Stand aside without switching off: restore the reader to its own full
  // width, keep every listener, and pick the layout back up on resume. Zoom
  // needs this - a spread of two half-width pages is no use once someone is
  // reading one panel, and our pinned transforms would fight a reader that
  // zooms by scaling them.
  function suspend(why) {
    if (state.suspended) return;
    state.suspended = true;
    state.suspendedBy = why;
    log('suspended (' + why + ') - the reader has its full width back');
    teardown();
    updateHud();
  }

  function resume() {
    if (!state.suspended) return;
    log('resumed after ' + state.suspendedBy);
    state.suspended = false;
    state.suspendedBy = '';
    apply();
  }

  // Is the reader zoomed into a panel?
  //
  // UNCONFIRMED. The reader's zoom mechanism has not been observed, so this
  // watches for the one form we would actively break: a scale on the canvas's
  // own transform, which our !important rule overrides. A reader that zooms by
  // redrawing the canvas at a larger scale would not show up here and needs a
  // different signal - see FINDINGS.md.
  function readerZoomed() {
    const host = q(SEL.host);
    if (!host) return false;
    for (const canvas of qa('canvas', host)) {
      const t = canvas.style.transform || '';
      const scale = /scale[XY]?\(\s*(-?[\d.]+)/.exec(t);
      if (scale && Math.abs(parseFloat(scale[1]) - 1) > 0.01) return true;
      const matrix = /matrix\(\s*(-?[\d.]+)/.exec(t);
      if (matrix && Math.abs(parseFloat(matrix[1]) - 1) > 0.01) return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- gamepad
  //
  // Streaming a controller in (Moonlight/Sunshine, Steam Link) delivers a real
  // XInput device to the host, so Chrome exposes it through the Gamepad API.
  // The reader itself does not read gamepads - but whatever maps the pad into
  // the stream may also be sending a keystroke or click that the reader DOES
  // react to, turning a single page underneath us.
  //
  // So this does not assume it is the only thing navigating. Exactly as with a
  // swipe: note the page the press started from, let anything else finish,
  // then complete the move to that row. Correct whether the controller also
  // turned a page or not, and `state.navigating` keeps the two from racing
  // when the pad is mapped to a real arrow key we already handle.
  let padLoop = 0;
  const padHeld = new Set();

  function readPads() {
    padLoop = 0;
    if (!state.gamepad) return;
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    let connected = 0;

    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      connected++;
      state.padName = pad.id || 'gamepad ' + pad.index;

      const buttons = pad.buttons || [];
      for (let i = 0; i < buttons.length; i++) {
        const b = buttons[i];
        const down = typeof b === 'object' ? (b.pressed || b.value > PAD_ANALOG) : b > PAD_ANALOG;
        const id = pad.index + ':b' + i;
        if (down && !padHeld.has(id)) {
          padHeld.add(id);
          state.padLast = 'button ' + i;
          if (i === PAD_DIM) cycleDim();
          else if (i === PAD_SINGLE) toggleSingle();
          else if (i === PAD_HELP) toggleHelp();
          else padNavigate(PAD_NEXT.indexOf(i) >= 0 ? 1 : PAD_PREV.indexOf(i) >= 0 ? -1 : 0);
        } else if (!down) {
          padHeld.delete(id);          // must be released before it fires again
        }
      }

      // Left stick, horizontal. Treated as a press rather than a repeat.
      const ax = (pad.axes && pad.axes[0]) || 0;
      const id = pad.index + ':ax0';
      if (Math.abs(ax) >= PAD_AXIS) {
        if (!padHeld.has(id)) {
          padHeld.add(id);
          state.padLast = 'stick ' + ax.toFixed(2);
          padNavigate(ax > 0 ? 1 : -1);
        }
      } else {
        padHeld.delete(id);
      }
    }

    if (connected) padLoop = requestAnimationFrame(readPads);
    else { state.padName = ''; padHeld.clear(); }
  }

  function startPadLoop() {
    if (!padLoop) padLoop = requestAnimationFrame(readPads);
  }

  async function padNavigate(dir) {
    if (!dir || !state.enabled || !onReaderPage()) return;
    if (state.navigating || state.passThrough || state.jumpWorks === false) return;

    const startPage = currentPage();
    const target = startPage ? targetPage(startPage, dir) : 0;
    if (!target || target === startPage) return;
    if (!thumbFor(target - state.jumpOffset)) return;

    state.navigating = true;
    state.navReason = 'gamepad ' + (dir > 0 ? 'forward' : 'back') + ' to ' + target;
    try {
      if (state.smooth) setTurning(true);
      // Whatever else the controller is mapped to may turn a page by itself.
      // Let that land first - a jump issued mid-turn gets the turn added on
      // top and finishes one page out.
      const own = await waitForPageChange(startPage, 500);
      if (own) await settledPage(900, 180);
      log('gamepad: ' + state.padLast + ' -> ' + (dir > 0 ? 'forward' : 'back') +
          '; the stream ' + (own ? 'also turned a page' : 'turned nothing') + '; target ' + target);
      await goToPage(target, 'gamepad ' + (dir > 0 ? 'forward' : 'back'));
    } finally {
      state.navigating = false;
      apply();
      requestAnimationFrame(() => setTurning(false));
    }
  }

  // ---------------------------------------------------------------- hotkeys

  function toggleDebug() {
    state.debug = !state.debug;
    store.set('debug', state.debug);
    document.documentElement.classList.toggle('dcui2p-debug', state.debug && state.enabled);
    console.log('%c[dcui2p] debug ' + (state.debug ? 'ON' : 'OFF'), 'color:#0a0;font-weight:bold');
    // Replay what happened before debug was switched on - startup and
    // manifest reading are over by the time anyone asks for it.
    if (state.debug && logLines.length) {
      console.groupCollapsed('%c[dcui2p] earlier events (' + logLines.length + ')', 'color:#0a0');
      logLines.forEach((line) => console.log(line));
      console.groupEnd();
      console.log('%c[dcui2p]%c state:', 'color:#0a0;font-weight:bold', 'color:inherit', {
        page: currentPage(), total: state.total, rows: state.rows.length,
        spreads: spreadPages(), navHook: state.navStrategy, boxW: state.boxW,
        parity: state.parity, manifestPages: state.manifest.filter(Boolean).length,
      });
    }
    updateHud();
  }

  // A tablet has no D key and no console, so without this there is no way to
  // find out why something is not working there. Three quick taps in the
  // top-left corner toggle the HUD. pointerup covers touch, pen and mouse
  // with one event per tap, so it can be tried on a desktop too.
  let cornerTaps = [];
  function onCornerTap(e) {
    if (!e.isTrusted || !onReaderPage()) return;
    if (e.clientX > 96 || e.clientY > 96) { cornerTaps = []; return; }
    const now = Date.now();
    cornerTaps = cornerTaps.filter((t) => now - t < 900).concat(now);
    if (cornerTaps.length >= 3) {
      cornerTaps = [];
      toggleDebug();
    }
  }

  function isTyping(el) {
    return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  }

  function onKeyDown(e) {
    // Synthetic events are ours (isTrusted === false); never re-handle them.
    if (!e.isTrusted || e.altKey || e.ctrlKey || e.metaKey) return;
    if (isTyping(e.target)) return;
    if (!onReaderPage()) return;

    const key = (e.key || '').toLowerCase();

    // Our hotkeys are ours: keep them from reaching the reader, which may bind
    // the same letters to its own controls.
    if ('dtpsbzh'.indexOf(key) >= 0 && key.length === 1) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    if (key === 'd') {
      toggleDebug();
      return;
    }

    if (key === 't') {
      state.enabled = !state.enabled;
      store.set('enabled', state.enabled);
      log('toggle: ' + (state.enabled ? 'enabled' : 'disabled (reader restored to stock)'));
      if (state.enabled) apply(); else teardown();
      return;
    }

    if (!state.enabled) return;

    if (key === 's') {
      state.smooth = !state.smooth;
      store.set('smooth', state.smooth);
      if (!state.smooth) setTurning(false);
      log('smooth: fade across page turns ' + (state.smooth ? 'ON' : 'OFF'));
      apply();
      return;
    }

    if (key === 'b') { cycleDim(); return; }
    if (key === 'z') { toggleSingle(); return; }
    if (key === 'h') { toggleHelp(); return; }

    if (key === 'p') {
      state.parity = state.parity ? 0 : 1;
      store.set('parity', state.parity);
      buildRows();
      log('parity: offset ' + state.parity + ' (' + (state.parity ? 'pairs from page 1' : 'cover alone, then pairs') + ')');
      apply();
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // Only take the key if we can actually move the reader ourselves;
      // otherwise the reader's one-page turn is the only navigation there is.
      if (state.passThrough || state.jumpWorks === false) return;

      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const page = currentPage();
      const target = page ? targetPage(page, dir) : 0;

      if (!target || target === page) return;

      // If the page browser has not rendered its thumbnails yet there is
      // nothing to click, so do not take the key - let the reader turn the
      // page rather than swallow a press we cannot act on.
      if (!thumbFor(target - state.jumpOffset)) return;

      // Stop the reader acting on this keypress; one press moves a whole row.
      // Remember the key so its keyup is swallowed too - see onKeyUpOrPress.
      swallowed.add(e.code || e.key);
      e.preventDefault();
      e.stopImmediatePropagation();
      step(dir);
    }
  }

  // The reader turns a page on keyup as well as keydown. Blocking only the
  // keydown therefore leaked one reader turn per press, in the direction of
  // the key, on top of our own jump - every move came to rest one page past
  // its target, and the calibration chased a moving offset. A key we took on
  // the way down must be taken on the way up.
  const swallowed = new Set();

  function onKeyUpOrPress(e) {
    if (!e.isTrusted) return;
    const k = e.code || e.key;
    if (!swallowed.has(k)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keyup') swallowed.delete(k);
  }

  // ------------------------------------------------------------------- boot

  let pending = 0;
  function schedule() {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; apply(); });
  }

  function watch() {
    const outer = q(SEL.outer);
    if (!outer) return false;

    // The reader rewrites inline transforms on every turn, recycles canvases,
    // and rewrites the page counter. One observer over the whole reader
    // catches all of it; `applying` keeps our own writes from re-triggering.
    const observer = new MutationObserver((records) => {
      state.stats.mutations += records.length;
      trackPage();
      if (!applying) schedule();
    });
    observer.observe(outer.parentElement || outer, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['style', 'class'],
    });
    log('observer attached');
    return true;
  }

  function init() {
    state.enabled = store.get('enabled', true);
    state.parity = store.get('parity', 0);
    state.debug = store.get('debug', false);
    state.navStrategy = store.get('navStrategy', null);
    state.smooth = store.get('smooth', true);
    // Only a success is remembered. Treating "unknown" as "no" left every
    // fresh install in pass-through forever: the jump was only attempted once
    // it was known to work, and it could only become known by attempting it.
    // A failure is deliberately NOT persisted - it may have been a one-off
    // (thumbnails not rendered yet), and the cost of re-trying next session is
    // a single swallowed keypress.
    state.jumpWorks = store.get('jumpWorks', null) === true ? true : null;
    // Calibrated per session, not loaded: every stored value so far was
    // learned while a leaked keyup was adding a turn in the direction of
    // travel, so it is noise. A genuine offset costs one retried jump to
    // relearn.
    state.jumpOffset = 0;
    state.dim = store.get('dim', 0);
    state.single = store.get('single', false);

    // Bind the key handler FIRST, before anything else and before the reader
    // has loaded. Listeners on the same target fire in registration order, so
    // a handler added at document-idle runs *after* the reader's own - it had
    // already turned a page by the time stopImmediatePropagation ran, and
    // every arrow press turned two pages. Registering at document-start is
    // the only way to get in front of it.
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    for (const type of ['keyup', 'keypress']) {
      window.addEventListener(type, onKeyUpOrPress, true);
      document.addEventListener(type, onKeyUpOrPress, true);
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('pointerup', onCornerTap, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    // Chrome only reveals a pad once it has been used, and announces it here.
    window.addEventListener('gamepadconnected', startPadLoop);
    startPadLoop();     // in case one was already in use before we loaded

    // Everything below touches the DOM, which does not exist yet at
    // document-start.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  function start() {
    installStyles();

    // One unconditional line. Everything else is gated behind debug mode, so
    // without this a silent script and a script that never loaded look
    // identical in the console.
    console.log('%c[dcui2p]%c v' + VERSION +
      (typeof GM_info !== 'undefined' ? ' (userscript)' : ' (extension)') + ' loaded — ' +
      (state.enabled ? 'enabled' : 'DISABLED (press T)') +
      (state.debug ? ', debug on' : '') +
      '  |  press H for the key list, D for the debug HUD' +
      '  |  dcui2p.report() for a copyable diagnosis',
      'color:#0a0;font-weight:bold', 'color:inherit');

    // Keep the HUD honest even when nothing mutates.
    setInterval(() => { trackPage(); if (state.debug) updateHud(); }, 500);

    // The reader mounts asynchronously and the thumbnails decode a moment
    // later; retry until both are there, then hand over to the observer.
    let tries = 0;
    const boot = setInterval(() => {
      if (++tries > 120) { clearInterval(boot); return; }   // ~60s, then give up quietly
      if (!onReaderPage()) return;
      if (q(SEL.host) && currentPage()) {
        if (!readManifest()) pollManifest();
        if (watch()) {
          clearInterval(boot);
          // The baseline is captured by apply() itself, immediately before
          // its first modification - see the note there.
          ensureRows();
          log('ready: page ' + currentPage() + ' of ' + state.total + ', ' + state.rows.length + ' rows');
          apply();
        }
      }
    }, 500);

    // Single-page app: entering or leaving the reader does not reload.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      state.manifest = [];
      state.total = 0;
      state.boxW = 0;
      state.rows = [];
      state.rowOf = [];
      state.rowsKey = '';
      log('navigated to ' + location.pathname);
      if (onReaderPage()) {
        setTimeout(() => {
          if (!readManifest()) pollManifest();
          apply();
        }, 1200);
      } else {
        teardown();
      }
    }, 800);

    // Expose a console handle. unsafeWindow reaches the page's own global in
    // sandboxing userscript engines; without it this is just `window`.
    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    try {
      pageWindow.dcui2p = {
        state: state,
        probeNav: probeNav,
        apply: apply,
        teardown: teardown,
        step: step,
        goToPage: goToPage,
        jumpToPage: jumpToPage,
        navOnce: navOnce,
        strategies: STRATEGIES.map((s) => s.name),
        page: currentPage,
        manifest: () => state.manifest,
        spreads: spreadPages,
        rows: () => { ensureRows(); return state.rows; },
        rowFor: rowFor,
        suspend: () => suspend('manual'),
        resume: resume,
        help: toggleHelp,
        single: toggleSingle,
        dim: cycleDim,
        zoomed: readerZoomed,
        collapsed: () => { const h = q(SEL.host); return !!h && slotsCollapsed(h); },
        verifyRestore: verifyRestore,
        snapshot: snapshot,
        stats: () => state.stats,
        report: report,
        history: () => state.history,
        canvases: () => {
          const host = q(SEL.host);
          if (!host) return [];
          const roles = classify(host);
          return qa('canvas', host).map((c) => ({
            role: roles.get(c), slot: slotOf(c), buffer: c.width + 'x' + c.height,
            inline: c.style.transform, computed: getComputedStyle(c).transform,
            visible: getComputedStyle(c).visibility !== 'hidden',
            rect: c.getBoundingClientRect(),
          }));
        },
      };
    } catch (_) { /* some engines forbid writing to the page global */ }
  }

  init();
})();
