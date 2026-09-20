# Brief: Two-page view for the DC Universe Infinite web reader

## Goal

Build a Tampermonkey/Violentmonkey userscript (`dcui-two-page.user.js`) that makes the DC Universe Infinite (DCUI) web comic reader show **two portrait pages side by side** on landscape screens, like an open print comic. The result should look right when the Chrome tab is cast to a TV.

## Hard constraints

- **Restyle only what the browser already renders.** Do not download, save, extract, or re-host page images. Do not touch auth tokens, decryption, or the reader's network layer. If the only way to do something involves circumventing DRM, stop and report instead.
- Zero external dependencies. One self-contained `.user.js` file.
- Nothing runs on any page except the DCUI reader (`@match` accordingly).
- Must be a no-op when disabled (toggle hotkey), leaving the reader's stock behavior intact.

## Phase 1 — Investigate before writing code

I'll paste DOM snippets and/or screenshots from the reader when you ask. Establish:

1. How pages are rendered: `<img>` elements? A `<canvas>` drawn one page at a time? Something else?
2. Whether all pages exist in the DOM at once (scroll container) or only the current one.
3. How the reader's own prev/next works (buttons, arrow keys, swipe) and what state it keeps.
4. How a two-page spread appears (single wide image? two images?).

Write up findings in `FINDINGS.md` and recommend one of the two approaches below before implementing.

## Phase 2 — Implement

### Approach A: pages are `<img>` in a container (preferred, simplest)

- Inject CSS: container becomes a flex row-wrap; each page `width: 50%; object-fit: contain; max-height: 100vh`.
- Use `MutationObserver` so the layout survives the reader re-rendering, lazy-loading, or changing issues.

### Approach B: reader draws one page at a time (canvas or single element)

- Build an overlay container that shows two pages, sourced from whatever the reader already has in memory/DOM (e.g., cloning the current canvas and triggering the reader's own "next" to obtain the second). Prefer hooking the reader's existing navigation over reimplementing it.
- If this can't be done without touching image fetching or DRM, stop and report.

### Behavior (both approaches)

- **Spread detection:** any page whose rendered aspect ratio is wider than tall gets its own row at full width.
- **Parity:** covers stand alone, so default pairing is `[1]`, `[2,3]`, `[4,5]`, … Hotkey **`P`** shifts the offset by one for books whose numbering doesn't line up.
- **Navigation:** left/right arrows move one *pair* at a time. Don't break the reader's own controls.
- **Toggle:** hotkey **`T`** enables/disables the whole script. Remember the setting per-site in `GM_setValue`/`localStorage`.
- **Reading direction:** left-to-right only (Western comics); no RTL needed.
- Background black, pages centered, no gap larger than ~8px between the pair.

## Deliverables

- `dcui-two-page.user.js` with a proper userscript header (`@name`, `@match`, `@version`, `@grant`).
- `FINDINGS.md` (Phase 1 results).
- `README.md`: install steps, hotkeys, known limitations.

## Acceptance

- Open any issue in the DCUI web reader on a 16:9 window: two pages shown side by side, cover alone, spreads full width.
- Arrow keys page through pairs; `P` fixes off-by-one pairing; `T` returns the reader to stock behavior.
- Casting the Chrome tab to a TV shows the same layout.
- No network requests added by the script.

## Working style

Explain the non-obvious choices (why the observer, how you're hooking navigation) in short comments — I want to understand the script, not just run it. Ask me for DOM/screenshot info rather than guessing at selectors.
