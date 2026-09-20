// ==UserScript==
// @name         DCUI Two-Page View
// @namespace    https://github.com/SamSchmitz98/DualComicReader
// @version      0.5.1
// @description  Shows two portrait pages side by side in the DC Universe Infinite web reader, like an open print comic. Layout only - no downloading, extracting or re-hosting of artwork.
// @author       SamSchmitz98
// @match        https://www.dcuniverseinfinite.com/comics/book/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
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

  const SEL = {
    host: '.dc-comic-reader',
    outer: '#issue-page-reader-container',
    thumbs: '.reader-modal__page-browser img',
    pageCount: '.page-count',
  };

  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.5.1';

  const DEFAULT_ASPECT = 0.652;   // standard US comic page, used until the manifest loads
  const MIN_BOX = 260;            // below this a pair is unreadable; fall back to single page
  const NAV_TIMEOUT = 1600;       // ms to wait for the reader to actually turn a page
  const PROBE_TIMEOUT = 1200;     // ms per strategy when probing for a working nav hook
  const JUMP_TIMEOUT = 2600;      // ms to reach the target page after a thumbnail click
  const FADE_MS = 80;             // fade out/in across a page turn; drives CSS and the wait

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
    aligned: false,     // have we nudged onto a row boundary since load?
    stock: null,        // snapshot of the untouched reader, to verify T restores it
    tornDown: false,    // teardown is idempotent; this is the latch
    smooth: true,       // fade across page turns instead of watching them
    jumpWorks: null,    // can we navigate by clicking a page-browser thumbnail?
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
  function pairDecision(page) {
    if (!state.enabled) return { pair: false, why: 'script disabled' };
    if (page < 1) return { pair: false, why: 'no page number' };

    const row = rowFor(page);
    if (!row) return { pair: false, why: 'page not in the row model yet' };
    if (row.length === 2 && row[0] === page) return { pair: true, why: 'paired' };
    if (row.length === 2) return { pair: false, why: 'right half of the pair starting at ' + row[0] };
    if (isSpread(page)) return { pair: false, why: 'spread, full width' };
    if (state.total && page >= state.total) return { pair: false, why: 'last page' };
    if (page === 1) return { pair: false, why: 'cover stands alone' };
    return { pair: false, why: 'alone (next page is a spread)' };
  }

  const pairsWithNext = (page) => pairDecision(page).pair;

  // Where an arrow press should land: the first page of the next or previous
  // row. Stepping back from the right half of a pair aligns to its left page
  // first, which is what you want if you arrived mid-row.
  function targetPage(page, dir) {
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
    const row = state.rows[idx];
    if (page !== row[0]) return row[0];
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
    let visible = 'page ' + (page || '?');
    if (L.showPair) visible = 'pages ' + page + ' + ' + (page + 1) + '  (left | right)';
    else if (page && isSpread(page)) visible = 'page ' + page + '  (SPREAD, full width)';
    else if (page) visible = 'page ' + page + '  (single)';

    hudElement().textContent = [
      'DCUI 2-PAGE  ' + (state.enabled ? 'ON' : 'OFF') + '   [T]oggle [P]arity [S]mooth [D]ebug',
      '',
      'VISIBLE: ' + visible,
      '',
      'page       ' + (page || '?') + ' / ' + (state.total || '?') +
        '   aspect ' + aspectOf(page).toFixed(3) + (isSpread(page) ? ' SPREAD' : ''),
      'next page  ' + (page + 1) + '   aspect ' + aspectOf(page + 1).toFixed(3) +
        (isSpread(page + 1) ? ' SPREAD' : ''),
      'pairing    ' + (L.showPair ? 'YES' : 'no') + '  (' + (L.why || '-') + ')   offset=' + state.parity,
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
      'nav hook   ' + (state.navStrategy || 'not yet determined') +
        '   jump ' + (state.jumpWorks === null ? 'untested' : state.jumpWorks ? 'YES (1 transition)' : 'no (stepping)') +
        '   fade ' + (state.smooth ? 'on' : 'off'),
      'churn      ' + state.stats.rate + '   resizes sent ' + state.stats.resizes +
        '   canvases ' + state.stats.canvases,
      '',
      'canvases:',
      ...canvasLines,
      '',
      'log:',
      ...logLines.map((l) => '  ' + l),
    ].join('\n');
  }

  // ----------------------------------------------------------------- styles

  const CSS = [
    'html.dcui2p-on ' + SEL.host + ' {',
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
    'html.dcui2p-on ' + SEL.host + ' canvas.dcui2p-cur  { transform: translateX(0) !important; }',
    'html.dcui2p-on ' + SEL.host + ' canvas.dcui2p-next { transform: translateX(var(--dcui2p-w, 0px)) !important; }',
    'html.dcui2p-on ' + SEL.host + ' canvas.dcui2p-off  { visibility: hidden !important; }',
    // A page turn is a content swap we cannot animate, so fade over it: the
    // pages appear to change together rather than one visibly following the
    // other. The backdrop behind is already black, so this reads as a blink.
    'html.dcui2p-on.dcui2p-smooth ' + SEL.host + ' { transition: opacity ' + FADE_MS + 'ms ease; }',
    'html.dcui2p-on.dcui2p-smooth.dcui2p-turning ' + SEL.host + ' { opacity: 0 !important; }',
    // Debug view: show the hidden canvases faintly and outline every slot, so
    // it is obvious which canvas the script thinks is which.
    'html.dcui2p-debug ' + SEL.host + ' canvas.dcui2p-cur  { outline: 2px solid #0f0 !important; outline-offset: -2px; }',
    'html.dcui2p-debug ' + SEL.host + ' canvas.dcui2p-next { outline: 2px solid #0ff !important; outline-offset: -2px; }',
    'html.dcui2p-debug ' + SEL.host + ' canvas.dcui2p-off  {',
    '  visibility: visible !important; opacity: 0.15 !important;',
    '  outline: 2px dashed #f44 !important; outline-offset: -2px;',
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

  // Classify the carousel by ORDER rather than by exact offsets. Sorted left to
  // right the three canvases are always [prev, current, next], which stays
  // correct even mid-animation when none of them sits at exactly 0.
  function classify(host) {
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

  function setTurning(on) {
    document.documentElement.classList.toggle('dcui2p-turning', !!on && state.smooth);
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
    state.tornDown = false;

    // Capture the untouched reader on the very first apply, before this
    // function modifies anything. Doing it during boot was unreliable: the
    // resize listener is bound earlier, so a resize could apply the layout
    // first and the "stock" baseline would record our own changes.
    if (!state.stock) state.stock = snapshot();

    if (!state.manifest.length) readManifest();

    // A pair takes two page turns, and between them the counter sits on the
    // intermediate page - which would lay out as a single page and then back,
    // jumping the container sideways for half a second on every turn. Hold the
    // current layout until navigation settles; step() re-applies at the end.
    if (state.navigating) { updateHud(); return; }

    // Counted here rather than on entry: the early returns above are cheap and
    // frequent during a page turn, and counting them made the churn detector
    // cry wolf.
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
    let boxW = Math.round(Math.min(vh * aspectOf(page), decision.pair ? Math.floor(vw / 2) : vw));
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
      root.style.setProperty('--dcui2p-w', boxW + 'px');
      root.style.setProperty('--dcui2p-left', left + 'px');
      backdrop(true);

      const roles = classify(host);
      for (const canvas of qa('canvas', host)) {
        const role = roles.get(canvas) || 'prev';
        canvas.classList.toggle('dcui2p-cur', role === 'cur');
        canvas.classList.toggle('dcui2p-next', role === 'next' && showPair);
        // The previous page would otherwise hang off the left edge of the
        // centred container and be partly on screen.
        canvas.classList.toggle('dcui2p-off', role === 'prev' || (role === 'next' && !showPair));
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
    const tagged = canvases.filter((c) => /dcui2p/.test(c.className));
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
      backdrop(false);
      for (const canvas of qa('canvas', q(SEL.host) || document)) {
        canvas.classList.remove('dcui2p-cur', 'dcui2p-next', 'dcui2p-off');
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

  function dispatchKey(target, dir) {
    if (!target) return;
    for (const type of ['keydown', 'keyup']) {
      const [t, init] = keyEventInit(dir, type);
      target.dispatchEvent(makeEvent(KeyboardEvent, t, init));
    }
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
  function waitForPage(target, timeout) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (currentPage() === target) return resolve({ page: target, ms: Date.now() - started });
        if (Date.now() - started > timeout) return resolve(null);
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  }

  function waitForPageChange(from, timeout = NAV_TIMEOUT) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const now = currentPage();
        if (now && now !== from) return resolve({ page: now, ms: Date.now() - started });
        if (Date.now() - started > timeout) return resolve(null);
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
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
        log('nav: page ' + before + ' -> ' + result.page + ' in ' + result.ms + 'ms');
        return result.page;
      }
      log('nav: ' + strategy.name + ' did nothing');
    }

    warn('no navigation hook worked - the reader ignored keys, clicks and swipes. ' +
         'Run dcui2p.probeNav() in the console for detail.');
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
    const img = thumbFor(target);
    if (!img) return 0;

    // The clickable element may be the image or a wrapper around it.
    const candidates = [img, img.closest('button'), img.closest('[role=button]'),
                        img.parentElement, img.parentElement && img.parentElement.parentElement]
      .filter((el, i, all) => el && all.indexOf(el) === i);

    for (const el of candidates) {
      const before = currentPage();
      el.dispatchEvent(makeEvent(MouseEvent, 'click',
        { bubbles: true, cancelable: true, composed: true, button: 0 }));
      const landed = await waitForPage(target, JUMP_TIMEOUT);

      if (!landed) {
        const now = currentPage();
        if (now !== before) {
          warn('jump: click moved to ' + now + ' and stopped, wanted ' + target);
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
      log('jump: reached page ' + target + ' in ' + landed.ms + 'ms');
      return target;
    }

    state.jumpWorks = false;
    store.set('jumpWorks', false);
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

    log((why || 'goto') + ': page ' + page + ' -> ' + target);
    if (state.smooth) { setTurning(true); await sleep(FADE_MS); }

    // Only worth jumping when it saves a transition; a single step is already
    // one transition and the arrow path is the better-tested one.
    if (Math.abs(target - page) > 1 && state.jumpWorks !== false) {
      const landed = await jumpToPage(target);
      if (landed === target) return target;
      page = currentPage();
      if (page === target) return page;
    }

    let guard = 0;
    while (page !== target && guard++ < 8) {
      const landed = await navOnce(page < target ? 1 : -1);
      if (!landed) break;
      page = landed;
    }
    if (page !== target) warn('stopped at page ' + page + ', wanted ' + target);
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
    } finally {
      state.navigating = false;
      apply();
      // Next frame, so the reveal happens after the new layout is painted.
      requestAnimationFrame(() => setTurning(false));
    }
  }

  // Opening an issue part-way through can drop you on the right half of a
  // pair, which looks wrong on arrival. Nudge onto the row boundary once.
  let alignWaitStart = 0;

  async function maybeAlign() {
    if (state.aligned || !state.enabled || state.navigating) return;

    // Do not align on a provisional row model. Until the thumbnails have
    // decoded, every page looks portrait, so a spread earlier in the issue is
    // missing and the row leaders after it are wrong - and alignment only ever
    // runs once, so getting it wrong here is permanent.
    if (state.manifestExpected && state.manifestDecoded < state.manifestExpected) {
      if (!alignWaitStart) alignWaitStart = Date.now();
      if (Date.now() - alignWaitStart < 20000) {
        setTimeout(maybeAlign, 750);
        return;
      }
      log('align: manifest still incomplete after 20s, aligning anyway');
    }

    const page = currentPage();
    const row = rowFor(page);
    if (!page || !row) return;

    state.aligned = true;          // one attempt per issue, success or not
    if (row[0] === page) return;

    state.navigating = true;
    try {
      await goToPage(row[0], 'align');
    } finally {
      state.navigating = false;
      apply();
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

    console.table(results);
    const winner = results.find((r) => r.worked);
    if (winner) {
      state.navStrategy = winner.strategy;
      store.set('navStrategy', winner.strategy);
      console.log('%c[dcui2p] using ' + winner.strategy, 'color:#0a0;font-weight:bold');
    } else {
      console.warn('[dcui2p] nothing moved the page. Try turning a page by hand and watch ' +
                   'which DOM attributes change, or check whether the reader needs a real user gesture.');
    }
    if (currentPage() !== startPage) console.warn('[dcui2p] ended on page ' + currentPage() + ', started on ' + startPage);
    return results;
  }

  // ---------------------------------------------------------------- hotkeys

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
    if (key === 'd' || key === 't' || key === 'p' || key === 's') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    if (key === 'd') {
      state.debug = !state.debug;
      store.set('debug', state.debug);
      document.documentElement.classList.toggle('dcui2p-debug', state.debug && state.enabled);
      console.log('%c[dcui2p] debug ' + (state.debug ? 'ON' : 'OFF'), 'color:#0a0;font-weight:bold');
      // Replay what happened before debug was switched on - startup and
      // manifest reading are over by the time anyone presses D.
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

    if (key === 'p') {
      state.parity = state.parity ? 0 : 1;
      store.set('parity', state.parity);
      buildRows();
      // The rows moved under us, so the current page may now be a right half.
      // Let the aligner put us back on a boundary.
      state.aligned = false;
      log('parity: offset ' + state.parity + ' (' + (state.parity ? 'pairs from page 1' : 'cover alone, then pairs') + ')');
      apply();
      setTimeout(maybeAlign, 50);
      return;
    }

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      // Stop the reader acting on this keypress; we re-issue our own so a
      // single press moves a whole pair.
      e.preventDefault();
      e.stopImmediatePropagation();
      step(e.key === 'ArrowRight' ? 1 : -1);
    }
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
    state.jumpWorks = store.get('jumpWorks', null);
    installStyles();

    // One unconditional line. Everything else is gated behind debug mode, so
    // without this a silent script and a script that never loaded look
    // identical in the console.
    console.log('%c[dcui2p]%c v' + VERSION + ' loaded — ' +
      (state.enabled ? 'enabled' : 'DISABLED (press T)') +
      (state.debug ? ', debug on' : '') +
      '  |  T toggle · P pairing offset · S smooth turns · D debug HUD' +
      (state.debug ? '' : '  |  press D for the HUD and verbose logging'),
      'color:#0a0;font-weight:bold', 'color:inherit');

    // Capture phase, so we get arrow keys before the reader's own handlers.
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', schedule);

    // Keep the HUD honest even when nothing mutates.
    setInterval(() => { if (state.debug) updateHud(); }, 500);

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
          setTimeout(maybeAlign, 400);
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
      state.aligned = false;
      alignWaitStart = 0;
      log('navigated to ' + location.pathname);
      if (onReaderPage()) {
        setTimeout(() => {
          if (!readManifest()) pollManifest();
          apply();
          setTimeout(maybeAlign, 400);
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
        verifyRestore: verifyRestore,
        snapshot: snapshot,
        stats: () => state.stats,
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
