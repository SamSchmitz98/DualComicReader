# DCUI Two-Page View

A userscript that makes the [DC Universe Infinite](https://www.dcuniverseinfinite.com)
web reader show **two portrait pages side by side** on a landscape screen, like
an open print comic — so casting the Chrome tab to a TV looks right.

It restyles what the reader already draws. It does not download, save, extract
or re-host artwork, does not touch authentication or decryption, and adds no
network requests of its own. See [FINDINGS.md](FINDINGS.md) for how the reader
works and why this approach was chosen.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Open `dcui-two-page.user.js` in the extension's editor — or drag the file
   onto the extension's dashboard — and save it.
3. Open any issue in the DCUI web reader. The spread view applies itself.

## Hotkeys

| Key | What it does |
|---|---|
| `T` | Toggle the script on and off. Off restores the reader's stock behavior exactly. |
| `P` | Shift the pairing offset, for books whose numbering does not line up. Default keeps the cover alone; pressing `P` pairs from page 1 instead. |
| `S` | Toggle the fade across page turns. On by default. |
| `D` | Toggle the debug HUD. |
| `←` `→` | The reader's own page turn, one page per press. Two presses move a spread. |

All settings are remembered per site, via the userscript manager's
storage where available and `localStorage` otherwise.

The reader's own controls — the on-screen buttons, click-to-advance, swipe and
the page browser — keep working untouched.

## How it works

The DCUI reader is a three-slide carousel of `<canvas>` elements: previous,
current and next page, positioned at `translateX(0)` and `translateX(±W)`,
where `W` is the width of their container.

Two properties of the reader make the spread nearly free:

- It sizes its canvases from its **container**, not the window, and re-fits the
  page with a `contain` scale on every resize.
- Its page-browser modal already holds a thumbnail `<img>` per page, carrying
  `alt="Page N"` and real natural dimensions — a complete manifest of the
  issue, present in the DOM from load.

So the script reads the manifest to learn each page's aspect ratio, sets the
container to exactly the width the art wants to be (`viewportHeight ×
pageAspect`), and lets the reader redraw. The art then fills its canvas edge to
edge, and the "next" canvas lands flush against the current one's right edge.
The script centers the pair and hides the "previous" canvas. That is the whole
trick — no cropping, no scaling hacks, and nothing reading pixels back off a
canvas.

### Pairing

Spreads are detected from the manifest: a double-page spread is delivered as
one wide image (aspect ≈ 1.30 against ≈ 0.65 for a single page), so any page
wider than tall gets a full-width row to itself.

Because a spread consumes a whole row, it shifts the odd/even rhythm of every
page after it — so pairing is not computed with parity arithmetic. At startup
the script walks the manifest once and lays the entire issue out in rows: the
cover alone, then pairs, with each spread taking a row to itself. Everything
after that is a lookup. In the test issue, whose page 3 is a spread, the
layout comes out as `[1] [2] [3] [4,5] [6,7] …` — page 2 correctly goes solo
because its partner is a spread.

Arrow keys are left to the reader, which turns one page per press, so two
presses advance a spread. The display stays on the correct pair either way,
because the carousel already holds the page that belongs beside the current
one: when the current page leads its row the spread is `current + next`, and
when it trails its row the spread is `previous + current`. Nothing has to be
navigated to show the right two pages.

This is not a stylistic choice. The reader ignores every synthetic keyboard,
mouse and touch event, so a script cannot turn its pages — see
[FINDINGS.md](FINDINGS.md). `dcui2p.probeNav()` re-tests this and will resume
paired navigation automatically if a hook ever works.

### Smoothness

The reader turns one page at a time and takes roughly 475ms to do it, so
advancing a pair by stepping means watching the right-hand page slide into the
left slot and a new page appear after it. Two things avoid that:

- **Jumping.** The page-browser thumbnails are in the DOM with the modal
  closed and their click handlers are live, so the script clicks the target
  page's thumbnail and the reader goes straight there — one transition per
  move instead of two, with no intermediate page. If the thumbnails turn out
  not to be clickable, it falls back to stepping and remembers that.
- **Fading.** A content swap in a canvas cannot be animated, so the script
  fades the reader out and back across the turn. The backdrop behind is
  already black, so it reads as a blink rather than a shuffle. Press `S` to
  turn it off and compare.

## Debugging

Debug output is **off by default**, so the only thing the script prints
normally is a single line at startup confirming it loaded, with its version
and the hotkeys. If you do not see that line in the console, the script is not
running.

Press `D` for an on-screen HUD showing which pages are visible, the pairing
decision and why it was made, the box geometry, the manifest, and a role/slot
line per canvas. Debug mode also outlines each canvas — green for the current
page, cyan for the one paired beside it, dashed red for the hidden previous
page, shown faintly so you can see where it sits.

Switching debug on also replays the events that happened before you pressed
`D` — startup and manifest reading are long over by then — and dumps a state
summary.

**Page changes are recorded whether or not debug is on.** If something
unexpected appears, run `dcui2p.report()` afterwards: it prints (and copies) a
block showing what is on screen, the rows around the current page, the
settings in force, and the last 20 page changes with what caused each — the
script's own navigation, or the reader responding to you directly. A change
that left the current page in the middle of a row is flagged `MID-ROW`, which
is what a lone page or a repeated page looks like from the inside.

The browser console also gets a `dcui2p` handle:

| Call | What it gives you |
|---|---|
| `dcui2p.probeNav()` | Tries every navigation hook in turn and prints a table of which ones actually turned a page. Restores your position afterwards. |
| `dcui2p.canvases()` | Role, slot offset, buffer size, transforms and screen rect for each canvas. |
| `dcui2p.state` | Live state: enabled, parity, manifest, remembered nav hook. |
| `dcui2p.spreads()` | Page numbers detected as double-page spreads. |
| `dcui2p.rows()` | The whole issue laid out in rows, e.g. `[[1],[2],[3],[4,5],…]`. |
| `dcui2p.rowFor(n)` | The row a given page sits in. |
| `dcui2p.step(1)` / `dcui2p.step(-1)` | Drive a paired page turn by hand. |
| `dcui2p.verifyRestore()` | Diff the reader against the snapshot taken before the script touched it. |
| `dcui2p.stats()` | Apply/mutation rates, resizes dispatched, canvas pool size. |
| `dcui2p.report()` | One copyable block: what is on screen, the rows around it, settings, and the last 20 page changes. Copied to the clipboard automatically. |
| `dcui2p.history()` | Every page change this session, with what caused it. |

If arrow keys are not turning pages, `dcui2p.probeNav()` is the place to start
— it will name the hook that works, and the script remembers it from then on.

## Known limitations

- **The page-turn animation is gone.** The script positions the canvases
  deterministically with `!important` rather than trusting the widget to have
  recomputed its slide offsets for the narrowed container. Page turns are
  instant instead of sliding.
- **One arrow press turns one page, not one spread.** The reader ignores
  synthetic events, so the script cannot turn pages itself; it leaves the
  arrow keys alone and pairs the display around wherever the reader lands.
  Advancing a spread therefore takes two presses, and the first of them looks
  like nothing happened — the same pair stays on screen, because the reader
  has only moved from the left half of it to the right half.
- **`@match` covers `/comics/book/*`, not only `/c/reader`.** The reader is a
  single-page app, so a script matched strictly on the reader URL would never
  load when you navigate into the reader from a book page. The script stays
  inert — no styles, no observers, no key handling — until the path is actually
  a reader path.
- **Portrait windows fall back to a single page.** If half the viewport would be
  narrower than 260px, the pair is dropped rather than rendered unreadably
  small.
- **The manifest must load for spread detection to work.** Until the page
  browser's thumbnails have decoded, every page is assumed to be a standard
  portrait page. In practice they are present and decoded on page load, and
  the layout is recomputed once the manifest arrives.
- Left-to-right reading order only, as intended for Western comics.

## Files

- `dcui-two-page.user.js` — the userscript.
- `FINDINGS.md` — how the reader renders pages, navigates, and exposes page
  metadata; the investigation behind the implementation.
- `LICENSE` — MIT.
