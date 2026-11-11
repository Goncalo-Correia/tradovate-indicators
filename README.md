# tradovate-indicators

Custom indicators for the [Tradovate custom-indicator API](https://tradovate.github.io/custom-indicators/).

All of them are tagged `tags: ["Custom Indicators"]`, so once pasted into the Code
Explorer they appear together under a single **Custom Indicators** group in Tradovate's
indicator dropdown rather than being scattered among the built-in categories.

| File | Shows in Tradovate as |
|---|---|
| [`indicators/scalpProMeter.js`](indicators/scalpProMeter.js) | Scalp-Pro Meter (PSR) |
| [`indicators/marketMagnet.js`](indicators/marketMagnet.js) | MMC Market Magnet (PSR) |
| [`indicators/atrLevels.js`](indicators/atrLevels.js) | ATR Levels |
| [`indicators/sessionRangeLevels.js`](indicators/sessionRangeLevels.js) | Session Range Levels |
| [`indicators/sessionCountdown.js`](indicators/sessionCountdown.js) | Session Countdown (Asia / London / NY) |
| [`indicators/bigTrades.js`](indicators/bigTrades.js) | Big Trades (bubbles) + Tape Speed |

## Scalp-Pro Meter (PSR)

[`indicators/scalpProMeter.js`](indicators/scalpProMeter.js)

A faithful port of the **"Scalp Pro Meter PSR"** ThinkorSwim indicator by the
*Million-Dollar-Margin Club* (MMC) — the tool used in the "Professor's Live" morning
scalping streams — rebuilt for Tradovate. It renders in its own pane and is designed
for 1-minute scalping.

### What it shows

| Original ThinkorSwim feature | Tradovate port |
|---|---|
| Tall blue volume histogram (total candle volume) | Blue `columns` plot of `volume` |
| Green buyer line/dot + red seller line/dot, positioned by where in the range trading occurred | Green/red `dots` plots at estimated `buyVolume` / `sellVolume` inside each volume bar, each joined by a `singleline` plotter on the same field (a green line through the buy dots, a red line through the sell dots) |
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

HUD placement is not a UI parameter — it lives in the `CONFIG` block at the top of the
file, in pixels measured inward from the corner named by `HUD_CORNER`:

| Constant | Default | Effect |
|---|---|---|
| `HUD_X` / `HUD_TOP` | 12 / 26 | Position of the whole HUD (meter + labels). `HUD_TOP` must stay ≥ ~24 so the meter clears Tradovate's own pane title. |
| `HUD_BOX_W` / `HUD_BOX_H` / `HUD_BOX_GAP` | 12 / 12 / 4 | Strength-meter box size and spacing |
| `HUD_LABEL_INDENT` | 16 | Labels' indent relative to the meter; `0` = flush |
| `HUD_LABEL_GAP` | 14 | Gap between the meter row and the first label |
| `HUD_LINE_H` | 22 | Vertical spacing between label lines |
| `HUD_FONT_MAIN` / `HUD_FONT_SUB` | 13 / 12 | Font sizes |

The TREND row is only shown during an active move but always reserves its slot, so the
VOL row underneath does not jump as the trend appears and disappears.

### Limitations vs the original

- **No audio.** The Tradovate custom-indicator API has no sound primitive, so the
  audible "dings" are reproduced visually (cyan `▲` on a volume spike, trend label on
  an active EMA/VWAP move). For real sound, wire up a Tradovate platform *alert*.
- **VWAP** is the standard session VWAP (resets per trading day, uses the bar's volume
  profile when available, otherwise typical price × volume) — matching the built-in
  Tradovate VWAP.
- **The pane autoscales on the volume series only.** `ema` and `vwap` are returned from
  `map` so the HUD can compare them, but they are price-valued (~22,000 on NQ) and are
  excluded from the axis via `scaler: { type: "multiPath", fields: [...] }`. Without
  that, the pane stretches to fit the price and the volume histogram collapses into a
  sliver along the bottom. If you add another price-valued output, add it to `plots`
  but **not** to `scaler.fields`.
- **A tall volume bar can paint over the HUD labels.** Frame-anchored graphics cannot be
  forced in front: wrapping them in a `Container` with a `ZIndex` transform makes them
  stop rendering altogether (tried and reverted). Give the HUD more clearance by raising
  `HUD_TOP`, or shrink the bars by reserving headroom in `scaler`.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/scalpProMeter.js`](indicators/scalpProMeter.js).
3. Save, then add **"Scalp-Pro Meter (PSR)"** to a chart (it opens in a new pane).
   Best on a 1-minute chart, per the original.

The `require("./tools/...")` calls resolve against Tradovate's bundled SDK modules
(`predef`, `meta`, `EMA`, `graphics`) — the same modules the official examples use — so
no local dependencies are needed inside the platform.

## ATR Levels

[`indicators/atrLevels.js`](indicators/atrLevels.js) ·
TradingView: [`trading-view/atrLevels.pine`](trading-view/atrLevels.pine)

Draws a fan of horizontal ATR-spaced levels anchored to the **current (right-most)
candle**, useful for gauging how far price could travel from where this candle opened in
ATR terms. The ladder re-anchors on every new candle.

### What it shows

- A **center line** at the **open of the newest candle** (amber), labelled `OPEN`.
- **5 lines above and 5 lines below** the center, each spaced by 1× ATR, labelled
  `+1 … +5` / `-1 … -5` just right of the current candle.
- The lines are **infinite horizontals** spanning the chart (set `EXTEND_LEFT = false` to
  have them start at the current candle and run only to the right).
- **Exactly one ladder exists at a time.** It updates on the live candle and re-anchors
  the moment a new candle opens — the previous candle's lines are removed, so the chart
  never accumulates old ladders.
- **Not tied to any session** — the ladder is drawn at all hours on the newest candle.

Spacing uses the ATR through the **previous closed bar**, so the ladder stays perfectly
still while the live candle forms and only jumps at the next open.

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `atrPeriod` | 14 | ATR period (Wilder's smoothing, computed inline) |

The line count, line extension, labels and colours are top-of-file constants (`LINES`,
`EXTEND_LEFT`, `SHOW_LABELS`, `LABEL_EVERY`, `LEVEL_COLOR`, `CENTER_COLOR`) rather than
UI parameters — edit them in the code before pasting.

### Notes / limitations

- **ATR** is computed inline with a simple-average warm-up until `atrPeriod` samples are
  seen, then Wilder's smoothing — no dependency on a `tools/` ATR module.
- **Lines are `graphics`, not `plots`.** A plot holds one value per bar, so an anchor
  that moves with every candle would paint a staircase instead of horizontal lines.
  Emitting infinite `LineSegments` only on the last bar (`global: true`) is what makes
  the previous candle's ladder disappear. The trade-off: no per-line entry in the chart
  legend and **no colour picker in the Tradovate UI** — restyle via the `LEVEL_COLOR` /
  `CENTER_COLOR` / `*_WIDTH` constants at the top of the file.
- Default style is a light, semi-transparent grey at 1px for the ATR lines and amber for
  the center line.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/atrLevels.js`](indicators/atrLevels.js).
3. Save, then add **"ATR Levels"** to a chart (it overlays on the price pane).
   If you had the old **"NY Session ATR Levels"** installed, remove it — it is a
   separate indicator in Tradovate and will not update itself.

## MMC Market Magnet (PSR)

[`indicators/marketMagnet.js`](indicators/marketMagnet.js) ·
TradingView: [`trading-view/marketMagnet.pine`](trading-view/marketMagnet.pine)

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

A volume-by-price profile is built inside each of three **ET windows**, using
`d.profile()` (per-bar volume-by-price levels), keyed by tick:

| Window | Hours (ET) |
|---|---|
| Asia — first 2 hours | 18:00 → 20:00 |
| London — first 2 hours | 03:00 → 05:00 |
| NY — whole regular session | 09:30 → 16:00 |

Each window starts a **fresh profile**; the session starts match Session Range
Levels and Session Countdown. On each candle inside a window it recomputes:

1. **POC** — the price level with the highest accumulated volume ("the magnet").
2. **Value area** — starting at the POC, expand outward adding the larger-volume
   neighbor each step until 50% of total session volume is covered; the top and
   bottom of that band are **VAH** and **VAL**.

The three levels update in real time as the window's distribution evolves.
Outside the windows the plots return nothing (the lines break), and the profile
resets at the start of the next window. Labels name the active window
(`NY MAGNET (POC)`, `LONDON VAH 50%`, …).

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `valueAreaPct` | 50 | Percentage of session volume the value area (VAH/VAL band) must cover |

The windows and the visual toggles are top-of-file constants: `WINDOWS` (ET
minutes-of-day; a window may not cross midnight), `SHOW_LABELS`, `SHOW_ARROWS` / `ARROW_EVERY` (arrow-row density),
and `SHOW_PROFILE` / `PROFILE_COLOR` / `PROFILE_MIN_FRAC` / `PROFILE_MAX_WIDTH_PX`
(the light-blue volume bars).

### Notes / limitations

- **Needs a volume profile.** `d.profile()` is populated when the chart is
  requested with volume histograms. If a bar has no profile, the port falls back
  to a single level at the bar's typical price × volume — coarser, but it still
  runs. For a true profile, enable the volume-profile/histogram option on the chart.
- **Asia and London need extended hours.** On an RTH-only session template those
  bars don't exist, so only the NY window draws.
- **Marketing vs. math discrepancy:** the product page prose calls the bands the
  session's highest/lowest price *reached*, but its formulas define them as the
  50%-value-area edges. This port follows the formulas (the value area), which is
  the standard, useful interpretation.
- **Timezone** is handled without `Intl` (hand-rolled US-Eastern DST).

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/marketMagnet.js`](indicators/marketMagnet.js).
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
  hide them outside 09:30–16:00 ET.
- Label colours follow the dark scheme (graphics items cannot see the active scheme);
  the plot lines themselves have proper light/dark styles.
- **Timezone** is handled without `Intl` (hand-rolled US-Eastern DST), same as
  `marketMagnet.js`.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/sessionRangeLevels.js`](indicators/sessionRangeLevels.js).
3. Save, then add **"Session Range Levels"** to a chart (it overlays on the price pane).
   Use an intraday chart with an **ETH** session template.

## Session Countdown

[`indicators/sessionCountdown.js`](indicators/sessionCountdown.js) ·
TradingView: [`trading-view/sessionCountdown.pine`](trading-view/sessionCountdown.pine)

A small readout pinned to the **bottom-left** of the price chart with one row per
session — Asia, London and New York. Each row shows **OPEN** (green) while that
session is trading, otherwise the time left until it next opens (`3h 12m`,
`1d 4h 05m`).

### Sessions

The futures-trading windows in US Eastern time — the same ones Session Range
Levels uses, so the two indicators agree:

| Session | Hours (ET) | Opens on |
|---|---|---|
| Asia | 18:00 → 03:00 (overnight, starts at the Globex open) | Sun–Thu evenings |
| London | 03:00 → 09:30 | Mon–Fri |
| NY | 09:30 → 16:00 | Mon–Fri |

Hours, open days, labels, colors and HUD placement are top-of-file constants
(`SESSIONS`, `MARGIN_*`, `*_COLOR`) — edit them before pasting. A session whose
close is earlier than its open runs past midnight. Each session can also be set in
Tokyo or London local time via its `tz` field (e.g. the forex Asia session:
`tz: "tokyo", open: "09:00", close: "18:00", openDays: MON_FRI`).

### Notes / limitations

- On a weekend the countdown runs to the next open (Asia: Sunday 18:00 ET).
  **Exchange holidays and early closes are not accounted for.**
- The countdown uses the wall clock (`Date.now()`) on the live bar, so it refreshes
  whenever Tradovate re-runs `map()` on incoming ticks; in a very quiet market it
  can lag until the next tick. Set `USE_WALL_CLOCK = false` to use the last bar's
  timestamp instead (for Replay).

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/sessionCountdown.js`](indicators/sessionCountdown.js).
3. Save, then add **"Session Countdown (Asia / London / NY)"** to a chart (it
   overlays on the price pane). It is listed under **Custom Indicators**.

## Big Trades + Tape Speed

[`indicators/bigTrades.js`](indicators/bigTrades.js) · Tradovate only (no TradingView port yet)

Bubbles where large aggressive volume traded, plus a "FAST" flag when the tape speeds up.

### What it shows

- **Green** = buyers lifting the offer (ask volume); **red** = sellers hitting the bid
  (bid volume).
- Only trades of at least `minSize` contracts (default **50**) are shown, each drawn
  as its **size in bold** at its price (e.g. `64`, `120`). Circles (`Shapes` + `Circle`) did not
  render in Tradovate, so text is the default. `MARKER_STYLE` in CONFIG also offers
  `"square"` (filled squares) and `"polygon"` (12-sided circles) to try.
- **`FAST`** (yellow, above the bar) when that bar's tape speed is at least
  `speedMult` × the average of the previous `speedBars` bars.
- A HUD in the top-right: `TAPE 1.7x avg` for the forming bar, turning yellow with
  `FAST` when it is over the threshold. A second row, `BIG buy N / sell N`, counts the
  big trades being drawn. Two diagnostic rows follow: `SRC` (where the bid / ask split
  comes from: `profile`, `bar` or `none`) and `MAX buy N / sell N in N bars` (the biggest
  buy / sell seen). If MAX stays under `minSize`, no trade that big is on screen.

### What "an order" means here

A custom indicator never sees individual time & sales prints, only bars. For each bar
the indicator reads the bar's volume profile (`d.profile()`: volume at each price,
split into bid / ask volume) and bubbles every price where ask or bid volume reaches
the threshold.

- On a **1-tick chart** every bar is one trade, so a marker really is a single print
  of 50+ contracts. **This is the intended setup.**
- On a time, range or bigger tick chart a bubble means "50+ contracts traded at this
  price inside this bar". On busy markets (NQ / ES on 1-min) that is many prices,
  so raise `minSize` or use a 1-tick chart.
- With no profile on a bar, the whole bar's ask / bid volume is used at its close.
  If the feed gives neither, no bubbles are drawn and the HUD shows `SRC none`.
- Profiles only exist when the chart is requested with a histogram; Tradovate may
  also split one large order into several smaller prints, so 50+ single prints can be rare.
- Iceberg / resting limit orders are not visible. Only the aggressive side of a trade is.

### Tape speed

Speed = contracts per second of a bar (volume ÷ time until the next bar opened; the
forming bar uses the time since it opened). On a time chart every bar lasts the same,
so this is just "volume vs the 10-bar average". On tick / range charts it is a true
rate. Session and weekend gaps are capped at 3× the median bar length so they don't
drag the average down.

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `minSize` | 50 | Only trades of at least this many contracts are shown |
| `speedBars` | 10 | Bars in the speed average |
| `speedMult` | 2 | `FAST` when speed ≥ this × the average |
| `showBuys` / `showSells` | on | Enable each side |
| `showSpeed` | on | Draw `FAST` labels |
| `showHud` | on | Show the HUD |

Colours, circle radii and how many bars back are drawn (`LOOKBACK_BARS`, 2000) are in the
`CONFIG` block at the top of the file.

### Install

1. In Tradovate, open **Chart → Indicators → the code editor (Code Explorer)**.
2. Create a new indicator and paste the contents of
   [`indicators/bigTrades.js`](indicators/bigTrades.js).
3. Save, then add **"Big Trades (bubbles) + Tape Speed"** to a chart, ideally a
   **1-tick** chart. It overlays on the price pane and is listed under **Custom Indicators**.
