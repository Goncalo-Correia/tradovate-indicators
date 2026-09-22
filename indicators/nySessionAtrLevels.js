// ============================================================================
// NY Session ATR Levels — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Draws a ladder of horizontal levels anchored to the CURRENT candle:
//   - The CENTER line sits at the OPEN of the newest (right-most) candle.
//   - 5 lines above and 5 lines below, each spaced by 1x ATR.
//   - The whole ladder is re-drawn on the live candle as it updates, and
//     RE-ANCHORS as soon as a new candle opens. Only one ladder ever exists:
//     the previous candle's lines disappear when the new candle starts.
//   - Levels are drawn only from NY open (09:30 ET) to NY close (16:00 ET)
//     while SESSION_ONLY is true; set it to false to draw around the clock.
//
// The lines are `graphics` (infinite LineSegments) rather than `plots`, because
// a plot holds one value per bar: an anchor that moves with every candle would
// paint a staircase across the chart instead of a single set of horizontal
// lines. Graphics are emitted only on the last bar (`global: true`, so they are
// rendered once for the series), which is what makes the previous candle's
// ladder vanish. Consequence: there is no per-line entry in the chart legend
// and no UI colour picker — style the lines from the CONFIG block below.
//
// Spacing uses the ATR through the PREVIOUS closed bar, so the ladder stays
// perfectly still while the live candle forms and only jumps at the next open.
//
// Only depends on ./tools/predef, ./tools/meta and ./tools/graphics (all
// provided by Tradovate). ATR is computed inline (Wilder's smoothing) so there
// is no dependency on a tools module whose signature might differ. Timezone is
// handled without Intl.
// ============================================================================

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ============================== CONFIG ======================================
const LINES = 5;                      // number of lines above AND below center
const SESSION_ONLY = true;            // true : only draw 09:30-16:00 ET
                                      // false: draw on every bar, any time
const SESSION_OPEN_MIN = 9 * 60 + 30; // 09:30 ET  (NY regular session open)
const SESSION_CLOSE_MIN = 16 * 60;    // 16:00 ET  (NY regular session close)
const EXTEND_LEFT = true;             // true : lines run across the whole chart
                                      // false: lines start at the current candle
                                      //        and only extend to the right
const SHOW_LABELS = true;             // draw "+3" / "OPEN" / "-3" at the right
const LABEL_EVERY = 1;                // label every Nth line (1 = all of them)
const LABEL_X_OFFSET = 8;             // px right of the current candle
const LABEL_FONT_SIZE = 9;

const LEVEL_COLOR = "#EDEDED99";      // ATR lines (40% transparent light grey)
const LEVEL_WIDTH = 1;
const CENTER_COLOR = "#FFD54FCC";     // center line (candle open) - amber
const CENTER_WIDTH = 1;
const LABEL_COLOR = "#EDEDED99";
const CENTER_LABEL_COLOR = "#FFD54FCC";
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

function easternMinutes(date) {
    const shifted = new Date(date.getTime() + easternOffsetHours(date) * 3600000);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

class NySessionAtrLevels {
    init() {
        this.period = this.props.atrPeriod;
        this.atr = undefined;      // Wilder ATR through the bar just processed
        this.trSum = 0;            // warm-up accumulation of true range
        this.trCount = 0;
        this.prevClose = undefined;
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

    // One horizontal line at `price`, anchored on the current candle's index.
    lineAt(index, price) {
        return {
            tag: "Line",
            a: { x: du(index), y: du(price) },
            b: { x: du(index + 1), y: du(price) },
            infiniteStart: EXTEND_LEFT,
            infiniteEnd: true
        };
    }

    label(key, index, price, text, color) {
        return {
            tag: "Text",
            key,
            point: {
                x: op(du(index), '+', px(LABEL_X_OFFSET)),
                y: du(price)
            },
            text,
            style: { fontSize: LABEL_FONT_SIZE, fontWeight: "normal", fill: color },
            // "rightMiddle" = text sits to the RIGHT of the anchor point
            textAlignment: "rightMiddle",
            global: true
        };
    }

    map(d) {
        // ATR through the PREVIOUS bar -> spacing does not twitch while the
        // live candle forms (captured before folding this bar's true range in).
        const prevAtr = this.atr;
        this.updateAtr(d);

        // Only the newest candle carries the ladder. Assigning `graphics` on
        // every bar (false = "nothing here") is what clears the older copies.
        if (!d.isLast()) {
            return { graphics: false };
        }

        if (SESSION_ONLY) {
            const minutes = easternMinutes(d.timestamp());
            if (minutes < SESSION_OPEN_MIN || minutes >= SESSION_CLOSE_MIN) {
                return { graphics: false };
            }
        }

        const spacing = prevAtr !== undefined ? prevAtr : this.atr;
        if (!(spacing > 0)) {
            return { graphics: false };
        }

        const index = d.index();
        const center = d.open();
        const levelLines = [];
        const labels = [];

        for (let k = 1; k <= LINES; k++) {
            const up = center + k * spacing;
            const dn = center - k * spacing;
            levelLines.push(this.lineAt(index, up));
            levelLines.push(this.lineAt(index, dn));
            if (SHOW_LABELS && k % LABEL_EVERY === 0) {
                labels.push(this.label("atrLblUp" + k, index, up, "+" + k, LABEL_COLOR));
                labels.push(this.label("atrLblDn" + k, index, dn, "-" + k, LABEL_COLOR));
            }
        }

        const items = [
            {
                tag: "LineSegments",
                key: "atrLevels",
                lines: levelLines,
                lineStyle: { lineWidth: LEVEL_WIDTH, color: LEVEL_COLOR },
                global: true
            },
            {
                tag: "LineSegments",
                key: "atrCenter",
                lines: [this.lineAt(index, center)],
                lineStyle: { lineWidth: CENTER_WIDTH, color: CENTER_COLOR },
                global: true
            }
        ];

        if (SHOW_LABELS) {
            items.push(this.label("atrLblCenter", index, center, "OPEN", CENTER_LABEL_COLOR));
            labels.forEach(function (item) { items.push(item); });
        }

        return { graphics: { items } };
    }
}

module.exports = {
    name: "nySessionAtrLevels",
    description: "NY Session ATR Levels",
    calculator: NySessionAtrLevels,
    params: {
        atrPeriod: predef.paramSpecs.period(14)
    },
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    tags: ["Custom Indicators"]
};
