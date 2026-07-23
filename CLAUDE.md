# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of custom indicators for the [Tradovate custom-indicator API](https://tradovate.github.io/custom-indicators/). Each file in `indicators/` is a **self-contained JavaScript module** that gets pasted, as-is, into Tradovate's in-platform Code Explorer (Chart → Indicators → code editor). There is no build step, no bundler, no `package.json`, and no local dependencies — the `require("./tools/...")` calls resolve against Tradovate's own bundled SDK at runtime inside the platform.

Because of this, **do not add npm dependencies or split an indicator across multiple local files.** Each indicator must remain one paste-able module. `require("lodash")` is available inside the platform if needed.

## Testing / verifying changes

There is no test runner in the repo. Indicators are validated by pasting into Tradovate and adding them to a chart. Logic-only changes (ATR math, VWAP, time/session handling) can be checked with a throwaway local Node harness that **stubs the `./tools/*` modules** (`predef`, `meta`, `EMA`, `graphics`) and feeds synthetic bars — put such harnesses in the scratchpad, not in the repo. Do not commit stubs or a `tools/` directory: those names must resolve to Tradovate's bundled modules, not local ones.

## Module contract (the shape every indicator must follow)

`module.exports` is an object; the important keys:

- `name`, `description` — identity shown in Tradovate.
- `calculator` — a class with `init()` (allocate/reset per-series state) and `map(d, index, history)` (called **once per closed bar**, in order). `map` returns either a number or an object whose keys match `plots`; the returned object may also carry `graphics`, `style`, `candlestick`.
- `params` — built with `predef.paramSpecs.*` (`period`, `number`, `percent`, `bool`, `enum`, `color`, ...). Read at runtime as `this.props.<paramName>`.
- `plots` — declares the named output series. `map`'s return object populates these by key.
- `plotter` / `plotters` — how plots are drawn: `predef.plotters.columns(field)`, `dots(field)`, `line`, `histogram`, etc. Can be an **array** of plotter definitions.
- `schemeStyles: { dark: {...}, light: {...} }` — per-plot color/width; supply both schemes.
- Optional: `inputType` (`meta.InputType.BARS`), `areaChoice` (`meta.AreaChoice.NEW` for its own pane vs `OVERLAY`), `tags`, `validate`.

### Bar accessors (`d`) worth knowing
`d.open/high/low/close/volume()`, `d.timestamp()` (a Date), `d.tradeDate()` (changes at each session boundary — use it to reset session accumulators), `d.isLast()`, `d.index()`, `d.profile()` (volume-profile levels). `d.offerVolume()/d.bidVolume()` give **real** per-bar bid/ask delta when the feed provides it. `history.prior()/last()/first()/back(n)` reach earlier bars.

## Cross-cutting patterns established here

These conventions are shared across the existing indicators — follow them for consistency:

- **Fixed HUD overlay:** to pin an on-screen readout to the pane, return `graphics: { items: [...] }` from `map`, gate it on `d.isLast()` so only the latest bar draws it, and mark each item `global: true` with `origin: { cs: "frame", h: "left", v: "top" }`. Coordinates use helpers from `./tools/graphics` — `px(v)` (pixels), `du(v)` (domain/price units), `op(a, '-', b)`. `Shapes` primitives (`Rectangle`, etc.) position by their **center** and take one `fillStyle` per group; `Text` items take `point`, `text`, `style`, `textAlignment`. See `mmcScalpProMeter.js`'s `hud()`.
- **Session VWAP:** accumulate `volume * typicalPrice` (prefer `d.profile()` levels when present) and reset the accumulators whenever `d.tradeDate()` changes. See `mmcScalpProMeter.js`'s `vwap()`.
- **Self-contained indicators / ET session handling:** avoid `Intl` for timezones (not reliably available). `nySessionAtrLevels.js` computes US Eastern offset with hand-rolled DST rules (2nd Sunday of March → 1st Sunday of November) and derives a `dayKey`/`minutes` from the bar timestamp to detect the NY regular session (09:30–16:00 ET) and re-anchor at each new session open. Reuse that approach rather than pulling in a date library.
- **Inline TA math over `tools/`:** when a `tools/` module's signature is uncertain, compute the indicator inline (e.g. `nySessionAtrLevels.js` implements Wilder-smoothed ATR itself, with a warm-up simple-average phase) so the module stays portable. `EMA` is the one commonly required helper (`const EMA = require("./tools/EMA"); this.e = EMA(period); this.e(value)`).
- **Top-of-file config block + doc comment:** each indicator opens with a block comment explaining behavior and limitations, and tunable constants live in a clearly marked `CONFIG` section near the top.

## Existing indicators

- `indicators/mmcScalpProMeter.js` — port of the ThinkorSwim "Scalp Pro Meter PSR" (Million-Dollar-Margin Club). Volume histogram + estimated buy/sell dots + a fixed HUD (strength meter, buy/sell %, EMA-vs-VWAP trend, volume-spike flag). See `README.md` for the full feature mapping, the close-in-range buy/sell estimate, and how to swap in real delta via `d.offerVolume()/d.bidVolume()`.
- `indicators/nySessionAtrLevels.js` — draws a center line at the NY session open plus 10 ATR-spaced lines above and below, only during 09:30–16:00 ET, re-anchoring each session.
