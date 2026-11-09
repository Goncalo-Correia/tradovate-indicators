// ============================================================================
// Signal — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Buy / sell entries from the Scalp-Pro trend. "Trend" is the same rule
// scalpProMeter.js uses:
//
//     bullish (green) = EMA(14) > session VWAP  AND  EMA rising vs previous candle
//     bearish (red)   = EMA(14) < session VWAP  AND  EMA falling vs previous candle
//     5-min trends always use this full rule. The ENTRY candle's trend (1-min
//     candle on a 1-min / range chart, the 5-min candle itself on a 5-min chart)
//     drops the EMA-slope half unless `requireSlope` is on. With the slope
//     required, signals were ~20x rarer in testing (1.1 vs 22.2 per 1,000 bars),
//     because a rising EMA needs the close above it, which a dip to the range
//     bottom almost never has.
//
// The chart type is detected from the spacing of its bars:
//
// 1-MIN CHART or TICK / RANGE CHART (e.g. 22-tick range) — 5m + 1m mode.
//   The indicator only sees the chart's own bars, so it builds 1-min candles by
//   grouping the bars by the minute of their timestamp, and 5-min candles from
//   those. On a 1-min chart each bar is its own 1-min candle. BUY fires on the
//   first 1-min candle of a new 5-min candle when all hold:
//     1. the 5-min candle that just closed was bullish,
//     2. the 1-min candle that closed together with it was bullish,
//     3. the new (forming) 5-min candle is bullish, evaluated with this 1-min
//        close as its provisional close               (param: requireLive5m),
//     4. that first 1-min candle closes bullish,
//     5. and its LOW reached the BOTTOM of the recent range — the lowest
//        `zonePct`% of the high/low of the last `rangeBars` 1-min candles
//        (this one included).
//   At most one BUY and one SELL per 5-min candle. With `allowLaterEntry` on,
//   any later 1-min candle in the same 5-min candle may trigger instead.
//
// 5-MIN CHART — 5m-only mode. No 1-min data exists on this chart, so:
//     1. the previous 5-min candle closed bullish (full rule),
//     2. this 5-min candle closes bullish (slope per `requireSlope`),
//     3. and its LOW reached the bottom `zonePct`% of the last `rangeBars`
//        5-min candles.
//   `requireLive5m` and `allowLaterEntry` do not apply.
//
// SELL is always the exact mirror: bearish trends, HIGH in the TOP zone.
// Any other chart (2-min, 15-min, ...) shows a warning and draws no signals.
//
// CONFIRMED ON CLOSE: Tradovate re-runs map() on every tick of the live bar,
// so a candle is only judged once it has closed — i.e. once a bar from the
// next minute (or the next 5-min bar) appears. On a range chart that can be a
// little after the minute ends. The marker (green "B" below the low / red "S"
// above the high) is drawn on the chart bar that made that candle's low /
// high, and never repaints. All state is stored by bar / candle number, so
// repeated map() calls on the same bar are harmless.
//
// Limitations:
//   * Assumes d.timestamp() is the bar's OPEN time; on a range chart a bar is
//     counted in the minute it opened in, so a bar spanning a minute boundary
//     adds its whole range and close to the earlier minute.
//   * EMA is seeded with the first close, so the first ~30 candles of history
//     may differ slightly from Scalp-Pro's EMA; after warm-up they converge.
//   * No sound — use Tradovate's own alerts / the HUD.
//
// Depends only on ./tools/predef, ./tools/meta and ./tools/graphics.
// ============================================================================

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ============================== CONFIG ======================================
const HTF_MINUTES = 5;              // higher timeframe

const BUY_COLOR = "#22c55e";
const SELL_COLOR = "#ef4444";
const NEUTRAL_COLOR = "#9ca3af";
const WARN_COLOR = "#eab308";

const MARKER_FONT = 13;             // size of the "B" / "S" letters
const MARKER_GAP = 4;               // gap between candle wick and the letter (px)
const MAX_MARKERS = 500;            // most recent signals kept on the chart

const HUD_CORNER = { cs: "frame", h: "left", v: "top" };
const HUD_X = 10;                   // px from the pane's left edge
const HUD_TOP = 14;                 // y-centre of the first row (px)
const HUD_LINE_H = 17;              // row spacing (px)
const HUD_FONT = 12;
// ============================================================================

const MINUTE_MS = 60 * 1000;
const HTF_MS = HTF_MINUTES * MINUTE_MS;

// Two candle pipelines run side by side on every chart; the chart type picks
// which one is shown. "mtf" = 1-min candles (+ 5-min candles built from them),
// "htf" = the chart's own bars taken as 5-min candles.
const MODES = ["mtf", "htf"];

function gcd(a, b) {
    while (b) [a, b] = [b, a % b];
    return a;
}

class Signal {
    init() {
        this.alpha = 2 / (this.props.emaPeriod + 1);
        this.states = [];           // per chart bar, indexed by map()'s `index`
        this.gapGcd = 0;            // GCD of all gaps between bar timestamps (ms); 0 = none yet
        this.offMinute = false;     // saw a bar not opening on a whole minute
        // per pipeline: closed-candle states by candle number, and confirmed signals
        this.eng = {};
        for (const m of MODES) this.eng[m] = { states: [], signals: {} };
    }

    emaStep(prev, value) {
        return prev === undefined ? value : prev + this.alpha * (value - prev);
    }

    // +1 bullish, -1 bearish, 0 neither (Scalp-Pro trend rule).
    // needSlope = false drops the "EMA rising / falling" half, leaving EMA vs VWAP.
    trend(ema, prevEma, vwap, needSlope = true) {
        if (prevEma === undefined) return 0;
        if (ema > vwap && (!needSlope || ema > prevEma)) return 1;
        if (ema < vwap && (!needSlope || ema < prevEma)) return -1;
        return 0;
    }

    // "mtf" on 1-min and tick / range charts, "htf" on a 5-min chart, "wrong" otherwise.
    // Decided from the greatest common divisor of all gaps between bars: on a time
    // chart every gap is a multiple of the bar period (weekends included), so the
    // GCD is that period. Tick / range bars come at irregular times, so their GCD
    // drops to 1 min or less — whether Tradovate stamps them to the millisecond or
    // rounds them to the second / minute, and however slowly they form.
    chartMode() {
        // Also: time bars always open exactly on a whole minute, so any off-minute
        // timestamp means tick / range bars too.
        const g = this.gapGcd;
        if (this.offMinute || g === 0 || g <= MINUTE_MS) return "mtf";
        if (g === HTF_MS) return "htf";
        return "wrong";
    }

    // Judges one candle `c` given the previous closed candle's state `prev`.
    // Pure: reads only earlier closed candles, so it is also used for the
    // still-forming candle shown in the HUD.
    judge(c, prev, mode, n) {
        const props = this.props;
        const ema1 = this.emaStep(prev && prev.ema1, c.c);
        // entry-candle trend: slope optional (`=== true`, so an unset prop means off)
        const trend1 = this.trend(ema1, prev && prev.ema1, c.vwap, props.requireSlope === true);
        const trendFull = this.trend(ema1, prev && prev.ema1, c.vwap, true);

        let inWindow, setup, liveOk, buyFiredBefore = false, sellFiredBefore = false;
        let ema5Closed, trend5Closed = 0, trend1AtHtfClose = 0, ema5Live, trend5Live = 0;
        const htf = c.htf;
        const newHtf = !prev || prev.htf !== htf;

        if (mode === "mtf") {
            // A new 5-min bucket means the previous candle's forming 5-min candle
            // has closed: its provisional EMA / trend become final.
            if (prev && newHtf) {
                ema5Closed = prev.ema5Live;
                trend5Closed = prev.trend5Live;
                trend1AtHtfClose = prev.trend1;
            }
            else if (prev) {
                ema5Closed = prev.ema5Closed;
                trend5Closed = prev.trend5Closed;
                trend1AtHtfClose = prev.trend1AtHtfClose;
            }
            // forming 5-min candle, using this 1-min close as its provisional close
            ema5Live = this.emaStep(ema5Closed, c.c);
            trend5Live = this.trend(ema5Live, ema5Closed, c.vwap);

            buyFiredBefore = !newHtf && !!prev && prev.buyFiredInHtf;
            sellFiredBefore = !newHtf && !!prev && prev.sellFiredInHtf;
            inWindow = (newHtf && !!prev) || (props.allowLaterEntry === true && !newHtf);
            setup = (dir) => trend5Closed === dir && trend1AtHtfClose === dir;
            liveOk = (dir) => props.requireLive5m === false || trend5Live === dir;
        }
        else {
            // 5-min chart: previous 5-min candle (full rule) + this one (trend1)
            inWindow = true;
            setup = (dir) => !!prev && prev.trendFull === dir;
            liveOk = () => true;
        }

        // Range zone — measured with the candle's WICK, not its close: B needs this
        // candle's LOW in the bottom zone, S its HIGH in the top zone (a close in
        // the bottom zone is almost never above the EMA, so close-based ~never fires).
        let rangeHigh = c.h, rangeLow = c.l;
        const closed = this.eng[mode].states;
        for (let k = Math.max(0, n - this.props.rangeBars + 1); k < n; ++k) {
            const st = closed[k];
            if (!st) continue;
            if (st.high > rangeHigh) rangeHigh = st.high;
            if (st.low < rangeLow) rangeLow = st.low;
        }
        const span = rangeHigh - rangeLow;
        const pos = (p) => span > 0 ? (p - rangeLow) / span : 0.5;
        const rangePos = pos(c.c);
        const lowPos = pos(c.l);
        const highPos = pos(c.h);
        const zone = props.zonePct / 100;
        const atBottom = lowPos <= zone;
        const atTop = highPos >= 1 - zone;

        const buy = !!(props.showBuy !== false && inWindow && !buyFiredBefore &&
            setup(1) && liveOk(1) && trend1 === 1 && atBottom);
        const sell = !!(props.showSell !== false && inWindow && !sellFiredBefore &&
            setup(-1) && liveOk(-1) && trend1 === -1 && atTop);

        let lastSignal = prev ? prev.lastSignal : null;
        if (buy) lastSignal = { dir: 1, bar: c.lowI };
        else if (sell) lastSignal = { dir: -1, bar: c.highI };

        return {
            htf, ema1, trend1, trendFull,
            ema5Closed, trend5Closed, trend1AtHtfClose, ema5Live, trend5Live,
            buy, sell,
            buyFiredInHtf: buyFiredBefore || buy,
            sellFiredInHtf: sellFiredBefore || sell,
            lastSignal,
            rangePos, lowPos, highPos,
            high: c.h, low: c.l
        };
    }

    // Moves one pipeline forward by chart bar i. When the bar starts a new candle
    // (key changed), the previous candle is closed: it is judged and stored as
    // candle number n. Keyed by n, so tick re-runs of bar i just rewrite it.
    advance(mode, p, key, d, i, x, vwap) {
        let n = p ? p.n : 0;
        if (p && p.form.key !== key) {
            const eng = this.eng[mode];
            const c = p.form;
            const st = this.judge(c, n > 0 ? eng.states[n - 1] : undefined, mode, n);
            eng.states[n] = st;
            if (st.buy) eng.signals[n] = { dir: 1, price: c.l, x: c.lowX };
            else if (st.sell) eng.signals[n] = { dir: -1, price: c.h, x: c.highX };
            else delete eng.signals[n];
            n++;
        }
        const high = d.high(), low = d.low();
        let form;
        if (p && p.form.key === key) {
            const f = p.form;
            form = { ...f };
            if (high > f.h) { form.h = high; form.highI = i; form.highX = x; }
            if (low < f.l) { form.l = low; form.lowI = i; form.lowX = x; }
        }
        else {
            form = { key, h: high, l: low, highI: i, highX: x, lowI: i, lowX: x };
        }
        form.c = d.close();
        form.vwap = vwap;
        // 5-min bucket of this candle: from its minute (mtf) or its own timestamp (htf)
        form.htf = mode === "mtf" ? Math.floor(key / HTF_MINUTES) : Math.floor(d.timestamp().getTime() / HTF_MS);
        return { n, form };
    }

    map(d, index, history) {
        // Bookkeeping uses map()'s `index` argument, NOT d.index(): keying state by
        // d.index() left every bar without a predecessor in Tradovate. d.index() is
        // only used as the x position for drawing (as the other indicators do).
        const i = index;
        const dx = d.index();
        const x = typeof dx === "number" && isFinite(dx) ? dx : i;
        const ts = d.timestamp().getTime();

        const prev = i > 0 ? this.states[i - 1] : undefined;

        // chart-type detection (see chartMode); uses our own stored timestamps
        if (ts % MINUTE_MS !== 0) this.offMinute = true;
        if (prev) {
            const gap = Math.round(Math.abs(ts - prev.ts));
            if (gap > 0) this.gapGcd = gcd(this.gapGcd, gap);
        }

        // --- session VWAP over the chart's bars (same accumulation as scalpProMeter.js) ---
        const tradeDate = d.tradeDate();
        let vNum = 0, vDen = 0;
        if (prev && prev.tradeDate === tradeDate) {
            vNum = prev.vNum;
            vDen = prev.vDen;
        }
        const profile = d.profile();
        if (profile && profile.length) {
            for (let k = 0; k < profile.length; ++k) {
                vNum += profile[k].vol * profile[k].price;
                vDen += profile[k].vol;
            }
        }
        else {
            const typical = (d.high() + d.low() + d.close()) / 3;
            vNum += d.volume() * typical;
            vDen += d.volume();
        }
        const vwap = vDen ? vNum / vDen : d.close();

        const s = {
            ts, tradeDate, vNum, vDen,
            mtf: this.advance("mtf", prev && prev.mtf, Math.floor(ts / MINUTE_MS), d, i, x, vwap),
            htf: this.advance("htf", prev && prev.htf, i, d, i, x, vwap)
        };
        this.states[i] = s;

        // Everything is drawn from the last bar only, as single-render items.
        const items = [];
        if (d.isLast()) {
            const mode = this.chartMode();
            if (mode !== "wrong") {
                const sigs = this.eng[mode].signals;
                const idx = Object.keys(sigs).map(Number).sort((a, b) => a - b).slice(-MAX_MARKERS);
                for (const k of idx) items.push(this.marker(`${mode}${k}`, sigs[k]));
            }
            if (this.props.showHud !== false) items.push(...this.hud(s, i, mode));
        }

        // Assign graphics on every bar (false = nothing) so no stale copies linger.
        return { graphics: items.length ? { items } : false };
    }

    // "B" below the candle low (buy) / "S" above the candle high (sell)
    marker(key, sig) {
        const buy = sig.dir === 1;
        return {
            tag: "Text",
            key: `sig${key}`,
            // In grid space, adding px moves DOWN, subtracting moves UP.
            point: { x: du(sig.x), y: op(du(sig.price), buy ? "+" : "-", px(MARKER_GAP)) },
            text: buy ? "B" : "S",
            style: { fontSize: MARKER_FONT, fontWeight: "bold", fill: buy ? BUY_COLOR : SELL_COLOR },
            // alignment = where the TEXT sits relative to `point`
            textAlignment: buy ? "centerBelow" : "centerAbove",
            global: true
        };
    }

    hud(s, i, mode) {
        const rows = [];
        if (mode === "wrong") {
            rows.push(["SIGNAL needs a 1-min, 5-min or tick/range chart", WARN_COLOR]);
            // what was detected, so a misdetected chart can be diagnosed from a screenshot
            rows.push([`(bars are ${Math.round(this.gapGcd / 1000)}s apart)`, WARN_COLOR]);
        }
        else {
            // Plain ASCII only: Tradovate's HUD font drops glyphs like "▲ ▼ –".
            const t = (dir) => dir === 1 ? ["BULL", BUY_COLOR]
                : dir === -1 ? ["BEAR", SELL_COLOR]
                : ["none", NEUTRAL_COLOR];
            const row = (label, dir) => {
                const [txt, color] = t(dir);
                rows.push([`${label}  ${txt}`, color]);
            };

            const pipe = s[mode];
            const closed = this.eng[mode].states;
            const last = pipe.n > 0 ? closed[pipe.n - 1] : undefined;      // last closed candle
            const live = this.judge(pipe.form, last, mode, pipe.n);           // forming candle

            if (mode === "mtf") {
                row(`${HTF_MINUTES}m closed`, live.trend5Closed);
                row(`${HTF_MINUTES}m live`, live.trend5Live);
                row("1m closed", last ? last.trend1 : 0);
            }
            else {
                row(`${HTF_MINUTES}m closed`, last ? last.trendFull : 0);
                row(`${HTF_MINUTES}m live`, live.trend1);
                rows.push(["1m closed  n/a (5m chart)", NEUTRAL_COLOR]);
            }

            // where the last closed candle's close sits in the recent range
            if (last) {
                const pct = Math.round(last.rangePos * 100);
                const zone = this.props.zonePct;
                const [where, color] = pct <= zone ? ["bottom", BUY_COLOR]
                    : pct >= 100 - zone ? ["top", SELL_COLOR]
                    : ["middle", NEUTRAL_COLOR];
                rows.push([`range  ${pct}% (${where})`, color]);
            }
            else {
                rows.push(["range  n/a", NEUTRAL_COLOR]);
            }

            const sig = last && last.lastSignal;
            if (sig) {
                const ago = i - sig.bar;
                rows.push([
                    `LAST ${sig.dir === 1 ? "BUY" : "SELL"}  ${ago} bar${ago === 1 ? "" : "s"} ago`,
                    sig.dir === 1 ? BUY_COLOR : SELL_COLOR
                ]);
            }
            else {
                rows.push(["LAST  none yet", NEUTRAL_COLOR]);
            }
        }

        return rows.map(([text, color], n) => ({
            tag: "Text",
            key: `hud${n}`,
            point: { x: px(HUD_X), y: px(HUD_TOP + n * HUD_LINE_H) },
            text,
            style: { fontSize: HUD_FONT, fontWeight: text.startsWith("LAST") ? "bold" : "normal", fill: color },
            // "rightMiddle" = text to the RIGHT of `point` (stays inside the pane).
            textAlignment: "rightMiddle",
            global: true,
            origin: HUD_CORNER
        }));
    }
}

module.exports = {
    name: "signal",
    description: "Signal (5m + 1m Scalp-Pro trend)",
    calculator: Signal,
    params: {
        emaPeriod: predef.paramSpecs.period(14),
        rangeBars: predef.paramSpecs.period(20),            // candles in the range (1-min, or 5-min on a 5m chart)
        zonePct: predef.paramSpecs.number(30, 1, 1),        // bottom / top zone size (%)
        // Literal boolean shape — predef.paramSpecs.bool() is not known to exist
        // and a missing helper makes the indicator silently vanish from the list.
        showBuy: { type: "boolean", def: true },
        showSell: { type: "boolean", def: true },
        requireLive5m: { type: "boolean", def: true },      // 1-min / range charts only
        allowLaterEntry: { type: "boolean", def: false },   // 1-min / range charts only
        requireSlope: { type: "boolean", def: false },      // entry candle also needs a rising/falling EMA
        showHud: { type: "boolean", def: true }
    },
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    plots: {},
    tags: ["Custom Indicators"],
    schemeStyles: { dark: {}, light: {} }
};
