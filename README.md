# DCUI Two-Page View

Makes the [DC Universe Infinite](https://www.dcuniverseinfinite.com) web
reader show **two portrait pages side by side** on a landscape screen, like an
open print comic — so casting the Chrome tab to a TV looks right. Installs as
a standalone Chrome extension or as a userscript.

It restyles what the reader already draws. It does not download, save, extract
or re-host artwork, does not touch authentication or decryption, and adds no
network requests of its own. See [FINDINGS.md](FINDINGS.md) for how the reader
works and why this approach was chosen.

> This is an unofficial, fan-made project. It is not affiliated with, endorsed
> by, or supported by DC, Warner Bros. Discovery, or DC Universe Infinite, and
> those names are used only to say what it works with. It requires your own
> DC Universe Infinite subscription and gives access to nothing you have not
> already paid for. Modifying how a site displays may be against that site's
> terms of use; read them and use this at your own discretion.

## Install

There are two ways in. They run the same file and behave identically; pick
one. (Installing both is harmless — the script notices and runs once.)

### As a standalone extension — nothing else to install

1. Download this repository: **Code → Download ZIP** on GitHub, and unzip it
   somewhere you will not delete. (Or `git clone` it.)
2. Open `chrome://extensions` and switch on **Developer mode**, top right.
3. Click **Load unpacked** and choose the unzipped folder — the one that
   contains `manifest.json`.
4. Open any issue in the DCUI web reader. The spread view applies itself.

Works in Chrome 111 or newer, and in Edge and Brave. To update, replace the
folder's contents with a newer download and press the reload arrow on the
extension's card. Chrome may remind you at startup that a developer-mode
extension is running; that is expected for any extension not installed from
the Web Store.

The extension asks for no permissions. It can run on
`dcuniverseinfinite.com/comics/book/*` and nowhere else, and it makes no
network requests.

### As a userscript — updates itself

1. Install [Violentmonkey](https://violentmonkey.github.io/) (open source) or
   [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Open
   [`dcui-two-page.user.js`](https://raw.githubusercontent.com/SamSchmitz98/DualComicReader/main/dcui-two-page.user.js)
   — the manager will offer to install it.
3. Open any issue in the DCUI web reader. The spread view applies itself.

New versions are picked up automatically from this repository.

## Hotkeys

| Key | What it does |
|---|---|
| `T` | Toggle the script on and off. Off restores the reader's stock behavior exactly. |
| `P` | Shift the pairing offset, for books whose numbering does not line up. Default keeps the cover alone; pressing `P` pairs from page 1 instead. |
| `S` | Toggle the fade across page turns. On by default. |
| `D` | Toggle the debug HUD. On a touch device, triple-tap the top-left corner instead. |
| `←` `→` | Move one *spread* at a time (via the page-browser thumbnails — the only synthetic input the reader honors). |
| Swipe / mouse drag | Also moves one spread. Swipe left for the next spread, right for the previous one. |

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
edge, and the neighbouring canvas lands flush against it. The script centers
the pair and hides the third canvas. That is the whole trick — no cropping, no
scaling hacks, and nothing reading pixels back off a canvas.

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

Arrow keys move one spread at a time. The reader's canvas widget ignores
every synthetic keyboard, mouse and touch event, so the script cannot press
its buttons for it — but the page browser's thumbnails are rendered by the
site's Vue layer, and a synthetic click on one of those *does* navigate. The
script clicks the thumbnail for the first page of the next (or previous) row.
See [FINDINGS.md](FINDINGS.md) for how this was established.

The display stays on the correct pair regardless of how the reader got where
it is, because the carousel already holds the page that belongs beside the
current one: when the current page leads its row the spread is
`current + next`, and when it trails its row the spread is
`previous + current`. That also makes a two-page jump look like a single
change — the page it passes through trails the same row, so the screen does
not alter until the destination lands.

A mouse drag or touch swipe also moves a whole spread. The reader handles
that gesture itself and turns one page - half a move - and its drag handling
can be neither driven nor cleanly suppressed from outside. So the script
watches the same gesture, lets the reader do whatever it does, then completes
the move to the row the swipe was asking for, measured from the page the
swipe started on. That is correct whether the reader turned a page or not.

The reader's on-screen buttons and its page browser still move one page at a
time, and the pairing follows wherever they land.

### Smoothness

The reader turns one page at a time and takes roughly 475ms per turn, and it
animates through every page on the way to a destination — so moving a spread
costs two turns however it is asked. Two things keep that from showing:

- **The page in between looks identical.** Going from 96 to 98 passes through
  97, but 97 trails the same row as 96, so the display shows `[96, 97]` the
  whole way and changes once, when 98 lands.
- **Fading.** A content swap in a canvas cannot be animated, so the script
  fades the reader out, moves, and fades back in once the destination has
  landed. The backdrop behind is already black, so it reads as a page turn
  rather than a glitch. Press `S` to turn it off and compare.

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
- **Navigation depends on one hook: a synthetic click on a page-browser
  thumbnail.** If DCUI ever changes that handler, the script cannot turn
  pages itself; it says so in the console and hands the arrow keys back to
  the reader, which then turns one page per press. The pairing keeps working
  either way. `dcui2p.probeNav()` re-tests every hook.
- **A spread advance still costs two reader page turns** (~950ms), since the
  reader animates through the page in between. The display does not change
  until the destination lands, and a brief fade covers the moment the
  neighbouring canvas is redrawn.
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

- `dcui-two-page.user.js` — the script. One file, loaded either by a
  userscript manager or as the extension's content script; it assumes no
  `GM_*` API and falls back to plain-web equivalents (`localStorage`, the
  async clipboard) when none is present.
- `manifest.json` — makes this folder loadable as an unpacked Chrome
  extension. It lives at the repository root so the extension runs the same
  file rather than a copy.
- `tools/check-version.js` — the version appears in the userscript header, in
  the script's fallback constant and in the manifest. `node
  tools/check-version.js` verifies they agree; `node tools/check-version.js
  1.2.3` sets all three.
- `tools/test-swipe.js` — drags and swipes: that one gesture moves one spread
  whether the reader itself turns a page in response or not, and that clicks,
  vertical drags, slow pans and drags on buttons or open modals are left
  alone.
- `tools/test-fresh-install.js` — simulates a brand-new install (empty
  storage, no userscript APIs), presses an arrow key and checks that the
  script takes it and jumps to the right page. It exists because the author's
  copy always has remembered settings, so a bug that only affects new installs
  is invisible without it.
- `FINDINGS.md` — how the reader renders pages, navigates, and exposes page
  metadata; the investigation behind the implementation.
- `LICENSE` — MIT.
