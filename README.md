# tradovate-indicators

Custom indicators for the [Tradovate custom-indicator API](https://tradovate.github.io/custom-indicators/).

## MMC Scalp-Pro Meter (PSR)

[`indicators/mmcScalpProMeter.js`](indicators/mmcScalpProMeter.js)

A faithful port of the **"Scalp Pro Meter PSR"** ThinkorSwim indicator by the
*Million-Dollar-Margin Club* (MMC) — the tool used in the "Professor's Live" morning
scalping streams — rebuilt for Tradovate. It renders in its own pane and is designed
for 1-minute scalping.

### What it shows

| Original ThinkorSwim feature | Tradovate port |
|---|---|
| Tall blue volume histogram (total candle volume) | Blue `columns` plot of `volume` |
| Green buyer line/dot + red seller line/dot, positioned by where in the range trading occurred | Green/red `dots` plots at estimated `buyVolume` / `sellVolume` inside each volume bar |
| 10-box green/red directional strength meter | Fixed HUD (top-left of pane): 10 boxes split green(buy)/red(sell) by the current candle's buy % |
| Buy/Sell % label — green / red / yellow (balanced) | `BUY x%  SELL y%` label, colored by dominance (yellow inside the balance band) |
| 14-EMA vs VWAP trend label, hidden when price stalls | `TREND ▲ EMA > VWAP` / `▼ EMA < VWAP`, shown only during an active move (correct side **and** EMA slope agrees); hidden otherwise |
| Volume feedback + audio "ding" on a volume spike | Volume label turns **cyan** and shows `▲` when the current candle's volume exceeds the previous candle's |

### How the buy/sell split is computed

Exactly like the original: it's an **estimate** from where the close sits inside the
candle's range.

```
buyFraction  = (close - low) / (high - low)   // close near high => buyers in control
sellFraction = 1 - buyFraction
buyVolume    = volume * buyFraction
sellVolume   = volume * sellFraction
```

This is *not* true order-flow. Tradovate does expose real per-bar delta via
`d.offerVolume()` / `d.bidVolume()`, so if you have a data feed that provides it you
can get a genuine buy/sell split by replacing the block above with:

```js
const buyVolume  = d.offerVolume();          // traded at the ask = buyers
const sellVolume = d.bidVolume();            // traded at the bid = sellers
const denom      = buyVolume + sellVolume;
const buyFrac    = denom > 0 ? buyVolume / denom : 0.5;
```

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `emaPeriod` | 14 | EMA period compared against session VWAP |
| `meterBoxes` | 10 | Number of boxes in the strength meter |
| `balanceThreshold` | 6 | How close to 50/50 (in %) counts as "balanced" (yellow label) |

### Limitations vs the original

- **No audio.** The Tradovate custom-indicator API has no sound primitive, so the
  audible "dings" are reproduced visually (cyan `▲` on a volume spike, trend label on
  an active EMA/VWAP move). For real sound, wire up a Tradovate platform *alert*.
- **VWAP** is the standard session VWAP (resets per trading day, uses the bar's volume
  profile when available, otherwise typical price × volume) — matching the built-in
  Tradovate VWAP.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/mmcScalpProMeter.js`](indicators/mmcScalpProMeter.js).
3. Save, then add **"MMC Scalp-Pro Meter (PSR)"** to a chart (it opens in a new pane).
   Best on a 1-minute chart, per the original.

The `require("./tools/...")` calls resolve against Tradovate's bundled SDK modules
(`predef`, `meta`, `EMA`, `graphics`) — the same modules the official examples use — so
no local dependencies are needed inside the platform.

## NY Session ATR Levels

[`indicators/nySessionAtrLevels.js`](indicators/nySessionAtrLevels.js)

Draws a fan of horizontal ATR-spaced levels anchored to the New York regular session,
useful for gauging how far price has travelled from the open in ATR terms.

### What it shows

- A **center line** anchored to the **open of the first NY-session candle** (09:30 ET).
- **10 lines above and 10 lines below** the center, each spaced by 1× ATR.
- Levels are drawn **only during the NY regular session** (09:30–16:00 ET). Outside the
  session the plots return nothing, so the lines break; they re-anchor automatically at
  the next NY open.

The center price and ATR spacing are captured at the session open. By default
(`DYNAMIC_ATR = true`) the spacing tracks the latest ATR on every candle close while the
center stays anchored; set `DYNAMIC_ATR = false` to freeze the spacing at the open so all
21 lines are perfectly flat for the whole session.

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `atrPeriod` | 14 | ATR period (Wilder's smoothing, computed inline) |

The line count, session hours, and the dynamic/fixed-spacing mode are top-of-file
constants (`LINES`, `SESSION_OPEN_MIN`, `SESSION_CLOSE_MIN`, `DYNAMIC_ATR`) rather than
UI parameters — edit them in the code before pasting.

### Notes / limitations

- **Timezone** is handled without `Intl`: US Eastern offset is derived from hand-rolled
  DST rules (2nd Sunday of March → 1st Sunday of November), so it is correct for US
  Eastern trading but not parameterized for other zones.
- **ATR** is computed inline with a simple-average warm-up until `atrPeriod` samples are
  seen, then Wilder's smoothing — no dependency on a `tools/` ATR module.
- Default line style is a light, semi-transparent grey at 1px width; adjust per-plot
  styling in the Tradovate UI after adding it.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/nySessionAtrLevels.js`](indicators/nySessionAtrLevels.js).
3. Save, then add **"NY Session ATR Levels"** to a chart (it overlays on the price pane).

## MMC Market Magnet (PSR)

[`indicators/mmcMarketMagnet.js`](indicators/mmcMarketMagnet.js)

A port of the *Million-Dollar-Margin Club* **"Market Magnet / Market Magnet PSR"**
ThinkorSwim indicator. Despite the "magnetic force" marketing, it is a **session
volume profile** — their own published formulas confirm it.

### What it shows

| Original ThinkorSwim feature | Tradovate port |
|---|---|
| "Magnet" — solid magenta line, the gravitational center | **Point of Control (POC)**: the session price level with the most volume (`argmax Vᵢ`) |
| "50% Volume Zone" | A **value area** covering 50% of the session's volume (`V₅₀% = 0.50·V_total`) |
| High Band — green dashed line | **Value Area High (VAH)**: top of the 50% zone |
| Low Band — red dashed line | **Value Area Low (VAL)**: bottom of the 50% zone |
| Peak Zone (green ▼ arrows) / Trough Zone (red ▲ arrows) | A row of green down-arrows along the VAH and red up-arrows along the VAL, one per bar, tracing the two bands across the session |
| Light-blue volume bars stretching across the screen | The session volume profile drawn as full-width, translucent light-blue horizontal bars whose thickness and opacity scale with volume (drawn on the last bar) |
| "Magnet / 50%" chart labels | `MAGNET (POC)`, `VAH 50%`, `VAL 50%` labels at the last bar |

### How it works

The volume-by-price profile is accumulated across the **NY regular session
(09:30–16:00 ET)** using `d.profile()` (per-bar volume-by-price levels), keyed by
tick. On each candle it recomputes:

1. **POC** — the price level with the highest accumulated volume ("the magnet").
2. **Value area** — starting at the POC, expand outward adding the larger-volume
   neighbor each step until 50% of total session volume is covered; the top and
   bottom of that band are **VAH** and **VAL**.

The three levels update in real time as the day's distribution evolves and
re-anchor each session. Outside the session the plots return nothing (the lines
break), and the profile resets at the next NY open.

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `valueAreaPct` | 50 | Percentage of session volume the value area (VAH/VAL band) must cover |

Session hours and the visual toggles are top-of-file constants: `SESSION_OPEN_MIN`,
`SESSION_CLOSE_MIN`, `SHOW_LABELS`, `SHOW_ARROWS` / `ARROW_EVERY` (arrow-row density),
and `SHOW_PROFILE` / `PROFILE_COLOR` / `PROFILE_MIN_FRAC` / `PROFILE_MAX_WIDTH_PX`
(the light-blue volume bars).

### Notes / limitations

- **Needs a volume profile.** `d.profile()` is populated when the chart is
  requested with volume histograms. If a bar has no profile, the port falls back
  to a single level at the bar's typical price × volume — coarser, but it still
  runs. For a true profile, enable the volume-profile/histogram option on the chart.
- **Marketing vs. math discrepancy:** the product page prose calls the bands the
  session's highest/lowest price *reached*, but its formulas define them as the
  50%-value-area edges. This port follows the formulas (the value area), which is
  the standard, useful interpretation.
- **Timezone** is handled without `Intl` (hand-rolled US-Eastern DST), same as
  `nySessionAtrLevels.js`.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/mmcMarketMagnet.js`](indicators/mmcMarketMagnet.js).
3. Save, then add **"MMC Market Magnet (PSR)"** to a chart (it overlays on the
   price pane). Best on an intraday chart with volume profile enabled.

## Session Range Levels

[`indicators/sessionRangeLevels.js`](indicators/sessionRangeLevels.js)

Eight horizontal levels marking the high and low of each major trading session, each
with a short label at the right edge so the lines can be told apart at a glance.

### What it shows

| Level | Label | Window (ET) | Colour |
|---|---|---|---|
| Asia high / low | `ASH` / `ASL` | 18:00 → 03:00 | purple |
| London high / low | `LOH` / `LOL` | 03:00 → 09:30 | blue |
| Pre-market high / low | `PMH` / `PML` | 04:00 → 09:30 | orange |
| **Previous** US session high / low | `PDH` / `PDL` | 09:30 → 16:00 (prior day) | grey |

Highs are solid, lows are dashed, in the same colour — so session identity reads as
colour and high-vs-low reads as line style.

Each level **updates live while its window is open and freezes when the window closes**,
so during the US session all eight lines are flat. A line is drawn from the bar where its
level first existed up to the current bar, so the left end of each line marks when that
session began.

Pre-market (04:00–09:30) deliberately **overlaps** London (03:00–09:30): they are two
independently tracked ranges, not a partition of the night.

### How it works

The **trading day rolls at 18:00 ET** (the futures open), not at midnight, so
Asia → London → pre-market → US all fall inside one trading day in that order and Asia
can span midnight without special-casing. When the day rolls, the US session that just
closed becomes `PDH`/`PDL`; today's US range is accumulated only so it can become
tomorrow's previous-session level.

Plots, scheme styles and the on/off parameters are all derived from a single `SESSIONS`
config array at the top of the file — adding or re-timing a session is a one-object edit.

Labels are staggered into **one horizontal column per session** rather than being nudged
apart vertically. Because pre-market sits inside London's window, `PMH` and `LOH` are
often at the same price, and there is no way to convert a price gap into a pixel gap
without knowing the chart's zoom at map time; columns are scale-free and deterministic.
Set `LABEL_STAGGER = false` to stack them all at one x.

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `showAsia` | on | Draw `ASH` / `ASL` |
| `showLondon` | on | Draw `LOH` / `LOL` |
| `showPremarket` | on | Draw `PMH` / `PML` |
| `showPrevUs` | on | Draw `PDH` / `PDL` |

Session windows, colours, label text, and label placement are top-of-file constants
(`SESSIONS`, `LABEL_*`, `DRAW_ONLY_IN_RTH`, `MAX_BAR_MINUTES`) rather than UI
parameters — edit them in the code before pasting.

### Notes / limitations

- **The chart must include electronic trading hours.** On an RTH-only session template
  the overnight bars do not exist and the Asia / London / pre-market lines will never
  appear. This is the most likely cause of "nothing is drawing".
- **Bars must be ≤ 60 minutes** (`MAX_BAR_MINUTES`). On coarser bars a single bar
  straddles several session windows and the levels would be meaningless, so the
  indicator deliberately draws nothing.
- `PDH`/`PDL` are undefined until one full US session has been seen. On the first
  trading day of the loaded history they may reflect a US session truncated by where
  the chart data begins.
- By default every known level stays drawn all day. Set `DRAW_ONLY_IN_RTH = true` to
  hide them outside 09:30–16:00 ET, matching `nySessionAtrLevels.js`.
- Label colours follow the dark scheme (graphics items cannot see the active scheme);
  the plot lines themselves have proper light/dark styles.
- **Timezone** is handled without `Intl` (hand-rolled US-Eastern DST), same as
  `nySessionAtrLevels.js`.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/sessionRangeLevels.js`](indicators/sessionRangeLevels.js).
3. Save, then add **"Session Range Levels"** to a chart (it overlays on the price pane).
   Use an intraday chart with an **ETH** session template.
