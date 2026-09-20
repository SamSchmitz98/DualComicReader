# FINDINGS — DCUI web reader (Phase 1, in progress)

## Reader identity

- URL shape: `https://www.dcuniverseinfinite.com/comics/book/<slug>/<uuid>/c/reader`
- App shell is Nuxt (`div#__nuxt`), dark theme.
- Reader DOM path:

```
div#__nuxt
 > div.app-wrapper
  > div.layout-inner.dark-theme
   > main
    > div.comic-issue.comic-issue__reader-open
     > div
      > div#issue-page-reader-container.comic-book-reader-container.pages-loaded
       > div.dc-comic-reader.dramafever-comicbook-reader-container
        > canvas  (x3)
```

- The `dramafever-` class prefix suggests the reader widget is inherited from
  DramaFever's comic reader, not written fresh for DCUI.
- Full reader subtree:

```
div#issue-page-reader-container.comic-book-reader-container.pages-loaded
  div.dc-comic-reader.dramafever-comicbook-reader-container   (fixed, 1475x945, z-index 1000)
    canvas   transform: translateX(+1475)  z-index 2   <- NEXT page
    canvas   transform: translateX(-1475)  z-index 1   <- PREVIOUS page
    canvas   transform: translateX(0)      z-index 3   <- CURRENT page
  div.comic-reader-chrome-wrapper
    div.comic-reader-chrome                  (1475x945, the UI overlay)
    div.reader-modal.reader-modal__settings  (0x0, closed)
    div.reader-modal.reader-modal__page-browser (0x0, closed)
    div.reader-modal                         (0x0, closed)
```

## Q1 — How are pages rendered?

**`<canvas>`, not `<img>`.** A probe filtering for images wider than 200px
returned zero `<img>` elements and three `<canvas>` elements.

## Q2 — Are all pages in the DOM at once?

**No.** Only three canvases exist, each 1475x945 (buffer size == rendered size,
so devicePixelRatio is 1 and no CSS scaling is applied). A whole issue is far
more than three pages, so these are a fixed-size pool, not one-per-page.

Note the canvas is *landscape* (1475x945) while the page being read is
*portrait*. The page is drawn letterboxed inside it: 945px tall page at a
typical comic aspect ratio works out to ~613px wide, which matches the visible
page column in the screenshot. So each canvas is a viewport-sized drawing
surface, and the page is painted into the middle of it.

**Resolved: the three canvases hold three different pages.** Laying them out
in a row with CSS alone (probe 3) showed three distinct pages of art. The
reader is a **three-slide carousel**: all three canvases are
`position: absolute; top/left: 0`, distinguished only by an inline
`transform: translateX(...)`:

| translateX | z-index | role |
|---|---|---|
| `+1475` (one viewport right) | 2 | next page |
| `0` | 3 | current page |
| `-1475` (one viewport left) | 1 | previous page |

Turning the page slides the strip and recycles the canvas that fell off the
end into the far side, redrawn with the newly-adjacent page. So the reader
always keeps exactly current, previous and next in memory — which is
precisely the two pages a spread view needs, already drawn, with no pixel
access required.

## Q3 — Reader's own navigation

Partly established.

- `keydown` is bound on **both** `document` and `window`, so the reader handles
  arrow keys itself. Our own handler must run first (capture phase) and call
  `stopImmediatePropagation()` to retime navigation without the reader also
  acting on the same keypress.
- **The reader honours `key:focused`** — a synthetic `ArrowLeft`/`ArrowRight`
  `KeyboardEvent` dispatched at `document.activeElement` and allowed to bubble.
  Confirmed in a live session. It does *not* check `isTrusted`. Dispatching
  straight at `document` or `window` was not needed, though the script still
  falls back through those, an edge click and a touch swipe if the preferred
  hook ever stops working.
- **A page turn takes about 475ms** from dispatch to the page counter
  updating. That is the reader's own transition, not our polling.
- **The canvas widget cannot be navigated synthetically; the Vue chrome
  can.** With the real keypress correctly blocked, `probeNav()` — run from
  the console, so no real key is involved — reported every input strategy
  aimed at the reader surface failing: keyboard events at the focused
  element, at `document`, at `window` and at the reader element, an edge
  click, and a touch swipe. Nothing moved the page.

  The **one thing that works is a synthetic `click` on a page-browser
  thumbnail** (`93 -> 96` in the same clean probe). The thumbnails are
  rendered by the site's Vue layer, whose click handlers do not care whether
  an event is trusted; the canvas widget's own input handling evidently does.
  The thumbnails are accurate: a later clean probe went `94 -> 96` when
  asked for 96. An earlier note here claimed they land one page late; that
  was wrong, and what it had actually observed was the leaked `keyup`
  described below adding a turn in the direction of travel.

  This invalidates every earlier reading that said `key:focused` worked. Those
  page turns were the *real* keypress reaching the reader while the script's
  synthetic event did nothing; the script simply took the credit because the
  page changed after it dispatched. **Any conclusion of the form "our
  synthetic event worked" is worthless unless the real event was blocked at
  the time.**

- **The reader's own keydown listener wins the race unless you start early.**
  Listeners on the same target fire in registration order, so a userscript
  bound at `@run-at document-idle` runs *after* the reader's - which has
  already turned a page by the time `stopImmediatePropagation()` executes.
  Every arrow press therefore turned two pages: one by the reader, one by the
  script. Visible in the history as an extra change, one page in the
  direction of travel, attributed to "reader or user" in the same second as
  the script's own move. `@run-at document-start` (binding the key handler
  immediately and deferring everything DOM-dependent to `DOMContentLoaded`)
  is the fix.
- **Blocking a keypress means blocking its `keyup` too.** The script took the
  real `keydown` and jumped, but the `keyup` that followed still reached the
  reader - which turns a page on `keyup`. Every move therefore came to rest
  one page past its target *in the direction of travel*: forwards jumps
  landed at target+1, backwards jumps at target-1. That signature is what
  distinguishes a leaked keypress from a thumbnail offset, which would be
  constant regardless of direction. It also made the offset calibration
  flip-flop, since it was chasing a sign that changed with each press.
- **The reader navigates on `keyup` as well as `keydown`.** Sending both, as
  a synthetic keypress naturally would, turns one dispatch into two page
  turns. Combined with a poller that sometimes caught the intermediate page
  and dispatched again, this produced an extra turn that arrived *after* the
  script believed it had finished — indistinguishable, in the logs, from the
  reader moving on its own. Send `keydown` only.
- **Clicking a page-browser thumbnail navigates to exactly the page its
  `alt` text names.** Several earlier readings said otherwise (`alt="Page
  92"` "landing" on 93), and an offset-calibration mechanism was built around
  them. Every one of those readings was contaminated - by the leaked `keyup`,
  or by catching the counter mid-animation. The calibration is kept as a
  zero-cost safety net, but in a clean run the offset is 0.
- **Never treat "the counter reached the page I wanted" as arrival.** The
  reader animates through the pages in between, so a move of two pages passes
  through the destination's neighbour, and a jump passes through the
  destination itself on its way somewhere else. Both make a move look finished
  while it is still travelling, and whatever happens next is then misread as
  the reader acting on its own. Wait for the counter to stop changing
  (~260ms of quiet) and use where it came to rest.
- A trap worth recording: in a sandboxing userscript engine, passing the
  script's own `window` as a UIEvent's `view` throws *"Failed to convert value
  to 'Window'"*, and every dispatch fails before reaching the page. Use
  `unsafeWindow`, or omit `view` entirely.
- `mousedown/mouseup/mousemove` and the full `touchstart/move/end/cancel` set
  are bound on `document` — that is the swipe/drag handling for the carousel.
- The visible UI lives in `div.comic-reader-chrome`, with settings and
  page-browser modals as siblings. Its buttons are the most likely place to
  hook "next page" without reimplementing navigation. The panes carry a
  `hide-pane` class and are only revealed on hover, so every control measures
  0x0 until then — the actual buttons sit inside `div.tooltip.tooltip--top`
  wrappers and have not been dumped yet.
- **`span.page-count` renders `"Page 104 / 238"`.** This is a gift: current
  page number and total, straight from the DOM, no reverse engineering. Use it
  for the odd/even pairing decision, for the `P` offset hotkey, and as the
  signal that a programmatic page turn actually landed.
- **No Vue component instance** is reachable by walking up from the reader
  container: the carousel is created imperatively by the DramaFever widget,
  not rendered by Vue. Reader state must be found elsewhere (Nuxt payload,
  a Pinia store, or a global) if we need it at all.

### A MutationObserver cannot be guarded with a flag

The obvious way to stop a layout reacting to its own DOM writes is to set a
flag during them and have the observer ignore anything that arrives while it
is set. It does not work. Observer callbacks are delivered **asynchronously**,
so the flag is false again by the time one runs, and every layout schedules
the next — 60 a second, indefinitely.

`observer.takeRecords()` after the writes is the real answer: it drains the
records they produced so nothing is delivered for them. A ceiling on how often
a layout may run (50ms apart) is worth having as well, since it bounds the
cost of any feedback loop that has not been thought of.

What tipped it over in practice was adding a class to elements the site's own
framework manages, to hide a scrollbar. Vue rewrote the class, the script put
it back, and the two fought at frame rate. The lesson generalises: **do not
write to attributes on elements the site owns.** Everything else the script
does is a stylesheet rule keyed on a class it puts on `<html>`, which nothing
contests.

### Measure against `clientWidth`, not `innerWidth`

The site lays its reader out inside `document.documentElement.clientWidth`,
which excludes the scrollbar, while `window.innerWidth` includes it. Using
the latter put the spread half a scrollbar off centre and made the restore
check report a phantom difference on every run:

```
container is 1265px, expected the full viewport (1280px)
canvas buffers are 3795px wide, expected ~3840
```

Both gaps are exactly one 15px scrollbar (and 45 = 15 x 3 at dpr 3). Nothing
was wrong with the restore; the yardstick was wrong.

A related cosmetic point, and *not* ours: the site keeps a scroll container
whose scrollbar occupies the right edge of the viewport, so a pale vertical
strip sits there whatever the script does. `elementFromPoint` returns null
over it, which is how it was identified — it is still present with the script
switched off.

### The carousel is not the reader's only layout

Double-clicking a panel takes the reader out of carousel mode. Observed by
diffing the whole reader subtree before and after:

```
before   z3 (no transform)   z2 translate(851px)   z1 translate(-851px)   opacity 1, 1, 1
after    z3 (no transform)   z2 translate(0px)     z1 translate(0px)      opacity 1, 0, 0
```

Two assumptions break at once. Every canvas is parked at the same offset, so
a transform no longer says which page a canvas holds; and the reader hides
the canvases it is not showing with **opacity**, which nothing in our CSS
overrode — so a canvas placed in a visible slot could be fully transparent.
In that snapshot every canvas was either hidden by us or transparent, which
is a blank screen.

The stacking order survives this and has been constant since the first probe:
**z-index 3 = current, 2 = next, 1 = previous.** It is the fallback when
offsets collapse, and arguably the better primary signal.

This turned out to be **panel zoom**: double-clicking a panel is what leaves
the carousel, and the reader redraws the zoomed panel into *every* canvas.
Forcing opacity back on - the fix for the blank screen above - therefore put
two zoomed panels on screen at once, one from each page. There is no laying
that out; the script has to stand aside and give the reader its full width
back until the carousel returns. The collapse is the signal, debounced so a
page turn passing through it does not flicker the layout.

### Identifying which canvas is which

The widget stores its own slot bookkeeping directly on the canvas elements: two
of the three carry a **`transformX` expando property**. Read that instead of
parsing the computed `transform` matrix — it is the widget's own intent rather
than a rendered side effect, and it does not go through intermediate values
during the slide animation.

(The third canvas lacks the property, presumably because the slot sitting at
offset 0 never had it assigned. Treat "no `transformX`" as 0.)

### The chrome buttons are not selector-friendly

All 16 buttons in `.comic-reader-chrome` have an empty `class`, no
`aria-label`, no `title` and no text — they are bare icon buttons, and
removing `hide-pane` was not enough to give them geometry, so they stayed 0x0
and even their `<svg>` path data came back empty.

Hooking "next page" by finding its button is therefore fragile. Better plan:
the reader binds `keydown` on `document` and `window`, so re-dispatching a
synthetic `ArrowRight` `KeyboardEvent` drives the reader's own navigation
without us reimplementing or guessing at buttons. Our capture-phase handler
must tag its own synthetic events so it does not re-intercept them and loop.

### No widget instance is reachable

`.dc-comic-reader` and `#issue-page-reader-container` have no expando
properties at all, and the only interesting-looking globals are unrelated
(`WM`/`psmMgr` are player telemetry, `ace` is the Ace code editor, `normalize`
is lodash). There is no reader API to call — the DOM is the whole interface.

## Q4 — How spreads appear

**As single wide pages, and they are fully enumerable in advance.**

Opening the page-browser modal renders a thumbnail `<img>` per page, each with
`alt="Page N"` and real natural dimensions. For the test issue (238 pages):

| aspect | count | meaning |
|---|---|---|
| 0.65 (163x250) | 234 | normal portrait page |
| 1.30 (250x192) | 4 | **double-page spread** |
| 1.50 / 1.00 / 10.72 | 1 each | site chrome, not pages (234 + 4 = 238) |

A spread is exactly twice the aspect of a single page (0.65 -> 1.30), i.e. the
two facing pages are delivered as one wide image, not as two. So spread
detection is simply `aspect > 1`, and those pages take a full-width row of
their own — which is what the brief asks for.

Note page 3 is a spread in this issue, so the naive `[1], [2,3], [4,5]`
pairing breaks almost immediately. Pairing has to be computed by walking the
manifest and letting each spread consume a whole row, not by parity
arithmetic.

This is what the implementation does: at startup it builds the entire issue as
a list of rows (`[1] [2] [3] [4,5] [6,7] ...` for the test issue — page 2 goes
solo because its partner is a spread) and every later question, including
where an arrow press should land, is a lookup against that list. The `P`
hotkey only shifts the starting offset, which is all it should ever need to
do.

## The one real layout problem

Each canvas is the size of the **whole viewport** (1475x945) and the portrait
page is drawn *letterboxed in the middle of it*, about 613px of art with
~431px of black on either side.

So naively placing two canvases side by side at 50% width does not give a
print-comic spread — it gives two small pages separated by roughly 430px of
black, far past the brief's "no gap larger than ~8px".

The fix is to crop rather than shrink: wrap each canvas in an
`overflow: hidden` box and use `transform: scale()/translate()` to push the
black margins outside the box, so the two pages meet in the middle. That needs
one number we do not have yet — **where the drawn art actually sits inside the
canvas**, i.e. the page's aspect ratio.

Candidate ways to get it, cheapest first:

1. ~~Page metadata already in the app (Nuxt payload / Pinia store / a
   global)~~ — **dead end.** `window.__NUXT__` contains no page list, there is
   no Pinia store on the Vue app, and the only non-standard globals are
   analytics vendors (Optimizely, OneTrust, Segment, Datadog RUM, GA) plus
   lodash. The reader widget does not publish its page data to the page.
2. Assume the reader fits page height to canvas height and centers it, then
   derive width from a known comic aspect ratio — works for standard pages,
   breaks on spreads and odd trim sizes.
3. Measure the non-black bounds by reading the canvas back with
   `getImageData` — this is pixel access, and although it only measures
   geometry rather than reproducing artwork, it is exactly the kind of thing
   the brief says to stop and ask about. Not doing this without a decision
   from the project owner.

## Why the three-canvas question decides the approach

- **If the three canvases hold different pages:** we can position two of them
  side by side with CSS alone (`position`, `transform`, `width`) and let the
  reader keep drawing into them as it always does. No pixel reads, no
  `drawImage`, no `getImageData`, no network. This is pure restyling of what
  the browser already renders, and it satisfies the brief's hard constraint
  cleanly.
- **If all three hold the same page** (pure double-buffering): showing two
  different pages at once would require copying pixels out of the reader's
  canvas into one of ours, which is a form of extraction. That is a judgment
  call for the project owner, and per the brief the default is to stop and
  report rather than proceed.

## Console noise (benign)

The reader logs `The Content Security Policy directive
'upgrade-insecure-requests' is ignored when delivered in a report-only policy.`
repeatedly. Unrelated to the reader's behavior; ignore it.

## The promising way out of the aspect-ratio problem

Worth testing before anything involving pixels: **the two pages may already fit
side by side at their natural size.** The viewport is 1475x945 and the drawn
art is roughly 613x945, so two pages laid next to each other come to ~1226px —
comfortably inside 1475. Nothing needs scaling; the canvases only need to slide
toward each other.

Two unknowns decide whether this works, both cheap to check and neither
involving reading pixels:

1. **Is the canvas transparent outside the art, or filled with opaque black?**
   The canvases overlap completely (all three are `top/left: 0`, full
   viewport). If the letterbox area is transparent, sliding them together
   composites correctly. If each canvas paints opaque black edge to edge, the
   higher z-index one hides the other and we must clip instead.

2. ~~Does the reader re-fit the art when the window changes size, and does it
   use `contain`?~~ — **CONFIRMED, and this is the key to the whole design.**
   Narrowing the browser window makes the art scale down to fill the width,
   with black bars appearing at top and bottom instead of at the sides. The
   reader recomputes its canvas size from the viewport and re-fits the page
   with a `contain` scale on every resize.

## Consequence: let the reader do the fitting

Because the fit is `contain`, the horizontal gap between two side-by-side
pages is governed entirely by how wide we let each canvas be:

- Canvas **wider** than the page's natural aspect (the current situation,
  1475 wide for ~613 of art): the reader fits to *height* and pads the sides
  with black. Two of these side by side leave a large gap.
- Canvas **narrower** than the page's aspect: the reader fits to *width*, the
  art spans the canvas edge to edge, and the padding moves to top and bottom —
  where it is black on black and therefore invisible.

So the implementation is not "crop the canvas", it is **give the reader a
narrower box and let it redraw the page to fit**. No cropping, no scaling
hacks, no pixel access.

The ideal box width is exactly `945 * pageAspect` (~613px here): any narrower
wastes vertical space, any wider reopens the gap. Which brings us back to
needing the page aspect ratio — see below.

## The page manifest (resolved — this was the missing piece)

`div.reader-modal.reader-modal__page-browser` holds a thumbnail `<img>` per
page. Each one gives us, for free:

- `alt="Page N"` — the page index, and
- `naturalWidth`/`naturalHeight` — the exact aspect ratio of that page.

That is a full manifest of the issue: how many pages, how wide each one is,
and which ones are spreads. It is enough to compute the pairing for the entire
issue up front and to size the render box exactly.

This reads the dimensions of images the reader has already placed in the DOM.
It is not pixel extraction, needs no canvas readback, and adds no network
request — the thumbnails are fetched by the reader whether we look at them or
not.

**Confirmed available without opening the modal.** All 238 thumbnails are in
the DOM on a fresh page load while the page browser is still closed.

They are *not* necessarily decoded yet, though. A thumbnail that has not
finished decoding reports `naturalHeight === 0`, and decoding 238 of them
takes a few seconds. Observed in a live session, re-reading every 750ms:

```
found 238 thumbnails but none decoded yet
128/238 pages read (110 still decoding), spreads at 3, 48, 51
232/238 pages read (6 still decoding),   spreads at 3, 48, 51, 218
238/238 pages read,                      spreads at 3, 48, 51, 218
```

The spread at page 218 does not appear until the third read. A single read at
startup would have left it classified as portrait, mis-pairing every page from
218 to the end of the issue. The manifest must be re-read until every
thumbnail reports real dimensions — and nothing that depends on the row model
being final, such as aligning onto a row boundary, may run before then. (Earlier probes missed them only because those filtered for images
wider than 200px and the thumbnails are 163px wide.) The script can read the
whole manifest silently at startup — no UI flashing, no modal toggling.

## Pairing is a display decision, not a navigation one

Because the carousel always holds the previous, current and next page, the
page that belongs beside the current one is *already drawn* whichever half of
the row the reader is sitting on:

| current page | left slot | right slot |
|---|---|---|
| leads its row (e.g. 96 of [96, 97]) | `cur` | `next` |
| trails its row (e.g. 97 of [96, 97]) | `prev` | `cur` |

So the correct spread can always be shown without moving the reader — and,
just as importantly, the display is correct at *every intermediate state* of
a multi-page jump. Jumping from 96 to 98 passes through 97, which trails the
same row, so the screen shows [96, 97] until the moment it shows [98, 99].
There is nothing to freeze and nothing to hide.

Navigation itself is the thumbnail jump: one arrow press jumps to the first
page of the next or previous row. If the jump is ever not known to work, the
arrow keys are left to the reader (one page per press) and the display-side
pairing still keeps the right two pages on screen.

## RECOMMENDATION — Approach B, geometry-driven, no pixel access

Approach A is not available: there are no page `<img>` elements to reflow.

Approach B is available in its good form. We do **not** need to clone canvases,
call `drawImage`, or read pixels back. The reader already keeps the current and
next page drawn in separate canvases, it already re-fits the art on resize, and
the page browser already tells us every page's exact aspect. The script's job
is only to:

1. Read the manifest from the page-browser thumbnails; compute pairing for the
   whole issue, giving every `aspect > 1` spread its own full-width row.
2. Give the reader a narrower box so its own `contain` fit renders each page at
   `945 * 0.652` wide with the black padding pushed to top and bottom.
3. Position the current-page and next-page canvases side by side, identified by
   their `transformX` expando.
4. Re-dispatch `ArrowRight`/`ArrowLeft` to the reader's own keydown handlers to
   advance a pair at a time.
5. Keep it all alive through a `MutationObserver`, since the reader rewrites
   inline transforms on every page turn.

Nothing here downloads, saves, extracts or re-hosts artwork, and nothing goes
near auth, decryption or the network layer.

## The mechanism (resolved — the reader sizes from its container)

Setting `.dc-comic-reader` to `width: 700px` and dispatching a `resize` event
made the reader rebuild all three canvases at **700x945**. It measures its own
container, not the window.

This makes the implementation almost trivial, because of how the carousel is
laid out. The three canvases sit at `translateX(0)` and `translateX(+/- W)`,
where `W` is the container width. So if the container is set to exactly the
width of the drawn art:

```
boxWidth = viewportHeight * pageAspect     // 945 * 0.652 = 616px
```

then the art fills its canvas edge to edge with no side padding, **and the
"next" canvas at `translateX(+616)` lands flush against the right edge of the
current one**. The spread assembles itself. All the script has to do is:

1. set the container width to `boxWidth`,
2. centre it horizontally (`left = (viewportWidth - 2 * boxWidth) / 2`),
3. hide the "previous" canvas, which would otherwise poke out on the left,
4. dispatch a `resize` so the reader redraws at the new size.

There is no cropping, no scaling, no cloning, no `drawImage`, no
`getImageData`. The canvas-transparency question is moot, because the two
canvases no longer overlap.

## Summary of the answers

| Question | Answer |
|---|---|
| Q1 How are pages rendered? | `<canvas>`, one page per canvas, no `<img>` |
| Q2 All pages in the DOM? | No — a recycled pool of exactly 3 (prev/current/next) |
| Q3 Reader navigation | `keydown` on `document` and `window`, plus mouse/touch drag; unlabeled icon buttons in hover-revealed chrome; `span.page-count` reports `"Page N / Total"` |
| Q4 Spreads | Single wide images, `aspect > 1`, enumerable up front from the thumbnail manifest |

## Acceptance (1.0)

The brief's acceptance criteria, as confirmed in a live session on the test
issue (238 pages, spreads at 3, 48, 51 and 218):

| Criterion | Result |
|---|---|
| Two pages side by side on a 16:9 window | Confirmed - pairs sit flush, centred on black |
| Cover alone, spreads full width | Confirmed - rows computed from the thumbnail manifest |
| Arrow keys page through pairs | Confirmed - one press per spread, via the thumbnail jump |
| `P` fixes off-by-one pairing | Works; rarely needed now that rows come from the manifest |
| `T` returns the reader to stock behavior | Confirmed |
| Casting the Chrome tab to a TV shows the same layout | Confirmed |
| No network requests added by the script | By construction - the script contains no fetch, XHR, image or beacon call |

Tested on one title, in Chrome on Windows at device pixel ratios of 1 and 1.5.
Other titles, browsers and platforms are untested.
