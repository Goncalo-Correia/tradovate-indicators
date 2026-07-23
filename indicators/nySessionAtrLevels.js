// ============================================================================
// NY Session ATR Levels — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Draws a set of horizontal levels for each New York regular-session:
//   - The CENTER line is anchored to the OPEN of the first NY-session candle.
//   - 10 lines above and 10 lines below, each spaced by 1x ATR.
//   - Levels are drawn only from NY open (09:30 ET) to NY close (16:00 ET);
//     outside the session the plots return nothing, so the lines break.
//   - The indicator re-maps on every candle close (Tradovate calls map() per
//     closed bar), and re-anchors automatically at the next NY open.
//
// By default the center price and the ATR spacing are FIXED at the session
// open, so the 21 lines are truly horizontal for the whole session. Set
// DYNAMIC_ATR = true to recompute the spacing on every candle instead.
//
// Only depends on ./tools/predef (always provided by Tradovate). ATR is
// computed inline (Wilder's smoothing) so there is no dependency on a tools
// module whose signature might differ. Timezone is handled without Intl.
// ============================================================================

const predef = require("./tools/predef");

// ============================== CONFIG ======================================
const LINES = 10;                     // number of lines above AND below center
const SESSION_OPEN_MIN = 9 * 60 + 30; // 09:30 ET  (NY regular session open)
const SESSION_CLOSE_MIN = 16 * 60;    // 16:00 ET  (NY regular session close)
const DYNAMIC_ATR = true;             // true : spacing tracks latest ATR each
                                      //        candle close (center stays anchored)
                                      // false: ATR fixed at open (flat lines)
// ============================================================================

// -------- US Eastern time (DST-aware, no Intl dependency) -------------------
function nthSundayOfMonth(year, monthIndex, n) {
    // Day-of-month of the n-th Sunday of the given month (monthIndex is 0-based)
    const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDow) % 7);
    return firstSunday + (n - 1) * 7;
}

function easternOffsetHours(date) {
    const y = date.getUTCFullYear();
    // DST starts 2nd Sunday of March at 02:00 EST -> 07:00 UTC
    const dstStart = Date.UTC(y, 2, nthSundayOfMonth(y, 2, 2), 7);
    // DST ends 1st Sunday of November at 02:00 EDT -> 06:00 UTC
    const dstEnd = Date.UTC(y, 10, nthSundayOfMonth(y, 10, 1), 6);
    const t = date.getTime();
    return (t >= dstStart && t < dstEnd) ? -4 : -5; // EDT vs EST
}

function easternParts(date) {
    const shifted = new Date(date.getTime() + easternOffsetHours(date) * 3600000);
    return {
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        dayKey: shifted.getUTCFullYear() * 10000 +
                (shifted.getUTCMonth() + 1) * 100 +
                shifted.getUTCDate()
    };
}

// -------- Static plot definitions: up10..up1, center, dn1..dn10 -------------
const plots = {};
for (let k = LINES; k >= 1; k--) {
    plots["up" + k] = { title: "+" + k + " ATR" };
}
plots.center = { title: "NY Open" };
for (let k = 1; k <= LINES; k++) {
    plots["dn" + k] = { title: "-" + k + " ATR" };
}

// -------- Default style: light grey, 1px (narrowest). Editable in UI. -------
const LINE_STYLE = { color: "#EDEDED99", lineWidth: 1 }; // 40% transparent (60% opacity)
const schemeStyles = { dark: {}, light: {} };
Object.keys(plots).forEach(function (key) {
    schemeStyles.dark[key] = LINE_STYLE;
    schemeStyles.light[key] = LINE_STYLE;
});

class NySessionAtrLevels {
    init() {
        this.period = this.props.atrPeriod;
        this.atr = undefined;      // current Wilder ATR value
        this.trSum = 0;            // warm-up accumulation of true range
        this.trCount = 0;
        this.prevClose = undefined;
        this.center = undefined;   // anchored open price of current session
        this.spacing = undefined;  // ATR captured at current session open
        this.sessionDayKey = undefined;
    }

    updateAtr(d) {
        const high = d.high();
        const low = d.low();
        const close = d.close();
        let tr;
        if (this.prevClose === undefined) {
            tr = high - low;
        } else {
            tr = Math.max(
                high - low,
                Math.abs(high - this.prevClose),
                Math.abs(low - this.prevClose)
            );
        }
        if (this.trCount < this.period) {
            // Warm-up: simple average until we have `period` samples
            this.trCount++;
            this.trSum += tr;
            this.atr = this.trSum / this.trCount;
        } else {
            // Wilder's smoothing
            this.atr = (this.atr * (this.period - 1) + tr) / this.period;
        }
        this.prevClose = close;
    }

    map(d) {
        this.updateAtr(d);

        const et = easternParts(d.timestamp());
        const inSession =
            et.minutes >= SESSION_OPEN_MIN && et.minutes < SESSION_CLOSE_MIN;

        // First bar of a NEW NY session -> anchor center and spacing
        if (inSession && et.dayKey !== this.sessionDayKey) {
            this.sessionDayKey = et.dayKey;
            this.center = d.open();
            this.spacing = this.atr;
        }

        // Outside the session (or before we ever anchored): draw nothing
        if (!inSession || this.center === undefined || this.spacing === undefined) {
            return {};
        }

        const spacing = DYNAMIC_ATR ? this.atr : this.spacing;
        const result = { center: this.center };
        for (let k = 1; k <= LINES; k++) {
            result["up" + k] = this.center + k * spacing;
            result["dn" + k] = this.center - k * spacing;
        }
        return result;
    }
}

module.exports = {
    name: "nySessionAtrLevels",
    description: "NY Session ATR Levels",
    calculator: NySessionAtrLevels,
    params: {
        atrPeriod: predef.paramSpecs.period(14)
    },
    plots,
    schemeStyles
};
