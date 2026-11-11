// ============================================================================
// Turtle Breakout — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Port of the "Turtle Breakout - Revelio" Pine script, with ONE change: every
// lookback is counted in CANDLES of the chart, not in trading days.
//
// Long-only breakout system:
//   Entry : a candle trades above the highest high of the previous N candles.
//   Stop  : entry price - atrMult x ATR, fixed for the whole trade
//           (ATR over `atrPeriod` candles, Wilder smoothing, through the
//           previous closed candle).
//   Exit  : lowest low of the previous M candles. The trade exits at whichever
//           of (stop, exit band) is HIGHER.
//   Day-trading mode: flat at CLOSE (16:30 ET), re-enter from OPEN (18:00 ET)
//           if the trade is still valid, flat over the weekend (Fri close ->
//           Sun open).
//
// This is an indicator: it draws, it does not place orders.
//
// Plots: Entry band (teal), Exit band (orange), Active exit (red, only while
// the signal is long), Entry dot (green), Exit dot (red). Dots need
// predef.plotters.singleline; if the bundled predef lacks it, the default line
// plotter is used and the dots are not drawn.
//
// Limitations:
//   - Use a regular 1/5/15/30-minute chart when day-trading mode is on: the
//     close candle is found from the bar spacing (smallest gap between bar
//     timestamps). Tick/range charts are not supported in that mode.
//   - `d.timestamp()` is assumed to be the candle OPEN time (TIMESTAMP_IS_OPEN).
//   - No candle shading (Pine's bgcolor has no plot equivalent here).
//   - ET/DST is hand-rolled (no Intl), no holiday calendar.
// ============================================================================

const predef = require("./tools/predef");
const meta = require("./tools/meta");

// ============================== CONFIG ======================================
const ENTRY_COLOR = "#26A69A";
const EXIT_COLOR = "#FF9800";
const STOP_COLOR = "#F23645";
const MARK_BUY_COLOR = "#00E676";
const MARK_SELL_COLOR = "#F23645";
const BAND_WIDTH = 2;

const TIMESTAMP_IS_OPEN = true;   // false if bar timestamps are candle CLOSE times
// ============================================================================

// -------- US Eastern time (DST-aware, no Intl dependency) -------------------
function nthSundayOfMonth(year, monthIndex, n) {
    const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDow) % 7);
    return firstSunday + (n - 1) * 7;
}

function easternOffsetHours(date) {
    const y = date.getUTCFullYear();
    const dstStart = Date.UTC(y, 2, nthSundayOfMonth(y, 2, 2), 7);
    const dstEnd = Date.UTC(y, 10, nthSundayOfMonth(y, 10, 1), 6);
    const t = date.getTime();
    return (t >= dstStart && t < dstEnd) ? -4 : -5;
}

// Milliseconds on the Eastern wall clock (read with getUTC*).
function wallMs(date) {
    return date.getTime() + easternOffsetHours(date) * 3600000;
}

const DAY_MS = 86400000;

class TurtleBreakout {
    init() {
        this.N = Math.max(2, this.props.entryPeriod);
        this.M = Math.max(2, this.props.exitPeriod);
        this.atrLen = Math.max(2, this.props.atrPeriod);
        this.mult = this.props.atrMult;
        this.dayTrading = !!this.props.dayTrading;
        this.closeMin = this.props.closeHour * 60 + this.props.closeMinute;
        this.openMin = this.props.openHour * 60 + this.props.openMinute;

        // Per-candle history keyed by map()'s index (idempotent on re-runs).
        this.highs = [];
        this.lows = [];
        this.snaps = [];   // machine state AFTER each index
        this.barMs = undefined;   // smallest positive gap between timestamps
        this.lastTs = undefined;
        this.lastIdx = -1;
    }

    freshState() {
        return {
            atr: undefined, atrSum: 0, atrCount: 0, prevClose: undefined,
            signalLong: false, held: false, stop: undefined,
            deadline: undefined, marked: false
        };
    }

    // First wall-clock close (Mon-Fri) strictly after `wall`.
    deadlineFor(wall) {
        const w = new Date(wall);
        const mins = w.getUTCHours() * 60 + w.getUTCMinutes();
        let day = Math.floor(wall / DAY_MS) * DAY_MS + (mins >= this.closeMin ? DAY_MS : 0);
        for (;;) {
            const dow = new Date(day).getUTCDay();
            if (dow !== 0 && dow !== 6) break;
            day += DAY_MS;
        }
        return day + this.closeMin * 60000;
    }

    map(d, index) {
        const date = d.timestamp();
        const ts = date.getTime();
        if (index > 0 && this.lastTs !== undefined && ts > this.lastTs && this.lastIdx === index - 1) {
            const gap = ts - this.lastTs;
            if (this.barMs === undefined || gap < this.barMs) this.barMs = gap;
        }
        this.lastTs = ts;
        this.lastIdx = index;

        const high = d.high(), low = d.low(), open = d.open(), close = d.close();
        const prev = index > 0 ? this.snaps[index - 1] : undefined;
        const s = prev ? Object.assign({}, prev) : this.freshState();
        const prevAtr = s.atr;   // ATR through the previous candle

        // Levels from the previous N / M candles (not including this one).
        let entryLevel, exitLevel;
        if (index >= this.N) {
            entryLevel = -Infinity;
            for (let i = index - this.N; i < index; i++) entryLevel = Math.max(entryLevel, this.highs[i]);
        }
        if (index >= this.M) {
            exitLevel = Infinity;
            for (let i = index - this.M; i < index; i++) exitLevel = Math.min(exitLevel, this.lows[i]);
        }
        this.highs[index] = high;
        this.lows[index] = low;

        // Wilder ATR, folded in after the levels so this candle uses prevAtr.
        const tr = s.prevClose === undefined
            ? high - low
            : Math.max(high - low, Math.abs(high - s.prevClose), Math.abs(low - s.prevClose));
        if (s.atr === undefined) {
            s.atrSum += tr;
            s.atrCount++;
            if (s.atrCount === this.atrLen) s.atr = s.atrSum / this.atrLen;
        } else {
            s.atr = (s.atr * (this.atrLen - 1) + tr) / this.atrLen;
        }
        s.prevClose = close;

        let entryMark, exitMark;

        if (entryLevel !== undefined && exitLevel !== undefined && prevAtr !== undefined) {
            const wall = wallMs(date);
            const w = new Date(wall);
            const nyMin = w.getUTCHours() * 60 + w.getUTCMinutes();
            const dow = w.getUTCDay();
            const barEnd = this.barMs !== undefined
                ? (TIMESTAMP_IS_OPEN ? wall + this.barMs : wall) : wall;

            const allowed = !this.dayTrading || (
                (nyMin < this.closeMin || nyMin >= this.openMin) &&
                dow !== 6 &&
                !(dow === 0 && nyMin < this.openMin) &&
                !(dow === 5 && nyMin >= this.closeMin));

            const wasLong = s.signalLong;
            const breakout = !wasLong && high > entryLevel;
            let exitEvent = false;
            let signalExit;

            if (breakout) {
                s.marked = false;
                s.stop = Math.max(entryLevel, open) - this.mult * prevAtr;
                s.signalLong = true;
                exitEvent = low < s.stop;
            } else if (wasLong) {
                exitEvent = low < Math.max(s.stop, exitLevel);
            }
            if (exitEvent) {
                signalExit = wasLong ? Math.min(open, Math.max(s.stop, exitLevel)) : s.stop;
                s.signalLong = false;
            }

            // Missed scheduled close (gap / weekend): bar opens at or after deadline.
            if (this.dayTrading && s.held && s.deadline !== undefined && wall >= s.deadline) {
                s.held = false;
            }
            let shadeHeld = s.held;
            if (!s.held && allowed) {
                const entryEvent = breakout;
                const reentryEvent = wasLong && open >= Math.max(s.stop, exitLevel);
                if (entryEvent || reentryEvent) {
                    if (!s.marked) {
                        entryMark = breakout ? Math.max(entryLevel, open) : open;
                        s.marked = true;
                    }
                    s.held = true;
                    s.deadline = this.deadlineFor(wall);
                }
            }
            shadeHeld = s.held;

            if (s.held) {
                if (exitEvent) {
                    s.held = false;
                } else if (this.dayTrading && s.deadline !== undefined && barEnd >= s.deadline) {
                    s.held = false;   // scheduled close at the end of this candle
                }
            }

            if (exitEvent) {
                // If already flat by schedule the signal still ends at the level.
                exitMark = shadeHeld ? signalExit : Math.max(s.stop, exitLevel);
                s.marked = false;
            }
        }

        this.snaps[index] = s;

        const activeStop = s.signalLong ? Math.max(s.stop, exitLevel !== undefined ? exitLevel : s.stop) : undefined;
        const out = {
            entryBand: entryLevel,
            exitBand: exitLevel,
            activeStop,
            entryMark,
            exitMark
        };
        return out;
    }
}

function intParam(def, min, max) {
    return { type: "number", def, restrictions: { min, max, step: 1 } };
}

const lineStyle = (color) => predef.styles.plot({ color, lineWidth: BAND_WIDTH });
const dotStyle = (color) => predef.styles.plot({ color, lineWidth: 5 });

const hasLine = predef.plotters && typeof predef.plotters.singleline === "function";
const plotter = hasLine ? [
    predef.plotters.singleline("entryBand"),
    predef.plotters.singleline("exitBand"),
    predef.plotters.singleline("activeStop"),
    predef.plotters.dots("entryMark"),
    predef.plotters.dots("exitMark")
] : undefined;

const exported = {
    name: "turtleBreakout",
    description: "Turtle Breakout (N-candle high entry, M-candle low exit, ATR stop)",
    calculator: TurtleBreakout,
    params: {
        entryPeriod: intParam(20, 2, 400),
        exitPeriod: intParam(10, 2, 400),
        atrPeriod: predef.paramSpecs.period(20),
        atrMult: { type: "number", def: 2, restrictions: { min: 0.5, max: 20, step: 0.5 } },
        dayTrading: { type: "boolean", def: true },
        closeHour: intParam(16, 0, 23),
        closeMinute: intParam(30, 0, 59),
        openHour: intParam(18, 0, 23),
        openMinute: intParam(0, 0, 59)
    },
    plots: {
        entryBand: { title: "Entry band" },
        exitBand: { title: "Exit band" },
        activeStop: { title: "Active exit" },
        entryMark: { title: "Entry" },
        exitMark: { title: "Exit" }
    },
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    tags: ["Custom Indicators"],
    schemeStyles: {
        dark: {
            entryBand: lineStyle(ENTRY_COLOR),
            exitBand: lineStyle(EXIT_COLOR),
            activeStop: lineStyle(STOP_COLOR),
            entryMark: dotStyle(MARK_BUY_COLOR),
            exitMark: dotStyle(MARK_SELL_COLOR)
        },
        light: {
            entryBand: lineStyle(ENTRY_COLOR),
            exitBand: lineStyle(EXIT_COLOR),
            activeStop: lineStyle(STOP_COLOR),
            entryMark: dotStyle(MARK_BUY_COLOR),
            exitMark: dotStyle(MARK_SELL_COLOR)
        }
    }
};
if (plotter) exported.plotter = plotter;

module.exports = exported;
